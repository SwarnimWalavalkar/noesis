import { createConditionalObject, type JsonObject, type JsonValue, JsonValueSchema } from "@noesis/domain";
import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  Model,
  Models,
  SimpleStreamOptions,
  TextContent,
  Tool,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { z } from "zod";
export const PI_MCP_CONTINUITY_META_KEY = "io.noesis/pi-continuity";
const McpMetaSchema = z.record(z.string(), z.json());
const PiContinuityMetaSchema = z.strictObject({
  textSignature: z.string().min(1).optional(),
  thoughtSignature: z.string().min(1).optional(),
});
type ValidatedMcpMeta = Readonly<z.infer<typeof McpMetaSchema>>;
type PiContinuityMeta = Readonly<z.infer<typeof PiContinuityMetaSchema>>;
interface McpMetadataCarrier {
  readonly _meta?: ValidatedMcpMeta;
}
export type PiMcpSamplingErrorCode =
  | "aborted"
  | "invalid_request"
  | "missing_auth"
  | "model_not_found"
  | "model_response"
  | "unsupported";
export interface PiMcpSamplingError extends Error {
  readonly name: "PiMcpSamplingError";
  readonly code: PiMcpSamplingErrorCode;
}
export function createPiMcpSamplingError(
  code: PiMcpSamplingErrorCode,
  message: string,
  options?: Readonly<{
    readonly cause?: unknown;
  }>,
): PiMcpSamplingError {
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.assign(new Error(message, options), {
    name: "PiMcpSamplingError" as const,
    code,
  });
}
export function isPiMcpSamplingError(value: unknown): value is PiMcpSamplingError {
  if (!(value instanceof Error) || value.name !== "PiMcpSamplingError") return false;
  if (!("code" in value)) return false;
  const code = value.code;
  return (
    code === "aborted" ||
    code === "invalid_request" ||
    code === "missing_auth" ||
    code === "model_not_found" ||
    code === "model_response" ||
    code === "unsupported"
  );
}
export interface PiMcpTextContent {
  readonly type: "text";
  readonly text: string;
  readonly annotations?: JsonObject;
  readonly _meta?: JsonObject;
}
export interface PiMcpImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
  readonly annotations?: JsonObject;
  readonly _meta?: JsonObject;
}
export interface PiMcpAudioContent {
  readonly type: "audio";
  readonly data: string;
  readonly mimeType: string;
  readonly annotations?: JsonObject;
  readonly _meta?: JsonObject;
}
export interface PiMcpResourceLinkContent {
  readonly type: "resource_link";
  readonly uri: string;
  readonly name: string;
  readonly [key: string]: JsonValue;
}
export interface PiMcpEmbeddedResourceContent {
  readonly type: "resource";
  readonly resource: JsonObject;
  readonly [key: string]: JsonValue;
}
export type PiMcpToolResultBlock =
  | PiMcpTextContent
  | PiMcpImageContent
  | PiMcpAudioContent
  | PiMcpResourceLinkContent
  | PiMcpEmbeddedResourceContent;
export interface PiMcpToolUseContent {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
  readonly _meta?: JsonObject;
}
export interface PiMcpToolResultContent {
  readonly type: "tool_result";
  readonly toolUseId: string;
  readonly content: readonly PiMcpToolResultBlock[];
  readonly structuredContent?: JsonObject;
  readonly isError?: boolean;
  readonly _meta?: JsonObject;
}
export type PiMcpSamplingContent =
  | PiMcpTextContent
  | PiMcpImageContent
  | PiMcpAudioContent
  | PiMcpToolUseContent
  | PiMcpToolResultContent;
