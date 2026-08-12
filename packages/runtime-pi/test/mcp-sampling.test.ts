import {
  type Context,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import {
  adaptMcpSamplingRequest,
  createPiMcpSamplingPort,
  isPiMcpSamplingError,
  PI_MCP_CONTINUITY_META_KEY,
  type PiMcpSamplingError,
  type PiMcpSamplingRequest,
} from "../src/index.ts";

function testSamplingPort(
  response: Parameters<typeof fauxAssistantMessage>[0] | string = "sampled response",
  options: Readonly<{ readonly input?: readonly ("text" | "image")[] }> = {},
) {
  const contexts: Context[] = [];
  const streamOptions: SimpleStreamOptions[] = [];
  const models = createModels();
  const provider = fauxProvider({
    provider: "mcp-sampling-test",
    models: [
      {
        id: "sampling-model",
        input: [...(options.input ?? ["text", "image"])],
        contextWindow: 8_000,
        maxTokens: 512,
      },
    ],
  });
  provider.setResponses([
    (context, requestOptions) => {
      contexts.push(structuredClone(context));
      streamOptions.push({ ...requestOptions });
      return typeof response === "string" ? fauxAssistantMessage(response) : fauxAssistantMessage(response);
    },
  ]);
  models.setProvider(provider.provider);
  return {
    contexts,
    streamOptions,
    port: createPiMcpSamplingPort({
      models,
      provider: "mcp-sampling-test",
      model: "sampling-model",
      reasoning: "high",
    }),
  };
}

function request(params: Partial<PiMcpSamplingRequest["params"]> = {}): PiMcpSamplingRequest {
  return {
    params: {
      messages: [{ role: "user", content: { type: "text", text: "hello" } }],
      maxTokens: 1_000,
      ...params,
    },
  };
}

async function expectSamplingError(promise: Promise<unknown>, code: PiMcpSamplingError["code"]) {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(isPiMcpSamplingError(failure)).toBe(true);
  if (!isPiMcpSamplingError(failure)) throw new Error("Expected a Pi MCP sampling error");
  expect(failure.code).toBe(code);
}

describe("Pi MCP sampling adapter", () => {
  test("validates unknown protocol requests before invoking the sampling port", () => {
    let called = false;

    expect(() =>
      adaptMcpSamplingRequest(
        Object.freeze({
          sample: async () => {
            called = true;
            return Object.freeze({
              model: "unused",
              role: "assistant" as const,
              content: Object.freeze({ type: "text" as const, text: "unused" }),
            });
          },
        }),
        { params: { messages: "not-an-array", maxTokens: 32 } },
      ),
    ).toThrow();
    expect(called).toBe(false);
  });

  test("accepts the SDK sampling/createMessage request envelope", async () => {
    const { port } = testSamplingPort("enveloped response");

    await expect(
      adaptMcpSamplingRequest(port, {
        method: "sampling/createMessage",
        params: {
          messages: [{ role: "user", content: { type: "text", text: "hello" } }],
          maxTokens: 32,
        },
      }),
    ).resolves.toMatchObject({
      role: "assistant",
      content: { type: "text", text: "enveloped response" },
    });
  });

  test("accepts SDK-valid omitted tool-result content and integer maxTokens", async () => {
    const { contexts, port } = testSamplingPort("normalized response");

    await expect(
      adaptMcpSamplingRequest(port, {
        method: "sampling/createMessage",
        params: {
          messages: [
            {
              role: "assistant",
              content: { type: "tool_use", id: "call-empty", name: "lookup", input: {} },
            },
            {
              role: "user",
              content: { type: "tool_result", toolUseId: "call-empty" },
            },
          ],
          maxTokens: 0,
        },
      }),
    ).resolves.toMatchObject({ role: "assistant" });
    expect(contexts[0]?.messages).toMatchObject([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-empty", name: "lookup", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call-empty",
        toolName: "lookup",
        content: [],
      },
    ]);
  });

  test("maps text and image input, request options, and rich text plus tool-use output", async () => {
    const { contexts, streamOptions, port } = testSamplingPort([
      fauxText("inspect this"),
      fauxToolCall("lookup", { id: 7 }, { id: "call-7" }),
    ]);

    const result = await port.sample(
      request({
        systemPrompt: "bounded server prompt",
        modelPreferences: { hints: [{ name: "advisory-only" }] },
        temperature: 0.25,
        maxTokens: 900,
        metadata: { source: "fixture" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
            ],
          },
        ],
        tools: [
          {
            name: "lookup",
            description: "Look up one item",
            inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
          },
        ],
      }),
    );

    expect(contexts[0]).toMatchObject({
      systemPrompt: "bounded server prompt",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          ],
        },
      ],
      tools: [{ name: "lookup", description: "Look up one item" }],
    });
    expect(streamOptions[0]).toMatchObject({
      maxTokens: 512,
      temperature: 0.25,
      reasoning: "high",
      metadata: { source: "fixture" },
    });
    expect(result).toMatchObject({
      role: "assistant",
      model: "sampling-model",
      stopReason: "toolUse",
      content: [
        { type: "text", text: "inspect this" },
        { type: "tool_use", id: "call-7", name: "lookup", input: { id: 7 } },
      ],
    });
  });

  test("preserves assistant tool use followed by the matching user tool result", async () => {
    const { contexts, port } = testSamplingPort("done");

    await port.sample(
      request({
        messages: [
          {
            role: "assistant",
            content: { type: "tool_use", id: "call-1", name: "lookup", input: { query: "Noesis" } },
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "call-1",
                content: [{ type: "text", text: "result" }],
                structuredContent: { count: 1 },
              },
              { type: "text", text: "summarize" },
            ],
          },
        ],
      }),
    );

    expect(contexts[0]?.messages).toMatchObject([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: { query: "Noesis" } }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "lookup",
        content: [
          { type: "text", text: "result" },
          { type: "text", text: 'Structured tool result:\n{"count":1}' },
        ],
      },
      { role: "user", content: [{ type: "text", text: "summarize" }] },
    ]);
  });

  test("rejects a tool result that precedes its matching tool use", async () => {
    const { port } = testSamplingPort("unused");

    await expectSamplingError(
      port.sample(
        request({
          messages: [
            {
              role: "user",
              content: {
                type: "tool_result",
                toolUseId: "call-future",
                content: [{ type: "text", text: "not valid yet" }],
              },
            },
            {
              role: "assistant",
              content: { type: "tool_use", id: "call-future", name: "lookup", input: {} },
            },
          ],
        }),
      ),
      "invalid_request",
    );
  });

  test("rejects reusing one tool use for multiple tool results", async () => {
    const { port } = testSamplingPort("unused");

    await expectSamplingError(
      port.sample(
        request({
          messages: [
            {
              role: "assistant",
              content: { type: "tool_use", id: "call-once", name: "lookup", input: {} },
            },
            {
              role: "user",
              content: {
                type: "tool_result",
                toolUseId: "call-once",
                content: [{ type: "text", text: "first" }],
              },
            },
            {
              role: "user",
              content: {
                type: "tool_result",
                toolUseId: "call-once",
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        }),
      ),
      "invalid_request",
    );
  });

  test("round-trips provider continuity signatures through namespaced MCP metadata", async () => {
    const { contexts, port } = testSamplingPort([
      { ...fauxText("next"), textSignature: "text-signature-next" },
      {
        ...fauxToolCall("lookup", { query: "Noesis" }, { id: "call-next" }),
        thoughtSignature: "thought-signature-next",
      },
    ]);

    const result = await port.sample(
      request({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "previous",
                _meta: {
                  unrelated: { preserved: true },
                  [PI_MCP_CONTINUITY_META_KEY]: { textSignature: "text-signature-previous" },
                },
              },
              {
                type: "tool_use",
                id: "call-previous",
                name: "lookup",
                input: { query: "prior" },
                _meta: {
                  [PI_MCP_CONTINUITY_META_KEY]: { thoughtSignature: "thought-signature-previous" },
                },
              },
            ],
          },
          {
            role: "user",
            content: {
              type: "tool_result",
              toolUseId: "call-previous",
              content: [
                {
                  type: "text",
                  text: "result",
                  _meta: { server: "preserved" },
                },
              ],
              _meta: { round: 2 },
            },
          },
        ],
      }),
    );

    expect(contexts[0]?.messages).toMatchObject([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "previous",
            textSignature: "text-signature-previous",
            _meta: {
              unrelated: { preserved: true },
              [PI_MCP_CONTINUITY_META_KEY]: { textSignature: "text-signature-previous" },
            },
          },
          {
            type: "toolCall",
            thoughtSignature: "thought-signature-previous",
            _meta: {
              [PI_MCP_CONTINUITY_META_KEY]: { thoughtSignature: "thought-signature-previous" },
            },
          },
        ],
      },
      {
        role: "toolResult",
        _meta: { round: 2 },
        content: [{ type: "text", text: "result", _meta: { server: "preserved" } }],
      },
    ]);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "next",
        _meta: {
          [PI_MCP_CONTINUITY_META_KEY]: { textSignature: "text-signature-next" },
        },
      },
      {
        type: "tool_use",
        id: "call-next",
        name: "lookup",
        input: { query: "Noesis" },
        _meta: {
          [PI_MCP_CONTINUITY_META_KEY]: { thoughtSignature: "thought-signature-next" },
        },
      },
    ]);
  });

  test("rejects malformed Noesis continuity metadata", async () => {
    const { port } = testSamplingPort();
    await expectSamplingError(
      port.sample(
        request({
          messages: [
            {
              role: "assistant",
              content: {
                type: "text",
                text: "previous",
                _meta: { [PI_MCP_CONTINUITY_META_KEY]: { textSignature: 42 } },
              },
            },
          ],
        }),
      ),
      "invalid_request",
    );
  });

  test("requires the model to honor required tool choice", async () => {
    const { port } = testSamplingPort("ignored requirement");
    await expectSamplingError(
      port.sample(
        request({
          toolChoice: { mode: "required" },
          tools: [{ name: "lookup", inputSchema: { type: "object" } }],
        }),
      ),
      "model_response",
    );
  });

  test("propagates cancellation and rejects missing model or auth", async () => {
    const controlled = testSamplingPort();
    const controller = new AbortController();
    controller.abort();
    await expectSamplingError(controlled.port.sample(request(), { signal: controller.signal }), "aborted");

    const emptyModels = createModels();
    await expectSamplingError(
      createPiMcpSamplingPort({
        models: emptyModels,
        provider: "missing",
        model: "missing",
      }).sample(request()),
      "model_not_found",
    );

    const unconfigured = createModels();
    const provider = fauxProvider({ provider: "unconfigured" });
    unconfigured.setProvider({
      ...provider.provider,
      auth: { apiKey: { name: "Unavailable test auth", resolve: async () => undefined } },
    });
    await expectSamplingError(
      createPiMcpSamplingPort({
        models: unconfigured,
        provider: "unconfigured",
        model: provider.getModel().id,
      }).sample(request()),
      "missing_auth",
    );
  });

  test.each([
    {
      name: "audio input",
      params: {
        messages: [
          { role: "user" as const, content: { type: "audio" as const, data: "YQ==", mimeType: "audio/wav" } },
        ],
      },
    },
    {
      name: "assistant image",
      params: {
        messages: [
          {
            role: "assistant" as const,
            content: { type: "image" as const, data: "aQ==", mimeType: "image/png" },
          },
        ],
      },
    },
    { name: "stop sequences", params: { stopSequences: ["STOP"] } },
  ])("rejects unsupported $name without lossy conversion", async ({ params }) => {
    const { port } = testSamplingPort();
    await expectSamplingError(port.sample(request(params)), "unsupported");
  });
});
