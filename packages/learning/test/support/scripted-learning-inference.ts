import type { AgentRole, AgentRunRequest, AgentTrace, StructuredInferencePort } from "@noesis/agent-types";
import { type JsonValue, toJsonValue } from "@noesis/domain";
import type { z } from "zod";

export interface ScriptedLearningInferenceStep {
  readonly role: AgentRole;
  readonly value: JsonValue;
}

export interface ScriptedLearningInferencePort extends StructuredInferencePort {
  readonly requests: () => readonly AgentRunRequest[];
  readonly remaining: () => number;
}

export interface ScriptedLearningInferenceOptions {
  readonly steps: readonly ScriptedLearningInferenceStep[];
  readonly startedAt?: string;
}

function freezeRequest(request: AgentRunRequest): AgentRunRequest {
  return Object.freeze({
    ...request,
    variant: Object.freeze({
      ...request.variant,
      configurationRefs: Object.freeze(
        request.variant.configurationRefs.map((reference) => Object.freeze({ ...reference })),
      ),
    }),
    messages: Object.freeze(request.messages.map((message) => Object.freeze({ ...message }))),
    evidenceRefs: Object.freeze(request.evidenceRefs.map((reference) => Object.freeze({ ...reference }))),
    availableTools: Object.freeze(request.availableTools.map((tool) => Object.freeze({ ...tool }))),
  });
}

/** Test-only deterministic adapter-neutral structured role runner for narrow unit seams. */
export function createScriptedLearningInferencePort(
  options: ScriptedLearningInferenceOptions,
): ScriptedLearningInferencePort {
  const pending = options.steps.map((step) => Object.freeze({ ...step }));
  const observed: AgentRunRequest[] = [];
  const startedAt = options.startedAt ?? "2026-01-01T00:00:00.000Z";

  const run = async <T>(request: AgentRunRequest, outputSchema: z.ZodType<T>) => {
    const step = pending.shift();
    if (!step) throw new Error(`No scripted response remains for ${request.role}`);
    if (step.role !== request.role) {
      throw new Error(`Expected scripted role ${step.role}, received ${request.role}`);
    }
    const frozenRequest = freezeRequest(request);
    observed.push(frozenRequest);
    const value = outputSchema.parse(toJsonValue(step.value));
    const trace: AgentTrace = Object.freeze({
      traceId: `scripted-learning-trace-${observed.length}`,
      role: request.role,
      variant: frozenRequest.variant,
      startedAt,
      completedAt: startedAt,
      usage: Object.freeze({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCost: 0,
      }),
      evidenceRefs: Object.freeze(
        frozenRequest.evidenceRefs.filter((reference) => reference.kind === "evidence_revision"),
      ),
      artifactRefs: Object.freeze(
        frozenRequest.evidenceRefs.filter((reference) => reference.kind === "artifact_file"),
      ),
    });
    return Object.freeze({ value, trace });
  };

  return Object.freeze({
    run,
    requests: () => Object.freeze([...observed]),
    remaining: () => pending.length,
  });
}
