import { expect, test } from "vitest";
import { stream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { inspectCacheUsage, requestContextComponents } from "../src/context-inspection.ts";

test.each([0, 9200])(
  "preserves %i cached tokens through the native Codex response adapter",
  async (cachedTokens) => {
    const tokenPayload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
    ).toString("base64url");
    const response = await stream(
      {
        id: "test-model",
        name: "Test model",
        api: "openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://example.invalid",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272000,
        maxTokens: 128000,
      },
      { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
      {
        apiKey: `test.${tokenPayload}.test`,
        transport: "sse",
        fetch: async () =>
          new Response(
            `data: ${JSON.stringify({ type: "response.completed", response: { id: "test-response", status: "completed", output: [], usage: { input_tokens: 10000, output_tokens: 100, total_tokens: 10100, input_tokens_details: { cached_tokens: cachedTokens } } } })}\n\n`,
            { headers: { "Content-Type": "text/event-stream" } },
          ),
      },
    ).result();
    expect(response.stopReason).toBe("stop");
    expect(inspectCacheUsage(response.usage)).toEqual({
      inputTokens: 10000,
      readTokens: cachedTokens,
      writeTokens: 0,
    });
  },
);

test("counts projected request material and only counts loaded skills inside results", () => {
  const components = requestContextComponents({
    systemPrompt: "Core instructions",
    skillsPrompt: "Skill names",
    tools: "Schemas",
    messages: [
      { role: "user", content: "Hello", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "load",
        toolName: "execute",
        content: [{ type: "text", text: "loaded skill body" }],
        isError: false,
        timestamp: 2,
      },
    ],
  });
  expect(components.find((part) => part.label === "Skill catalog")?.content).toBe("Skill names");
  expect(components.find((part) => part.label === "Tool results & loaded skills")?.content).toContain(
    "loaded skill body",
  );
  expect(components.find((part) => part.label === "Assistant messages & reasoning")?.tokens).toBe(0);
});

test("bounds preview characters without bounding the token count", () => {
  const components = requestContextComponents({
    systemPrompt: "x".repeat(50000),
    skillsPrompt: "",
    tools: "",
    messages: [],
  });
  expect(components[0]?.tokens).toBe(12500);
  expect(components[0]?.content).toContain("preview truncated");
  expect(components[0]?.content.length).toBeLessThan(17000);
});

test("cache accounting includes cache writes in input, never as hits", () => {
  expect(inspectCacheUsage({ input: 300, cacheRead: 9200, cacheWrite: 500 })).toEqual({
    inputTokens: 10000,
    readTokens: 9200,
    writeTokens: 500,
  });
  expect(inspectCacheUsage({ input: 300, cacheRead: 0, cacheWrite: 500 })).toEqual({
    inputTokens: 800,
    readTokens: 0,
    writeTokens: 500,
  });
});

test("retains zero cache hits when input usage is available", () => {
  expect(inspectCacheUsage({ input: 1000, cacheRead: 0, cacheWrite: 0 })).toEqual({
    inputTokens: 1000,
    readTokens: 0,
    writeTokens: 0,
  });
});

test("does not invent cache accounting without input usage or with invalid usage", () => {
  expect(inspectCacheUsage({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
  expect(inspectCacheUsage({ input: NaN, cacheRead: 10, cacheWrite: 0 })).toBeUndefined();
  expect(inspectCacheUsage({ input: 10, cacheRead: -1, cacheWrite: 0 })).toBeUndefined();
});
