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

export interface ResearchExperimentRun {
  readonly experimentId: string;
  readonly question: string;
  readonly axis: ExperimentVariantRef["axis"];
  readonly baselineVariant: ExperimentVariantRef;
  readonly candidateVariants: readonly ExperimentVariantRef[];
  readonly inputRefs: readonly EvidenceRef[];
  readonly trialRefs: readonly EvidenceRef[];
  readonly comparisonRef?: EvidenceRevisionRef;
  readonly status: "planned" | "running" | "completed" | "failed";
}
