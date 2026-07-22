import { type ArtifactFileRef, type EvidenceRevisionRef, type JsonValue, sha256 } from "@noesis/domain";
import type { EffectDecision, EffectGateway, EffectRequest } from "@noesis/policy";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createDeterministicFakeBackend,
  createEffectGatewayBroker,
  createGeneratedToolRuntime,
  createLocalChildProcessBackend,
  type GeneratedEffectCall,
  type GeneratedToolArtifactSink,
  type GeneratedToolBroker,
  type GeneratedToolDefinition,
} from "../src/index.ts";

const noBrokerInvoke: GeneratedToolBroker["invoke"] = async (call) => ({
  ok: false,
  requestId: call.requestId,
  code: "undeclared",
  reason: "No effects declared for this test",
});
const noBroker: GeneratedToolBroker = Object.freeze({ invoke: noBrokerInvoke });

function createArtifacts(): {
  readonly sink: GeneratedToolArtifactSink;
  readonly sources: Uint8Array[];
  readonly traces: Uint8Array[];
} {
  const sources: Uint8Array[] = [];
  const traces: Uint8Array[] = [];
  const recordSource: GeneratedToolArtifactSink["recordSource"] = async (
    request,
  ): Promise<ArtifactFileRef> => {
    sources.push(request.source);
    return {
      kind: "artifact_file",
      artifactId: `source-${request.runId}`,
      path: `artifacts/${request.runId}/source.mjs`,
      mediaType: "text/javascript",
    };
  };
  const recordTrace: GeneratedToolArtifactSink["recordTrace"] = async (
    request,
  ): Promise<EvidenceRevisionRef<"tool_trace">> => {
    traces.push(request.trace);
    return {
      kind: "evidence_revision",
      revisionId: `trace-${request.runId}`,
      workingPath: `evidence/${request.runId}/trace.json`,
      snapshotPath: `evidence/revisions/${request.runId}/trace.json`,
      contentDigest: sha256(request.trace),
      evidenceKind: "tool_trace",
    };
  };
  const sink: GeneratedToolArtifactSink = Object.freeze({ recordSource, recordTrace });
  return { sink, sources, traces };
}

function tool(
  source: string,
  schemas: {
    readonly input?: z.ZodType;
    readonly output?: z.ZodType;
  } = {},
): GeneratedToolDefinition {
  return {
    toolId: "generated-tool-1",
    name: "generated_tool",
    source,
    inputSchemaId: "schema:input:1",
    outputSchemaId: "schema:output:1",
    inputSchema: schemas.input ?? z.unknown(),
    outputSchema: schemas.output ?? z.unknown(),
    permissionManifest: { effects: [], resourcePatterns: [], credentialRefs: [] },
    dependencyLock: {
      packageManager: "pnpm",
      dependencies: {},
      lockfile: "lockfileVersion: '9.0'\n",
    },
  };
}

function createPermissiveGateway(onRun: () => void): EffectGateway {
  const run = async <T extends JsonValue>(request: EffectRequest<T>): Promise<EffectDecision<T>> => {
    onRun();
    const value = await request.execute({ effect: request.effect, resource: request.resource });
    return { ok: true, value, replayed: false };
  };
  return Object.freeze({ run });
}

