import { type EffectClass, type JsonValue, toJsonValue } from "@noesis/domain";
import { type AuthorityBoundary, type EffectDecision, inspectEffectExecutionFailure } from "@noesis/policy";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createToolBroker,
  defineTool,
  type ToolDefinition,
  type ToolInvocationRecord,
} from "../src/index.ts";

const permission = Object.freeze({
  effects: Object.freeze(["read"]),
  resourcePatterns: Object.freeze(["test:*"]),
  credentialRefs: Object.freeze([]),
});

function receiptFor(request: Parameters<AuthorityBoundary["runForeground"]>[0]) {
  return Object.freeze({
    effect: request.effect,
    resource: request.resource,
    operationId: request.operationId,
  });
}

function foregroundAuthority(): Pick<AuthorityBoundary, "runForeground"> {
  return Object.freeze({
    runForeground: async <T extends JsonValue>(
      request: Parameters<AuthorityBoundary["runForeground"]>[0],
    ): Promise<EffectDecision<T>> => {
      try {
        return Object.freeze({
          ok: true,
          value: (await request.execute(receiptFor(request))) as T,
          replayed: false,
        });
      } catch (error) {
        const executionFailure = inspectEffectExecutionFailure(error);
        return Object.freeze({
          ok: false,
          code: executionFailure?.code ?? ("failed" as const),
          reason: executionFailure?.message ?? (error instanceof Error ? error.message : String(error)),
        });
      }
    },
  });
}

function invocationContext(signal = new AbortController().signal) {
  return Object.freeze({
    executionId: "execution-1",
    sessionId: "session-1",
    signal,
  });
}

function echo(description = "Return the provided value"): ToolDefinition {
  return defineTool({
    name: "test.echo",
    label: "Echo",
    description,
    visibility: "codemode_only",
    inputSchema: z.strictObject({ value: z.string() }),
    outputSchema: z.strictObject({ value: z.string() }),
    effect: () => Object.freeze({ effect: "read", resource: "test:echo", estimatedCost: 0 }),
    execute: async (input) => input,
  });
}

