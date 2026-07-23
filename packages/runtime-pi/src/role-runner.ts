import { randomUUID } from "node:crypto";
import type {
  AgentRoleRunner,
  AgentRunRequest,
  AgentUsage,
  StructuredInferencePort,
} from "@noesis/agent-types";
import { toJsonValue } from "@noesis/domain";
import { z } from "zod";
import { applyRoleContextPolicy, renderBoundedRolePrompt, signalOf } from "./role-context.ts";
import type {
  FakeRoleResponse,
  RoleBackendRequest,
  RoleBackendResult,
  RoleModelBackend,
  RoleRunTelemetry,
  RoleStopReason,
  RoleVariantConfiguration,
  RuntimePiAgentRoleRunner,
  RuntimePiAgentRunResult,
  RuntimePiAgentTrace,
  RuntimePiStructuredInferencePort,
} from "./role-types.ts";

const ZERO_USAGE: AgentUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  estimatedCost: 0,
});

export type RoleRunErrorCode = "aborted" | "backend" | "configuration" | "malformed_output";

export interface RoleRunError extends Error {
  readonly code: RoleRunErrorCode;
  readonly trace: RuntimePiAgentTrace | undefined;
}

export function isRoleRunError(value: unknown): value is RoleRunError {
  return (
    value instanceof Error &&
    value.name === "RoleRunError" &&
    "code" in value &&
    ["aborted", "backend", "configuration", "malformed_output"].includes(String(value.code))
  );
}

function roleRunError(
  code: RoleRunErrorCode,
  message: string,
  trace?: RuntimePiAgentTrace,
  cause?: Error,
): RoleRunError {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    name: "RoleRunError",
    code,
    trace,
  });
}

export interface CreateAgentRoleRunnerOptions {
  readonly backend: RoleModelBackend;
  readonly variants: readonly RoleVariantConfiguration[];
  readonly now?: () => Date;
  readonly createTraceId?: () => string;
}

function variantKey(role: AgentRunRequest["role"], variantId: string): string {
  return `${role}\u0000${variantId}`;
}

function configurationMap(
  variants: readonly RoleVariantConfiguration[],
): ReadonlyMap<string, RoleVariantConfiguration> {
  const configurations = new Map<string, RoleVariantConfiguration>();
  for (const configuration of variants) {
    if (configuration.variant.axis !== "role") {
      throw roleRunError(
        "configuration",
        `Role variant configuration must use the role axis, got ${configuration.variant.axis}`,
      );
    }
    const key = variantKey(configuration.role, configuration.variant.variantId);
    if (configurations.has(key)) {
      throw roleRunError(
        "configuration",
        `Duplicate role variant configuration ${configuration.role}/${configuration.variant.variantId}`,
      );
    }
    configurations.set(key, Object.freeze({ ...configuration }));
  }
  return configurations;
}

function sameVariant(
  request: AgentRunRequest["variant"],
  configuration: RoleVariantConfiguration["variant"],
): boolean {
  return (
    request.variantId === configuration.variantId &&
    request.axis === configuration.axis &&
    request.configurationRefs.length === configuration.configurationRefs.length &&
    request.configurationRefs.every((reference, index) => {
      const expected = configuration.configurationRefs[index];
      return (
        expected !== undefined &&
        reference.kind === expected.kind &&
        reference.revisionId === expected.revisionId &&
        reference.workingPath === expected.workingPath &&
        reference.snapshotPath === expected.snapshotPath &&
        reference.contentDigest === expected.contentDigest
      );
    })
  );
}

function capabilityRevisionsFrom(input: ReturnType<typeof applyRoleContextPolicy>) {
  return Object.freeze(input.capabilityRevisions.map((revision) => Object.freeze({ ...revision })));
}

function traceReferences(request: AgentRunRequest) {
  return {
    evidenceRefs: request.evidenceRefs.filter((reference) => reference.kind === "evidence_revision"),
    artifactRefs: request.evidenceRefs.filter((reference) => reference.kind === "artifact_file"),
  };
}

