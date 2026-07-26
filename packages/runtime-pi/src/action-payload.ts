import type { JsonValue } from "@noesis/domain";

export const MAX_AGENT_ACTION_PAYLOAD_BYTES = 256 * 1024;

const MAX_DEPTH = 8;
const MAX_COLLECTION_ITEMS = 100;
const MAX_STRING_CHARACTERS = 256 * 1024;

function truncateCharacters(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… [truncated ${String(value.length - limit)} characters]`;
}

function normalizeActionValue(value: unknown, depth: number, seen: WeakSet<object>): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return typeof value === "string" ? truncateCharacters(value, MAX_STRING_CHARACTERS) : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return `${String(value)}n`;
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "symbol") return `[symbol ${value.description ?? ""}]`;
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (depth >= MAX_DEPTH) return "[maximum depth reached]";
  if (value instanceof Error)
    return Object.freeze({
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: truncateCharacters(value.stack, MAX_STRING_CHARACTERS) } : {}),
    });
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const items = value
      .slice(0, MAX_COLLECTION_ITEMS)
      .map((item) => normalizeActionValue(item, depth + 1, seen));
    if (value.length > MAX_COLLECTION_ITEMS)
      items.push(`[${String(value.length - MAX_COLLECTION_ITEMS)} more items]`);
    return Object.freeze(items);
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const entries = Object.entries(value);
    const normalized: Record<string, JsonValue> = {};
    for (const [key, entry] of entries.slice(0, MAX_COLLECTION_ITEMS))
      normalized[key] = normalizeActionValue(entry, depth + 1, seen);
    if (entries.length > MAX_COLLECTION_ITEMS)
      normalized["…"] = `[${String(entries.length - MAX_COLLECTION_ITEMS)} more properties]`;
    return Object.freeze(normalized);
  }
  return String(value);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  return new TextDecoder().decode(bytes.slice(0, maxBytes));
}

/** Convert arbitrary Pi payloads into bounded, adapter-neutral JSON for product read models. */
export function toAgentActionPayload(value: unknown): JsonValue {
  const normalized = normalizeActionValue(value, 0, new WeakSet<object>());
  const serialized = JSON.stringify(normalized);
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.byteLength <= MAX_AGENT_ACTION_PAYLOAD_BYTES) return normalized;
  const previewBytes = Math.floor(MAX_AGENT_ACTION_PAYLOAD_BYTES / 3);
  return Object.freeze({
    truncated: true,
    originalBytes: bytes.byteLength,
    preview: truncateUtf8(serialized, previewBytes),
  });
}
