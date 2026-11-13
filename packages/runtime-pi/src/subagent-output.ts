import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import ajvFormats from "ajv-formats";
import { canonicalJson, JsonValueSchema, type JsonObject, type JsonValue } from "@noesis/domain";
import { z } from "zod";

/**
 * One validator for every caller schema. It implements JSON Schema 2020-12 fully, never fills in a
 * `default`, and rejects unknown keywords such as draft-7 `dependencies` at admission instead of
 * silently ignoring them.
 */
const validator = new Ajv2020({
  allErrors: true,
  strictSchema: true,
  strictNumbers: true,
  strictTypes: false,
  strictTuples: false,
  strictRequired: false,
  validateFormats: true,
});
// ajv-formats is CommonJS; its function is also exported as `default`.
ajvFormats.default(validator);

/** Decoder for a caller-supplied JSON Schema. A schema that cannot be compiled fails at admission. */
export function compileSubAgentOutput(schema: JsonObject): z.ZodType<JsonValue> {
  let validate: ValidateFunction;
  try {
    validate = validator.compile(schema);
  } catch (cause) {
    throw new Error(
      `Subagent output is not a usable JSON Schema: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  return JsonValueSchema.superRefine((value, context) => {
    if (validate(value)) return;
    for (const error of validate.errors ?? [])
      context.addIssue({
        code: "custom",
        message: `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
      });
  });
}

export type SubAgentOutputDecoding =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly failure: string };

/**
 * Decode a final answer that must be exactly one JSON value. A message that wraps the value in prose
 * is invalid and goes to repair. One fence around the whole message is tolerated.
 */
export function decodeCompiledSubAgentOutput(
  text: string,
  schema: z.ZodType<JsonValue>,
): SubAgentOutputDecoding {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed)?.[1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced ?? trimmed);
  } catch (cause) {
    return Object.freeze({
      ok: false as const,
      failure: `The answer is not exactly one JSON value: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
  const decoded = schema.safeParse(parsed);
  return decoded.success
    ? Object.freeze({ ok: true as const, value: decoded.data })
    : Object.freeze({ ok: false as const, failure: z.prettifyError(decoded.error) });
}

/** Validate a durable result against the schema its actor froze. */
export function decodeSubAgentOutput(text: string, schema: JsonObject): JsonValue {
  const decoded = decodeCompiledSubAgentOutput(text, compileSubAgentOutput(schema));
  if (!decoded.ok) throw new Error(`Recorded subagent result is invalid: ${decoded.failure}`);
  return decoded.value;
}

export function renderSubAgentOutputContract(schema: JsonObject): string {
  return [
    "Your final message must contain only one JSON value that satisfies this JSON Schema, with no prose or code fence around it:",
    canonicalJson(schema),
  ].join("\n");
}

export function renderSubAgentOutputRepair(failure: string): string {
  return [
    "Your final answer did not satisfy the required JSON Schema.",
    `Problem: ${failure}`,
    "Reply again with only the corrected JSON value. Tools are not available for this reply.",
  ].join("\n");
}