export interface PiMcpSamplingMessage {
  readonly role: "user" | "assistant";
  readonly content: PiMcpSamplingContent | readonly PiMcpSamplingContent[];
  readonly _meta?: JsonObject;
}
export interface PiMcpSamplingTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
}
export interface PiMcpSamplingRequestParams {
  readonly messages: readonly PiMcpSamplingMessage[];
  readonly modelPreferences?: JsonObject;
  readonly systemPrompt?: string;
  readonly includeContext?: "none" | "thisServer" | "allServers";
  readonly temperature?: number;
  readonly maxTokens: number;
  readonly stopSequences?: readonly string[];
  readonly metadata?: JsonObject;
  readonly tools?: readonly PiMcpSamplingTool[];
  readonly toolChoice?: Readonly<{
    readonly mode?: "auto" | "required" | "none";
  }>;
  /** Preserved for the MCP host's task machinery. The Pi sampling adapter does not own task state. */
  readonly task?: Readonly<{
    readonly ttl?: number | null;
    readonly pollInterval?: number;
  }>;
  readonly _meta?: JsonObject;
}
export interface PiMcpSamplingRequest {
  readonly params: PiMcpSamplingRequestParams;
}
const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
const SamplingTextContentSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
  annotations: JsonObjectSchema.optional(),
  _meta: JsonObjectSchema.optional(),
});
const SamplingImageContentSchema = z.looseObject({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
  annotations: JsonObjectSchema.optional(),
  _meta: JsonObjectSchema.optional(),
});
const SamplingAudioContentSchema = z.looseObject({
  type: z.literal("audio"),
  data: z.string(),
  mimeType: z.string(),
  annotations: JsonObjectSchema.optional(),
  _meta: JsonObjectSchema.optional(),
});
const SamplingResourceLinkContentSchema = z.looseObject({
  type: z.literal("resource_link"),
  uri: z.string(),
  name: z.string(),
});
const SamplingEmbeddedResourceContentSchema = z.looseObject({
  type: z.literal("resource"),
  resource: JsonObjectSchema,
});
const SamplingToolUseContentSchema = z.looseObject({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
  input: JsonObjectSchema,
  _meta: JsonObjectSchema.optional(),
});
const SamplingToolResultContentSchema = z.looseObject({
  type: z.literal("tool_result"),
  toolUseId: z.string().min(1),
  content: z
    .array(
      z.union([
        SamplingTextContentSchema,
        SamplingImageContentSchema,
        SamplingAudioContentSchema,
        SamplingResourceLinkContentSchema,
        SamplingEmbeddedResourceContentSchema,
      ]),
    )
    .default([]),
  structuredContent: JsonObjectSchema.optional(),
  isError: z.boolean().optional(),
  _meta: JsonObjectSchema.optional(),
});
const SamplingContentSchema = z.union([
  SamplingTextContentSchema,
  SamplingImageContentSchema,
  SamplingAudioContentSchema,
  SamplingToolUseContentSchema,
  SamplingToolResultContentSchema,
]);
const UntrustedPiMcpSamplingRequestSchema = z.strictObject({
  method: z.literal("sampling/createMessage"),
  params: z.looseObject({
    messages: z.array(
      z.looseObject({
        role: z.enum(["user", "assistant"]),
        content: z.union([SamplingContentSchema, z.array(SamplingContentSchema)]),
        _meta: JsonObjectSchema.optional(),
      }),
    ),
    modelPreferences: JsonObjectSchema.optional(),
    systemPrompt: z.string().optional(),
    includeContext: z.enum(["none", "thisServer", "allServers"]).optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().int(),
    stopSequences: z.array(z.string()).optional(),
    metadata: JsonObjectSchema.optional(),
    tools: z
      .array(
        z.looseObject({
          name: z.string().min(1),
          description: z.string().optional(),
          inputSchema: JsonObjectSchema,
        }),
      )
      .optional(),
    toolChoice: z.looseObject({ mode: z.enum(["auto", "required", "none"]).optional() }).optional(),
    task: z
      .looseObject({ ttl: z.number().nullable().optional(), pollInterval: z.number().optional() })
      .optional(),
    _meta: JsonObjectSchema.optional(),
  }),
});
const PiMcpSamplingRequestSchema = z.preprocess(
  (value) => UntrustedPiMcpSamplingRequestSchema.parse(value),
  z.custom<PiMcpSamplingRequest>(() => true),
);
export interface PiMcpSamplingResult {
  readonly model: string;
  readonly role: "assistant";
  readonly content:
    | PiMcpTextContent
    | PiMcpToolUseContent
    | readonly (PiMcpTextContent | PiMcpToolUseContent)[];
  readonly stopReason?: "endTurn" | "maxTokens" | "toolUse" | string;
}
export interface PiMcpSamplingPort {
  readonly sample: (
    request: PiMcpSamplingRequest,
    options?: Readonly<{
      readonly signal?: AbortSignal;
      readonly route?: Readonly<{
        readonly provider: string;
        readonly model: string;
        readonly reasoning: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
      }>;
    }>,
  ) => Promise<PiMcpSamplingResult>;
}
/** Protocol-facing boundary kept here so app composition never imports Pi model/runtime types. */
// BOUNDARY: The MCP SDK owns the incoming request shape; the adapter parses it before sampling.
export function adaptMcpSamplingRequest(
  port: PiMcpSamplingPort,
  request: unknown,
  signal?: AbortSignal,
  route?: Readonly<{
    readonly provider: string;
    readonly model: string;
    readonly reasoning: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  }>,
): Promise<PiMcpSamplingResult> {
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return port.sample(
    PiMcpSamplingRequestSchema.parse(request),
    createConditionalObject({} as const)
      .addOptional(signal ? { signal } : undefined)
      .addOptional(route ? { route } : undefined)
      .finish(),
  );
}
export interface CreatePiMcpSamplingPortInput {
  readonly models: Models;
  readonly provider: string;
  readonly model: string;
  readonly reasoning?: SimpleStreamOptions["reasoning"] | "off";
}
const EMPTY_USAGE = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});
function blocks(content: PiMcpSamplingMessage["content"]): readonly PiMcpSamplingContent[] {
  return isSamplingContentArray(content) ? content : [content];
}
function isSamplingContentArray(
  content: PiMcpSamplingMessage["content"],
): content is readonly PiMcpSamplingContent[] {
  return Array.isArray(content);
}
function unsupported(message: string): never {
  throw createPiMcpSamplingError("unsupported", message);
}
function validatedMcpMeta(meta: JsonObject | undefined): ValidatedMcpMeta | undefined {
  if (meta === undefined) return undefined;
  const parsed = McpMetaSchema.safeParse(meta);
  if (!parsed.success)
    throw createPiMcpSamplingError("invalid_request", "MCP sampling content _meta must contain JSON values", {
      cause: parsed.error,
    });
  return Object.freeze({ ...parsed.data });
}
function continuityMeta(meta: ValidatedMcpMeta | undefined): PiContinuityMeta | undefined {
  if (!meta || !(PI_MCP_CONTINUITY_META_KEY in meta)) return undefined;
  const parsed = PiContinuityMetaSchema.safeParse(meta[PI_MCP_CONTINUITY_META_KEY]);
  if (!parsed.success)
    throw createPiMcpSamplingError(
      "invalid_request",
      `MCP sampling ${PI_MCP_CONTINUITY_META_KEY} metadata is malformed`,
      { cause: parsed.error },
    );
  return parsed.data;
}
function outputMeta(continuity: PiContinuityMeta): ValidatedMcpMeta | undefined {
  const payload =
    continuity.textSignature !== undefined && continuity.thoughtSignature !== undefined
      ? { textSignature: continuity.textSignature, thoughtSignature: continuity.thoughtSignature }
      : continuity.textSignature !== undefined
        ? { textSignature: continuity.textSignature }
        : continuity.thoughtSignature !== undefined
          ? { thoughtSignature: continuity.thoughtSignature }
          : undefined;
  if (!payload) return undefined;
  return Object.freeze({
    [PI_MCP_CONTINUITY_META_KEY]: Object.freeze(payload),
  });
}
function piTextContent(block: PiMcpTextContent): TextContent & McpMetadataCarrier {
  const meta = validatedMcpMeta(block._meta);
  const continuity = continuityMeta(meta);
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze(
    createConditionalObject({
      type: "text",
      text: block.text,
    } as const)
      .addOptional(continuity?.textSignature ? { textSignature: continuity.textSignature } : undefined)
      .addOptional(meta ? { _meta: meta } : undefined)
      .finish(),
  );
}
function piImageContent(block: PiMcpImageContent): ImageContent & McpMetadataCarrier {
  const meta = validatedMcpMeta(block._meta);
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze(
    createConditionalObject({
      type: "image",
      data: block.data,
      mimeType: block.mimeType,
    } as const)
      .addOptional(meta ? { _meta: meta } : undefined)
      .finish(),
  );
}
function validateToolUse(block: PiMcpToolUseContent): ToolCall & McpMetadataCarrier {
  if (!block.id || !block.name)
    throw createPiMcpSamplingError("invalid_request", "MCP sampling tool-use blocks require an id and name");
  const meta = validatedMcpMeta(block._meta);
  const continuity = continuityMeta(meta);
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze(
    createConditionalObject({
      type: "toolCall",
      id: block.id,
      name: block.name,
      arguments: { ...block.input },
    } as const)
      .addOptional(
        continuity?.thoughtSignature ? { thoughtSignature: continuity.thoughtSignature } : undefined,
      )
      .addOptional(meta ? { _meta: meta } : undefined)
      .finish(),
  );
}
function priorAssistantMessage(
  message: PiMcpSamplingMessage,
  model: Model<Api>,
  timestamp: number,
): AssistantMessage {
  const content = blocks(message.content).map((block): TextContent | ToolCall => {
    if (block.type === "text") return piTextContent(block);
    if (block.type === "tool_use") return validateToolUse(block);
    if (block.type === "image")
      return unsupported("The configured Pi model adapter cannot represent images in assistant history");
    if (block.type === "audio")
      return unsupported("The configured Pi model adapter cannot represent MCP audio content");
    return unsupported("MCP tool-result blocks must be carried by user messages");
  });
  return Object.freeze({
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
    timestamp,
  });
}
function directUserMessage(
  content: readonly (PiMcpTextContent | PiMcpImageContent)[],
  model: Model<Api>,
  timestamp: number,
): UserMessage | undefined {
  const direct = content.map((block): TextContent | ImageContent => {
    if (block.type === "text") return piTextContent(block);
    if (!model.input.includes("image"))
      return unsupported(`Configured model ${model.provider}/${model.id} does not accept image input`);
    return piImageContent(block);
  });
  if (direct.length === 0) return undefined;
  return Object.freeze({ role: "user", content: direct, timestamp });
}
function toolResultBlocks(
  block: PiMcpToolResultContent,
  model: Model<Api>,
): readonly (TextContent | ImageContent)[] {
  const result: (TextContent | ImageContent)[] = [];
  for (const item of block.content) {
    if (item.type === "text") result.push(piTextContent(item));
    else if (item.type === "image") {
      if (!model.input.includes("image"))
        unsupported(`Configured model ${model.provider}/${model.id} does not accept image input`);
      result.push(piImageContent(item));
    } else if (item.type === "audio")
      unsupported("The configured Pi model adapter cannot represent MCP audio tool results");
    else unsupported(`The configured Pi model adapter cannot represent MCP ${item.type} tool results`);
  }
  if (block.structuredContent)
    result.push(
      Object.freeze({
        type: "text",
        text: `Structured tool result:\n${JSON.stringify(block.structuredContent)}`,
      }),
    );
  return Object.freeze(result);
}
function priorUserMessages(
  message: PiMcpSamplingMessage,
  toolNames: Map<string, string>,
  model: Model<Api>,
  timestamp: number,
): readonly Message[] {
  const content = blocks(message.content);
  const result: Message[] = [];
  let direct: (PiMcpTextContent | PiMcpImageContent)[] = [];
  const flushDirect = (): void => {
    const user = directUserMessage(direct, model, timestamp);
    if (user) result.push(user);
    direct = [];
  };
  for (const block of content) {
    if (block.type === "text" || block.type === "image") {
      direct.push(block);
      continue;
    }
    if (block.type === "audio")
      unsupported("The configured Pi model adapter cannot represent MCP audio content");
    if (block.type === "tool_use") unsupported("MCP tool-use blocks must be carried by assistant messages");
    flushDirect();
    const toolName = toolNames.get(block.toolUseId);
    if (!toolName)
      throw createPiMcpSamplingError(
        "invalid_request",
        `MCP tool result ${block.toolUseId} has no preceding tool-use block`,
      );
    toolNames.delete(block.toolUseId);
    const meta = validatedMcpMeta(block._meta);
    const toolResult: ToolResultMessage & McpMetadataCarrier = Object.freeze(
      createConditionalObject({
        role: "toolResult",
        toolCallId: block.toolUseId,
        toolName,
        content: [...toolResultBlocks(block, model)],
        isError: block.isError ?? false,
        timestamp,
      } satisfies Pick<
        ToolResultMessage & McpMetadataCarrier,
        "role" | "toolCallId" | "toolName" | "content" | "isError" | "timestamp"
      >)
        .addOptional(meta ? { _meta: meta } : undefined)
        .finish(),
    );
    result.push(toolResult);
  }
  flushDirect();
  return Object.freeze(result);
}
function piMessages(request: PiMcpSamplingRequest, model: Model<Api>): readonly Message[] {
  const toolNames = new Map<string, string>();
  const seenToolIds = new Set<string>();
  const baseTimestamp = Date.now() - request.params.messages.length;
  const messages: Message[] = [];
  for (const [index, message] of request.params.messages.entries()) {
    const timestamp = baseTimestamp + index;
    if (message.role === "user") {
      messages.push(...priorUserMessages(message, toolNames, model, timestamp));
      continue;
    }
    messages.push(priorAssistantMessage(message, model, timestamp));
    for (const block of blocks(message.content)) {
      if (block.type !== "tool_use") continue;
      if (seenToolIds.has(block.id))
        throw createPiMcpSamplingError("invalid_request", `MCP sampling reused tool-use id ${block.id}`);
      seenToolIds.add(block.id);
      toolNames.set(block.id, block.name);
    }
  }
  return Object.freeze(messages);
}
function piTools(request: PiMcpSamplingRequest): readonly Tool[] | undefined {
  const mode = request.params.toolChoice?.mode ?? "auto";
  if (mode === "none") return undefined;
  const definitions = request.params.tools ?? [];
  if (mode === "required" && definitions.length === 0)
    throw createPiMcpSamplingError("invalid_request", "MCP sampling requires a tool but supplied no tools");
  if (definitions.length === 0) return undefined;
  const names = new Set<string>();
  return Object.freeze(
    definitions.map((definition): Tool => {
      if (!definition.name || names.has(definition.name))
        throw createPiMcpSamplingError(
          "invalid_request",
          names.has(definition.name)
            ? `MCP sampling supplied duplicate tool ${definition.name}`
            : "MCP sampling tools require a name",
        );
      names.add(definition.name);
      return Object.freeze({
        name: definition.name,
        description: definition.description ?? "",
        parameters: definition.inputSchema,
      });
    }),
  );
}
function samplingSystemPrompt(request: PiMcpSamplingRequest): string | undefined {
  if (request.params.toolChoice?.mode !== "required") return request.params.systemPrompt;
  const requirement = "You must call at least one of the supplied tools in this response.";
  return request.params.systemPrompt ? `${request.params.systemPrompt}\n\n${requirement}` : requirement;
}
function outputContent(message: AssistantMessage): readonly (PiMcpTextContent | PiMcpToolUseContent)[] {
  const visible = message.content.flatMap((part): readonly (PiMcpTextContent | PiMcpToolUseContent)[] => {
    if (part.type === "text") {
      const meta = outputMeta(part.textSignature ? { textSignature: part.textSignature } : {});
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return [
        Object.freeze(
          createConditionalObject({
            type: "text",
            text: part.text,
          } as const)
            .addOptional(meta ? { _meta: meta } : undefined)
            .finish(),
        ),
      ];
    }
    if (part.type === "toolCall") {
      const meta = outputMeta(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {});
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return [
        Object.freeze(
          createConditionalObject({
            type: "tool_use",
            id: part.id,
            name: part.name,
            input: Object.freeze({ ...part.arguments }),
          } as const)
            .addOptional(meta ? { _meta: meta } : undefined)
            .finish(),
        ),
      ];
    }
    return [];
  });
  return visible.length > 0 ? Object.freeze(visible) : Object.freeze([{ type: "text", text: "" }]);
}
function stopReason(reason: AssistantMessage["stopReason"]): string {
  if (reason === "stop") return "endTurn";
  if (reason === "length") return "maxTokens";
  if (reason === "toolUse") return "toolUse";
  return reason;
}
export function createPiMcpSamplingPort(input: CreatePiMcpSamplingPortInput): PiMcpSamplingPort {
  const sample: PiMcpSamplingPort["sample"] = async (request, options) => {
    if (options?.signal?.aborted)
      throw createPiMcpSamplingError("aborted", "MCP sampling was aborted before it started");
    if (request.params.stopSequences && request.params.stopSequences.length > 0)
      throw createPiMcpSamplingError(
        "unsupported",
        "The configured Pi model adapter cannot forward MCP stop sequences",
      );
    const provider = options?.route?.provider ?? input.provider;
    const modelId = options?.route?.model ?? input.model;
    const model = input.models.getModel(provider, modelId);
    if (!model)
      throw createPiMcpSamplingError("model_not_found", `Pi model not found: ${provider}/${modelId}`);
    const auth = await input.models.getAuth(model);
    if (!auth)
      throw createPiMcpSamplingError(
        "missing_auth",
        `Authentication is not configured for ${provider}/${modelId}`,
      );
    const tools = piTools(request);
    const systemPrompt = samplingSystemPrompt(request);
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const context: Context = createConditionalObject({} as const)
      .addOptional(!(systemPrompt === undefined) ? { systemPrompt } : undefined)
      .add({
        messages: [...piMessages(request, model)],
      } satisfies Pick<Context, "messages">)
      .addOptional(tools ? { tools: [...tools] } : undefined)
      .finish();
    const maxTokens = Math.max(1, Math.min(Math.floor(request.params.maxTokens), model.maxTokens));
    const requestedReasoning = options?.route?.reasoning ?? input.reasoning;
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const streamOptions: SimpleStreamOptions = createConditionalObject({
      maxTokens,
    } as const)
      .addOptional(
        !(request.params.temperature === undefined) ? { temperature: request.params.temperature } : undefined,
      )
      .addOptional(
        requestedReasoning && requestedReasoning !== "off" ? { reasoning: requestedReasoning } : undefined,
      )
      .addOptional(request.params.metadata ? { metadata: { ...request.params.metadata } } : undefined)
      .addOptional(options?.signal ? { signal: options.signal } : undefined)
      .finish();
    let response: AssistantMessage;
    try {
      response = await input.models.completeSimple(model, context, streamOptions);
    } catch (error) {
      if (options?.signal?.aborted)
        throw createPiMcpSamplingError("aborted", "MCP sampling was aborted", { cause: error });
      throw createPiMcpSamplingError("model_response", "Pi model sampling failed", { cause: error });
    }
    if (response.stopReason === "aborted")
      throw createPiMcpSamplingError("aborted", response.errorMessage ?? "MCP sampling was aborted");
    if (response.stopReason === "error")
      throw createPiMcpSamplingError("model_response", response.errorMessage ?? "Pi model sampling failed");
    const content = outputContent(response);
    const usedTool = content.some((part) => part.type === "tool_use");
    if (request.params.toolChoice?.mode === "required" && !usedTool)
      throw createPiMcpSamplingError(
        "model_response",
        "The model did not satisfy the MCP request's required tool choice",
      );
    return Object.freeze({
      model: response.responseModel ?? response.model,
      role: "assistant",
      content: content.length === 1 && content[0] ? content[0] : content,
      stopReason: usedTool ? "toolUse" : stopReason(response.stopReason),
    });
  };
  return Object.freeze({ sample });
}
