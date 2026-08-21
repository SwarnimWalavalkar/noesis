import { isJsonObject, type JsonObject, type JsonValue } from "@noesis/domain";

export function isRecord(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && isJsonObject(value);
}

export function stringField(value: JsonValue | undefined, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

export function numberField(value: JsonValue | undefined, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}
