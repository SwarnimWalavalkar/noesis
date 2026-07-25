import type {
  AgentContextUsage,
  AgentRuntimeEvent,
  AgentRuntimeRequest,
  AgentRuntimeResult,
  NoesisAgentRuntime,
} from "@noesis/agent-types";
import { validateFrozenTurnPlan } from "@noesis/agent-types";

/** Test-only adapter-neutral scripted runtime for narrow runtime package seams. */
export function createScriptedAgentRuntime(): NoesisAgentRuntime {
  const active = new Map<string, AbortController>();
  const run = async (
    request: AgentRuntimeRequest,
    emit: (event: AgentRuntimeEvent) => void,
  ): Promise<AgentRuntimeResult> => {
    if (request.frozenTurnPlan) {
      const plan = validateFrozenTurnPlan(request.frozenTurnPlan);
      if (plan.sessionId !== request.trailId || plan.renderedSystemPrompt !== request.systemPrompt)
        throw new Error(`Runtime request does not match frozen turn plan ${plan.planId}`);
    }
    if (active.has(request.trailId)) throw new Error(`Trail ${request.trailId} is already active`);
    const controller = new AbortController();
    active.set(request.trailId, controller);
    try {
      const contextWindow = 8_000;
      emit({ type: "model", provider: "scripted", model: request.model, contextWindow });
      emit({ type: "status", status: "started" });
      const text = `Scripted completion for: ${request.prompt}`;
      let rendered = "";
      for (const word of text.split(" ")) {
        if (controller.signal.aborted) {
          emit({ type: "status", status: "aborted" });
          return {
            text: rendered.trim(),
            provider: "scripted",
            model: request.model,
            outcome: "aborted",
            stopReason: "aborted",
          };
        }
        const firstDelta = rendered.length === 0;
        const delta = `${rendered ? " " : ""}${word}`;
        rendered += delta;
        emit({ type: "delta", text: delta });
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
        provider: "scripted",
        model: request.model,
        outcome: "completed",
        stopReason: "stop",
        contextUsage,
      };
    } finally {
      if (active.get(request.trailId) === controller) active.delete(request.trailId);
    }
  };
  return Object.freeze({
    name: "scripted-test-runtime",
    run,
    steer: async (trailId: string) => {
      if (!active.has(trailId)) throw new Error("Trail is not running");
    },
    followUp: async (trailId: string) => {
      if (!active.has(trailId)) throw new Error("Trail is not running");
    },
    abort: async (trailId: string) => active.get(trailId)?.abort(),
  });
}
