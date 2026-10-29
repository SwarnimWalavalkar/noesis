import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityEffects, createAtomicCapabilityRegistry } from "@noesis/capabilities";
import {
  capabilityGuidance,
  capabilityRevisionRef,
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
  const registry = createAtomicCapabilityRegistry();
  const publisher = createCapabilityPublisher({ workspace, store: workspace.capabilities, registry });
  const context = Object.freeze({
    project: Object.freeze({ projectId: "project-files", root }),
    sessionId: "session-files",
    evidenceRefs: [message],
    actor: Object.freeze({ actorId: "test", kind: "noesis" as const }),
  });
  return { root, workspace, registry, publisher, context, message };
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

  test("moves a Capability made before Capability files into a file", async () => {
    const { workspace, registry, publisher, context, message } = await setup();
    const actor = Object.freeze({ actorId: "test", kind: "noesis" as const });
    const material = await workspace.definitions.recordWorkingDefinition({
      workingPath: "capabilities/capability-old/revision-old/instruction-1.md",
      // Longer than new always-active guidance may be; the move keeps it as it was.
      bytes: new TextEncoder().encode(`Cite the primary source.${" Keep citations exact.".repeat(120)}\n`),
      actor,
    });
    const router = await workspace.definitions.recordWorkingDefinition({
      workingPath: "capabilities/capability-old/router.json",
      bytes: new TextEncoder().encode("{}\n"),
      actor,
    });
    registry.registerCapability({
      capabilityId: "capability-old",
      name: "Cite sources",
      scope: "general",
      intent: "Research answers.",
    });
    const reference = registry.constructRevision({
      definitionState: "candidate",
      capabilityRevisionId: "revision-old",
      capabilityId: "capability-old",
      effects: [{ kind: "instruction", material }],
      promptModules: [material],
      skills: [],
      tools: [],
      routerRevision: router,
      routerStrategyId: "fixture",
      activationPolicy: { mode: "automatic_low_risk", scope: "general" },
      permissionManifest: { effects: [], resourcePatterns: [], credentialRefs: [] },
      evidenceRefs: [message],
      sourceEvaluationDefinitions: [],
      requestedPermissionDelta: { addedEffects: [], widenedResources: [], addedCredentialRefs: [] },
    });
    const revision = registry.getRevision(reference);
    if (!revision) throw new Error("Expected the fixture revision");
    await workspace.capabilities.create({
      definition: {
        capabilityId: "capability-old",
        name: "Cite sources",
        description: "Cite the primary source.",
        applicability: "Research answers.",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      revision: {
        revision,
        reference: capabilityRevisionRef(revision),
        summary: "Cite sources.",
        rationale: "Fixture.",
        anticipatedEffect: "Answers cite sources.",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      binding: {
        capabilityId: "capability-old",
        revision: capabilityRevisionRef(revision),
        scope: { kind: "global" },
        activationMode: "always",
        state: "paused",
      },
    });

    await expect(publisher.moveToDocuments(context, new AbortController().signal)).resolves.toBe(1);
    const moved = await current(workspace, "capability-old");
    expect(moved.binding.state).toBe("paused");
    expect(capabilityEffects(moved.lifecycle.revision).map((effect) => effect.kind)).toEqual(["instruction"]);
    expect(
      capabilityGuidance(new TextDecoder().decode(await workspace.reads.readRevision(moved.document))),
    ).toMatch(/^Cite the primary source\. Keep citations exact\./u);
    expect(moved.binding.activationMode).toBe("always");
    // A second run finds nothing left to move.
    await expect(publisher.moveToDocuments(context, new AbortController().signal)).resolves.toBe(0);

    // Restoring the revision from before Capability files moves it into a file again, and finishes.
    const restored = await publisher.publish(
      {
        decision: "restore",
        capabilityId: "capability-old",
        expectedBindingRevision: moved.binding.revisionNumber,
        capabilityRevisionId: "revision-old",
        reason: "Go back to the original.",
      },
      context,
      new AbortController().signal,
    );
    expect(restored).toMatchObject({ status: "restored" });
    const afterRestore = await current(workspace, "capability-old");
    expect(afterRestore.binding.revision.capabilityRevisionId).not.toBe("revision-old");
    expect(
      capabilityGuidance(new TextDecoder().decode(await workspace.reads.readRevision(afterRestore.document))),
    ).toMatch(/^Cite the primary source\./u);
  });
});
