import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { forbidToolCallsInPayload, withoutToolCalls } from "../src/answer-only-request.ts";

const tools = [{ name: "execute" }];

describe("forbidToolCallsInPayload", () => {
  it.each([
    // Anthropic, and Anthropic-routed OpenRouter and OpenCode models.
    ["anthropic-messages", { tool_choice: { type: "none" } }],
    // OpenRouter and most OpenCode Zen and OpenCode Go models.
    ["openai-completions", { tool_choice: "none" }],
    ["openai-responses", { tool_choice: "none" }],
    ["openai-codex-responses", { tool_choice: "none" }],
    ["azure-openai-responses", { tool_choice: "none" }],
    ["mistral-conversations", { toolChoice: "none" }],
  ])("keeps tool definitions and forbids calls on %s", (api, expected) => {
    expect(forbidToolCallsInPayload(api, { model: "m", tools })).toEqual({ model: "m", tools, ...expected });
  });

  it("replaces an earlier choice", () => {
    expect(forbidToolCallsInPayload("openai-codex-responses", { tools, tool_choice: "auto" })).toEqual({
      tools,
      tool_choice: "none",
    });
  });

  it.each(["google-generative-ai", "google-vertex"])("uses function calling mode on %s", (api) => {
    expect(
      forbidToolCallsInPayload(api, {
        contents: [],
        config: { tools, toolConfig: { functionCallingConfig: { mode: "AUTO" } } },
      }),
    ).toEqual({
      contents: [],
      config: { tools, toolConfig: { functionCallingConfig: { mode: "NONE" } } },
    });
  });

  it("leaves an API with no such option unchanged", () => {
    const payload = { toolConfig: { tools } };
    expect(forbidToolCallsInPayload("bedrock-converse-stream", payload)).toBe(payload);
  });
});

describe("withoutToolCalls", () => {
  const message = (
    content: AssistantMessage["content"],
    stopReason: AssistantMessage["stopReason"],
  ): AssistantMessage => ({
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "p",
    model: "m",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  });

  it("keeps the text and ends the turn", () => {
    const result = withoutToolCalls(
      message(
        [
          { type: "text", text: "Answer" },
          { type: "toolCall", id: "1", name: "execute", arguments: {} },
        ],
        "toolUse",
      ),
    );
    expect(result.content).toEqual([{ type: "text", text: "Answer" }]);
    expect(result.stopReason).toBe("stop");
  });

  it("returns a plain answer unchanged", () => {
    const plain = message([{ type: "text", text: "Answer" }], "stop");
    expect(withoutToolCalls(plain)).toBe(plain);
  });
});
