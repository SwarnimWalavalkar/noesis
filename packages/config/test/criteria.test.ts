import { createConditionalObject, sha256, err, ok, type FileRevisionRef } from "@noesis/domain";
import { describe, expect, test } from "vitest";
import {
  createUserCriterionRepository,
  type CriterionRevisionCommitRequest,
  type CriterionRevisionMetadata,
  type UserCriterionDefinitionPort,
  type UserCriterionMetadataPort,
} from "../src/index.ts";
// SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
const user = { actorId: "user-1", kind: "user" } as const;
// SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
const noesis = { actorId: "reflector-1", kind: "noesis" } as const;
function createFakeDefinitionPort(): UserCriterionDefinitionPort & {
  readonly corrupt: (ref: FileRevisionRef, content: string) => void;
} {
  const snapshots = new Map<string, Uint8Array>();
  let sequence = 0;
  return {
    recordWorkingDefinition: async (request) => {
      sequence += 1;
      const revisionId = `file-revision-${sequence}`;
      const ref: FileRevisionRef = {
        kind: "file_revision",
        revisionId,
        workingPath: request.workingPath,
        snapshotPath: `revisions/${revisionId}.json`,
        contentDigest: sha256(request.bytes),
      };
      snapshots.set(revisionId, request.bytes.slice());
      return ref;
    },
    readRevision: async (ref) => {
      const bytes = snapshots.get(ref.revisionId);
      if (!bytes) throw new Error(`Missing revision ${ref.revisionId}`);
      return bytes.slice();
    },
    corrupt: (ref, content) => {
      snapshots.set(ref.revisionId, new TextEncoder().encode(content));
    },
  };
}
function createFakeMetadataPort(): UserCriterionMetadataPort & {
  readonly history: (criterionId: string) => readonly CriterionRevisionMetadata[];
} {
  const histories = new Map<string, CriterionRevisionMetadata[]>();
  let activitySequence = 0;
  const current = (criterionId: string): CriterionRevisionMetadata | undefined =>
    histories.get(criterionId)?.at(-1);
  const commitRevision = async (request: CriterionRevisionCommitRequest) => {
    const previous = current(request.criterionId);
    if (previous?.definitionRevision.revisionId !== request.expectedCurrentRevisionId) {
      // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
      return err({ code: "conflict" as const, message: "Current criterion revision changed" });
    }
    if (request.revision !== (previous?.revision ?? 0) + 1) {
      // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
      return err({ code: "conflict" as const, message: "Criterion revision is not monotonic" });
    }
    activitySequence += 1;
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const metadata: CriterionRevisionMetadata = createConditionalObject({
      criterionId: request.criterionId,
      revision: request.revision,
      definitionRevision: request.definitionRevision,
      fileRevisionRow: {
        kind: "database_row",
        table: "file_revisions",
        rowId: `file-row-${activitySequence}`,
      },
      activityRow: {
        kind: "database_row",
        table: "activity_log",
        rowId: `activity-${activitySequence}`,
      },
    } as const)
      .addOptional(previous ? { predecessorRevisionId: previous.definitionRevision.revisionId } : undefined)
      .finish();
    histories.set(request.criterionId, [...(histories.get(request.criterionId) ?? []), metadata]);
    return ok(metadata);
  };
  return {
    getCurrent: async (criterionId) => current(criterionId),
    listCurrent: async () => [...histories.values()].flatMap((history) => history.at(-1) ?? []),
    listRevisions: async (criterionId) => histories.get(criterionId) ?? [],
    commitRevision,
    history: (criterionId) => histories.get(criterionId) ?? [],
  };
}
function createRepository() {
  const definitions = createFakeDefinitionPort();
  const metadata = createFakeMetadataPort();
  return {
    definitions,
    metadata,
    repository: createUserCriterionRepository({
      definitions,
      metadata,
      nextCriterionId: () => "preserve-voice",
    }),
  };
}
describe("user criterion repository", () => {
  test("creates, revises, pins, and retires criteria without rewriting prior revisions", async () => {
    const { repository, metadata } = createRepository();
    const created = await repository.create({
      source: "correction",
      scope: "writing",
      evaluatorInstruction: "Preserve the user's voice.",
      evidenceRefs: [{ kind: "database_row", table: "messages", rowId: "message-1" }],
      actor: user,
    });
    expect(created.ok).toBe(true);
    const revised = await repository.revise({
      criterionId: "preserve-voice",
      evaluatorInstruction: "Preserve voice and sentence rhythm.",
      actor: noesis,
    });
    expect(revised.ok && revised.value.definition.revision).toBe(2);
    const pinned = await repository.pin("preserve-voice", true, user, "Keep this contract stable");
    expect(pinned.ok && pinned.value.definition).toMatchObject({ revision: 3, pinned: true });
    const silentRewrite = await repository.revise({
      criterionId: "preserve-voice",
      evaluatorInstruction: "Replace the user's voice.",
      actor: noesis,
    });
    expect(silentRewrite).toMatchObject({ ok: false, error: { code: "pinned" } });
    await expect(repository.pin("preserve-voice", false, noesis)).resolves.toMatchObject({
      ok: false,
      error: { code: "pinned" },
    });
    const explicitRewrite = await repository.revise({
      criterionId: "preserve-voice",
      evaluatorInstruction: "Preserve voice, rhythm, and structure.",
      actor: user,
    });
    expect(explicitRewrite.ok && explicitRewrite.value.definition).toMatchObject({
      revision: 4,
      pinned: true,
    });
    const retired = await repository.retire("preserve-voice", user, "No longer applies");
    expect(retired.ok && retired.value.definition).toMatchObject({ revision: 5, status: "retired" });
    expect(metadata.history("preserve-voice")).toHaveLength(5);
    const original = await repository.inspect("preserve-voice", 1);
    expect(original.ok && original.value.definition).toMatchObject({
      revision: 1,
      status: "active",
      pinned: false,
      evaluatorInstruction: "Preserve the user's voice.",
    });
    expect(
      new Set(metadata.history("preserve-voice").map((entry) => entry.definitionRevision.revisionId)).size,
    ).toBe(5);
  });
  test("builds scope-filtered immutable relevance snapshots with prompt ownership and provenance", async () => {
    const definitions = createFakeDefinitionPort();
    const metadata = createFakeMetadataPort();
    let id = 0;
    const repository = createUserCriterionRepository({
      definitions,
      metadata,
      nextCriterionId: () => `criterion-${++id}`,
    });
    await repository.create({
      source: "explicit_statement",
      scope: "writing",
      evaluatorInstruction: "Preserve my voice.",
      evidenceRefs: [{ kind: "database_row", table: "messages", rowId: "message-1" }],
      promptOwnership: { owner: "user", layer: "user_constitution" },
      actor: user,
    });
    await repository.create({
      source: "expert_command",
      scope: "research",
      evaluatorInstruction: "Cite primary sources.",
      evidenceRefs: [
        {
          kind: "file_revision",
          revisionId: "source-1",
          workingPath: "sources/a",
          snapshotPath: "revisions/a",
          contentDigest: "a".repeat(64),
        },
      ],
      actor: user,
    });
    const snapshot = await repository.snapshotRelevant({
      snapshotId: "criteria-snapshot-1",
      scope: "writing/email",
      candidateRevision: {
        kind: "capability_revision",
        capabilityId: "writing",
        capabilityRevisionId: "revision-1",
        bundleDigest: "b".repeat(64),
      },
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.selectedCriterionIds).toEqual(["criterion-1"]);
    expect(snapshot.value.criteria[0]).toMatchObject({
      criterionId: "criterion-1",
      revision: 1,
      promptOwnership: { owner: "user", layer: "user_constitution" },
      evidenceRefs: [{ kind: "database_row", table: "messages", rowId: "message-1" }],
    });
    expect(snapshot.value.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(snapshot.value.criteria)).toBe(true);
    expect(Object.isFrozen(snapshot.value.criteria[0])).toBe(true);
    expect(Object.isFrozen(snapshot.value.criteria[0]?.evidenceRefs)).toBe(true);
  });
  test("fails closed when an immutable criterion file is malformed", async () => {
    const { repository, definitions } = createRepository();
    const created = await repository.create({
      source: "correction",
      scope: "writing",
      evaluatorInstruction: "Preserve my voice.",
      evidenceRefs: [],
      actor: user,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    definitions.corrupt(created.value.metadata.definitionRevision, "{not-json");
    await expect(repository.inspect("preserve-voice")).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_definition", criterionId: "preserve-voice", revision: 1 },
    });
  });
  test("exposes definition controls only, with no activation or authority mutation handle", () => {
    const { repository } = createRepository();
    expect("activate" in repository).toBe(false);
    expect("promote" in repository).toBe(false);
    expect("grant" in repository).toBe(false);
  });
});
