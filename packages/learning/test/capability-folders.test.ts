import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  capabilityFolderDigest,
  capabilityGuidance,
  capabilityRevisionRef,
  parseCapabilityDocument,
  renderCapabilityDocument,
  sha256,
} from "@noesis/domain";
import { createWorkspaceStore, type NoesisWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import {
  capabilityDocumentRevision,
  capabilityWorkingFolderPath,
  createCapabilityPublisher,
} from "../src/capability-publisher.ts";

const opened: { root: string; workspace: NoesisWorkspaceStore }[] = [];
afterEach(async () => {
  for (const { root, workspace } of opened.splice(0)) {
    workspace.close();
    await rm(root, { recursive: true, force: true });
  }
});
const signal = new AbortController().signal;
const decoder = new TextDecoder();

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "noesis-capability-folders-"));
  const workspace = await createWorkspaceStore(root);
  opened.push({ root, workspace });
  await workspace.operational.sessions.put({
    sessionId: "session-folders",
    title: "Folders",
    status: "idle",
    provider: "fake",
    model: "fake",
    runtime: "fake",
    createdAt: "2026-10-29T10:00:00.000Z",
    updatedAt: "2026-10-29T10:00:00.000Z",
    metadata: Object.freeze({}),
  });
  const message = await workspace.operational.messages.put({
    messageId: "turn-folders:user",
    sessionId: "session-folders",
    role: "user",
    content: "Review migrations carefully.",
    sensitivity: "normal",
    createdAt: "2026-10-29T10:00:00.000Z",
    metadata: Object.freeze({ turnId: "turn-folders" }),
  });
  const publisher = createCapabilityPublisher({ workspace, store: workspace.capabilities });
  const context = Object.freeze({
    project: Object.freeze({ projectId: "project-folders", root }),
    sessionId: "session-folders",
    evidenceRefs: [message],
    actor: Object.freeze({ actorId: "test", kind: "noesis" as const }),
  });
  const created = await publisher.publish(
    {
      decision: "create",
      proposal: {
        name: "Review: migrations",
        description: "Check a migration before it ships: rollback and data loss.",
        applicability: "Reviewing a database migration.",
        summary: "Review migrations.",
        rationale: "The user asked.",
        anticipatedEffect: "Migrations get checked.",
        effects: [{ kind: "instruction", content: "Check the rollback path first." }],
        consequence: "ordinary",
        consequenceDescription: "Only guidance changes.",
      },
    },
    context,
    signal,
  );
  if (created.status !== "activated") throw new Error("Expected activation");
  const capabilityId = created.capabilityId;
  const currentRevision = async () => {
    const binding = await workspace.capabilities.getBinding(capabilityId);
    if (!binding) throw new Error("Expected a binding");
    const lifecycle = await workspace.capabilities.getRevision(binding.revision);
    if (!lifecycle) throw new Error("Expected a revision");
    return { binding, lifecycle };
  };
  const { lifecycle } = await currentRevision();
  const folder = capabilityWorkingFolderPath(capabilityDocumentRevision(lifecycle));
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(root, folder, path)), { recursive: true });
    await writeFile(join(root, folder, path), text);
  };
  return { root, workspace, publisher, context, capabilityId, currentRevision, folder, write };
}

