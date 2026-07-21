import { describe, expect, test } from "vitest";
import { createAssistantDeltaAggregator, createFakeAgentRuntime } from "../src/index.ts";

const request = {
  trailId: "shared-trail",
  provider: "fake",
  model: "fake-model",
  thinkingLevel: "off" as const,
  systemPrompt: "test",
  prompt: "verify independent closure state",
  activeCapabilities: [],
};

describe("agent runtime factories", () => {
  test("aggregates authoritative Pi text deltas across tool-loop assistant messages", () => {
    const deltas = createAssistantDeltaAggregator();
    deltas.beginMessage();
    expect(deltas.push("I will inspect ")).toBe("I will inspect ");
    expect(deltas.push("the snapshot.")).toBe("the snapshot.");
    deltas.beginMessage(); // tool-call-only assistant message: no text delta
    deltas.beginMessage();
    expect(deltas.push("Grounded answer.")).toBe("\n\nGrounded answer.");
    expect(deltas.text()).toBe("I will inspect the snapshot.\n\nGrounded answer.");
  });

  test("isolates active turns across independent fake runtime instances", async () => {
    const first = createFakeAgentRuntime();
    const second = createFakeAgentRuntime();

    const firstRun = first.run(request, () => undefined);
    const secondRun = second.run(request, () => undefined);
    await first.abort(request.trailId);

    const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);
    expect(firstResult.stopReason).toBe("aborted");
    expect(secondResult.stopReason).toBe("stop");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
  });

  test("rejects duplicate fake executions and releases only the owned handle", async () => {
    const runtime = createFakeAgentRuntime();
    const first = runtime.run(request, () => undefined);

    await expect(runtime.run(request, () => undefined)).rejects.toThrow("already active");
    await expect(first).resolves.toMatchObject({ stopReason: "stop" });
    await expect(runtime.run(request, () => undefined)).resolves.toMatchObject({ stopReason: "stop" });
  });

  test("emits explicit model and estimated usage telemetry for offline UI tests", async () => {
    const runtime = createFakeAgentRuntime();
    const events: Parameters<Parameters<typeof runtime.run>[1]>[0][] = [];

    const result = await runtime.run(request, (event) => events.push(event));

    expect(events[0]).toEqual({
      type: "model",
      provider: "fake",
      model: "fake-model",
      contextWindow: 8_000,
    });
    expect(events).toContainEqual({ type: "status", status: "started" });
    expect(events.at(-2)).toMatchObject({ type: "usage", accuracy: "estimated", contextWindow: 8_000 });
    expect(events.at(-1)).toEqual({ type: "status", status: "completed" });
    expect(result.contextUsage).toMatchObject({ accuracy: "estimated", contextWindow: 8_000 });
  });
});
