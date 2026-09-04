import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { calculateContextTokens } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type AuthResult,
  type Context,
  type Model,
  type Models,
  type ModelsApiStreamOptions,
  type ModelsSimpleStreamOptions,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
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

type AuthResolutionOverrides = Parameters<Models["getAuth"]>[1];

function failedRequestMessage(model: Model<Api>, failure: Error): AssistantMessage {
  return Object.freeze({
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: Object.freeze({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
    }),
    stopReason: "error",
    errorMessage: failure.message,
    timestamp: Date.now(),
  });
}

function failedRequestStream(model: Model<Api>, failure: Error): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const message = failedRequestMessage(model, failure);
    stream.push({ type: "error", reason: "error", error: message });
  });
  return stream;
}

/** Prevents a failed request projection from reaching the provider. */
export function createPiRequestGuardedModels(
  delegate: Models,
  currentFailure: () => Error | undefined,
): Models {
  function getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
  function getAuth(model: Model<Api>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
  async function getAuth(
    providerOrModel: string | Model<Api>,
    overrides?: AuthResolutionOverrides,
  ): Promise<AuthResult | undefined> {
    return typeof providerOrModel === "string"
      ? await delegate.getAuth(providerOrModel, overrides)
      : await delegate.getAuth(providerOrModel, overrides);
  }

  function stream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ): AssistantMessageEventStream {
    const failure = currentFailure();
    return failure ? failedRequestStream(model, failure) : delegate.stream(model, context, options);
  }

  async function complete<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ): Promise<AssistantMessage> {
    return await stream(model, context, options).result();
  }

  function streamSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ): AssistantMessageEventStream {
    const failure = currentFailure();
    return failure ? failedRequestStream(model, failure) : delegate.streamSimple(model, context, options);
  }

  async function completeSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ): Promise<AssistantMessage> {
    return await streamSimple(model, context, options).result();
  }

  const guarded: Models = {
    getProviders: () => delegate.getProviders(),
    getProvider: (id) => delegate.getProvider(id),
    getModels: (provider) => delegate.getModels(provider),
    getModel: (provider, id) => delegate.getModel(provider, id),
    refresh: async (options) => await delegate.refresh(options),
    checkAuth: async (providerId, options) => await delegate.checkAuth(providerId, options),
    getAvailable: async (providerId, options) => await delegate.getAvailable(providerId, options),
    getAuth,
    login: async (providerId, type, interaction) => await delegate.login(providerId, type, interaction),
    logout: async (providerId, options) => await delegate.logout(providerId, options),
    stream,
    complete,
    streamSimple,
    completeSimple,
    streamDeferred: (model, handle, options) => delegate.streamDeferred(model, handle, options),
    fetchDeferred: async (model, handle, options) => await delegate.fetchDeferred(model, handle, options),
    cancelDeferred: async (model, handle, options) => await delegate.cancelDeferred(model, handle, options),
  };
  return Object.freeze(guarded);
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

function estimateMessageTokens(message: AgentMessage): number {
  return estimateInputTokens(JSON.stringify(message));
}

function heuristicMessageTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
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
          const originalTokens = estimateMessageTokens(candidate);
          const compactedTokens = estimateMessageTokens(projectedToolResult(candidate));
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