function structuredJson(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return toJsonValue(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function createTrace(input: {
  readonly request: AgentRunRequest;
  readonly configuration: RoleVariantConfiguration;
  readonly capabilityRevisions: RuntimePiAgentTrace["capabilityRevisions"];
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly usage: AgentUsage;
  readonly stopReason: RoleStopReason;
  readonly provider?: string;
  readonly model?: string;
  readonly repairAttempts?: number;
  readonly failure?: RoleRunTelemetry["failure"];
  readonly createTraceId: () => string;
}): RuntimePiAgentTrace {
  const references = traceReferences(input.request);
  const status = input.stopReason === "aborted" ? "aborted" : input.failure ? "failed" : "completed";
  return Object.freeze({
    traceId: input.createTraceId(),
    role: input.request.role,
    variant: input.request.variant,
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    usage: input.usage,
    evidenceRefs: references.evidenceRefs,
    artifactRefs: references.artifactRefs,
    capabilityRevisions: input.capabilityRevisions,
    telemetry: Object.freeze({
      provider: input.provider ?? input.configuration.provider,
      model: input.model ?? input.configuration.model,
      reasoning: input.configuration.reasoning,
      contextPolicyId: input.configuration.contextPolicy.policyId,
      latencyMs: Math.max(0, input.completedAt.getTime() - input.startedAt.getTime()),
      stopReason: input.stopReason,
      status,
      attempts: 1 + (input.repairAttempts ?? 0),
      repairAttempts: input.repairAttempts ?? 0,
      ...(input.failure ? { failure: input.failure } : {}),
    }),
  });
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function createAgentRoleRunner(options: CreateAgentRoleRunnerOptions): RuntimePiAgentRoleRunner {
  const configurations = configurationMap(options.variants);
  const active = new Map<string, AbortController>();
  const now = options.now ?? (() => new Date());
  const createTraceId = options.createTraceId ?? (() => `role_trace_${randomUUID()}`);

  const abort = async (runId: string): Promise<void> => {
    active.get(runId)?.abort();
    await options.backend.abort(runId);
  };

  const run = async (request: AgentRunRequest): Promise<RuntimePiAgentRunResult> => {
    if (request.variant.axis !== "role") {
      throw roleRunError(
        "configuration",
        `Role runner requires a role-axis variant, got ${request.variant.axis}`,
      );
    }
    const configuration = configurations.get(variantKey(request.role, request.variant.variantId));
    if (!configuration) {
      throw roleRunError(
        "configuration",
        `No role variant configuration for ${request.role}/${request.variant.variantId}`,
      );
    }
    if (!sameVariant(request.variant, configuration.variant)) {
      throw roleRunError(
        "configuration",
        `Role variant ${request.variant.variantId} does not match its configured revision references`,
      );
    }
    if (active.has(request.runId)) {
      throw roleRunError("configuration", `Role run ${request.runId} is already active`);
    }

    const boundedInput = applyRoleContextPolicy(request, configuration.contextPolicy);
    const capabilityRevisions = capabilityRevisionsFrom(boundedInput);
    const startedAt = now();
    const controller = new AbortController();
    const externalSignal = signalOf(request);
    const forwardAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) forwardAbort();
    else externalSignal?.addEventListener("abort", forwardAbort, { once: true });
    active.set(request.runId, controller);

    try {
      const backendRequest: RoleBackendRequest = {
        runId: request.runId,
        provider: configuration.provider,
        model: configuration.model,
        reasoning: configuration.reasoning,
        systemPrompt: configuration.systemPrompt,
        prompt: renderBoundedRolePrompt(boundedInput, configuration.contextPolicy),
        ...(configuration.timeoutMs === undefined ? {} : { timeoutMs: configuration.timeoutMs }),
        ...(configuration.maxRetries === undefined ? {} : { maxRetries: configuration.maxRetries }),
        signal: controller.signal,
      };
      let backendResult: RoleBackendResult;
      try {
        backendResult = await options.backend.run(backendRequest);
      } catch (error) {
        const cause = toError(error);
        const completedAt = now();
        const aborted = controller.signal.aborted;
        const code = aborted ? "aborted" : "backend";
        const trace = createTrace({
          request,
          configuration,
          capabilityRevisions,
          startedAt,
          completedAt,
          usage: ZERO_USAGE,
          stopReason: aborted ? "aborted" : "error",
          failure: { code, message: cause.message },
          createTraceId,
        });
        throw roleRunError(code, cause.message, trace, cause);
      }

      const completedAt = now();
      if (backendResult.stopReason === "aborted" || backendResult.stopReason === "error") {
        const code = backendResult.stopReason === "aborted" ? "aborted" : "backend";
        const message = backendResult.error?.trim() || `Role run stopped with ${backendResult.stopReason}`;
        const trace = createTrace({
          request,
          configuration,
          capabilityRevisions,
          startedAt,
          completedAt,
          usage: backendResult.usage,
          stopReason: backendResult.stopReason,
          provider: backendResult.provider,
          model: backendResult.model,
          failure: { code, message },
          createTraceId,
        });
        throw roleRunError(code, message, trace);
      }

      const trace = createTrace({
        request,
        configuration,
        capabilityRevisions,
        startedAt,
        completedAt,
        usage: backendResult.usage,
        stopReason: backendResult.stopReason,
        provider: backendResult.provider,
        model: backendResult.model,
        createTraceId,
      });
      const parsed = structuredJson(backendResult.text);
      return Object.freeze({
        text: backendResult.text,
        ...(parsed === undefined ? {} : { structuredOutput: parsed }),
        trace,
        capabilityRevisions,
      });
    } finally {
      externalSignal?.removeEventListener("abort", forwardAbort);
      if (active.get(request.runId) === controller) active.delete(request.runId);
    }
  };

  const runner = Object.freeze({ run, abort });
  runner satisfies RuntimePiAgentRoleRunner;
  runner satisfies AgentRoleRunner;
  return runner;
}

function jsonCandidates(text: string): readonly string[] {
  const trimmed = text.trim();
  const candidates = new Set<string>([trimmed]);
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1];
  if (fenced) candidates.add(fenced.trim());
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) candidates.add(trimmed.slice(objectStart, objectEnd + 1));
  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.add(trimmed.slice(arrayStart, arrayEnd + 1));
  return [...candidates].filter(Boolean);
}

