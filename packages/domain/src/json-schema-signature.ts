import type { JsonValue } from "./index.ts";

const MAX_SIGNATURE_CHARACTERS = 2_000;
const MAX_DEPTH = 6;

type JsonRecord = { readonly [key: string]: JsonValue };

const isRecord = (value: JsonValue | undefined): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: JsonValue | undefined): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

/** Recursive schemas, such as the JSON value schema, have no useful finite type to show. */
const selfReferencing = (schema: JsonValue, ref: string): boolean =>
  JSON.stringify(schema).includes(`"$ref":${JSON.stringify(ref)}`);

const resolveRef = (root: JsonValue, ref: string): JsonValue | undefined => {
  if (!ref.startsWith("#/")) return undefined;
  let current: JsonValue | undefined = root;
  for (const segment of ref.slice(2).split("/"))
    current = isRecord(current) ? current[segment.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined;
  return current;
};

const union = (parts: readonly string[]): string => [...new Set(parts)].join(" | ");

function render(schema: JsonValue | undefined, depth: number, root: JsonValue): string {
  if (schema === true || schema === undefined || !isRecord(schema)) return "unknown";
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    if (ref === "#") return "JSON";
    const target = resolveRef(root, ref);
    if (target === undefined) return "unknown";
    return selfReferencing(target, ref) ? "JSON" : render(target, depth + 1, root);
  }
  if (depth > MAX_DEPTH) return "…";
  if ("const" in schema) return JSON.stringify(schema["const"]);
  if (Array.isArray(schema["enum"])) return union(schema["enum"].map((value) => JSON.stringify(value)));
  const alternatives = schema["anyOf"] ?? schema["oneOf"];
  if (Array.isArray(alternatives)) return union(alternatives.map((entry) => render(entry, depth, root)));
  const types = Array.isArray(schema["type"]) ? strings(schema["type"]) : strings([schema["type"] ?? null]);
  if (types.length > 1) return union(types.map((type) => render({ ...schema, type }, depth, root)));
  switch (types[0]) {
    case "string":
    case "boolean":
    case "null":
      return types[0];
    case "number":
    case "integer":
      return "number";
    case "array": {
      const item = render(schema["items"], depth + 1, root);
      return item.includes(" ") ? `(${item})[]` : `${item}[]`;
    }
    case "object": {
      const properties = isRecord(schema["properties"]) ? schema["properties"] : undefined;
      if (!properties || Object.keys(properties).length === 0)
        return isRecord(schema["additionalProperties"])
          ? `Record<string, ${render(schema["additionalProperties"], depth + 1, root)}>`
          : "{}";
      const required = new Set(strings(schema["required"]));
      const fields = Object.entries(properties).map(([key, value]) => {
        const name = IDENTIFIER.test(key) ? key : JSON.stringify(key);
        return `${name}${required.has(key) ? "" : "?"}: ${render(value, depth + 1, root)}`;
      });
      return `{ ${fields.join("; ")} }`;
    }
    default:
      return "unknown";
  }
}

/** Renders a JSON Schema as a compact TypeScript-like type so a model can see field names at a glance. */
export function schemaSignature(schema: JsonValue): string {
  const rendered =
    isRecord(schema) && selfReferencing(schema, "#") && !isRecord(schema["properties"])
      ? "JSON"
      : render(schema, 0, schema);
  return rendered.length > MAX_SIGNATURE_CHARACTERS
    ? `${rendered.slice(0, MAX_SIGNATURE_CHARACTERS)}… (truncated; see inputSchema/outputSchema)`
    : rendered;
}
