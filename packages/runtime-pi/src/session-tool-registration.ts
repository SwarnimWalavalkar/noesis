import type { AgentTool } from "@earendil-works/pi-agent-core";
import { sha256, toJsonValue, type JsonValue } from "@noesis/domain";
import type { SessionToolDefinition, SessionToolError, SessionToolName } from "@noesis/intelligence";
import { z } from "zod";

const REQUIRED_SESSION_TOOLS = [
  "search_sessions",
  "open_session_evidence",
  "find_corrections",
  "find_similar_tasks",
  "prior_experiment_outcomes",
] as const satisfies readonly SessionToolName[];

export interface PiSessionToolDetails {
  readonly toolName: SessionToolName;
  readonly resultDigest: string;
}

export interface CreatePiSessionToolRegistrationOptions {
  readonly definitions: readonly SessionToolDefinition[];
  readonly maxSerializedResultBytes?: number;
}

const OpenByCitationIdSchema = z.strictObject({
  citationId: z.string().regex(/^[a-f0-9]{64}$/u),
  beforeChars: z.number().int().min(0).max(2_048).optional(),
  afterChars: z.number().int().min(0).max(2_048).optional(),
  maxChars: z.number().int().min(32).max(4_096).optional(),
});

/**
 * Adapts one turn-scoped intelligence toolset to Pi. This module owns no retrieval policy,
 * authorization, budget, or durable state; callers create a fresh intelligence toolset per turn.
 */
export function createPiSessionToolRegistration(
  options: CreatePiSessionToolRegistrationOptions,
): readonly AgentTool[] {
  const maxSerializedResultBytes = z
    .number()
    .int()
    .min(128)
    .max(65_536)
    .parse(options.maxSerializedResultBytes ?? 4_096);
  const citations = new Map<string, JsonValue>();
  const byName = new Map<SessionToolName, SessionToolDefinition>();
  for (const definition of options.definitions) {
    if (byName.has(definition.name)) throw new Error(`Duplicate session tool ${definition.name}`);
    byName.set(definition.name, definition);
  }
  const missing = REQUIRED_SESSION_TOOLS.filter((name) => !byName.has(name));
  if (missing.length > 0) throw new Error(`Missing session tools: ${missing.join(", ")}`);

  return Object.freeze(
    REQUIRED_SESSION_TOOLS.map((name) => {
      const definition = byName.get(name);
      if (!definition) throw new Error(`Missing session tool ${name}`);
      const adapterSchema =
        name === "open_session_evidence" ? OpenByCitationIdSchema : definition.inputSchema;
      const parameters = z.toJSONSchema(adapterSchema);
      const tool: AgentTool<typeof parameters, PiSessionToolDetails> = {
        name: definition.name,
        label: definition.label,
        description: definition.description,
        parameters,
        executionMode: "sequential",
        execute: async (_toolCallId, params, signal) => {
          if (signal?.aborted) throw new Error(`${definition.name} was cancelled before execution`);
          const validated = adapterSchema.safeParse(params);
          if (!validated.success)
            throw new Error(`${definition.name} received input that failed adapter validation`);
          const forwarded =
            name === "open_session_evidence"
              ? expandCitationHandle(OpenByCitationIdSchema.parse(validated.data), citations)
              : validated.data;
          const result = await definition.execute(forwarded, signal ? { signal } : {});
          if (signal?.aborted) throw new Error(`${definition.name} was cancelled during execution`);
          if (!result.ok) throw sessionToolFailure(definition.name, result.error);
          const value = compactSessionToolResult(toJsonValue(result.value), citations);
          const text = serializeBoundedResult(value, maxSerializedResultBytes);
          return {
            content: [{ type: "text", text }],
            details: { toolName: definition.name, resultDigest: sha256(text) },
          };
        },
      };
      return Object.freeze(tool);
    }),
  );
}

