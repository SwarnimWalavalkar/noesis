import { AgentHarness, type AgentTool } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { MutableModels } from "@earendil-works/pi-ai";
import type {
  AgentContextUsage,
  AgentRuntimeEvent,
  AgentRuntimeRequest,
  AgentRuntimeResult,
  FrozenTurnPlan,
  NoesisAgentRuntime,
} from "@noesis/agent-types";
import { validateFrozenTurnPlan } from "@noesis/agent-types";
import { z } from "zod";
import { resolveFrozenSessionTools, type FrozenSessionToolResolver } from "./frozen-session-tools.ts";
import { createEphemeralPiSession, releasePiSessionResources } from "./session-lifecycle.ts";

export * from "./auth.ts";
export * from "./experiment-fixtures.ts";
export { frozenPlanMaterialUses } from "./frozen-session-tools.ts";
export type {
  FrozenPlanMaterialKind,
  FrozenPlanMaterialUse,
  FrozenSessionToolResolution,
  FrozenSessionToolResolver,
} from "./frozen-session-tools.ts";
export * from "./pi-role-backend.ts";
export * from "./role-context.ts";
export * from "./role-runner.ts";
export * from "./role-types.ts";
export * from "./session-tool-registration.ts";
export type {
  AgentCompletedStopReason,
  AgentContextUsage,
  AgentRuntimeEvent,
  AgentRuntimeRequest,
  AgentRuntimeResult,
  AgentThinkingLevel,
  NoesisAgentRuntime,
} from "@noesis/agent-types";

function assistantText(message: { readonly content: readonly unknown[] }): string {
  return message.content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text" || !("text" in part))
        return [];
      return typeof part.text === "string" ? [part.text] : [];
    })
    .join("");
}

function verifyFrozenRequest(request: AgentRuntimeRequest): FrozenTurnPlan | undefined {
  if (!request.frozenTurnPlan) return undefined;
  const plan = validateFrozenTurnPlan(request.frozenTurnPlan);
  if (
    plan.sessionId !== request.trailId ||
    plan.provider !== request.provider ||
    plan.model !== request.model ||
    plan.thinkingLevel !== request.thinkingLevel ||
    plan.renderedSystemPrompt !== request.systemPrompt
  )
    throw new Error(`Runtime request does not match frozen turn plan ${plan.planId}`);
  for (const selection of plan.selectedCapabilities) {
    for (const prompt of selection.promptModules) {
      const content = prompt.content.trim();
      if (content && !plan.renderedSystemPrompt.includes(content))
        throw new Error(
          `Frozen turn plan ${plan.planId} does not serve prompt material ${prompt.revision.revisionId}`,
        );
    }
  }
  return plan;
}

export interface AssistantDeltaAggregator {
  /** Start the next Pi assistant message in the same tool-loop turn. */
  readonly beginMessage: () => void;
  /** Return the exact display delta, including a separator between text-bearing assistant messages. */
  readonly push: (delta: string) => string;
  readonly text: () => string;
}

export function createAssistantDeltaAggregator(): AssistantDeltaAggregator {
  let aggregate = "";
  let currentMessageHasText = false;
  return {
    beginMessage() {
      currentMessageHasText = false;
    },
    push(delta) {
      if (!delta) return "";
      const separator = aggregate && !currentMessageHasText ? "\n\n" : "";
      const emitted = `${separator}${delta}`;
      aggregate += emitted;
      currentMessageHasText = true;
      return emitted;
    },
    text: () => aggregate,
  };
}

const inspectParameters = z.looseObject({
  section: z.enum(["context", "capabilities"]),
});
const inspectParametersJsonSchema = z.toJSONSchema(inspectParameters);

export interface PiAgentRuntime extends NoesisAgentRuntime {
  readonly name: "pi-agent-harness-0.80.6";
}

export interface CreatePiAgentRuntimeOptions {
  readonly sessionTools?: FrozenSessionToolResolver;
}

