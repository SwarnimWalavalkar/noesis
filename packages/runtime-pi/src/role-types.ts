import type {
  AgentMessage,
  AgentRole,
  AgentRunRequest,
  AgentRunResult,
  AgentTrace,
  AgentUsage,
} from "@noesis/agent-types";
import type { CapabilityRevisionRef, ExperimentVariantRef } from "@noesis/domain";

export type RoleReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type RoleStopReason = "stop" | "length" | "toolUse" | "aborted" | "error";

export interface RoleContextPolicy {
  readonly policyId: string;
  readonly maxMessages: number;
  readonly maxCharactersPerMessage: number;
  readonly maxTotalCharacters: number;
  readonly maxEvidenceRefs: number;
  readonly maxTools: number;
  readonly allowedMessageNames?: readonly string[];
  readonly includeCapabilityRevisions: boolean;
  readonly forbiddenContent?: RegExp;
}

export interface RoleVariantConfiguration {
  readonly variant: ExperimentVariantRef;
  readonly role: AgentRole;
  readonly provider: string;
  readonly model: string;
  readonly reasoning: RoleReasoningLevel;
  readonly systemPrompt: string;
  readonly contextPolicy: RoleContextPolicy;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

export interface RuntimePiAgentRunRequest extends AgentRunRequest {
  readonly capabilityRevisions: readonly CapabilityRevisionRef[];
  readonly signal?: AbortSignal;
}

export interface BoundedRoleInput {
  readonly runId: string;
  readonly role: AgentRole;
  readonly variant: ExperimentVariantRef;
  readonly messages: readonly AgentMessage[];
  readonly evidenceRefs: AgentRunRequest["evidenceRefs"];
  readonly availableTools: AgentRunRequest["availableTools"];
  readonly capabilityRevisions: readonly CapabilityRevisionRef[];
}

export interface RoleBackendRequest {
  readonly runId: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoning: RoleReasoningLevel;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly signal: AbortSignal;
}

export interface RoleBackendResult {
  readonly text: string;
  readonly provider: string;
  readonly model: string;
  readonly stopReason: RoleStopReason;
  readonly usage: AgentUsage;
  readonly error?: string;
}

export interface RoleModelBackend {
  readonly run: (request: RoleBackendRequest) => Promise<RoleBackendResult>;
  readonly abort: (runId: string) => Promise<void>;
}

export interface RoleRunTelemetry {
  readonly provider: string;
  readonly model: string;
  readonly reasoning: RoleReasoningLevel;
  readonly contextPolicyId: string;
  readonly latencyMs: number;
  readonly stopReason: RoleStopReason;
  readonly status: "completed" | "aborted" | "failed";
  readonly attempts: number;
  readonly repairAttempts: number;
  readonly failure?: {
    readonly code: "aborted" | "backend" | "configuration" | "malformed_output";
    readonly message: string;
  };
}

export interface RuntimePiAgentTrace extends AgentTrace {
  readonly capabilityRevisions: readonly CapabilityRevisionRef[];
  readonly telemetry: RoleRunTelemetry;
}

export interface RuntimePiAgentRunResult extends AgentRunResult {
  readonly trace: RuntimePiAgentTrace;
  readonly capabilityRevisions: readonly CapabilityRevisionRef[];
}

export interface RuntimePiAgentRoleRunner {
  readonly run: (request: AgentRunRequest) => Promise<RuntimePiAgentRunResult>;
  readonly abort: (runId: string) => Promise<void>;
}

export interface RuntimePiStructuredInferencePort {
  readonly run: <T>(
    request: AgentRunRequest,
    outputSchema: import("zod").ZodType<T>,
  ) => Promise<{
    readonly value: T;
    readonly trace: RuntimePiAgentTrace;
    readonly capabilityRevisions: readonly CapabilityRevisionRef[];
  }>;
}

export interface FakeRoleResponse {
  readonly text: string;
  readonly stopReason?: RoleStopReason;
  readonly usage?: AgentUsage;
  readonly latencyMs?: number;
  readonly error?: string;
}

export interface ComparableRoleVariantFixture {
  readonly baseline: RuntimePiAgentRunRequest;
  readonly candidate: RuntimePiAgentRunRequest;
  readonly capabilityRevisions: readonly CapabilityRevisionRef[];
}

export interface BlindedJudgeFixture {
  readonly messages: readonly AgentMessage[];
  readonly labels: Readonly<Record<"A" | "B", "first" | "second">>;
}
