import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";

export const CONTROLLED_PI_PROVIDER = "controlled-pi";
export const CONTROLLED_PI_MODEL = "controlled-model";

export interface ControlledPiPrompt {
  readonly systemPrompt: string;
  readonly lastUserText: string;
  readonly context: Context;
}

export interface CreateControlledPiModelsOptions {
  readonly respond?: (
    prompt: ControlledPiPrompt,
  ) => string | AssistantMessage | Promise<string | AssistantMessage>;
  readonly responseBudget?: number;
  readonly tokensPerSecond?: number;
}

export function controlledToolCallResponse(
  name: string,
  input: Readonly<Record<string, unknown>>,
  id: string,
): AssistantMessage {
  return fauxAssistantMessage(fauxToolCall(name, input, { id }), { stopReason: "toolUse" });
}

function contentText(content: Context["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((part) => {
      if (part.type === "text") return [part.text];
      if (part.type === "thinking") return [part.thinking];
      return [];
    })
    .join("");
}

export function createControlledPiModels(options: CreateControlledPiModelsOptions = {}) {
  const models = createModels();
  const provider = fauxProvider({
    provider: CONTROLLED_PI_PROVIDER,
    models: [{ id: CONTROLLED_PI_MODEL, contextWindow: 8_000, maxTokens: 1_000 }],
    ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }),
  });
  const respond =
    options.respond ?? ((prompt: ControlledPiPrompt) => `Controlled completion for: ${prompt.lastUserText}`);
  const responseFactory = async (context: Context) => {
    const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
    const response = await respond({
      systemPrompt: context.systemPrompt ?? "",
      lastUserText: lastUser ? contentText(lastUser.content) : "",
      context,
    });
    return typeof response === "string" ? fauxAssistantMessage(response) : response;
  };
  provider.setResponses(Array.from({ length: options.responseBudget ?? 100 }, () => responseFactory));
  models.setProvider(provider.provider);
  return Object.freeze({ models, provider });
}