export function createPiAgentRuntime(
  cwd: string,
  models: MutableModels,
  options: CreatePiAgentRuntimeOptions = {},
): PiAgentRuntime {
  interface ActivePiExecution {
    readonly controller: AbortController;
    harness?: AgentHarness;
    sessionId?: string;
    requestHarnessAbort?: () => Promise<void>;
    abortError?: unknown;
    abortStatusEmitted?: boolean;
  }

  const active = new Map<string, ActivePiExecution>();

  const run = async (
    request: AgentRuntimeRequest,
    emit: (event: AgentRuntimeEvent) => void,
  ): Promise<AgentRuntimeResult> => {
    const plan = verifyFrozenRequest(request);
    if (active.has(request.trailId)) throw new Error(`Trail ${request.trailId} is already active`);
    const execution: ActivePiExecution = { controller: new AbortController() };
    active.set(request.trailId, execution);
    const abortedBeforePrompt = (): AgentRuntimeResult => {
      if (!execution.abortStatusEmitted) {
        execution.abortStatusEmitted = true;
        emit({ type: "status", status: "aborted" });
      }
      return Object.freeze({
        text: "",
        provider: request.provider,
        model: request.model,
        outcome: "aborted" as const,
        stopReason: "aborted" as const,
      });
    };
    try {
      if (execution.controller.signal.aborted) return abortedBeforePrompt();
      const model = models.getModel(request.provider, request.model);
      if (!model) throw new Error(`Pi model not found: ${request.provider}/${request.model}`);
      emit({
        type: "model",
        provider: model.provider,
        model: model.id,
        contextWindow: model.contextWindow,
      });
      const sessionTools = plan
        ? await resolveFrozenSessionTools(plan, options.sessionTools, execution.controller.signal)
        : Object.freeze([]);
      if (execution.controller.signal.aborted) return abortedBeforePrompt();
      const auth = await models.getAuth(model);
      if (execution.controller.signal.aborted) return abortedBeforePrompt();
      if (!auth) {
        if (request.provider === "openai-codex")
          throw new Error(
            "Codex OAuth is not configured. Run `noesis auth login openai-codex` before using this model.",
          );
        if (request.provider === "openrouter")
          throw new Error(
            "OpenRouter authentication is missing. Set OPENROUTER_API_KEY or run `noesis auth login openrouter`.",
          );
        throw new Error(`Pi credentials are missing for provider ${request.provider}.`);
      }
      const inspectTool: AgentTool<typeof inspectParametersJsonSchema, { section: string; immutable: true }> =
        {
          name: "inspect_noesis_snapshot",
          label: "Inspect Noesis snapshot",
          description: "Inspect the immutable context or capability snapshot pinned to this turn.",
          parameters: inspectParametersJsonSchema,
          execute: async (_toolCallId, input) => {
            const params = inspectParameters.parse(input);
            return {
              content: [
                {
                  type: "text",
                  text:
                    params.section === "context"
                      ? request.systemPrompt
                      : JSON.stringify(request.activeCapabilities, null, 2),
                },
              ],
              details: { section: params.section, immutable: true },
            };
          },
        };
      const { session, sessionId } = await createEphemeralPiSession();
      execution.sessionId = sessionId;
      if (execution.controller.signal.aborted) return abortedBeforePrompt();
      const harness = new AgentHarness({
        env: new NodeExecutionEnv({ cwd }),
        session,
        models,
        model,
        tools: [inspectTool, ...sessionTools],
        thinkingLevel: request.thinkingLevel,
        systemPrompt: request.systemPrompt,
      });
      execution.harness = harness;
      let abortPromise: Promise<void> | undefined;
      const requestHarnessAbort = (): Promise<void> => {
        abortPromise ??= harness.abort().then(
          () => undefined,
          (error: unknown) => {
            execution.abortError = error;
          },
        );
        return abortPromise;
      };
      execution.requestHarnessAbort = requestHarnessAbort;
      const abortHarness = () => requestHarnessAbort();
      execution.controller.signal.addEventListener("abort", abortHarness, { once: true });
      if (execution.controller.signal.aborted) await requestHarnessAbort();
      const assistantDeltas = createAssistantDeltaAggregator();
      const unsubscribe = harness.subscribe((event) => {
        if (event.type === "message_start" && event.message.role === "assistant") {
          assistantDeltas.beginMessage();
        } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          const delta = assistantDeltas.push(event.assistantMessageEvent.delta);
          if (delta) emit({ type: "delta", text: delta });
        } else if (event.type === "tool_execution_start") {
          const input: Record<string, unknown> =
            event.args && typeof event.args === "object" && !Array.isArray(event.args) ? event.args : {};
          emit({ type: "tool-start", name: event.toolName, input });
        } else if (event.type === "tool_execution_end") {
          emit({ type: "tool-end", name: event.toolName, isError: event.isError });
        }
      });
      emit({ type: "status", status: "started" });
      try {
        const message = await harness.prompt(request.prompt);
        const text = assistantText(message);
        const usedTokens =
          message.usage.totalTokens ||
          message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
        const contextUsage =
          usedTokens > 0 && model.contextWindow > 0
            ? ({
                usedTokens,
                contextWindow: model.contextWindow,
                accuracy: "reported",
              } satisfies AgentContextUsage)
            : undefined;
        if (contextUsage) emit({ type: "usage", ...contextUsage });
        const base = {
          text,
          provider: message.provider,
          model: message.model,
          ...(contextUsage ? { contextUsage } : {}),
        };
        if (message.stopReason === "error") {
          const error = message.errorMessage?.trim() || "The provider returned an error without details.";
          emit({ type: "status", status: "failed", error });
          return { ...base, outcome: "failed", stopReason: "error", error };
        }
        if (message.stopReason === "aborted") {
          emit({ type: "status", status: "aborted" });
          return { ...base, outcome: "aborted", stopReason: "aborted" };
        }
        emit({ type: "status", status: "completed" });
        return { ...base, outcome: "completed", stopReason: message.stopReason };
      } finally {
        execution.controller.signal.removeEventListener("abort", abortHarness);
        unsubscribe();
        await abortPromise;
      }
    } catch (error) {
      if (execution.controller.signal.aborted && !execution.harness) return abortedBeforePrompt();
      throw error;
    } finally {
      try {
        try {
          if (execution.harness) await execution.harness.waitForIdle();
        } finally {
          if (execution.sessionId) releasePiSessionResources(execution.sessionId);
        }
      } finally {
        if (active.get(request.trailId) === execution) active.delete(request.trailId);
      }
    }
  };

  const steer = async (trailId: string, text: string): Promise<void> => {
    const harness = active.get(trailId)?.harness;
    if (!harness) throw new Error("Trail is not running");
    await harness.steer(text);
  };

  const followUp = async (trailId: string, text: string): Promise<void> => {
    const harness = active.get(trailId)?.harness;
    if (!harness) throw new Error("Trail is not running");
    await harness.followUp(text);
  };

  const abort = async (trailId: string): Promise<void> => {
    const execution = active.get(trailId);
    if (!execution) return;
    execution.controller.abort();
    await execution.requestHarnessAbort?.();
    if (execution.abortError) throw execution.abortError;
  };

  return Object.freeze({ name: "pi-agent-harness-0.80.6", run, steer, followUp, abort });
}
