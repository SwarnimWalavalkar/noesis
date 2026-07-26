export type EffectExecutionFailureCode = "cancelled" | "invalid_output" | "result_too_large";

const failureBrand = Symbol("noesis.effect-execution-failure");
const durablePrefix = "noesis-effect-failure-v1:";

interface BrandedEffectExecutionFailure extends Error {
  readonly [failureBrand]: EffectExecutionFailureCode;
}

export interface EffectExecutionFailureDetails {
  readonly code: EffectExecutionFailureCode;
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
  return failure ? `${durablePrefix}${JSON.stringify(failure)}` : undefined;
}

export function parseEffectExecutionFailure(reason: string): EffectExecutionFailureDetails | undefined {
  if (!reason.startsWith(durablePrefix)) return undefined;
  try {
    const parsed: unknown = JSON.parse(reason.slice(durablePrefix.length));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("code" in parsed) ||
      !isFailureCode(parsed.code) ||
      !("message" in parsed) ||
      typeof parsed.message !== "string"
    )
      return undefined;
    return Object.freeze({ code: parsed.code, message: parsed.message });
  } catch {
    return undefined;
  }
}