function decodeStructured<T>(text: string, schema: z.ZodType<T>): T {
  const failures: string[] = [];
  for (const candidate of jsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      failures.push(toError(error).message);
      continue;
    }
    const decoded = schema.safeParse(parsed);
    if (decoded.success) return decoded.data;
    failures.push(z.prettifyError(decoded.error));
  }
  throw new Error(failures.at(-1) ?? "Model output did not contain JSON");
}

function addOutputContract(request: AgentRunRequest, schema: z.ZodType<unknown>): AgentRunRequest {
  const contract = JSON.stringify(z.toJSONSchema(schema));
  const messages = request.messages.map((message, index) =>
    index === request.messages.length - 1
      ? {
          ...message,
          content: `${message.content}\n\nReturn JSON only. The JSON must match this schema:\n${contract}`,
        }
      : message,
  );
  return { ...request, messages };
}

function repairRequest(
  request: AgentRunRequest,
  raw: string,
  error: Error,
  attempt: number,
): AgentRunRequest {
  const messages = request.messages.map((message, index) =>
    index === request.messages.length - 1
      ? {
          ...message,
          content: `${message.content}\n\nRepair the following malformed model output. Return only corrected JSON.\nValidation failure: ${error.message}\nMalformed output:\n${raw}`,
        }
      : message,
  );
  return { ...request, runId: `${request.runId}:repair:${attempt}`, messages };
}

function addUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
  return Object.freeze({
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    estimatedCost: left.estimatedCost + right.estimatedCost,
  });
}

function combineTraces(
  traces: readonly RuntimePiAgentTrace[],
  repairAttempts: number,
  failure?: RoleRunTelemetry["failure"],
): RuntimePiAgentTrace {
  const first = traces[0];
  const last = traces.at(-1);
  if (!first || !last) throw new Error("Cannot combine an empty role trace list");
  const usage = traces.reduce<AgentUsage>((total, trace) => addUsage(total, trace.usage), ZERO_USAGE);
  return Object.freeze({
    ...last,
    startedAt: first.startedAt,
    usage,
    telemetry: Object.freeze({
      ...last.telemetry,
      latencyMs: traces.reduce((total, trace) => total + trace.telemetry.latencyMs, 0),
      attempts: traces.length,
      repairAttempts,
      status: failure ? "failed" : last.telemetry.status,
      ...(failure ? { failure } : {}),
    }),
  });
}

