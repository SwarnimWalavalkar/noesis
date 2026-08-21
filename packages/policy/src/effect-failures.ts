export type EffectExecutionFailureCode = "cancelled" | "invalid_output" | "result_too_large";

const failureBrand = Symbol("noesis.effect-execution-failure");
const preEffectFailureBrand = Symbol("noesis.pre-effect-execution-failure");
const durablePrefix = "noesis-effect-failure-v2:";
const legacyDurablePrefix = "noesis-effect-failure-v1:";

interface BrandedEffectExecutionFailure extends Error {
  readonly [failureBrand]: EffectExecutionFailureCode;
}

interface BrandedPreEffectExecutionFailure extends BrandedEffectExecutionFailure {
  readonly [preEffectFailureBrand]: true;
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
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const error = new Error(message) as BrandedEffectExecutionFailure;
  Object.defineProperty(error, failureBrand, {
    configurable: false,
    enumerable: false,
    value: code,
    writable: false,
  });
  return error;
}

/**
 * Marks a trusted callback failure that occurred before its effect began. The authority may release
 * this reservation for retry; ordinary execution failures remain terminal.
 */
export function createPreEffectExecutionFailure(code: EffectExecutionFailureCode, message: string): Error {
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const error = createEffectExecutionFailure(code, message) as BrandedPreEffectExecutionFailure;
  Object.defineProperty(error, preEffectFailureBrand, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return error;
}

// BOUNDARY: Authority callers may provide arbitrary thrown values; only the private brand is inspected.
export function inspectPreEffectExecutionFailure(value: unknown): EffectExecutionFailureDetails | undefined {
  // SAFETY: The Error instance is inspected only for this module's private symbol brand.
  if (
    !(value instanceof Error) ||
    (value as Partial<BrandedPreEffectExecutionFailure>)[preEffectFailureBrand] !== true
  )
    return undefined;
  return inspectEffectExecutionFailure(value);
}

// BOUNDARY: Authority callers may provide arbitrary thrown values; only the private brand is inspected.
export function inspectEffectExecutionFailure(value: unknown): EffectExecutionFailureDetails | undefined {
  // SAFETY: The Error instance is inspected only for this module's private symbol brand.
  if (
    !(value instanceof Error) ||
    !isFailureCode((value as Partial<BrandedEffectExecutionFailure>)[failureBrand])
  )
    return undefined;
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze({
    code: (value as BrandedEffectExecutionFailure)[failureBrand],
    message: value.message,
  });
}

// BOUNDARY: Effect execution may throw arbitrary values; serialization creates the durable error contract.
export function serializeEffectExecutionFailure(value: unknown): string | undefined {
  const failure = inspectEffectExecutionFailure(value);
  return failure ? `${durablePrefix}${JSON.stringify({ kind: "typed", ...failure })}` : undefined;
}

// BOUNDARY: Effect execution may throw arbitrary values; serialization creates the durable error contract.
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
