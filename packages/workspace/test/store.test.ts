import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  eventChecksum,
  SCHEMA_VERSION,
  type CapabilityRevisionRef,
  type Experiment,
  type ExperimentTrial,
  type LedgerEvent,
  type PreflightPlan,
  type PreflightReport,
} from "@noesis/domain";
import { createWorkspaceStore, restoreWorkspaceBackup, type NoesisWorkspaceStore } from "../src/index.ts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const actor = { actorId: "test-user", kind: "user" as const };
const text = (value: string): Uint8Array => Buffer.from(value);
const digest = (character: string): string => character.repeat(64);

describe("WorkspaceStore", () => {
  let roots: string[] = [];

  beforeEach(() => {
    roots = [];
  });

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  const temporary = async (name: string): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), `noesis-${name}-`));
    roots.push(root);
    return root;
  };

  test("records direct edits as immutable predecessor-linked revisions", async () => {
    const store = await createWorkspaceStore(await temporary("revision"));
    const first = await store.definitions.recordWorkingDefinition({
      workingPath: "prompts/research.md",
      bytes: text("first bytes"),
      actor,
    });
    await writeFile(join(store.paths.definitions, "prompts", "research.md"), "second bytes");
    const second = await store.recordDirectEdit("definitions/prompts/research.md", actor, "external edit");

    expect(second.revisionId).not.toBe(first.revisionId);
    expect(Buffer.from(await store.reads.readRevision(first)).toString()).toBe("first bytes");
    expect(Buffer.from(await store.reads.readRevision(second)).toString()).toBe("second bytes");
    const row = await store.reads.readDatabaseRow({
      kind: "database_row",
      table: "file_revisions",
      rowId: second.revisionId,
    });
    expect(row?.["predecessor_revision_id"]).toBe(first.revisionId);
    store.close();
  });

  test("keeps candidate and active staging separate and cleans abandoned stages", async () => {
    const store = await createWorkspaceStore(await temporary("staging"));
    const abandoned = await store.stageDefinition({
      targetArea: "candidate",
      relativePath: "capabilities/abandoned.json",
      bytes: text("{}"),
      actor,
    });
    const selected = await store.stageDefinition({
      targetArea: "active",
      relativePath: "capabilities/selected.json",
      bytes: text('{"selected":true}'),
      actor,
    });
    const active = await store.registerStagedDefinition(selected.stageId);

    expect(active.workingPath).toBe("definitions/active/capabilities/selected.json");
    expect(await readFile(join(store.paths.active, "capabilities", "selected.json"), "utf8")).toBe(
      '{"selected":true}',
    );
    expect(await store.cleanupStagedDefinitions()).toBe(1);
    await expect(readFile(join(store.paths.root, abandoned.stagedPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
    store.close();
  });

  test("upgrades a version-1 workspace and keeps migrations idempotent", async () => {
    const root = await temporary("migrations");
    await mkdir(join(root, "database"), { recursive: true });
    const seed = new DatabaseSync(join(root, "database", "noesis.sqlite"));
    seed.exec(await readFile(new URL("../migrations/001_operational.sql", import.meta.url), "utf8"));
    seed
      .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, ?, ?)")
      .run("001_operational.sql", "2026-01-01T00:00:00.000Z");
    seed.close();
    const upgraded = await createWorkspaceStore(root);
    expect(await upgraded.search.rebuildDocuments()).toEqual([]);
    upgraded.close();
    const second = await createWorkspaceStore(root);
    second.close();
    const database = new DatabaseSync(join(root, "database", "noesis.sqlite"), { readOnly: true });
    const versions = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => Reflect.get(row, "version"));
    database.close();
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("rolls back repository activity when a foreign-key write fails", async () => {
    const store = await createWorkspaceStore(await temporary("transaction"));
    const before = countRows(store, "activity_log");
    await expect(
      store.operational.messages.put({
        messageId: "message-orphan",
        sessionId: "missing-session",
        role: "user",
        content: "must fail",
        sensitivity: "normal",
        createdAt: "2026-01-01T00:00:00.000Z",
        metadata: {},
      }),
    ).rejects.toThrow();
    expect(countRows(store, "messages")).toBe(0);
    expect(countRows(store, "activity_log")).toBe(before);
    store.close();
  });

  test("persists and validates complete capability revision identity for activation state", async () => {
    const store = await createWorkspaceStore(await temporary("activation-identity"));
    const capabilityRevision = revision("capability-revision-1", "a");
    await store.operational.activations.put({
      activationId: "activation-1",
      revision: 1,
      previousActivationId: null,
      activeDefinitions: {},
      activeCapabilityRevisions: { [capabilityRevision.capabilityId]: capabilityRevision },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await store.operational.activations.putPointer({
      pointerId: "activation-pointer-1",
      capabilityId: capabilityRevision.capabilityId,
      activationId: "activation-1",
      capabilityRevision,
      updatedAt: "2026-01-01T00:01:00.000Z",
    });

    expect(await store.operational.activations.get("activation-1")).toMatchObject({
      activeCapabilityRevisions: { [capabilityRevision.capabilityId]: capabilityRevision },
    });
    expect(await store.operational.activations.getPointer(capabilityRevision.capabilityId)).toMatchObject({
      capabilityRevision,
    });
    await expect(
      store.operational.activations.put({
        activationId: "activation-incomplete",
        revision: 2,
        previousActivationId: "activation-1",
        activeDefinitions: {},
        activeCapabilityRevisions: {
          [capabilityRevision.capabilityId]: {
            kind: "legacy_capability_revision",
            capabilityId: capabilityRevision.capabilityId,
            capabilityRevisionId: capabilityRevision.capabilityRevisionId,
          },
        },
        createdAt: "2026-01-01T00:02:00.000Z",
      }),
    ).rejects.toThrow();
    store.close();

    const legacyDatabase = new DatabaseSync(store.unsafeDatabasePathForTesting);
    legacyDatabase
      .prepare(
        `INSERT INTO activations(
          activation_id, revision, previous_activation_id, definitions_json,
          capability_revisions_json, preflight_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "activation-legacy",
        2,
        "activation-1",
        "{}",
        JSON.stringify({ [capabilityRevision.capabilityId]: "legacy-revision-id" }),
        null,
        "2026-01-01T00:02:00.000Z",
      );
    legacyDatabase
      .prepare(
        `UPDATE activation_pointers SET activation_id = ?, capability_revision_id = ?,
         capability_revision_json = NULL WHERE capability_id = ?`,
      )
      .run("activation-legacy", "legacy-revision-id", capabilityRevision.capabilityId);
    legacyDatabase.close();
    const reopened = await createWorkspaceStore(store.paths.root);
    expect(await reopened.operational.activations.get("activation-legacy")).toMatchObject({
      activeCapabilityRevisions: {
        [capabilityRevision.capabilityId]: {
          kind: "legacy_capability_revision",
          capabilityRevisionId: "legacy-revision-id",
        },
      },
    });
    expect(await reopened.operational.activations.getPointer(capabilityRevision.capabilityId)).toMatchObject({
      capabilityRevision: {
        kind: "legacy_capability_revision",
        capabilityRevisionId: "legacy-revision-id",
      },
    });
    reopened.close();
  });

  test("round-trips the experiment, trials, preflight, evaluation, and feedback lifecycle", async () => {
    const store = await createWorkspaceStore(await temporary("experiment"));
    const [caseEvidence, baselineEvidence, candidateEvidence, judgmentEvidence, reportEvidence] =
      await Promise.all([
        store.evidence.appendEvidence({
          workingPath: "evals/case",
          bytes: text("case"),
          actor,
          evidenceKind: "input",
        }),
        store.evidence.appendEvidence({
          workingPath: "evals/baseline",
          bytes: text("baseline"),
          actor,
          evidenceKind: "output",
        }),
        store.evidence.appendEvidence({
          workingPath: "evals/candidate",
          bytes: text("candidate"),
          actor,
          evidenceKind: "output",
        }),
        store.evidence.appendEvidence({
          workingPath: "evals/judgment",
          bytes: text("judgment"),
          actor,
          evidenceKind: "judgment",
        }),
        store.evidence.appendEvidence({
          workingPath: "evals/report",
          bytes: text("report"),
          actor,
          evidenceKind: "report",
        }),
      ]);
    const baseline = revision("baseline", "a");
    const candidate = revision("candidate", "b");
    const experiment: Experiment = {
      experimentId: "experiment-1",
      hypothesis: "the candidate is better",
      scope: "research",
      evidenceRefs: [caseEvidence],
      baselineRevision: baseline,
      candidateRevisions: [candidate],
      feedbackSignalIds: [],
      status: "hypothesis",
    };
    await store.research.experiments.putExperiment(experiment);
    await store.research.experiments.putExperiment({ ...experiment, status: "authoring" });
    await store.research.experiments.putExperiment({ ...experiment, status: "preflight" });

    const plan: PreflightPlan = {
      planId: "plan-1",
      experimentId: experiment.experimentId,
      candidateRevision: candidate,
      baselineRevision: baseline,
      caseRefs: [caseEvidence],
      judgeVariant: { variantId: "judge", axis: "evaluation", configurationRefs: [] },
      runtimeVariant: { variantId: "runtime", axis: "role", configurationRefs: [] },
      budget: { maxCases: 1, maxAttemptsPerArm: 1, maxCost: 0 },
    };
    await store.research.preflights.putPreflightPlan(plan);
    const baselineTrial = trial("trial-baseline", "baseline", baseline, caseEvidence, baselineEvidence);
    const candidateTrial = trial("trial-candidate", "candidate", candidate, caseEvidence, candidateEvidence);
    const baselineRow = await store.research.trials.putTrial(baselineTrial);
    const candidateRow = await store.research.trials.putTrial(candidateTrial);
    await store.research.trials.putTrial({ ...baselineTrial, status: "running" });
    await store.research.trials.putTrial({ ...baselineTrial, status: "completed" });
    await store.research.trials.putTrial({ ...candidateTrial, status: "running" });
    await store.research.trials.putTrial({ ...candidateTrial, status: "completed" });
    const report: PreflightReport = {
      preflightId: "preflight-1",
      experimentId: experiment.experimentId,
      planId: plan.planId,
      candidateRevision: candidate,
      baselineRevision: baseline,
      trialRowRefs: [baselineRow, candidateRow],
      trialEvidence: [baselineEvidence, candidateEvidence],
      judgmentEvidence: [judgmentEvidence],
      appliedCriteria: [],
      railChecks: [{ rail: "authority", passed: true, evidenceRefs: [] }],
      comparison: { winner: "candidate", confidence: 0.9, summary: "candidate won" },
      decision: "pass",
      reportEvidence,
    };
    const preflightRow = await store.research.preflights.putPreflightReport(report);
    await store.research.evaluations.putEvaluation({
      evaluationId: "evaluation-1",
      experimentId: experiment.experimentId,
      preflightId: report.preflightId,
      candidateRevision: candidate,
      trialIds: [baselineTrial.trialId, candidateTrial.trialId],
      evidenceRefs: [reportEvidence],
      status: "running",
    });
    await store.research.evaluations.putEvaluation({
      evaluationId: "evaluation-1",
      experimentId: experiment.experimentId,
      preflightId: report.preflightId,
      candidateRevision: candidate,
      trialIds: [baselineTrial.trialId, candidateTrial.trialId],
      evidenceRefs: [reportEvidence],
      status: "completed",
    });
    await store.research.feedbackSignals.recordFeedbackSignal({
      signalId: "feedback-1",
      kind: "surprising_success",
      scope: "research",
      evidenceRefs: [candidateEvidence],
      strength: 0.8,
      novelty: 0.6,
      sensitivity: "normal",
      experimentId: experiment.experimentId,
      capabilityRevisionId: candidate.capabilityRevisionId,
    });
    const completed: Experiment = {
      ...experiment,
      status: "completed",
      outcome: "keep",
      preflightRef: preflightRow,
      activatedRevision: candidate,
      feedbackSignalIds: ["feedback-1"],
    };
    await store.research.experiments.putExperiment({ ...experiment, status: "observing" });
    await store.research.experiments.putExperiment(completed);

    expect(await store.research.experiments.getExperiment(experiment.experimentId)).toEqual(completed);
    expect(await store.research.experiments.listExperiments({ status: "completed", limit: 10 })).toEqual([
      completed,
    ]);
    expect(await store.research.preflights.getPreflightReport(report.preflightId)).toEqual(report);
    expect(await store.research.evaluations.listEvaluations(experiment.experimentId)).toHaveLength(1);
    expect(await store.research.feedbackSignals.getFeedbackSignal("feedback-1")).toMatchObject({
      experimentId: experiment.experimentId,
    });
    store.close();
  });

  test("backs up and restores authoritative files and reports missing and orphan refs", async () => {
    const sourceRoot = await temporary("backup-source");
    const backupRoot = await temporary("backup-copy");
    const restoreRoot = await temporary("backup-restore");
    const store = await createWorkspaceStore(sourceRoot);
    await store.operational.sessions.put(session("session-backup"));
    const revisionRef = await store.definitions.recordWorkingDefinition({
      workingPath: "skills/research.md",
      bytes: text("skill bytes"),
      actor,
    });
    await store.evidence.appendEvidence({
      workingPath: "evaluation/input",
      bytes: text("evidence bytes"),
      actor,
      evidenceKind: "input",
    });
    const artifact = await store.artifacts.writeArtifact({
      path: "reports/result.txt",
      mediaType: "text/plain",
      bytes: text("artifact bytes"),
      actor,
      relationshipRefs: [revisionRef],
    });
    await mkdir(join(store.paths.revisions, "orphan"), { recursive: true });
    await writeFile(join(store.paths.revisions, "orphan", "content"), "orphan");
    expect((await store.inspectIntegrity()).orphanFiles).toContain("revisions/orphan/content");
    const backup = await store.backup(backupRoot);
    expect(backup.missingFiles).toEqual([]);
    store.close();

    const restored = await restoreWorkspaceBackup(backupRoot, restoreRoot);
    expect(restored.missingFiles).toEqual([]);
    const restoredStore = await createWorkspaceStore(restoreRoot);
    expect(await restoredStore.operational.sessions.get("session-backup")).toMatchObject({
      title: "Session session-backup",
    });
    expect(Buffer.from(await restoredStore.reads.readRevision(revisionRef)).toString()).toBe("skill bytes");
    expect(Buffer.from(await restoredStore.reads.readArtifact(artifact)).toString()).toBe("artifact bytes");
    await unlink(join(restoredStore.paths.root, artifact.path));
    expect((await restoredStore.inspectIntegrity()).missingFiles).toContain(artifact.path);
    const missingBackup = await restoredStore.backup(await temporary("backup-missing"));
    expect(missingBackup.missingFiles).toContain(artifact.path);
    restoredStore.close();
  });

  test("imports a legacy home once without continuing dual writes", async () => {
    const legacyRoot = await temporary("legacy");
    const workspaceRoot = await temporary("imported");
    await mkdir(join(legacyRoot, "ledger"), { recursive: true });
    await mkdir(join(legacyRoot, "views"), { recursive: true });
    await writeFile(join(legacyRoot, "config.json"), '{"schemaVersion":1,"agent":{}}\n');
    await writeFile(join(legacyRoot, "views", "memory.md"), "# Legacy memory\n\nPreserve this.\n");
    const events = legacyEvents();
    await writeFile(
      join(legacyRoot, "ledger", "events.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    const store = await createWorkspaceStore(workspaceRoot);
    const first = await store.importLegacyWorkspace(legacyRoot, actor);
    const second = await store.importLegacyWorkspace(legacyRoot, actor);

    expect(first).toMatchObject({ sessions: 1, messages: 2, outcomes: 1, definitions: 2 });
    expect(second.alreadyImported).toBe(true);
    expect(await store.operational.messages.listForSession("trail-legacy")).toHaveLength(2);
    expect(await readFile(join(store.paths.definitions, "profile-memory", "memory.md"), "utf8")).toContain(
      "Preserve this",
    );
    await writeFile(join(legacyRoot, "views", "memory.md"), "changed after import\n");
    expect(await readFile(join(store.paths.definitions, "profile-memory", "memory.md"), "utf8")).toContain(
      "Preserve this",
    );
    store.close();
  });
});

function session(sessionId: string) {
  return {
    sessionId,
    title: `Session ${sessionId}`,
    status: "idle" as const,
    provider: "fake",
    model: "fake",
    runtime: "fake",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    metadata: {},
  };
}

function revision(id: string, digestCharacter: string): CapabilityRevisionRef {
  return {
    kind: "capability_revision",
    capabilityId: "capability-research",
    capabilityRevisionId: id,
    bundleDigest: digest(digestCharacter),
  };
}

function trial(
  trialId: string,
  arm: ExperimentTrial["arm"],
  capabilityRevision: CapabilityRevisionRef,
  input: ExperimentTrial["inputRefs"][number],
  output: ExperimentTrial["outputEvidenceRefs"][number],
): ExperimentTrial {
  return {
    trialId,
    experimentId: "experiment-1",
    comparisonGroupId: "group-1",
    arm,
    capabilityRevision,
    inputRefs: [input],
    outputEvidenceRefs: [output],
    traceEvidenceRefs: [],
    variant: { variantId: arm, axis: "role", configurationRefs: [] },
    status: "planned",
  };
}

function countRows(store: NoesisWorkspaceStore, table: string): number {
  const database = new DatabaseSync(store.unsafeDatabasePathForTesting, { readOnly: true });
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  database.close();
  const value = row && typeof row === "object" ? Reflect.get(row, "count") : undefined;
  if (typeof value !== "number") throw new Error(`Could not count ${table}`);
  return value;
}

function legacyEvents(): readonly LedgerEvent[] {
  const unsignedStart: Omit<LedgerEvent, "checksum"> = {
    schemaVersion: SCHEMA_VERSION,
    eventId: "event-start",
    sequence: 1,
    occurredAt: "2026-01-01T00:00:00.000Z",
    principal: "foreground",
    type: "trail.started",
    trailId: "trail-legacy",
    payload: { title: "Legacy", provider: "fake", model: "fake", runtime: "fake" },
    previousChecksum: null,
  };
  const start: LedgerEvent = { ...unsignedStart, checksum: eventChecksum(unsignedStart) };
  const unsignedTurn: Omit<LedgerEvent, "checksum"> = {
    schemaVersion: SCHEMA_VERSION,
    eventId: "event-turn",
    sequence: 2,
    occurredAt: "2026-01-01T00:01:00.000Z",
    principal: "foreground",
    type: "turn.completed",
    trailId: "trail-legacy",
    payload: { input: "legacy question", output: "legacy answer" },
    previousChecksum: start.checksum,
  };
  return [start, { ...unsignedTurn, checksum: eventChecksum(unsignedTurn) }];
}
