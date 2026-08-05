import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { FrozenTurnPlan } from "@noesis/agent-types";
import type { JsonValue } from "@noesis/domain";
import { z } from "zod";
import type { PiSkillResource } from "./skill-library.ts";

const executeParameters = z.strictObject({
  source: z
    .string()
    .min(1)
    .max(128 * 1024),
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
});
const executeParametersJsonSchema = z.toJSONSchema(executeParameters);
const MAX_SOURCE_BYTES = 128 * 1024;

export type PiCodeExecutionEvent =
  | { readonly type: "started"; readonly executionId: string }
  | { readonly type: "progress"; readonly value: JsonValue }
  | {
      readonly type: "tool-start";
      readonly callId: string;
      readonly name: string;
      readonly callIndex: number;
      readonly input?: JsonValue;
    }
  | {
      readonly type: "tool-end";
      readonly callId: string;
      readonly name: string;
      readonly callIndex: number;
      readonly ok: boolean;
      readonly result?: JsonValue;
      readonly error?: string;
    };

export interface PiFrozenToolCatalog {
  readonly catalogId: string;
  readonly catalogDigest: string;
  readonly tools: readonly {
    readonly name: string;
    readonly label: string;
    readonly description: string;
    readonly revisionId: string;
    readonly inputSchema: JsonValue;
    readonly outputSchema: JsonValue;
  }[];
}

export interface PreparedPiCodeExecution {
  readonly catalog: PiFrozenToolCatalog;
  readonly invoke?: (
    name: string,
    input: JsonValue,
    signal: AbortSignal,
    identity: {
      readonly executionId: string;
      readonly logicalExecutionId: string;
      readonly callId: string;
    },
  ) => Promise<JsonValue>;
  readonly execute: (
    source: string,
    timeoutMs: number | undefined,
    signal: AbortSignal,
    emit: (event: PiCodeExecutionEvent) => void,
    identity?: { readonly logicalExecutionId: string },
  ) => Promise<{
    readonly executionId: string;
    readonly value: JsonValue;
    readonly calls: number;
    readonly durationMs: number;
  }>;
  readonly close: () => Promise<void>;
}

export interface PiCodeExecutionAdapter {
  readonly prepare: (
    plan: FrozenTurnPlan,
    signal: AbortSignal,
    resources?: { readonly skills: readonly PiSkillResource[] },
  ) => Promise<PreparedPiCodeExecution>;
  readonly shutdown: () => Promise<void>;
}

export type PiExecuteToolDetails =
  | {
      readonly kind: "activity";
      readonly executionId?: string;
      readonly event: PiCodeExecutionEvent;
    }
  | {
      readonly kind: "result";
      readonly executionId: string;
      readonly calls: number;
    };

export function createPiExecuteTool(input: {
  readonly prepared: PreparedPiCodeExecution;
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly emit: (event: PiCodeExecutionEvent, parentToolCallId: string) => void;
}): AgentTool<typeof executeParametersJsonSchema, PiExecuteToolDetails> {
  const tool: AgentTool<typeof executeParametersJsonSchema, PiExecuteToolDetails> = {
    name: "execute",
    label: "Execute JavaScript",
    description: [
      "Execute JavaScript on the user's machine and compose work tools through the injected SDK.",
      "Discover before guessing: return await noesis.search(query), then return await noesis.describe(exactName) to inspect its input schema.",
      "Invoke with return await tools.<family>.<operation>(input), or return await noesis.invoke(exactName, input).",
      "emit(value) and notify(value) show progress to the user but do not return that value to you; use return for the final result that should enter conversation context.",
      "When the user asks to preserve successful reusable work, prefer scripts.save over a loose helper file, verify it immediately with scripts.run in the same execution, and return the save receipt, verification, and reuse instructions.",
      "Use store(key, value)/load(key) for codemode-session scratch state.",
    ].join(" "),
    parameters: executeParametersJsonSchema,
    executionMode: "sequential",
    execute: async (toolCallId, rawInput, toolSignal, onUpdate) => {
      const params = executeParameters.parse(rawInput);
      if (new TextEncoder().encode(params.source).byteLength > MAX_SOURCE_BYTES)
        throw new Error(`Codemode source exceeds ${String(MAX_SOURCE_BYTES)} UTF-8 bytes`);
      const controller = new AbortController();
      const abortTurn = (): void => controller.abort(input.signal.reason);
      const abortTool = (): void => controller.abort(toolSignal?.reason);
      if (input.signal.aborted) abortTurn();
      else input.signal.addEventListener("abort", abortTurn, { once: true });
      if (toolSignal?.aborted) abortTool();
      else toolSignal?.addEventListener("abort", abortTool, { once: true });
      try {
        if (controller.signal.aborted) throw new Error("Codemode execution was cancelled before start");
        let executionId: string | undefined;
        const result = await input.prepared.execute(
          params.source,
          params.timeoutMs,
          controller.signal,
          (event) => {
            if (event.type === "started") executionId = event.executionId;
            input.emit(event, toolCallId);
            onUpdate?.({
              content: [],
              details: Object.freeze({
                kind: "activity",
                ...(executionId ? { executionId } : {}),
                event,
              }),
            });
          },
          { logicalExecutionId: `${input.turnId}:${toolCallId}` },
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.value) }],
          details: {
            kind: "result",
            executionId: result.executionId,
            calls: result.calls,
          },
        };
      } finally {
        input.signal.removeEventListener("abort", abortTurn);
        toolSignal?.removeEventListener("abort", abortTool);
      }
    },
  };
  return Object.freeze(tool);
}
