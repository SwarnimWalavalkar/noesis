import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type FrozenTurnPlan, frozenTurnPlanDigest } from "@noesis/agent-types";
import { createConditionalObject, canonicalJson, type JsonValue, sha256 } from "@noesis/domain";
import type { AuthorityReceipt } from "@noesis/policy";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createWorkspaceStore, type NoesisWorkspaceStore, restoreWorkspaceBackup } from "../src/index.ts";
import { decodeModelCall, decodeWorkflowRun } from "../src/decoders.ts";
import { createWorkspaceRuntimeInternals } from "../src/protected-runtime.ts";
// SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
const actor = { actorId: "test-user", kind: "user" as const };
const text = (value: string): Uint8Array => Buffer.from(value);
const digest = (character: string): string => character.repeat(64);
const authority = (store: NoesisWorkspaceStore) => createWorkspaceRuntimeInternals(store).authority;
const publishWorkflowProgram = async (store: NoesisWorkspaceStore, projectId: string, name: string) => {
  const publication = await store.definitionPublications.publish({
    namespace: `program:${projectId}:workflow`,
    definitionId: name,
    revision: 1,
    workingPath: `programs/projects/${projectId}/workflow/${name}/program.json`,
    bytes: text(
      canonicalJson({
        kind: "noesis_program",
        mode: "workflow",
        name,
        description: `Workflow fixture ${name}.`,
        revision: 1,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        phases: [
          {
            name: "run",
            description: "Return the input.",
            source: "return input;",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
            requiredTools: [],
          },
        ],
        createdFrom: {
          sessionId: `session-${name}`,
          turnId: `turn-${name}`,
          planId: `plan-${name}`,
        },
      }),
    ),
    activity: Object.freeze({ kind: "program.saved", actor }),
  });
  if (!publication.ok) throw new Error(publication.error.message);
  return publication.value.definitionRevision;
};
const runningTurnPlan = (sessionId: string, turnId: string): FrozenTurnPlan => {
  const body: Omit<FrozenTurnPlan, "canonicalDigest"> = {
    schemaVersion: 2,
    planId: `plan-${turnId}`,
    sessionId,
    turnId,
    selectedCapabilities: [],
    renderedSystemPrompt: "Noesis recovery fixture",
    provider: "controlled",
    model: "controlled",
    thinkingLevel: "off",
    permissionSnapshot: { effects: [], resourcePatterns: [], credentialRefs: [] },
    retrievalCitations: [],
    createdAt: "2026-07-26T00:00:00.000Z",
  };
  return Object.freeze({ ...body, canonicalDigest: frozenTurnPlanDigest(body) });
};
const seedWorkspaceThroughMigration = async (
  root: string,
  maximumVersion: number,
): Promise<{
  readonly databasePath: string;
  readonly database: DatabaseSync;
}> => {
  await mkdir(join(root, "database"), { recursive: true });
  const databasePath = join(root, "database", "noesis.sqlite");
  const database = new DatabaseSync(databasePath);
  const migrationNames = (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => /^\d{3}_.+\.sql$/u.test(name))
    .sort()
    .filter((name) => Number(name.slice(0, 3)) <= maximumVersion);
  for (const name of migrationNames) {
    const version = Number(name.slice(0, 3));
    database.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    database
      .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
      .run(version, name, "2026-07-26T00:00:00.000Z");
  }
  return Object.freeze({ databasePath, database });
};
const seedWorkspaceThroughMigration32 = async (
  root: string,
): Promise<{
  readonly databasePath: string;
  readonly database: DatabaseSync;
}> => seedWorkspaceThroughMigration(root, 32);
const seedLegacyWorkflowDependencyRun = (
  database: DatabaseSync,
  suffix: string,
  definitionDependenciesDigest: string | Uint8Array,
): {
  readonly runId: string;
} => {
  const sessionId = `session-workflow-digest-${suffix}`;
  const revisionId = `revision-workflow-digest-${suffix}`;
  const runId = `workflow-run-digest-${suffix}`;
  database
    .prepare(`INSERT INTO sessions(
        session_id, title, status, provider, model, runtime, created_at, updated_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      sessionId,
      `Workflow digest ${suffix}`,
      "idle",
      "controlled",
      "controlled",
      "pi",
      "2026-07-26T00:00:00.000Z",
      "2026-07-26T00:00:00.000Z",
      "{}",
    );
  database
    .prepare(`INSERT INTO file_revisions(
        revision_id, revision_kind, working_path, snapshot_path, content_digest,
        actor_id, actor_kind, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      revisionId,
      "definition",
      `workflows/digest-${suffix}/workflow.json`,
      `revisions/definition/${revisionId}.json`,
      digest("b"),
      "test-user",
      "user",
      "2026-07-26T00:00:00.000Z",
    );
  database
    .prepare(`INSERT INTO workflow_runs(
        run_id, project_id, workflow_name, workflow_revision, definition_revision_id,
        definition_dependencies_digest, session_id, status, current_phase, input_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      runId,
      `project-workflow-digest-${suffix}`,
      `digest-${suffix}`,
      1,
      revisionId,
      definitionDependenciesDigest,
      sessionId,
      "running",
      0,
      "{}",
      "2026-07-26T00:00:00.000Z",
      "2026-07-26T00:00:00.000Z",
    );
  return Object.freeze({ runId });
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
  test("purges empty sessions and retains referenced conversation evidence behind a deletion tombstone", async () => {
    const store = await createWorkspaceStore(await temporary("session-deletion"));
    await store.operational.sessions.put(session("session-empty"));
    await expect(
      store.operational.sessions.deleteIfEmpty("session-empty", "2026-08-25T00:00:00.000Z"),
    ).resolves.toBe(true);
    await expect(store.operational.sessions.get("session-empty")).resolves.toBeUndefined();

    await store.operational.sessions.put(session("session-artifact-reference"));
    await store.artifacts.writeArtifact({
      path: "session-deletion/referenced.txt",
      mediaType: "text/plain",
      bytes: text("Retained evidence"),
      actor,
      relationshipRefs: Object.freeze([
        {
          kind: "database_row",
          table: "sessions",
          rowId: "session-artifact-reference",
        },
      ]),
    });
    await expect(
      store.operational.sessions.deleteIfEmpty("session-artifact-reference", "2026-08-25T00:00:00.500Z"),
    ).resolves.toBe(true);
    await expect(store.operational.sessions.get("session-artifact-reference")).resolves.toMatchObject({
      metadata: { deletedAt: "2026-08-25T00:00:00.500Z" },
    });

    await store.operational.sessions.put(session("session-nested-evidence-reference"));
    await store.definitions.recordWorkingDefinition({
      workingPath: "prompts/session-deletion-reference.md",
      bytes: text("Definition that cites the session"),
      actor,
      provenanceRefs: Object.freeze([
        {
          kind: "database_row",
          table: "sessions",
          rowId: "session-nested-evidence-reference",
        },
      ]),
    });
    await expect(
      store.operational.sessions.deleteIfEmpty(
        "session-nested-evidence-reference",
        "2026-08-25T00:00:00.750Z",
      ),
    ).resolves.toBe(true);
    await expect(store.operational.sessions.get("session-nested-evidence-reference")).resolves.toMatchObject({
      metadata: { deletedAt: "2026-08-25T00:00:00.750Z" },
    });

    await store.operational.sessions.put({ ...session("session-running"), status: "running" });
    await expect(
      store.operational.sessions.deleteIfEmpty("session-running", "2026-08-25T00:00:00.000Z"),
    ).resolves.toBe(false);
    await expect(store.operational.sessions.get("session-running")).resolves.toBeDefined();

    await store.operational.sessions.put(session("session-retained"));
    await store.operational.messages.put({
      messageId: "message-retained",
      sessionId: "session-retained",
      role: "user",
      content: "Delete this conversation from ordinary history.",
      sensitivity: "normal",
      createdAt: "2026-08-25T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    await store.search.rebuildDocuments();
    await expect(
      store.operational.sessions.deleteIfEmpty("session-retained", "2026-08-25T00:00:01.000Z"),
    ).resolves.toBe(false);
    await expect(
      store.operational.sessions.delete("session-retained", "2026-08-25T00:00:01.000Z"),
    ).resolves.toBe("retained-for-audit");
    await expect(store.operational.sessions.get("session-retained")).resolves.toMatchObject({
      metadata: { deletedAt: "2026-08-25T00:00:01.000Z" },
    });
    expect((await store.search.listDocuments()).map((document) => document.sessionId)).not.toContain(
      "session-retained",
    );
    store.close();
  });
  test("indexes tool calls only after they reach an immutable terminal status", async () => {
    const store = await createWorkspaceStore(await temporary("search-terminal-tool-calls"));
    await store.operational.sessions.put(session("session-search"));
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const running = {
      toolCallId: "tool-call-search",
      sessionId: "session-search",
      toolName: "shell.run",
      request: Object.freeze({ query: "immutable terminal trace" }),
      status: "running" as const,
      sensitivity: "normal" as const,
      createdAt: "2026-08-10T00:00:00.000Z",
    };
    await store.operational.toolCalls.put(running);
    expect(
      (await store.search.rebuildDocuments()).some(
        (document) =>
          document.source.kind === "database_row" &&
          document.source.table === "tool_calls" &&
          document.source.rowId === running.toolCallId,
      ),
    ).toBe(false);
    await store.operational.toolCalls.put({
      ...running,
      response: Object.freeze({ hits: 2 }),
      status: "completed",
      completedAt: "2026-08-10T00:00:01.000Z",
    });
    const rebuilt = await store.search.rebuildDocuments();
    const indexed = rebuilt.find(
      (document) =>
        document.source.kind === "database_row" &&
        document.source.table === "tool_calls" &&
        document.source.rowId === running.toolCallId,
    );
    expect(indexed?.body).toContain('"hits":2');
    store.close();
  });
  test("atomically activates immutable context checkpoints and preserves raw transcript rows", async () => {
    const root = await temporary("context-checkpoints");
    const store = await createWorkspaceStore(root);
    await store.operational.sessions.put(session("session-context"));
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const messages = [
      Object.freeze({
        messageId: "context-message-1",
        sessionId: "session-context",
        role: "user" as const,
        content: "Please keep the exact raw request.",
        sensitivity: "normal" as const,
        createdAt: "2026-08-13T00:00:00.000Z",
        metadata: Object.freeze({}),
      }),
      Object.freeze({
        messageId: "context-message-2",
        sessionId: "session-context",
        role: "assistant" as const,
        content: "The exact raw answer remains authoritative.",
        sensitivity: "private" as const,
        createdAt: "2026-08-13T00:00:01.000Z",
        metadata: Object.freeze({}),
      }),
    ];
    for (const message of messages) await store.operational.messages.put(message);
    const sources = Object.freeze(
      messages.map((message) =>
        Object.freeze({ messageId: message.messageId, contentDigest: sha256(message.content) }),
      ),
    );
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const checkpoint = Object.freeze({
      checkpointId: "context-checkpoint-1",
      sessionId: "session-context",
      summaryKind: "note_delta" as const,
      summary: "A bounded continuation summary.",
      summaryDigest: sha256("A bounded continuation summary."),
      sourceDigest: sha256(canonicalJson(sources)),
      sources,
      lastCoveredMessageId: "context-message-2",
      tokenBudget: 160000,
      estimatedSummaryTokens: 8,
      sensitivity: "private" as const,
      provider: "controlled",
      model: "controlled",
      thinkingLevel: "off" as const,
      usage: Object.freeze({ inputTokens: 10, outputTokens: 8, totalTokens: 18, estimatedCost: 0 }),
      createdAt: "2026-08-13T00:00:02.000Z",
    });
    const expectedContextMessageIds = Object.freeze(messages.map((message) => message.messageId));
    const first = sources[0];
    if (!first) throw new Error("Expected a checkpoint source fixture");
    const firstSource = Object.freeze([first]);
    await expect(
      store.operational.contextCheckpoints.activate({
        checkpoint: Object.freeze({
          ...checkpoint,
          checkpointId: "context-checkpoint-skips-tail",
          sources: firstSource,
          sourceDigest: sha256(canonicalJson(firstSource)),
          lastCoveredMessageId: first.messageId,
        }),
        expectedContextMessageIds,
      }),
    ).rejects.toThrow("retained tail must immediately follow");
    const duplicateSources = Object.freeze([first, first]);
    await expect(
      store.operational.contextCheckpoints.activate({
        checkpoint: Object.freeze({
          ...checkpoint,
          checkpointId: "context-checkpoint-duplicate-source",
          sources: duplicateSources,
          sourceDigest: sha256(canonicalJson(duplicateSources)),
          lastCoveredMessageId: first.messageId,
        }),
        expectedContextMessageIds,
      }),
    ).rejects.toThrow("cannot repeat a source message");
    await expect(
      store.operational.contextCheckpoints.activate({ checkpoint, expectedContextMessageIds }),
    ).resolves.toMatchObject({
      status: "activated",
      checkpoint: { checkpointId: checkpoint.checkpointId },
    });
    await expect(
      store.operational.contextCheckpoints.activate({
        checkpoint: Object.freeze({ ...checkpoint, checkpointId: "context-checkpoint-conflict" }),
        expectedContextMessageIds,
      }),
    ).resolves.toEqual({ status: "conflict", activeCheckpointId: checkpoint.checkpointId });
    expect(await store.operational.contextCheckpoints.get("context-checkpoint-conflict")).toBeUndefined();
    expect(
      (await store.operational.messages.listForSession("session-context")).map(({ content }) => content),
    ).toEqual(messages.map(({ content }) => content));
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const successorMessage = Object.freeze({
      messageId: "context-message-successor",
      sessionId: "session-context",
      role: "user" as const,
      content: "A later turn is covered by a successor checkpoint.",
      sensitivity: "normal" as const,
      createdAt: "2026-08-13T00:00:03.000Z",
      metadata: Object.freeze({}),
    });
    await store.operational.messages.put(successorMessage);
    const successorSources = Object.freeze([
      Object.freeze({
        messageId: successorMessage.messageId,
        contentDigest: sha256(successorMessage.content),
      }),
    ]);
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const successor = Object.freeze({
      ...checkpoint,
      checkpointId: "context-checkpoint-2",
      previousCheckpointId: checkpoint.checkpointId,
      summary: "The continuation now includes the later turn.",
      summaryDigest: sha256("The continuation now includes the later turn."),
      sourceDigest: sha256(canonicalJson(successorSources)),
      sources: successorSources,
      lastCoveredMessageId: successorMessage.messageId,
      estimatedSummaryTokens: 11,
      sensitivity: "normal" as const,
      usage: Object.freeze({ inputTokens: 9, outputTokens: 11, totalTokens: 20, estimatedCost: 0 }),
      createdAt: "2026-08-13T00:00:04.000Z",
    });
    await expect(
      store.operational.contextCheckpoints.activate({
        checkpoint: successor,
        expectedActiveCheckpointId: checkpoint.checkpointId,
        expectedContextMessageIds: Object.freeze([successorMessage.messageId]),
      }),
    ).resolves.toMatchObject({ status: "activated" });
    await expect(store.operational.contextCheckpoints.lineage(successor.checkpointId)).resolves.toEqual([
      checkpoint,
      successor,
    ]);
    await store.operational.sessions.put(session("session-context-other"));
    await store.operational.messages.put({
      messageId: "context-message-other",
      sessionId: "session-context-other",
      role: "user",
      content: "Other session context.",
      sensitivity: "normal",
      createdAt: "2026-08-13T00:00:05.000Z",
      metadata: Object.freeze({}),
    });
    const integrityDatabase = new DatabaseSync(store.unsafeDatabasePathForTesting);
    expect(() =>
      integrityDatabase
        .prepare(
          "INSERT INTO session_context_state(session_id, active_checkpoint_id, updated_at) VALUES (?, ?, ?)",
        )
        .run("session-context-other", checkpoint.checkpointId, "2026-08-13T00:00:06.000Z"),
    ).toThrow("active context checkpoint must belong to its session");
    expect(() =>
      integrityDatabase
        .prepare("UPDATE context_checkpoints SET first_retained_message_id = ? WHERE checkpoint_id = ?")
        .run("context-message-other", checkpoint.checkpointId),
    ).toThrow("context checkpoint is immutable");
    expect(() =>
      integrityDatabase
        .prepare("UPDATE context_checkpoints SET session_id = ? WHERE checkpoint_id = ?")
        .run("session-context-other", checkpoint.checkpointId),
    ).toThrow("context checkpoint is immutable");
    expect(() =>
      integrityDatabase
        .prepare("UPDATE context_checkpoints SET summary = ? WHERE checkpoint_id = ?")
        .run("Mutated summary.", checkpoint.checkpointId),
    ).toThrow("context checkpoint is immutable");
    expect(() =>
      integrityDatabase
        .prepare("UPDATE context_checkpoint_sources SET content_digest = ? WHERE checkpoint_id = ?")
        .run(sha256("mutated"), checkpoint.checkpointId),
    ).toThrow("context checkpoint source is immutable");
    expect(() =>
      integrityDatabase
        .prepare("DELETE FROM context_checkpoint_sources WHERE checkpoint_id = ?")
        .run(checkpoint.checkpointId),
    ).toThrow("context checkpoint source is immutable");
    expect(() =>
      integrityDatabase
        .prepare("DELETE FROM context_checkpoints WHERE checkpoint_id = ?")
        .run(checkpoint.checkpointId),
    ).toThrow("context checkpoint is immutable");
    expect(() =>
      integrityDatabase
        .prepare(`INSERT OR REPLACE INTO context_checkpoints
           SELECT * FROM context_checkpoints WHERE checkpoint_id = ?`)
        .run(checkpoint.checkpointId),
    ).toThrow("context checkpoint identity already exists");
    expect(() =>
      integrityDatabase
        .prepare(`INSERT OR REPLACE INTO context_checkpoint_seals(checkpoint_id, sealed_at)
           VALUES (?, ?)`)
        .run(checkpoint.checkpointId, "2026-08-13T00:00:07.000Z"),
    ).toThrow("context checkpoint seal identity already exists");
    integrityDatabase
      .prepare(`INSERT INTO messages(
          message_id, session_id, role, content, sensitivity, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "context-message-appended",
        "session-context",
        "user",
        "This later message must not mutate checkpoint provenance.",
        "normal",
        "2026-08-13T00:00:07.000Z",
        "{}",
      );
    expect(() =>
      integrityDatabase
        .prepare(`INSERT INTO context_checkpoint_sources(checkpoint_id, ordinal, message_id, content_digest)
           VALUES (?, ?, ?, ?)`)
        .run(
          checkpoint.checkpointId,
          checkpoint.sources.length,
          "context-message-appended",
          sha256("This later message must not mutate checkpoint provenance."),
        ),
    ).toThrow("sealed context checkpoint sources are immutable");
    integrityDatabase.close();
    store.close();
    const reopened = await createWorkspaceStore(root);
    await expect(reopened.operational.contextCheckpoints.get(checkpoint.checkpointId)).resolves.toEqual(
      checkpoint,
    );
    await expect(reopened.operational.contextCheckpoints.getActive("session-context")).resolves.toEqual(
      successor,
    );
    reopened.close();
  });
  test("rejects dangling checkpoint references when upgrading an applied migration 36 workspace", async () => {
    const root = await temporary("context-checkpoint-dangling-upgrade");
    const { databasePath, database } = await seedWorkspaceThroughMigration(root, 36);
    database
      .prepare(`INSERT INTO sessions(
          session_id, title, status, provider, model, runtime, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "session-context-dangling",
        "Dangling context",
        "idle",
        "controlled",
        "controlled",
        "pi",
        "2026-08-13T00:00:00.000Z",
        "2026-08-13T00:00:00.000Z",
        "{}",
      );
    database
      .prepare(`INSERT INTO messages(
          message_id, session_id, role, content, sensitivity, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "context-message-dangling",
        "session-context-dangling",
        "user",
        "This source is removed by a corrupted legacy workspace.",
        "normal",
        "2026-08-13T00:00:00.000Z",
        "{}",
      );
    const source = Object.freeze({
      messageId: "context-message-dangling",
      contentDigest: sha256("This source is removed by a corrupted legacy workspace."),
    });
    database
      .prepare(`INSERT INTO context_checkpoints(
          checkpoint_id, session_id, summary, summary_digest, source_digest,
          last_covered_message_id, token_budget, estimated_summary_tokens, sensitivity,
          provider, model, thinking_level, usage_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "context-checkpoint-dangling",
        "session-context-dangling",
        "Legacy summary.",
        sha256("Legacy summary."),
        sha256(canonicalJson(Object.freeze([source]))),
        source.messageId,
        160000,
        4,
        "normal",
        "controlled",
        "controlled",
        "off",
        canonicalJson({ inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 }),
        "2026-08-13T00:00:01.000Z",
      );
    database
      .prepare(`INSERT INTO context_checkpoint_sources(checkpoint_id, ordinal, message_id, content_digest)
         VALUES (?, ?, ?, ?)`)
      .run("context-checkpoint-dangling", 0, source.messageId, source.contentDigest);
    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare("DELETE FROM messages WHERE message_id = ?").run(source.messageId);
    database.close();
    await expect(createWorkspaceStore(root)).rejects.toThrow(
      "Workspace migration 037_context_checkpoint_session_immutability.sql failed",
    );
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    expect(inspection.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
      version: 36,
    });
    inspection.close();
  });
  test("activates a checkpoint when expected context spans multiple SQLite parameter chunks", async () => {
    const store = await createWorkspaceStore(await temporary("context-checkpoint-chunked-context"));
    await store.operational.sessions.put(session("session-context-chunked"));
    const expectedContextMessageIds: string[] = [];
    for (let index = 0; index < 501; index += 1) {
      const messageId = `context-chunked-${String(index).padStart(3, "0")}`;
      expectedContextMessageIds.push(messageId);
      await store.operational.messages.put({
        messageId,
        sessionId: "session-context-chunked",
        role: index % 2 === 0 ? "user" : "assistant",
        content: `Chunked context message ${String(index)}`,
        sensitivity: "normal",
        createdAt: `2026-08-13T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        metadata: Object.freeze({}),
      });
    }
    const firstMessageId = expectedContextMessageIds[0];
    const firstRetainedMessageId = expectedContextMessageIds[1];
    if (!firstMessageId || !firstRetainedMessageId) throw new Error("Expected chunked context fixtures");
    const sources = Object.freeze([
      Object.freeze({
        messageId: firstMessageId,
        contentDigest: sha256("Chunked context message 0"),
      }),
    ]);
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const checkpoint = Object.freeze({
      checkpointId: "context-checkpoint-chunked",
      sessionId: "session-context-chunked",
      summaryKind: "note_delta" as const,
      summary: "The oldest chunked context message was summarized.",
      summaryDigest: sha256("The oldest chunked context message was summarized."),
      sourceDigest: sha256(canonicalJson(sources)),
      sources,
      firstRetainedMessageId,
      lastCoveredMessageId: firstMessageId,
      tokenBudget: 160000,
      estimatedSummaryTokens: 12,
      sensitivity: "normal" as const,
      provider: "controlled",
      model: "controlled",
      thinkingLevel: "off" as const,
      usage: Object.freeze({ inputTokens: 10, outputTokens: 12, totalTokens: 22, estimatedCost: 0 }),
      createdAt: "2026-08-13T09:00:00.000Z",
    });
    await expect(
      store.operational.contextCheckpoints.activate({
        checkpoint,
        expectedContextMessageIds: Object.freeze(expectedContextMessageIds),
      }),
    ).resolves.toMatchObject({ status: "activated" });
    await expect(store.operational.contextCheckpoints.getActive("session-context-chunked")).resolves.toEqual(
      checkpoint,
    );
    store.close();
  });
  test("never re-indexes history retrieval tool calls as derived evidence", async () => {
    const store = await createWorkspaceStore(await temporary("search-history-tool-calls"));
    await store.operational.sessions.put(session("session-history-search"));
    await Promise.all([
      store.operational.toolCalls.put({
        toolCallId: "history-search-normal",
        sessionId: "session-history-search",
        toolName: "history.search_sessions",
        request: Object.freeze({ query: "prior launch decision" }),
        response: Object.freeze({ excerpt: "normal retrieved fragment" }),
        status: "completed",
        sensitivity: "normal",
        createdAt: "2026-08-10T00:00:00.000Z",
        completedAt: "2026-08-10T00:00:01.000Z",
      }),
      store.operational.toolCalls.put({
        toolCallId: "history-search-private",
        sessionId: "session-history-search",
        toolName: "history.open_session_evidence",
        request: Object.freeze({ citation: "private-citation" }),
        response: Object.freeze({ excerpt: "private retrieved fragment" }),
        status: "completed",
        sensitivity: "private",
        createdAt: "2026-08-10T00:00:02.000Z",
        completedAt: "2026-08-10T00:00:03.000Z",
      }),
      store.operational.toolCalls.put({
        toolCallId: "ordinary-terminal",
        sessionId: "session-history-search",
        toolName: "files.read",
        request: Object.freeze({ path: "README.md" }),
        response: Object.freeze({ content: "ordinary terminal trace" }),
        status: "completed",
        sensitivity: "normal",
        createdAt: "2026-08-10T00:00:04.000Z",
        completedAt: "2026-08-10T00:00:05.000Z",
      }),
    ]);
    const documents = await store.search.rebuildDocuments();
    const indexedToolCallIds = documents.flatMap((document) =>
      document.source.kind === "database_row" && document.source.table === "tool_calls"
        ? [document.source.rowId]
        : [],
    );
    expect(indexedToolCallIds).toContain("ordinary-terminal");
    expect(indexedToolCallIds).not.toContain("history-search-normal");
    expect(indexedToolCallIds).not.toContain("history-search-private");
    expect(JSON.stringify(documents)).not.toContain("private retrieved fragment");
    store.close();
  });
  test("rebuilds file revisions with more than 64 authoritative provenance references", async () => {
    const store = await createWorkspaceStore(await temporary("search-large-provenance"));
    await Promise.all([
      store.operational.sessions.put(session("session-provenance-a")),
      store.operational.sessions.put(session("session-provenance-b")),
    ]);
    const refs: Array<{
      readonly kind: "database_row";
      readonly table: "messages";
      readonly rowId: string;
    }> = [];
    for (let index = 0; index < 66; index += 1) {
      const messageId = `message-provenance-${index}`;
      await store.operational.messages.put({
        messageId,
        sessionId: index === 65 ? "session-provenance-b" : "session-provenance-a",
        role: "user",
        content: `Authoritative provenance message ${index}`,
        sensitivity: "normal",
        createdAt: `2026-08-10T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
        metadata: Object.freeze({}),
      });
      // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
      refs.push({ kind: "database_row" as const, table: "messages" as const, rowId: messageId });
    }
    const oneSessionEvidence = await store.evidence.appendEvidence({
      workingPath: "history/large-single-session-provenance.txt",
      bytes: text("Evidence with 65 authoritative references from one session."),
      actor,
      evidenceKind: "output",
      sensitivity: "normal",
      provenanceRefs: refs.slice(0, 65),
    });
    const multipleSessionEvidence = await store.evidence.appendEvidence({
      workingPath: "history/large-multiple-session-provenance.txt",
      bytes: text("Evidence whose 66th reference introduces another session."),
      actor,
      evidenceKind: "output",
      sensitivity: "normal",
      provenanceRefs: refs,
    });
    const documents = await store.search.rebuildDocuments();
    const revisionDocument = (revisionId: string) =>
      documents.find(
        (document) => document.source.kind === "file_revision" && document.source.revisionId === revisionId,
      );
    expect(revisionDocument(oneSessionEvidence.revisionId)?.sessionId).toBe("session-provenance-a");
    expect(revisionDocument(multipleSessionEvidence.revisionId)?.sessionId).toBeUndefined();
    const authoritativeRow = await store.reads.readDatabaseRow({
      kind: "database_row",
      table: "file_revisions",
      rowId: multipleSessionEvidence.revisionId,
    });
    expect(JSON.parse(String(authoritativeRow?.["provenance_refs_json"]))).toHaveLength(66);
    store.close();
  });
  test("projects late private and secret provenance before ordinary search candidates", async () => {
    const store = await createWorkspaceStore(await temporary("search-provenance-sensitivity"));
    await store.operational.sessions.put(session("session-sensitive-provenance"));
    const refs: Array<{
      readonly kind: "database_row";
      readonly table: "messages";
      readonly rowId: string;
    }> = [];
    for (let index = 0; index < 66; index += 1) {
      const messageId = `message-sensitive-provenance-${index}`;
      await store.operational.messages.put({
        messageId,
        sessionId: "session-sensitive-provenance",
        role: "user",
        content: `Provenance sensitivity anchor ${index}`,
        sensitivity: index === 65 ? "secret" : index === 64 ? "private" : "normal",
        createdAt: "2026-08-10T00:00:00.000Z",
        metadata: Object.freeze({}),
      });
      refs.push({ kind: "database_row", table: "messages", rowId: messageId });
    }
    const privateEvidence = await store.evidence.appendEvidence({
      workingPath: "history/late-private-provenance.txt",
      bytes: text("Late private provenance visibility sentinel."),
      actor,
      evidenceKind: "output",
      sensitivity: "normal",
      provenanceRefs: refs.slice(0, 65),
    });
    const secretEvidence = await store.evidence.appendEvidence({
      workingPath: "history/late-secret-provenance.txt",
      bytes: text("Late secret provenance visibility sentinel."),
      actor,
      evidenceKind: "output",
      sensitivity: "normal",
      provenanceRefs: refs,
    });
    const rebuilt = await store.search.rebuildDocuments();
    const revisionDocument = (revisionId: string) =>
      rebuilt.find(
        (document) => document.source.kind === "file_revision" && document.source.revisionId === revisionId,
      );
    expect(revisionDocument(privateEvidence.revisionId)?.sensitivity).toBe("private");
    expect(revisionDocument(secretEvidence.revisionId)?.sensitivity).toBe("secret");
    const ordinaryDocuments = await store.search.listDocuments();
    expect(ordinaryDocuments.map((document) => document.documentId)).not.toContain(
      revisionDocument(privateEvidence.revisionId)?.documentId,
    );
    expect(ordinaryDocuments.map((document) => document.documentId)).not.toContain(
      revisionDocument(secretEvidence.revisionId)?.documentId,
    );
    const ordinaryLexical = await store.search.lexicalCandidates({
      query: "provenance visibility sentinel",
      limit: 8,
      includePrivate: false,
    });
    const sensitiveDocumentIds = [
      revisionDocument(privateEvidence.revisionId)?.documentId,
      revisionDocument(secretEvidence.revisionId)?.documentId,
    ];
    expect(ordinaryLexical.every((candidate) => !sensitiveDocumentIds.includes(candidate.documentId))).toBe(
      true,
    );
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    await store.search.putEmbeddings(
      "sensitivity-test",
      new Map(rebuilt.map((document) => [document.documentId, [1, 0] as const])),
    );
    const ordinarySemantic = await store.search.semanticCandidates({
      modelId: "sensitivity-test",
      vector: [1, 0],
      limit: 8,
      includePrivate: false,
    });
    expect(ordinarySemantic.every((candidate) => !sensitiveDocumentIds.includes(candidate.documentId))).toBe(
      true,
    );
    store.close();
  });
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test("applies typed source scopes before lexical and semantic candidate limits", async () => {
    const store = await createWorkspaceStore(await temporary("search-source-scopes"));
    await store.operational.sessions.put({
      ...session("session-source-scopes"),
      title: "Scope eligibility sentinel session",
    });
    const evidenceMessageId = "message-source-scope-evidence";
    await store.operational.messages.put({
      messageId: evidenceMessageId,
      sessionId: "session-source-scopes",
      role: "user",
      content: "Experiment source evidence without the query phrase.",
      sensitivity: "normal",
      createdAt: "2026-08-10T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    for (let index = 0; index < 40; index += 1)
      await store.operational.messages.put({
        messageId: `message-source-scope-decoy-${index}`,
        sessionId: "session-source-scopes",
        role: "user",
        content: `${"scope eligibility sentinel ".repeat(20)}decoy ${index}`,
        sensitivity: "normal",
        createdAt: "2026-08-10T00:00:00.000Z",
        metadata: Object.freeze({}),
      });
    await store.operational.outcomes.put({
      outcomeId: "outcome-source-scope-accepted",
      sessionId: "session-source-scopes",
      status: "accepted",
      summary: "Scope eligibility sentinel accepted outcome.",
      sensitivity: "normal",
      createdAt: "2026-08-10T00:00:01.000Z",
      metadata: Object.freeze({}),
    });
    const documents = await store.search.rebuildDocuments();
    const lexical = async (sourceScope: "session_or_outcome") =>
      await store.search.lexicalCandidates({
        query: "scope eligibility sentinel",
        limit: 2,
        sourceScope,
        includePrivate: false,
      });
    const sessionOrOutcomeLexical = await lexical("session_or_outcome");
    expect(sessionOrOutcomeLexical).toHaveLength(2);
    expect(
      sessionOrOutcomeLexical.every(
        (candidate) =>
          candidate.source.kind === "database_row" &&
          ["sessions", "outcomes"].includes(candidate.source.table),
      ),
    ).toBe(true);
    const embeddings = new Map<string, readonly number[]>();
    for (const document of documents)
      embeddings.set(
        document.documentId,
        document.source.kind === "database_row" && document.source.table === "messages" ? [1, 0] : [0.8, 0.2],
      );
    await store.search.putEmbeddings("source-scope-test", embeddings);
    const semantic = async (sourceScope: "session_or_outcome") =>
      await store.search.semanticCandidates({
        modelId: "source-scope-test",
        vector: [1, 0],
        limit: 2,
        sourceScope,
        includePrivate: false,
      });
    const sessionOrOutcomeSemantic = await semantic("session_or_outcome");
    expect(sessionOrOutcomeSemantic).toHaveLength(2);
    expect(
      sessionOrOutcomeSemantic.every(
        (candidate) =>
          candidate.source.kind === "database_row" &&
          ["sessions", "outcomes"].includes(candidate.source.table),
      ),
    ).toBe(true);
    store.close();
  });
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
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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
    const modelRequest = await first.artifacts.writeArtifact({
      path: "model-calls/call-unfinished/request.json",
      mediaType: "application/json",
      bytes: text('{"prompt":"unfinished"}'),
      actor,
      relationshipRefs: Object.freeze([
        { kind: "database_row" as const, table: "sessions" as const, rowId: "session-codemode" },
      ]),
    });
    await first.operational.modelCalls.put({
      modelCallId: "call-unfinished",
      parentExecutionId: "execution-unfinished",
      sessionId: "session-codemode",
      requestArtifactId: modelRequest.artifactId,
      provider: "controlled",
      model: "controlled",
      thinkingLevel: "off",
      contextRefs: Object.freeze([]),
      status: "running",
      startedAt: "2026-07-26T00:00:00.500Z",
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
    expect(await recovered.operational.modelCalls.get("call-unfinished")).toMatchObject({
      status: "interrupted",
      error: "Process exited before model call outcome was observed",
      completedAt: "2026-07-26T00:01:00.000Z",
    });
    recovered.close();
  });
  test("enforces workflow context pins and model-call identity at the database boundary", async () => {
    const store = await createWorkspaceStore(await temporary("context-model-integrity"));
    await store.operational.sessions.put({
      sessionId: "session-context-model-integrity",
      title: "Context and model integrity",
      status: "running",
      provider: "controlled",
      model: "controlled",
      runtime: "pi",
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    const workflowDefinition = await publishWorkflowProgram(
      store,
      "project-context-model-integrity",
      "context-model-integrity",
    );
    const contextText = '{"role":"user","content":"frozen context é"}\n';
    const contextBytes = text(contextText);
    const contextArtifact = await store.artifacts.writeArtifact({
      path: "context/session-context-model-integrity.ndjson",
      mediaType: "application/x-ndjson",
      bytes: contextBytes,
      actor,
      relationshipRefs: Object.freeze([
        {
          kind: "database_row" as const,
          table: "sessions" as const,
          rowId: "session-context-model-integrity",
        },
      ]),
    });
    const database = new DatabaseSync(store.unsafeDatabasePathForTesting);
    database.exec("PRAGMA busy_timeout = 5000");
    const insertWorkflowRun = database.prepare(`INSERT INTO workflow_runs(
        run_id, project_id, workflow_name, workflow_revision, definition_revision_id,
        context_artifact_id, context_digest, context_character_length, context_byte_length,
        session_id, status, current_phase, input_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const workflowValues = [
      "project-context-model-integrity",
      "context-model-integrity",
      1,
      workflowDefinition.revisionId,
    ] as const;
    expect(() =>
      insertWorkflowRun.run(
        "workflow-partial-context",
        ...workflowValues,
        contextArtifact.artifactId,
        null,
        null,
        null,
        "session-context-model-integrity",
        "running",
        0,
        "{}",
        "2026-07-26T00:00:00.000Z",
        "2026-07-26T00:00:00.000Z",
      ),
    ).toThrow(/Invalid workflow context pin/iu);
    expect(() =>
      insertWorkflowRun.run(
        "workflow-mismatched-context",
        ...workflowValues,
        contextArtifact.artifactId,
        digest("f"),
        contextText.length,
        contextBytes.byteLength,
        "session-context-model-integrity",
        "running",
        0,
        "{}",
        "2026-07-26T00:00:00.000Z",
        "2026-07-26T00:00:00.000Z",
      ),
    ).toThrow(/Invalid workflow context pin/iu);
    const nulDigest = `${"a".repeat(63)}\0`;
    database.exec("PRAGMA ignore_check_constraints = ON");
    database
      .prepare(`INSERT INTO artifacts(
          artifact_id, path, media_type, byte_length, content_digest, actor_id, actor_kind,
          relationship_refs_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "artifact-nul-context-digest",
        "artifacts/nul-context-digest.jsonl",
        "application/x-ndjson",
        0,
        nulDigest,
        "test-user",
        "user",
        "[]",
        "2026-07-26T00:00:00.000Z",
      );
    database.exec("PRAGMA ignore_check_constraints = OFF");
    expect(() =>
      insertWorkflowRun.run(
        "workflow-nul-context-digest",
        ...workflowValues,
        "artifact-nul-context-digest",
        nulDigest,
        0,
        0,
        "session-context-model-integrity",
        "running",
        0,
        "{}",
        "2026-07-26T00:00:00.000Z",
        "2026-07-26T00:00:00.000Z",
      ),
    ).toThrow(/context_digest/iu);
    database.close();
    await store.operational.workflows.putRun({
      runId: "workflow-valid-context",
      projectId: "project-context-model-integrity",
      workflowName: "context-model-integrity",
      workflowRevision: 1,
      definitionRevisionId: workflowDefinition.revisionId,
      contextPin: Object.freeze({
        artifactId: contextArtifact.artifactId,
        digest: sha256(contextBytes),
        characterLength: contextText.length,
        byteLength: contextBytes.byteLength,
      }),
      sessionId: "session-context-model-integrity",
      status: "running",
      currentPhase: 0,
      input: Object.freeze({}),
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
    });
    const source = await store.artifacts.writeArtifact({
      path: "codemode/execution-context-model-integrity/source.mjs",
      mediaType: "text/javascript",
      bytes: text('return await agents.spawn({ prompt: "test" });'),
      actor,
      relationshipRefs: Object.freeze([
        {
          kind: "database_row" as const,
          table: "sessions" as const,
          rowId: "session-context-model-integrity",
        },
      ]),
    });
    await store.operational.codeExecutions.put({
      executionId: "execution-context-model-integrity",
      logicalExecutionId: "logical-context-model-integrity",
      sessionId: "session-context-model-integrity",
      catalogId: "catalog-context-model-integrity",
      catalogDigest: digest("a"),
      sourceDigest: sha256(text('return await agents.spawn({ prompt: "test" });')),
      sourceArtifactId: source.artifactId,
      status: "running",
      callCount: 1,
      startedAt: "2026-07-26T00:00:01.000Z",
    });
    const requestArtifact = await store.artifacts.writeArtifact({
      path: "model-calls/call-context-model-integrity/request.json",
      mediaType: "application/json",
      bytes: text('{"prompt":"test"}'),
      actor,
      relationshipRefs: Object.freeze([
        {
          kind: "database_row" as const,
          table: "sessions" as const,
          rowId: "session-context-model-integrity",
        },
      ]),
    });
    const outputArtifact = await store.artifacts.writeArtifact({
      path: "model-calls/call-context-model-integrity/output.json",
      mediaType: "application/json",
      bytes: text('{"text":"done"}'),
      actor,
      relationshipRefs: Object.freeze([
        {
          kind: "database_row" as const,
          table: "sessions" as const,
          rowId: "session-context-model-integrity",
        },
      ]),
    });
    const runningModelCall = Object.freeze({
      modelCallId: "call-context-model-integrity",
      parentExecutionId: "execution-context-model-integrity",
      sessionId: "session-context-model-integrity",
      requestArtifactId: requestArtifact.artifactId,
      provider: "controlled",
      model: "controlled",
      thinkingLevel: "off" as const,
      contextRefs: Object.freeze([
        Object.freeze({
          __noesisContext: Object.freeze({
            documentId: "context-document-integrity-fixture",
            start: 0,
            end: contextText.length,
          }),
        }),
      ]),
      status: "running" as const,
      startedAt: "2026-07-26T00:00:01.500Z",
    });
    await store.operational.modelCalls.put(runningModelCall);
    const modelDatabase = new DatabaseSync(store.unsafeDatabasePathForTesting);
    modelDatabase.exec("PRAGMA busy_timeout = 5000");
    expect(() =>
      modelDatabase
        .prepare("UPDATE model_calls SET input_tokens = 1 WHERE model_call_id = ?")
        .run(runningModelCall.modelCallId),
    ).toThrow(/CHECK constraint failed/iu);
    expect(() =>
      modelDatabase
        .prepare("UPDATE model_calls SET status = 'completed', completed_at = ? WHERE model_call_id = ?")
        .run("2026-07-26T00:00:02.000Z", runningModelCall.modelCallId),
    ).toThrow(/CHECK constraint failed.*output_artifact_id/iu);
    expect(() =>
      modelDatabase
        .prepare("INSERT OR REPLACE INTO model_calls SELECT * FROM model_calls WHERE model_call_id = ?")
        .run(runningModelCall.modelCallId),
    ).toThrow(/Model call identity already exists/iu);
    modelDatabase.close();
    await store.operational.modelCalls.put({
      ...runningModelCall,
      outputArtifactId: outputArtifact.artifactId,
      status: "completed",
      completedAt: "2026-07-26T00:00:02.000Z",
    });
    await expect(store.operational.modelCalls.get(runningModelCall.modelCallId)).resolves.toMatchObject({
      contextRefs: [
        {
          __noesisContext: {
            documentId: "context-document-integrity-fixture",
            start: 0,
            end: contextText.length,
          },
        },
      ],
      outputArtifactId: outputArtifact.artifactId,
      status: "completed",
    });
    store.close();
  });
  test("admits a turn plan only for an existing session and returns it again on re-admission", async () => {
    const root = await temporary("turn-plan-admission");
    const store = await createWorkspaceStore(root, { now: () => "2026-07-26T00:00:00.000Z" });
    const protectedRuntime = createWorkspaceRuntimeInternals(store).protectedRuntime;
    await expect(
      protectedRuntime.turnPlans.admit(runningTurnPlan("session-missing", "turn-orphan")),
    ).rejects.toThrow("Session session-missing does not exist");
    expect(await protectedRuntime.turnPlans.get("session-missing", "turn-orphan")).toBeUndefined();
    await store.operational.sessions.put({
      sessionId: "session-present",
      title: "Present",
      status: "idle",
      provider: "controlled",
      model: "controlled",
      runtime: "pi",
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    const plan = runningTurnPlan("session-present", "turn-present");
    const admitted = await protectedRuntime.turnPlans.admit(plan);
    expect(await protectedRuntime.turnPlans.admit(plan)).toEqual(admitted);
    store.close();
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
    await protectedRuntime.turnPlans.admit(runningTurnPlan("session-interrupted-turn", "turn-interrupted"));
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
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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
    await protectedRuntime.turnPlans.admit(
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
      .prepare(`SELECT activity_kind, subject_id, references_json
         FROM activity_log
         WHERE activity_kind = 'session.interrupted'
         ORDER BY subject_id`)
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
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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
      .run("stale-owner", 999999, "2026-07-26T00:00:00.000Z");
    database.close();
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 999999 && signal === 0)
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
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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
  test("binds script Program execution identity to the exact referenced source revision", async () => {
    const store = await createWorkspaceStore(await temporary("codemode-program-identity"));
    await store.operational.sessions.put(session("session-program-identity"));
    const sourceBytes = text('return "exact";');
    const sourceRevision = await store.definitions.recordWorkingDefinition({
      workingPath: "programs/projects/project-program/script/exact/index.mjs",
      bytes: sourceBytes,
      actor,
    });
    const publication = await store.definitionPublications.publish({
      namespace: "program:project-program:script",
      definitionId: "exact",
      revision: 1,
      workingPath: "programs/projects/project-program/script/exact/program.json",
      bytes: text(
        canonicalJson({
          kind: "noesis_program",
          mode: "script",
          name: "exact",
          description: "Return one exact value.",
          revision: 1,
          sourceRevision,
          inputSchema: { type: "object" },
          outputSchema: { type: "string" },
          requiredTools: [],
          createdFrom: {
            sessionId: "session-program-identity",
            turnId: "turn-program-identity",
            planId: "plan-program-identity",
          },
        }),
      ),
      provenanceRefs: Object.freeze([sourceRevision]),
      activity: Object.freeze({ kind: "program.saved", actor }),
    });
    if (!publication.ok) throw new Error(publication.error.message);
    const exactSource = await store.artifacts.writeArtifact({
      path: "codemode/execution-program-exact/source.mjs",
      mediaType: "text/javascript",
      bytes: sourceBytes,
      actor,
      relationshipRefs: Object.freeze([]),
    });
    await store.operational.codeExecutions.put({
      executionId: "execution-program-exact",
      logicalExecutionId: "logical-program-exact",
      sessionId: "session-program-identity",
      projectId: "project-program",
      catalogId: "catalog-test",
      catalogDigest: digest("a"),
      sourceDigest: sourceRevision.contentDigest,
      program: Object.freeze({
        mode: "script",
        projectId: "project-program",
        name: "exact",
        revision: 1,
        definitionRevisionId: publication.value.definitionRevision.revisionId,
      }),
      sourceArtifactId: exactSource.artifactId,
      status: "running",
      callCount: 0,
      startedAt: "2026-07-26T00:00:00.000Z",
    });
    const unrelatedBytes = text('return "unrelated";');
    const unrelatedSource = await store.artifacts.writeArtifact({
      path: "codemode/execution-program-unrelated/source.mjs",
      mediaType: "text/javascript",
      bytes: unrelatedBytes,
      actor,
      relationshipRefs: Object.freeze([]),
    });
    await expect(
      store.operational.codeExecutions.put({
        executionId: "execution-program-false-attribution",
        logicalExecutionId: "logical-program-false-attribution",
        sessionId: "session-program-identity",
        projectId: "project-program",
        catalogId: "catalog-test",
        catalogDigest: digest("a"),
        sourceDigest: sha256(unrelatedBytes),
        program: Object.freeze({
          mode: "script",
          projectId: "project-program",
          name: "exact",
          revision: 1,
          definitionRevisionId: publication.value.definitionRevision.revisionId,
        }),
        sourceArtifactId: unrelatedSource.artifactId,
        status: "running",
        callCount: 0,
        startedAt: "2026-07-26T00:00:00.000Z",
      }),
    ).rejects.toThrow("does not match its exact Program definition");
    store.close();
  });
  test("validates workflow definition dependency digests at SQL and decoder boundaries", async () => {
    const root = await temporary("workflow-definition-dependency-digest");
    const store = await createWorkspaceStore(root);
    await store.operational.sessions.put(session("session-workflow-digest"));
    const definitionRevision = await publishWorkflowProgram(store, "project-workflow-digest", "digest");
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const invalidDigests = [
      digest("A"),
      "a".repeat(63),
      `${"a".repeat(63)}g`,
      `${digest("a")}\0z`,
      `${"a".repeat(63)}\0`,
    ] as const;
    await store.operational.workflows.putRun({
      runId: "workflow-run-valid-digest",
      projectId: "project-workflow-digest",
      workflowName: "digest",
      workflowRevision: 1,
      definitionRevisionId: definitionRevision.revisionId,
      definitionDependenciesDigest: digest("a"),
      sessionId: "session-workflow-digest",
      status: "running",
      currentPhase: 0,
      input: {},
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
    });
    await expect(store.operational.workflows.getRun("workflow-run-valid-digest")).resolves.toMatchObject({
      definitionDependenciesDigest: digest("a"),
    });
    for (const [index, definitionDependenciesDigest] of invalidDigests.entries()) {
      await expect(
        store.operational.workflows.putRun({
          runId: `workflow-run-invalid-digest-${String(index)}`,
          projectId: "project-workflow-digest",
          workflowName: "digest",
          workflowRevision: 1,
          definitionRevisionId: definitionRevision.revisionId,
          definitionDependenciesDigest,
          sessionId: "session-workflow-digest",
          status: "running",
          currentPhase: 0,
          input: {},
          createdAt: "2026-07-26T00:00:00.000Z",
          updatedAt: "2026-07-26T00:00:00.000Z",
        }),
      ).rejects.toThrow(/64 lowercase hexadecimal ASCII bytes/iu);
      expect(() =>
        decodeWorkflowRun({
          run_id: `workflow-run-corrupt-digest-${String(index)}`,
          project_id: "project-workflow-digest",
          workflow_name: "digest",
          workflow_revision: 1,
          definition_revision_id: definitionRevision.revisionId,
          catalog_id: null,
          catalog_digest: null,
          definition_dependencies_digest: definitionDependenciesDigest,
          permission_digest: null,
          provider: null,
          model: null,
          thinking_level: null,
          session_id: "session-workflow-digest",
          turn_id: null,
          status: "running",
          current_phase: 0,
          input_json: "{}",
          output_json: null,
          error: null,
          created_at: "2026-07-26T00:00:00.000Z",
          updated_at: "2026-07-26T00:00:00.000Z",
          completed_at: null,
        }),
      ).toThrow();
    }
    const database = new DatabaseSync(store.unsafeDatabasePathForTesting);
    database.exec("PRAGMA busy_timeout = 5000");
    const blobDigest = Buffer.from(digest("a"));
    expect(() =>
      database
        .prepare(`INSERT INTO workflow_runs(
            run_id, project_id, workflow_name, workflow_revision, definition_revision_id,
            definition_dependencies_digest, session_id, status, current_phase, input_json,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          "workflow-run-blob-digest",
          "project-workflow-digest",
          "digest",
          1,
          definitionRevision.revisionId,
          blobDigest,
          "session-workflow-digest",
          "running",
          0,
          "{}",
          "2026-07-26T00:00:00.000Z",
          "2026-07-26T00:00:00.000Z",
        ),
    ).toThrow(/64 lowercase hexadecimal ASCII bytes|cannot store BLOB value in TEXT column/iu);
    expect(() =>
      database
        .prepare("UPDATE workflow_runs SET definition_dependencies_digest = ? WHERE run_id = ?")
        .run(blobDigest, "workflow-run-valid-digest"),
    ).toThrow(/64 lowercase hexadecimal ASCII bytes|cannot store BLOB value in TEXT column/iu);
    database.close();
    store.close();
  });
  test("hardens workflow definition dependency digests after migrations 31 and 32 were recorded", async () => {
    const root = await temporary("workflow-definition-dependency-digest-upgrade");
    const { databasePath, database } = await seedWorkspaceThroughMigration32(root);
    const legacy = seedLegacyWorkflowDependencyRun(database, "upgrade", digest("a"));
    database.close();
    const upgraded = await createWorkspaceStore(root);
    await expect(upgraded.operational.workflows.getRun(legacy.runId)).resolves.toMatchObject({
      definitionDependenciesDigest: digest("a"),
    });
    const currentDefinition = await publishWorkflowProgram(
      upgraded,
      "project-workflow-digest-upgrade",
      "digest-upgrade",
    );
    for (const [index, definitionDependenciesDigest] of [
      digest("A"),
      `${"a".repeat(63)}g`,
      `${digest("a")}\0z`,
    ].entries()) {
      await expect(
        upgraded.operational.workflows.putRun({
          runId: `workflow-run-invalid-upgraded-digest-${String(index)}`,
          projectId: "project-workflow-digest-upgrade",
          workflowName: "digest-upgrade",
          workflowRevision: 1,
          definitionRevisionId: currentDefinition.revisionId,
          definitionDependenciesDigest,
          sessionId: "session-workflow-digest-upgrade",
          status: "running",
          currentPhase: 0,
          input: {},
          createdAt: "2026-07-26T00:00:01.000Z",
          updatedAt: "2026-07-26T00:00:01.000Z",
        }),
      ).rejects.toThrow(/64 lowercase hexadecimal ASCII bytes/iu);
    }
    upgraded.close();
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      inspection.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get(),
    ).toEqual({ version: 58 });
    inspection.close();
  });
  test("aborts migration 33 when an older workspace contains a malformed workflow dependency digest", async () => {
    const root = await temporary("workflow-definition-dependency-digest-invalid-upgrade");
    const { database } = await seedWorkspaceThroughMigration32(root);
    const legacy = seedLegacyWorkflowDependencyRun(database, "invalid-upgrade", digest("A"));
    const migration = await readFile(
      new URL("../migrations/033_workflow_definition_dependency_digest.sql", import.meta.url),
      "utf8",
    );
    let migrationError: unknown;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration);
      database
        .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
        .run(33, "033_workflow_definition_dependency_digest.sql", "2026-07-26T00:00:01.000Z");
      database.exec("COMMIT");
    } catch (error) {
      migrationError = error;
      database.exec("ROLLBACK");
    }
    expect(migrationError).toBeInstanceOf(Error);
    expect(String(migrationError)).toMatch(/check constraint failed/iu);
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
      version: 32,
    });
    expect(
      database
        .prepare("SELECT definition_dependencies_digest FROM workflow_runs WHERE run_id = ?")
        .get(legacy.runId),
    ).toEqual({ definition_dependencies_digest: digest("A") });
    expect(
      database
        .prepare(`SELECT name FROM sqlite_master
           WHERE type = 'trigger' AND name = 'workflow_definition_dependency_digest_insert'`)
        .get(),
    ).toBeUndefined();
    expect(
      database
        .prepare(`SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'migration_033_workflow_digest_validation'`)
        .get(),
    ).toBeUndefined();
    database.close();
  });
  test("aborts migration 33 when an older workspace contains a BLOB workflow dependency digest", async () => {
    const root = await temporary("workflow-definition-dependency-blob-upgrade");
    const seeded = await seedWorkspaceThroughMigration32(root);
    const schemaRow = seeded.database
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'workflow_runs'")
      .get();
    const strictSchemaSql = schemaRow && typeof schemaRow === "object" ? schemaRow["sql"] : undefined;
    if (typeof strictSchemaSql !== "string") throw new Error("Expected workflow_runs schema SQL");
    const relaxedSchemaSql = strictSchemaSql.replace(/\s+STRICT$/u, "");
    if (relaxedSchemaSql === strictSchemaSql) throw new Error("Expected a strict workflow_runs table");
    const replaceWorkflowSchema = (database: DatabaseSync, sql: string): void => {
      const versionRow = database.prepare("PRAGMA schema_version").get();
      const version = versionRow && typeof versionRow === "object" ? versionRow["schema_version"] : undefined;
      if (typeof version !== "number") throw new Error("Expected a numeric SQLite schema version");
      database.exec("PRAGMA writable_schema = ON");
      database.prepare("UPDATE sqlite_schema SET sql = ? WHERE name = 'workflow_runs'").run(sql);
      database.exec(`PRAGMA schema_version = ${String(version + 1)}`);
      database.exec("PRAGMA writable_schema = OFF");
    };
    seeded.database.close();
    const corruptionOptions = { readOnly: false, defensive: false };
    const corrupt = new DatabaseSync(seeded.databasePath, corruptionOptions);
    replaceWorkflowSchema(corrupt, relaxedSchemaSql);
    const blobDigest = Buffer.from(digest("a"));
    const legacy = seedLegacyWorkflowDependencyRun(corrupt, "blob-upgrade", blobDigest);
    replaceWorkflowSchema(corrupt, strictSchemaSql);
    corrupt.close();
    const database = new DatabaseSync(seeded.databasePath);
    expect(
      database
        .prepare(`SELECT typeof(definition_dependencies_digest) AS storage_class
           FROM workflow_runs WHERE run_id = ?`)
        .get(legacy.runId),
    ).toEqual({ storage_class: "blob" });
    const migration = await readFile(
      new URL("../migrations/033_workflow_definition_dependency_digest.sql", import.meta.url),
      "utf8",
    );
    let migrationError: unknown;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration);
      database
        .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
        .run(33, "033_workflow_definition_dependency_digest.sql", "2026-07-26T00:00:01.000Z");
      database.exec("COMMIT");
    } catch (error) {
      migrationError = error;
      database.exec("ROLLBACK");
    }
    expect(migrationError).toBeInstanceOf(Error);
    expect(String(migrationError)).toMatch(/check constraint failed/iu);
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
      version: 32,
    });
    expect(
      database
        .prepare(`SELECT typeof(definition_dependencies_digest) AS storage_class
           FROM workflow_runs WHERE run_id = ?`)
        .get(legacy.runId),
    ).toEqual({ storage_class: "blob" });
    database.close();
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
    const definitionRevision = await publishWorkflowProgram(first, "project-workflow", "recover");
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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
      projectId: "project-workflow",
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
      projectId: "project-workflow",
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
        logicalExecutionId: "logical-completed-without-start",
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
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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
      projectId: "project-other",
      catalogId: "catalog-test",
      catalogDigest: digest("c"),
      sourceDigest: sha256(text("return input;")),
      sourceArtifactId: otherSource.artifactId,
      status: "running",
      callCount: 0,
      startedAt: "2026-07-26T00:00:00.000Z",
    });
    await first.operational.codeExecutions.put({
      executionId: "execution-other-project",
      logicalExecutionId: "logical-workflow-phase",
      sessionId: "session-workflow",
      projectId: "project-other",
      catalogId: "catalog-test",
      catalogDigest: digest("c"),
      sourceDigest: sha256(text("return input;")),
      sourceArtifactId: workflowSource.artifactId,
      status: "running",
      callCount: 0,
      startedAt: "2026-07-26T00:00:00.000Z",
    });
    await first.operational.codeExecutions.put({
      executionId: "execution-without-project",
      logicalExecutionId: "logical-workflow-phase",
      sessionId: "session-workflow",
      catalogId: "catalog-test",
      catalogDigest: digest("c"),
      sourceDigest: sha256(text("return input;")),
      sourceArtifactId: workflowSource.artifactId,
      status: "running",
      callCount: 0,
      startedAt: "2026-07-26T00:00:00.000Z",
    });
    await expect(
      first.operational.codeExecutions.put({
        executionId: "execution-cross-project-child",
        logicalExecutionId: "logical-cross-project-child",
        parentExecutionId: "execution-workflow-unfinished",
        sessionId: "session-workflow",
        projectId: "project-other",
        catalogId: "catalog-test",
        catalogDigest: digest("c"),
        sourceDigest: sha256(text("return input;")),
        sourceArtifactId: workflowSource.artifactId,
        status: "running",
        callCount: 0,
        startedAt: "2026-07-26T00:00:00.000Z",
      }),
    ).rejects.toThrow("parent does not share its project, session, and turn");
    await expect(
      first.operational.workflows.putPhase({
        runId: "workflow-run-unfinished",
        phaseIndex: 1,
        phaseName: "cross-project",
        status: "running",
        attempt: 1,
        logicalExecutionId: "logical-workflow-phase",
        input: { value: 1 },
        executionId: "execution-other-project",
        startedAt: "2026-07-26T00:00:00.000Z",
      }),
    ).rejects.toThrow("does not belong to its run project and session");
    await expect(
      first.operational.workflows.putPhase({
        runId: "workflow-run-unfinished",
        phaseIndex: 1,
        phaseName: "missing-project",
        status: "running",
        attempt: 1,
        logicalExecutionId: "logical-workflow-phase",
        input: { value: 1 },
        executionId: "execution-without-project",
        startedAt: "2026-07-26T00:00:00.000Z",
      }),
    ).rejects.toThrow("does not belong to its run project and session");
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
    ).rejects.toThrow("does not belong to its run project and session");
    const lineageDatabase = new DatabaseSync(first.unsafeDatabasePathForTesting);
    expect(() =>
      lineageDatabase
        .prepare(`INSERT INTO codemode_executions(
          execution_id, logical_execution_id, parent_execution_id, session_id, project_id,
          catalog_id, catalog_digest, source_digest, source_artifact_id, status, call_count, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          "execution-cross-project-child-sql",
          "logical-cross-project-child-sql",
          "execution-workflow-unfinished",
          "session-workflow",
          "project-other",
          "catalog-test",
          digest("c"),
          sha256(text("return input;")),
          workflowSource.artifactId,
          "running",
          0,
          "2026-07-26T00:00:00.000Z",
        ),
    ).toThrow("parent does not belong to its project");
    expect(() =>
      lineageDatabase
        .prepare(`INSERT INTO workflow_phase_runs(
          run_id, phase_index, phase_name, status, input_json, attempt,
          logical_execution_id, execution_id, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          "workflow-run-unfinished",
          1,
          "cross-project-sql",
          "running",
          '{"value":1}',
          1,
          "logical-workflow-phase",
          "execution-other-project",
          "2026-07-26T00:00:00.000Z",
        ),
    ).toThrow("does not belong to its run project");
    expect(() =>
      lineageDatabase
        .prepare(`INSERT INTO workflow_phase_runs(
          run_id, phase_index, phase_name, status, input_json, attempt, logical_execution_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run("workflow-run-unfinished", 1, "invalid-pending-identity", "pending", "{}", 0, "logical-pending"),
    ).toThrow("status and logical execution identity do not match");
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
        .prepare("UPDATE workflow_runs SET project_id = ? WHERE run_id = ?")
        .run("project-other", "workflow-run-unfinished"),
    ).toThrow("project is immutable");
    expect(() =>
      lineageDatabase
        .prepare("UPDATE workflow_runs SET workflow_name = ? WHERE run_id = ?")
        .run("retargeted", "workflow-run-unfinished"),
    ).toThrow("Program identity is immutable");
    expect(() =>
      lineageDatabase
        .prepare("UPDATE workflow_runs SET workflow_revision = ? WHERE run_id = ?")
        .run(2, "workflow-run-unfinished"),
    ).toThrow("Program identity is immutable");
    expect(() =>
      lineageDatabase
        .prepare("UPDATE workflow_runs SET definition_revision_id = ? WHERE run_id = ?")
        .run("definition-other", "workflow-run-unfinished"),
    ).toThrow("Program identity is immutable");
    expect(() =>
      lineageDatabase
        .prepare("UPDATE workflow_phase_runs SET run_id = ? WHERE run_id = ? AND phase_index = 0")
        .run("other-run", "workflow-run-unfinished"),
    ).toThrow("lineage is immutable");
    expect(() =>
      lineageDatabase
        .prepare("UPDATE workflow_phase_runs SET phase_index = ? WHERE run_id = ? AND phase_index = 0")
        .run(2, "workflow-run-unfinished"),
    ).toThrow("lineage is immutable");
    expect(() =>
      lineageDatabase
        .prepare("UPDATE workflow_phase_runs SET phase_name = ? WHERE run_id = ? AND phase_index = 0")
        .run("renamed", "workflow-run-unfinished"),
    ).toThrow("lineage is immutable");
    expect(() =>
      lineageDatabase
        .prepare("UPDATE workflow_phase_runs SET execution_id = ? WHERE run_id = ? AND phase_index = 0")
        .run("execution-other-session", "workflow-run-unfinished"),
    ).toThrow("Workflow phase run and execution lineage is immutable");
    expect(() =>
      decodeModelCall({
        model_call_id: "model-call-inverted-context",
        parent_execution_id: "execution-inverted-context",
        session_id: "session-inverted-context",
        turn_id: null,
        context_artifact_id: null,
        request_artifact_id: "artifact-request",
        output_artifact_id: null,
        provider: "controlled",
        model: "controlled",
        thinking_level: "off",
        context_refs_json: '[{"__noesisContext":{"documentId":"context-document","start":2,"end":1}}]',
        status: "failed",
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        estimated_cost: null,
        latency_ms: null,
        error: "invalid context",
        started_at: "2026-07-26T00:00:00.000Z",
        completed_at: "2026-07-26T00:00:01.000Z",
      }),
    ).toThrow(/Context range end must not precede start/iu);
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
        "project-workflow",
        "2026-07-26T00:02:00.000Z",
      ),
    ).resolves.toBeUndefined();
    await expect(
      recovered.operational.workflows.claimPausedRun(
        "workflow-run-unfinished",
        "session-workflow",
        "project-other",
        "2026-07-26T00:02:00.000Z",
      ),
    ).resolves.toBeUndefined();
    await expect(
      recovered.operational.workflows.claimPausedRun(
        "workflow-run-unfinished",
        "session-workflow",
        "project-workflow",
        "2026-07-26T00:02:00.000Z",
      ),
    ).resolves.toMatchObject({ status: "running" });
    await expect(
      recovered.operational.workflows.claimPausedRun(
        "workflow-run-unfinished",
        "session-workflow",
        "project-workflow",
        "2026-07-26T00:02:00.000Z",
      ),
    ).resolves.toBeUndefined();
    await recovered.operational.workflows.putPhase({
      runId: "workflow-run-unfinished",
      phaseIndex: 0,
      phaseName: "recover",
      status: "running",
      attempt: 2,
      logicalExecutionId: "logical-workflow-phase-corrected",
      input: { value: 2 },
      startedAt: "2026-07-26T00:02:00.000Z",
    });
    await recovered.operational.codeExecutions.put({
      executionId: "execution-workflow-retry",
      logicalExecutionId: "logical-workflow-phase-corrected",
      sessionId: "session-workflow",
      projectId: "project-workflow",
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
      logicalExecutionId: "logical-workflow-phase-corrected",
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
        logicalExecutionId: "logical-workflow-phase-corrected",
        executionId: "execution-workflow-retry",
      },
    ]);
    const retryDatabase = new DatabaseSync(recovered.unsafeDatabasePathForTesting);
    expect(() =>
      retryDatabase
        .prepare(`UPDATE workflow_phase_runs
           SET logical_execution_id = NULL
           WHERE run_id = ? AND phase_index = 0`)
        .run("workflow-run-unfinished"),
    ).toThrow("status and logical execution identity do not match");
    expect(() =>
      retryDatabase
        .prepare(`UPDATE workflow_phase_runs
           SET logical_execution_id = ?
           WHERE run_id = ? AND phase_index = 0`)
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
      .map((row) => row["version"]);
    database.close();
    expect(versions).toEqual(Array.from({ length: versions.length }, (_, index) => index + 1));
    expect(versions.at(-1)).toBeGreaterThanOrEqual(9);
  });
  test("migration 54 removes activations and keeps admitted turns referenced by their plans", async () => {
    const root = await temporary("remove-activations");
    const { database } = await seedWorkspaceThroughMigration(root, 53);
    const at = "2026-07-26T00:00:00.000Z";
    database
      .prepare(`INSERT INTO sessions(
          session_id, title, status, provider, model, runtime, created_at, updated_at, metadata_json
        ) VALUES (?, ?, 'idle', 'controlled', 'controlled', 'pi', ?, ?, '{}')`)
      .run("session-legacy", "Legacy", at, at);
    database
      .prepare(`INSERT INTO activations(
          activation_id, revision, previous_activation_id, definitions_json,
          capability_revisions_json, preflight_id, created_at
        ) VALUES ('activation_genesis', 1, NULL, '{}', '{}', NULL, ?)`)
      .run(at);
    database
      .prepare(`INSERT INTO activation_state(state_id, activation_id, revision, updated_at)
          VALUES ('current', 'activation_genesis', 1, ?)`)
      .run(at);
    database
      .prepare(`INSERT INTO frozen_turn_plans(
          plan_id, session_id, turn_id, schema_version, activation_id, activation_revision,
          plan_json, canonical_digest, created_at
        ) VALUES ('plan-legacy', 'session-legacy', 'turn-legacy', 1, 'activation_genesis', 1, '{}', ?, ?)`)
      .run(digest("b"), at);
    database
      .prepare(`INSERT INTO foreground_turns(
          turn_id, session_id, plan_id, status, outcome_id, admitted_at, settled_at
        ) VALUES ('turn-legacy', 'session-legacy', 'plan-legacy', 'running', NULL, ?, NULL)`)
      .run(at);
    database
      .prepare(`INSERT INTO turn_activation_pins(
          turn_key, session_id, turn_id, activation_id, activation_revision,
          definitions_json, capability_revisions_json, pinned_at
        ) VALUES ('pin-legacy', 'session-legacy', 'turn-legacy', 'activation_genesis', 1, '{}', '{}', ?)`)
      .run(at);
    database
      .prepare(`INSERT INTO compounding_replay_budgets(
          budget_id, maximum_calls, maximum_tokens, maximum_cost, created_at
        ) VALUES ('budget-legacy', 1, 1, 1, ?)`)
      .run(at);
    database
      .prepare(`INSERT INTO compounding_replay_runs(replay_id, plan_id, budget_id, status, created_at)
          VALUES ('replay-legacy', 'plan-legacy', 'budget-legacy', 'running', ?)`)
      .run(at);
    database
      .prepare(`INSERT INTO agent_messages(
          message_id, project_id, sender_kind, sender_id, recipient_kind, recipient_id,
          content, sensitivity, status, sequence, task_id, created_at
        ) VALUES ('message-legacy', 'project', 'foreground', 'session-legacy', 'foreground', 'session-legacy',
          'hello', 'normal', 'accepted', 1, NULL, ?)`)
      .run(at);
    database.close();

    const store = await createWorkspaceStore(root);
    store.close();
    const upgraded = new DatabaseSync(join(root, "database", "noesis.sqlite"), { readOnly: true });
    expect(upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
      version: 58,
    });
    expect(upgraded.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      upgraded
        .prepare("SELECT name FROM pragma_table_info('frozen_turn_plans') ORDER BY cid")
        .all()
        .map((row) => row["name"]),
    ).toEqual([
      "plan_id",
      "session_id",
      "turn_id",
      "schema_version",
      "plan_json",
      "canonical_digest",
      "created_at",
    ]);
    expect(upgraded.prepare("SELECT plan_id, turn_id FROM frozen_turn_plans").all()).toEqual([
      { plan_id: "plan-legacy", turn_id: "turn-legacy" },
    ]);
    expect(upgraded.prepare("SELECT turn_id, plan_id FROM foreground_turns").all()).toEqual([
      { turn_id: "turn-legacy", plan_id: "plan-legacy" },
    ]);
    expect(upgraded.prepare("SELECT COUNT(*) AS count FROM agent_messages").get()).toEqual({ count: 0 });
    expect(
      upgraded
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND (
            name LIKE 'activation%' OR name IN (
              'turn_activation_pins', 'outcome_activation_publications', 'experiment_observations',
              'experiment_outcomes', 'experiment_research_runs', 'successor_lineage_inputs'
            ))`)
        .all(),
    ).toEqual([]);
    upgraded.close();
  });
  test("migration 55 removes research state and strips retired reflection payload fields", async () => {
    const root = await temporary("remove-research");
    const { database } = await seedWorkspaceThroughMigration(root, 54);
    const at = "2026-07-26T00:00:00.000Z";
    const insertJob = database.prepare(`INSERT INTO jobs(
        job_id, kind, payload_json, status, attempt, budget_remaining, created_at, updated_at,
        operation_id, idempotency_key, not_before
      ) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`);
    const job = (jobId: string, kind: string, payload: JsonValue, status: string): void => {
      insertJob.run(
        jobId,
        kind,
        JSON.stringify(payload),
        status,
        at,
        at,
        `operation:${jobId}`,
        `idempotency:${jobId}`,
        at,
      );
    };
    const turn = {
      sessionId: "session-1",
      turnId: "turn-1",
      servedWorkingAdjustmentOutcomes: [],
      expectedActiveAdjustmentId: null,
      scope: "global",
    };
    job("reflection-pending", "runtime.reflect_capability", { schemaVersion: 1, turn }, "scheduled");
    job("reflection-done", "runtime.reflect_capability", { schemaVersion: 1, turn }, "completed");
    job(
      "review-pending",
      "runtime.review_session",
      { schemaVersion: 1, sessionId: "session-1" },
      "scheduled",
    );
    job("legacy-reflection", "runtime.reflect_turn", {}, "completed");
    job("legacy-author", "runtime.author_revision", { experimentId: "experiment-1" }, "scheduled");
    database
      .prepare("INSERT INTO job_lineage(child_job_id, parent_job_id, linked_at) VALUES (?, ?, ?)")
      .run("legacy-author", "legacy-reflection", at);
    database
      .prepare(`INSERT INTO experiments(experiment_id, status, data_json, created_at, updated_at)
          VALUES ('experiment-1', 'completed', '{}', ?, ?)`)
      .run(at, at);
    database
      .prepare(`INSERT INTO search_documents(
          document_id, source_kind, source_table, source_id, source_field, session_id, sensitivity,
          occurred_at, body, citation_json
        ) VALUES ('document-experiment', 'database_row', 'experiments', 'experiment-1', 'data_json',
          NULL, 'normal', ?, 'experiment body', '{}')`)
      .run(at);
    database
      .prepare("INSERT INTO search_fts(document_id, body) VALUES ('document-experiment', 'experiment body')")
      .run();
    database.close();

    const store = await createWorkspaceStore(root);
    expect((await store.jobs.get("reflection-done"))?.payload).toEqual({
      schemaVersion: 1,
      turn: { sessionId: "session-1", turnId: "turn-1", scope: "global" },
    });
    // Migration 56 then removes unfinished reflections and reviews with the Capability reset.
    expect(await store.jobs.get("reflection-pending")).toBeUndefined();
    expect(await store.jobs.get("review-pending")).toBeUndefined();
    expect(await store.jobs.get("legacy-reflection")).toBeUndefined();
    expect(await store.jobs.get("legacy-author")).toBeUndefined();
    store.close();
    const upgraded = new DatabaseSync(join(root, "database", "noesis.sqlite"), { readOnly: true });
    expect(upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
      version: 58,
    });
    expect(upgraded.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      upgraded
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
            'experiments', 'experiment_trials', 'preflight_plans', 'preflight_reports', 'evaluations',
            'feedback_signals', 'compounding_replay_budgets', 'compounding_replay_runs',
            'compounding_replay_operations', 'working_adjustments', 'active_project_adjustments',
            'capability_learning_cutovers', 'capability_learning_cutover_failures',
            'staged_definitions', 'job_lineage', 'job_observations'
          )`)
        .all(),
    ).toEqual([]);
    expect(upgraded.prepare("SELECT COUNT(*) AS count FROM search_documents").get()).toEqual({ count: 0 });
    expect(upgraded.prepare("SELECT COUNT(*) AS count FROM search_fts").get()).toEqual({ count: 0 });
    upgraded.close();
  });
  test("migration 56 resets Capabilities, unfinished learning jobs, and subagent history", async () => {
    const root = await temporary("capability-files-only");
    const { database } = await seedWorkspaceThroughMigration(root, 55);
    const at = "2026-07-26T00:00:00.000Z";
    const reference = JSON.stringify({
      kind: "capability_revision",
      capabilityId: "capability-old",
      capabilityRevisionId: "revision-old",
      bundleDigest: digest("c"),
    });
    database
      .prepare("INSERT INTO capabilities(capability_id, definition_json, created_at) VALUES (?, '{}', ?)")
      .run("capability-old", at);
    database
      .prepare(`INSERT INTO capability_revisions(
          capability_revision_id, capability_id, predecessor_revision_id, revision_json, created_at
        ) VALUES ('revision-old', 'capability-old', NULL, '{}', ?)`)
      .run(at);
    database
      .prepare(`INSERT INTO capability_bindings(
          capability_id, revision_json, scope_json, activation_mode, state, binding_revision, updated_at
        ) VALUES ('capability-old', ?, '{"kind":"global"}', 'relevant', 'active', 1, ?)`)
      .run(reference, at);
    database
      .prepare(`INSERT INTO capability_feedback(
          feedback_id, capability_id, revision_json, feedback_json, created_at
        ) VALUES ('feedback-old', 'capability-old', ?, '{}', ?)`)
      .run(reference, at);
    database
      .prepare(`INSERT INTO capability_gate_requests(
          gate_request_id, capability_id, revision_json, request_json, status, created_at, settled_at
        ) VALUES ('gate-old', 'capability-old', ?, '{}', 'pending', ?, NULL)`)
      .run(reference, at);
    database
      .prepare(`INSERT INTO capability_outcomes(
          outcome_id, capability_id, capability_revision_id, session_id, turn_id, result, reason,
          evidence_json, created_at
        ) VALUES ('outcome-old', 'capability-old', 'revision-old', 'session-1', 'turn-1', 'helped', 'ok', '[]', ?)`)
      .run(at);
    const insertJob = database.prepare(`INSERT INTO jobs(
        job_id, kind, payload_json, status, attempt, budget_remaining, created_at, updated_at,
        operation_id, idempotency_key, not_before
      ) VALUES (?, ?, '{}', ?, 0, 0, ?, ?, ?, ?, ?)`);
    for (const [jobId, kind, status] of [
      ["reflection-pending", "runtime.reflect_capability", "scheduled"],
      ["reflection-done", "runtime.reflect_capability", "completed"],
      ["review-pending", "runtime.review_session", "scheduled"],
      ["review-done", "runtime.review_session", "completed"],
    ] as const)
      insertJob.run(jobId, kind, status, at, at, `operation:${jobId}`, `idempotency:${jobId}`, at);
    database
      .prepare(`INSERT INTO sessions(
          session_id, title, status, provider, model, runtime, created_at, updated_at, metadata_json
        ) VALUES ('session-1', 'Old', 'idle', 'controlled', 'controlled', 'pi', ?, ?, '{}')`)
      .run(at, at);
    database
      .prepare(`INSERT INTO frozen_turn_plans(
          plan_id, session_id, turn_id, schema_version, plan_json, canonical_digest, created_at
        ) VALUES ('plan-old', 'session-1', 'turn-1', 1, '{}', ?, ?)`)
      .run(digest("b"), at);
    database
      .prepare(`INSERT INTO foreground_turns(
          turn_id, session_id, plan_id, status, outcome_id, admitted_at, settled_at
        ) VALUES ('turn-1', 'session-1', 'plan-old', 'completed', NULL, ?, ?)`)
      .run(at, at);
    database
      .prepare(`INSERT INTO agent_messages(
          message_id, project_id, sender_kind, sender_id, recipient_kind, recipient_id,
          content, sensitivity, status, sequence, task_id, created_at
        ) VALUES ('message-old', 'project', 'foreground', 'session-1', 'foreground', 'session-1',
          'hello', 'normal', 'accepted', 1, NULL, ?)`)
      .run(at);
    database.close();

    const store = await createWorkspaceStore(root);
    expect(await store.jobs.get("reflection-pending")).toBeUndefined();
    expect(await store.jobs.get("review-pending")).toBeUndefined();
    expect(await store.jobs.get("reflection-done")).toBeDefined();
    expect(await store.jobs.get("review-done")).toBeDefined();
    store.close();
    const upgraded = new DatabaseSync(join(root, "database", "noesis.sqlite"));
    expect(upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
      version: 58,
    });
    expect(upgraded.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    for (const table of [
      "capabilities",
      "capability_revisions",
      "capability_bindings",
      "capability_feedback",
      "capability_gate_requests",
      "capability_outcomes",
      "agent_messages",
    ])
      expect(upgraded.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    expect(upgraded.prepare("SELECT plan_id, schema_version FROM frozen_turn_plans").all()).toEqual([
      { plan_id: "plan-old", schema_version: 1 },
    ]);
    // Capability revisions stay immutable after the reset.
    upgraded
      .prepare("INSERT INTO capabilities(capability_id, definition_json, created_at) VALUES (?, '{}', ?)")
      .run("capability-new", at);
    upgraded
      .prepare(`INSERT INTO capability_revisions(
          capability_revision_id, capability_id, predecessor_revision_id, revision_json, created_at
        ) VALUES ('revision-new', 'capability-new', NULL, '{}', ?)`)
      .run(at);
    expect(() =>
      upgraded
        .prepare("DELETE FROM capability_revisions WHERE capability_revision_id = 'revision-new'")
        .run(),
    ).toThrow(/immutable/u);
    expect(() =>
      upgraded
        .prepare(
          "UPDATE capability_revisions SET revision_json = '[]' WHERE capability_revision_id = 'revision-new'",
        )
        .run(),
    ).toThrow(/immutable/u);
    upgraded.close();
  });
  test("migration 57 drops legacy import records and keeps authority operations", async () => {
    const root = await temporary("remove-legacy-import");
    const { database } = await seedWorkspaceThroughMigration(root, 56);
    const at = "2026-07-26T00:00:00.000Z";
    database
      .prepare(`INSERT INTO import_runs(source_id, source_root, source_digest, imported_at, report_json)
        VALUES ('source', '/old', ?, ?, '{}')`)
      .run(digest("a"), at);
    database
      .prepare(`INSERT INTO operational_cutovers(cutover_name, cutover_version, source_digest, completed_at)
        VALUES ('workspace-operational-authority', 1, ?, ?)`)
      .run(digest("a"), at);
    database
      .prepare(`INSERT INTO authority_grants(
          grant_id, principal, effects_json, resource_prefixes_json, expires_at, max_uses, max_cost,
          issued_at, source_event_id
        ) VALUES ('grant-old', 'scheduler', '["execute"]', '["job:"]', '2027-01-01T00:00:00.000Z', 2, 2, ?,
          'event-grant')`)
      .run(at);
    database
      .prepare(`INSERT INTO authority_operations(
          operation_id, idempotency_key, operation_fingerprint, principal, effect, resource,
          request_digest, estimated_cost, grant_id, status, result_json, failure, receipt_lineage_id,
          source_event_id, created_at, updated_at
        ) VALUES ('operation-old', 'key-old', ?, 'scheduler', 'execute', 'job:old', ?, 1, 'grant-old',
          'completed', '"done"', NULL, 'receipt-old', 'event-operation', ?, ?)`)
      .run(digest("b"), digest("c"), at, at);
    database.close();

    const store = await createWorkspaceStore(root);
    store.close();
    const upgraded = new DatabaseSync(join(root, "database", "noesis.sqlite"), { readOnly: true });
    expect(upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
      version: 58,
    });
    expect(upgraded.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      upgraded
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('import_runs', 'operational_cutovers')",
        )
        .all(),
    ).toEqual([]);
    for (const table of ["authority_grants", "authority_operations"])
      expect(
        upgraded
          .prepare(`SELECT name FROM pragma_table_info('${table}') WHERE name = 'source_event_id'`)
          .all(),
      ).toEqual([]);
    expect(upgraded.prepare("SELECT grant_id, max_uses FROM authority_grants").all()).toEqual([
      { grant_id: "grant-old", max_uses: 2 },
    ]);
    expect(
      upgraded
        .prepare("SELECT operation_id, grant_id, status, receipt_lineage_id FROM authority_operations")
        .all(),
    ).toEqual([
      {
        operation_id: "operation-old",
        grant_id: "grant-old",
        status: "completed",
        receipt_lineage_id: "receipt-old",
      },
    ]);
    expect(
      upgraded
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'authority_operations_grant'",
        )
        .all(),
    ).toEqual([{ name: "authority_operations_grant" }]);
    upgraded.close();
  });
  test("migration 58 rewrites imported exchanges as self-describing replay history", async () => {
    const root = await temporary("imported-history");
    const { database } = await seedWorkspaceThroughMigration(root, 57);
    const at = (second: number): string => `2026-07-26T00:00:0${String(second)}.000Z`;
    database
      .prepare(`INSERT INTO sessions(
          session_id, title, status, provider, model, runtime, created_at, updated_at, metadata_json
        ) VALUES ('session-imported', 'Imported', 'idle', 'controlled', 'controlled', 'pi', ?, ?, '{}')`)
      .run(at(0), at(0));
    const outcome = database.prepare(`INSERT INTO outcomes(
        outcome_id, session_id, turn_id, status, summary, created_at, metadata_json
      ) VALUES (?, 'session-imported', ?, ?, '', ?, ?)`);
    outcome.run("evt-done:outcome", "evt-done", "unknown", at(2), '{"legacyEventId":"evt-done"}');
    outcome.run("evt-failed:outcome", "evt-failed", "failed", at(4), '{"legacyEventId":"evt-failed"}');
    const message = database.prepare(`INSERT INTO messages(
        message_id, session_id, role, content, created_at, metadata_json
      ) VALUES (?, 'session-imported', ?, ?, ?, ?)`);
    message.run("m-user", "user", "hello", at(1), '{"legacyEventId":"evt-done"}');
    message.run("m-assistant", "assistant", "hi", at(2), '{"legacyEventId":"evt-done"}');
    message.run("m-failed", "user", "broken", at(3), '{"legacyEventId":"evt-failed"}');
    message.run("m-modern", "user", "later", at(5), '{"turnId":"turn-modern"}');
    database.close();

    const store = await createWorkspaceStore(root);
    store.close();
    const upgraded = new DatabaseSync(join(root, "database", "noesis.sqlite"), { readOnly: true });
    const rows = upgraded
      .prepare("SELECT message_id, metadata_json FROM messages ORDER BY created_at")
      .all()
      .map((row) => ({ id: row["message_id"], metadata: JSON.parse(String(row["metadata_json"])) }));
    upgraded.close();
    const inherited = (messageId: string, historySequence: number) => ({
      replayEligible: true,
      historyKind: "turn",
      historyTurnKey: "session-imported:evt-done",
      historySequence,
      inheritedFromSessionId: "session-imported",
      inheritedFromMessageId: messageId,
    });
    expect(rows).toEqual([
      { id: "m-user", metadata: inherited("m-user", 0) },
      { id: "m-assistant", metadata: inherited("m-assistant", 1) },
      { id: "m-failed", metadata: { legacyEventId: "evt-failed" } },
      { id: "m-modern", metadata: { turnId: "turn-modern" } },
    ]);
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
      .map((row) => row["version"]);
    const ownerTable = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_owner'")
      .get();
    const lineageTrigger = database
      .prepare(`SELECT name, sql
         FROM sqlite_master
         WHERE type = 'trigger' AND name = 'codemode_execution_lineage_immutable'`)
      .get();
    const phaseLineageTrigger = database
      .prepare(`SELECT name
         FROM sqlite_master
         WHERE type = 'trigger' AND name = 'workflow_phase_lineage_immutable'`)
      .get();
    const sequenceTrigger = database
      .prepare(`SELECT name
         FROM sqlite_master
         WHERE type = 'trigger' AND name = 'tool_call_action_sequence_required'`)
      .get();
    const jobListIndex = database
      .prepare(`SELECT name FROM sqlite_master
         WHERE type = 'index' AND name = 'jobs_created_status_kind'`)
      .get();
    const toolCallTurnPlan = database
      .prepare(`EXPLAIN QUERY PLAN
         SELECT * FROM tool_calls
         WHERE session_id = ? AND turn_id = ?
         ORDER BY action_sequence, tool_call_id`)
      .all("session-null-sequence", "turn-null-sequence")
      .map((row) => String(row["detail"]));
    database
      .prepare(`INSERT INTO sessions(
          session_id, title, status, provider, model, runtime, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
        .prepare(`INSERT INTO tool_calls(
            tool_call_id, session_id, tool_name, request_json, status, sensitivity, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          "action-null-sequence",
          "session-null-sequence",
          "capabilities.inspect",
          "{}",
          "requested",
          "normal",
          "2026-07-26T00:00:00.000Z",
        ),
    ).toThrow(/action sequence is required/iu);
    database.close();
    expect(versions.at(-1)).toBe(58);
    expect(ownerTable).toBeDefined();
    expect(lineageTrigger).toMatchObject({
      name: "codemode_execution_lineage_immutable",
      sql: expect.stringContaining("source_digest"),
    });
    expect(phaseLineageTrigger).toBeDefined();
    expect(sequenceTrigger).toBeDefined();
    expect(jobListIndex).toBeDefined();
    expect(toolCallTurnPlan.some((detail) => detail.includes("tool_calls_turn_created"))).toBe(true);
  });
  test("upgrades a version-24 workspace with planner-usable job scan indexes", async () => {
    const root = await temporary("jobs-keyset-migration");
    await mkdir(join(root, "database"), { recursive: true });
    const seed = new DatabaseSync(join(root, "database", "noesis.sqlite"));
    const migrationNames = (await readdir(new URL("../migrations/", import.meta.url)))
      .filter((name) => /^\d{3}_.+\.sql$/u.test(name))
      .sort()
      .filter((name) => Number(name.slice(0, 3)) <= 24);
    for (const name of migrationNames) {
      const version = Number(name.slice(0, 3));
      seed.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      seed
        .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
        .run(version, name, "2026-07-26T00:00:00.000Z");
    }
    expect(
      seed.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'jobs_created'").get(),
    ).toBeUndefined();
    seed.close();
    const upgraded = await createWorkspaceStore(root);
    upgraded.close();
    const database = new DatabaseSync(join(root, "database", "noesis.sqlite"), { readOnly: true });
    const indexes = database
      .prepare(`SELECT name FROM sqlite_master
         WHERE type = 'index' AND name IN (
           'jobs_created_status_kind',
           'jobs_experiment_created',
           'job_lineage_parent_child',
           'job_observations_session_child',
           'job_observations_parent_child'
         ) ORDER BY name`)
      .all();
    const keysetPlan = database
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM jobs ORDER BY created_at, job_id LIMIT 100")
      .all()
      .map((row) => String(row["detail"]));
    const runtimeScanPlan = database
      .prepare(`EXPLAIN QUERY PLAN
         SELECT * FROM jobs INDEXED BY jobs_created_status_kind
         WHERE status IN (?, ?) AND kind IN (?, ?)
         ORDER BY created_at, job_id LIMIT 100`)
      .all("scheduled", "running", "runtime.reflect_capability", "runtime.review_session")
      .map((row) => String(row["detail"]));
    database.close();
    expect(indexes).toEqual([{ name: "jobs_created_status_kind" }]);
    expect(keysetPlan.some((detail) => detail.includes("jobs_created"))).toBe(true);
    expect(runtimeScanPlan.some((detail) => detail.includes("jobs_created_status_kind"))).toBe(true);
    expect(runtimeScanPlan.some((detail) => detail.includes("USE TEMP B-TREE"))).toBe(false);
  });
  test("reports exact-limit terminal job pages as exhausted without exceeding the page limit", async () => {
    const store = await createWorkspaceStore(await temporary("job-page-lookahead"));
    const enqueue = async (jobId: string, createdAt: string): Promise<void> => {
      await store.jobs.enqueue({
        jobId,
        kind: "fixture.job",
        payload: Object.freeze({}),
        payloadRefs: Object.freeze([]),
        operationId: `operation:${jobId}`,
        idempotencyKey: `idempotency:${jobId}`,
        notBefore: createdAt,
        maxAttempts: 1,
        estimatedCost: 0,
        budget: 0,
      });
    };
    await enqueue("job-a", "2026-07-26T00:00:00.000Z");
    await enqueue("job-b", "2026-07-26T00:00:01.000Z");
    const exactTerminal = await store.jobs.listPage({ kind: "fixture.job", limit: 2 });
    expect(exactTerminal.records.map(({ jobId }) => jobId)).toEqual(["job-a", "job-b"]);
    expect(exactTerminal.exhausted).toBe(true);
    await enqueue("job-c", "2026-07-26T00:00:02.000Z");
    const first = await store.jobs.listPage({ kind: "fixture.job", limit: 2 });
    expect(first.records.map(({ jobId }) => jobId)).toEqual(["job-a", "job-b"]);
    expect(first.exhausted).toBe(false);
    expect(first.nextCursor).toBeDefined();
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const final = await store.jobs.listPage(
      createConditionalObject({
        kind: "fixture.job",
        limit: 2,
      } as const)
        .addOptional(first.nextCursor ? { after: first.nextCursor } : undefined)
        .finish(),
    );
    expect(final.records.map(({ jobId }) => jobId)).toEqual(["job-c"]);
    expect(final.exhausted).toBe(true);
    const newest = await store.jobs.listPage({ kind: "fixture.job", order: "newest", limit: 2 });
    expect(newest.records.map(({ jobId }) => jobId)).toEqual(["job-c", "job-b"]);
    expect(newest.exhausted).toBe(false);
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const older = await store.jobs.listPage(
      createConditionalObject({
        kind: "fixture.job",
        order: "newest",
        limit: 2,
      } as const)
        .addOptional(newest.nextCursor ? { after: newest.nextCursor } : undefined)
        .finish(),
    );
    expect(older.records.map(({ jobId }) => jobId)).toEqual(["job-a"]);
    expect(older.exhausted).toBe(true);
    store.close();
  });
  test("uses the project expression index for newest reflection scans", async () => {
    const root = await temporary("job-project-index");
    const store = await createWorkspaceStore(root);
    await store.jobs.enqueue({
      jobId: "project-reflection-indexed",
      kind: "runtime.reflect_turn",
      payload: Object.freeze({
        turn: Object.freeze({
          project: Object.freeze({ projectId: "project-indexed", root: "/workspace/indexed" }),
          sessionId: "session-indexed",
          turnId: "turn-indexed",
          sensitivity: "normal",
        }),
      }),
      payloadRefs: Object.freeze([]),
      operationId: "operation:project-reflection-indexed",
      idempotencyKey: "idempotency:project-reflection-indexed",
      notBefore: "2026-07-26T00:00:00.000Z",
      maxAttempts: 1,
      estimatedCost: 0,
      budget: 0,
    });
    store.close();
    const database = new DatabaseSync(join(root, "database", "noesis.sqlite"), { readOnly: true });
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN SELECT * FROM jobs
         WHERE kind = ? AND json_extract(payload_json, '$.turn.project.projectId') = ?
         ORDER BY created_at DESC, job_id DESC LIMIT ?`)
      .all("runtime.reflect_turn", "project-indexed", 1)
      .map((row) => String(row["detail"]));
    expect(plan.join("\n")).toContain("jobs_reflection_project_created");
    database.close();
  });
  test("keeps a running job visible when it becomes scheduled between active-stream pages", async () => {
    const store = await createWorkspaceStore(await temporary("job-active-status-transition"));
    const start = Date.parse("2026-07-26T00:00:00.000Z");
    for (let index = 0; index < 1000; index += 1) {
      const jobId = `active-filler-${String(index).padStart(4, "0")}`;
      await store.jobs.enqueue({
        jobId,
        kind: "test.bulk_job",
        payload: Object.freeze({}),
        payloadRefs: Object.freeze([]),
        operationId: `operation:${jobId}`,
        idempotencyKey: `idempotency:${jobId}`,
        notBefore: new Date(start + index).toISOString(),
        maxAttempts: 1,
        estimatedCost: 0,
        budget: 0,
      });
    }
    await store.jobs.enqueue({
      jobId: "active-transition-target",
      kind: "test.transition_job",
      payload: Object.freeze({}),
      payloadRefs: Object.freeze([]),
      operationId: "operation:active-transition-target",
      idempotencyKey: "idempotency:active-transition-target",
      notBefore: new Date(start + 2000).toISOString(),
      maxAttempts: 2,
      estimatedCost: 1,
      budget: 2,
    });
    const claimed = await store.jobs.claim({
      workerId: "status-transition-worker",
      now: new Date(start + 3000).toISOString(),
      leaseUntil: new Date(start + 4000).toISOString(),
      maximumCost: 1,
      kinds: ["test.transition_job"],
    });
    if (!claimed?.leaseToken) throw new Error("Expected transition target lease");
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const filter = {
      statuses: ["scheduled", "running"] as const,
      kinds: ["test.bulk_job", "test.transition_job"] as const,
      limit: 1000,
    };
    const first = await store.jobs.listPage(filter);
    expect(first.exhausted).toBe(false);
    expect(first.records).toHaveLength(1000);
    await store.jobs.fail({
      jobId: claimed.jobId,
      leaseToken: claimed.leaseToken,
      now: new Date(start + 3500).toISOString(),
      retryAt: new Date(start + 5000).toISOString(),
      failure: { code: "retry", message: "retry", retryable: true, ambiguous: false },
    });
    if (!first.nextCursor) throw new Error("Expected active stream cursor");
    const second = await store.jobs.listPage({ ...filter, after: first.nextCursor });
    expect(second.records.map(({ jobId }) => jobId)).toEqual(["active-transition-target"]);
    expect(second.exhausted).toBe(true);
    store.close();
  }, 30000);
  test("keeps authority grants, reservations, completions, and replay in SQLite", async () => {
    const root = await temporary("durable-authority");
    const first = await createWorkspaceStore(root);
    await authority(first).schedule("job:durable:schedule", "schedule:durable", async (receipt) => {
      await authority(first).issueSchedulerGrant(
        "durable",
        2,
        new Date(Date.now() + 60000).toISOString(),
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
        .prepare(`SELECT status, receipt_lineage_id FROM authority_operations
           WHERE principal = 'scheduler' AND effect = 'execute'`)
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
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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
  test("records a foreground collaboration reminder atomically with its mailbox delivery", async () => {
    const store = await createWorkspaceStore(await temporary("foreground-reminder"));
    await store.operational.sessions.put(session("session-reminder"));
    seedForegroundTurn(store, {
      turnId: "turn-reminder",
      sessionId: "session-reminder",
      status: "running",
      admittedAt: "2026-01-01T00:00:00.000Z",
    });
    const append = async (messageId: string, kind: "message" | "completion") =>
      await store.operational.subAgents.appendMessage({
        messageId,
        projectId: "project-reminder",
        sender: { kind: "foreground", id: "session-sender" },
        recipient: { kind: "foreground", id: "session-reminder" },
        kind,
        content: `content ${messageId}`,
        sensitivity: "normal",
        status: "accepted",
        createdAt: "2026-01-01T00:00:01.000Z",
      });
    const claim = async (messageId: string) => {
      const current = await store.operational.subAgents.getMessage(messageId);
      if (!current) throw new Error(`Missing ${messageId}`);
      await store.operational.subAgents.putMessage({
        ...current,
        status: "claimed",
        claimedAt: "2026-01-01T00:00:02.000Z",
      });
    };
    await expect(append("message-report", "message")).resolves.toMatchObject({ kind: "message" });
    await expect(append("message-notice", "completion")).resolves.toMatchObject({ kind: "completion" });
    const request = {
      sessionId: "session-reminder",
      turnId: "turn-reminder",
      messageIds: ["message-report", "message-notice"],
      content: "<system-reminder>\nreport\n</system-reminder>",
      timelineSequence: 3,
      deliveredAt: "2026-01-01T00:00:03.000Z",
    } as const;
    await claim("message-report");
    // An unclaimed message rolls back the whole delivery, including the session message.
    await expect(store.operational.subAgents.recordForegroundReminder(request)).rejects.toThrow(
      /message-notice is not claimed/u,
    );
    expect(await store.operational.messages.listForSession("session-reminder")).toEqual([]);
    await claim("message-notice");
    await expect(store.operational.subAgents.recordForegroundReminder(request)).resolves.toMatchObject({
      messageId: "turn-reminder:collaboration:message-report",
      role: "user",
      metadata: {
        turnId: "turn-reminder",
        deliveryMode: "steer",
        origin: "collaboration",
        mailboxMessageIds: ["message-report", "message-notice"],
      },
    });
    expect(await store.operational.messages.listForSession("session-reminder")).toMatchObject([
      { content: request.content, timelineSequence: 3 },
    ]);
    for (const messageId of request.messageIds)
      expect(await store.operational.subAgents.getMessage(messageId)).toMatchObject({
        status: "delivered",
        deliveredAt: request.deliveredAt,
      });
    seedForegroundTurn(store, {
      turnId: "turn-settled",
      sessionId: "session-reminder",
      status: "completed",
      admittedAt: "2026-01-01T00:00:00.000Z",
      settledAt: "2026-01-01T00:00:04.000Z",
    });
    await expect(
      store.operational.subAgents.recordForegroundReminder({ ...request, turnId: "turn-settled" }),
    ).rejects.toThrow(/is not running/u);
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
  test("atomically reroutes pending intents across sessions while retaining source provenance", async () => {
    const root = await temporary("reroute-user-intents");
    const store = await createWorkspaceStore(root);
    await store.operational.sessions.put(session("session-reroute-source"));
    await store.operational.sessions.put(session("session-reroute-destination"));
    await store.operational.userIntents.enqueue({
      intentId: "intent-reroute-first",
      sessionId: "session-reroute-source",
      text: "first",
      createdAt: "2026-01-01T00:01:00.000Z",
    });
    await store.operational.userIntents.enqueue({
      intentId: "intent-reroute-second",
      sessionId: "session-reroute-source",
      text: "second",
      createdAt: "2026-01-01T00:02:00.000Z",
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const request = {
      sourceSessionId: "session-reroute-source",
      destinationSessionId: "session-reroute-destination",
      intents: [
        { sourceIntentId: "intent-reroute-first", destinationIntentId: "intent-rerouted-first" },
        { sourceIntentId: "intent-reroute-second", destinationIntentId: "intent-rerouted-second" },
      ],
      reroutedAt: "2026-01-01T00:03:00.000Z",
    } as const;
    await expect(store.operational.userIntents.reroutePending(request)).resolves.toMatchObject([
      { intentId: "intent-rerouted-first", text: "first", status: "pending", queueSequence: 1 },
      { intentId: "intent-rerouted-second", text: "second", status: "pending", queueSequence: 2 },
    ]);
    await expect(store.operational.userIntents.reroutePending(request)).resolves.toMatchObject([
      { intentId: "intent-rerouted-first", text: "first", status: "pending" },
      { intentId: "intent-rerouted-second", text: "second", status: "pending" },
    ]);
    expect(await store.operational.userIntents.listPending("session-reroute-source")).toEqual([]);
    const database = new DatabaseSync(join(root, "database", "noesis.sqlite"), { readOnly: true });
    expect(
      database
        .prepare(`SELECT intent_id, status, withdrawn_at
           FROM user_intents
           WHERE session_id = ?
           ORDER BY queue_sequence`)
        .all("session-reroute-source"),
    ).toEqual([
      {
        intent_id: "intent-reroute-first",
        status: "withdrawn",
        withdrawn_at: "2026-01-01T00:03:00.000Z",
      },
      {
        intent_id: "intent-reroute-second",
        status: "withdrawn",
        withdrawn_at: "2026-01-01T00:03:00.000Z",
      },
    ]);
    database.close();
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
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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
        .prepare(`SELECT activity_kind
           FROM activity_log
           WHERE subject_kind = 'user_intent' AND subject_id = ?
           ORDER BY rowid`)
        .all("intent-atomic-steer"),
    ).toEqual([
      { activity_kind: "user_intent.enqueued" },
      { activity_kind: "user_intent.promoted_to_steer" },
    ]);
    database.close();
    store.close();
  });
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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
      .prepare(`UPDATE foreground_turns
         SET status = 'completed', settled_at = ?
         WHERE turn_id = ? AND status = 'running'`)
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
    await expect(store.operational.userIntents.listDispatching("session-held-steers")).resolves.toMatchObject(
      [{ intentId: "intent-explicit-held", deliveryMode: "steer", status: "dispatching" }],
    );
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
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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
  test("atomically transfers attachment-only steering refs into the canonical message", async () => {
    const store = await createWorkspaceStore(await temporary("attachment-steering"));
    await store.operational.sessions.put(session("attachment-steering"));
    seedForegroundTurn(store, {
      turnId: "attachment-turn",
      sessionId: "attachment-steering",
      status: "running",
      admittedAt: "2026-01-01T00:00:00.000Z",
    });
    const artifact = await store.artifacts.writeArtifact({
      path: "composer/steer.txt",
      mediaType: "text/plain",
      bytes: text("steered bytes"),
      actor,
      relationshipRefs: [],
    });
    const attachments = [{ name: "steer.txt", mimeType: "text/plain", artifact }];
    const request = {
      intentId: "attachment-intent",
      sessionId: "attachment-steering",
      targetTurnId: "attachment-turn",
      text: "",
      attachments,
      createdAt: "2026-01-01T00:01:00.000Z",
      promotedAt: "2026-01-01T00:02:00.000Z",
    };
    const queued = await store.operational.userIntents.enqueueAndPromoteToSteer(request);
    expect(queued?.attachments).toEqual(attachments);
    await expect(
      store.operational.userIntents.enqueueAndPromoteToSteer({
        ...request,
        attachments: [{ ...attachments[0], name: "changed.txt", mimeType: "text/plain", artifact }],
      }),
    ).rejects.toThrow(/different identity/);
    const delivery = {
      intentId: request.intentId,
      sessionId: request.sessionId,
      targetTurnId: request.targetTurnId,
      text: "",
      sensitivity: "normal" as const,
      timelineSequence: 1,
      deliveredAt: "2026-01-01T00:03:00.000Z",
    };
    await expect(store.operational.userIntents.recordSteerDelivery(delivery)).rejects.toThrow(/digest/);
    const delivered = await store.operational.userIntents.recordSteerDelivery({ ...delivery, attachments });
    expect(delivered).toMatchObject({ status: "delivered", attachments: [] });
    expect(delivered?.text).toBeUndefined();
    expect(await store.operational.messages.get("attachment-turn:steer:attachment-intent")).toMatchObject({
      content: "",
      metadata: { attachments },
    });
    await expect(
      store.operational.userIntents.recordSteerDelivery({ ...delivery, attachments }),
    ).resolves.toMatchObject({ status: "delivered" });
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
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test("recovers dispatching user intents from durable message provenance", async () => {
    const store = await createWorkspaceStore(await temporary("user-intent-recovery"));
    await store.operational.sessions.put(session("session-recovery"));
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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
  test("imports an existing file as an authoritative artifact", async () => {
    const workspaceRoot = await temporary("artifact-import-workspace");
    const sourceRoot = await temporary("artifact-import-source");
    const sourcePath = join(sourceRoot, "shell-output.log");
    const content = `${"large output\n".repeat(10000)}tail`;
    await writeFile(sourcePath, content, "utf8");
    const store = await createWorkspaceStore(workspaceRoot);
    const request = {
      path: "tool-output/shell-output.log",
      mediaType: "text/plain",
      sourcePath,
      actor,
      relationshipRefs: Object.freeze([]),
    } as const;
    const artifact = await store.artifacts.importArtifact(request);
    await expect(store.artifacts.importArtifact(request)).resolves.toEqual(artifact);
    expect(Buffer.from(await store.reads.readArtifact(artifact)).toString()).toBe(content);
    store.close();
  });
  test("concurrent artifact imports cannot replace different bytes", async () => {
    const workspaceRoot = await temporary("artifact-import-race-workspace");
    const sourceRoot = await temporary("artifact-import-race-source");
    const firstSource = join(sourceRoot, "first.log");
    const secondSource = join(sourceRoot, "second.log");
    const firstContent = `first:${"a".repeat(1024 * 1024)}`;
    const secondContent = `second:${"b".repeat(1024 * 1024)}`;
    await Promise.all([
      writeFile(firstSource, firstContent, "utf8"),
      writeFile(secondSource, secondContent, "utf8"),
    ]);
    const store = await createWorkspaceStore(workspaceRoot);
    const request = (sourcePath: string) => ({
      path: "tool-output/concurrent.log",
      mediaType: "text/plain",
      sourcePath,
      actor,
      relationshipRefs: Object.freeze([]),
    });

    const settled = await Promise.allSettled([
      store.artifacts.importArtifact(request(firstSource)),
      store.artifacts.importArtifact(request(secondSource)),
    ]);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]?.reason)).toContain("different bytes");
    const artifact = fulfilled[0]?.value;
    if (!artifact) throw new Error("Expected one successful concurrent artifact import");
    const stored = Buffer.from(await store.reads.readArtifact(artifact)).toString();
    expect([firstContent, secondContent]).toContain(stored);
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
    await expect(
      store.artifacts.writeArtifact({
        path: "reports/result.txt",
        mediaType: "text/plain",
        bytes: text("artifact bytes"),
        actor,
        relationshipRefs: [revisionRef],
      }),
    ).resolves.toEqual(artifact);
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
  test("rejects partial model usage and workflow context pins while decoding", () => {
    expect(() =>
      decodeModelCall({
        model_call_id: "model-call-partial-usage",
        parent_execution_id: "execution-partial-usage",
        session_id: "session-partial-usage",
        turn_id: null,
        context_artifact_id: null,
        request_artifact_id: "artifact-request",
        output_artifact_id: null,
        provider: "controlled",
        model: "controlled",
        thinking_level: "off",
        context_refs_json: "[]",
        status: "completed",
        input_tokens: 1,
        output_tokens: null,
        total_tokens: null,
        estimated_cost: null,
        latency_ms: null,
        error: null,
        started_at: "2026-07-26T00:00:00.000Z",
        completed_at: "2026-07-26T00:00:01.000Z",
      }),
    ).toThrow(/partial usage columns/iu);
    expect(() =>
      decodeModelCall({
        model_call_id: "model-call-invalid-context",
        parent_execution_id: "execution-invalid-context",
        session_id: "session-invalid-context",
        turn_id: null,
        context_artifact_id: null,
        request_artifact_id: "artifact-request",
        output_artifact_id: null,
        provider: "controlled",
        model: "controlled",
        thinking_level: "off",
        context_refs_json: '[{"unexpected":true}]',
        status: "completed",
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        estimated_cost: null,
        latency_ms: null,
        error: null,
        started_at: "2026-07-26T00:00:00.000Z",
        completed_at: "2026-07-26T00:00:01.000Z",
      }),
    ).toThrow();
    expect(() =>
      decodeWorkflowRun({
        run_id: "workflow-run-partial-context",
        project_id: "project-partial-context",
        workflow_name: "partial-context",
        workflow_revision: 1,
        definition_revision_id: "definition-partial-context",
        catalog_id: null,
        catalog_digest: null,
        definition_dependencies_digest: null,
        permission_digest: null,
        provider: null,
        model: null,
        thinking_level: null,
        context_artifact_id: "artifact-context",
        context_digest: null,
        context_character_length: null,
        context_byte_length: null,
        session_id: "session-partial-context",
        turn_id: null,
        status: "running",
        current_phase: 0,
        input_json: "{}",
        output_json: null,
        error: null,
        created_at: "2026-07-26T00:00:00.000Z",
        updated_at: "2026-07-26T00:00:00.000Z",
        completed_at: null,
      }),
    ).toThrow(/partial context pin columns/iu);
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
    .prepare(`INSERT INTO foreground_turns(
        turn_id, session_id, plan_id, status, outcome_id, admitted_at, settled_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?)`)
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
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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
function countRows(store: NoesisWorkspaceStore, table: string): number {
  const database = new DatabaseSync(store.unsafeDatabasePathForTesting, { readOnly: true });
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  database.close();
  const value = row && typeof row === "object" ? row["count"] : undefined;
  if (typeof value !== "number") throw new Error(`Could not count ${table}`);
  return value;
}
