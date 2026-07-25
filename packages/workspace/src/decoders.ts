import {
  CapabilityRevisionRefSchema,
  ExperimentSchema,
  FeedbackSignalSchema,
  FileRevisionRefSchema,
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
  ActivationPointerRecord,
  ActivationRecord,
  CanonicalSearchSource,
  JobRecord,
  MessageRecord,
  OutcomeRecord,
  SearchConfiguration,
  SearchDocument,
  SessionRecord,
  ToolCallRecord,
  TurnActivationPinRecord,
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
    status: requiredString(row, "status") as SessionRecord["status"],
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
    role: requiredString(row, "role") as MessageRecord["role"],
    content: requiredString(row, "content"),
    sensitivity: requiredString(row, "sensitivity") as MessageRecord["sensitivity"],
    createdAt: requiredString(row, "created_at"),
    metadata: JsonRecordSchema.parse(parseJson(requiredString(row, "metadata_json"))),
  };
}

export function decodeToolCall(row: unknown): ToolCallRecord {
  const response = optionalString(row, "response_json");
  const messageId = optionalString(row, "message_id");
  const completedAt = optionalString(row, "completed_at");
  return {
    toolCallId: requiredString(row, "tool_call_id"),
    sessionId: requiredString(row, "session_id"),
    ...(messageId === undefined ? {} : { messageId }),
    toolName: requiredString(row, "tool_name"),
    request: parseJson(requiredString(row, "request_json")),
    ...(response === undefined ? {} : { response: parseJson(response) }),
    status: requiredString(row, "status") as ToolCallRecord["status"],
    sensitivity: requiredString(row, "sensitivity") as ToolCallRecord["sensitivity"],
    createdAt: requiredString(row, "created_at"),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

export function decodeOutcome(row: unknown): OutcomeRecord {
  const turnId = optionalString(row, "turn_id");
  return {
    outcomeId: requiredString(row, "outcome_id"),
    sessionId: requiredString(row, "session_id"),
    ...(turnId === undefined ? {} : { turnId }),
    status: requiredString(row, "status") as OutcomeRecord["status"],
    summary: requiredString(row, "summary"),
    sensitivity: requiredString(row, "sensitivity") as OutcomeRecord["sensitivity"],
    createdAt: requiredString(row, "created_at"),
    metadata: JsonRecordSchema.parse(parseJson(requiredString(row, "metadata_json"))),
  };
}

export function decodeJob(row: unknown): JobRecord {
  const leaseOwner = optionalString(row, "lease_owner");
  const leaseUntil = optionalString(row, "lease_until");
  return {
    jobId: requiredString(row, "job_id"),
    kind: requiredString(row, "kind"),
    payload: parseJson(requiredString(row, "payload_json")),
    status: requiredString(row, "status") as JobRecord["status"],
    ...(leaseOwner === undefined ? {} : { leaseOwner }),
    ...(leaseUntil === undefined ? {} : { leaseUntil }),
    attempt: requiredNumber(row, "attempt"),
    budgetRemaining: requiredNumber(row, "budget_remaining"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
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

export function decodeActivationPointer(row: unknown): ActivationPointerRecord {
  const capabilityId = requiredString(row, "capability_id");
  const encoded = optionalString(row, "capability_revision_json");
  const capabilityRevision =
    encoded === undefined
      ? {
          kind: "legacy_capability_revision" as const,
          capabilityId,
          capabilityRevisionId: requiredString(row, "capability_revision_id"),
        }
      : CapabilityRevisionRefSchema.parse(parseJson(encoded));
  if (capabilityRevision.capabilityId !== capabilityId)
    throw new Error("Stored activation pointer capability identity is mismatched");
  return {
    pointerId: requiredString(row, "pointer_id"),
    capabilityId,
    activationId: requiredString(row, "activation_id"),
    capabilityRevision,
    updatedAt: requiredString(row, "updated_at"),
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