export interface CreateStructuredInferencePortOptions {
  readonly runner: RuntimePiAgentRoleRunner;
  readonly maxRepairAttempts?: number;
}

export function createStructuredInferencePort(
  options: CreateStructuredInferencePortOptions,
): RuntimePiStructuredInferencePort {
  const maxRepairAttempts = options.maxRepairAttempts ?? 1;
  if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 0) {
    throw roleRunError("configuration", "maxRepairAttempts must be a non-negative integer");
  }

  const run = async <T>(request: AgentRunRequest, outputSchema: z.ZodType<T>) => {
    const traces: RuntimePiAgentTrace[] = [];
    let result = await options.runner.run(addOutputContract(request, outputSchema));
    traces.push(result.trace);
    let failure: Error;
    try {
      const value = decodeStructured(result.text, outputSchema);
      return Object.freeze({
        value,
        trace: combineTraces(traces, 0),
        capabilityRevisions: result.capabilityRevisions,
      });
    } catch (error) {
      failure = toError(error);
    }

    for (let attempt = 1; attempt <= maxRepairAttempts; attempt += 1) {
      result = await options.runner.run(repairRequest(request, result.text, failure, attempt));
      traces.push(result.trace);
      try {
        const value = decodeStructured(result.text, outputSchema);
        return Object.freeze({
          value,
          trace: combineTraces(traces, attempt),
          capabilityRevisions: result.capabilityRevisions,
        });
      } catch (error) {
        failure = toError(error);
      }
    }

    const trace = combineTraces(traces, maxRepairAttempts, {
      code: "malformed_output",
      message: failure.message,
    });
    throw roleRunError("malformed_output", failure.message, trace, failure);
  };

  const port = Object.freeze({ run });
  port satisfies RuntimePiStructuredInferencePort;
  port satisfies StructuredInferencePort;
  return port;
}

export interface CreateFakeRoleModelBackendOptions {
  readonly respond: (request: RoleBackendRequest) => FakeRoleResponse | Promise<FakeRoleResponse>;
}

export interface CreateFakeAgentRoleRunnerOptions extends CreateFakeRoleModelBackendOptions {
  readonly variants: readonly RoleVariantConfiguration[];
  readonly now?: () => Date;
  readonly createTraceId?: () => string;
}

export function createFakeAgentRoleRunner(
  options: CreateFakeAgentRoleRunnerOptions,
): RuntimePiAgentRoleRunner {
  return createAgentRoleRunner({
    backend: createFakeRoleModelBackend({ respond: options.respond }),
    variants: options.variants,
    ...(options.now ? { now: options.now } : {}),
    ...(options.createTraceId ? { createTraceId: options.createTraceId } : {}),
  });
}

export function createFakeRoleModelBackend(options: CreateFakeRoleModelBackendOptions): RoleModelBackend {
  const active = new Map<string, AbortController>();
  const abort = async (runId: string): Promise<void> => {
    active.get(runId)?.abort();
  };
  const run = async (request: RoleBackendRequest): Promise<RoleBackendResult> => {
    if (active.has(request.runId)) throw new Error(`Fake role run ${request.runId} is already active`);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(request.signal.reason);
    if (request.signal.aborted) forwardAbort();
    else request.signal.addEventListener("abort", forwardAbort, { once: true });
    active.set(request.runId, controller);
    try {
      const response = await options.respond(request);
      if (response.latencyMs && response.latencyMs > 0) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, response.latencyMs);
          if (controller.signal.aborted) finish();
          else controller.signal.addEventListener("abort", finish, { once: true });
        });
      }
      const stopReason = controller.signal.aborted ? "aborted" : (response.stopReason ?? "stop");
      return Object.freeze({
        text: response.text,
        provider: request.provider,
        model: request.model,
        stopReason,
        usage: response.usage ?? ZERO_USAGE,
        ...(response.error ? { error: response.error } : {}),
      });
    } finally {
      request.signal.removeEventListener("abort", forwardAbort);
      if (active.get(request.runId) === controller) active.delete(request.runId);
    }
  };
  return Object.freeze({ run, abort });
}
