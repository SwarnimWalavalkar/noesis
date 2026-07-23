import { AgentHarness, InMemorySessionStorage, Session, type AgentTool } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { MutableModels } from "@earendil-works/pi-ai";
import type {
  AgentContextUsage,
  AgentRuntimeEvent,
  AgentRuntimeRequest,
  AgentRuntimeResult,
  NoesisAgentRuntime,
} from "@noesis/agent-types";
import { z } from "zod";

export * from "./auth.ts";
export * from "./experiment-fixtures.ts";
export * from "./generated-tool-broker.ts";
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

export interface FakeAgentRuntime extends NoesisAgentRuntime {
  readonly name: "fake";
}

export function createFakeAgentRuntime(): FakeAgentRuntime {
  const active = new Map<string, AbortController>();

  const run = async (
    request: AgentRuntimeRequest,
    emit: (event: AgentRuntimeEvent) => void,
  ): Promise<AgentRuntimeResult> => {
    if (active.has(request.trailId)) throw new Error(`Trail ${request.trailId} is already active`);
    const controller = new AbortController();
    active.set(request.trailId, controller);
    try {
      const contextWindow = 8_000;
      emit({ type: "model", provider: "fake", model: request.model, contextWindow });
      emit({ type: "status", status: "started" });
      const skills =
        request.activeCapabilities.length === 0
          ? "no promoted skills"
          : `skills ${request.activeCapabilities.map((item) => `${item.name}@${item.version}`).join(", ")}`;
      const text = `Fake completion for: ${request.prompt} [using ${skills}]`;
      let rendered = "";
      for (const word of text.split(" ")) {
        if (controller.signal.aborted) {
          emit({ type: "status", status: "aborted" });
          return {
            text: rendered.trim(),
            provider: "fake",
            model: request.model,
            outcome: "aborted",
            stopReason: "aborted",
          };
        }
        const firstDelta = rendered.length === 0;
        const delta = `${rendered ? " " : ""}${word}`;
        rendered += delta;
        emit({ type: "delta", text: delta });
        // Give the first fake delta one render frame, then keep later chunks fast and deterministic.
        await new Promise<void>((resolve) =>
          firstDelta
            ? setTimeout(resolve, 20)
            : request.prompt.length > 200
              ? setTimeout(resolve, 2)
              : setImmediate(resolve),
        );
      }
      const contextUsage: AgentContextUsage = {
        usedTokens: Math.max(
          1,
          Math.ceil((request.systemPrompt.length + request.prompt.length + text.length) / 4),
        ),
        contextWindow,
        accuracy: "estimated",
      };
      emit({ type: "usage", ...contextUsage });
      emit({ type: "status", status: "completed" });
      return {
        text: rendered,
        provider: "fake",
        model: request.model,
        outcome: "completed",
        stopReason: "stop",
        contextUsage,
      };
    } finally {
      if (active.get(request.trailId) === controller) active.delete(request.trailId);
    }
  };

  const steer = async (trailId: string, text: string): Promise<void> => {
    if (!active.has(trailId)) throw new Error("Trail is not running");
    void text;
  };

  const followUp = async (trailId: string, text: string): Promise<void> => {
    if (!active.has(trailId)) throw new Error("Trail is not running");
    void text;
  };

  const abort = async (trailId: string): Promise<void> => {
    active.get(trailId)?.abort();
  };

  return Object.freeze({ name: "fake", run, steer, followUp, abort });
}

const inspectParameters = z.looseObject({
  section: z.enum(["context", "capabilities"]),
});
const inspectParametersJsonSchema = z.toJSONSchema(inspectParameters);

export interface PiAgentRuntime extends NoesisAgentRuntime {
  readonly name: "pi-agent-harness-0.80.6";
}

export function createPiAgentRuntime(cwd: string, models: MutableModels): PiAgentRuntime {
  interface ActivePiExecution {
    harness?: AgentHarness;
  }

  const active = new Map<string, ActivePiExecution>();

  const run = async (
    request: AgentRuntimeRequest,
    emit: (event: AgentRuntimeEvent) => void,
  ): Promise<AgentRuntimeResult> => {
    if (active.has(request.trailId)) throw new Error(`Trail ${request.trailId} is already active`);
    const execution: ActivePiExecution = {};
    active.set(request.trailId, execution);
    try {
      const model = models.getModel(request.provider, request.model);
      if (!model) throw new Error(`Pi model not found: ${request.provider}/${request.model}`);
      emit({
        type: "model",
        provider: model.provider,
        model: model.id,
        contextWindow: model.contextWindow,
      });
      const auth = await models.getAuth(model);
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
      const harness = new AgentHarness({
        env: new NodeExecutionEnv({ cwd }),
        session: new Session(new InMemorySessionStorage()),
        models,
        model,
        tools: [inspectTool],
        thinkingLevel: request.thinkingLevel,
        systemPrompt: request.systemPrompt,
      });
      execution.harness = harness;
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
        unsubscribe();
      }
    } finally {
      if (active.get(request.trailId) === execution) active.delete(request.trailId);
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
    await active.get(trailId)?.harness?.abort();
  };

  return Object.freeze({ name: "pi-agent-harness-0.80.6", run, steer, followUp, abort });
}