describe("Capability folders", () => {
  test("SKILL.md is a standard skill that still round-trips the Capability's fields", () => {
    const text = renderCapabilityDocument(
      "review-migrations-abc123",
      {
        name: "Review: migrations",
        when: 'Reviewing a "database" migration.',
        description: "Check rollback: first.",
        guidance: "Check the rollback path first.",
      },
      { rationale: "Asked.", history: [{ date: "2026-10-29", summary: "Created." }] },
    );
    expect(text.startsWith("---\nname: review-migrations-abc123\n")).toBe(true);
    // Only the fields the skill format allows are at the top level.
    expect(
      text
        .slice(4, text.indexOf("\n---\n"))
        .split("\n")
        .filter((line) => !line.startsWith(" ")),
    ).toEqual(["name: review-migrations-abc123", 'description: "Check rollback: first."', "metadata:"]);
    expect(parseCapabilityDocument(text)).toEqual({
      ok: true,
      content: {
        name: "Review: migrations",
        when: 'Reviewing a "database" migration.',
        description: "Check rollback: first.",
        guidance: "Check the rollback path first.",
      },
    });
    expect(capabilityGuidance(text)).toBe("Check the rollback path first.");
  });

  test("a direct edit anywhere in the folder becomes a revision that pins the whole folder", async () => {
    const { root, workspace, publisher, context, capabilityId, currentRevision, folder, write } =
      await setup();
    const first = await currentRevision();
    expect(first.lifecycle.revision.folder?.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    await expect(publisher.recordDocumentEdits(context, signal)).resolves.toEqual({
      recorded: [],
      problems: [],
    });

    await write("references/checklist.md", "- Is there a rollback?\n");
    const added = await publisher.recordDocumentEdits(context, signal);
    expect(added).toMatchObject({ recorded: [{ capabilityId }], problems: [] });
    const second = await currentRevision();
    expect(second.lifecycle.revision.predecessorRevisionId).toBe(
      first.lifecycle.revision.capabilityRevisionId,
    );
    const secondFolder = second.lifecycle.revision.folder;
    if (!secondFolder) throw new Error("Expected a folder");
    expect(secondFolder.files.map((file) => file.path).sort()).toEqual([
      "SKILL.md",
      "references/checklist.md",
    ]);
    expect(secondFolder.digest).toBe(capabilityFolderDigest(secondFolder.files));
    expect(secondFolder.digest).not.toBe(first.lifecycle.revision.folder?.digest);
    // Scanning again without changes records nothing.
    await expect(publisher.recordDocumentEdits(context, signal)).resolves.toEqual({
      recorded: [],
      problems: [],
    });

    // A revision keeps its bytes when the working file changes, and any later publication keeps the file.
    const pinned = secondFolder.files.find((file) => file.path === "references/checklist.md");
    if (!pinned) throw new Error("Expected the pinned file");
    await write("references/checklist.md", "- Changed afterwards\n");
    await publisher.recordDocumentEdits(context, signal);
    expect(decoder.decode(await workspace.reads.readRevision(pinned.revision))).toBe(
      "- Is there a rollback?\n",
    );
    const third = await currentRevision();
    await publisher.publish(
      {
        decision: "revise",
        capabilityId,
        expectedBindingRevision: third.binding.revisionNumber,
        proposal: {
          name: "Review: migrations",
          description: "Check a migration before it ships.",
          applicability: "Reviewing a database migration.",
          summary: "Reword.",
          rationale: "Clearer.",
          anticipatedEffect: "Clearer guidance.",
          effects: [{ kind: "instruction", content: "Check the rollback path first, always." }],
          consequence: "ordinary",
          consequenceDescription: "Only guidance changes.",
        },
      },
      context,
      signal,
    );
    const fourth = await currentRevision();
    expect(fourth.lifecycle.revision.folder?.files.map((file) => file.path).sort()).toEqual([
      "SKILL.md",
      "references/checklist.md",
    ]);
    expect(await readFile(join(root, folder, "references/checklist.md"), "utf8")).toBe(
      "- Changed afterwards\n",
    );

    // Restoring the first revision rewrites the working folder, and that is not read as an edit.
    await publisher.publish(
      {
        decision: "restore",
        capabilityId,
        expectedBindingRevision: fourth.binding.revisionNumber,
        capabilityRevisionId: first.lifecycle.revision.capabilityRevisionId,
        reason: "Back to the start.",
      },
      context,
      signal,
    );
    await expect(readFile(join(root, folder, "references/checklist.md"))).rejects.toThrow();
    expect(await readFile(join(root, folder, "SKILL.md"), "utf8")).toContain(
      "Check the rollback path first.",
    );
    await expect(publisher.recordDocumentEdits(context, signal)).resolves.toEqual({
      recorded: [],
      problems: [],
    });
    const restored = await currentRevision();
    expect(restored.binding.revision.capabilityRevisionId).toBe(
      first.lifecycle.revision.capabilityRevisionId,
    );
  });

  test("an unusable folder stays as it is and is reported", async () => {
    const { root, publisher, context, capabilityId, currentRevision, folder, write } = await setup();
    const before = await currentRevision();
    await symlink("/etc/hosts", join(root, folder, "hosts"));
    const linked = await publisher.recordDocumentEdits(context, signal);
    expect(linked.recorded).toEqual([]);
    expect(linked.problems).toEqual([
      expect.objectContaining({ capabilityId, error: expect.stringContaining("link") }),
    ]);
    await rm(join(root, folder, "hosts"));

    // Programs cannot be read without a Program library, so the edit waits rather than losing them.
    await write("programs/check/program.json", "{}");
    const unreadable = await publisher.recordDocumentEdits(context, signal);
    expect(unreadable.recorded).toEqual([]);
    expect(unreadable.problems).toEqual([
      expect.objectContaining({ capabilityId, error: expect.stringContaining("Programs") }),
    ]);
    expect((await currentRevision()).binding.revision).toEqual(before.binding.revision);
    expect(await readFile(join(root, folder, "programs/check/program.json"), "utf8")).toBe("{}");
  });

  test("moves a single-file Capability into a folder without a new revision, and can repeat safely", async () => {
    const { root, workspace, publisher, context } = await setup();
    const actor = Object.freeze({ actorId: "capability-files", kind: "system" as const });
    const legacyText = [
      "---",
      "name: Use pnpm",
      "when: Package commands.",
      "description: Use pnpm.",
      "---",
      "",
      "Run pnpm, not npm.",
      "",
      "<!-- Noesis writes everything below this line from the Capability's history. Edits below it are ignored. -->",
      "",
      "## Why",
      "",
      "- Reason: Asked.",
      "",
    ].join("\n");
    const bytes = new TextEncoder().encode(legacyText);
    const material = await workspace.definitions.recordCandidateDefinition({
      workingPath: "capabilities/use-pnpm-abc123.md",
      bytes,
      actor,
    });
    await workspace.definitions.recordWorkingDefinition({
      workingPath: "capabilities/use-pnpm-abc123.md",
      bytes,
      actor,
    });
    const revision = Object.freeze({
      capabilityRevisionId: "revision-legacy",
      capabilityId: "capability-legacy",
      effects: Object.freeze([Object.freeze({ kind: "instruction" as const, material })]),
      evidenceRefs: Object.freeze([material]),
    });
    await workspace.capabilities.create({
      definition: Object.freeze({
        capabilityId: "capability-legacy",
        name: "Use pnpm",
        description: "Use pnpm.",
        applicability: "Package commands.",
        createdAt: "2026-10-29T10:00:00.000Z",
      }),
      revision: Object.freeze({
        revision,
        reference: capabilityRevisionRef(revision),
        summary: "Created.",
        rationale: "Asked.",
        anticipatedEffect: "pnpm.",
        createdAt: "2026-10-29T10:00:00.000Z",
      }),
      binding: Object.freeze({
        capabilityId: "capability-legacy",
        revision: capabilityRevisionRef(revision),
        scope: Object.freeze({ kind: "global" as const }),
        activationMode: "relevant" as const,
        state: "active" as const,
      }),
    });
    const legacyPath = join(root, "definitions/capabilities/use-pnpm-abc123.md");
    const skillPath = join(root, "definitions/capabilities/use-pnpm-abc123/SKILL.md");
    const pinned = () => workspace.capabilities.getBinding("capability-legacy");
    const before = await pinned();

    await expect(publisher.recordDocumentEdits(context, signal)).resolves.toEqual({
      recorded: [],
      problems: [],
    });
    await expect(readFile(legacyPath)).rejects.toThrow();
    const moved = await readFile(skillPath, "utf8");
    expect(moved.startsWith("---\nname: use-pnpm-abc123\n")).toBe(true);
    expect(parseCapabilityDocument(moved)).toMatchObject({
      ok: true,
      content: { name: "Use pnpm", when: "Package commands.", guidance: "Run pnpm, not npm." },
    });
    // The revision and so its track record stay exactly as they were.
    expect((await pinned())?.revision).toEqual(before?.revision);
    expect(sha256(await workspace.reads.readRevision(material))).toBe(material.contentDigest);
    // Running it again changes nothing.
    await expect(publisher.recordDocumentEdits(context, signal)).resolves.toEqual({
      recorded: [],
      problems: [],
    });
    expect(await readFile(skillPath, "utf8")).toBe(moved);

    // A crash after the copy leaves both files. The next scan removes the old one and keeps the folder.
    await writeFile(legacyPath, bytes);
    await publisher.recordDocumentEdits(context, signal);
    await expect(readFile(legacyPath)).rejects.toThrow();
    expect(await readFile(skillPath, "utf8")).toBe(moved);

    // An edit Noesis never recorded survives the move and becomes a revision in folder form.
    await rm(skillPath);
    await writeFile(legacyPath, legacyText.replace("Run pnpm, not npm.", "Run pnpm always."));
    const report = await publisher.recordDocumentEdits(context, signal);
    expect(report).toMatchObject({ recorded: [{ capabilityId: "capability-legacy" }], problems: [] });
    await expect(readFile(legacyPath)).rejects.toThrow();
    const after = await pinned();
    if (!after) throw new Error("Expected a binding");
    const edited = await workspace.capabilities.getRevision(after.revision);
    expect(edited?.revision.folder?.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(await readFile(skillPath, "utf8")).toContain("Run pnpm always.");

    // Restoring the single-file revision writes it back as a folder.
    await publisher.publish(
      {
        decision: "restore",
        capabilityId: "capability-legacy",
        expectedBindingRevision: after.revisionNumber,
        capabilityRevisionId: "revision-legacy",
        reason: "Back.",
      },
      context,
      signal,
    );
    expect(await readFile(skillPath, "utf8")).toBe(moved);
    await expect(publisher.recordDocumentEdits(context, signal)).resolves.toEqual({
      recorded: [],
      problems: [],
    });
  });
});
