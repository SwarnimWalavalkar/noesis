import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { calculateContextTokens, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { estimateInputTokens } from "@noesis/agent-types";
import { sha256 } from "@noesis/domain";

const REQUEST_FRAMING_TOKENS = 64;
const TOOL_FRAMING_TOKENS = 16;
const MESSAGE_FRAMING_TOKENS = 8;
const TOOL_RESULT_PREVIEW_CHARACTERS = 1_200;

export interface PiRequestBudgetProjection {
  readonly messages: AgentMessage[];
  readonly estimatedTokens: number;
  readonly fixedTokens: number;
  readonly messageTokens: number;
  readonly providerReportedTokens: number;
  readonly trailingEstimatedTokens: number;
  readonly projectedToolResults: number;
}

export interface PiRequestBudgetInput {
  readonly messages: readonly AgentMessage[];
  readonly systemPrompt: string;
  readonly activeToolMaterial: string;
  readonly activeToolCount: number;
  readonly tokenBudget: number;
  readonly planId: string;
}

export interface PiRequestBudgetProjector {
  readonly project: (input: PiRequestBudgetInput) => PiRequestBudgetProjection;
}

function validAssistantUsage(message: AgentMessage): message is AssistantMessage {
  if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted")
    return false;
  return calculateContextTokens(message.usage) > 0;
}

function fixedRequestTokens(input: {
  readonly systemPrompt: string;
  readonly activeToolMaterial: string;
  readonly activeToolCount: number;
  readonly messageCount: number;
}): number {
  return (
    REQUEST_FRAMING_TOKENS +
    estimateInputTokens(input.systemPrompt) +
    estimateInputTokens(input.activeToolMaterial) +
    input.activeToolCount * TOOL_FRAMING_TOKENS +
    input.messageCount * MESSAGE_FRAMING_TOKENS
  );
}

function toolResultText(message: ToolResultMessage): string {
  return message.content
    .map((block) =>
      block.type === "text"
        ? block.text
        : `[image ${block.mimeType}; ${String(block.data.length)} encoded bytes]`,
    )
    .join("\n");
}

function projectedToolResult(message: ToolResultMessage): ToolResultMessage {
  const serialized = JSON.stringify(message.content);
  const text = toolResultText(message);
  const preview = text.slice(0, TOOL_RESULT_PREVIEW_CHARACTERS);
  const omitted = Math.max(0, text.length - preview.length);
  return {
    ...message,
    content: [
      {
        type: "text",
        text: [
          `[Earlier tool result compacted for model context: ${message.toolName} (${message.toolCallId}).]`,
          `Full result remains in the durable tool-call trace. sha256=${sha256(serialized)}; originalBytes=${String(new TextEncoder().encode(serialized).byteLength)}.`,
          preview,
          omitted > 0 ? `[${String(omitted)} additional characters omitted from model context.]` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  };
}

function applyProjection(messages: readonly AgentMessage[], projected: ReadonlySet<string>): AgentMessage[] {
  return messages.map((message) =>
    message.role === "toolResult" && projected.has(message.toolCallId)
      ? projectedToolResult(message)
      : message,
  );
}

function heuristicMessageTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function lastReportedUsage(
  messages: readonly AgentMessage[],
): Readonly<{ index: number; tokens: number }> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && validAssistantUsage(message))
      return Object.freeze({ index, tokens: calculateContextTokens(message.usage) });
  }
  return undefined;
}

export function createPiRequestBudgetProjector(): PiRequestBudgetProjector {
  const projectedToolCallIds = new Set<string>();
  let previousFixedTokens: number | undefined;

  const heuristicProjection = (
    messages: readonly AgentMessage[],
    fixedTokens: number,
  ): PiRequestBudgetProjection => {
    const projectedMessages = applyProjection(messages, projectedToolCallIds);
    const messageTokens = heuristicMessageTokens(projectedMessages);
    return Object.freeze({
      messages: projectedMessages,
      estimatedTokens: fixedTokens + messageTokens,
      fixedTokens,
      messageTokens,
      providerReportedTokens: 0,
      trailingEstimatedTokens: 0,
      projectedToolResults: projectedToolCallIds.size,
    });
  };

  return Object.freeze({
    project(input: PiRequestBudgetInput) {
      if (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget <= 0)
        throw new Error("Frozen request token budget must be a positive integer");
      const fixedTokens = fixedRequestTokens({
        systemPrompt: input.systemPrompt,
        activeToolMaterial: input.activeToolMaterial,
        activeToolCount: input.activeToolCount,
        messageCount: input.messages.length,
      });
      const reported = lastReportedUsage(input.messages);
      let projection: PiRequestBudgetProjection;
      if (reported) {
        const trailingEstimatedTokens = heuristicMessageTokens(input.messages.slice(reported.index + 1));
        const fixedAdjustment = previousFixedTokens === undefined ? 0 : fixedTokens - previousFixedTokens;
        const estimatedTokens = Math.max(1, reported.tokens + trailingEstimatedTokens + fixedAdjustment);
        projection = Object.freeze({
          messages: applyProjection(input.messages, projectedToolCallIds),
          estimatedTokens,
          fixedTokens,
          messageTokens: Math.max(0, estimatedTokens - fixedTokens),
          providerReportedTokens: reported.tokens,
          trailingEstimatedTokens,
          projectedToolResults: projectedToolCallIds.size,
        });
      } else {
        projection = heuristicProjection(input.messages, fixedTokens);
      }

      if (projection.estimatedTokens > input.tokenBudget) {
        const candidates = input.messages.flatMap((message) =>
          message.role === "toolResult" && !projectedToolCallIds.has(message.toolCallId) ? [message] : [],
        );
        for (const candidate of candidates) {
          const originalTokens = estimateTokens(candidate);
          const compactedTokens = estimateTokens(projectedToolResult(candidate));
          if (compactedTokens >= originalTokens) continue;
          projectedToolCallIds.add(candidate.toolCallId);
          if (reported) {
            const estimatedTokens = Math.max(
              1,
              projection.estimatedTokens - (originalTokens - compactedTokens),
            );
            projection = Object.freeze({
              ...projection,
              messages: applyProjection(input.messages, projectedToolCallIds),
              estimatedTokens,
              messageTokens: Math.max(0, estimatedTokens - fixedTokens),
              projectedToolResults: projectedToolCallIds.size,
            });
          } else {
            projection = heuristicProjection(input.messages, fixedTokens);
          }
          if (projection.estimatedTokens <= input.tokenBudget) break;
        }
      }

      if (projection.estimatedTokens > input.tokenBudget)
        throw new Error(
          `Frozen turn plan ${input.planId} complete request exceeds its token budget before model invocation ` +
            `(estimated=${String(projection.estimatedTokens)}, budget=${String(input.tokenBudget)}, fixed=${String(projection.fixedTokens)}, messages=${String(projection.messageTokens)}, providerReported=${String(projection.providerReportedTokens)}, trailingEstimated=${String(projection.trailingEstimatedTokens)}, projectedToolResults=${String(projection.projectedToolResults)})`,
        );
      previousFixedTokens = fixedTokens;
      return projection;
    },
  });
}
