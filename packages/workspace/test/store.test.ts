import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { frozenTurnPlanDigest, type FrozenTurnPlan } from "@noesis/agent-types";
import {
  eventChecksum,
  effectOperationFingerprint,
  SCHEMA_VERSION,
  sha256,
  type CapabilityRevisionRef,
  type Experiment,
  type ExperimentTrial,
  type LedgerEvent,
  type PreflightPlan,
  type PreflightReport,
} from "@noesis/domain";
import type { AuthorityReceipt } from "@noesis/policy";
import { createWorkspaceStore, restoreWorkspaceBackup, type NoesisWorkspaceStore } from "../src/index.ts";
import { createWorkspaceRuntimeInternals } from "../src/protected-runtime.ts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const actor = { actorId: "test-user", kind: "user" as const };
const text = (value: string): Uint8Array => Buffer.from(value);
const digest = (character: string): string => character.repeat(64);
const authority = (store: NoesisWorkspaceStore) => createWorkspaceRuntimeInternals(store).authority;

const runningTurnPlan = (sessionId: string, turnId: string): FrozenTurnPlan => {
  const body: Omit<FrozenTurnPlan, "canonicalDigest"> = {
    schemaVersion: 1,
    planId: `plan-${turnId}`,
    sessionId,
    turnId,
    activationId: "activation_genesis",
    activationRevision: 1,
    selectedCapabilities: [],
    renderedSystemPrompt: "Noesis recovery fixture",
    provider: "controlled",
    model: "controlled",
    thinkingLevel: "off",
    permissionSnapshot: { effects: [], resourcePatterns: [], credentialRefs: [] },
    retrievalCitations: [],
    routing: { strategyId: "baseline", reason: "Recovery fixture" },
    createdAt: "2026-07-26T00:00:00.000Z",
  };
  return Object.freeze({ ...body, canonicalDigest: frozenTurnPlanDigest(body) });
};

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

  test("rehydrates unfinished codemode executions as interrupted", async () => {
    const root = await temporary("codemode-recovery");
    const first = await createWorkspaceStore(root, {
      now: () => "2026-07-26T00:00:00.000Z",
    });
    await first.operational.sessions.put({
      sessionId: "session-codemode",
      title: "Codemode",
      status: "running",
      provider: "controlled",
      model: "controlled",
      runtime: "pi",
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    const unfinishedSource = await first.artifacts.writeArtifact({
      path: "codemode/execution-unfinished/source.mjs",
      mediaType: "text/javascript",
      bytes: text('return "exact";'),
      actor,
      relationshipRefs: Object.freeze([
        { kind: "database_row" as const, table: "sessions" as const, rowId: "session-codemode" },
      ]),
    });
    await first.operational.codeExecutions.put({
      executionId: "execution-unfinished",
      logicalExecutionId: "logical-execution-unfinished",
      sessionId: "session-codemode",
      catalogId: "catalog-test",
      catalogDigest: digest("a"),
      sourceDigest: sha256(text('return "exact";')),
      sourceArtifactId: unfinishedSource.artifactId,
      status: "running",
      callCount: 1,
      startedAt: "2026-07-26T00:00:00.000Z",
    });
    first.close();

    const recovered = await createWorkspaceStore(root, {
      now: () => "2026-07-26T00:01:00.000Z",
      recoverInterruptedOperations: true,
    });

    expect(await recovered.operational.codeExecutions.get("execution-unfinished")).toMatchObject({
      status: "interrupted",
      error: "Process exited before execution settled",
      completedAt: "2026-07-26T00:01:00.000Z",
    });
    recovered.close();
  });

  test("recovers orphaned foreground turns and their actions under the successor runtime owner", async () => {
    const root = await temporary("foreground-turn-recovery");
    const first = await createWorkspaceStore(root, {
      now: () => "2026-07-26T00:00:00.000Z",
    });
    await first.operational.sessions.put({
      sessionId: "session-interrupted-turn",
      title: "Interrupted foreground turn",
      status: "running",
      provider: "controlled",
      model: "controlled",
      runtime: "pi",
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    const protectedRuntime = createWorkspaceRuntimeInternals(first).protectedRuntime;
    await protectedRuntime.activations.bootstrapGenesis({
      capabilityRevision: {
        kind: "capability_revision",
        capabilityId: "general-collaboration",
        capabilityRevisionId: "general-collaboration-genesis-v1",
        bundleDigest: digest("a"),
      },
      activeDefinitions: Object.freeze({}),
    });
    await protectedRuntime.activations.admitTurnPlan(
      runningTurnPlan("session-interrupted-turn", "turn-interrupted"),
    );
    await first.operational.toolCalls.put({
      toolCallId: "action-interrupted",
      sessionId: "session-interrupted-turn",
      turnId: "turn-interrupted",
      toolName: "shell.run",
      request: Object.freeze({ command: "long-running-command" }),
      status: "running",
      sensitivity: "normal",
      createdAt: "2026-07-26T00:00:01.000Z",
    });
    first.close();

    const recovered = await createWorkspaceStore(root, {
      now: () => "2026-07-26T00:01:00.000Z",
      recoverInterruptedOperations: true,
      runtimeOwnerId: "successor-owner",
    });

    expect(await recovered.operational.sessions.get("session-interrupted-turn")).toMatchObject({
      status: "aborted",
      updatedAt: "2026-07-26T00:01:00.000Z",
    });
    expect(await recovered.operational.foregroundTurns.get("turn-interrupted")).toMatchObject({
      status: "aborted",
      settledAt: "2026-07-26T00:01:00.000Z",
    });
    expect(await recovered.operational.toolCalls.get("action-interrupted")).toMatchObject({
      turnId: "turn-interrupted",
      status: "failed",
      response: {
        error: "Runtime exited before turn settled",
        reason: "interrupted",
      },
      completedAt: "2026-07-26T00:01:00.000Z",
    });
    expect(await recovered.operational.outcomes.listForSession("session-interrupted-turn")).toEqual([]);
    recovered.close();
  });

  test("recovers running sessions on both sides of foreground admission without changing settled sessions", async () => {
    const root = await temporary("runtime-session-recovery-windows");
    const first = await createWorkspaceStore(root, {
      now: () => "2026-07-26T00:00:00.000Z",
    });
    const session = (sessionId: string, status: "idle" | "running" | "completed" | "aborted" | "failed") =>
      Object.freeze({
        sessionId,
        title: sessionId,
        status,
        provider: "controlled",
        model: "controlled",
        runtime: "pi",
        createdAt: "2026-07-26T00:00:00.000Z",
        updatedAt: "2026-07-26T00:00:00.000Z",
        metadata: Object.freeze({}),
      });
    await first.operational.sessions.put(session("session-before-admission", "running"));
    await first.operational.sessions.put(session("session-after-settlement", "running"));
    await first.operational.sessions.put(session("session-idle", "idle"));
    await first.operational.sessions.put(session("session-completed", "completed"));
    await first.operational.sessions.put(session("session-aborted", "aborted"));
    await first.operational.sessions.put(session("session-failed", "failed"));

    const protectedRuntime = createWorkspaceRuntimeInternals(first).protectedRuntime;
    await protectedRuntime.activations.bootstrapGenesis({
      capabilityRevision: {
        kind: "capability_revision",
        capabilityId: "general-collaboration",
        capabilityRevisionId: "general-collaboration-genesis-v1",
        bundleDigest: digest("a"),
      },
      activeDefinitions: Object.freeze({}),
    });
    await protectedRuntime.activations.admitTurnPlan(
      runningTurnPlan("session-after-settlement", "turn-already-settled"),
    );
    await first.operational.outcomes.put({
      outcomeId: "turn-already-settled:outcome",
      sessionId: "session-after-settlement",
      turnId: "turn-already-settled",
      status: "accepted",
      summary: "Already settled before the process exited",
      sensitivity: "normal",
      createdAt: "2026-07-26T00:00:01.000Z",
      metadata: Object.freeze({ replayEligible: true }),
    });
    await first.operational.foregroundTurns.settle({
      turnId: "turn-already-settled",
      outcomeId: "turn-already-settled:outcome",
      status: "completed",
      settledAt: "2026-07-26T00:00:01.000Z",
    });
    // Recreate the process-exit window after the foreground transaction settled but before
    // the owning runtime persisted its final idle trail state.
    await first.operational.sessions.put(session("session-after-settlement", "running"));
    first.close();

    const recovered = await createWorkspaceStore(root, {
      now: () => "2026-07-26T00:01:00.000Z",
      recoverInterruptedOperations: true,
      runtimeOwnerId: "successor-owner",
    });

    for (const sessionId of ["session-before-admission", "session-after-settlement"])
      expect(await recovered.operational.sessions.get(sessionId)).toMatchObject({
        status: "aborted",
        updatedAt: "2026-07-26T00:01:00.000Z",
      });
    expect(await recovered.operational.foregroundTurns.get("turn-already-settled")).toMatchObject({
      status: "completed",
      settledAt: "2026-07-26T00:00:01.000Z",
    });
    expect(await recovered.operational.outcomes.listForSession("session-before-admission")).toEqual([]);
    for (const status of ["idle", "completed", "aborted", "failed"] as const)
      expect(await recovered.operational.sessions.get(`session-${status}`)).toMatchObject({
        status,
        updatedAt: "2026-07-26T00:00:00.000Z",
      });

    const inspection = new DatabaseSync(recovered.unsafeDatabasePathForTesting, { readOnly: true });
    const recoveryActivities = inspection
      .prepare(
        `SELECT activity_kind, subject_id, references_json
         FROM activity_log
         WHERE activity_kind = 'session.interrupted'
         ORDER BY subject_id`,
      )
      .all();
    inspection.close();
    expect(recoveryActivities).toMatchObject([
      {
        activity_kind: "session.interrupted",
        subject_id: "session-after-settlement",
        references_json: '[{"reason":"runtime_owner_recovery","interruptedTurnIds":[]}]',
      },
      {
        activity_kind: "session.interrupted",
        subject_id: "session-before-admission",
        references_json: '[{"reason":"runtime_owner_recovery","interruptedTurnIds":[]}]',
      },
    ]);
    recovered.close();
  });

  test("keeps one live mutating runtime owner while allowing non-recovering readers", async () => {
    const root = await temporary("runtime-owner");
    const owner = await createWorkspaceStore(root, {
      recoverInterruptedOperations: true,
      runtimeOwnerId: "owner-one",
    });
    await owner.operational.sessions.put({
      sessionId: "session-live-owner",
      title: "Live owner",
      status: "running",
      provider: "controlled",
      model: "controlled",
      runtime: "pi",
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    const source = await owner.artifacts.writeArtifact({
      path: "codemode/execution-live-owner/source.mjs",
      mediaType: "text/javascript",
      bytes: text('return "live";'),
      actor,
      relationshipRefs: Object.freeze([
        { kind: "database_row" as const, table: "sessions" as const, rowId: "session-live-owner" },
      ]),
    });
    await owner.operational.codeExecutions.put({
      executionId: "execution-live-owner",
      logicalExecutionId: "logical-live-owner",
      sessionId: "session-live-owner",
      catalogId: "catalog-test",
      catalogDigest: digest("a"),
      sourceDigest: sha256(text('return "live";')),
      sourceArtifactId: source.artifactId,
      status: "running",
      callCount: 0,
      startedAt: "2026-07-26T00:00:00.000Z",
    });
    const reader = await createWorkspaceStore(root);
    expect(await reader.operational.codeExecutions.get("execution-live-owner")).toMatchObject({
      status: "running",
    });

    await expect(
      createWorkspaceStore(root, {
        recoverInterruptedOperations: true,
        runtimeOwnerId: "owner-two",
      }),
    ).rejects.toThrow("live runtime owner");

    reader.close();
    owner.close();
    const successor = await createWorkspaceStore(root, {
      recoverInterruptedOperations: true,
      runtimeOwnerId: "owner-two",
    });
    successor.close();
  });

  test("releases its runtime owner when initialization fails after acquisition", async () => {
    const root = await temporary("runtime-owner-initialization-failure");
    await expect(
      createWorkspaceStore(root, {
        recoverInterruptedOperations: true,
        runtimeOwnerId: "failed-owner",
        afterRuntimeOwnerAcquiredForTesting: () => {
          throw new Error("injected initialization failure");
        },
      }),
    ).rejects.toThrow("injected initialization failure");

    const database = new DatabaseSync(join(root, "database", "noesis.sqlite"), { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM runtime_owner").get()).toMatchObject({
      count: 0,
    });
    database.close();

    const successor = await createWorkspaceStore(root, {
      recoverInterruptedOperations: true,
      runtimeOwnerId: "successor-owner",
    });
    successor.close();
  });

  test("takes over a stale runtime owner after an ESRCH liveness result", async () => {
    const root = await temporary("runtime-owner-stale");
    const initialized = await createWorkspaceStore(root);
    initialized.close();
    const database = new DatabaseSync(join(root, "database", "noesis.sqlite"));
    database
      .prepare("INSERT INTO runtime_owner(singleton, owner_id, pid, acquired_at) VALUES (1, ?, ?, ?)")
      .run("stale-owner", 999_999, "2026-07-26T00:00:00.000Z");
    database.close();
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 999_999 && signal === 0)
        throw Object.assign(new Error("No such process"), { code: "ESRCH" });
      return true;
    });
    let successor: NoesisWorkspaceStore | undefined;
    try {
      successor = await createWorkspaceStore(root, {
        recoverInterruptedOperations: true,
        runtimeOwnerId: "successor-owner",
      });
      const current = new DatabaseSync(successor.unsafeDatabasePathForTesting, { readOnly: true });
      expect(current.prepare("SELECT owner_id, pid FROM runtime_owner WHERE singleton = 1").get()).toEqual({
        owner_id: "successor-owner",
        pid: process.pid,
      });
      current.close();
    } finally {
      successor?.close();
      kill.mockRestore();
    }
  });

  test("pins exact codemode source and log artifacts across terminal updates", async () => {
    const store = await createWorkspaceStore(await temporary("codemode-artifacts"));
    await store.operational.sessions.put({
      sessionId: "session-artifacts",
      title: "Codemode artifacts",
      status: "running",
      provider: "controlled",
      model: "controlled",
      runtime: "pi",
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    const relationshipRefs = Object.freeze([
      {
        kind: "database_row" as const,
        table: "sessions" as const,
        rowId: "session-artifacts",
      },
    ]);
    await expect(
      store.operational.codeExecutions.put({
        executionId: "execution-missing-source",
        logicalExecutionId: "execution-missing-source",
        sessionId: "session-artifacts",
        catalogId: "catalog-test",
        catalogDigest: digest("a"),
        sourceDigest: sha256(text('return "missing";')),
        status: "running",
        callCount: 0,
        startedAt: "2026-07-26T00:00:00.000Z",
      }),
    ).rejects.toThrow("requires a source artifact");
    const source = await store.artifacts.writeArtifact({
      path: "codemode/execution-artifacts/source.mjs",
      mediaType: "text/javascript",
      bytes: text('return "exact";'),
      actor,
      relationshipRefs,
    });
    const stdout = await store.artifacts.writeArtifact({
      path: "codemode/execution-artifacts/stdout.log",
      mediaType: "text/plain",
      bytes: text("one\n"),
      actor,
      relationshipRefs,
    });
    const stderr = await store.artifacts.writeArtifact({
      path: "codemode/execution-artifacts/stderr.log",
      mediaType: "text/plain",
      bytes: text(""),
      actor,
      relationshipRefs,
    });
    await store.operational.codeExecutions.put({
      executionId: "execution-artifacts",
      logicalExecutionId: "execution-artifacts",
      sessionId: "session-artifacts",
      catalogId: "catalog-test",
      catalogDigest: digest("a"),
      sourceDigest: sha256(text('return "exact";')),
      sourceArtifactId: source.artifactId,
      status: "running",
      callCount: 0,
      startedAt: "2026-07-26T00:00:00.000Z",
    });
    await store.operational.codeExecutions.put({
      executionId: "execution-artifacts",
      logicalExecutionId: "execution-artifacts",
      sessionId: "session-artifacts",
      catalogId: "catalog-test",
      catalogDigest: digest("a"),
      sourceDigest: sha256(text('return "exact";')),
      sourceArtifactId: source.artifactId,
      stdoutArtifactId: stdout.artifactId,
      stderrArtifactId: stderr.artifactId,
      status: "completed",
      result: "exact",
      callCount: 0,
      startedAt: "2026-07-26T00:00:00.000Z",
      completedAt: "2026-07-26T00:00:01.000Z",
    });
    const alternateStdout = await store.artifacts.writeArtifact({
      path: "codemode/execution-artifacts/alternate-stdout.log",
      mediaType: "text/plain",
      bytes: text("two\n"),
      actor,
      relationshipRefs,
    });

    expect(await store.operational.codeExecutions.get("execution-artifacts")).toMatchObject({
      sourceArtifactId: source.artifactId,
      stdoutArtifactId: stdout.artifactId,
      stderrArtifactId: stderr.artifactId,
    });
    await expect(
      store.operational.codeExecutions.put({
        executionId: "execution-artifacts",
        logicalExecutionId: "execution-artifacts",
        sessionId: "session-artifacts",
        catalogId: "catalog-test",
        catalogDigest: digest("a"),
        sourceDigest: sha256(text('return "exact";')),
        sourceArtifactId: source.artifactId,
        stdoutArtifactId: alternateStdout.artifactId,
        stderrArtifactId: stderr.artifactId,
        status: "completed",
        result: "exact",
        callCount: 0,
        startedAt: "2026-07-26T00:00:00.000Z",
        completedAt: "2026-07-26T00:00:01.000Z",
      }),
    ).rejects.toThrow("immutable");
    const lineageDatabase = new DatabaseSync(store.unsafeDatabasePathForTesting);
    expect(() =>
      lineageDatabase
        .prepare("UPDATE codemode_executions SET source_digest = ? WHERE execution_id = ?")
        .run(digest("f"), "execution-artifacts"),
    ).toThrow("lineage is immutable");
    lineageDatabase.close();
    store.close();
  });

  test("rehydrates unfinished workflows as paused with their phase identity intact", async () => {
    const root = await temporary("workflow-recovery");
    const first = await createWorkspaceStore(root, {
      now: () => "2026-07-26T00:00:00.000Z",
    });
    await first.operational.sessions.put({
      sessionId: "session-workflow",
      title: "Workflow",
      status: "running",
      provider: "controlled",
      model: "controlled",
      runtime: "pi",
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    const definitionRevision = await first.definitions.recordWorkingDefinition({
      workingPath: "workflows/recover/workflow.json",
      bytes: text('{"name":"recover"}'),
      actor,
    });
    const workflowSource = await first.artifacts.writeArtifact({
      path: "codemode/execution-workflow-unfinished/source.mjs",
      mediaType: "text/javascript",
      bytes: text("return input;"),
      actor,
      relationshipRefs: Object.freeze([
        { kind: "database_row" as const, table: "sessions" as const, rowId: "session-workflow" },
      ]),
    });
    await first.operational.workflows.putRun({
      runId: "workflow-run-unfinished",
      workflowName: "recover",
      workflowRevision: 1,
      definitionRevisionId: definitionRevision.revisionId,
      sessionId: "session-workflow",
      status: "running",
      currentPhase: 0,
      input: { value: 1 },
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
    });
    await first.operational.codeExecutions.put({
      executionId: "execution-workflow-unfinished",
      logicalExecutionId: "logical-workflow-phase",
      sessionId: "session-workflow",
      catalogId: "catalog-test",
      catalogDigest: digest("c"),
      sourceDigest: sha256(text("return input;")),
      sourceArtifactId: workflowSource.artifactId,
      status: "running",
      callCount: 1,
      startedAt: "2026-07-26T00:00:00.000Z",
    });
    await first.operational.workflows.putPhase({
      runId: "workflow-run-unfinished",
      phaseIndex: 0,
      phaseName: "recover",
      status: "running",
      attempt: 1,
      logicalExecutionId: "logical-workflow-phase",
      input: { value: 1 },
      executionId: "execution-workflow-unfinished",
      startedAt: "2026-07-26T00:00:00.000Z",
    });
    await expect(
      first.operational.workflows.putPhase({
        runId: "workflow-run-unfinished",
        phaseIndex: 1,
        phaseName: "pending-cannot-start",
        status: "pending",
        attempt: 0,
        input: { value: 1 },
        startedAt: "2026-07-26T00:00:00.000Z",
      }),
    ).rejects.toThrow("cannot start");
    await expect(
      first.operational.workflows.putPhase({
        runId: "workflow-run-unfinished",
        phaseIndex: 1,
        phaseName: "completed-must-start",
        status: "completed",
        attempt: 1,
        input: { value: 1 },
        output: { value: 1 },
        completedAt: "2026-07-26T00:00:01.000Z",
      }),
    ).rejects.toThrow("requires a start time");
    await first.operational.sessions.put({
      sessionId: "session-other",
      title: "Other session",
      status: "running",
      provider: "controlled",
      model: "controlled",
      runtime: "pi",
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    const otherSource = await first.artifacts.writeArtifact({
      path: "codemode/execution-other-session/source.mjs",
      mediaType: "text/javascript",
      bytes: text("return input;"),
      actor,
      relationshipRefs: Object.freeze([
        { kind: "database_row" as const, table: "sessions" as const, rowId: "session-other" },
      ]),
    });
    await first.operational.codeExecutions.put({
      executionId: "execution-other-session",
      logicalExecutionId: "logical-other-session",
      sessionId: "session-other",
      catalogId: "catalog-test",
      catalogDigest: digest("c"),
      sourceDigest: sha256(text("return input;")),
      sourceArtifactId: otherSource.artifactId,
      status: "running",
      callCount: 0,
      startedAt: "2026-07-26T00:00:00.000Z",
    });
    await expect(
      first.operational.workflows.putPhase({
        runId: "workflow-run-unfinished",
        phaseIndex: 1,
        phaseName: "cross-session",
        status: "running",
        attempt: 1,
        logicalExecutionId: "logical-other-session",
        input: { value: 1 },
        executionId: "execution-other-session",
        startedAt: "2026-07-26T00:00:00.000Z",
      }),
    ).rejects.toThrow("does not belong to its run session");
    const lineageDatabase = new DatabaseSync(first.unsafeDatabasePathForTesting);
    expect(() =>
      lineageDatabase
        .prepare("UPDATE workflow_runs SET session_id = ? WHERE run_id = ?")
        .run("session-other", "workflow-run-unfinished"),
    ).toThrow("lineage is immutable");
    expect(() =>
      lineageDatabase
        .prepare("UPDATE workflow_runs SET turn_id = ? WHERE run_id = ?")
        .run("missing-turn", "workflow-run-unfinished"),
    ).toThrow("lineage is immutable");
    expect(() =>
      lineageDatabase
        .prepare("UPDATE workflow_phase_runs SET run_id = ? WHERE run_id = ? AND phase_index = 0")
        .run("other-run", "workflow-run-unfinished"),
    ).toThrow("lineage is immutable");
    expect(() =>
      lineageDatabase
        .prepare("UPDATE workflow_phase_runs SET execution_id = ? WHERE run_id = ? AND phase_index = 0")
        .run("execution-other-session", "workflow-run-unfinished"),
    ).toThrow();
    lineageDatabase.close();
    first.close();

    const recovered = await createWorkspaceStore(root, {
      now: () => "2026-07-26T00:01:00.000Z",
      recoverInterruptedOperations: true,
    });

    expect(await recovered.operational.workflows.getRun("workflow-run-unfinished")).toMatchObject({
      status: "paused",
      error: "Process exited before workflow settled",
      updatedAt: "2026-07-26T00:01:00.000Z",
    });
    expect(await recovered.operational.workflows.listPhases("workflow-run-unfinished")).toMatchObject([
      {
        status: "failed",
        attempt: 1,
        logicalExecutionId: "logical-workflow-phase",
        input: { value: 1 },
        executionId: "execution-workflow-unfinished",
        error: "Process exited before workflow phase settled",
        completedAt: "2026-07-26T00:01:00.000Z",
      },
    ]);
    await expect(
      recovered.operational.workflows.claimPausedRun(
        "workflow-run-unfinished",
        "session-other",
        "2026-07-26T00:02:00.000Z",
      ),
    ).resolves.toBeUndefined();
    await expect(
      recovered.operational.workflows.claimPausedRun(
        "workflow-run-unfinished",
        "session-workflow",
        "2026-07-26T00:02:00.000Z",
      ),
    ).resolves.toMatchObject({ status: "running" });
    await expect(
      recovered.operational.workflows.claimPausedRun(
        "workflow-run-unfinished",
        "session-workflow",
        "2026-07-26T00:02:00.000Z",
      ),
    ).resolves.toBeUndefined();

    await recovered.operational.workflows.putPhase({
      runId: "workflow-run-unfinished",
      phaseIndex: 0,
      phaseName: "recover",
      status: "running",
      attempt: 2,
      logicalExecutionId: "logical-workflow-phase",
      input: { value: 2 },
      startedAt: "2026-07-26T00:02:00.000Z",
    });
    await recovered.operational.codeExecutions.put({
      executionId: "execution-workflow-retry",
      logicalExecutionId: "logical-workflow-phase",
      sessionId: "session-workflow",
      catalogId: "catalog-test",
      catalogDigest: digest("c"),
      sourceDigest: sha256(text("return input;")),
      sourceArtifactId: workflowSource.artifactId,
      status: "running",
      callCount: 0,
      startedAt: "2026-07-26T00:02:00.000Z",
    });
    await recovered.operational.workflows.putPhase({
      runId: "workflow-run-unfinished",
      phaseIndex: 0,
      phaseName: "recover",
      status: "running",
      attempt: 2,
      logicalExecutionId: "logical-workflow-phase",
      input: { value: 2 },
      executionId: "execution-workflow-retry",
      startedAt: "2026-07-26T00:02:00.000Z",
    });
    await expect(
      recovered.operational.workflows.listPhases("workflow-run-unfinished"),
    ).resolves.toMatchObject([
      {
        status: "running",
        attempt: 2,
        logicalExecutionId: "logical-workflow-phase",
        executionId: "execution-workflow-retry",
      },
    ]);
    const retryDatabase = new DatabaseSync(recovered.unsafeDatabasePathForTesting);
    expect(() =>
      retryDatabase
        .prepare(
          `UPDATE workflow_phase_runs
           SET logical_execution_id = ?
           WHERE run_id = ? AND phase_index = 0`,
        )
        .run("logical-arbitrary-mutation", "workflow-run-unfinished"),
    ).toThrow("lineage is immutable");
    retryDatabase.close();
    recovered.close();
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
    expect(versions).toEqual(Array.from({ length: versions.length }, (_, index) => index + 1));
    expect(versions.at(-1)).toBeGreaterThanOrEqual(9);
  });

  test("upgrades an old version-20 workspace through corrected execution lineage contracts", async () => {
    const root = await temporary("development-migrations");
    await mkdir(join(root, "database"), { recursive: true });
    const seed = new DatabaseSync(join(root, "database", "noesis.sqlite"));
    const migrationNames = (await readdir(new URL("../migrations/", import.meta.url)))
      .filter((name) => /^\d{3}_.+\.sql$/u.test(name))
      .sort()
      .filter((name) => Number(name.slice(0, 3)) <= 20);
    for (const name of migrationNames) {
      const version = Number(name.slice(0, 3));
      seed.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      seed
        .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
        .run(version, name, "2026-07-26T00:00:00.000Z");
    }
    seed.close();

    const upgraded = await createWorkspaceStore(root);
    upgraded.close();

    const database = new DatabaseSync(join(root, "database", "noesis.sqlite"));
    const versions = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => Reflect.get(row, "version"));
    const ownerTable = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_owner'")
      .get();
    const lineageTrigger = database
      .prepare(
        `SELECT name, sql
         FROM sqlite_master
         WHERE type = 'trigger' AND name = 'codemode_execution_lineage_immutable'`,
      )
      .get();
    const phaseLineageTrigger = database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'trigger' AND name = 'workflow_phase_lineage_immutable'`,
      )
      .get();
    const sequenceTrigger = database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'trigger' AND name = 'tool_call_action_sequence_required'`,
      )
      .get();
    const learningJobIndexes = database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name IN ('jobs_reflection_session_created', 'jobs_experiment_created')
         ORDER BY name`,
      )
      .all();
    database
      .prepare(
        `INSERT INTO sessions(
          session_id, title, status, provider, model, runtime, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "session-null-sequence",
        "Null sequence",
        "idle",
        "controlled",
        "controlled",
        "pi",
        "2026-07-26T00:00:00.000Z",
        "2026-07-26T00:00:00.000Z",
        "{}",
      );
    expect(() =>
      database
        .prepare(
          `INSERT INTO tool_calls(
            tool_call_id, session_id, tool_name, request_json, status, sensitivity, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "action-null-sequence",
          "session-null-sequence",
          "inspect_self",
          "{}",
          "requested",
          "normal",
          "2026-07-26T00:00:00.000Z",
        ),
    ).toThrow(/action sequence is required/iu);
    database.close();

    expect(versions.at(-1)).toBe(24);
    expect(ownerTable).toBeDefined();
    expect(lineageTrigger).toMatchObject({
      name: "codemode_execution_lineage_immutable",
      sql: expect.stringContaining("source_digest"),
    });
    expect(phaseLineageTrigger).toBeDefined();
    expect(sequenceTrigger).toBeDefined();
    expect(learningJobIndexes).toEqual([
      { name: "jobs_experiment_created" },
      { name: "jobs_reflection_session_created" },
    ]);
  });

  test("keeps authority grants, reservations, completions, and replay in SQLite", async () => {
    const root = await temporary("durable-authority");
    const first = await createWorkspaceStore(root);
    await authority(first).schedule("job:durable:schedule", "schedule:durable", async (receipt) => {
      await authority(first).issueSchedulerGrant(
        "durable",
        2,
        new Date(Date.now() + 60_000).toISOString(),
        receipt,
      );
      return null;
    });
    let executions = 0;
    await expect(
      authority(first).runScheduled("durable", 1, "durable-fingerprint", async () => {
        executions += 1;
        return "finished";
      }),
    ).resolves.toMatchObject({ ok: true, replayed: false, value: "finished" });
    first.close();

    const recovered = await createWorkspaceStore(root);
    await expect(
      authority(recovered).runScheduled("durable", 1, "durable-fingerprint", async () => {
        executions += 1;
        return "duplicate";
      }),
    ).resolves.toMatchObject({ ok: true, replayed: true, value: "finished" });
    expect(executions).toBe(1);
    await expect(
      authority(recovered).runScheduled("durable", 2, "durable-fingerprint", async () => {
        executions += 1;
        return "second";
      }),
    ).resolves.toMatchObject({ ok: true, replayed: false, value: "second" });
    await expect(
      authority(recovered).runScheduled("durable", 3, "durable-fingerprint", async () => {
        executions += 1;
        return "over-budget";
      }),
    ).resolves.toMatchObject({ ok: false, code: "denied" });
    expect(executions).toBe(2);

    const database = new DatabaseSync(recovered.unsafeDatabasePathForTesting, { readOnly: true });
    expect(
      database
        .prepare(
          `SELECT status, receipt_lineage_id FROM authority_operations
           WHERE principal = 'scheduler' AND effect = 'execute'`,
        )
        .get(),
    ).toMatchObject({
      status: "completed",
      receipt_lineage_id: expect.stringMatching(/^receipt_/u),
    });
    database.close();
    recovered.close();
  });

  test("replays a durable foreground operation without persisting an unused grant", async () => {
    const store = await createWorkspaceStore(await temporary("foreground-authority-replay"));
    let executions = 0;
    const request = Object.freeze({
      operationId: "operation-foreground-durable-replay",
      effect: "read" as const,
      resource: "tool:durable-replay",
      estimatedCost: 0,
      idempotencyKey: "foreground-durable-replay",
      requestDigest: digest("a"),
      execute: async () => {
        executions += 1;
        return "durable";
      },
    });
    const permission = {
      effects: ["read"],
      resourcePatterns: ["tool:durable-replay"],
      credentialRefs: [],
    };

    await expect(authority(store).runForeground(request, permission)).resolves.toMatchObject({
      ok: true,
      replayed: false,
      value: "durable",
    });
    expect(countRows(store, "authority_grants")).toBe(1);
    await expect(authority(store).runForeground(request, permission)).resolves.toMatchObject({
      ok: true,
      replayed: true,
      value: "durable",
    });
    expect(executions).toBe(1);
    expect(countRows(store, "authority_grants")).toBe(1);
    store.close();
  });

  test("fails closed for durable collisions, failures, and unresolved reservations", async () => {
    const store = await createWorkspaceStore(await temporary("authority-fail-closed"));
    await expect(
      authority(store).promote("capability:first", "shared-key", async () => "first"),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      authority(store).promote("capability:other", "shared-key", async () => "must-not-run"),
    ).resolves.toMatchObject({ ok: false, code: "collision" });

    let failedExecutions = 0;
    await expect(
      authority(store).promote("capability:failure", "failure-key", async () => {
        failedExecutions += 1;
        throw new Error("durable failure");
      }),
    ).resolves.toMatchObject({ ok: false, code: "failed" });
    await expect(
      authority(store).promote("capability:failure", "failure-key", async () => {
        failedExecutions += 1;
        return null;
      }),
    ).resolves.toMatchObject({ ok: false, code: "failed" });
    expect(failedExecutions).toBe(1);

    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: (() => void) | undefined;
    const executing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = authority(store).promote("capability:inflight", "inflight-key", async () => {
      started?.();
      await blocked;
      return "settled";
    });
    await executing;
    await expect(
      authority(store).promote("capability:inflight", "inflight-key", async () => "duplicate"),
    ).resolves.toMatchObject({ ok: false, code: "ambiguous" });
    release?.();
    await expect(first).resolves.toMatchObject({ ok: true, value: "settled" });
    store.close();
  });

  test("rejects forged and stale receipts at the exact operation boundary", async () => {
    const store = await createWorkspaceStore(await temporary("receipt-binding"));
    let firstReceipt: AuthorityReceipt | undefined;
    await authority(store).promote("capability:first:activate", "activate:first", async (receipt) => {
      firstReceipt = receipt;
      expect(
        authority(store).receiptVerifier.verify(receipt, {
          effect: "promote",
          resource: "capability:first:activate",
          operationId: receipt.operationId,
        }),
      ).toBe(true);
      expect(
        authority(store).receiptVerifier.verify(
          {
            effect: receipt.effect,
            resource: receipt.resource,
            operationId: receipt.operationId,
          },
          {
            effect: "promote",
            resource: "capability:first:activate",
            operationId: receipt.operationId,
          },
        ),
      ).toBe(false);
      return null;
    });
    await authority(store).promote("capability:second:activate", "activate:second", async (receipt) => {
      expect(firstReceipt).toBeDefined();
      expect(
        authority(store).receiptVerifier.verify(firstReceipt, {
          effect: "promote",
          resource: "capability:second:activate",
          operationId: receipt.operationId,
        }),
      ).toBe(false);
      return null;
    });
    store.close();
  });

  test("writes the operational cutover marker only after strict legacy validation", async () => {
    const root = await temporary("strict-cutover");
    await mkdir(join(root, "ledger"), { recursive: true });
    await writeFile(join(root, "ledger", "events.jsonl"), "{ definitely-not-json }\n");
    const store = await createWorkspaceStore(root);

    await expect(store.cutoverLegacyOperationalAuthority(root, actor)).rejects.toThrow(
      "malformed legacy journal line 1",
    );
    const database = new DatabaseSync(store.unsafeDatabasePathForTesting, { readOnly: true });
    expect(database.prepare("SELECT count(*) AS count FROM operational_cutovers").get()).toMatchObject({
      count: 0,
    });
    database.close();
    store.close();
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

  test("preserves message insertion order when one turn shares a timestamp", async () => {
    const store = await createWorkspaceStore(await temporary("message-order"));
    await store.operational.sessions.put(session("session-message-order"));
    const createdAt = "2026-01-01T00:00:00.000Z";
    await store.operational.messages.put({
      messageId: "turn-1:user",
      sessionId: "session-message-order",
      role: "user",
      content: "question",
      sensitivity: "normal",
      createdAt,
      metadata: { turnId: "turn-1" },
    });
    await store.operational.messages.put({
      messageId: "turn-1:assistant",
      sessionId: "session-message-order",
      role: "assistant",
      content: "answer",
      sensitivity: "normal",
      createdAt,
      metadata: { turnId: "turn-1" },
    });

    expect(
      (await store.operational.messages.listForSession("session-message-order")).map(
        (message) => message.role,
      ),
    ).toEqual(["user", "assistant"]);
    store.close();
  });

  test("keeps queued turns and explicit steers durable, ordered, and session isolated", async () => {
    const store = await createWorkspaceStore(await temporary("user-intents"));
    await store.operational.sessions.put(session("session-intents"));
    await store.operational.sessions.put(session("session-other-intents"));
    seedForegroundTurn(store, {
      turnId: "turn-active",
      sessionId: "session-intents",
      status: "running",
      admittedAt: "2026-01-01T00:00:00.000Z",
    });

    await store.operational.userIntents.enqueue({
      intentId: "intent-z-first",
      sessionId: "session-intents",
      text: "first",
      queuedBehindTurnId: "turn-active",
      createdAt: "2026-01-01T00:01:00.000Z",
    });
    await store.operational.userIntents.enqueue({
      intentId: "intent-a-second",
      sessionId: "session-intents",
      text: "second",
      queuedBehindTurnId: "turn-active",
      createdAt: "2026-01-01T00:01:00.000Z",
    });
    await store.operational.userIntents.enqueue({
      intentId: "intent-other",
      sessionId: "session-other-intents",
      text: "other session",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(
      (await store.operational.userIntents.listPending("session-intents")).map((intent) => intent.intentId),
    ).toEqual(["intent-z-first", "intent-a-second"]);
    await expect(
      store.operational.userIntents.withdraw({
        sessionId: "session-intents",
        intentId: "intent-a-second",
        withdrawnAt: "2026-01-01T00:03:00.000Z",
      }),
    ).resolves.toMatchObject({
      intentId: "intent-a-second",
      status: "withdrawn",
    });
    await expect(
      store.operational.userIntents.claimOldestPending({
        sessionId: "session-intents",
        targetTurnId: "turn-first",
        claimedAt: "2026-01-01T00:04:00.000Z",
      }),
    ).resolves.toMatchObject({
      intentId: "intent-z-first",
      status: "dispatching",
      targetTurnId: "turn-first",
      attemptCount: 1,
    });
    await expect(
      store.operational.userIntents.releaseUnconsumedDispatch({
        sessionId: "session-other-intents",
        intentId: "intent-z-first",
        releasedAt: "2026-01-01T00:05:00.000Z",
      }),
    ).resolves.toBeUndefined();

    await expect(
      store.operational.userIntents.enqueueAndPromoteToSteer({
        sessionId: "session-intents",
        intentId: "intent-steer",
        text: "change direction",
        targetTurnId: "turn-active",
        createdAt: "2026-01-01T00:05:00.000Z",
        promotedAt: "2026-01-01T00:06:00.000Z",
      }),
    ).resolves.toMatchObject({
      deliveryMode: "steer",
      status: "dispatching",
      targetTurnId: "turn-active",
    });
    const deliveredSteer = await store.operational.userIntents.recordSteerDelivery({
      sessionId: "session-intents",
      intentId: "intent-steer",
      targetTurnId: "turn-active",
      text: "change direction",
      sensitivity: "normal",
      timelineSequence: 1,
      deliveredAt: "2026-01-01T00:07:00.000Z",
    });
    expect(deliveredSteer).toMatchObject({ status: "delivered" });
    expect(deliveredSteer?.text).toBeUndefined();
    await expect(
      store.operational.userIntents.enqueue({
        intentId: "intent-steer",
        sessionId: "session-intents",
        text: "change direction",
        queuedBehindTurnId: "turn-active",
        createdAt: "2026-01-01T00:05:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "delivered", contentDigest: sha256("change direction") });
    await expect(store.operational.messages.get("turn-active:steer:intent-steer")).resolves.toMatchObject({
      content: "change direction",
      metadata: {
        turnId: "turn-active",
        sourceIntentId: "intent-steer",
        deliveryMode: "steer",
      },
      timelineSequence: 1,
    });

    await store.operational.userIntents.enqueue({
      intentId: "intent-third",
      sessionId: "session-intents",
      text: "third",
      createdAt: "2026-01-01T00:08:00.000Z",
    });
    await store.operational.userIntents.enqueue({
      intentId: "intent-fourth",
      sessionId: "session-intents",
      text: "fourth",
      createdAt: "2026-01-01T00:09:00.000Z",
    });
    await expect(
      store.operational.userIntents.promoteNewestPendingToSteer({
        sessionId: "session-intents",
        targetTurnId: "turn-active",
        promotedAt: "2026-01-01T00:10:00.000Z",
      }),
    ).resolves.toMatchObject({
      intentId: "intent-fourth",
      deliveryMode: "steer",
      status: "dispatching",
    });
    await expect(
      store.operational.userIntents.releaseUnconsumedDispatch({
        sessionId: "session-intents",
        intentId: "intent-fourth",
        releasedAt: "2026-01-01T00:11:00.000Z",
      }),
    ).resolves.toMatchObject({
      status: "pending",
      deliveryMode: "turn",
      attemptCount: 1,
    });
    expect(
      (await store.operational.userIntents.listPending("session-intents")).map((intent) => intent.intentId),
    ).toEqual(["intent-third", "intent-fourth"]);
    expect(
      (await store.operational.userIntents.listPending("session-other-intents")).map(
        (intent) => intent.intentId,
      ),
    ).toEqual(["intent-other"]);
    store.close();
  });

  test("atomically enqueues and promotes an explicit steer with idempotent identity", async () => {
    const root = await temporary("atomic-explicit-steer");
    const store = await createWorkspaceStore(root);
    await store.operational.sessions.put(session("session-atomic-steer"));
    seedForegroundTurn(store, {
      turnId: "turn-atomic-steer",
      sessionId: "session-atomic-steer",
      status: "running",
      admittedAt: "2026-01-01T00:00:00.000Z",
    });
    const request = {
      intentId: "intent-atomic-steer",
      sessionId: "session-atomic-steer",
      text: "change direction immediately",
      targetTurnId: "turn-atomic-steer",
      createdAt: "2026-01-01T00:01:00.000Z",
      promotedAt: "2026-01-01T00:01:00.001Z",
    } as const;

    await expect(store.operational.userIntents.enqueueAndPromoteToSteer(request)).resolves.toMatchObject({
      intentId: "intent-atomic-steer",
      deliveryMode: "steer",
      status: "dispatching",
      queueSequence: 1,
      queuedBehindTurnId: "turn-atomic-steer",
      targetTurnId: "turn-atomic-steer",
      attemptCount: 1,
    });
    await expect(store.operational.userIntents.enqueueAndPromoteToSteer(request)).resolves.toMatchObject({
      intentId: "intent-atomic-steer",
      queueSequence: 1,
      attemptCount: 1,
    });
    expect(await store.operational.userIntents.listPending("session-atomic-steer")).toEqual([]);

    const database = new DatabaseSync(join(root, "database", "noesis.sqlite"), { readOnly: true });
    expect(
      database
        .prepare("SELECT count(*) AS count FROM user_intents WHERE intent_id = ?")
        .get("intent-atomic-steer"),
    ).toMatchObject({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT activity_kind
           FROM activity_log
           WHERE subject_kind = 'user_intent' AND subject_id = ?
           ORDER BY rowid`,
        )
        .all("intent-atomic-steer"),
    ).toEqual([
      { activity_kind: "user_intent.enqueued" },
      { activity_kind: "user_intent.promoted_to_steer" },
    ]);
    database.close();
    store.close();
  });

  test("does not enqueue an explicit steer when its target cannot be bound", async () => {
    const root = await temporary("atomic-explicit-steer-target");
    const store = await createWorkspaceStore(root);
    await store.operational.sessions.put(session("session-steer-target"));
    await store.operational.sessions.put(session("session-steer-target-other"));
    seedForegroundTurn(store, {
      turnId: "turn-steer-completed",
      sessionId: "session-steer-target",
      status: "completed",
      admittedAt: "2026-01-01T00:00:00.000Z",
      settledAt: "2026-01-01T00:00:30.000Z",
    });
    seedForegroundTurn(store, {
      turnId: "turn-steer-other-session",
      sessionId: "session-steer-target-other",
      status: "running",
      admittedAt: "2026-01-01T00:00:00.000Z",
    });

    for (const [intentId, targetTurnId] of [
      ["intent-target-missing", "turn-steer-missing"],
      ["intent-target-settled", "turn-steer-completed"],
      ["intent-target-foreign", "turn-steer-other-session"],
    ] as const) {
      await expect(
        store.operational.userIntents.enqueueAndPromoteToSteer({
          intentId,
          sessionId: "session-steer-target",
          text: intentId,
          targetTurnId,
          createdAt: "2026-01-01T00:01:00.000Z",
          promotedAt: "2026-01-01T00:01:00.001Z",
        }),
      ).resolves.toBeUndefined();
    }

    const database = new DatabaseSync(join(root, "database", "noesis.sqlite"), { readOnly: true });
    expect(database.prepare("SELECT count(*) AS count FROM user_intents").get()).toMatchObject({ count: 0 });
    expect(
      database.prepare("SELECT count(*) AS count FROM activity_log WHERE subject_kind = 'user_intent'").get(),
    ).toMatchObject({ count: 0 });
    database.close();
    store.close();
  });

  test("does not mutate queued work when steer promotion races turn settlement", async () => {
    const store = await createWorkspaceStore(await temporary("queued-steer-settlement-race"));
    await store.operational.sessions.put(session("session-steer-race"));
    seedForegroundTurn(store, {
      turnId: "turn-steer-race",
      sessionId: "session-steer-race",
      status: "completed",
      admittedAt: "2026-01-01T00:00:00.000Z",
      settledAt: "2026-01-01T00:00:01.000Z",
    });
    await store.operational.userIntents.enqueue({
      intentId: "intent-stays-pending",
      sessionId: "session-steer-race",
      text: "keep me queued",
      createdAt: "2026-01-01T00:00:02.000Z",
    });

    await expect(
      store.operational.userIntents.promoteNewestPendingToSteer({
        sessionId: "session-steer-race",
        targetTurnId: "turn-steer-race",
        promotedAt: "2026-01-01T00:00:03.000Z",
      }),
    ).resolves.toBeUndefined();
    await expect(store.operational.userIntents.listPending("session-steer-race")).resolves.toMatchObject([
      { intentId: "intent-stays-pending", status: "pending", deliveryMode: "turn" },
    ]);
    store.close();
  });

  test("does not hold an explicit steer when a previously running target settles first", async () => {
    const root = await temporary("held-explicit-steer-settlement-race");
    const store = await createWorkspaceStore(root);
    await store.operational.sessions.put(session("session-held-explicit-race"));
    seedForegroundTurn(store, {
      turnId: "turn-held-explicit-race",
      sessionId: "session-held-explicit-race",
      status: "running",
      admittedAt: "2026-01-01T00:00:00.000Z",
    });

    const settlement = new DatabaseSync(store.unsafeDatabasePathForTesting);
    settlement
      .prepare(
        `UPDATE foreground_turns
         SET status = 'completed', settled_at = ?
         WHERE turn_id = ? AND status = 'running'`,
      )
      .run("2026-01-01T00:00:01.000Z", "turn-held-explicit-race");
    settlement.close();

    await expect(
      store.operational.userIntents.holdExplicitSteer({
        intentId: "intent-held-explicit-race",
        sessionId: "session-held-explicit-race",
        text: "restore this draft",
        targetTurnId: "turn-held-explicit-race",
        createdAt: "2026-01-01T00:00:02.000Z",
        heldAt: "2026-01-01T00:00:02.000Z",
      }),
    ).resolves.toBeUndefined();

    const inspection = new DatabaseSync(store.unsafeDatabasePathForTesting, { readOnly: true });
    expect(inspection.prepare("SELECT count(*) AS count FROM user_intents").get()).toMatchObject({
      count: 0,
    });
    expect(
      inspection
        .prepare("SELECT count(*) AS count FROM activity_log WHERE subject_kind = 'user_intent'")
        .get(),
    ).toMatchObject({ count: 0 });
    inspection.close();
    store.close();
  });

  test("holds pre-ready steers durably and restores each origin without FIFO delivery", async () => {
    const store = await createWorkspaceStore(await temporary("held-steers"));
    await store.operational.sessions.put(session("session-held-steers"));
    seedForegroundTurn(store, {
      turnId: "turn-held-steers",
      sessionId: "session-held-steers",
      status: "running",
      admittedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.operational.userIntents.enqueue({
      intentId: "intent-queued-held",
      sessionId: "session-held-steers",
      text: "queued then steered",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await expect(
      store.operational.userIntents.holdNewestPendingToSteer({
        sessionId: "session-held-steers",
        targetTurnId: "turn-held-steers",
        heldAt: "2026-01-01T00:00:02.000Z",
      }),
    ).resolves.toMatchObject({
      intentId: "intent-queued-held",
      status: "held",
      deliveryMode: "steer",
      steerOrigin: "queued",
      attemptCount: 0,
    });
    await expect(
      store.operational.userIntents.holdExplicitSteer({
        intentId: "intent-explicit-held",
        sessionId: "session-held-steers",
        text: "explicit steer",
        targetTurnId: "turn-held-steers",
        createdAt: "2026-01-01T00:00:03.000Z",
        heldAt: "2026-01-01T00:00:03.000Z",
      }),
    ).resolves.toMatchObject({
      status: "held",
      steerOrigin: "explicit",
      attemptCount: 0,
    });
    expect(await store.operational.userIntents.listPending("session-held-steers")).toEqual([]);
    await expect(store.operational.userIntents.listHeld("session-held-steers")).resolves.toMatchObject([
      { intentId: "intent-queued-held" },
      { intentId: "intent-explicit-held" },
    ]);

    await expect(
      store.operational.userIntents.activateHeldSteer({
        sessionId: "session-held-steers",
        intentId: "intent-explicit-held",
        targetTurnId: "turn-held-steers",
        promotedAt: "2026-01-01T00:00:04.000Z",
      }),
    ).resolves.toMatchObject({ status: "dispatching", attemptCount: 1 });
    await expect(
      store.operational.userIntents.releaseHeldSteer({
        sessionId: "session-held-steers",
        intentId: "intent-queued-held",
        targetTurnId: "turn-held-steers",
        releasedAt: "2026-01-01T00:00:05.000Z",
      }),
    ).resolves.toMatchObject({ status: "pending", deliveryMode: "turn" });
    expect(await store.operational.userIntents.listUnresolved("session-held-steers")).toEqual([]);
    store.close();
  });

  test("recovers held explicit steers as inspectable uncertainty and held queued steers as pending", async () => {
    const store = await createWorkspaceStore(await temporary("held-steer-recovery"));
    await store.operational.sessions.put(session("session-held-recovery"));
    seedForegroundTurn(store, {
      turnId: "turn-held-recovery",
      sessionId: "session-held-recovery",
      status: "running",
      admittedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.operational.userIntents.enqueue({
      intentId: "intent-held-queued",
      sessionId: "session-held-recovery",
      text: "queued",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await store.operational.userIntents.holdNewestPendingToSteer({
      sessionId: "session-held-recovery",
      targetTurnId: "turn-held-recovery",
      heldAt: "2026-01-01T00:00:02.000Z",
    });
    await store.operational.userIntents.holdExplicitSteer({
      intentId: "intent-held-explicit",
      sessionId: "session-held-recovery",
      text: "explicit",
      targetTurnId: "turn-held-recovery",
      createdAt: "2026-01-01T00:00:03.000Z",
      heldAt: "2026-01-01T00:00:03.000Z",
    });

    await expect(
      store.operational.userIntents.recoverDispatching({
        sessionId: "session-held-recovery",
        recoveredAt: "2026-01-01T00:00:04.000Z",
      }),
    ).resolves.toEqual({ released: 1, delivered: 0, unresolved: 1 });
    await expect(store.operational.userIntents.listPending("session-held-recovery")).resolves.toMatchObject([
      { intentId: "intent-held-queued", status: "pending" },
    ]);
    await expect(
      store.operational.userIntents.listUnresolved("session-held-recovery"),
    ).resolves.toMatchObject([
      {
        intentId: "intent-held-explicit",
        status: "unresolved",
        deliveryMode: "steer",
        steerOrigin: "explicit",
      },
    ]);
    expect(await store.operational.userIntents.listHeld("session-held-recovery")).toEqual([]);
    store.close();
  });

  test("rolls back an explicit steer when promotion provenance cannot be recorded", async () => {
    const root = await temporary("atomic-explicit-steer-rollback");
    const store = await createWorkspaceStore(root);
    await store.operational.sessions.put(session("session-steer-rollback"));
    seedForegroundTurn(store, {
      turnId: "turn-steer-rollback",
      sessionId: "session-steer-rollback",
      status: "running",
      admittedAt: "2026-01-01T00:00:00.000Z",
    });
    const database = new DatabaseSync(join(root, "database", "noesis.sqlite"));
    database.exec(`
      CREATE TRIGGER reject_atomic_steer_activity
      BEFORE INSERT ON activity_log
      WHEN NEW.subject_kind = 'user_intent' AND NEW.subject_id = 'intent-steer-rollback'
      BEGIN
        SELECT RAISE(ABORT, 'reject atomic steer activity');
      END;
    `);

    await expect(
      store.operational.userIntents.enqueueAndPromoteToSteer({
        intentId: "intent-steer-rollback",
        sessionId: "session-steer-rollback",
        text: "must remain atomic",
        targetTurnId: "turn-steer-rollback",
        createdAt: "2026-01-01T00:01:00.000Z",
        promotedAt: "2026-01-01T00:01:00.001Z",
      }),
    ).rejects.toThrow(/reject atomic steer activity/u);
    expect(
      database
        .prepare("SELECT count(*) AS count FROM user_intents WHERE intent_id = ?")
        .get("intent-steer-rollback"),
    ).toMatchObject({ count: 0 });
    expect(
      database
        .prepare("SELECT count(*) AS count FROM activity_log WHERE subject_id = ?")
        .get("intent-steer-rollback"),
    ).toMatchObject({ count: 0 });
    database.close();
    store.close();
  });

  test("atomically withdraws a proven-unconsumed explicit steer without exposing pending work", async () => {
    const root = await temporary("atomic-explicit-steer-withdraw");
    const store = await createWorkspaceStore(root);
    await store.operational.sessions.put(session("session-steer-withdraw"));
    seedForegroundTurn(store, {
      turnId: "turn-steer-withdraw",
      sessionId: "session-steer-withdraw",
      status: "running",
      admittedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.operational.userIntents.enqueueAndPromoteToSteer({
      intentId: "intent-steer-withdraw",
      sessionId: "session-steer-withdraw",
      text: "restore this exact text",
      targetTurnId: "turn-steer-withdraw",
      createdAt: "2026-01-01T00:01:00.000Z",
      promotedAt: "2026-01-01T00:01:00.001Z",
    });
    const request = {
      sessionId: "session-steer-withdraw",
      intentId: "intent-steer-withdraw",
      targetTurnId: "turn-steer-withdraw",
      withdrawnAt: "2026-01-01T00:02:00.000Z",
    } as const;

    await expect(
      store.operational.userIntents.withdrawUnconsumedSteerDispatch(request),
    ).resolves.toMatchObject({
      status: "withdrawn",
      deliveryMode: "turn",
      text: "restore this exact text",
      queuedBehindTurnId: "turn-steer-withdraw",
      withdrawnAt: "2026-01-01T00:02:00.000Z",
    });
    await expect(
      store.operational.userIntents.withdrawUnconsumedSteerDispatch(request),
    ).resolves.toMatchObject({
      status: "withdrawn",
      text: "restore this exact text",
    });
    expect(await store.operational.userIntents.listPending("session-steer-withdraw")).toEqual([]);

    const database = new DatabaseSync(join(root, "database", "noesis.sqlite"), { readOnly: true });
    expect(
      database
        .prepare("SELECT status, delivery_mode, target_turn_id FROM user_intents WHERE intent_id = ?")
        .get("intent-steer-withdraw"),
    ).toEqual({ status: "withdrawn", delivery_mode: "turn", target_turn_id: null });
    database.close();
    store.close();
  });

  test("rolls back unconsumed steer withdrawal without exposing pending work", async () => {
    const root = await temporary("atomic-explicit-steer-withdraw-rollback");
    const store = await createWorkspaceStore(root);
    await store.operational.sessions.put(session("session-steer-withdraw-rollback"));
    seedForegroundTurn(store, {
      turnId: "turn-steer-withdraw-rollback",
      sessionId: "session-steer-withdraw-rollback",
      status: "running",
      admittedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.operational.userIntents.enqueueAndPromoteToSteer({
      intentId: "intent-steer-withdraw-rollback",
      sessionId: "session-steer-withdraw-rollback",
      text: "never become pending",
      targetTurnId: "turn-steer-withdraw-rollback",
      createdAt: "2026-01-01T00:01:00.000Z",
      promotedAt: "2026-01-01T00:01:00.001Z",
    });
    const database = new DatabaseSync(join(root, "database", "noesis.sqlite"));
    database.exec(`
      CREATE TRIGGER reject_atomic_steer_withdrawal
      BEFORE INSERT ON activity_log
      WHEN NEW.activity_kind = 'user_intent.withdrawn_unconsumed_steer'
      BEGIN
        SELECT RAISE(ABORT, 'reject atomic steer withdrawal');
      END;
    `);

    await expect(
      store.operational.userIntents.withdrawUnconsumedSteerDispatch({
        sessionId: "session-steer-withdraw-rollback",
        intentId: "intent-steer-withdraw-rollback",
        targetTurnId: "turn-steer-withdraw-rollback",
        withdrawnAt: "2026-01-01T00:02:00.000Z",
      }),
    ).rejects.toThrow(/reject atomic steer withdrawal/u);
    expect(
      database
        .prepare("SELECT status, delivery_mode, target_turn_id FROM user_intents WHERE intent_id = ?")
        .get("intent-steer-withdraw-rollback"),
    ).toEqual({
      status: "dispatching",
      delivery_mode: "steer",
      target_turn_id: "turn-steer-withdraw-rollback",
    });
    expect(await store.operational.userIntents.listPending("session-steer-withdraw-rollback")).toEqual([]);
    database.close();
    store.close();
  });

  test("allocates unique explicit-steer sequence numbers across store instances", async () => {
    const root = await temporary("atomic-explicit-steer-contention");
    const first = await createWorkspaceStore(root);
    await first.operational.sessions.put(session("session-steer-contention"));
    seedForegroundTurn(first, {
      turnId: "turn-steer-contention",
      sessionId: "session-steer-contention",
      status: "running",
      admittedAt: "2026-01-01T00:00:00.000Z",
    });
    const second = await createWorkspaceStore(root);
    const request = (intentId: string) => ({
      intentId,
      sessionId: "session-steer-contention",
      text: intentId,
      targetTurnId: "turn-steer-contention",
      createdAt: "2026-01-01T00:01:00.000Z",
      promotedAt: "2026-01-01T00:01:00.001Z",
    });

    const [one, two] = await Promise.all([
      first.operational.userIntents.enqueueAndPromoteToSteer(request("intent-steer-one")),
      second.operational.userIntents.enqueueAndPromoteToSteer(request("intent-steer-two")),
    ]);
    expect([one?.queueSequence, two?.queueSequence].sort()).toEqual([1, 2]);
    const repeated = await Promise.all([
      first.operational.userIntents.enqueueAndPromoteToSteer(request("intent-steer-one")),
      second.operational.userIntents.enqueueAndPromoteToSteer(request("intent-steer-one")),
    ]);
    expect(repeated.map((intent) => intent?.queueSequence)).toEqual([one?.queueSequence, one?.queueSequence]);

    second.close();
    first.close();
  });

  test("records immutable turn timeline sequence for same-millisecond steer delivery", async () => {
    const store = await createWorkspaceStore(await temporary("steer-interaction-sequence"));
    await store.operational.sessions.put(session("session-steer-sequence"));
    seedForegroundTurn(store, {
      turnId: "turn-steer-sequence",
      sessionId: "session-steer-sequence",
      status: "running",
      admittedAt: "2026-01-01T00:00:00.000Z",
    });
    for (const [index, intentId] of ["intent-steer-first", "intent-steer-second"].entries()) {
      await store.operational.userIntents.enqueueAndPromoteToSteer({
        intentId,
        sessionId: "session-steer-sequence",
        text: intentId,
        targetTurnId: "turn-steer-sequence",
        createdAt: "2026-01-01T00:01:00.000Z",
        promotedAt: `2026-01-01T00:01:00.00${String(index)}Z`,
      });
    }
    const deliveredAt = "2026-01-01T00:02:00.000Z";
    for (const [index, intentId] of ["intent-steer-second", "intent-steer-first"].entries()) {
      await store.operational.userIntents.recordSteerDelivery({
        sessionId: "session-steer-sequence",
        intentId,
        targetTurnId: "turn-steer-sequence",
        text: intentId,
        sensitivity: "normal",
        timelineSequence: index + 1,
        deliveredAt,
      });
    }

    const steers = (await store.operational.messages.listForSession("session-steer-sequence")).filter(
      (message) => message.metadata["deliveryMode"] === "steer",
    );
    expect(steers.map((message) => message.timelineSequence)).toEqual([1, 2]);
    expect(
      steers
        .toSorted(
          (left, right) =>
            (left.timelineSequence ?? Number.MAX_SAFE_INTEGER) -
            (right.timelineSequence ?? Number.MAX_SAFE_INTEGER),
        )
        .map((message) => message.metadata["sourceIntentId"]),
    ).toEqual(["intent-steer-second", "intent-steer-first"]);
    store.close();
  });

  test("commits steer text to its canonical message atomically and protects intent identity", async () => {
    const root = await temporary("user-intent-canonical-text");
    const store = await createWorkspaceStore(root);
    await store.operational.sessions.put(session("session-canonical-text"));
    seedForegroundTurn(store, {
      turnId: "turn-canonical-text",
      sessionId: "session-canonical-text",
      status: "running",
      admittedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.operational.userIntents.enqueueAndPromoteToSteer({
      intentId: "intent-canonical-text",
      sessionId: "session-canonical-text",
      text: "canonical steer",
      targetTurnId: "turn-canonical-text",
      createdAt: "2026-01-01T00:01:00.000Z",
      promotedAt: "2026-01-01T00:02:00.000Z",
    });

    await expect(
      store.operational.userIntents.recordSteerDelivery({
        sessionId: "session-canonical-text",
        intentId: "intent-canonical-text",
        targetTurnId: "turn-canonical-text",
        text: "wrong steer",
        sensitivity: "normal",
        timelineSequence: 1,
        deliveredAt: "2026-01-01T00:03:00.000Z",
      }),
    ).rejects.toThrow(/does not match its digest/u);
    await expect(
      store.operational.messages.get("turn-canonical-text:steer:intent-canonical-text"),
    ).resolves.toBeUndefined();

    const delivered = await store.operational.userIntents.recordSteerDelivery({
      sessionId: "session-canonical-text",
      intentId: "intent-canonical-text",
      targetTurnId: "turn-canonical-text",
      text: "canonical steer",
      sensitivity: "normal",
      timelineSequence: 1,
      deliveredAt: "2026-01-01T00:03:00.000Z",
    });
    expect(delivered).toMatchObject({
      status: "delivered",
      contentDigest: sha256("canonical steer"),
    });
    expect(delivered?.text).toBeUndefined();
    await expect(
      store.operational.userIntents.recordSteerDelivery({
        sessionId: "session-canonical-text",
        intentId: "intent-canonical-text",
        targetTurnId: "turn-canonical-text",
        text: "canonical steer",
        sensitivity: "normal",
        timelineSequence: 1,
        deliveredAt: "2026-01-01T00:04:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "delivered", deliveredAt: "2026-01-01T00:03:00.000Z" });
    await expect(
      store.operational.userIntents.recordSteerDelivery({
        sessionId: "session-canonical-text",
        intentId: "intent-canonical-text",
        targetTurnId: "turn-canonical-text",
        text: "canonical steer",
        sensitivity: "normal",
        timelineSequence: 2,
        deliveredAt: "2026-01-01T00:04:00.000Z",
      }),
    ).resolves.toBeUndefined();
    expect(
      (await store.operational.messages.listForSession("session-canonical-text")).filter(
        (message) => message.metadata["sourceIntentId"] === "intent-canonical-text",
      ),
    ).toHaveLength(1);
    await store.operational.userIntents.enqueue({
      intentId: "intent-pending-immutable",
      sessionId: "session-canonical-text",
      text: "pending text",
      createdAt: "2026-01-01T00:05:00.000Z",
    });

    const database = new DatabaseSync(join(root, "database", "noesis.sqlite"));
    expect(() =>
      database
        .prepare("UPDATE user_intents SET text = ? WHERE intent_id = ?")
        .run("mutated pending text", "intent-pending-immutable"),
    ).toThrow(/text may only be cleared by delivery/u);
    expect(() =>
      database
        .prepare("UPDATE user_intents SET text = ? WHERE intent_id = ?")
        .run("mutated", "intent-canonical-text"),
    ).toThrow(/text may only be cleared by delivery/u);
    expect(() =>
      database
        .prepare("UPDATE user_intents SET content_digest = ? WHERE intent_id = ?")
        .run(sha256("mutated"), "intent-canonical-text"),
    ).toThrow(/identity and provenance are immutable/u);
    database.close();
    store.close();
  });

  test("claims one pending user intent exactly once across store instances", async () => {
    const root = await temporary("user-intent-claim-contention");
    const first = await createWorkspaceStore(root);
    await first.operational.sessions.put(session("session-claim"));
    await first.operational.userIntents.enqueue({
      intentId: "intent-only",
      sessionId: "session-claim",
      text: "only once",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const second = await createWorkspaceStore(root);

    const claims = await Promise.all([
      first.operational.userIntents.claimOldestPending({
        sessionId: "session-claim",
        targetTurnId: "turn-worker-one",
        claimedAt: "2026-01-01T00:01:00.000Z",
      }),
      second.operational.userIntents.claimOldestPending({
        sessionId: "session-claim",
        targetTurnId: "turn-worker-two",
        claimedAt: "2026-01-01T00:01:00.000Z",
      }),
    ]);

    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    expect(claims.filter((claim) => claim === undefined)).toHaveLength(1);
    expect(await first.operational.userIntents.listPending("session-claim")).toEqual([]);
    second.close();
    first.close();
  });

  test("recovers dispatching user intents from durable message provenance", async () => {
    const store = await createWorkspaceStore(await temporary("user-intent-recovery"));
    await store.operational.sessions.put(session("session-recovery"));
    const targets = [
      ["intent-missing", "turn-missing"],
      ["intent-completed", "turn-completed"],
      ["intent-failed", "turn-failed"],
      ["intent-running", "turn-running"],
    ] as const;
    for (const [index, [intentId, targetTurnId]] of targets.entries()) {
      await store.operational.userIntents.enqueue({
        intentId,
        sessionId: "session-recovery",
        text: intentId,
        createdAt: `2026-01-01T00:0${String(index)}:00.000Z`,
      });
      await store.operational.userIntents.claimOldestPending({
        sessionId: "session-recovery",
        targetTurnId,
        claimedAt: `2026-01-01T00:0${String(index)}:30.000Z`,
      });
    }
    seedForegroundTurn(store, {
      turnId: "turn-running",
      sessionId: "session-recovery",
      status: "running",
      admittedAt: "2026-01-01T00:00:00.000Z",
    });
    seedForegroundTurn(store, {
      turnId: "turn-completed",
      sessionId: "session-recovery",
      status: "completed",
      admittedAt: "2026-01-01T00:00:00.000Z",
      settledAt: "2026-01-01T00:00:30.000Z",
    });
    await store.operational.userIntents.enqueueAndPromoteToSteer({
      intentId: "intent-steer-uncertain",
      sessionId: "session-recovery",
      text: "possibly consumed",
      targetTurnId: "turn-running",
      createdAt: "2026-01-01T00:08:00.000Z",
      promotedAt: "2026-01-01T00:08:30.000Z",
    });
    seedForegroundTurn(store, {
      turnId: "turn-failed",
      sessionId: "session-recovery",
      status: "failed",
      admittedAt: "2026-01-01T00:00:00.000Z",
      settledAt: "2026-01-01T00:00:30.000Z",
    });
    for (const [intentId, turnId] of [
      ["intent-completed", "turn-completed"],
      ["intent-failed", "turn-failed"],
      ["intent-running", "turn-running"],
    ] as const) {
      await store.operational.messages.put({
        messageId: `${turnId}:user`,
        sessionId: "session-recovery",
        role: "user",
        content: intentId,
        sensitivity: "normal",
        createdAt: "2026-01-01T00:09:00.000Z",
        metadata: { turnId, sourceIntentId: intentId },
      });
    }

    await expect(
      store.operational.userIntents.recoverDispatching({
        sessionId: "session-recovery",
        recoveredAt: "2026-01-01T00:10:00.000Z",
      }),
    ).resolves.toEqual({ released: 1, delivered: 1, unresolved: 3 });
    expect(
      (await store.operational.userIntents.listPending("session-recovery")).map((intent) => [
        intent.intentId,
        intent.attemptCount,
      ]),
    ).toEqual([["intent-missing", 1]]);
    await expect(store.operational.userIntents.listUnresolved("session-recovery")).resolves.toMatchObject([
      { intentId: "intent-failed", status: "unresolved", deliveryMode: "turn" },
      { intentId: "intent-running", status: "unresolved", deliveryMode: "turn" },
      {
        intentId: "intent-steer-uncertain",
        status: "unresolved",
        deliveryMode: "steer",
        text: "possibly consumed",
      },
    ]);
    const withdrawn = await store.operational.userIntents.withdraw({
      sessionId: "session-recovery",
      intentId: "intent-steer-uncertain",
      withdrawnAt: "2026-01-01T00:10:30.000Z",
    });
    expect(withdrawn).toMatchObject({
      status: "withdrawn",
      deliveryMode: "turn",
      text: "possibly consumed",
    });
    expect(withdrawn?.targetTurnId).toBeUndefined();
    await expect(
      store.operational.userIntents.recoverDispatching({
        sessionId: "session-recovery",
        recoveredAt: "2026-01-01T00:11:00.000Z",
      }),
    ).resolves.toEqual({ released: 0, delivered: 0, unresolved: 0 });
    store.close();
  });

  test("fails closed when durable message provenance has the wrong content", async () => {
    const store = await createWorkspaceStore(await temporary("user-intent-digest-mismatch"));
    await store.operational.sessions.put(session("session-digest-mismatch"));
    await store.operational.userIntents.enqueue({
      intentId: "intent-digest-mismatch",
      sessionId: "session-digest-mismatch",
      text: "expected content",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await store.operational.userIntents.claimOldestPending({
      sessionId: "session-digest-mismatch",
      targetTurnId: "turn-digest-mismatch",
      claimedAt: "2026-01-01T00:01:00.000Z",
    });
    await store.operational.messages.put({
      messageId: "turn-digest-mismatch:user",
      sessionId: "session-digest-mismatch",
      role: "user",
      content: "different content",
      sensitivity: "normal",
      createdAt: "2026-01-01T00:02:00.000Z",
      metadata: { turnId: "turn-digest-mismatch", sourceIntentId: "intent-digest-mismatch" },
    });

    await expect(
      store.operational.userIntents.recoverDispatching({
        sessionId: "session-digest-mismatch",
        recoveredAt: "2026-01-01T00:03:00.000Z",
      }),
    ).rejects.toThrow(/does not match its digest/u);
    expect(await store.operational.userIntents.listPending("session-digest-mismatch")).toEqual([]);
    store.close();
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

  test("retries the exact completing experiment write against its merged stored provenance", async () => {
    const store = await createWorkspaceStore(await temporary("experiment-completion-retry"));
    const [initialEvidence, authoringEvidence, completingEvidence] = await Promise.all([
      store.evidence.appendEvidence({
        workingPath: "experiments/retry/initial",
        bytes: text("initial"),
        actor,
        evidenceKind: "input",
      }),
      store.evidence.appendEvidence({
        workingPath: "experiments/retry/authoring",
        bytes: text("authoring"),
        actor,
        evidenceKind: "input",
      }),
      store.evidence.appendEvidence({
        workingPath: "experiments/retry/completing",
        bytes: text("completing"),
        actor,
        evidenceKind: "input",
      }),
    ]);
    const baseline = revision("retry-baseline", "c");
    const candidate = revision("retry-candidate", "d");
    const initial: Experiment = {
      experimentId: "experiment-completion-retry",
      hypothesis: "completion retries preserve cumulative provenance",
      scope: "research",
      evidenceRefs: [initialEvidence],
      baselineRevision: baseline,
      candidateRevisions: [candidate],
      feedbackSignalIds: ["feedback-initial"],
      status: "hypothesis",
    };
    await store.research.experiments.putExperiment(initial);
    await store.research.experiments.putExperiment({
      ...initial,
      evidenceRefs: [authoringEvidence],
      feedbackSignalIds: ["feedback-authoring"],
      status: "authoring",
    });
    await store.research.experiments.putExperiment({
      ...initial,
      evidenceRefs: [authoringEvidence],
      feedbackSignalIds: ["feedback-authoring"],
      status: "preflight",
    });
    const completing: Experiment = {
      ...initial,
      evidenceRefs: [completingEvidence],
      feedbackSignalIds: ["feedback-completing"],
      status: "completed",
      outcome: "keep",
    };

    await store.research.experiments.putExperiment(completing);
    const completed = await store.research.experiments.getExperiment(initial.experimentId);
    await expect(store.research.experiments.putExperiment(completing)).resolves.toEqual({
      kind: "database_row",
      table: "experiments",
      rowId: initial.experimentId,
    });

    expect(await store.research.experiments.getExperiment(initial.experimentId)).toEqual(completed);
    expect(completed).toMatchObject({
      evidenceRefs: [initialEvidence, authoringEvidence, completingEvidence],
      feedbackSignalIds: ["feedback-initial", "feedback-authoring", "feedback-completing"],
    });
    await expect(
      store.research.experiments.putExperiment({ ...completing, outcome: "revise" }),
    ).rejects.toThrow(`Completed experiment ${initial.experimentId} is immutable`);
    store.close();
  });

  test("backs up and restores authoritative files and reports missing and orphan refs", async () => {
    const sourceRoot = await temporary("backup-source");
    const backupRoot = await temporary("backup-copy");
    const restoreRoot = await temporary("backup-restore");
    const store = await createWorkspaceStore(sourceRoot);
    await store.operational.sessions.put(session("session-backup"));
    await expect(
      authority(store).promote("capability:backup", "backup-operation", async () => "durable"),
    ).resolves.toMatchObject({ ok: true, value: "durable" });
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
    let replayExecutions = 0;
    await expect(
      authority(restoredStore).promote("capability:backup", "backup-operation", async () => {
        replayExecutions += 1;
        return "duplicate";
      }),
    ).resolves.toMatchObject({ ok: true, replayed: true, value: "durable" });
    expect(replayExecutions).toBe(0);
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

  test("cuts over the full legacy authority graph before writing its independent marker", async () => {
    const legacyRoot = await temporary("legacy-authority");
    const workspaceRoot = await temporary("authority-cutover");
    await mkdir(join(legacyRoot, "ledger"), { recursive: true });
    const events = legacyAuthorityEvents();
    await writeFile(
      join(legacyRoot, "ledger", "events.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    const store = await createWorkspaceStore(workspaceRoot);
    const first = await store.cutoverLegacyOperationalAuthority(legacyRoot, actor);
    const second = await store.cutoverLegacyOperationalAuthority(legacyRoot, actor);

    expect(first).toMatchObject({
      cutoverVersion: 1,
      alreadyCompleted: false,
    });
    expect(second).toMatchObject({
      cutoverVersion: 1,
      alreadyCompleted: true,
      sourceDigest: first.sourceDigest,
    });
    const database = new DatabaseSync(store.unsafeDatabasePathForTesting, { readOnly: true });
    expect(
      database.prepare("SELECT principal FROM authority_grants WHERE grant_id = 'grant-legacy'").get(),
    ).toMatchObject({ principal: "scheduler" });
    expect(
      database
        .prepare(
          "SELECT status, result_json, receipt_lineage_id FROM authority_operations WHERE operation_id = 'operation-legacy'",
        )
        .get(),
    ).toMatchObject({
      status: "completed",
      result_json: '"legacy-result"',
      receipt_lineage_id: expect.stringMatching(/^legacy_receipt_/u),
    });
    expect(database.prepare("SELECT count(*) AS count FROM operational_cutovers").get()).toMatchObject({
      count: 1,
    });
    database.close();
    store.close();
  });
});

function seedForegroundTurn(
  store: NoesisWorkspaceStore,
  input: {
    readonly turnId: string;
    readonly sessionId: string;
    readonly status: "running" | "completed" | "aborted" | "failed";
    readonly admittedAt: string;
    readonly settledAt?: string;
  },
): void {
  const database = new DatabaseSync(store.unsafeDatabasePathForTesting);
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare(
      `INSERT INTO foreground_turns(
        turn_id, session_id, plan_id, status, outcome_id, admitted_at, settled_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      input.turnId,
      input.sessionId,
      `plan:${input.turnId}`,
      input.status,
      input.admittedAt,
      input.settledAt ?? null,
    );
  database.close();
}

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

function legacyAuthorityEvents(): readonly LedgerEvent[] {
  const identity = {
    operationId: "operation-legacy",
    idempotencyKey: "legacy-run-1",
    principal: "scheduler" as const,
    effect: "execute" as const,
    resource: "job:legacy:runtime",
    requestDigest: digest("a"),
  };
  const events: LedgerEvent[] = [];
  const append = (
    input: Pick<LedgerEvent, "eventId" | "occurredAt" | "principal" | "type" | "payload">,
  ): void => {
    const previous = events.at(-1);
    const unsigned: Omit<LedgerEvent, "checksum"> = {
      schemaVersion: SCHEMA_VERSION,
      eventId: input.eventId,
      sequence: events.length + 1,
      occurredAt: input.occurredAt,
      principal: input.principal,
      type: input.type,
      payload: input.payload,
      previousChecksum: previous?.checksum ?? null,
    };
    events.push({ ...unsigned, checksum: eventChecksum(unsigned) });
  };
  append({
    eventId: "event-grant",
    occurredAt: "2026-01-01T00:00:00.000Z",
    principal: "system",
    type: "authority.grant_issued",
    payload: {
      grant: {
        schemaVersion: 1,
        grantId: "grant-legacy",
        principal: "scheduler",
        effects: ["execute"],
        resourcePrefixes: ["job:legacy:"],
        expiresAt: "2027-01-01T00:00:00.000Z",
        maxUses: 2,
        maxCost: 2,
      },
    },
  });
  const operation = {
    ...identity,
    operationFingerprint: effectOperationFingerprint(identity),
    estimatedCost: 1,
    grantId: "grant-legacy",
  };
  append({
    eventId: "event-reserved",
    occurredAt: "2026-01-01T00:01:00.000Z",
    principal: "scheduler",
    type: "effect.reserved",
    payload: { ...operation, reservationId: "reservation-legacy" },
  });
  append({
    eventId: "event-completed",
    occurredAt: "2026-01-01T00:02:00.000Z",
    principal: "scheduler",
    type: "effect.completed",
    payload: { ...operation, result: "legacy-result" },
  });
  return Object.freeze(events);
}
