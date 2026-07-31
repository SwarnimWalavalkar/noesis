import type {
  ArtifactFileRef,
  CapabilityRevisionRef,
  EvidenceRef,
  EvidenceRevisionRef,
  ExperimentVariantRef,
  FileRevisionRef,
  JsonValue,
  PermissionManifest,
} from "@noesis/domain";
import {
  CapabilityRevisionRefSchema,
  EvidenceRefSchema,
  FileRevisionRefSchema,
  canonicalJson,
  sha256,
} from "@noesis/domain";
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
  readonly signal?: AbortSignal;
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

export type FrozenBaselineRef =
  | { readonly kind: "genesis" }
  | { readonly kind: "unknown_legacy" }
  | {
      readonly kind: "capability_revision";
      readonly experimentId: string;
      readonly revision: CapabilityRevisionRef;
    };

export interface FrozenRevisionMaterial {
  readonly revision: FileRevisionRef;
  /** Exact UTF-8 bytes decoded from the immutable revision at planning time. */
  readonly content: string;
}

export interface FrozenCapabilitySelection {
  readonly capabilityId: string;
  readonly name: string;
  readonly scope: string;
  readonly selectionReason: string;
  readonly revision: CapabilityRevisionRef;
  readonly baseline: FrozenBaselineRef;
  readonly promptModules: readonly FrozenRevisionMaterial[];
  readonly skills: readonly FrozenRevisionMaterial[];
  readonly tools: readonly FrozenRevisionMaterial[];
  readonly router: FrozenRevisionMaterial;
  readonly permissionManifest: PermissionManifest;
}

/** The complete SQLite-authoritative input to one foreground execution. */
export interface FrozenTurnPlan {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly activationId: string;
  readonly activationRevision: number;
  readonly selectedCapabilities: readonly FrozenCapabilitySelection[];
  readonly renderedSystemPrompt: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: AgentThinkingLevel;
  readonly permissionSnapshot: PermissionManifest;
  readonly retrievalCitations: readonly EvidenceRef[];
  readonly routing: {
    readonly strategyId: string;
    readonly reason: string;
  };
  readonly createdAt: string;
  readonly canonicalDigest: string;
}

const PermissionManifestSchema = z.strictObject({
  effects: z.array(z.string()),
  resourcePatterns: z.array(z.string()),
  credentialRefs: z.array(z.string()),
});
const FrozenRevisionMaterialSchema = z.strictObject({
  revision: FileRevisionRefSchema,
  content: z.string(),
});
const FrozenBaselineRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("genesis") }),
  z.strictObject({ kind: z.literal("unknown_legacy") }),
  z.strictObject({
    kind: z.literal("capability_revision"),
    experimentId: z.string().min(1),
    revision: CapabilityRevisionRefSchema,
  }),
]);
const FrozenCapabilitySelectionSchema = z.strictObject({
  capabilityId: z.string().min(1),
  name: z.string().min(1),
  scope: z.string().min(1),
  selectionReason: z.string().min(1),
  revision: CapabilityRevisionRefSchema,
  baseline: FrozenBaselineRefSchema,
  promptModules: z.array(FrozenRevisionMaterialSchema),
  skills: z.array(FrozenRevisionMaterialSchema),
  tools: z.array(FrozenRevisionMaterialSchema),
  router: FrozenRevisionMaterialSchema,
  permissionManifest: PermissionManifestSchema,
});

export const FrozenTurnPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  planId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  activationId: z.string().min(1),
  activationRevision: z.number().int().positive(),
  selectedCapabilities: z.array(FrozenCapabilitySelectionSchema),
  renderedSystemPrompt: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  permissionSnapshot: PermissionManifestSchema,
  retrievalCitations: z.array(EvidenceRefSchema),
  routing: z.strictObject({
    strategyId: z.string().min(1),
    reason: z.string().min(1),
  }),
  createdAt: z.string().min(1),
  canonicalDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});

export function frozenTurnPlanDigest(plan: Omit<FrozenTurnPlan, "canonicalDigest">): string {
  return sha256(canonicalJson(plan));
}

export function validateFrozenTurnPlan(value: unknown): FrozenTurnPlan {
  const plan = FrozenTurnPlanSchema.parse(value);
  for (const selection of plan.selectedCapabilities) {
    const materials = [...selection.promptModules, ...selection.skills, ...selection.tools, selection.router];
    for (const material of materials) {
      if (sha256(material.content) !== material.revision.contentDigest)
        throw new Error(
          `Frozen turn plan ${plan.planId} material ${material.revision.revisionId} failed content digest verification`,
        );
    }
  }
  const { canonicalDigest, ...unsigned } = plan;
  if (frozenTurnPlanDigest(unsigned) !== canonicalDigest)
    throw new Error(`Frozen turn plan ${plan.planId} failed canonical digest verification`);
  return plan;
}

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
  /** Present on the product application path; legacy package tests may omit it until HL-11. */
  readonly frozenTurnPlan?: FrozenTurnPlan;
}

export interface AgentActionStartEvent {
  readonly type: "tool-start";
  /** Adapter-neutral stable identity for the lifetime of this action. */
  readonly actionId: string;
  /** Present when this action was invoked from another action, such as an SDK call inside execute. */
  readonly parentActionId?: string;
  readonly name: string;
  readonly input: JsonValue;
  /** Position in the adapter-observed mixed interaction timeline for this turn. */
  readonly timelineSequence?: number;
}

export interface AgentActionUpdateEvent {
  readonly type: "tool-update";
  readonly actionId: string;
  readonly parentActionId?: string;
  readonly name: string;
  /** A bounded snapshot of current progress, not an unbounded output delta. */
  readonly update: JsonValue;
}

export interface AgentActionEndEvent {
  readonly type: "tool-end";
  readonly actionId: string;
  readonly parentActionId?: string;
  readonly name: string;
  readonly isError: boolean;
  /** A bounded final result or error representation. */
  readonly result: JsonValue;
}

export type AgentActionEvent = AgentActionStartEvent | AgentActionUpdateEvent | AgentActionEndEvent;

export interface AgentAssistantMessageBoundary {
  readonly text: string;
  readonly timelineSequence: number;
  readonly createdAt: string;
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
  | ({ readonly type: "assistant-message" } & AgentAssistantMessageBoundary)
  | AgentActionEvent
  | { readonly type: "status"; readonly status: "started" | "completed" | "aborted" }
  | { readonly type: "status"; readonly status: "failed"; readonly error: string };

interface AgentRuntimeResultBase {
  readonly text: string;
  readonly assistantMessages?: readonly AgentAssistantMessageBoundary[];
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

/**
 * Durable steering may only be acknowledged after Pi injects the queued user message into the
 * active loop. Queue acceptance alone is not delivery.
 */
export type AgentSteerResult =
  | {
      readonly status: "consumed";
      readonly timelineSequence: number;
      readonly consumedAt: string;
    }
  | {
      readonly status: "not-consumed";
      readonly reason: "not-running" | "turn-ended" | "aborted";
    };

export interface NoesisAgentRuntime {
  readonly name: string;
  readonly run: (
    request: AgentRuntimeRequest,
    emit: (event: AgentRuntimeEvent) => void,
  ) => Promise<AgentRuntimeResult>;
  readonly steer: (trailId: string, text: string) => Promise<AgentSteerResult>;
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
