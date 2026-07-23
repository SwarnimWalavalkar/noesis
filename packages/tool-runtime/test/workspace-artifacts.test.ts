import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createDeterministicFakeBackend,
  createGeneratedToolRuntime,
  createWorkspaceToolArtifactSink,
  type GeneratedToolBroker,
  type GeneratedToolDefinition,
} from "../src/index.ts";

const invoke: GeneratedToolBroker["invoke"] = async (call) => ({
  ok: false,
  requestId: call.requestId,
  code: "undeclared",
  reason: "Barrier fixture grants no effects",
});
const broker: GeneratedToolBroker = Object.freeze({ invoke });

describe("Barrier F generated-tool WorkspaceStore integration", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  test("records source, lock, and trace without exposing activation authority", async () => {
    root = await mkdtemp(join(tmpdir(), "noesis-barrier-tool-"));
    const workspace = await createWorkspaceStore(root);
    const artifacts = createWorkspaceToolArtifactSink(workspace);
    const runtime = createGeneratedToolRuntime({
      backend: createDeterministicFakeBackend((input) => ({ input, researched: true })),
      artifacts,
      brokerFor: () => broker,
    });
    const tool: GeneratedToolDefinition = {
      toolId: "research-fixture",
      name: "research_fixture",
      source: "export default async function (input) { return { input, researched: true }; }",
      inputSchemaId: "research-input-v1",
      outputSchemaId: "research-output-v1",
      inputSchema: z.strictObject({ query: z.string() }),
      outputSchema: z.strictObject({
        input: z.strictObject({ query: z.string() }),
        researched: z.literal(true),
      }),
      permissionManifest: { effects: [], resourcePatterns: [], credentialRefs: [] },
      dependencyLock: {
        packageManager: "pnpm",
        dependencies: {},
        lockfile: "lockfileVersion: '9.0'\n",
      },
    };

    const result = await runtime.run({
      runId: "barrier-tool-run",
      tool,
      input: { query: "bounded evidence" },
      principal: "evaluator",
    });
    if (!result.ok) throw new Error(result.reason);
    expect(Buffer.from(await workspace.reads.readArtifact(result.sourceArtifact)).toString()).toBe(
      tool.source,
    );
    expect(
      JSON.parse(Buffer.from(await workspace.reads.readEvidence(result.traceEvidence)).toString()),
    ).toMatchObject({
      runId: "barrier-tool-run",
      toolId: "research-fixture",
      backendTrace: { previewIsolation: "deterministic_fake" },
    });
    expect(Object.keys(artifacts).sort()).toEqual(["recordSource", "recordTrace"]);

    const database = new DatabaseSync(workspace.unsafeDatabasePathForTesting, { readOnly: true });
    expect(count(database, "artifacts")).toBe(2);
    expect(count(database, "file_revisions", "revision_kind = 'evidence'")).toBe(1);
    expect(count(database, "activations")).toBe(0);
    expect(count(database, "activation_pointers")).toBe(0);
    database.close();
    workspace.close();
  });
});

function count(database: DatabaseSync, table: string, where = "1 = 1"): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get();
  const value = row && typeof row === "object" ? Reflect.get(row, "count") : undefined;
  if (typeof value !== "number") throw new Error(`Could not count ${table}`);
  return value;
}