async function runLocal(
  source: string,
  input: JsonValue = {},
  options: {
    readonly signal?: AbortSignal;
    readonly maxOutputBytes?: number;
    readonly timeoutMs?: number;
    readonly broker?: GeneratedToolBroker;
    readonly definition?: GeneratedToolDefinition;
  } = {},
) {
  const artifacts = createArtifacts();
  const definition = options.definition ?? tool(source);
  const runtime = createGeneratedToolRuntime({
    backend: createLocalChildProcessBackend(),
    artifacts: artifacts.sink,
    brokerFor: () => options.broker ?? noBroker,
  });
  const result = await runtime.run({
    runId: "run-local",
    tool: definition,
    input,
    principal: "foreground",
    limits: {
      timeoutMs: options.timeoutMs ?? 1_000,
      maxOutputBytes: options.maxOutputBytes ?? 32_768,
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { result, artifacts };
}

describe("local generated-tool research backend", () => {
  test("runs a successful child and records source and trace artifacts", async () => {
    const { result, artifacts } = await runLocal(
      "export default async function (input) { return { value: input.value + 1 }; }",
      { value: 2 },
      {
        definition: tool("export default async function (input) { return { value: input.value + 1 }; }", {
          input: z.strictObject({ value: z.number() }),
          output: z.strictObject({ value: z.number() }),
        }),
      },
    );
    expect(result).toMatchObject({ ok: true, output: { value: 3 } });
    expect(artifacts.sources).toHaveLength(1);
    expect(artifacts.traces).toHaveLength(1);
  });

  test("reports child errors", async () => {
    const { result } = await runLocal(
      'export default async function () { throw new Error("candidate failed"); }',
    );
    expect(result).toMatchObject({ ok: false, code: "child_error", reason: "candidate failed" });
  });

  test("kills a hung child at the time bound", async () => {
    const { result } = await runLocal(
      "export default async function () { await new Promise(() => {}); }",
      {},
      { timeoutMs: 50 },
    );
    expect(result).toMatchObject({ ok: false, code: "timeout" });
  });

  test("kills a child whose stdio exceeds the output bound", async () => {
    const { result } = await runLocal(
      'export default async function () { return { text: "x".repeat(10000) }; }',
      {},
      { maxOutputBytes: 512 },
    );
    expect(result).toMatchObject({ ok: false, code: "output_limit" });
  });

  test("supports cancellation", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const { result } = await runLocal(
      "export default async function () { await new Promise(() => {}); }",
      {},
      { signal: controller.signal },
    );
    expect(result).toMatchObject({ ok: false, code: "cancelled" });
  });

  test("sanitizes the child environment", async () => {
    const { result } = await runLocal(
      "export default async function () { return { keys: Object.keys(process.env).sort() }; }",
      {},
      {
        definition: tool(
          'export default async function () { return { keys: Object.keys(process.env).filter((key) => !key.startsWith("__")).sort() }; }',
          { output: z.strictObject({ keys: z.array(z.string()) }) },
        ),
      },
    );
    expect(result).toMatchObject({
      ok: true,
      output: { keys: ["LANG", "LC_ALL", "NOESIS_GENERATED_TOOL_PREVIEW", "TZ"] },
    });
  });

  test("exposes no authority handles, receipts, credentials, or principal to generated code", async () => {
    const source = `export default async function (input, context) {
      return { contextKeys: Object.keys(context).sort(), inputKeys: Object.keys(input).sort(), env: Object.keys(process.env).sort() };
    }`;
    const { result } = await runLocal(source, { ordinary: true });
    expect(result).toMatchObject({
      ok: true,
      output: {
        contextKeys: ["requestEffect"],
        inputKeys: ["ordinary"],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/grant|receipt|credential|principal/i);
  });

  test("routes a child effect request through the bounded parent broker", async () => {
    let gatewayCalls = 0;
    const broker = createEffectGatewayBroker({
      toolId: "generated-tool-1",
      principal: "foreground",
      manifest: { effects: ["read"], resourcePatterns: ["workspace:"], credentialRefs: [] },
      gateway: createPermissiveGateway(() => {
        gatewayCalls += 1;
      }),
      executor: {
        invoke: async (request) => ({
          output: { observed: request.resource },
          evidenceRefs: ["evidence-child-1"],
        }),
      },
    });
    const source = `export default async function (_input, context) {
      const result = await context.requestEffect({
        requestId: "request-child-1",
        operationId: "operation-child-1",
        idempotencyKey: "effect-child-1",
        effect: "read",
        resource: "workspace:file-a",
        estimatedCost: 0,
        input: { path: "file-a" }
      });
      return result.output;
    }`;
    const definition = {
      ...tool(source, { output: z.strictObject({ observed: z.string() }) }),
      permissionManifest: {
        effects: ["read"],
        resourcePatterns: ["workspace:"],
        credentialRefs: [],
      },
    };
    const { result } = await runLocal(source, {}, { broker, definition });
    expect(result).toMatchObject({ ok: true, output: { observed: "workspace:file-a" } });
    expect(gatewayCalls).toBe(1);
  });
});

describe("generated-tool runtime boundaries", () => {
  test("fails input and output schemas at the parent boundary", async () => {
    let backendCalls = 0;
    const artifacts = createArtifacts();
    const invalidInputRuntime = createGeneratedToolRuntime({
      backend: createDeterministicFakeBackend((input) => {
        backendCalls += 1;
        return input;
      }),
      artifacts: artifacts.sink,
      brokerFor: () => noBroker,
    });
    const invalidInput = await invalidInputRuntime.run({
      runId: "invalid-input",
      tool: tool("export default async function () {}", { input: z.string() }),
      input: 42,
      principal: "foreground",
    });
    expect(invalidInput).toMatchObject({ ok: false, code: "invalid_input" });
    expect(backendCalls).toBe(0);

    const invalidOutput = await invalidInputRuntime.run({
      runId: "invalid-output",
      tool: tool("export default async function () {}", { output: z.string() }),
      input: 42,
      principal: "foreground",
    });
    expect(invalidOutput).toMatchObject({ ok: false, code: "invalid_output" });
    expect(backendCalls).toBe(1);
  });

  test("rejects floating dependency versions", async () => {
    const artifacts = createArtifacts();
    const runtime = createGeneratedToolRuntime({
      backend: createDeterministicFakeBackend(),
      artifacts: artifacts.sink,
      brokerFor: () => noBroker,
    });
    const definition: GeneratedToolDefinition = {
      ...tool("export default async function (input) { return input; }"),
      dependencyLock: {
        packageManager: "pnpm",
        dependencies: { zod: "^4.4.3" },
        lockfile: "lockfileVersion: '9.0'\n",
      },
    };
    const result = await runtime.run({
      runId: "floating-dependency",
      tool: definition,
      input: {},
      principal: "foreground",
    });
    expect(result).toMatchObject({ ok: false, code: "dependency_lock" });
  });

  test("the deterministic fake backend is stable", async () => {
    const artifacts = createArtifacts();
    const runtime = createGeneratedToolRuntime({
      backend: createDeterministicFakeBackend((input) => ({ input, fixed: true })),
      artifacts: artifacts.sink,
      brokerFor: () => noBroker,
    });
    const definition = tool("export default async function () {}", {
      output: z.strictObject({ input: z.unknown(), fixed: z.literal(true) }),
    });
    const first = await runtime.run({
      runId: "fake-1",
      tool: definition,
      input: { value: 1 },
      principal: "evaluator",
    });
    const second = await runtime.run({
      runId: "fake-2",
      tool: definition,
      input: { value: 1 },
      principal: "evaluator",
    });
    expect(first.ok && first.output).toEqual(second.ok && second.output);
  });
});

describe("EffectGateway broker", () => {
  const effectCall = (overrides: Partial<GeneratedEffectCall> = {}): GeneratedEffectCall => ({
    requestId: "request-1",
    operationId: "operation-1",
    idempotencyKey: "effect-key-1",
    effect: "read",
    resource: "workspace:file-a",
    estimatedCost: 0,
    input: { path: "file-a" },
    ...overrides,
  });

  test("mediates a declared child request through EffectGateway", async () => {
    let gatewayCalls = 0;
    let executorCalls = 0;
    const gateway = createPermissiveGateway(() => {
      gatewayCalls += 1;
    });
    const broker = createEffectGatewayBroker({
      toolId: "tool-1",
      principal: "foreground",
      manifest: { effects: ["read"], resourcePatterns: ["workspace:"], credentialRefs: [] },
      gateway,
      executor: {
        invoke: async () => {
          executorCalls += 1;
          return { output: { content: "safe" }, evidenceRefs: ["evidence-1"] };
        },
      },
    });

    await expect(broker.invoke(effectCall())).resolves.toMatchObject({
      ok: true,
      output: { content: "safe" },
      evidenceRefs: ["evidence-1"],
    });
    expect(gatewayCalls).toBe(1);
    expect(executorCalls).toBe(1);
  });

  test("blocks undeclared effects before EffectGateway and identity collisions before replay", async () => {
    let gatewayCalls = 0;
    const gateway = createPermissiveGateway(() => {
      gatewayCalls += 1;
    });
    const broker = createEffectGatewayBroker({
      toolId: "tool-1",
      principal: "foreground",
      manifest: { effects: ["read"], resourcePatterns: ["workspace:"], credentialRefs: [] },
      gateway,
      executor: { invoke: async () => ({ output: null, evidenceRefs: [] }) },
    });

    await expect(broker.invoke(effectCall({ effect: "write" }))).resolves.toMatchObject({
      ok: false,
      code: "undeclared",
    });
    await expect(broker.invoke(effectCall())).resolves.toMatchObject({ ok: true });
    await expect(
      broker.invoke(effectCall({ requestId: "request-2", resource: "workspace:file-b" })),
    ).resolves.toMatchObject({ ok: false, code: "collision" });
    expect(gatewayCalls).toBe(1);
  });
});