describe("tool broker", () => {
  it("freezes discovery identity and validates calls", async () => {
    const definitions: ToolDefinition[] = [echo()];
    const broker = createToolBroker({ definitions, authority: foregroundAuthority(), permission });
    definitions.push(echo("mutated later"));

    expect(broker.list()).toHaveLength(1);
    expect(broker.search("echo")[0]?.name).toBe("test.echo");
    await expect(broker.invoke("test.echo", { value: "hello" }, invocationContext())).resolves.toMatchObject({
      ok: true,
      value: { value: "hello" },
    });
    await expect(broker.invoke("test.echo", { value: 1 }, invocationContext())).resolves.toMatchObject({
      ok: false,
      code: "invalid_input",
      message: expect.stringContaining('noesis.describe("test.echo")'),
    });
  });

  it("recovers unknown tool names with frozen-catalog suggestions and discovery guidance", async () => {
    const shellRun = defineTool({
      name: "shell.run",
      label: "Run shell command",
      description: "Run a shell command",
      visibility: "codemode_only",
      inputSchema: z.strictObject({ command: z.string() }),
      outputSchema: z.null(),
      effect: () => Object.freeze({ effect: "read", resource: "test:shell", estimatedCost: 0 }),
      execute: async () => null,
    });
    const bareFoo = defineTool({
      name: "foo",
      label: "Foo",
      description: "Exercise nearest-name recovery across dot structure",
      visibility: "codemode_only",
      inputSchema: z.strictObject({}),
      outputSchema: z.null(),
      effect: () => Object.freeze({ effect: "read", resource: "test:foo", estimatedCost: 0 }),
      execute: async () => null,
    });
    const broker = createToolBroker({
      definitions: [echo(), shellRun, bareFoo],
      authority: foregroundAuthority(),
      permission,
    });

    await expect(broker.invoke("shell.rum", { command: "pwd" }, invocationContext())).resolves.toEqual({
      ok: false,
      code: "not_found",
      message:
        "Unknown tool: shell.rum. Did you mean shell.run? Discover the frozen catalog with noesis.search(query), then inspect an exact contract with noesis.describe(name).",
    });

    await expect(broker.invoke("shell/run", { command: "pwd" }, invocationContext())).resolves.toEqual({
      ok: false,
      code: "not_found",
      message:
        "Unknown tool: shell/run. Did you mean shell.run? Discover the frozen catalog with noesis.search(query), then inspect an exact contract with noesis.describe(name).",
    });

    await expect(broker.invoke("Shell.run", { command: "pwd" }, invocationContext())).resolves.toEqual({
      ok: false,
      code: "not_found",
      message:
        "Unknown tool: Shell.run. Did you mean shell.run? Discover the frozen catalog with noesis.search(query), then inspect an exact contract with noesis.describe(name).",
    });

    await expect(broker.invoke("foo.", {}, invocationContext())).resolves.toEqual({
      ok: false,
      code: "not_found",
      message:
        "Unknown tool: foo.. Did you mean foo? Discover the frozen catalog with noesis.search(query), then inspect an exact contract with noesis.describe(name).",
    });

    await expect(
      broker.invoke("shell.completely-unrelated", { command: "pwd" }, invocationContext()),
    ).resolves.toEqual({
      ok: false,
      code: "not_found",
      message:
        "Unknown tool: shell.completely-unrelated. Discover the frozen catalog with noesis.search(query), then inspect an exact contract with noesis.describe(name).",
    });

    const oversizedName = `shell.${"x".repeat(10_000)}`;
    const displayedName = `${oversizedName.slice(0, 128)}… [truncated]`;
    await expect(broker.invoke(oversizedName, {}, invocationContext())).resolves.toEqual({
      ok: false,
      code: "not_found",
      message: `Unknown tool: ${displayedName}. Discover the frozen catalog with noesis.search(query), then inspect an exact contract with noesis.describe(name).`,
    });
  });

  it("gives equal definitions byte-stable revision and catalog identities", () => {
    const first = createToolBroker({
      definitions: [echo()],
      authority: foregroundAuthority(),
      permission,
    });
    const second = createToolBroker({
      definitions: [echo()],
      authority: foregroundAuthority(),
      permission,
    });
    expect(first.catalogDigest).toBe(second.catalogDigest);
    expect(first.describe("test.echo")?.revisionId).toBe(second.describe("test.echo")?.revisionId);
  });

  it("changes catalog identity when executable behavior identity changes", () => {
    const changed = defineTool({
      name: "test.echo",
      label: "Echo",
      description: "Return the provided value",
      visibility: "codemode_only",
      identityMaterial: { adapterRevision: "echo-v2" },
      inputSchema: z.strictObject({ value: z.string() }),
      outputSchema: z.strictObject({ value: z.string() }),
      effect: () => Object.freeze({ effect: "read", resource: "test:echo", estimatedCost: 0 }),
      execute: async ({ value }) => ({ value }),
    });
    const original = createToolBroker({
      definitions: [echo()],
      authority: foregroundAuthority(),
      permission,
    });
    const revised = createToolBroker({
      definitions: [changed],
      authority: foregroundAuthority(),
      permission,
    });

    expect(revised.catalogDigest).not.toBe(original.catalogDigest);
    expect(revised.describe("test.echo")?.implementationDigest).not.toBe(
      original.describe("test.echo")?.implementationDigest,
    );
  });

  it("binds effect idempotency to the stable logical call instead of a physical execution", async () => {
    const idempotencyKeys: string[] = [];
    const broker = createToolBroker({
      definitions: [echo()],
      permission,
      authority: Object.freeze({
        runForeground: async <T extends JsonValue>(
          request: Parameters<AuthorityBoundary["runForeground"]>[0],
        ): Promise<EffectDecision<T>> => {
          idempotencyKeys.push(request.idempotencyKey);
          return Object.freeze({
            ok: true,
            value: (await request.execute(receiptFor(request))) as T,
            replayed: false,
          });
        },
      }),
    });
    const signal = new AbortController().signal;

    await broker.invoke(
      "test.echo",
      { value: "hello" },
      {
        executionId: "physical-1",
        logicalExecutionId: "logical-1",
        callId: "logical-call-1",
        sessionId: "session-1",
        signal,
      },
    );
    await broker.invoke(
      "test.echo",
      { value: "hello" },
      {
        executionId: "physical-2",
        logicalExecutionId: "logical-1",
        callId: "logical-call-1",
        sessionId: "session-1",
        signal,
      },
    );

    expect(idempotencyKeys).toHaveLength(2);
    expect(idempotencyKeys[0]).toBe(idempotencyKeys[1]);
  });

  it("runs input and output transforms exactly once", async () => {
    let inputTransforms = 0;
    let outputTransforms = 0;
    const transformed = defineTool({
      name: "test.transformed",
      label: "Transformed",
      description: "Exercise one validation boundary",
      visibility: "codemode_only",
      inputSchema: z.strictObject({
        value: z.string().transform((value) => {
          inputTransforms += 1;
          return Number(value);
        }),
      }),
      outputSchema: z.strictObject({
        value: z.number().transform((value) => {
          outputTransforms += 1;
          return value + 1;
        }),
      }),
      effect: ({ value }) => ({
        effect: "read",
        resource: `test:${String(value)}`,
        estimatedCost: 0,
      }),
      execute: async ({ value }) => ({ value: value * 2 }),
    });
    const broker = createToolBroker({
      definitions: [transformed],
      authority: foregroundAuthority(),
      permission,
    });

    await expect(
      broker.invoke("test.transformed", { value: "4" }, invocationContext()),
    ).resolves.toMatchObject({ ok: true, value: { value: 9 } });
    expect(inputTransforms).toBe(1);
    expect(outputTransforms).toBe(1);
  });

  it("preserves cancelled and invalid-output failures while accepting large valid results", async () => {
    const controller = new AbortController();
    const records: ToolInvocationRecord[] = [];
    const cancelling = defineTool({
      name: "test.cancel",
      label: "Cancel",
      description: "Cancel while executing",
      visibility: "codemode_only",
      inputSchema: z.strictObject({}),
      outputSchema: z.null(),
      effect: () => ({ effect: "read", resource: "test:cancel", estimatedCost: 0 }),
      execute: async () => {
        controller.abort();
        throw new Error("underlying abort");
      },
    });
    const invalid = defineTool({
      name: "test.invalid",
      label: "Invalid",
      description: "Return invalid output",
      visibility: "codemode_only",
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({ value: z.string() }),
      effect: () => ({ effect: "read", resource: "test:invalid", estimatedCost: 0 }),
      execute: async () => ({ value: 42 as unknown as string }),
    });
    const oversized = defineTool({
      name: "test.oversized",
      label: "Oversized",
      description: "Return oversized output",
      visibility: "codemode_only",
      inputSchema: z.strictObject({}),
      outputSchema: z.string(),
      effect: () => ({ effect: "read", resource: "test:oversized", estimatedCost: 0 }),
      execute: async () => "x".repeat(300 * 1024),
    });
    const broker = createToolBroker({
      definitions: [cancelling, invalid, oversized],
      authority: foregroundAuthority(),
      permission,
      recorder: Object.freeze({
        record: async (record: ToolInvocationRecord) => {
          records.push(record);
        },
      }),
    });

    await expect(
      broker.invoke("test.cancel", {}, invocationContext(controller.signal)),
    ).resolves.toMatchObject({ ok: false, code: "cancelled" });
    await expect(broker.invoke("test.invalid", {}, invocationContext())).resolves.toMatchObject({
      ok: false,
      code: "invalid_output",
    });
    await expect(broker.invoke("test.oversized", {}, invocationContext())).resolves.toMatchObject({
      ok: true,
      value: "x".repeat(300 * 1024),
    });
    expect(
      records.filter((record) => record.toolName === "test.oversized").map((record) => record.status),
    ).toEqual(["requested", "running", "completed"]);
  });

  it("records an effect-derivation exception as a terminal failure", async () => {
    const records: { readonly status: string; readonly error?: string }[] = [];
    const broken = defineTool({
      name: "test.broken-effect",
      label: "Broken effect",
      description: "Throw while deriving an effect",
      visibility: "codemode_only",
      inputSchema: z.strictObject({}),
      outputSchema: z.null(),
      effect: () => {
        throw new Error("cannot derive resource");
      },
      execute: async () => null,
    });
    const broker = createToolBroker({
      definitions: [broken],
      authority: foregroundAuthority(),
      permission,
      recorder: Object.freeze({
        record: async (record: ToolInvocationRecord) => {
          records.push({ status: record.status, ...(record.error ? { error: record.error } : {}) });
        },
      }),
    });

    await expect(broker.invoke("test.broken-effect", {}, invocationContext())).resolves.toMatchObject({
      ok: false,
      code: "failed",
    });
    expect(records.map((record) => record.status)).toEqual(["requested", "running", "failed"]);
    expect(records.at(-1)?.error).toBe("cannot derive resource");
  });

  it("reports non-JSON native parser values at the matching protocol boundary", async () => {
    const invalidInput: ToolDefinition = {
      ...echo(),
      name: "test.invalid-native-input",
      parseInput: () => ({ value: 1n }),
    };
    const invalidOutput: ToolDefinition = {
      ...echo(),
      name: "test.invalid-native-output",
      parseOutput: () => null,
    };
    Reflect.set(invalidOutput, "parseOutput", () => undefined);
    const broker = createToolBroker({
      definitions: [invalidInput, invalidOutput],
      authority: foregroundAuthority(),
      permission,
    });

    await expect(
      broker.invoke("test.invalid-native-input", { value: "ignored" }, invocationContext()),
    ).resolves.toMatchObject({ ok: false, code: "invalid_input" });
    await expect(
      broker.invoke("test.invalid-native-output", { value: "valid" }, invocationContext()),
    ).resolves.toMatchObject({ ok: false, code: "invalid_output" });
  });

  it("snapshots permissions and callable definitions against caller mutation", async () => {
    const effects: EffectClass[] = ["read"];
    const resourcePatterns = ["test:*"];
    const mutablePermission = { effects, resourcePatterns, credentialRefs: [] };
    let observedPermission: Parameters<AuthorityBoundary["runForeground"]>[1] | undefined;
    const authoring = {
      name: "test.captured",
      label: "Captured",
      description: "Capture authoring closures",
      visibility: "codemode_only" as const,
      inputSchema: z.strictObject({ value: z.string() }),
      outputSchema: z.strictObject({ value: z.string() }),
      effect: () => ({ effect: "read" as const, resource: "test:captured", estimatedCost: 0 }),
      execute: async ({ value }: { readonly value: string }) => ({ value }),
    };
    const definition = defineTool(authoring);
    const broker = createToolBroker({
      definitions: [definition],
      permission: mutablePermission,
      authority: Object.freeze({
        runForeground: async <T extends JsonValue>(
          request: Parameters<AuthorityBoundary["runForeground"]>[0],
          receivedPermission: Parameters<AuthorityBoundary["runForeground"]>[1],
        ): Promise<EffectDecision<T>> => {
          observedPermission = receivedPermission;
          return Object.freeze({
            ok: true,
            value: (await request.execute(receiptFor(request))) as T,
            replayed: false,
          });
        },
      }),
    });
    effects.push("write");
    resourcePatterns.splice(0, 1, "*");
    authoring.execute = async ({ value }) => ({ value: `mutated:${value}` });

    await expect(
      broker.invoke("test.captured", { value: "original" }, invocationContext()),
    ).resolves.toMatchObject({ ok: true, value: { value: "original" } });
    expect(observedPermission).toEqual({
      effects: ["read"],
      resourcePatterns: ["test:*"],
      credentialRefs: [],
    });
    expect(Object.isFrozen(observedPermission?.effects)).toBe(true);
    expect(Object.isFrozen(broker.describe("test.captured")?.inputSchema)).toBe(true);
  });

  it("publishes a native JSON Schema without making Zod the catalog authority", () => {
    const nativeInput = Object.freeze({
      type: "object" as const,
      properties: Object.freeze({ query: Object.freeze({ type: "string" as const }) }),
      required: Object.freeze(["query"]),
      additionalProperties: false,
    });
    const definition: ToolDefinition = Object.freeze({
      ...echo(),
      name: "mcp.docs.search",
      catalogInputSchema: nativeInput,
    });
    const broker = createToolBroker({
      definitions: [definition],
      authority: foregroundAuthority(),
      permission,
    });

    expect(broker.describe("mcp.docs.search")?.inputSchema).toEqual(nativeInput);
    expect(Object.isFrozen(broker.describe("mcp.docs.search")?.inputSchema)).toBe(true);
  });

  it("persists large valid results through durable authority without host projection", async () => {
    const persisted: JsonValue[] = [];
    const authority: Pick<AuthorityBoundary, "runForeground"> = Object.freeze({
      runForeground: async <T extends JsonValue>(
        request: Parameters<AuthorityBoundary["runForeground"]>[0],
      ): Promise<EffectDecision<T>> => {
        try {
          const value = (await request.execute(receiptFor(request))) as T;
          persisted.push(value);
          return Object.freeze({ ok: true, value, replayed: false });
        } catch (error) {
          const failure = inspectEffectExecutionFailure(error);
          return Object.freeze({
            ok: false,
            code: failure?.code ?? ("failed" as const),
            reason: failure?.message ?? (error instanceof Error ? error.message : String(error)),
          });
        }
      },
    });
    const resultTool = (name: string, result: string): ToolDefinition =>
      defineTool({
        name,
        label: name,
        description: `Return ${name}`,
        visibility: "codemode_only",
        inputSchema: z.strictObject({}),
        outputSchema: z.string(),
        effect: () => ({ effect: "read", resource: name, estimatedCost: 0 }),
        execute: async () => result,
      });
    const broker = createToolBroker({
      definitions: [
        resultTool("test.unprepared-small", "small"),
        resultTool("test.unprepared-large", "x".repeat(300 * 1024)),
      ],
      authority,
      permission,
    });

    const large = "x".repeat(300 * 1024);
    await expect(broker.invoke("test.unprepared-large", {}, invocationContext())).resolves.toMatchObject({
      ok: true,
      value: large,
    });
    await expect(broker.invoke("test.unprepared-small", {}, invocationContext())).resolves.toMatchObject({
      ok: true,
      value: "small",
    });
    expect(persisted).toEqual([large, "small"]);
  });

  it("settles a valid effect before reporting a protocol-owned tool failure", async () => {
    const details = toJsonValue({
      content: Object.freeze([Object.freeze({ type: "text", text: "remote failure" })]),
      isError: true,
    });
    const definition = defineTool({
      name: "test.reported-failure",
      label: "Reported failure",
      description: "Returns a protocol-valid failure result",
      visibility: "codemode_only",
      inputSchema: z.strictObject({}),
      outputSchema: z.json(),
      effect: () => ({ effect: "read", resource: "test:reported-failure", estimatedCost: 0 }),
      execute: async () => details,
      reportedFailure: (output) => ({ message: "remote tool failed", details: output }),
    });
    const broker = createToolBroker({
      definitions: [definition],
      authority: foregroundAuthority(),
      permission,
    });

    await expect(broker.invoke("test.reported-failure", {}, invocationContext())).resolves.toEqual({
      ok: false,
      code: "failed",
      message: "remote tool failed",
      details,
    });
  });

  it("replays complete large protocol failure details", async () => {
    const original = toJsonValue({
      isError: true,
      content: [{ type: "text", text: "x".repeat(300 * 1024) }],
    });
    let durableResult: JsonValue | undefined;
    let executions = 0;
    const definition = defineTool({
      name: "test.materialized-failure",
      label: "Materialized failure",
      description: "Returns a large protocol failure",
      visibility: "codemode_only",
      inputSchema: z.strictObject({}),
      outputSchema: z.json(),
      effect: () => ({ effect: "read", resource: "test:materialized-failure", estimatedCost: 0 }),
      execute: async () => {
        executions += 1;
        return original;
      },
      reportedFailure: (output) =>
        typeof output === "object" && output !== null && Reflect.get(output, "isError") === true
          ? { message: "remote tool failed", details: output }
          : undefined,
    });
    const authority: Pick<AuthorityBoundary, "runForeground"> = Object.freeze({
      runForeground: async <T extends JsonValue>(
        request: Parameters<AuthorityBoundary["runForeground"]>[0],
      ): Promise<EffectDecision<T>> => {
        if (durableResult !== undefined)
          return Object.freeze({ ok: true, value: durableResult as T, replayed: true });
        durableResult = await request.execute(receiptFor(request));
        return Object.freeze({ ok: true, value: durableResult as T, replayed: false });
      },
    });
    const broker = createToolBroker({
      definitions: [definition],
      authority,
      permission,
    });

    const context = Object.freeze({ ...invocationContext(), callId: "materialized-failure-call" });
    for (let invocation = 0; invocation < 2; invocation += 1)
      await expect(broker.invoke("test.materialized-failure", {}, context)).resolves.toEqual({
        ok: false,
        code: "failed",
        message: "remote tool failed",
        details: original,
      });
    expect(durableResult).toEqual(original);
    expect(executions).toBe(1);
  });
});
