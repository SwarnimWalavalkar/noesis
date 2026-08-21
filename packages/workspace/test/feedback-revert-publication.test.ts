import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type CapabilityRevisionRef, canonicalJson, type FileRevisionRef, sha256 } from "@noesis/domain";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkspaceStore, type NoesisWorkspaceStore } from "../src/index.ts";
import { createWorkspaceRuntimeInternals } from "../src/protected-runtime.ts";
import type { CommitExperimentOutcomeRequest } from "../src/types.ts";

// SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
const actor = Object.freeze({ actorId: "revert-publication-test", kind: "system" as const });
const encoder = new TextEncoder();
const permissionManifest = Object.freeze({
  effects: Object.freeze(["read"]),
  resourcePatterns: Object.freeze(["workspace:"]),
  credentialRefs: Object.freeze([]),
});

interface RevertFixture {
  readonly store: NoesisWorkspaceStore;
  readonly request: CommitExperimentOutcomeRequest;
  readonly baselinePrompt: FileRevisionRef;
  readonly baselineRetired: FileRevisionRef;
  readonly candidatePrompt: FileRevisionRef;
  readonly candidateOnly: FileRevisionRef;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function activeRevision(
  store: NoesisWorkspaceStore,
  relativePath: string,
  body: string,
): Promise<FileRevisionRef> {
  const staged = await store.stageDefinition({
    targetArea: "active",
    relativePath,
    bytes: encoder.encode(body),
    actor,
  });
  return await store.registerStagedDefinition(staged.stageId);
}

function revisionRef(capabilityId: string, revisionId: string, digestSeed: string): CapabilityRevisionRef {
  return Object.freeze({
    kind: "capability_revision",
    capabilityId,
    capabilityRevisionId: revisionId,
    bundleDigest: sha256(digestSeed),
  });
}

async function createRevertFixture(
  options: Parameters<typeof createWorkspaceStore>[1] = {},
): Promise<RevertFixture> {
  const root = await mkdtemp(join(tmpdir(), "noesis-revert-publication-"));
  roots.push(root);
  const store = await createWorkspaceStore(root, options);
  const capabilityId = "capability-revert-publication";
  const experimentId = "experiment-revert-publication";
  const baselinePrompt = await activeRevision(store, "capability-revert/prompt.md", "baseline prompt");
  const baselineRetired = await activeRevision(
    store,
    "capability-revert/retired.md",
    "baseline retained slot",
  );
  const candidatePrompt = await activeRevision(store, "capability-revert/prompt.md", "candidate prompt");
  const candidateOnly = await activeRevision(
    store,
    "capability-revert/candidate-only.md",
    "candidate-only slot",
  );
  await unlink(join(root, baselineRetired.workingPath));

  const baseline = revisionRef(capabilityId, "baseline-r1", "baseline");
  const candidate = revisionRef(capabilityId, "candidate-r2", "candidate");
  const prefix = `${sha256(capabilityId)}:`;
  const sourceActivationId = "activation-revert-source";
  const currentActivationId = "activation-revert-current";
  const timestamp = "2026-07-25T00:00:00.000Z";
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  const experiment = Object.freeze({
    experimentId,
    hypothesis: "Restore the exact prior active definition set",
    scope: "workspace:test",
    evidenceRefs: Object.freeze([]),
    baselineRevision: baseline,
    candidateRevisions: Object.freeze([candidate]),
    activatedRevision: candidate,
    feedbackSignalIds: Object.freeze([]),
    status: "observing" as const,
  });
  const binding = Object.freeze({
    experimentId,
    candidateRevision: candidate,
    manifestRevision: candidatePrompt,
    preflightId: "preflight-revert-publication",
    planId: "plan-revert-publication",
    candidateDigest: candidate.bundleDigest,
    manifestDigest: candidatePrompt.contentDigest,
    suiteDigest: sha256("suite"),
    preflightDigest: sha256("preflight"),
    reportDigest: sha256("report"),
    definitionSetDigest: sha256("definitions"),
    controlRevisionId: null,
  });
  const policySnapshot = Object.freeze({ risk: "low" });
  const seed = new DatabaseSync(store.unsafeDatabasePathForTesting);
  seed.exec("PRAGMA foreign_keys = OFF");
  seed
    .prepare(
      `INSERT INTO activations(
        activation_id, revision, previous_activation_id, definitions_json,
        capability_revisions_json, preflight_id, created_at
      ) VALUES (?, 1, NULL, ?, ?, NULL, ?)`,
    )
    .run(
      sourceActivationId,
      JSON.stringify({
        [`${prefix}prompt`]: baselinePrompt,
        [`${prefix}retired`]: baselineRetired,
      }),
      JSON.stringify({ [capabilityId]: baseline }),
      timestamp,
    );
  seed
    .prepare(
      `INSERT INTO activations(
        activation_id, revision, previous_activation_id, definitions_json,
        capability_revisions_json, preflight_id, created_at
      ) VALUES (?, 2, ?, ?, ?, NULL, ?)`,
    )
    .run(
      currentActivationId,
      sourceActivationId,
      JSON.stringify({
        [`${prefix}prompt`]: candidatePrompt,
        [`${prefix}candidate-only`]: candidateOnly,
      }),
      JSON.stringify({ [capabilityId]: candidate }),
      timestamp,
    );
  seed
    .prepare(
      `INSERT INTO activation_state(state_id, activation_id, revision, updated_at)
       VALUES ('current', ?, 2, ?)`,
    )
    .run(currentActivationId, timestamp);
  seed
    .prepare(
      `INSERT INTO activation_pointers(
        pointer_id, capability_id, activation_id, capability_revision_id, updated_at,
        capability_revision_json
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "pointer-revert-publication",
      capabilityId,
      currentActivationId,
      candidate.capabilityRevisionId,
      timestamp,
      JSON.stringify(candidate),
    );
  seed
    .prepare("INSERT INTO experiments VALUES (?, 'observing', ?, ?, ?)")
    .run(experimentId, JSON.stringify(experiment), timestamp, timestamp);
  seed
    .prepare(
      `INSERT INTO activation_operations(
        operation_id, idempotency_key, activation_id, experiment_id,
        candidate_revision_json, manifest_revision_json, preflight_id, plan_id,
        binding_json, binding_digest, policy_snapshot_json, policy_digest,
        decision, status, expected_activation_revision, previous_activation_id,
        approval_id, created_at, updated_at, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'eligible_auto_activate',
        'committed', 1, ?, NULL, ?, ?, ?)`,
    )
    .run(
      "activation-operation-revert-publication",
      "activation-idempotency-revert-publication",
      currentActivationId,
      experimentId,
      JSON.stringify(candidate),
      JSON.stringify(candidatePrompt),
      binding.preflightId,
      binding.planId,
      JSON.stringify(binding),
      sha256(canonicalJson(binding)),
      JSON.stringify(policySnapshot),
      sha256(canonicalJson(policySnapshot)),
      sourceActivationId,
      timestamp,
      timestamp,
      timestamp,
    );
  seed.close();

  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  const digestInput = Object.freeze({
    operationId: "outcome-operation-revert-publication",
    idempotencyKey: "outcome-idempotency-revert-publication",
    experimentId,
    decision: "revert" as const,
    strategyId: "hard-regression",
    researchRunId: null,
    expectedActivationId: currentActivationId,
    expectedActivationRevision: 2,
    evidenceRefs: Object.freeze([]),
    restore: Object.freeze({
      sourceActivationId,
      currentPermissionManifest: permissionManifest,
      restoredPermissionManifest: permissionManifest,
    }),
    successor: null,
  });
  const request: CommitExperimentOutcomeRequest = Object.freeze({
    operationId: digestInput.operationId,
    idempotencyKey: digestInput.idempotencyKey,
    experimentId,
    decision: digestInput.decision,
    strategyId: digestInput.strategyId,
    expectedActivationId: currentActivationId,
    expectedActivationRevision: 2,
    evidenceRefs: Object.freeze([]),
    restore: digestInput.restore,
    operationDigest: sha256(canonicalJson(digestInput)),
  });
  return Object.freeze({
    store,
    request,
    baselinePrompt,
    baselineRetired,
    candidatePrompt,
    candidateOnly,
  });
}

async function commitRevert(fixture: RevertFixture): Promise<void> {
  await createWorkspaceRuntimeInternals(fixture.store).protectedRuntime.feedback.commitOutcome(
    fixture.request,
  );
}

describe("experiment revert active-definition publication", () => {
  test("restores exact prior bytes and deletes candidate-only active paths after commit", async () => {
    const fixture = await createRevertFixture();
    await commitRevert(fixture);

    expect(await readFile(join(fixture.store.paths.root, fixture.baselinePrompt.workingPath), "utf8")).toBe(
      "baseline prompt",
    );
    expect(await readFile(join(fixture.store.paths.root, fixture.baselineRetired.workingPath), "utf8")).toBe(
      "baseline retained slot",
    );
    await expect(
      readFile(join(fixture.store.paths.root, fixture.candidateOnly.workingPath)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const restored = await createWorkspaceRuntimeInternals(
      fixture.store,
    ).protectedRuntime.activations.current();
    expect(Object.values(restored?.activeDefinitions ?? {})).toEqual(
      expect.arrayContaining([fixture.baselinePrompt, fixture.baselineRetired]),
    );
    expect(Object.values(restored?.activeDefinitions ?? {})).toHaveLength(2);
    const database = new DatabaseSync(fixture.store.unsafeDatabasePathForTesting, { readOnly: true });
    expect(
      database
        .prepare(
          `SELECT count(*) AS count FROM outcome_activation_publications
           WHERE operation_id = ? AND published = 1`,
        )
        .get(fixture.request.operationId),
    ).toMatchObject({ count: 3 });
    database.close();
    fixture.store.close();
  });

  test("recovers committed publication and deletion work on startup after a post-commit crash", async () => {
    const fixture = await createRevertFixture({
      afterOutcomeCommitForTesting: () => {
        throw new Error("simulated crash after protected outcome commit");
      },
    });
    await commitRevert(fixture);
    expect(await readFile(join(fixture.store.paths.root, fixture.candidatePrompt.workingPath), "utf8")).toBe(
      "candidate prompt",
    );
    const beforeRestart = new DatabaseSync(fixture.store.unsafeDatabasePathForTesting, {
      readOnly: true,
    });
    expect(
      beforeRestart
        .prepare(
          `SELECT count(*) AS count FROM outcome_activation_publications
           WHERE operation_id = ? AND published = 0`,
        )
        .get(fixture.request.operationId),
    ).toMatchObject({ count: 3 });
    beforeRestart.close();
    const root = fixture.store.paths.root;
    fixture.store.close();

    const recovered = await createWorkspaceStore(root);
    expect(await readFile(join(root, fixture.baselinePrompt.workingPath), "utf8")).toBe("baseline prompt");
    expect(await readFile(join(root, fixture.baselineRetired.workingPath), "utf8")).toBe(
      "baseline retained slot",
    );
    await expect(readFile(join(root, fixture.candidateOnly.workingPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const database = new DatabaseSync(recovered.unsafeDatabasePathForTesting, { readOnly: true });
    expect(
      database
        .prepare(
          `SELECT count(*) AS count FROM outcome_activation_publications
           WHERE operation_id = ? AND published = 1`,
        )
        .get(fixture.request.operationId),
    ).toMatchObject({ count: 3 });
    database.close();
    recovered.close();
  });
});
