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
const MAX_WORKFLOW_SUMMARIES = 32;
const MAX_WORKFLOW_INDEX_BYTES = 4 * 1024;
const MAX_WORKFLOW_NAME_BYTES = 96;
const MAX_WORKFLOW_TOOL_NAME_BYTES = 128;
const MAX_WORKFLOW_DESCRIPTION_BYTES = 192;

export interface PiWorkflowSummary {
  readonly name: string;
  readonly description: string;
  readonly toolName: string;
}

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
  readonly workflowSummaries?: readonly PiWorkflowSummary[];
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

function normalizeSingleLine(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeXmlBounded(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const escaped = escapeXml(value);
  if (encoder.encode(escaped).byteLength <= maxBytes) return escaped;
  const ellipsis = "…";
  const available = maxBytes - encoder.encode(ellipsis).byteLength;
  let result = "";
  let used = 0;
  for (const character of value) {
    const escapedCharacter = escapeXml(character);
    const bytes = encoder.encode(escapedCharacter).byteLength;
    if (used + bytes > available) break;
    result += escapedCharacter;
    used += bytes;
  }
  return `${result}${ellipsis}`;
}

function workflowIndex(summaries: readonly PiWorkflowSummary[] | undefined): string | undefined {
  if (!summaries || summaries.length === 0) return undefined;
  const normalized = summaries
    .map((summary) => ({
      name: normalizeSingleLine(summary.name),
      description: normalizeSingleLine(summary.description),
      toolName: normalizeSingleLine(summary.toolName),
    }))
    .sort((left, right) => {
      if (left.name !== right.name) return left.name < right.name ? -1 : 1;
      if (left.toolName !== right.toolName) return left.toolName < right.toolName ? -1 : 1;
      if (left.description === right.description) return 0;
      return left.description < right.description ? -1 : 1;
    });
  const selected = normalized.slice(0, MAX_WORKFLOW_SUMMARIES);
  const render = (entries: typeof selected, truncated: boolean): string => {
    const compactEntries = entries
      .map(
        ({ name, description, toolName }) =>
          `${escapeXmlBounded(name, MAX_WORKFLOW_NAME_BYTES)} [tool: ${escapeXmlBounded(
            toolName,
            MAX_WORKFLOW_TOOL_NAME_BYTES,
          )}] — ${escapeXmlBounded(description, MAX_WORKFLOW_DESCRIPTION_BYTES)}`,
      )
      .join("; ");
    return [
      `<available_workflows>${compactEntries}</available_workflows>`,
      "Use each exact listed tool name with adapt for project-safe hotbar pinning.",
      "`workflows.run` is the generic runner; use `workflows.describe(name)` for the full workflow contract.",
      ...(truncated ? ["More saved workflows are available; use workflows.list to inspect them."] : []),
    ].join(" ");
  };
  let truncated = selected.length < normalized.length;
  while (selected.length > 0) {
    const value = render(selected, truncated);
    if (new TextEncoder().encode(value).byteLength <= MAX_WORKFLOW_INDEX_BYTES) return value;
    selected.pop();
    truncated = true;
  }
  return render([], true);
}

export function createPiExecuteTool(input: {
  readonly prepared: PreparedPiCodeExecution;
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly emit: (event: PiCodeExecutionEvent, parentToolCallId: string) => void;
}): AgentTool<typeof executeParametersJsonSchema, PiExecuteToolDetails> {
  const availableWorkflows = workflowIndex(input.prepared.workflowSummaries);
  const tool: AgentTool<typeof executeParametersJsonSchema, PiExecuteToolDetails> = {
    name: "execute",
    label: "Execute JavaScript",
    description: [
      "Execute JavaScript on the user's machine and compose work tools through the injected SDK.",
      "Discover before guessing: return await noesis.search(query), then return await noesis.describe(exactName) to inspect its input schema.",
      "Invoke with return await tools.<family>.<operation>(input), or return await noesis.invoke(exactName, input).",
      "emit(value) and notify(value) show progress to the user but do not return that value to you; use return for the final result that should enter conversation context.",
      "When the user asks you to create a reusable capability, or a reusable project-local program would materially help the current work, implement it immediately as a script with scripts.save, or as a workflow with workflows.save when it needs durable phases. Do not defer executable project-local work to reflection or evaluation. Verify a new script immediately with scripts.run in the same execution and return the save receipt, verification, and reuse instructions.",
      ...(availableWorkflows ? [availableWorkflows] : []),
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
