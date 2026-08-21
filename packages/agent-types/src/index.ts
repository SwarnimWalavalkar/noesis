import type {
  ArtifactFileRef,
  CapabilityRevisionRef,
  EvidenceRef,
  EvidenceRevisionRef,
  ExperimentVariantRef,
  FileRevisionRef,
  JsonValue,
  PermissionManifest,
  ProjectRef,
} from "@noesis/domain";
import {
  ArtifactFileRefSchema,
  createConditionalObject,
  CapabilityRevisionRefSchema,
  canonicalJson,
  EvidenceRefSchema,
  FileRevisionRefSchema,
  ProjectRefSchema,
  sha256,
} from "@noesis/domain";
import { z } from "zod";
export type AgentRole =
  | "foreground"
  | "capability_router"
  | "session_compactor"
  | "history_reranker"
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
  | {
      readonly kind: "genesis";
    }
  | {
      readonly kind: "unknown_legacy";
    }
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
export type FrozenCapabilityEffect =
  | {
      readonly kind: "instruction";
      readonly material: FrozenRevisionMaterial;
    }
  | {
      readonly kind: "skill";
      readonly name: string;
      readonly description: string;
      readonly material: FrozenRevisionMaterial;
    }
  | {
      readonly kind: "script" | "workflow";
      readonly name: string;
      readonly project: ProjectRef;
      readonly definition: FrozenRevisionMaterial;
    };
export interface FrozenCapabilitySelection {
  readonly capabilityId: string;
  readonly name: string;
  readonly scope: string;
  readonly selectionReason: string;
  readonly revision: CapabilityRevisionRef;
  readonly baseline: FrozenBaselineRef;
  /** Present on effects-first revisions. Legacy frozen plans omit it. */
  readonly effects?: readonly FrozenCapabilityEffect[] | undefined;
  readonly promptModules: readonly FrozenRevisionMaterial[];
  readonly skills: readonly FrozenRevisionMaterial[];
  readonly tools: readonly FrozenRevisionMaterial[];
  readonly router: FrozenRevisionMaterial;
  readonly permissionManifest: PermissionManifest;
}
export interface FrozenConversationHistoryEntry {
  readonly messageId: string;
  readonly messageRef: {
    readonly kind: "database_row";
    readonly table: "messages";
    readonly rowId: string;
  };
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly createdAt: string;
  readonly contentDigest: string;
  /** Terminal state of the source turn. Older plans omit this field. */
  readonly turnStatus?: "completed" | "failed" | "aborted";
}
export function renderFrozenConversationHistoryContent(entry: {
  readonly content: string;
  readonly role: "user" | "assistant";
  readonly turnStatus?: "completed" | "failed" | "aborted" | undefined;
}): string {
  if (entry.turnStatus !== "failed" && entry.turnStatus !== "aborted") return entry.content;
  const kind = entry.role === "user" ? "user message" : "partial assistant message";
  return `[Previous ${kind} from a turn that ${entry.turnStatus} before completion.]\n${entry.content}`;
}
export interface FrozenContextCheckpoint {
  readonly checkpointId: string;
  readonly checkpointRef: {
    readonly kind: "database_row";
    readonly table: "context_checkpoints";
    readonly rowId: string;
  };
  readonly summary: string;
  readonly summaryDigest: string;
  readonly sourceDigest: string;
  readonly sensitivity: "normal" | "private" | "secret";
  readonly createdAt: string;
}
export interface FrozenContextDocument {
  readonly documentId: string;
  readonly artifact: {
    readonly kind: "artifact_file";
    readonly artifactId: string;
    readonly path: string;
    readonly mediaType: "application/x-ndjson";
  };
  readonly format: "noesis-session-context-v1";
  /** UTF-16 code units, matching JavaScript String.length and String.slice. */
  readonly characterLength: number;
  readonly byteLength: number;
  readonly contentDigest: string;
}
export const MAX_FROZEN_CONVERSATION_HISTORY_MESSAGES = 512;
export const MAX_FROZEN_CONVERSATION_HISTORY_ENTRY_CHARACTERS = 96000;
export const MAX_FROZEN_CONVERSATION_HISTORY_TOTAL_CHARACTERS = 4000000;
export const MAX_FROZEN_CONTEXT_CHECKPOINT_SUMMARY_CHARACTERS = 32000;
/**
 * Provider-independent token estimate used when a provider has not reported usage yet.
 * BPE tokenizers average roughly four UTF-8 bytes per token. Provider-owned usage replaces
 * this estimate at the execution boundary as soon as a successful response is available.
 */
