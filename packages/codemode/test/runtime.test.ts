import type { JsonValue } from "@noesis/domain";
import type { AuthorityBoundary, EffectDecision } from "@noesis/policy";
import {
  createToolBroker,
  defineTool,
  type ToolInvocationRecord,
  type ToolInvocationRecorder,
} from "@noesis/tools";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createCodeModeRuntime, type CodeModeRuntime } from "../src/index.ts";

const runtimes = new Set<CodeModeRuntime>();

afterEach(async () => {
  await Promise.all([...runtimes].map(async (code) => await code.shutdown()));
  runtimes.clear();
});

function authority(): Pick<AuthorityBoundary, "runForeground"> {
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
  options: { readonly recorder?: ToolInvocationRecorder; readonly beforeDouble?: () => Promise<void> } = {},
) {
  const broker = createToolBroker({
    authority: authority(),
    permission: Object.freeze({
      effects: Object.freeze(["read"]),
      resourcePatterns: Object.freeze(["math:"]),
      credentialRefs: Object.freeze([]),
    }),
    definitions: [
      defineTool({
        name: "math.double",
        label: "Double",
        description: "Double a number",
        visibility: "codemode_only",
        inputSchema: z.strictObject({ value: z.number() }),
        outputSchema: z.strictObject({ value: z.number() }),
        effect: () => ({ effect: "read", resource: "math:double", estimatedCost: 0 }),
        execute: async ({ value }) => {
          await options.beforeDouble?.();
          return { value: value * 2 };
        },
      }),
    ],
    ...(options.recorder ? { recorder: options.recorder } : {}),
  });
  const code = createCodeModeRuntime({ cwd: process.cwd(), broker });
  runtimes.add(code);
  return code;
}

describe("codemode runtime", () => {
  it("runs ordinary JavaScript and composes sequential and parallel SDK calls", async () => {
    const result = await runtime().execute({
      source: `
        const first = await tools.math.double({ value: 4 });
        const pair = await Promise.all([
          noesis.invoke("math.double", { value: first.value }),
          tools.math.double({ value: 3 })
        ]);
        return { first, pair };
      `,
      sessionId: "session-1",
    });
    expect(result.value).toEqual({
      first: { value: 8 },
      pair: [{ value: 16 }, { value: 6 }],
    });
    expect(result.calls).toBe(3);
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

  it("derives stable host call identities from a logical execution across retries", async () => {
    const requestedCallIds: string[] = [];
    const code = runtime({
      recorder: Object.freeze({
        record: async (record: ToolInvocationRecord) => {
          if (record.status === "requested") requestedCallIds.push(record.callId);
        },
      }),
    });
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

  it("bounds values before sending them across the child-process boundary", async () => {
    await expect(
      runtime().execute({
        source: 'return "x".repeat(300 * 1024);',
        sessionId: "session-1",
      }),
    ).rejects.toThrow("Codemode result exceeds");
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
