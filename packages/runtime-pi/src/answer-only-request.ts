import type { Api, AssistantMessage } from "@earendil-works/pi-ai";
import { z } from "zod";

const objectPayload = z.looseObject({});
const googlePayload = z.looseObject({ config: z.looseObject({}).optional() });

/**
 * Forbid tool calls in one provider payload while leaving its tool definitions in place. Each branch
 * is that API's own wire shape. An API without a way to say this is unchanged, and the response
 * guard in `withoutToolCalls` still ends the task.
 */
export function forbidToolCallsInPayload<Payload>(api: Api, payload: Payload) {
  const object = objectPayload.safeParse(payload);
  if (!object.success) return payload;
  switch (api) {
    case "anthropic-messages":
      return { ...object.data, tool_choice: { type: "none" } };
    case "openai-completions":
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      return { ...object.data, tool_choice: "none" };
    case "mistral-conversations":
      return { ...object.data, toolChoice: "none" };
    case "google-generative-ai":
    case "google-vertex": {
      const google = googlePayload.parse(object.data);
      return {
        ...google,
        config: { ...google.config, toolConfig: { functionCallingConfig: { mode: "NONE" } } },
      };
    }
    default:
      return payload;
  }
}

/** The same answer with any tool calls removed, so the model's turn ends here. */
export function withoutToolCalls<Message extends AssistantMessage>(message: Message): Message {
  if (message.stopReason !== "toolUse" && !message.content.some((part) => part.type === "toolCall"))
    return message;
  return {
    ...message,
    content: message.content.filter((part) => part.type !== "toolCall"),
    stopReason: message.stopReason === "toolUse" ? "stop" : message.stopReason,
  };
}
