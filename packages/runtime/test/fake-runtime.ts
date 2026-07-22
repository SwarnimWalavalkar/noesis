import type {
  AgentContextUsage,
  AgentRuntimeEvent,
  AgentRuntimeRequest,
  AgentRuntimeResult,
  NoesisAgentRuntime,
} from "@noesis/agent-types";

/** Adapter-neutral deterministic runtime used by the runtime package's acceptance suite. */
export function createFakeAgentRuntime(): NoesisAgentRuntime {
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
  return Object.freeze({
    name: "fake",
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
