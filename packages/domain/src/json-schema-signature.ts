import type { JsonValue } from "./index.ts";

const MAX_SIGNATURE_CHARACTERS = 2_000;
const MAX_DEPTH = 6;

type JsonRecord = { readonly [key: string]: JsonValue };

const isRecord = (value: JsonValue | undefined): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: JsonValue | undefined): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

const JSON_VALUE_TYPES = ["array", "boolean", "null", "number", "object", "string"].join();

/** The recursive JSON value schema: one branch for each JSON type. Other recursive schemas keep their shape. */
const isJsonValueSchema = (schema: JsonRecord): boolean => {
  const alternatives = schema["anyOf"];
  if (!Array.isArray(alternatives)) return false;
  const types = alternatives.map((entry) => (isRecord(entry) ? entry["type"] : undefined));
  return types.every((type) => typeof type === "string") && types.toSorted().join() === JSON_VALUE_TYPES;
};

const resolveRef = (root: JsonValue, ref: string): JsonValue | undefined => {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current: JsonValue | undefined = root;
  for (const segment of ref.slice(2).split("/"))
    current = isRecord(current) ? current[segment.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined;
  return current;
};

const union = (parts: readonly string[]): string => [...new Set(parts)].join(" | ");

function render(
  schema: JsonValue | undefined,
  depth: number,
  root: JsonValue,
  visiting: ReadonlySet<string>,
): string {
  if (schema === true || schema === undefined || !isRecord(schema)) return "unknown";
  if (isJsonValueSchema(schema)) return "JSON";
  if (depth > MAX_DEPTH) return "…";
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    if (visiting.has(ref)) return "(recursive)";
    const target = resolveRef(root, ref);
    return target === undefined ? "unknown" : render(target, depth + 1, root, new Set([...visiting, ref]));
  }
  if ("const" in schema) return JSON.stringify(schema["const"]);
  if (Array.isArray(schema["enum"])) return union(schema["enum"].map((value) => JSON.stringify(value)));
  const alternatives = schema["anyOf"] ?? schema["oneOf"];
  if (Array.isArray(alternatives))
    return union(alternatives.map((entry) => render(entry, depth, root, visiting)));
  const types = Array.isArray(schema["type"]) ? strings(schema["type"]) : strings([schema["type"] ?? null]);
  if (types.length > 1) return union(types.map((type) => render({ ...schema, type }, depth, root, visiting)));
  switch (types[0]) {
    case "string":
    case "boolean":
    case "null":
      return types[0];
    case "number":
    case "integer":
      return "number";
    case "array": {
      const item = render(schema["items"], depth + 1, root, visiting);
      return item.includes(" ") ? `(${item})[]` : `${item}[]`;
    }
    case "object": {
      const properties = isRecord(schema["properties"]) ? schema["properties"] : undefined;
      if (!properties || Object.keys(properties).length === 0)
        return isRecord(schema["additionalProperties"])
          ? `Record<string, ${render(schema["additionalProperties"], depth + 1, root, visiting)}>`
          : "{}";
      const required = new Set(strings(schema["required"]));
      const fields = Object.entries(properties).map(([key, value]) => {
        const name = IDENTIFIER.test(key) ? key : JSON.stringify(key);
        return `${name}${required.has(key) ? "" : "?"}: ${render(value, depth + 1, root, visiting)}`;
      });
      return `{ ${fields.join("; ")} }`;
    }
    default:
      return "unknown";
  }
}

/** Renders a JSON Schema as a compact TypeScript-like type so a model can see field names at a glance. */
export function schemaSignature(schema: JsonValue): string {
  const rendered = render(schema, 0, schema, new Set(["#"]));
  return rendered.length > MAX_SIGNATURE_CHARACTERS
    ? `${rendered.slice(0, MAX_SIGNATURE_CHARACTERS)}… (truncated; see inputSchema/outputSchema)`
    : rendered;
}
