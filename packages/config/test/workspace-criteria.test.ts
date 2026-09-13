import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import { createUserCriterionRepository, createWorkspaceUserCriterionPorts } from "../src/index.ts";

// SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
const user = { actorId: "barrier-user", kind: "user" } as const;
// SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
const noesis = { actorId: "barrier-reflector", kind: "noesis" } as const;

describe("Barrier F WorkspaceStore criterion integration", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  test("revises, pins, scopes, and retires criteria while preserving immutable history", async () => {
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
      promptOwnership: { owner: "user", layer: "user_constitution" },
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
    for (const forbidden of ["activate", "promote", "grant"]) expect(forbidden in reopened).toBe(false);
    await expect(
      reopened.revise({
        criterionId: "preserve-rhythm",
        evaluatorInstruction: "Replace the voice.",
        actor: noesis,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "pinned" } });
    await expect(reopened.pin("preserve-rhythm", false, noesis)).resolves.toMatchObject({
      ok: false,
      error: { code: "pinned" },
    });
    const other = createUserCriterionRepository({
      ...createWorkspaceUserCriterionPorts(reopenedStore),
      nextCriterionId: () => "research",
    });
    await expect(
      other.create({
        source: "expert_command",
        scope: "research",
        evaluatorInstruction: "Cite primary sources.",
        evidenceRefs: [originalRevision],
        actor: user,
      }),
    ).resolves.toMatchObject({ ok: true });
    const snapshot = await reopened.snapshotRelevant({
      snapshotId: "criteria-snapshot",
      scope: "writing/email",
      candidateRevision: {
        kind: "capability_revision",
        capabilityId: "writing",
        capabilityRevisionId: "revision-1",
        bundleDigest: "b".repeat(64),
      },
    });
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    expect(snapshot.value.selectedCriterionIds).toEqual(["preserve-rhythm"]);
    expect(snapshot.value.criteria[0]).toMatchObject({
      criterionId: "preserve-rhythm",
      revision: 3,
      promptOwnership: { owner: "user", layer: "user_constitution" },
      evidenceRefs: [citation],
    });
    expect(snapshot.value.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(snapshot.value.criteria)).toBe(true);
    expect(Object.isFrozen(snapshot.value.criteria[0])).toBe(true);
    expect(Object.isFrozen(snapshot.value.criteria[0]?.evidenceRefs)).toBe(true);
    await expect(
      reopened.revise({
        criterionId: "preserve-rhythm",
        evaluatorInstruction: "Preserve voice, rhythm, and structure.",
        actor: user,
      }),
    ).resolves.toMatchObject({ ok: true, value: { definition: { revision: 4, pinned: true } } });
    await expect(reopened.retire("preserve-rhythm", user, "No longer applies")).resolves.toMatchObject({
      ok: true,
      value: { definition: { revision: 5, status: "retired" } },
    });
    const history = await reopenedStore.definitionMetadata.listRevisions("user_criterion", "preserve-rhythm");
    expect(history).toHaveLength(5);
    expect(new Set(history.map((entry) => entry.definitionRevision.revisionId)).size).toBe(5);
    expect(await reopenedStore.reads.readRevision(originalRevision)).toEqual(originalBytes);
    await expect(reopened.inspect("preserve-rhythm", 1)).resolves.toMatchObject({
      ok: true,
      value: { definition: { revision: 1, status: "active", pinned: false } },
    });
    reopenedStore.close();
  });

  test("fails closed on malformed criterion JSON and corrupted revision bytes", async () => {
    root = await mkdtemp(join(tmpdir(), "noesis-criterion-corrupt-"));
    const store = await createWorkspaceStore(root);
    try {
      const published = await store.definitionPublications.publish({
        namespace: "user_criterion",
        definitionId: "corrupt",
        revision: 1,
        workingPath: "config/criteria/corrupt.json",
        bytes: Buffer.from("{not-json"),
        activity: { kind: "criterion.created", actor: user },
      });
      if (!published.ok) throw new Error(published.error.message);
      const repository = createUserCriterionRepository(createWorkspaceUserCriterionPorts(store));
      await expect(repository.inspect("corrupt")).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_definition", criterionId: "corrupt", revision: 1 },
      });
      await writeFile(join(root, published.value.definitionRevision.snapshotPath), "changed recorded bytes");
      await expect(repository.inspect("corrupt")).resolves.toMatchObject({
        ok: false,
        error: { code: "storage_error", criterionId: "corrupt", revision: 1 },
      });
    } finally {
      store.close();
    }
  });

  test("publishes only the criterion revision that wins a concurrent pointer CAS", async () => {
    root = await mkdtemp(join(tmpdir(), "noesis-criterion-race-"));
    const store = await createWorkspaceStore(root);
    const publish = (instruction: string) =>
      store.definitionPublications.publish({
        namespace: "user_criterion",
        definitionId: "race",
        revision: 1,
        workingPath: "config/criteria/race.json",
        bytes: Buffer.from(instruction),
        activity: { kind: "criterion.created", actor: user },
      });

    const results = await Promise.all([publish("winner-a"), publish("winner-b")]);
    const winner = results.find((result) => result.ok);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    if (!winner?.ok) throw new Error("Expected one publication winner");
    expect(await readFile(join(store.paths.definitions, "config", "criteria", "race.json"), "utf8")).toBe(
      Buffer.from(await store.reads.readRevision(winner.value.definitionRevision)).toString(),
    );
    expect(await store.definitionPublications.cleanupAbandoned()).toBe(0);
    store.close();
  });

  test("recovers a committed criterion publication after a crash before working-file publish", async () => {
    root = await mkdtemp(join(tmpdir(), "noesis-criterion-recovery-"));
    let crash = true;
    const first = await createWorkspaceStore(root, {
      afterDefinitionCommitForTesting: () => {
        if (crash) {
          crash = false;
          throw new Error("simulated publication crash");
        }
      },
    });
    const repository = createUserCriterionRepository({
      ...createWorkspaceUserCriterionPorts(first),
      nextCriterionId: () => "recoverable",
    });
    await expect(
      repository.create({
        source: "explicit_statement",
        scope: "writing",
        evaluatorInstruction: "Keep immutable bytes recoverable.",
        evidenceRefs: [],
        actor: user,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "storage_error" } });
    first.close();

    const reopened = await createWorkspaceStore(root);
    const recovered = await createUserCriterionRepository(
      createWorkspaceUserCriterionPorts(reopened),
    ).inspect("recoverable");
    expect(recovered).toMatchObject({ ok: true, value: { definition: { revision: 1 } } });
    expect(await reopened.definitionPublications.recoverPending()).toBe(0);
    reopened.close();
  });
});