export function estimateInputTokens(text: string): number {
  return Math.max(1, Math.ceil(new TextEncoder().encode(text).byteLength / 4));
}
/** The complete SQLite-authoritative input to one foreground execution. */
export interface FrozenTurnPlan {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** Host-derived project identity. Absent only on plans persisted before project-local adjustment support. */
  readonly project?: ProjectRef;
  /** Exact immutable project adjustment admitted to this turn, when one was active. */
  readonly workingAdjustmentId?: string;
  readonly activationId: string;
  readonly activationRevision: number;
  readonly selectedCapabilities: readonly FrozenCapabilitySelection[];
  /** Exact bounded SQLite-authoritative history served to this turn. Absent only on legacy plans. */
  readonly conversationHistory?: readonly FrozenConversationHistoryEntry[];
  /** Immutable summary checkpoint served before the exact raw history tail. */
  readonly contextCheckpoint?: FrozenContextCheckpoint;
  /** Complete immutable pre-turn session timeline exposed lazily to codemode. */
  readonly contextDocument?: FrozenContextDocument;
  /** Estimated-token budget shared by the checkpoint summary and raw history tail. */
  readonly contextTokenBudget?: number;
  /** Estimated-token ceiling for the complete provider request, including tools and current input. */
  readonly requestTokenBudget?: number;
  readonly renderedSystemPrompt: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: AgentThinkingLevel;
  readonly permissionSnapshot: PermissionManifest;
  readonly retrievalCitations: readonly EvidenceRef[];
  readonly routing: {
    readonly strategyId: string;
    readonly reason: string;
    readonly learningAttribution?: {
      readonly capabilityId: string;
      readonly reason: string;
    };
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
const FrozenCapabilityEffectSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("instruction"),
    material: FrozenRevisionMaterialSchema,
  }),
  z.strictObject({
    kind: z.literal("skill"),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    description: z.string().min(1).max(2048),
    material: FrozenRevisionMaterialSchema,
  }),
  z.strictObject({
    kind: z.literal("script"),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    project: ProjectRefSchema,
    definition: FrozenRevisionMaterialSchema,
  }),
  z.strictObject({
    kind: z.literal("workflow"),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    project: ProjectRefSchema,
    definition: FrozenRevisionMaterialSchema,
  }),
]);
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
  effects: z.array(FrozenCapabilityEffectSchema).min(1).max(32).optional(),
  promptModules: z.array(FrozenRevisionMaterialSchema),
  skills: z.array(FrozenRevisionMaterialSchema),
  tools: z.array(FrozenRevisionMaterialSchema),
  router: FrozenRevisionMaterialSchema,
  permissionManifest: PermissionManifestSchema,
});
const FrozenConversationHistoryEntrySchema = z.strictObject({
  messageId: z.string().min(1),
  messageRef: z.strictObject({
    kind: z.literal("database_row"),
    table: z.literal("messages"),
    rowId: z.string().min(1),
  }),
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
  createdAt: z.string().min(1),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  turnStatus: z.enum(["completed", "failed", "aborted"]).optional(),
});
const FrozenContextCheckpointSchema = z.strictObject({
  checkpointId: z.string().min(1),
  checkpointRef: z.strictObject({
    kind: z.literal("database_row"),
    table: z.literal("context_checkpoints"),
    rowId: z.string().min(1),
  }),
  summary: z.string().min(1).max(MAX_FROZEN_CONTEXT_CHECKPOINT_SUMMARY_CHARACTERS),
  summaryDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  sensitivity: z.enum(["normal", "private", "secret"]),
  createdAt: z.string().min(1),
});
const FrozenContextDocumentSchema = z.strictObject({
  documentId: z.string().min(1),
  artifact: ArtifactFileRefSchema.extend({
    mediaType: z.literal("application/x-ndjson"),
  }),
  format: z.literal("noesis-session-context-v1"),
  characterLength: z.number().int().nonnegative(),
  byteLength: z.number().int().nonnegative(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const FrozenTurnPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  planId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  project: ProjectRefSchema.optional(),
  workingAdjustmentId: z.string().min(1).optional(),
  activationId: z.string().min(1),
  activationRevision: z.number().int().positive(),
  selectedCapabilities: z.array(FrozenCapabilitySelectionSchema),
  conversationHistory: z.array(FrozenConversationHistoryEntrySchema).optional(),
  contextCheckpoint: FrozenContextCheckpointSchema.optional(),
  contextDocument: FrozenContextDocumentSchema.optional(),
  contextTokenBudget: z.number().int().positive().max(1000000).optional(),
  requestTokenBudget: z.number().int().positive().max(1000000).optional(),
  renderedSystemPrompt: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  permissionSnapshot: PermissionManifestSchema,
  retrievalCitations: z.array(EvidenceRefSchema),
  routing: z.strictObject({
    strategyId: z.string().min(1),
    reason: z.string().min(1),
    learningAttribution: z
      .strictObject({
        capabilityId: z.string().min(1),
        reason: z.string().min(1),
      })
      .optional(),
  }),
  createdAt: z.string().min(1),
  canonicalDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
export function frozenTurnPlanDigest(plan: Omit<FrozenTurnPlan, "canonicalDigest">): string {
  return sha256(canonicalJson(plan));
}
export function validateFrozenTurnPlan(value: unknown): FrozenTurnPlan {
  const decoded = FrozenTurnPlanSchema.parse(value);
  const {
    conversationHistory,
    contextCheckpoint,
    contextDocument,
    contextTokenBudget,
    requestTokenBudget,
    project,
    workingAdjustmentId,
    routing,
    ...base
  } = decoded;
  const { learningAttribution, ...routingBase } = routing;
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const normalizedConversationHistory = conversationHistory?.map(({ turnStatus, ...entry }) =>
    Object.freeze(
      createConditionalObject({
        ...entry,
      } as const)
        .addOptional(!(turnStatus === undefined) ? { turnStatus } : undefined)
        .finish(),
    ),
  );
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const plan = Object.freeze(
    createConditionalObject({
      ...base,
    } as const)
      .addOptional(
        !(normalizedConversationHistory === undefined)
          ? {
              conversationHistory: Object.freeze(normalizedConversationHistory),
            }
          : undefined,
      )
      .addOptional(
        !(contextCheckpoint === undefined)
          ? {
              contextCheckpoint: Object.freeze({ ...contextCheckpoint }),
            }
          : undefined,
      )
      .addOptional(
        !(contextDocument === undefined)
          ? {
              contextDocument: Object.freeze({
                ...contextDocument,
                artifact: Object.freeze({ ...contextDocument.artifact }),
              }),
            }
          : undefined,
      )
      .addOptional(!(contextTokenBudget === undefined) ? { contextTokenBudget } : undefined)
      .addOptional(!(requestTokenBudget === undefined) ? { requestTokenBudget } : undefined)
      .addOptional(!(project === undefined) ? { project: Object.freeze({ ...project }) } : undefined)
      .addOptional(!(workingAdjustmentId === undefined) ? { workingAdjustmentId } : undefined)
      .add({
        routing: Object.freeze(
          createConditionalObject({
            ...routingBase,
          } as const)
            .addOptional(!(learningAttribution === undefined) ? { learningAttribution } : undefined)
            .finish(),
        ),
      } as const)
      .finish(),
  ) satisfies FrozenTurnPlan;
  for (const selection of plan.selectedCapabilities) {
    const effectMaterials = (selection.effects ?? []).map((effect) =>
      effect.kind === "instruction" || effect.kind === "skill" ? effect.material : effect.definition,
    );
    const materials = [
      ...selection.promptModules,
      ...selection.skills,
      ...selection.tools,
      selection.router,
      ...effectMaterials,
    ];
    for (const material of materials) {
      if (sha256(material.content) !== material.revision.contentDigest)
        throw new Error(
          `Frozen turn plan ${plan.planId} material ${material.revision.revisionId} failed content digest verification`,
        );
    }
  }
  if (plan.workingAdjustmentId !== undefined && plan.project === undefined)
    throw new Error(
      `Frozen turn plan ${plan.planId} pins a working adjustment without a host-derived project`,
    );
  if ((plan.conversationHistory?.length ?? 0) > MAX_FROZEN_CONVERSATION_HISTORY_MESSAGES)
    throw new Error(`Frozen turn plan ${plan.planId} exceeds the conversation-history message bound`);
  const historyMessageIds = new Set<string>();
  let historyCharacters = 0;
  for (const entry of plan.conversationHistory ?? []) {
    if (entry.messageRef.rowId !== entry.messageId)
      throw new Error(
        `Frozen turn plan ${plan.planId} history ref ${entry.messageRef.rowId} does not match ${entry.messageId}`,
      );
    if (sha256(entry.content) !== entry.contentDigest)
      throw new Error(
        `Frozen turn plan ${plan.planId} history message ${entry.messageId} failed content digest verification`,
      );
    const renderedContent = renderFrozenConversationHistoryContent(entry);
    if (renderedContent.length > MAX_FROZEN_CONVERSATION_HISTORY_ENTRY_CHARACTERS)
      throw new Error(
        `Frozen turn plan ${plan.planId} history message ${entry.messageId} exceeds the per-entry character bound`,
      );
    historyCharacters += renderedContent.length;
    if (historyCharacters > MAX_FROZEN_CONVERSATION_HISTORY_TOTAL_CHARACTERS)
      throw new Error(`Frozen turn plan ${plan.planId} exceeds the total history character bound`);
    if (historyMessageIds.has(entry.messageId))
      throw new Error(`Frozen turn plan ${plan.planId} repeats history message ${entry.messageId}`);
    historyMessageIds.add(entry.messageId);
  }
  if (plan.contextCheckpoint !== undefined) {
    if (plan.contextTokenBudget === undefined)
      throw new Error(`Frozen turn plan ${plan.planId} pins a context checkpoint without a token budget`);
    if (plan.contextCheckpoint.checkpointRef.rowId !== plan.contextCheckpoint.checkpointId)
      throw new Error(`Frozen turn plan ${plan.planId} has a mismatched context checkpoint reference`);
    if (sha256(plan.contextCheckpoint.summary) !== plan.contextCheckpoint.summaryDigest)
      throw new Error(`Frozen turn plan ${plan.planId} context checkpoint failed summary verification`);
  }
  if (plan.contextDocument !== undefined) {
    if (plan.contextDocument.documentId !== `context_document_${plan.contextDocument.contentDigest}`)
      throw new Error(`Frozen turn plan ${plan.planId} has a mismatched context document identity`);
    if (plan.contextDocument.artifact.mediaType !== "application/x-ndjson")
      throw new Error(`Frozen turn plan ${plan.planId} has an unsupported context document type`);
  }
  if (plan.contextTokenBudget !== undefined) {
    const estimatedContextTokens =
      (plan.contextCheckpoint === undefined ? 0 : estimateInputTokens(plan.contextCheckpoint.summary)) +
      (plan.conversationHistory ?? []).reduce(
        (total, entry) => total + estimateInputTokens(renderFrozenConversationHistoryContent(entry)),
        0,
      );
    if (estimatedContextTokens > plan.contextTokenBudget)
      throw new Error(`Frozen turn plan ${plan.planId} exceeds its context token budget`);
  }
  if (
    plan.contextTokenBudget !== undefined &&
    plan.requestTokenBudget !== undefined &&
    plan.contextTokenBudget >= plan.requestTokenBudget
  )
    throw new Error(`Frozen turn plan ${plan.planId} does not reserve non-history request capacity`);
  const narrowSelections = plan.selectedCapabilities.filter(
    (selection) => selection.baseline.kind !== "genesis",
  );
  const attribution = plan.routing.learningAttribution;
  if (narrowSelections.length === 0 && attribution !== undefined)
    throw new Error(`Frozen turn plan ${plan.planId} attributes learning without a narrow capability`);
  if (
    attribution !== undefined &&
    !narrowSelections.some((selection) => selection.capabilityId === attribution.capabilityId)
  )
    throw new Error(
      `Frozen turn plan ${plan.planId} attributes learning to unselected capability ${attribution.capabilityId}`,
    );
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
  /** Prior conversation preserved at its original instruction level. */
  readonly history?: readonly {
    readonly role: "user" | "assistant";
    readonly content: string;
    readonly createdAt?: string;
  }[];
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
  /** The canonical Broker recorder owns persistence for this action. */
  readonly recordedByBroker?: boolean;
}
export interface AgentActionUpdateEvent {
  readonly type: "tool-update";
  readonly actionId: string;
  readonly parentActionId?: string;
  readonly name: string;
  /** A bounded snapshot of current progress, not an unbounded output delta. */
  readonly update: JsonValue;
  readonly recordedByBroker?: boolean;
}
export interface AgentActionEndEvent {
  readonly type: "tool-end";
  readonly actionId: string;
  readonly parentActionId?: string;
  readonly name: string;
  readonly isError: boolean;
  /** A bounded final result or error representation. */
  readonly result: JsonValue;
  readonly recordedByBroker?: boolean;
}
export type AgentActionEvent = AgentActionStartEvent | AgentActionUpdateEvent | AgentActionEndEvent;
export interface AgentAssistantMessageBoundary {
  readonly text: string;
  readonly timelineSequence: number;
  readonly createdAt: string;
}
export type AgentRuntimeEvent =
  | {
      readonly type: "delta";
      readonly text: string;
    }
  | {
      readonly type: "model";
      readonly provider: string;
      readonly model: string;
      readonly contextWindow: number;
    }
  | ({
      readonly type: "usage";
    } & AgentContextUsage)
  | ({
      readonly type: "assistant-message";
    } & AgentAssistantMessageBoundary)
  | AgentActionEvent
  | {
      readonly type: "status";
      readonly status: "started" | "completed" | "aborted";
    }
  | {
      readonly type: "status";
      readonly status: "failed";
      readonly error: string;
    };
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
