import { type JsonValue, toJsonValue } from "@noesis/domain";
import type { GeneratedToolBackend, GeneratedToolBackendRequest } from "./contracts.ts";

export type FakeGeneratedToolExecutor = (
  input: JsonValue,
  request: GeneratedToolBackendRequest,
) => JsonValue | Promise<JsonValue>;

export function createDeterministicFakeBackend(
  execute: FakeGeneratedToolExecutor = (input) => input,
): GeneratedToolBackend {
  const executeBackend: GeneratedToolBackend["execute"] = async (request) => {
    const startedAt = "2000-01-01T00:00:00.000Z";
    try {
      const output = toJsonValue(await execute(request.input, request));
      return {
        ok: true,
        output,
        trace: {
          backend: "deterministic-fake",
          previewIsolation: "deterministic_fake",
          startedAt,
          completedAt: startedAt,
          stdout: "",
          stderr: "",
          brokerRequestCount: 0,
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: "child_error",
        reason: error instanceof Error ? error.message : String(error),
        trace: {
          backend: "deterministic-fake",
          previewIsolation: "deterministic_fake",
          startedAt,
          completedAt: startedAt,
          stdout: "",
          stderr: "",
          brokerRequestCount: 0,
        },
      };
    }
  };
  return Object.freeze({
    backendId: "deterministic-fake",
    execute: executeBackend,
  });
}
