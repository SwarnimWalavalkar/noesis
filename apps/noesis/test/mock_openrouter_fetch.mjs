function messageText(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) =>
      part && typeof part === "object" && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("");
}

function completionText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = [
    ...messages.filter((message) => message?.role === "system").map(messageText),
    ...(Array.isArray(body?.system) ? body.system.map(messageText) : []),
  ].join("\n");
  if (system.includes("role: reflector"))
    return JSON.stringify({
      observation: {
        kind: "other",
        reason: "The controlled provider found no correction or reusable preference.",
      },
      decision: "no_change",
      reason: "The controlled Pi provider found no durable change.",
    });
  const lastUser = [...messages].reverse().find((message) => message?.role === "user");
  return `Controlled Pi completion for: ${messageText(lastUser)}`;
}

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const openAiCompletions = url.startsWith("https://openrouter.ai/api/v1/chat/completions");
  const anthropicMessages = url.startsWith("https://openrouter.ai/api/v1/messages");
  if (!openAiCompletions && !anthropicMessages)
    throw new Error(`Unexpected network request in controlled OpenRouter fixture: ${url}`);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  const text = completionText(body);
  const id = `controlled-${Date.now()}`;
  const model = typeof body.model === "string" ? body.model : "anthropic/claude-sonnet-4.5";
  const textChunks = text.match(/[\s\S]{1,120}/gu) ?? [text];
  const payloads = anthropicMessages
    ? [
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 32, output_tokens: 0 },
          },
        })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        })}\n\n`,
        ...textChunks.map(
          (content) =>
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: content },
            })}\n\n`,
        ),
        `event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: 0,
        })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 16 },
        })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ]
    : [
        ...textChunks.map(
          (content) =>
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
            })}\n\n`,
        ),
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 32, completion_tokens: 16, total_tokens: 48 },
        })}\n\n`,
        "data: [DONE]\n\n",
      ];
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 8));
      const payload = payloads[index];
      if (payload === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(payload));
      index += 1;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};
