import type { DatabaseRow } from "./database.ts";
import {
  createConditionalObject,
  CapabilityRevisionRefSchema,
  ExperimentSchema,
  FeedbackSignalSchema,
  FileRevisionRefSchema,
  JsonValueSchema,
  type Experiment,
  type FeedbackSignal,
  type FileRevisionRef,
} from "@noesis/domain";
import { z } from "zod";
import { optionalString, parseJson, requiredNumber, requiredString } from "./database.ts";
import type {
  ActivationApprovalRecord,
  ActivationEvidenceBinding,
  ActivationMaterializationRecord,
  ActivationOperationRecord,
  ActivationRecord,
  CanonicalSearchSource,
  CodeExecutionRecord,
  ModelCallRecord,
  MessageRecord,
  OutcomeRecord,
  SearchConfiguration,
  SearchDocument,
  SessionRecord,
  ToolCallRecord,
  TurnActivationPinRecord,
  UserIntentRecord,
  WorkflowPhaseRunRecord,
  WorkflowRunRecord,
} from "./types.ts";
export const JsonRecordSchema = z.record(z.string(), JsonValueSchema);
export const SearchConfigurationSchema = z.strictObject({
  lexicalLimit: z.number().int().min(1).max(1000),
  semanticLimit: z.number().int().min(0).max(1000),
  rerankLimit: z.number().int().min(0).max(100),
  maxExcerptChars: z.number().int().min(32).max(8000),
  includePrivate: z.boolean(),
  updatedAt: z.string().min(1),
});
export const SensitivitySchema = z.enum(["normal", "private", "secret"]);
const SessionStatusSchema = z.enum(["idle", "running", "completed", "aborted", "failed"]);
const MessageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);
const UserIntentModeSchema = z.enum(["turn", "steer"]);
const UserIntentStatusSchema = z.enum([
  "pending",
  "held",
  "dispatching",
  "unresolved",
  "delivered",
  "withdrawn",
]);
const UserIntentSteerOriginSchema = z.enum(["explicit", "queued"]);
const ToolCallStatusSchema = z.enum(["requested", "running", "completed", "failed", "denied", "ambiguous"]);
const CodeExecutionStatusSchema = z.enum(["running", "completed", "failed", "cancelled", "interrupted"]);
const ModelCallStatusSchema = z.enum(["running", "completed", "failed", "cancelled"]);
const WorkflowRunStatusSchema = z.enum(["running", "paused", "completed", "failed", "cancelled"]);
const WorkflowPhaseStatusSchema = z.enum(["pending", "running", "completed", "failed", "cancelled"]);
const OutcomeStatusSchema = z.enum(["accepted", "corrected", "failed", "unknown"]);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ActivationEvidenceBindingSchema: z.ZodType<ActivationEvidenceBinding> = z.strictObject({
  experimentId: z.string().min(1),
  candidateRevision: CapabilityRevisionRefSchema,
  manifestRevision: FileRevisionRefSchema,
  preflightId: z.string().min(1),
  planId: z.string().min(1),
  candidateDigest: DigestSchema,
  manifestDigest: DigestSchema,
  suiteDigest: DigestSchema,
  preflightDigest: DigestSchema,
  reportDigest: DigestSchema,
  definitionSetDigest: DigestSchema,
  controlRevisionId: z.string().min(1).nullable(),
  sourceAdjustmentId: z.string().min(1).optional(),
});
const ActivationPolicyDecisionSchema = z.enum(["block", "approval_required", "eligible_auto_activate"]);
const ActivationOperationStatusSchema = z.enum([
  "blocked",
  "staged",
  "pending_approval",
  "approved",
  "rejected",
  "committed",
]);
const ActivationPolicySnapshotSchema = z.record(z.string(), JsonValueSchema);
export function decodeFileRevisionRef(row: DatabaseRow | undefined): FileRevisionRef {
  return FileRevisionRefSchema.parse({
    kind: "file_revision",
    revisionId: requiredString(row, "revision_id"),
    workingPath: requiredString(row, "working_path"),
    snapshotPath: requiredString(row, "snapshot_path"),
    contentDigest: requiredString(row, "content_digest"),
  });
}
export function decodeSession(row: DatabaseRow | undefined): SessionRecord {
  const parentSessionId = optionalString(row, "parent_session_id");
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return createConditionalObject({
    sessionId: requiredString(row, "session_id"),
  } as const)
    .addOptional(!(parentSessionId === undefined) ? { parentSessionId } : undefined)
    .add({
      title: requiredString(row, "title"),
      status: SessionStatusSchema.parse(requiredString(row, "status")),
      provider: requiredString(row, "provider"),
      model: requiredString(row, "model"),
      runtime: requiredString(row, "runtime"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
      metadata: JsonRecordSchema.parse(parseJson(requiredString(row, "metadata_json"))),
    } as const)
    .finish();
}
export function decodeMessage(row: DatabaseRow | undefined): MessageRecord {
  const timelineSequence = row?.["timeline_sequence"];
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return createConditionalObject({
    messageId: requiredString(row, "message_id"),
    sessionId: requiredString(row, "session_id"),
    role: MessageRoleSchema.parse(requiredString(row, "role")),
    content: requiredString(row, "content"),
    sensitivity: SensitivitySchema.parse(requiredString(row, "sensitivity")),
    createdAt: requiredString(row, "created_at"),
    metadata: JsonRecordSchema.parse(parseJson(requiredString(row, "metadata_json"))),
  } as const)
    .addOptional(
      !(timelineSequence === null || timelineSequence === undefined)
        ? {
            timelineSequence: z.number().int().nonnegative().parse(timelineSequence),
          }
        : undefined,
    )
    .finish();
}
export function decodeUserIntent(row: DatabaseRow | undefined): UserIntentRecord {
  const text = optionalString(row, "text");
  const queuedBehindTurnId = optionalString(row, "queued_behind_turn_id");
  const targetTurnId = optionalString(row, "target_turn_id");
  const promotedAt = optionalString(row, "promoted_at");
  const heldAt = optionalString(row, "held_at");
  const deliveredAt = optionalString(row, "delivered_at");
  const unresolvedAt = optionalString(row, "unresolved_at");
  const withdrawnAt = optionalString(row, "withdrawn_at");
  const steerOrigin = optionalString(row, "steer_origin");
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze(
    createConditionalObject({
      intentId: requiredString(row, "intent_id"),
      sessionId: requiredString(row, "session_id"),
    } as const)
      .addOptional(!(text === undefined) ? { text } : undefined)
      .add({
        contentDigest: requiredString(row, "content_digest"),
        deliveryMode: UserIntentModeSchema.parse(requiredString(row, "delivery_mode")),
        status: UserIntentStatusSchema.parse(requiredString(row, "status")),
        queueSequence: requiredNumber(row, "queue_sequence"),
      } as const)
      .addOptional(!(queuedBehindTurnId === undefined) ? { queuedBehindTurnId } : undefined)
      .addOptional(!(targetTurnId === undefined) ? { targetTurnId } : undefined)
      .add({
        createdAt: requiredString(row, "created_at"),
        updatedAt: requiredString(row, "updated_at"),
      } as const)
      .addOptional(!(heldAt === undefined) ? { heldAt } : undefined)
      .addOptional(!(promotedAt === undefined) ? { promotedAt } : undefined)
      .addOptional(!(deliveredAt === undefined) ? { deliveredAt } : undefined)
      .addOptional(!(unresolvedAt === undefined) ? { unresolvedAt } : undefined)
      .addOptional(!(withdrawnAt === undefined) ? { withdrawnAt } : undefined)
      .addOptional(
        !(steerOrigin === undefined)
          ? {
              steerOrigin: UserIntentSteerOriginSchema.parse(steerOrigin),
            }
          : undefined,
      )
      .add({
        attemptCount: requiredNumber(row, "attempt_count"),
      } as const)
      .finish(),
  );
}
export function decodeToolCall(row: DatabaseRow | undefined): ToolCallRecord {
  const turnId = optionalString(row, "turn_id");
  const response = optionalString(row, "response_json");
  const update = optionalString(row, "update_json");
  const messageId = optionalString(row, "message_id");
  const parentToolCallId = optionalString(row, "parent_tool_call_id");
  const executionId = optionalString(row, "execution_id");
  const completedAt = optionalString(row, "completed_at");
  const timelineSequence = row?.["timeline_sequence"];
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return createConditionalObject({
    toolCallId: requiredString(row, "tool_call_id"),
    sessionId: requiredString(row, "session_id"),
  } as const)
    .addOptional(!(turnId === undefined) ? { turnId } : undefined)
    .addOptional(!(messageId === undefined) ? { messageId } : undefined)
    .addOptional(!(parentToolCallId === undefined) ? { parentToolCallId } : undefined)
    .addOptional(!(executionId === undefined) ? { executionId } : undefined)
    .add({
      toolName: requiredString(row, "tool_name"),
      request: parseJson(requiredString(row, "request_json")),
    } as const)
    .addOptional(!(update === undefined) ? { update: parseJson(update) } : undefined)
    .addOptional(!(response === undefined) ? { response: parseJson(response) } : undefined)
    .add({
      sequence: requiredNumber(row, "action_sequence"),
    } as const)
    .addOptional(
      !(timelineSequence === null || timelineSequence === undefined)
        ? {
            timelineSequence: z.number().int().nonnegative().parse(timelineSequence),
          }
        : undefined,
    )
    .add({
      status: ToolCallStatusSchema.parse(requiredString(row, "status")),
      sensitivity: SensitivitySchema.parse(requiredString(row, "sensitivity")),
      createdAt: requiredString(row, "created_at"),
    } as const)
    .addOptional(!(completedAt === undefined) ? { completedAt } : undefined)
    .finish();
}
export function decodeCodeExecution(row: DatabaseRow | undefined): CodeExecutionRecord {
  const parentExecutionId = optionalString(row, "parent_execution_id");
  const turnId = optionalString(row, "turn_id");
  const result = optionalString(row, "result_json");
  const error = optionalString(row, "error");
  const completedAt = optionalString(row, "completed_at");
  const sourceArtifactId = optionalString(row, "source_artifact_id");
  const stdoutArtifactId = optionalString(row, "stdout_artifact_id");
  const stderrArtifactId = optionalString(row, "stderr_artifact_id");
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return createConditionalObject({
    executionId: requiredString(row, "execution_id"),
    logicalExecutionId: requiredString(row, "logical_execution_id"),
  } as const)
    .addOptional(!(parentExecutionId === undefined) ? { parentExecutionId } : undefined)
    .add({
      sessionId: requiredString(row, "session_id"),
    } as const)
    .addOptional(!(turnId === undefined) ? { turnId } : undefined)
    .add({
      catalogId: requiredString(row, "catalog_id"),
      catalogDigest: requiredString(row, "catalog_digest"),
      sourceDigest: requiredString(row, "source_digest"),
    } as const)
    .addOptional(!(sourceArtifactId === undefined) ? { sourceArtifactId } : undefined)
    .addOptional(!(stdoutArtifactId === undefined) ? { stdoutArtifactId } : undefined)
    .addOptional(!(stderrArtifactId === undefined) ? { stderrArtifactId } : undefined)
    .add({
      status: CodeExecutionStatusSchema.parse(requiredString(row, "status")),
    } as const)
    .addOptional(!(result === undefined) ? { result: JsonValueSchema.parse(parseJson(result)) } : undefined)
    .addOptional(!(error === undefined) ? { error } : undefined)
    .add({
      callCount: requiredNumber(row, "call_count"),
      startedAt: requiredString(row, "started_at"),
    } as const)
    .addOptional(!(completedAt === undefined) ? { completedAt } : undefined)
    .finish();
}
export function decodeModelCall(row: DatabaseRow | undefined): ModelCallRecord {
  const turnId = optionalString(row, "turn_id");
  const contextArtifactId = optionalString(row, "context_artifact_id");
  const outputArtifactId = optionalString(row, "output_artifact_id");
  const inputTokens = row?.["input_tokens"] ?? null;
  const outputTokens = row?.["output_tokens"] ?? null;
  const totalTokens = row?.["total_tokens"] ?? null;
  const estimatedCost = row?.["estimated_cost"] ?? null;
  const latencyMs = row?.["latency_ms"] ?? null;
  const error = optionalString(row, "error");
  const completedAt = optionalString(row, "completed_at");
  const usage =
    inputTokens === null || outputTokens === null || totalTokens === null || estimatedCost === null
      ? undefined
      : Object.freeze({
          inputTokens: z.number().int().nonnegative().parse(inputTokens),
          outputTokens: z.number().int().nonnegative().parse(outputTokens),
          totalTokens: z.number().int().nonnegative().parse(totalTokens),
          estimatedCost: z.number().nonnegative().parse(estimatedCost),
        });
  return createConditionalObject({
    modelCallId: requiredString(row, "model_call_id"),
    parentExecutionId: requiredString(row, "parent_execution_id"),
    sessionId: requiredString(row, "session_id"),
  } as const)
    .addOptional(!(turnId === undefined) ? { turnId } : undefined)
    .addOptional(!(contextArtifactId === undefined) ? { contextArtifactId } : undefined)
    .add({
      requestArtifactId: requiredString(row, "request_artifact_id"),
    } as const)
    .addOptional(!(outputArtifactId === undefined) ? { outputArtifactId } : undefined)
    .add({
      provider: requiredString(row, "provider"),
      model: requiredString(row, "model"),
      thinkingLevel: z
        .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
        .parse(requiredString(row, "thinking_level")),
      contextRefs: JsonValueSchema.parse(parseJson(requiredString(row, "context_refs_json"))),
      status: ModelCallStatusSchema.parse(requiredString(row, "status")),
    } as const)
    .addOptional(!(usage === undefined) ? { usage } : undefined)
    .addOptional(
      !(latencyMs === null || latencyMs === undefined)
        ? { latencyMs: z.number().int().nonnegative().parse(latencyMs) }
        : undefined,
    )
    .addOptional(!(error === undefined) ? { error } : undefined)
    .add({ startedAt: requiredString(row, "started_at") } as const)
    .addOptional(!(completedAt === undefined) ? { completedAt } : undefined)
    .finish();
}
export function decodeWorkflowRun(row: DatabaseRow | undefined): WorkflowRunRecord {
  const projectId = optionalString(row, "project_id");
  const turnId = optionalString(row, "turn_id");
  const catalogId = optionalString(row, "catalog_id");
  const catalogDigest = optionalString(row, "catalog_digest");
  const definitionDependenciesDigest = optionalString(row, "definition_dependencies_digest");
  const permissionDigest = optionalString(row, "permission_digest");
  const provider = optionalString(row, "provider");
  const model = optionalString(row, "model");
  const thinkingLevel = optionalString(row, "thinking_level");
  const contextArtifactId = optionalString(row, "context_artifact_id");
  const contextDigest = optionalString(row, "context_digest");
  const contextCharacterLength = row?.["context_character_length"] ?? null;
  const contextByteLength = row?.["context_byte_length"] ?? null;
  const output = optionalString(row, "output_json");
  const error = optionalString(row, "error");
  const completedAt = optionalString(row, "completed_at");
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return createConditionalObject({
    runId: requiredString(row, "run_id"),
  } as const)
    .addOptional(!(projectId === undefined) ? { projectId } : undefined)
    .add({
      workflowName: requiredString(row, "workflow_name"),
      workflowRevision: requiredNumber(row, "workflow_revision"),
      definitionRevisionId: requiredString(row, "definition_revision_id"),
    } as const)
    .addOptional(!(catalogId === undefined) ? { catalogId } : undefined)
    .addOptional(!(catalogDigest === undefined) ? { catalogDigest } : undefined)
    .addOptional(
      !(definitionDependenciesDigest === undefined)
        ? {
            definitionDependenciesDigest: DigestSchema.parse(definitionDependenciesDigest),
          }
        : undefined,
    )
    .addOptional(!(permissionDigest === undefined) ? { permissionDigest } : undefined)
    .addOptional(!(provider === undefined) ? { provider } : undefined)
    .addOptional(!(model === undefined) ? { model } : undefined)
    .addOptional(
      !(thinkingLevel === undefined)
        ? {
            thinkingLevel: z
              .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
              .parse(thinkingLevel),
          }
        : undefined,
    )
    .addOptional(!(contextArtifactId === undefined) ? { contextArtifactId } : undefined)
    .addOptional(
      !(contextDigest === undefined) ? { contextDigest: DigestSchema.parse(contextDigest) } : undefined,
    )
    .addOptional(
      !(contextCharacterLength === null || contextCharacterLength === undefined)
        ? { contextCharacterLength: z.number().int().nonnegative().parse(contextCharacterLength) }
        : undefined,
    )
    .addOptional(
      !(contextByteLength === null || contextByteLength === undefined)
        ? { contextByteLength: z.number().int().nonnegative().parse(contextByteLength) }
        : undefined,
    )
    .add({
      sessionId: requiredString(row, "session_id"),
    } as const)
    .addOptional(!(turnId === undefined) ? { turnId } : undefined)
    .add({
      status: WorkflowRunStatusSchema.parse(requiredString(row, "status")),
      currentPhase: requiredNumber(row, "current_phase"),
      input: JsonValueSchema.parse(parseJson(requiredString(row, "input_json"))),
    } as const)
    .addOptional(!(output === undefined) ? { output: JsonValueSchema.parse(parseJson(output)) } : undefined)
    .addOptional(!(error === undefined) ? { error } : undefined)
    .add({
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
    } as const)
    .addOptional(!(completedAt === undefined) ? { completedAt } : undefined)
    .finish();
}
export function decodeWorkflowPhaseRun(row: DatabaseRow | undefined): WorkflowPhaseRunRecord {
  const output = optionalString(row, "output_json");
  const executionId = optionalString(row, "execution_id");
  const logicalExecutionId = optionalString(row, "logical_execution_id");
  const error = optionalString(row, "error");
  const startedAt = optionalString(row, "started_at");
  const completedAt = optionalString(row, "completed_at");
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return createConditionalObject({
    runId: requiredString(row, "run_id"),
    phaseIndex: requiredNumber(row, "phase_index"),
    phaseName: requiredString(row, "phase_name"),
    status: WorkflowPhaseStatusSchema.parse(requiredString(row, "status")),
    attempt: requiredNumber(row, "attempt"),
  } as const)
    .addOptional(!(logicalExecutionId === undefined) ? { logicalExecutionId } : undefined)
    .add({
      input: JsonValueSchema.parse(parseJson(requiredString(row, "input_json"))),
    } as const)
    .addOptional(!(output === undefined) ? { output: JsonValueSchema.parse(parseJson(output)) } : undefined)
    .addOptional(!(executionId === undefined) ? { executionId } : undefined)
    .addOptional(!(error === undefined) ? { error } : undefined)
    .addOptional(!(startedAt === undefined) ? { startedAt } : undefined)
    .addOptional(!(completedAt === undefined) ? { completedAt } : undefined)
    .finish();
}
export function decodeOutcome(row: DatabaseRow | undefined): OutcomeRecord {
  const turnId = optionalString(row, "turn_id");
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return createConditionalObject({
    outcomeId: requiredString(row, "outcome_id"),
    sessionId: requiredString(row, "session_id"),
  } as const)
    .addOptional(!(turnId === undefined) ? { turnId } : undefined)
    .add({
      status: OutcomeStatusSchema.parse(requiredString(row, "status")),
      summary: requiredString(row, "summary"),
      sensitivity: SensitivitySchema.parse(requiredString(row, "sensitivity")),
      createdAt: requiredString(row, "created_at"),
      metadata: JsonRecordSchema.parse(parseJson(requiredString(row, "metadata_json"))),
    } as const)
    .finish();
}
export function decodeActivation(row: DatabaseRow | undefined): ActivationRecord {
  const preflightId = optionalString(row, "preflight_id");
  const storedCapabilityRevisions = z
    .record(z.string(), z.unknown())
    .parse(parseJson(requiredString(row, "capability_revisions_json")));
  const activeCapabilityRevisions = Object.fromEntries(
    Object.entries(storedCapabilityRevisions).map(([capabilityId, value]) => {
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      const revision =
        typeof value === "string"
          ? {
              kind: "legacy_capability_revision" as const,
              capabilityId,
              capabilityRevisionId: value,
            }
          : CapabilityRevisionRefSchema.parse(value);
      if (revision.capabilityId !== capabilityId)
        throw new Error(`Stored activation capability key ${capabilityId} is mismatched`);
      return [capabilityId, revision];
    }),
  );
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return createConditionalObject({
    activationId: requiredString(row, "activation_id"),
    revision: requiredNumber(row, "revision"),
    previousActivationId: optionalString(row, "previous_activation_id") ?? null,
    activeDefinitions: z
      .record(z.string(), FileRevisionRefSchema)
      .parse(parseJson(requiredString(row, "definitions_json"))),
    activeCapabilityRevisions,
  } as const)
    .addOptional(!(preflightId === undefined) ? { preflightId } : undefined)
    .add({
      createdAt: requiredString(row, "created_at"),
    } as const)
    .finish();
}
export function decodeActivationApproval(row: DatabaseRow | undefined): ActivationApprovalRecord {
  const decidedAt = optionalString(row, "decided_at");
  const decisionActor = optionalString(row, "decision_actor");
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze(
    createConditionalObject({
      approvalId: requiredString(row, "approval_id"),
      operationId: requiredString(row, "operation_id"),
      bindingDigest: DigestSchema.parse(requiredString(row, "binding_digest")),
      policyDigest: DigestSchema.parse(requiredString(row, "policy_digest")),
      status: z.enum(["pending", "approved", "rejected"]).parse(requiredString(row, "status")),
      requestedAt: requiredString(row, "requested_at"),
    } as const)
      .addOptional(!(decidedAt === undefined) ? { decidedAt } : undefined)
      .addOptional(!(decisionActor === undefined) ? { decisionActor } : undefined)
      .finish(),
  );
}
export function decodeActivationOperationRow(
  row: DatabaseRow | undefined,
  materializations: readonly ActivationMaterializationRecord[],
): ActivationOperationRecord {
  const operationId = requiredString(row, "operation_id");
  const approvalId = optionalString(row, "approval_id");
  const committedAt = optionalString(row, "committed_at");
  const supersededByOperationId = optionalString(row, "superseded_by_operation_id");
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze(
    createConditionalObject({
      operationId,
      idempotencyKey: requiredString(row, "idempotency_key"),
      activationId: requiredString(row, "activation_id"),
      binding: ActivationEvidenceBindingSchema.parse(parseJson(requiredString(row, "binding_json"))),
      bindingDigest: DigestSchema.parse(requiredString(row, "binding_digest")),
      policySnapshot: Object.freeze(
        ActivationPolicySnapshotSchema.parse(parseJson(requiredString(row, "policy_snapshot_json"))),
      ),
      policyDigest: DigestSchema.parse(requiredString(row, "policy_digest")),
      decision: ActivationPolicyDecisionSchema.parse(requiredString(row, "decision")),
      status: ActivationOperationStatusSchema.parse(requiredString(row, "status")),
      expectedActivationRevision: requiredNumber(row, "expected_activation_revision"),
      previousActivationId: optionalString(row, "previous_activation_id") ?? null,
    } as const)
      .addOptional(!(approvalId === undefined) ? { approvalId } : undefined)
      .addOptional(!(supersededByOperationId === undefined) ? { supersededByOperationId } : undefined)
      .add({
        materializations,
        createdAt: requiredString(row, "created_at"),
        updatedAt: requiredString(row, "updated_at"),
      } as const)
      .addOptional(!(committedAt === undefined) ? { committedAt } : undefined)
      .finish(),
  );
}
export function decodeTurnActivationPin(row: DatabaseRow | undefined): TurnActivationPinRecord {
  return Object.freeze({
    turnKey: requiredString(row, "turn_key"),
    sessionId: requiredString(row, "session_id"),
    turnId: requiredString(row, "turn_id"),
    activationId: requiredString(row, "activation_id"),
    activationRevision: requiredNumber(row, "activation_revision"),
    activeDefinitions: z
      .record(z.string(), FileRevisionRefSchema)
      .parse(parseJson(requiredString(row, "definitions_json"))),
    activeCapabilityRevisions: z
      .record(z.string(), CapabilityRevisionRefSchema)
      .parse(parseJson(requiredString(row, "capability_revisions_json"))),
    pinnedAt: requiredString(row, "pinned_at"),
  });
}
export function decodeSearchConfiguration(row: DatabaseRow | undefined): SearchConfiguration {
  return SearchConfigurationSchema.parse({
    lexicalLimit: requiredNumber(row, "lexical_limit"),
    semanticLimit: requiredNumber(row, "semantic_limit"),
    rerankLimit: requiredNumber(row, "rerank_limit"),
    maxExcerptChars: requiredNumber(row, "max_excerpt_chars"),
    includePrivate: requiredNumber(row, "include_private") === 1,
    updatedAt: requiredString(row, "updated_at"),
  });
}
export function decodeSearchDocument(row: DatabaseRow | undefined): SearchDocument {
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const source = z
    .discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("database_row"),
        table: z.enum(["sessions", "messages", "tool_calls", "outcomes", "experiments"]),
        rowId: z.string(),
        field: z.string(),
      }),
      z.strictObject({
        kind: z.literal("file_revision"),
        revisionId: z.string(),
        field: z.literal("bytes"),
      }),
    ])
    .parse(parseJson(requiredString(row, "citation_json"))) as CanonicalSearchSource;
  const sessionId = optionalString(row, "session_id");
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return createConditionalObject({
    documentId: requiredString(row, "document_id"),
    source,
  } as const)
    .addOptional(!(sessionId === undefined) ? { sessionId } : undefined)
    .add({
      sensitivity: requiredString(row, "sensitivity") as SearchDocument["sensitivity"],
      occurredAt: requiredString(row, "occurred_at"),
      body: requiredString(row, "body"),
    } as const)
    .finish();
}
export function decodeOptional<T>(
  row: DatabaseRow | undefined,
  decode: (value: DatabaseRow) => T,
): T | undefined {
  return row === undefined ? undefined : decode(row);
}
export function decodeStored<T>(row: DatabaseRow | undefined, schema: z.ZodType<T>): T | undefined {
  return row === undefined ? undefined : schema.parse(parseJson(requiredString(row, "data_json")));
}
export function decodeExperiment(row: DatabaseRow | undefined): Experiment | undefined {
  if (row === undefined) return undefined;
  const parsed = ExperimentSchema.safeParse(parseJson(requiredString(row, "data_json")));
  if (!parsed.success) throw parsed.error;
  // Zod's optional-property inference includes explicit undefined while the domain uses exact optionals.
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return parsed.data as Experiment;
}
export function decodeFeedbackSignal(row: DatabaseRow | undefined): FeedbackSignal | undefined {
  if (row === undefined) return undefined;
  const parsed = FeedbackSignalSchema.safeParse(parseJson(requiredString(row, "data_json")));
  if (!parsed.success) throw parsed.error;
  // Zod's optional-property inference includes explicit undefined while the domain uses exact optionals.
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return parsed.data as FeedbackSignal;
}
export function decodeVector(value: string): readonly number[] {
  return z.array(z.number().finite()).min(1).parse(JSON.parse(value));
}
