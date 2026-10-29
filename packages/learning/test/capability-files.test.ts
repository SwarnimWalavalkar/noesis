import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sha256,
  CAPABILITY_NOTES_MARKER,
  capabilityGuidance,
  parseCapabilityDocument,
  renderCapabilityDocument,
} from "@noesis/domain";
import { createWorkspaceStore, type NoesisWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import {
  capabilityDocumentRevision,
  capabilityWorkingDocumentPath,
  createCapabilityPublisher,
} from "../src/capability-publisher.ts";

const opened: { readonly root: string; readonly workspace: NoesisWorkspaceStore }[] = [];
afterEach(async () => {
  for (const item of opened.splice(0)) {
    item.workspace.close();
    await rm(item.root, { recursive: true, force: true });
  }
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "noesis-capability-files-"));
  const workspace = await createWorkspaceStore(root);
  opened.push({ root, workspace });
  await workspace.operational.sessions.put({
    sessionId: "session-files",
    title: "Files",
    status: "idle",
    provider: "fake",
    model: "fake",
    runtime: "fake",
    createdAt: "2026-10-29T10:00:00.000Z",
    updatedAt: "2026-10-29T10:00:00.000Z",
    metadata: Object.freeze({}),
  });
  const message = await workspace.operational.messages.put({
    messageId: "turn-files:user",
    sessionId: "session-files",
    role: "user",
    content: "Always use pnpm here.",
    sensitivity: "normal",
    createdAt: "2026-10-29T10:00:00.000Z",
    metadata: Object.freeze({ turnId: "turn-files" }),
  });
  const publisher = createCapabilityPublisher({ workspace, store: workspace.capabilities });
  const context = Object.freeze({
    project: Object.freeze({ projectId: "project-files", root }),
    sessionId: "session-files",
    evidenceRefs: [message],
    actor: Object.freeze({ actorId: "test", kind: "noesis" as const }),
  });
  return { root, workspace, publisher, context, message };
}

const current = async (workspace: NoesisWorkspaceStore, capabilityId: string) => {
  const binding = await workspace.capabilities.getBinding(capabilityId);
  if (!binding) throw new Error("Expected a binding");
  const lifecycle = await workspace.capabilities.getRevision(binding.revision);
  if (!lifecycle) throw new Error("Expected a revision");
  const document = capabilityDocumentRevision(lifecycle);
  if (!document) throw new Error("Expected a Capability file");
  return { binding, lifecycle, document };
};