function expandCitationHandle(
  input: z.infer<typeof OpenByCitationIdSchema>,
  citations: ReadonlyMap<string, JsonValue>,
): JsonValue {
  const citation = citations.get(input.citationId);
  if (!citation) throw new Error(`Unknown or expired session citation handle ${input.citationId}`);
  return {
    citation,
    ...(input.beforeChars === undefined ? {} : { beforeChars: input.beforeChars }),
    ...(input.afterChars === undefined ? {} : { afterChars: input.afterChars }),
    ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
  };
}

function isJsonObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compactFragment(value: JsonValue, citations: Map<string, JsonValue>): JsonValue {
  if (!isJsonObject(value)) return value;
  const citation = value["citation"];
  const citationId = isJsonObject(citation) ? citation["citationDigest"] : undefined;
  if (typeof citationId === "string" && /^[a-f0-9]{64}$/u.test(citationId) && citation) {
    citations.set(citationId, citation);
  }
  const compact: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "citation" || key === "provenance") continue;
    compact[key] = item;
  }
  if (typeof citationId === "string") compact["citationId"] = citationId;
  return compact;
}

function compactSessionToolResult(value: JsonValue, citations: Map<string, JsonValue>): JsonValue {
  if (!isJsonObject(value)) return value;
  const compact: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "fragments" && Array.isArray(item)) {
      compact[key] = item.map((fragment) => compactFragment(fragment, citations));
    } else if (key === "fragment") {
      compact[key] = compactFragment(item, citations);
    } else {
      compact[key] = item;
    }
  }
  return compact;
}

function serializedBytes(value: JsonValue): { readonly text: string; readonly bytes: number } {
  const text = JSON.stringify(value);
  return { text, bytes: new TextEncoder().encode(text).length };
}

function collectCitationIds(value: JsonValue): readonly string[] {
  const ids = new Set<string>();
  const visit = (item: JsonValue): void => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!isJsonObject(item)) return;
    if (typeof item["citationId"] === "string") ids.add(item["citationId"]);
    for (const child of Object.values(item)) visit(child);
  };
  visit(value);
  return [...ids];
}

function firstExcerpt(value: JsonValue): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstExcerpt(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isJsonObject(value)) return undefined;
  if (typeof value["content"] === "string") return value["content"];
  for (const item of Object.values(value)) {
    const found = firstExcerpt(item);
    if (found !== undefined) return found;
  }
  return undefined;
}

function serializeBoundedResult(value: JsonValue, maximumBytes: number): string {
  const full = serializedBytes(value);
  if (full.bytes <= maximumBytes) return full.text;
  const resultDigest = sha256(full.text);
  const citationIds = collectCitationIds(value);
  const base = { truncated: true, resultDigest } as const;
  let bounded: JsonValue = base;
  for (let count = citationIds.length; count >= 0; count -= 1) {
    const candidate = {
      ...base,
      ...(count > 0 ? { citationIds: citationIds.slice(0, count) } : {}),
    };
    if (serializedBytes(candidate).bytes <= maximumBytes) {
      bounded = candidate;
      break;
    }
  }
  const excerpt = firstExcerpt(value);
  if (excerpt !== undefined) {
    let low = 0;
    let high = excerpt.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = { ...bounded, excerpt: excerpt.slice(0, middle) };
      if (serializedBytes(candidate).bytes <= maximumBytes) low = middle;
      else high = middle - 1;
    }
    if (low > 0) bounded = { ...bounded, excerpt: excerpt.slice(0, low) };
  }
  const serialized = serializedBytes(bounded);
  if (serialized.bytes > maximumBytes)
    throw new Error("Configured Pi session tool result bound cannot fit the integrity envelope");
  return serialized.text;
}

function sessionToolFailure(name: SessionToolName, error: SessionToolError): Error {
  const retry = error.retryable ? "retryable" : "not retryable";
  return new Error(`${name} failed [${error.code}, ${retry}]: ${error.message}`);
}
