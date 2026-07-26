export type EffectExecutionFailureCode = "cancelled" | "invalid_output" | "result_too_large";

const failureBrand = Symbol("noesis.effect-execution-failure");
const durablePrefix = "noesis-effect-failure-v2:";
const legacyDurablePrefix = "noesis-effect-failure-v1:";

interface BrandedEffectExecutionFailure extends Error {
  readonly [failureBrand]: EffectExecutionFailureCode;
}

export interface EffectExecutionFailureDetails {
  readonly code: EffectExecutionFailureCode;
  readonly message: string;
}

export interface DurableEffectExecutionFailureDetails {
  readonly code?: EffectExecutionFailureCode;
  readonly message: string;
}

function isFailureCode(value: unknown): value is EffectExecutionFailureCode {
  return value === "cancelled" || value === "invalid_output" || value === "result_too_large";
}

export function createEffectExecutionFailure(code: EffectExecutionFailureCode, message: string): Error {
  const error = new Error(message) as BrandedEffectExecutionFailure;
  Object.defineProperty(error, failureBrand, {
    configurable: false,
    enumerable: false,
    value: code,
    writable: false,
  });
  return error;
}

export function inspectEffectExecutionFailure(value: unknown): EffectExecutionFailureDetails | undefined {
  if (
    !(value instanceof Error) ||
    !isFailureCode((value as Partial<BrandedEffectExecutionFailure>)[failureBrand])
  )
    return undefined;
  return Object.freeze({
    code: (value as BrandedEffectExecutionFailure)[failureBrand],
    message: value.message,
  });
}

export function serializeEffectExecutionFailure(value: unknown): string | undefined {
  const failure = inspectEffectExecutionFailure(value);
  return failure ? `${durablePrefix}${JSON.stringify({ kind: "typed", ...failure })}` : undefined;
}

export function serializeEffectExecutionError(value: unknown): string {
  return (
    serializeEffectExecutionFailure(value) ??
    `${durablePrefix}${JSON.stringify({
      kind: "ordinary",
      message: value instanceof Error ? value.message : String(value),
    })}`
  );
}

export function parseEffectExecutionFailure(reason: string): EffectExecutionFailureDetails | undefined {
  const parsed = parseEffectExecutionError(reason);
  return parsed?.code === undefined
    ? undefined
    : Object.freeze({ code: parsed.code, message: parsed.message });
}

export function parseEffectExecutionError(reason: string): DurableEffectExecutionFailureDetails | undefined {
  const prefix = reason.startsWith(durablePrefix)
    ? durablePrefix
    : reason.startsWith(legacyDurablePrefix)
      ? legacyDurablePrefix
      : undefined;
  if (!prefix) return undefined;
  try {
    const parsed: unknown = JSON.parse(reason.slice(prefix.length));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("message" in parsed) ||
      typeof parsed.message !== "string"
    )
      return undefined;
    if (prefix === legacyDurablePrefix) {
      if (!("code" in parsed) || !isFailureCode(parsed.code)) return undefined;
      return Object.freeze({ code: parsed.code, message: parsed.message });
    }
    if (!("kind" in parsed) || (parsed.kind !== "typed" && parsed.kind !== "ordinary")) return undefined;
    if (parsed.kind === "ordinary") return Object.freeze({ message: parsed.message });
    if (!("code" in parsed) || !isFailureCode(parsed.code)) return undefined;
    return Object.freeze({ code: parsed.code, message: parsed.message });
  } catch {
    return undefined;
  }
}
