import {
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
  ActivationMaterializationRecord,
  ActivationOperationRecord,
  ActivationRecord,
  CanonicalSearchSource,
  CodeExecutionRecord,
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

export const JsonRecordSchema = z.record(z.string(), z.unknown());
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
const UserIntentStatusSchema = z.enum(["pending", "dispatching", "unresolved", "delivered", "withdrawn"]);
const ToolCallStatusSchema = z.enum(["requested", "running", "completed", "failed", "denied", "ambiguous"]);
const CodeExecutionStatusSchema = z.enum(["running", "completed", "failed", "cancelled", "interrupted"]);
const WorkflowRunStatusSchema = z.enum(["running", "paused", "completed", "failed", "cancelled"]);
const WorkflowPhaseStatusSchema = z.enum(["pending", "running", "completed", "failed", "cancelled"]);
const OutcomeStatusSchema = z.enum(["accepted", "corrected", "failed", "unknown"]);

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ActivationEvidenceBindingSchema = z.strictObject({
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
const ActivationPolicySnapshotSchema = z.record(z.string(), z.unknown());

export function decodeFileRevisionRef(row: unknown): FileRevisionRef {
  return FileRevisionRefSchema.parse({
    kind: "file_revision",
    revisionId: requiredString(row, "revision_id"),
    workingPath: requiredString(row, "working_path"),
    snapshotPath: requiredString(row, "snapshot_path"),
    contentDigest: requiredString(row, "content_digest"),
  });
}

export function decodeSession(row: unknown): SessionRecord {
  const parentSessionId = optionalString(row, "parent_session_id");
  return {
    sessionId: requiredString(row, "session_id"),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    title: requiredString(row, "title"),
    status: SessionStatusSchema.parse(requiredString(row, "status")),
    provider: requiredString(row, "provider"),
    model: requiredString(row, "model"),
    runtime: requiredString(row, "runtime"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
    metadata: JsonRecordSchema.parse(parseJson(requiredString(row, "metadata_json"))),
  };
}

export function decodeMessage(row: unknown): MessageRecord {
  return {
    messageId: requiredString(row, "message_id"),
    sessionId: requiredString(row, "session_id"),
    role: MessageRoleSchema.parse(requiredString(row, "role")),
    content: requiredString(row, "content"),
    sensitivity: SensitivitySchema.parse(requiredString(row, "sensitivity")),
    createdAt: requiredString(row, "created_at"),
    metadata: JsonRecordSchema.parse(parseJson(requiredString(row, "metadata_json"))),
  };
}

export function decodeUserIntent(row: unknown): UserIntentRecord {
  const text = optionalString(row, "text");
  const queuedBehindTurnId = optionalString(row, "queued_behind_turn_id");
  const targetTurnId = optionalString(row, "target_turn_id");
  const promotedAt = optionalString(row, "promoted_at");
  const deliveredAt = optionalString(row, "delivered_at");
  const unresolvedAt = optionalString(row, "unresolved_at");
  const withdrawnAt = optionalString(row, "withdrawn_at");
  return Object.freeze({
    intentId: requiredString(row, "intent_id"),
    sessionId: requiredString(row, "session_id"),
    ...(text === undefined ? {} : { text }),
    contentDigest: requiredString(row, "content_digest"),
    deliveryMode: UserIntentModeSchema.parse(requiredString(row, "delivery_mode")),
    status: UserIntentStatusSchema.parse(requiredString(row, "status")),
    queueSequence: requiredNumber(row, "queue_sequence"),
    ...(queuedBehindTurnId === undefined ? {} : { queuedBehindTurnId }),
    ...(targetTurnId === undefined ? {} : { targetTurnId }),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
    ...(promotedAt === undefined ? {} : { promotedAt }),
    ...(deliveredAt === undefined ? {} : { deliveredAt }),
    ...(unresolvedAt === undefined ? {} : { unresolvedAt }),
    ...(withdrawnAt === undefined ? {} : { withdrawnAt }),
    attemptCount: requiredNumber(row, "attempt_count"),
  });
}

export function decodeToolCall(row: unknown): ToolCallRecord {
  const turnId = optionalString(row, "turn_id");
  const response = optionalString(row, "response_json");
  const update = optionalString(row, "update_json");
  const messageId = optionalString(row, "message_id");
  const parentToolCallId = optionalString(row, "parent_tool_call_id");
  const executionId = optionalString(row, "execution_id");
  const completedAt = optionalString(row, "completed_at");
  return {
    toolCallId: requiredString(row, "tool_call_id"),
    sessionId: requiredString(row, "session_id"),
    ...(turnId === undefined ? {} : { turnId }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
    ...(executionId === undefined ? {} : { executionId }),
    toolName: requiredString(row, "tool_name"),
    request: parseJson(requiredString(row, "request_json")),
    ...(update === undefined ? {} : { update: parseJson(update) }),
    ...(response === undefined ? {} : { response: parseJson(response) }),
    sequence: requiredNumber(row, "action_sequence"),
    status: ToolCallStatusSchema.parse(requiredString(row, "status")),
    sensitivity: SensitivitySchema.parse(requiredString(row, "sensitivity")),
    createdAt: requiredString(row, "created_at"),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

export function decodeCodeExecution(row: unknown): CodeExecutionRecord {
  const parentExecutionId = optionalString(row, "parent_execution_id");
  const turnId = optionalString(row, "turn_id");
  const result = optionalString(row, "result_json");
  const error = optionalString(row, "error");
  const completedAt = optionalString(row, "completed_at");
  const sourceArtifactId = optionalString(row, "source_artifact_id");
  const stdoutArtifactId = optionalString(row, "stdout_artifact_id");
  const stderrArtifactId = optionalString(row, "stderr_artifact_id");
  return {
    executionId: requiredString(row, "execution_id"),
    logicalExecutionId: requiredString(row, "logical_execution_id"),
    ...(parentExecutionId === undefined ? {} : { parentExecutionId }),
    sessionId: requiredString(row, "session_id"),
    ...(turnId === undefined ? {} : { turnId }),
    catalogId: requiredString(row, "catalog_id"),
    catalogDigest: requiredString(row, "catalog_digest"),
    sourceDigest: requiredString(row, "source_digest"),
    ...(sourceArtifactId === undefined ? {} : { sourceArtifactId }),
    ...(stdoutArtifactId === undefined ? {} : { stdoutArtifactId }),
    ...(stderrArtifactId === undefined ? {} : { stderrArtifactId }),
    status: CodeExecutionStatusSchema.parse(requiredString(row, "status")),
    ...(result === undefined ? {} : { result: JsonValueSchema.parse(parseJson(result)) }),
    ...(error === undefined ? {} : { error }),
    callCount: requiredNumber(row, "call_count"),
    startedAt: requiredString(row, "started_at"),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

export function decodeWorkflowRun(row: unknown): WorkflowRunRecord {
  const turnId = optionalString(row, "turn_id");
  const catalogId = optionalString(row, "catalog_id");
  const catalogDigest = optionalString(row, "catalog_digest");
  const permissionDigest = optionalString(row, "permission_digest");
  const provider = optionalString(row, "provider");
  const model = optionalString(row, "model");
  const thinkingLevel = optionalString(row, "thinking_level");
  const output = optionalString(row, "output_json");
  const error = optionalString(row, "error");
  const completedAt = optionalString(row, "completed_at");
  return {
    runId: requiredString(row, "run_id"),
    workflowName: requiredString(row, "workflow_name"),
    workflowRevision: requiredNumber(row, "workflow_revision"),
    definitionRevisionId: requiredString(row, "definition_revision_id"),
    ...(catalogId === undefined ? {} : { catalogId }),
    ...(catalogDigest === undefined ? {} : { catalogDigest }),
    ...(permissionDigest === undefined ? {} : { permissionDigest }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined
      ? {}
      : {
          thinkingLevel: z
            .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
            .parse(thinkingLevel),
        }),
    sessionId: requiredString(row, "session_id"),
    ...(turnId === undefined ? {} : { turnId }),
    status: WorkflowRunStatusSchema.parse(requiredString(row, "status")),
    currentPhase: requiredNumber(row, "current_phase"),
    input: JsonValueSchema.parse(parseJson(requiredString(row, "input_json"))),
    ...(output === undefined ? {} : { output: JsonValueSchema.parse(parseJson(output)) }),
    ...(error === undefined ? {} : { error }),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

export function decodeWorkflowPhaseRun(row: unknown): WorkflowPhaseRunRecord {
  const output = optionalString(row, "output_json");
  const executionId = optionalString(row, "execution_id");
  const logicalExecutionId = optionalString(row, "logical_execution_id");
  const error = optionalString(row, "error");
  const startedAt = optionalString(row, "started_at");
  const completedAt = optionalString(row, "completed_at");
  return {
    runId: requiredString(row, "run_id"),
    phaseIndex: requiredNumber(row, "phase_index"),
    phaseName: requiredString(row, "phase_name"),
    status: WorkflowPhaseStatusSchema.parse(requiredString(row, "status")),
    attempt: requiredNumber(row, "attempt"),
    ...(logicalExecutionId === undefined ? {} : { logicalExecutionId }),
    input: JsonValueSchema.parse(parseJson(requiredString(row, "input_json"))),
    ...(output === undefined ? {} : { output: JsonValueSchema.parse(parseJson(output)) }),
    ...(executionId === undefined ? {} : { executionId }),
    ...(error === undefined ? {} : { error }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

export function decodeOutcome(row: unknown): OutcomeRecord {
  const turnId = optionalString(row, "turn_id");
  return {
    outcomeId: requiredString(row, "outcome_id"),
    sessionId: requiredString(row, "session_id"),
    ...(turnId === undefined ? {} : { turnId }),
    status: OutcomeStatusSchema.parse(requiredString(row, "status")),
    summary: requiredString(row, "summary"),
    sensitivity: SensitivitySchema.parse(requiredString(row, "sensitivity")),
    createdAt: requiredString(row, "created_at"),
    metadata: JsonRecordSchema.parse(parseJson(requiredString(row, "metadata_json"))),
  };
}

export function decodeActivation(row: unknown): ActivationRecord {
  const preflightId = optionalString(row, "preflight_id");
  const storedCapabilityRevisions = z
    .record(z.string(), z.unknown())
    .parse(parseJson(requiredString(row, "capability_revisions_json")));
  const activeCapabilityRevisions = Object.fromEntries(
    Object.entries(storedCapabilityRevisions).map(([capabilityId, value]) => {
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
  return {
    activationId: requiredString(row, "activation_id"),
    revision: requiredNumber(row, "revision"),
    previousActivationId: optionalString(row, "previous_activation_id") ?? null,
    activeDefinitions: z
      .record(z.string(), FileRevisionRefSchema)
      .parse(parseJson(requiredString(row, "definitions_json"))),
    activeCapabilityRevisions,
    ...(preflightId === undefined ? {} : { preflightId }),
    createdAt: requiredString(row, "created_at"),
  };
}

export function decodeActivationApproval(row: unknown): ActivationApprovalRecord {
  const decidedAt = optionalString(row, "decided_at");
  const decisionActor = optionalString(row, "decision_actor");
  return Object.freeze({
    approvalId: requiredString(row, "approval_id"),
    operationId: requiredString(row, "operation_id"),
    bindingDigest: DigestSchema.parse(requiredString(row, "binding_digest")),
    policyDigest: DigestSchema.parse(requiredString(row, "policy_digest")),
    status: z.enum(["pending", "approved", "rejected"]).parse(requiredString(row, "status")),
    requestedAt: requiredString(row, "requested_at"),
    ...(decidedAt === undefined ? {} : { decidedAt }),
    ...(decisionActor === undefined ? {} : { decisionActor }),
  });
}

export function decodeActivationOperationRow(
  row: unknown,
  materializations: readonly ActivationMaterializationRecord[],
): ActivationOperationRecord {
  const operationId = requiredString(row, "operation_id");
  const approvalId = optionalString(row, "approval_id");
  const committedAt = optionalString(row, "committed_at");
  const supersededByOperationId = optionalString(row, "superseded_by_operation_id");
  return Object.freeze({
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
    ...(approvalId === undefined ? {} : { approvalId }),
    ...(supersededByOperationId === undefined ? {} : { supersededByOperationId }),
    materializations,
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
    ...(committedAt === undefined ? {} : { committedAt }),
  });
}

export function decodeTurnActivationPin(row: unknown): TurnActivationPinRecord {
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

export function decodeSearchConfiguration(row: unknown): SearchConfiguration {
  return SearchConfigurationSchema.parse({
    lexicalLimit: requiredNumber(row, "lexical_limit"),
    semanticLimit: requiredNumber(row, "semantic_limit"),
    rerankLimit: requiredNumber(row, "rerank_limit"),
    maxExcerptChars: requiredNumber(row, "max_excerpt_chars"),
    includePrivate: requiredNumber(row, "include_private") === 1,
    updatedAt: requiredString(row, "updated_at"),
  });
}

export function decodeSearchDocument(row: unknown): SearchDocument {
  const source = z
    .discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("database_row"),
        table: z.enum(["sessions", "messages", "tool_calls", "outcomes"]),
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
  return {
    documentId: requiredString(row, "document_id"),
    source,
    ...(sessionId === undefined ? {} : { sessionId }),
    sensitivity: requiredString(row, "sensitivity") as SearchDocument["sensitivity"],
    occurredAt: requiredString(row, "occurred_at"),
    body: requiredString(row, "body"),
  };
}

export function decodeOptional<T>(row: unknown, decode: (value: unknown) => T): T | undefined {
  return row === undefined ? undefined : decode(row);
}

export function decodeStored<T>(row: unknown, schema: z.ZodType<T>): T | undefined {
  return row === undefined ? undefined : schema.parse(parseJson(requiredString(row, "data_json")));
}

export function decodeExperiment(row: unknown): Experiment | undefined {
  if (row === undefined) return undefined;
  const parsed = ExperimentSchema.safeParse(parseJson(requiredString(row, "data_json")));
  if (!parsed.success) throw parsed.error;
  // Zod's optional-property inference includes explicit undefined while the domain uses exact optionals.
  return parsed.data as Experiment;
}

export function decodeFeedbackSignal(row: unknown): FeedbackSignal | undefined {
  if (row === undefined) return undefined;
  const parsed = FeedbackSignalSchema.safeParse(parseJson(requiredString(row, "data_json")));
  if (!parsed.success) throw parsed.error;
  // Zod's optional-property inference includes explicit undefined while the domain uses exact optionals.
  return parsed.data as FeedbackSignal;
}

export function decodeVector(value: string): readonly number[] {
  return z.array(z.number().finite()).min(1).parse(JSON.parse(value));
}
