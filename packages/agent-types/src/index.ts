import type {
  ArtifactFileRef,
  EvidenceRef,
  EvidenceRevisionRef,
  ExperimentVariantRef,
  JsonValue,
} from "@noesis/domain";
import { JsonValueSchema } from "@noesis/domain";
import { z } from "zod";

export type AgentRole =
  | "foreground"
  | "signal_interpreter"
  | "reflector"
  | "revision_author"
  | "case_generator"
  | "trial"
  | "judge_critic"
  | "revision_agent"
  | "ux_explainer";

export interface AgentMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly name?: string;
}

export interface AgentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly estimatedCost: number;
}

export interface AgentTrace {
  readonly traceId: string;
  readonly role: AgentRole;
  readonly variant: ExperimentVariantRef;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly usage: AgentUsage;
  readonly evidenceRefs: readonly EvidenceRevisionRef[];
  readonly artifactRefs: readonly ArtifactFileRef[];
}

export interface AgentRunRequest {
  readonly runId: string;
  readonly role: AgentRole;
  readonly variant: ExperimentVariantRef;
  readonly messages: readonly AgentMessage[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly availableTools: readonly AgentToolDescriptor[];
}

export interface AgentRunResult {
  readonly text: string;
  readonly structuredOutput?: JsonValue;
  readonly trace: AgentTrace;
}

export interface AgentRoleRunner {
  readonly run: (request: AgentRunRequest) => Promise<AgentRunResult>;
}

export type AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentContextUsage {
  readonly usedTokens: number;
  readonly contextWindow: number;
  readonly accuracy: "reported" | "estimated";
}

export type AgentCompletedStopReason = "stop" | "length" | "toolUse";

export interface AgentRuntimeRequest {
  readonly trailId: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: AgentThinkingLevel;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly activeCapabilities: readonly {
    readonly name: string;
    readonly version: number;
  }[];
}

export type AgentRuntimeEvent =
  | { readonly type: "delta"; readonly text: string }
  | {
      readonly type: "model";
      readonly provider: string;
      readonly model: string;
      readonly contextWindow: number;
    }
  | ({ readonly type: "usage" } & AgentContextUsage)
  | { readonly type: "tool-start"; readonly name: string; readonly input: Readonly<Record<string, unknown>> }
  | { readonly type: "tool-end"; readonly name: string; readonly isError: boolean }
  | { readonly type: "status"; readonly status: "started" | "completed" | "aborted" }
  | { readonly type: "status"; readonly status: "failed"; readonly error: string };

interface AgentRuntimeResultBase {
  readonly text: string;
  readonly provider: string;
  readonly model: string;
  readonly contextUsage?: AgentContextUsage;
}

export type AgentRuntimeResult =
  | (AgentRuntimeResultBase & {
      readonly outcome: "completed";
      readonly stopReason: AgentCompletedStopReason;
    })
  | (AgentRuntimeResultBase & {
      readonly outcome: "aborted";
      readonly stopReason: "aborted";
    })
  | (AgentRuntimeResultBase & {
      readonly outcome: "failed";
      readonly stopReason: "error";
      readonly error: string;
    });

export interface NoesisAgentRuntime {
  readonly name: string;
  readonly run: (
    request: AgentRuntimeRequest,
    emit: (event: AgentRuntimeEvent) => void,
  ) => Promise<AgentRuntimeResult>;
  readonly steer: (trailId: string, text: string) => Promise<void>;
  readonly followUp: (trailId: string, text: string) => Promise<void>;
  readonly abort: (trailId: string) => Promise<void>;
}

export interface StructuredInferencePort {
  readonly run: <T>(
    request: AgentRunRequest,
    outputSchema: z.ZodType<T>,
  ) => Promise<{
    readonly value: T;
    readonly trace: AgentTrace;
  }>;
}

export interface AgentToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchemaId: string;
  readonly outputSchemaId: string;
  readonly permissionManifestRef: string;
}

export const ToolBrokerRequestSchema = z.strictObject({
  requestId: z.string().min(1),
  operationId: z.string().min(1),
  toolName: z.string().min(1),
  input: JsonValueSchema,
});
export type ToolBrokerRequest = Readonly<z.infer<typeof ToolBrokerRequestSchema>>;

export const ToolBrokerResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    requestId: z.string().min(1),
    output: JsonValueSchema,
    evidenceRefs: z.array(z.string().min(1)),
  }),
  z.strictObject({
    ok: z.literal(false),
    requestId: z.string().min(1),
    code: z.enum(["invalid_input", "denied", "failed", "timeout"]),
    reason: z.string().min(1),
  }),
]);
export type ToolBrokerResult = Readonly<z.infer<typeof ToolBrokerResultSchema>>;

export interface ToolBrokerPort {
  readonly invoke: (request: ToolBrokerRequest) => Promise<ToolBrokerResult>;
}

/** One execution child of the canonical domain Experiment lifecycle. */
export interface ExperimentExecutionRun {
  readonly runId: string;
  readonly experimentId: string;
  readonly purpose: string;
  readonly axis: ExperimentVariantRef["axis"];
  readonly baselineVariant: ExperimentVariantRef;
  readonly candidateVariants: readonly ExperimentVariantRef[];
  readonly inputRefs: readonly EvidenceRef[];
  readonly trialRefs: readonly EvidenceRef[];
  readonly comparisonRef?: EvidenceRevisionRef;
  readonly status: "planned" | "running" | "completed" | "failed";
}
