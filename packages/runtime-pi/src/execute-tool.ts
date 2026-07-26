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

export type PiCodeExecutionEvent =
  | { readonly type: "progress"; readonly value: JsonValue }
  | { readonly type: "tool-start"; readonly name: string; readonly callIndex: number }
  | {
      readonly type: "tool-end";
      readonly name: string;
      readonly callIndex: number;
      readonly ok: boolean;
    };

export interface PreparedPiCodeExecution {
  readonly catalogId: string;
  readonly catalogDigest: string;
  readonly execute: (
    source: string,
    timeoutMs: number | undefined,
    signal: AbortSignal,
    emit: (event: PiCodeExecutionEvent) => void,
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

export function createPiExecuteTool(input: {
  readonly prepared: PreparedPiCodeExecution;
  readonly signal: AbortSignal;
  readonly emit: (event: PiCodeExecutionEvent) => void;
}): AgentTool<typeof executeParametersJsonSchema, { readonly executionId: string; readonly calls: number }> {
  const tool: AgentTool<
    typeof executeParametersJsonSchema,
    { readonly executionId: string; readonly calls: number }
  > = {
    name: "execute",
    label: "Execute JavaScript",
    description: [
      "Execute JavaScript on the user's machine and compose work tools through the injected SDK.",
      "Use tools.<family>.<operation>(input), noesis.search(query), and noesis.describe(name).",
      "Return only the final value that should enter the conversation context.",
    ].join(" "),
    parameters: executeParametersJsonSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, rawInput, toolSignal) => {
      const params = executeParameters.parse(rawInput);
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      input.signal.addEventListener("abort", abort, { once: true });
      toolSignal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await input.prepared.execute(
          params.source,
          params.timeoutMs,
          controller.signal,
          input.emit,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.value) }],
          details: { executionId: result.executionId, calls: result.calls },
        };
      } finally {
        input.signal.removeEventListener("abort", abort);
        toolSignal?.removeEventListener("abort", abort);
      }
    },
  };
  return Object.freeze(tool);
}