describe("Capability files", () => {
  test("round-trips the editable part and ignores the notes", () => {
    const text = renderCapabilityDocument(
      {
        name: "Use pnpm",
        when: "Package commands.",
        description: "Use pnpm.",
        guidance: "Run pnpm, not npm.",
      },
      { rationale: "Asked for.", history: [{ date: "2026-10-29", summary: "Created." }] },
    );
    expect(parseCapabilityDocument(text)).toEqual({
      ok: true,
      content: {
        name: "Use pnpm",
        when: "Package commands.",
        description: "Use pnpm.",
        guidance: "Run pnpm, not npm.",
      },
    });
    expect(capabilityGuidance(text)).toBe("Run pnpm, not npm.");
    // Older materials are plain guidance and pass through unchanged.
    expect(capabilityGuidance("Plain guidance.")).toBe("Plain guidance.");
    expect(parseCapabilityDocument("---\nname: x\n---\n\nBody")).toMatchObject({ ok: false });
    // Every field needs a colon and a value, and a quoted marker inside the guidance is kept.
    expect(parseCapabilityDocument("---\nname\nwhen: w\ndescription: d\n---\n\nBody")).toMatchObject({
      ok: false,
    });
    expect(parseCapabilityDocument("---\nname: n\nwhen: w\n---\n\nBody")).toMatchObject({ ok: false });
    const quoted = `---\nname: n\nwhen: w\ndescription: d\n---\n\nThe file ends with ${CAPABILITY_NOTES_MARKER} notes.\n\n${CAPABILITY_NOTES_MARKER}\n\n## Why`;
    expect(capabilityGuidance(quoted)).toBe(`The file ends with ${CAPABILITY_NOTES_MARKER} notes.`);
  });

  test("records a direct edit as a revision and reports an edit it cannot read", async () => {
    const { root, workspace, publisher, context } = await setup();
    const created = await publisher.publish(
      {
        decision: "create",
        proposal: {
          name: "Use pnpm",
          description: "Use pnpm for package commands.",
          applicability: "Package commands in this repository.",
          summary: "Use pnpm.",
          rationale: "The user asked for pnpm.",
          anticipatedEffect: "Package commands use pnpm.",
          effects: [{ kind: "instruction", content: "Run pnpm, not npm." }],
          consequence: "ordinary",
          consequenceDescription: "Only model instructions change.",
        },
      },
      context,
      new AbortController().signal,
    );
    if (created.status !== "activated") throw new Error("Expected activation");
    const before = await current(workspace, created.capabilityId);
    const file = join(root, capabilityWorkingDocumentPath(before.document));

    // A publication that fails, here because the Program does not exist, leaves the file alone and
    // is never mistaken for a user edit.
    await expect(
      publisher.publish(
        {
          decision: "revise",
          capabilityId: created.capabilityId,
          expectedBindingRevision: before.binding.revisionNumber,
          proposal: {
            name: "Use pnpm",
            description: "Use pnpm for package commands.",
            applicability: "Package commands in this repository.",
            summary: "Attach a missing script.",
            rationale: "Fixture.",
            anticipatedEffect: "None.",
            effects: [
              { kind: "instruction", content: "Rejected guidance." },
              { kind: "program", mode: "script", name: "missing-script" },
            ],
            consequence: "ordinary",
            consequenceDescription: "Fixture.",
          },
        },
        context,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Unknown saved script Program missing-script");
    expect(
      new TextDecoder().decode(
        await workspace.reads.readWorkingFile(capabilityWorkingDocumentPath(before.document)),
      ),
    ).not.toContain("Rejected guidance.");

    // Nothing changed, so nothing is recorded.
    await expect(publisher.recordDocumentEdits(context, new AbortController().signal)).resolves.toEqual({
      recorded: [],
      problems: [],
    });

    const edited = new TextDecoder()
      .decode(await workspace.reads.readRevision(before.document))
      .replace("Run pnpm, not npm.", "Run pnpm, not npm. Use pnpm dlx instead of npx.")
      .replace("when: Package commands in this repository.", "when: Package and script commands.");
    await writeFile(file, edited);
    await expect(publisher.recordDocumentEdits(context, new AbortController().signal)).resolves.toEqual({
      recorded: [{ capabilityId: created.capabilityId, name: "Use pnpm" }],
      problems: [],
    });
    const after = await current(workspace, created.capabilityId);
    expect(after.binding.revision.capabilityRevisionId).not.toBe(
      before.binding.revision.capabilityRevisionId,
    );
    expect(capabilityWorkingDocumentPath(after.document)).toBe(
      capabilityWorkingDocumentPath(before.document),
    );
    expect(
      capabilityGuidance(new TextDecoder().decode(await workspace.reads.readRevision(after.document))),
    ).toBe("Run pnpm, not npm. Use pnpm dlx instead of npx.");
    expect(await workspace.capabilities.getDefinition(created.capabilityId)).toMatchObject({
      applicability: "Package and script commands.",
    });
    // The imported edit is the current file now, so the next scan records nothing new.
    await expect(publisher.recordDocumentEdits(context, new AbortController().signal)).resolves.toEqual({
      recorded: [],
      problems: [],
    });
    expect((await current(workspace, created.capabilityId)).binding.revision).toEqual(after.binding.revision);

    // History lists the newest change first.
    const afterText = new TextDecoder().decode(await workspace.reads.readRevision(after.document));
    const history = afterText.slice(afterText.indexOf("## History"));
    expect(history.indexOf("Edited directly in its Capability file.")).toBeLessThan(
      history.indexOf("Use pnpm."),
    );

    // Noesis stopped right after publishing: its own last write at this path is still the earlier
    // file. That file is brought up to date instead of being imported as the user's edit.
    await workspace.definitions.recordWorkingDefinition({
      workingPath: capabilityWorkingDocumentPath(before.document),
      bytes: await workspace.reads.readRevision(before.document),
      actor: Object.freeze({ actorId: "capability-files", kind: "system" as const }),
    });
    await expect(publisher.recordDocumentEdits(context, new AbortController().signal)).resolves.toEqual({
      recorded: [],
      problems: [],
    });
    expect((await current(workspace, created.capabilityId)).binding.revision).toEqual(after.binding.revision);
    expect(
      new TextDecoder().decode(
        await workspace.reads.readWorkingFile(capabilityWorkingDocumentPath(after.document)),
      ),
    ).toBe(afterText);

    // An edit gets the same limits as any authored Capability.
    await writeFile(file, afterText.replace("name: Use pnpm", `name: ${"n".repeat(161)}`));
    const tooLong = await publisher.recordDocumentEdits(context, new AbortController().signal);
    expect(tooLong.recorded).toEqual([]);
    expect(tooLong.problems).toEqual([expect.objectContaining({ error: expect.stringContaining("name") })]);

    await writeFile(file, "no frontmatter here");
    const report = await publisher.recordDocumentEdits(context, new AbortController().signal);
    expect(report.recorded).toEqual([]);
    expect(report.problems).toEqual([
      expect.objectContaining({ capabilityId: created.capabilityId, error: expect.stringContaining("---") }),
    ]);
    expect((await current(workspace, created.capabilityId)).binding.revision).toEqual(after.binding.revision);

    // Restoring the first revision puts its file back, so the restore is not mistaken for an edit.
    const restored = await publisher.publish(
      {
        decision: "restore",
        capabilityId: created.capabilityId,
        expectedBindingRevision: after.binding.revisionNumber,
        capabilityRevisionId: before.binding.revision.capabilityRevisionId,
        reason: "Go back to the first version.",
      },
      context,
      new AbortController().signal,
    );
    expect(restored).toMatchObject({ status: "restored" });
    expect(
      new TextDecoder().decode(
        await workspace.reads.readWorkingFile(capabilityWorkingDocumentPath(before.document)),
      ),
    ).toBe(new TextDecoder().decode(await workspace.reads.readRevision(before.document)));
    await expect(publisher.recordDocumentEdits(context, new AbortController().signal)).resolves.toEqual({
      recorded: [],
      problems: [],
    });
    // The restored file's "when" text is the Capability's applicability again.
    expect(await workspace.capabilities.getDefinition(created.capabilityId)).toMatchObject({
      applicability: "Package commands in this repository.",
    });
  });

  test("keeps an unrecorded user edit when an ambient revision is published", async () => {
    const { root, workspace, publisher, context } = await setup();
    const proposal = {
      name: "Use pnpm",
      description: "Use pnpm for package commands.",
      applicability: "Package commands in this repository.",
      summary: "Use pnpm.",
      rationale: "The user asked for pnpm.",
      anticipatedEffect: "Package commands use pnpm.",
      effects: [{ kind: "instruction" as const, content: "Run pnpm, not npm." }],
      consequence: "ordinary" as const,
      consequenceDescription: "Only model instructions change.",
    };
    const created = await publisher.publish(
      { decision: "create", proposal },
      context,
      new AbortController().signal,
    );
    if (created.status !== "activated") throw new Error("Expected activation");
    const first = await current(workspace, created.capabilityId);
    const file = join(root, capabilityWorkingDocumentPath(first.document));
    const userEdit = new TextDecoder()
      .decode(await workspace.reads.readRevision(first.document))
      .replace("Run pnpm, not npm.", "Run pnpm, not npm. Prefer pnpm dlx.");
    await writeFile(file, userEdit);
    // Reflection publishes a revision before the edit scan has run.
    const ambient = await publisher.publish(
      {
        decision: "revise",
        capabilityId: created.capabilityId,
        expectedBindingRevision: first.binding.revisionNumber,
        proposal: { ...proposal, effects: [{ kind: "instruction", content: "Run pnpm in scripts too." }] },
      },
      { ...context, actor: Object.freeze({ actorId: "automatic-learning-organ", kind: "noesis" as const }) },
      new AbortController().signal,
    );
    expect(ambient).toMatchObject({ status: "revised", capabilityId: created.capabilityId });
    expect(
      new TextDecoder().decode(
        await workspace.reads.readWorkingFile(capabilityWorkingDocumentPath(first.document)),
      ),
    ).toBe(userEdit);
    await expect(publisher.recordDocumentEdits(context, new AbortController().signal)).resolves.toMatchObject(
      {
        recorded: [{ capabilityId: created.capabilityId }],
      },
    );
    const latest = await current(workspace, created.capabilityId);
    expect(
      capabilityGuidance(new TextDecoder().decode(await workspace.reads.readRevision(latest.document))),
    ).toBe("Run pnpm, not npm. Prefer pnpm dlx.");

    // A newer save made while an edit was being applied is never replaced by the older edit.
    const newerSave = `${userEdit}\nNewer save.\n`;
    await writeFile(file, newerSave);
    await publisher.syncWorkingDocument(created.capabilityId, {
      userChoseRevision: true,
      onlyReplacingDigest: sha256(userEdit),
    });
    expect(
      new TextDecoder().decode(
        await workspace.reads.readWorkingFile(capabilityWorkingDocumentPath(first.document)),
      ),
    ).toBe(newerSave);
  });

  test("imports an earlier file the user restored from a backup as an edit", async () => {
    const { root, workspace, publisher, context } = await setup();
    const proposal = {
      name: "Use pnpm",
      description: "Use pnpm for package commands.",
      applicability: "Package commands in this repository.",
      summary: "Use pnpm.",
      rationale: "The user asked for pnpm.",
      anticipatedEffect: "Package commands use pnpm.",
      effects: [{ kind: "instruction" as const, content: "Run pnpm, not npm." }],
      consequence: "ordinary" as const,
      consequenceDescription: "Only model instructions change.",
    };
    const created = await publisher.publish(
      { decision: "create", proposal },
      context,
      new AbortController().signal,
    );
    if (created.status !== "activated") throw new Error("Expected activation");
    const first = await current(workspace, created.capabilityId);
    await publisher.publish(
      {
        decision: "revise",
        capabilityId: created.capabilityId,
        expectedBindingRevision: first.binding.revisionNumber,
        proposal: { ...proposal, effects: [{ kind: "instruction", content: "Run pnpm and pnpm dlx." }] },
      },
      context,
      new AbortController().signal,
    );
    await writeFile(
      join(root, capabilityWorkingDocumentPath(first.document)),
      await workspace.reads.readRevision(first.document),
    );
    await expect(publisher.recordDocumentEdits(context, new AbortController().signal)).resolves.toEqual({
      recorded: [{ capabilityId: created.capabilityId, name: "Use pnpm" }],
      problems: [],
    });
    const restored = await current(workspace, created.capabilityId);
    expect(
      capabilityGuidance(new TextDecoder().decode(await workspace.reads.readRevision(restored.document))),
    ).toBe("Run pnpm, not npm.");
  });

  test("keeps reporting a restored file it cannot apply instead of overwriting it", async () => {
    const { root, workspace, publisher, context } = await setup();
    const proposal = {
      name: "Rules",
      description: "Rules.",
      applicability: "Every turn.",
      summary: "Rules.",
      rationale: "Fixture.",
      anticipatedEffect: "None.",
      effects: [{ kind: "instruction" as const, content: "x".repeat(2_001) }],
      consequence: "ordinary" as const,
      consequenceDescription: "Fixture.",
    };
    const created = await publisher.publish(
      { decision: "create", proposal },
      context,
      new AbortController().signal,
    );
    if (created.status !== "activated") throw new Error("Expected activation");
    const long = await current(workspace, created.capabilityId);
    await publisher.publish(
      {
        decision: "revise",
        capabilityId: created.capabilityId,
        expectedBindingRevision: long.binding.revisionNumber,
        proposal: {
          ...proposal,
          effects: [{ kind: "instruction", content: "Short." }],
          activationMode: "always",
        },
      },
      context,
      new AbortController().signal,
    );
    const file = join(root, capabilityWorkingDocumentPath(long.document));
    const restoredBytes = await workspace.reads.readRevision(long.document);
    await writeFile(file, restoredBytes);
    for (const _scan of [1, 2]) {
      const report = await publisher.recordDocumentEdits(context, new AbortController().signal);
      expect(report.problems).toEqual([
        expect.objectContaining({
          capabilityId: created.capabilityId,
          error: expect.stringContaining("at most 2000"),
        }),
      ]);
      expect(await workspace.reads.readWorkingFile(capabilityWorkingDocumentPath(long.document))).toEqual(
        restoredBytes,
      );
    }
  });

  test("keeps always-active guidance short", async () => {
    const { workspace, publisher, context } = await setup();
    const proposal = {
      name: "Long rules",
      description: "Many rules.",
      applicability: "Every turn.",
      summary: "Long rules.",
      rationale: "Fixture.",
      anticipatedEffect: "None.",
      effects: [{ kind: "instruction" as const, content: "x".repeat(2_001) }],
      consequence: "ordinary" as const,
      consequenceDescription: "Fixture.",
    };
    await expect(
      publisher.publish(
        { decision: "create", proposal: { ...proposal, activationMode: "always" } },
        context,
        new AbortController().signal,
      ),
    ).rejects.toThrow("at most 2000 characters");
    const relevant = await publisher.publish(
      { decision: "create", proposal },
      context,
      new AbortController().signal,
    );
    if (relevant.status !== "activated") throw new Error("Expected activation");
    await expect(publisher.assertCurrentGuidanceFitsAlways(relevant.capabilityId)).rejects.toThrow(
      "at most 2000 characters",
    );

    // A pending always-active revision cannot be amended into guidance that is too long.
    const gated = await publisher.publish(
      {
        decision: "create",
        proposal: {
          ...proposal,
          name: "Gated rules",
          effects: [{ kind: "instruction", content: "Short guidance." }],
          activationMode: "always",
          consequence: "recovery_control",
          consequenceDescription: "Changes recovery control.",
        },
      },
      context,
      new AbortController().signal,
    );
    if (gated.status !== "pending") throw new Error("Expected a pending gate");
    const [gate] = await workspace.capabilities.listPendingGates();
    if (!gate) throw new Error("Expected the pending gate");
    await expect(
      publisher.replacePendingGate(
        {
          gateRequestId: gate.gateRequestId,
          proposal: { ...proposal, name: "Gated rules", consequence: "recovery_control" },
          instruction: "Add every rule.",
        },
        { actor: context.actor, project: context.project },
        new AbortController().signal,
      ),
    ).rejects.toThrow("at most 2000 characters");
    await expect(publisher.assertGateFitsAlways(gate.gateRequestId)).resolves.toBeUndefined();
  });
});
