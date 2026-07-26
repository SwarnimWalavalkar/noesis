import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
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
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const actor = { actorId: "test-user", kind: "user" as const };
const text = (value: string): Uint8Array => Buffer.from(value);
const digest = (character: string): string => character.repeat(64);
const authority = (store: NoesisWorkspaceStore) => createWorkspaceRuntimeInternals(store).authority;

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

  test("upgrades a development workspace through the execution contract migrations", async () => {
    const root = await temporary("development-migrations");
    await mkdir(join(root, "database"), { recursive: true });
    const seed = new DatabaseSync(join(root, "database", "noesis.sqlite"));
    const migrationNames = (await readdir(new URL("../migrations/", import.meta.url)))
      .filter((name) => /^\d{3}_.+\.sql$/u.test(name))
      .sort()
      .filter((name) => Number(name.slice(0, 3)) <= 18);
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

    const database = new DatabaseSync(join(root, "database", "noesis.sqlite"), { readOnly: true });
    const versions = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => Reflect.get(row, "version"));
    const ownerTable = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_owner'")
      .get();
    const lineageTrigger = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'codemode_execution_contract_insert'",
      )
      .get();
    database.close();

    expect(versions.at(-1)).toBe(20);
    expect(ownerTable).toBeDefined();
    expect(lineageTrigger).toBeDefined();
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
