import { type ActorRef, canonicalJson, type JsonValue, sha256, toJsonValue } from "@noesis/domain";
import {
  DEFAULT_GENERATED_TOOL_LIMITS,
  type GeneratedToolArtifactSink,
  type GeneratedToolBackend,
  type GeneratedToolBackendResult,
  type GeneratedToolBroker,
  type GeneratedToolDefinition,
  type GeneratedToolLimits,
  type GeneratedToolRunRequest,
  type GeneratedToolRunResult,
} from "./contracts.ts";

export interface GeneratedToolRuntimeOptions {
  readonly backend: GeneratedToolBackend;
  readonly artifacts: GeneratedToolArtifactSink;
  readonly brokerFor: (request: GeneratedToolRunRequest) => GeneratedToolBroker;
}

export interface GeneratedToolRuntime {
  readonly run: (request: GeneratedToolRunRequest) => Promise<GeneratedToolRunResult>;
}

const GENERATED_TOOL_ACTOR: ActorRef = Object.freeze({ actorId: "generated-tool-runtime", kind: "system" });

function isExactDependencyVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}

export function validateDependencyLock(tool: GeneratedToolDefinition): string | undefined {
  if (tool.dependencyLock.packageManager !== "pnpm" || tool.dependencyLock.lockfile.trim() === "") {
    return "Generated tools require an explicit pnpm dependency lock";
  }
  for (const [name, version] of Object.entries(tool.dependencyLock.dependencies)) {
    if (name.trim() === "" || !isExactDependencyVersion(version)) {
      return `Dependency ${name || "<empty>"} must use one exact semantic version`;
    }
    if (!tool.dependencyLock.lockfile.includes(name) || !tool.dependencyLock.lockfile.includes(version)) {
      return `Dependency ${name} at ${version} is absent from the supplied lockfile`;
    }
  }
  return undefined;
}

function mergeLimits(partial?: Partial<GeneratedToolLimits>): GeneratedToolLimits {
  const limits = { ...DEFAULT_GENERATED_TOOL_LIMITS, ...partial };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
  return Object.freeze(limits);
}

function failureTrace(
  request: GeneratedToolRunRequest,
  code: string,
  reason: string,
  backendResult?: GeneratedToolBackendResult,
): JsonValue {
  return toJsonValue({
    runId: request.runId,
    toolId: request.tool.toolId,
    backendId: backendResult?.trace.backend ?? "not_started",
    previewIsolation: backendResult?.trace.previewIsolation ?? "not_started",
    code,
    reason,
    ...(backendResult ? { backendTrace: backendResult.trace } : {}),
  });
}

export function createGeneratedToolRuntime(options: GeneratedToolRuntimeOptions): GeneratedToolRuntime {
  const run = async (request: GeneratedToolRunRequest): Promise<GeneratedToolRunResult> => {
    const sourceArtifact = await options.artifacts.recordSource({
      runId: request.runId,
      toolId: request.tool.toolId,
      source: Buffer.from(request.tool.source),
      dependencyLock: Buffer.from(request.tool.dependencyLock.lockfile),
      actor: GENERATED_TOOL_ACTOR,
    });

    const finishFailure = async (
      code: Extract<GeneratedToolRunResult, { readonly ok: false }>["code"],
      reason: string,
      backendResult?: GeneratedToolBackendResult,
    ): Promise<GeneratedToolRunResult> => {
      const traceEvidence = await options.artifacts.recordTrace({
        runId: request.runId,
        toolId: request.tool.toolId,
        trace: Buffer.from(canonicalJson(failureTrace(request, code, reason, backendResult))),
        actor: GENERATED_TOOL_ACTOR,
      });
      return { ok: false, code, reason, sourceArtifact, traceEvidence };
    };

    const dependencyError = validateDependencyLock(request.tool);
    if (dependencyError) return await finishFailure("dependency_lock", dependencyError);

    const input = request.tool.inputSchema.safeParse(request.input);
    if (!input.success) return await finishFailure("invalid_input", input.error.message);
    let jsonInput: JsonValue;
    try {
      jsonInput = toJsonValue(input.data);
    } catch {
      return await finishFailure("invalid_input", "Input schema transformed the request into non-JSON data");
    }

    const backendResult = await options.backend.execute({
      runId: request.runId,
      tool: request.tool,
      input: jsonInput,
      limits: mergeLimits(request.limits),
      broker: options.brokerFor(request),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!backendResult.ok) {
      return await finishFailure(backendResult.code, backendResult.reason, backendResult);
    }

    const output = request.tool.outputSchema.safeParse(backendResult.output);
    if (!output.success) {
      return await finishFailure("invalid_output", output.error.message, backendResult);
    }
    let jsonOutput: JsonValue;
    try {
      jsonOutput = toJsonValue(output.data);
    } catch {
      return await finishFailure(
        "invalid_output",
        "Output schema accepted data that cannot cross the JSON boundary",
        backendResult,
      );
    }
    const traceEvidence = await options.artifacts.recordTrace({
      runId: request.runId,
      toolId: request.tool.toolId,
      trace: Buffer.from(
        canonicalJson({
          runId: request.runId,
          toolId: request.tool.toolId,
          sourceDigest: sha256(request.tool.source),
          inputSchemaId: request.tool.inputSchemaId,
          outputSchemaId: request.tool.outputSchemaId,
          outputDigest: sha256(canonicalJson(jsonOutput)),
          backendTrace: backendResult.trace,
        }),
      ),
      actor: GENERATED_TOOL_ACTOR,
    });
    return { ok: true, output: jsonOutput, sourceArtifact, traceEvidence };
  };

  return Object.freeze({ run });
}
