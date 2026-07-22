import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import { createUserCriterionRepository, createWorkspaceUserCriterionPorts } from "../src/index.ts";

const user = { actorId: "barrier-user", kind: "user" } as const;
const noesis = { actorId: "barrier-reflector", kind: "noesis" } as const;

describe("Barrier F WorkspaceStore criterion integration", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  test("migrates, edits, and pins a criterion while preserving its immutable cited revision", async () => {
    root = await mkdtemp(join(tmpdir(), "noesis-barrier-criteria-"));
    const firstStore = await createWorkspaceStore(root);
    await firstStore.operational.sessions.put({
      sessionId: "criterion-session",
      title: "Criterion source",
      status: "completed",
      provider: "fake",
      model: "fake",
      runtime: "fake",
      createdAt: "2026-07-22T12:00:00.000Z",
      updatedAt: "2026-07-22T12:01:00.000Z",
      metadata: {},
    });
    const citation = await firstStore.operational.messages.put({
      messageId: "criterion-message",
      sessionId: "criterion-session",
      role: "user",
      content: "Always preserve the author's sentence rhythm.",
      sensitivity: "normal",
      createdAt: "2026-07-22T12:00:30.000Z",
      metadata: {},
    });
    const repository = createUserCriterionRepository({
      ...createWorkspaceUserCriterionPorts(firstStore),
      nextCriterionId: () => "preserve-rhythm",
    });
    const created = await repository.create({
      source: "explicit_statement",
      scope: "writing",
      evaluatorInstruction: "Preserve the author's sentence rhythm.",
      evidenceRefs: [citation],
      actor: user,
    });
    if (!created.ok) throw new Error(created.error.message);
    const originalRevision = created.value.metadata.definitionRevision;
    const originalBytes = await firstStore.reads.readRevision(originalRevision);

    const revised = await repository.revise({
      criterionId: "preserve-rhythm",
      evaluatorInstruction: "Preserve sentence rhythm and paragraph cadence.",
      actor: noesis,
    });
    if (!revised.ok) throw new Error(revised.error.message);
    const pinned = await repository.pin("preserve-rhythm", true, user, "Explicit user pin");
    if (!pinned.ok) throw new Error(pinned.error.message);
    expect(pinned.value.definition).toMatchObject({ revision: 3, pinned: true });
    firstStore.close();

    const reopenedStore = await createWorkspaceStore(root);
    const reopened = createUserCriterionRepository(createWorkspaceUserCriterionPorts(reopenedStore));
    const current = await reopened.inspect("preserve-rhythm");
    const original = await reopened.inspect("preserve-rhythm", 1);
    if (!current.ok) throw new Error(current.error.message);
    if (!original.ok) throw new Error(original.error.message);
    expect(current.value.definition).toMatchObject({ revision: 3, pinned: true });
    expect(original.value.definition).toMatchObject({
      revision: 1,
      evaluatorInstruction: "Preserve the author's sentence rhythm.",
      evidenceRefs: [citation],
    });
    expect(await reopenedStore.reads.readRevision(originalRevision)).toEqual(originalBytes);
    expect(
      await reopenedStore.definitionMetadata.getCurrent("user_criterion", "preserve-rhythm"),
    ).toMatchObject({
      revision: 3,
      definitionRevision: current.value.metadata.definitionRevision,
    });
    expect("activate" in reopened).toBe(false);
    reopenedStore.close();
  });
});
