import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConditionalObject, sha256, toJsonValue } from "@noesis/domain";
import type { JsonValue } from "@noesis/domain";
import type { AuthorityBoundary, EffectDecision } from "@noesis/policy";
import {
  createToolBroker,
  defineTool,
  type ToolInvocationRecord,
  type ToolInvocationRecorder,
  type ToolInvocationResult,
  type ToolExecutionContext,
} from "@noesis/tools";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type CodeExecutionEvent, type CodeModeRuntime, createCodeModeRuntime } from "../src/index.ts";
const runtimes = new Set<CodeModeRuntime>();
const roots = new Set<string>();
type ControlledAgentPrompt =
  | string
  | Readonly<{
      __noesisContext: Readonly<{ documentId: string; start: number; end: number }>;
    }>
  | readonly (
      | string
      | Readonly<{
          __noesisContext: Readonly<{ documentId: string; start: number; end: number }>;
        }>
    )[];
interface ControlledAgentRunInput {
  readonly prompt: ControlledAgentPrompt;
}
afterEach(async () => {
  await Promise.all([...runtimes].map(async (code) => await code.shutdown()));
  runtimes.clear();
  await Promise.all([...roots].map(async (root) => await rm(root, { recursive: true, force: true })));
  roots.clear();
});
function authority(): Pick<AuthorityBoundary, "runForeground"> {
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  return Object.freeze({
    runForeground: async <T extends JsonValue>(
      request: Parameters<AuthorityBoundary["runForeground"]>[0],
    ): Promise<EffectDecision<T>> =>
      Object.freeze({
        ok: true,
        value: (await request.execute({
          effect: request.effect,
          resource: request.resource,
          operationId: request.operationId,
        })) as T,
        replayed: false,
      }),
  });
}
function runtime(
  options: {
    readonly recorder?: ToolInvocationRecorder;
    readonly beforeDouble?: () => Promise<void>;
    readonly doubleProgress?: JsonValue;
    readonly overrideInvocationResult?: ToolInvocationResult;
    readonly runAgent?: (input: ControlledAgentRunInput) => Promise<string>;
    readonly observeContext?: (context: ToolExecutionContext) => void;
  } = {},
) {
  const runAgent = options.runAgent;
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  const broker = createToolBroker(
    createConditionalObject({
      authority: authority(),
      permission: Object.freeze({
        effects: Object.freeze(["read"]),
        resourcePatterns: Object.freeze(["math:", "model:"]),
        credentialRefs: Object.freeze([]),
      }),
      definitions: [
        defineTool({
          name: "math.double",
          label: "Double",
          description: "Double a number",
          inputSchema: z.strictObject({ value: z.number() }),
          outputSchema: z.strictObject({ value: z.number() }),
          effect: () => ({ effect: "read", resource: "math:double", estimatedCost: 0 }),
          execute: async ({ value }, context) => {
            options.observeContext?.(context);
            await options.beforeDouble?.();
            if (options.doubleProgress !== undefined) context.emitUpdate?.(options.doubleProgress);
            return { value: value * 2 };
          },
        }),
        ...(runAgent
          ? [
              defineTool({
                name: "agents.spawn",
                label: "Spawn subagent",
                description: "Controlled subagent spawn",
                inputSchema: z.strictObject({
                  prompt: z.union([
                    z.string(),
                    z.strictObject({
                      __noesisContext: z.strictObject({
                        documentId: z.string(),
                        start: z.number().int(),
                        end: z.number().int(),
                      }),
                    }),
                    z.array(
                      z.union([
                        z.string(),
                        z.strictObject({
                          __noesisContext: z.strictObject({
                            documentId: z.string(),
                            start: z.number().int(),
                            end: z.number().int(),
                          }),
                        }),
                      ]),
                    ),
                  ]),
                }),
                outputSchema: z.string(),
                effect: () => ({ effect: "read", resource: "model:query", estimatedCost: 0 }),
                execute: async (input) => await runAgent(input),
              }),
            ]
          : []),
      ],
    } as const)
      .addOptional(options.recorder ? { recorder: options.recorder } : undefined)
      .finish(),
  );
  const overrideInvocationResult = options.overrideInvocationResult;
  const effectiveBroker = overrideInvocationResult
    ? Object.freeze({ ...broker, invoke: async () => overrideInvocationResult })
    : broker;
  const code = createCodeModeRuntime({ cwd: process.cwd(), broker: effectiveBroker });
  runtimes.add(code);
  return code;
}
describe("codemode runtime", () => {
  it("exposes a lazy immutable context view through agents.spawn", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-codemode-context-"));
    roots.add(root);
    const content = '{"type":"message","content":"first"}\n{"type":"message","content":"second"}\n';
    const path = join(root, "context.jsonl");
    await writeFile(path, content);
    const queries: JsonValue[] = [];
    const contentDigest = sha256(content);
    const documentId = `context_document_${contentDigest}`;
    const code = runtime({
      runAgent: async (input) => {
        queries.push(toJsonValue(input));
        return "nested answer";
      },
    });
    const result = await code.execute({
      source: `
        const selected = context.slice(-40);
        return {
          length: context.length,
          selected: await selected.text(),
          answer: await agents.spawn({ prompt: ["Summarize the last entry", selected, "Be concise"] })
        };
      `,
      sessionId: "session-context",
      contextDocument: Object.freeze({
        documentId,
        path,
        characterLength: content.length,
        byteLength: Buffer.byteLength(content, "utf8"),
        contentDigest,
      }),
    });
    expect(result.value).toEqual({
      length: content.length,
      selected: content.slice(-40),
      answer: "nested answer",
    });
    expect(queries).toEqual([
      {
        prompt: [
          "Summarize the last entry",
          {
            __noesisContext: {
              documentId,
              start: content.length - 40,
              end: content.length,
            },
          },
          "Be concise",
        ],
      },
    ]);
  });
  it("runs ordinary JavaScript and composes sequential and parallel SDK calls", async () => {
    const events: CodeExecutionEvent[] = [];
    const result = await runtime().execute(
      {
        source: `
          const first = await tools.math.double({ value: 4 });
          const pair = await Promise.all([
            noesis.invoke("math.double", { value: first.value }),
            tools.math.double({ value: 3 })
          ]);
          return { first, pair };
        `,
        sessionId: "session-1",
      },
      (event) => events.push(event),
    );
    expect(result.value).toEqual({
      first: { value: 8 },
      pair: [{ value: 16 }, { value: 6 }],
    });
    expect(result.calls).toBe(3);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool-start",
        executionId: result.executionId,
        name: "math.double",
        callIndex: 1,
        input: { value: 4 },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool-end",
        executionId: result.executionId,
        name: "math.double",
        callIndex: 1,
        ok: true,
        result: { value: 8 },
      }),
    );
    const firstStart = events.find(
      (
        event,
      ): event is Extract<
        CodeExecutionEvent,
        {
          readonly type: "tool-start";
        }
      > => event.type === "tool-start" && event.callIndex === 1,
    );
    const firstEnd = events.find(
      (
        event,
      ): event is Extract<
        CodeExecutionEvent,
        {
          readonly type: "tool-end";
        }
      > => event.type === "tool-end" && event.callIndex === 1,
    );
    expect(firstStart?.callId).toMatch(/^tool_call_[a-f0-9]{64}$/u);
    expect(firstEnd?.callId).toBe(firstStart?.callId);
  });

  it("does not impose a production SDK-call ceiling", async () => {
    const result = await runtime().execute({
      source: `
        let total = 0;
        for (let index = 0; index < 130; index += 1) {
          total += (await tools.math.double({ value: 1 })).value;
        }
        return total;
      `,
      sessionId: "session-many-calls",
    });

    expect(result.value).toBe(260);
    expect(result.calls).toBe(130);
  });
  it("returns the final top-level expression only in last-expression mode", async () => {
    const code = runtime();
    await expect(
      code.execute({
        source: `
          const seed = 4;
          await tools.math.double({ value: seed }); // returned by REPL completion
        `,
        completionMode: "last-expression",
        sessionId: "session-last-expression",
      }),
    ).resolves.toMatchObject({ value: { value: 8 }, calls: 1 });
    await expect(
      code.execute({
        source: "const value = 3; ({ value });",
        completionMode: "last-expression",
        sessionId: "session-last-expression",
      }),
    ).resolves.toMatchObject({ value: { value: 3 } });
    await expect(
      code.execute({
        source: "return 42;",
        completionMode: "last-expression",
        sessionId: "session-last-expression",
      }),
    ).resolves.toMatchObject({ value: 42 });
    await expect(
      code.execute({
        source: "return new.target ?? null;",
        completionMode: "last-expression",
        sessionId: "session-last-expression",
      }),
    ).resolves.toMatchObject({ value: null });
    await expect(
      code.execute({
        source: "const value = 3; value;",
        sessionId: "session-explicit-completion",
      }),
    ).resolves.toMatchObject({ value: null });
    await expect(
      code.execute({
        source: "if (true) { 42; }",
        completionMode: "last-expression",
        sessionId: "session-last-expression",
      }),
    ).resolves.toMatchObject({ value: null });
  });
  it("returns actionable frozen-catalog recovery for an unknown tool name", async () => {
    await expect(
      runtime().execute({
        source: 'return await noesis.invoke("math.multiply", { value: 4 });',
        sessionId: "session-unknown-tool",
      }),
    ).rejects.toThrow(
      "Unknown tool: math.multiply. Discover the frozen catalog with noesis.search(query), then inspect an exact contract with noesis.describe(name).",
    );
  });
  it("allows local SDK shadowing without changing completion or session storage", async () => {
    const code = runtime();
    for (const completionMode of ["explicit", "last-expression"] as const) {
      const result = await code.execute({
        source: `
          store("saved", await tools.math.double({ value: 3 }));
          const noesis = "local";
          { const tools = "nested"; if (tools !== "nested") throw new Error("scope"); }
          ${completionMode === "explicit" ? "return" : ""} ({ noesis, stored: load("saved"), target: new.target ?? null });
        `,
        completionMode,
        sessionId: "shadowing",
      });
      expect(result.value).toEqual({ noesis: "local", stored: { value: 6 }, target: null });
    }
    await expect(
      code.execute({ source: 'return load("saved");', sessionId: "shadowing" }),
    ).resolves.toMatchObject({ value: { value: 6 } });
    await expect(
      code.execute({ source: "const tools = 42; return tools;", sessionId: "shadowing" }),
    ).resolves.toMatchObject({ value: 42 });
  });
  it("enumerates only frozen catalog tools without discovery calls", async () => {
    const result = await runtime().execute({
      source: `return {
        families: Object.keys(tools), operations: Object.keys(tools.math),
        missing: tools.missing === undefined && tools.math.missing === undefined,
        inherited: tools.toString === undefined && tools.math.constructor === undefined,
        doubled: await tools.math.double({ value: 7 }),
      };`,
      sessionId: "catalog-enumeration",
    });
    expect(result.value).toEqual({
      families: ["math"],
      operations: ["double"],
      missing: true,
      inherited: true,
      doubled: { value: 14 },
    });
    expect(result.calls).toBe(1);
  });
  it("drains stdout and stderr alongside the returned value", async () => {
    const result = await runtime().execute({
      source: 'console.log("x".repeat(100_000)); console.error("warning"); return 42;',
      sessionId: "console-output",
    });
    expect(result).toMatchObject({
      value: 42,
      stdout: `${"x".repeat(100_000)}\n`,
      stderr: "warning\n",
      logsTruncated: false,
    });
    const logged = await runtime().execute({
      source: 'console.log("hello");',
      completionMode: "last-expression",
      sessionId: "console-only",
    });
    expect(logged).toMatchObject({ value: null, stdout: "hello\n" });
    const large = await runtime().execute({
      source: 'console.log("x".repeat(300_000)); return 42;',
      sessionId: "large-console",
    });
    expect(large.value).toBe(42);
    expect(large.logsTruncated).toBe(true);
  });
  it("supports Node imports and progress", async () => {
    const events: JsonValue[] = [];
    const result = await runtime().execute(
      {
        source: `
          const path = await import("node:path");
          emit({ base: path.basename("/tmp/noesis") });
          return { joined: path.join("a", "b") };
        `,
        sessionId: "session-1",
      },
      (event) => {
        if (event.type === "progress") events.push(event.value);
      },
    );
    expect(result.value).toEqual({ joined: "a/b" });
    expect(events).toEqual([{ base: "noesis" }]);
  });
  it("binds Broker progress to the exact nested tool call", async () => {
    const events: CodeExecutionEvent[] = [];
    const result = await runtime({ doubleProgress: { message: "Halfway" } }).execute(
      {
        source: "return await tools.math.double({ value: 4 });",
        sessionId: "session-broker-progress",
      },
      (event) => events.push(event),
    );
    const started = events.find(
      (
        event,
      ): event is Extract<
        CodeExecutionEvent,
        {
          readonly type: "tool-start";
        }
      > => event.type === "tool-start",
    );
    if (!started) throw new Error("Expected nested tool start");
    expect(events).toContainEqual({
      type: "progress",
      executionId: result.executionId,
      value: { message: "Halfway" },
      callId: started.callId,
      name: "math.double",
      callIndex: started.callIndex,
    });
  });
  it("passes only successfully awaited SDK calls as causal predecessors", async () => {
    const contexts: ToolExecutionContext[] = [];
    const code = runtime({ observeContext: (context) => contexts.push(context) });
    await code.execute({
      source: "await tools.math.double({ value: 2 }); await tools.math.double({ value: 3 }); return null;",
      sessionId: "session-causal-calls",
    });
    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.causallyPriorCallIds).toEqual([]);
    expect(contexts[1]?.causallyPriorCallIds).toEqual([contexts[0]?.callId]);

    contexts.splice(0);
    await code.execute({
      source:
        "await Promise.all([tools.math.double({ value: 4 }), tools.math.double({ value: 5 })]); return null;",
      sessionId: "session-causal-calls",
    });
    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.causallyPriorCallIds).toEqual([]);
    expect(contexts[1]?.causallyPriorCallIds).toEqual([]);

    contexts.splice(0);
    await code.execute({
      source:
        "void tools.math.double({ value: 6 }); await tools.math.double({ value: 7 }); await tools.math.double({ value: 8 }); return null;",
      sessionId: "session-causal-calls",
    });
    expect(contexts).toHaveLength(3);
    expect(contexts[2]?.causallyPriorCallIds).toEqual([contexts[1]?.callId]);
  });
  it("persists store values across executions in the same session only", async () => {
    const code = runtime();
    await code.execute({
      source: 'store("topic", { name: "Noesis" }); return null;',
      sessionId: "session-1",
    });
    await expect(
      code.execute({
        source: 'return load("topic");',
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ value: { name: "Noesis" } });
    await expect(
      code.execute({
        source: 'return load("topic") ?? null;',
        sessionId: "session-2",
      }),
    ).resolves.toMatchObject({ value: null });
    await code.shutdown();
  });
  it("merges concurrent store mutations without overwriting unrelated keys", async () => {
    const code = runtime();
    await Promise.all([
      code.execute({
        source: 'await new Promise((resolve) => setTimeout(resolve, 40)); store("first", 1); return null;',
        sessionId: "shared-session",
      }),
      code.execute({
        source: 'await new Promise((resolve) => setTimeout(resolve, 60)); store("second", 2); return null;',
        sessionId: "shared-session",
      }),
    ]);
    await expect(
      code.execute({
        source: 'return { first: load("first"), second: load("second") };',
        sessionId: "shared-session",
      }),
    ).resolves.toMatchObject({ value: { first: 1, second: 2 } });
  });
  it("derives stable host call identities from a logical execution across retries", async () => {
    const requestedCallIds: string[] = [];
    const code = runtime({
      recorder: Object.freeze({
        record: async (record: ToolInvocationRecord) => {
          if (record.status === "requested") requestedCallIds.push(record.callId);
        },
      }),
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const request = {
      source: "return await tools.math.double({ value: 4 });",
      logicalExecutionId: "workflow-phase-logical-1",
      sessionId: "session-1",
    } as const;
    await code.execute({ ...request, executionId: "physical-attempt-1" });
    await code.execute({ ...request, executionId: "physical-attempt-2" });
    expect(requestedCallIds).toHaveLength(2);
    expect(requestedCallIds[0]).toBe(requestedCallIds[1]);
    await code.shutdown();
  });
  it("waits for unawaited SDK effects before recording execution completion", async () => {
    let effectCompleted = false;
    const code = runtime({
      beforeDouble: async () => {
        await new Promise<void>((resolve) =>
          setTimeout(() => {
            effectCompleted = true;
            resolve();
          }, 25),
        );
      },
    });
    const result = await code.execute({
      source: "void tools.math.double({ value: 4 }); return { returned: true };",
      sessionId: "session-1",
    });
    expect(result.value).toEqual({ returned: true });
    expect(result.calls).toBe(1);
    expect(effectCompleted).toBe(true);
    await code.shutdown();
  });
  it("cancels an active cell and shuts down cleanly", async () => {
    const controller = new AbortController();
    const pending = runtime().execute({
      source: "await new Promise((resolve) => setTimeout(resolve, 10_000)); return null;",
      sessionId: "session-1",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });
  it("does not hang shutdown when a broker call ignores cancellation", async () => {
    let markToolStarted: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    const code = runtime({
      beforeDouble: async () => {
        markToolStarted?.();
        await new Promise<never>(() => undefined);
      },
    });
    const pending = code.execute({
      executionId: "ignored-cancellation",
      source: "void tools.math.double({ value: 4 }); return null;",
      sessionId: "session-1",
    });
    await toolStarted;
    await expect(code.shutdown()).resolves.toBeUndefined();
    await expect(pending).rejects.toThrow("cancelled");
  });
  it("times out after the cell returns while an unawaited broker call is still settling", async () => {
    let markToolStarted: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    const code = runtime({
      beforeDouble: async () => {
        markToolStarted?.();
        await new Promise<never>(() => undefined);
      },
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const outcome = code
      .execute({
        source: "void tools.math.double({ value: 4 }); return null;",
        sessionId: "session-timeout-during-settlement",
        timeoutMs: 1000,
      })
      .then(
        (value) => ({ ok: true, value }) as const,
        (cause: unknown) => ({ ok: false, error: cause }) as const,
      );
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const firstEvent = await Promise.race([
      toolStarted.then(() => "tool-started" as const),
      outcome.then(() => "execution-settled" as const),
    ]);
    expect(firstEvent).toBe("tool-started");
    const result = await outcome;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected codemode execution to time out");
    expect(result.error).toBeInstanceOf(Error);
    if (!(result.error instanceof Error)) throw new Error("Expected codemode execution to fail");
    expect(result.error.message).toContain("timed out");
  });
  it("does not spawn work for an already-cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runtime().execute({
        source: "return null;",
        sessionId: "session-1",
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
  });
  it("returns large values across the child-process boundary", async () => {
    await expect(
      runtime().execute({
        source: 'return "x".repeat(2 * 1024 * 1024);',
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ value: "x".repeat(2 * 1024 * 1024) });
  });
  it("bounds SDK inputs and failure frames before sending them over IPC", async () => {
    await expect(
      runtime().execute({
        source: 'return await noesis.invoke("math.double", { value: "x".repeat(300 * 1024) });',
        sessionId: "session-1",
      }),
    ).rejects.toThrow("Codemode SDK request exceeds");
    let thrown: unknown;
    try {
      await runtime().execute({
        source: 'throw new Error("x".repeat(2 * 1024 * 1024));',
        sessionId: "session-2",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) throw new Error("Expected codemode execution to fail");
    expect(Buffer.byteLength(thrown.message, "utf8")).toBeLessThanOrEqual(32 * 1024);
  });
  it("does not impose an aggregate IPC ceiling on valid child requests", async () => {
    await expect(
      runtime().execute({
        source: `
          for (let index = 0; index < 45; index += 1) {
            process.send({
              type: "sdk-call",
              requestId: "raw-" + String(index),
              kind: "describe",
              name: "x".repeat(190 * 1024)
            });
          }
          return null;
        `,
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ value: null, calls: 45 });
  });
  it("enforces host-side frame and semantic limits against raw IPC bypasses", async () => {
    await expect(
      runtime().execute({
        source: `
          process.send({
            type: "sdk-call",
            requestId: "oversized-sdk",
            kind: "invoke",
            name: "math.double",
            input: { value: "x".repeat(300 * 1024) }
          });
          return null;
        `,
        sessionId: "raw-sdk",
      }),
    ).rejects.toThrow("Codemode SDK request exceeds");
    await expect(
      runtime().execute({
        source: `
          process.send({ type: "result", value: "x".repeat(2 * 1024 * 1024), storeMutations: [] });
          await new Promise(() => undefined);
        `,
        sessionId: "raw-result",
      }),
    ).resolves.toMatchObject({ value: "x".repeat(2 * 1024 * 1024) });
    await expect(
      runtime().execute({
        source: `
          process.send({ type: "failure", error: "x".repeat(40 * 1024) });
          return null;
        `,
        sessionId: "raw-failure",
      }),
    ).rejects.toThrow("Codemode failure message exceeds");
    await expect(
      runtime().execute({
        source: `
          process.send({ type: "failure", error: "failed", stack: "x".repeat(100 * 1024) });
          return null;
        `,
        sessionId: "raw-stack",
      }),
    ).rejects.toThrow("Codemode failure stack exceeds");
    await expect(
      runtime().execute({
        source: `
          process.send({ type: "progress", value: "x".repeat(65 * 1024) });
          return null;
        `,
        sessionId: "raw-progress",
      }),
    ).resolves.toMatchObject({ value: null });
    await expect(
      runtime().execute({
        source: `
          process.send({ type: "failure", error: "x".repeat(1100 * 1024) });
          return null;
        `,
        sessionId: "raw-frame",
      }),
    ).rejects.toThrow("Codemode IPC frame exceeds");
  });
  it("bounds aggregate store state in the child before returning it", async () => {
    await expect(
      runtime().execute({
        source: `
          for (let index = 0; index < 257; index += 1) store(String(index), index);
          return null;
        `,
        sessionId: "session-1",
      }),
    ).rejects.toThrow("Codemode store exceeds");
  });
  it("drops excess progress without failing productive work", async () => {
    const individualEvents: CodeExecutionEvent[] = [];
    await expect(
      runtime().execute(
        {
          source: 'emit("x".repeat(65 * 1024)); return null;',
          sessionId: "session-1",
        },
        (event) => individualEvents.push(event),
      ),
    ).resolves.toMatchObject({ value: null });
    expect(individualEvents.some((event) => event.type === "progress")).toBe(false);
    const aggregateEvents: CodeExecutionEvent[] = [];
    await expect(
      runtime().execute(
        {
          source: `
            for (let index = 0; index < 5; index += 1) emit("x".repeat(60 * 1024));
            return null;
          `,
          sessionId: "session-2",
        },
        (event) => aggregateEvents.push(event),
      ),
    ).resolves.toMatchObject({ value: null });
    expect(aggregateEvents.filter((event) => event.type === "progress")).toHaveLength(4);
  });
  it("drops excess Broker progress without failing the tool call", async () => {
    const individualEvents: CodeExecutionEvent[] = [];
    await expect(
      runtime({ doubleProgress: "x".repeat(65 * 1024) }).execute(
        {
          source: "return await tools.math.double({ value: 1 });",
          sessionId: "broker-progress-value-limit",
        },
        (event) => individualEvents.push(event),
      ),
    ).resolves.toMatchObject({ value: { value: 2 } });
    expect(individualEvents.some((event) => event.type === "progress")).toBe(false);
    const aggregateEvents: CodeExecutionEvent[] = [];
    await expect(
      runtime({ doubleProgress: "x".repeat(60 * 1024) }).execute(
        {
          source: `
            for (let index = 0; index < 5; index += 1)
              await tools.math.double({ value: index });
            return null;
          `,
          sessionId: "broker-progress-aggregate-limit",
        },
        (event) => aggregateEvents.push(event),
      ),
    ).resolves.toMatchObject({ value: null, calls: 5 });
    expect(aggregateEvents.filter((event) => event.type === "progress")).toHaveLength(4);
  });
  it("bounds Broker failure details before returning them to the child", async () => {
    const events: CodeExecutionEvent[] = [];
    await expect(
      runtime({
        overrideInvocationResult: {
          ok: false,
          code: "failed",
          message: "remote tool failed",
          details: { payload: "x".repeat(20 * 1024 * 1024) },
        },
      }).execute(
        {
          source: "return await tools.math.double({ value: 1 });",
          sessionId: "broker-error-details-limit",
        },
        (event) => events.push(event),
      ),
    ).rejects.toThrow("remote tool failed");
    const failedCall = events.find(
      (
        event,
      ): event is Extract<
        CodeExecutionEvent,
        {
          readonly type: "tool-end";
        }
      > => event.type === "tool-end" && !event.ok,
    );
    expect(failedCall?.error).toContain("remote tool failed");
    expect(Buffer.byteLength(failedCall?.error ?? "", "utf8")).toBeLessThanOrEqual(64 * 1024);
  });
  it("does not leak a child when an event observer throws", async () => {
    const code = runtime();
    await expect(
      code.execute({ executionId: "observer-error", source: "return 42;", sessionId: "session-1" }, () => {
        throw new Error("observer failed");
      }),
    ).resolves.toMatchObject({ value: 42 });
    await expect(
      code.execute({
        executionId: "observer-error",
        source: "return 43;",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({ value: 43 });
    await code.shutdown();
  });
});
