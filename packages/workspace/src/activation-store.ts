import { type FrozenTurnPlan, validateFrozenTurnPlan } from "@noesis/agent-types";
import {
  type ActorRef,
  type CapabilityRevisionRef,
  CapabilityRevisionRefSchema,
  canonicalJson,
  type DatabaseRowRef,
  type DatabaseTable,
  type DefinitionWriteRequest,
  type EvidenceRef,
  ExperimentSchema,
  type FileRevisionRef,
  FileRevisionRefSchema,
  sameCapabilityRevisionRef,
  sha256,
} from "@noesis/domain";
import { z } from "zod";
import {
  optionalString,
  parseJson,
  requiredNumber,
  requiredString,
  type WorkspaceDatabase,
} from "./database.ts";
import {
  decodeActivation,
  decodeActivationApproval,
  decodeActivationOperationRow,
  decodeOptional,
  decodeTurnActivationPin,
} from "./decoders.ts";
import type {
  ActivationEvidenceBinding,
  ActivationMaterializationRecord,
  ActivationOperationRecord,
  ActivationRecord,
  ProtectedActivationStore,
} from "./types.ts";
import { workingAdjustmentAdmissionConflictError } from "./types.ts";

type RecordActivity = (
  actor: ActorRef,
  activityKind: string,
  subjectKind: string,
  subjectId: string,
  references?: unknown,
) => unknown;

interface CreateProtectedActivationStoreOptions {
  readonly database: WorkspaceDatabase;
  readonly now: () => string;
  readonly beforeActivationCommitForTesting?: () => void;
  readonly duringActivationCommitForTesting?: () => void;
  readonly afterActivationCommitForTesting?: () => void;
  readonly recordActivity: RecordActivity;
  readonly assertStoredReference: (reference: EvidenceRef | DatabaseRowRef | FileRevisionRef) => void;
  readonly readVerifiedFile: (storedPath: string, expectedDigest?: string) => Promise<Uint8Array>;
  readonly persistAtomically: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly pathsForDefinition: (
    workingPath: string,
    forcedArea?: "candidate" | "active",
  ) => { readonly absolute: string; readonly stored: string };
  readonly resolveRevision: (revisionId: string) => Promise<FileRevisionRef | undefined>;
  readonly recordDefinitionBytes: (
    request: DefinitionWriteRequest,
    revisionKind: "definition" | "candidate" | "active",
    forcedArea?: "candidate" | "active",
    writeWorkingFile?: boolean,
    stageId?: string,
  ) => Promise<FileRevisionRef>;
}

const ActorSchema = z.strictObject({
  actorId: z.string().min(1),
  kind: z.enum(["user", "noesis", "external_system", "system"]),
});
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
const ActivationPolicySnapshotSchema = z.record(z.string(), z.unknown());

const databaseRef = <Table extends DatabaseTable>(table: Table, rowId: string): DatabaseRowRef<Table> => ({
  kind: "database_row",
  table,
  rowId,
});

export async function createProtectedActivationStore(
  options: CreateProtectedActivationStoreOptions,
): Promise<ProtectedActivationStore> {
  const db = options.database.connection;

  const materializationsFor = (operationId: string): readonly ActivationMaterializationRecord[] =>
    Object.freeze(
      db
        .prepare(
          `SELECT slot_key, stage_id, source_revision_json, active_revision_json, published
           FROM activation_materializations WHERE operation_id = ? ORDER BY slot_key`,
        )
        .all(operationId)
        .map((row) =>
          Object.freeze({
            slotKey: requiredString(row, "slot_key"),
            stageId: requiredString(row, "stage_id"),
            sourceRevision: FileRevisionRefSchema.parse(
              parseJson(requiredString(row, "source_revision_json")),
            ),
            activeRevision: FileRevisionRefSchema.parse(
              parseJson(requiredString(row, "active_revision_json")),
            ),
            published: requiredNumber(row, "published") === 1,
          }),
        ),
    );

  const decodeActivationOperation = (row: unknown): ActivationOperationRecord =>
    decodeActivationOperationRow(row, materializationsFor(requiredString(row, "operation_id")));

  const getActivationOperation = async (
    operationId: string,
  ): Promise<ActivationOperationRecord | undefined> =>
    decodeOptional(
      db.prepare("SELECT * FROM activation_operations WHERE operation_id = ?").get(operationId),
      decodeActivationOperation,
    );

  const currentActivation = async (): Promise<ActivationRecord | undefined> => {
    const state = db.prepare("SELECT activation_id FROM activation_state WHERE state_id = 'current'").get();
    if (state === undefined) return undefined;
    return decodeOptional(
      db
        .prepare("SELECT * FROM activations WHERE activation_id = ?")
        .get(requiredString(state, "activation_id")),
      decodeActivation,
    );
  };

  const currentActivationIdentity = (): {
    readonly revision: number;
    readonly activationId: string | null;
  } => {
    const state = db
      .prepare("SELECT activation_id, revision FROM activation_state WHERE state_id = 'current'")
      .get();
    return state === undefined
      ? Object.freeze({ revision: 0, activationId: null })
      : Object.freeze({
          revision: requiredNumber(state, "revision"),
          activationId: requiredString(state, "activation_id"),
        });
  };

  const currentCapabilityControlRevision = (capabilityId: string): string | undefined => {
    const row = db
      .prepare(
        `SELECT definition_revision_id FROM definition_current_pointers
         WHERE namespace = 'capability_control' AND definition_id = ?`,
      )
      .get(capabilityId);
    return row === undefined ? undefined : requiredString(row, "definition_revision_id");
  };

  const materializeActivationStage = async (input: {
    readonly operationId: string;
    readonly slotKey: string;
    readonly stageId: string;
    readonly sourceRevision: FileRevisionRef;
  }): Promise<ActivationMaterializationRecord> => {
    FileRevisionRefSchema.parse(input.sourceRevision);
    options.assertStoredReference(input.sourceRevision);
    const row = db.prepare("SELECT * FROM staged_definitions WHERE stage_id = ?").get(input.stageId);
    if (row === undefined) throw new Error(`Unknown activation stage ${input.stageId}`);
    if (requiredString(row, "target_area") !== "active")
      throw new Error(`Activation stage ${input.stageId} is not inert active material`);
    const bytes = await options.readVerifiedFile(
      requiredString(row, "staged_path"),
      requiredString(row, "content_digest"),
    );
    const sourceBytes = await options.readVerifiedFile(
      input.sourceRevision.snapshotPath,
      input.sourceRevision.contentDigest,
    );
    if (sha256(bytes) !== sha256(sourceBytes))
      throw new Error(`Activation stage ${input.stageId} differs from its pinned source revision`);
    const registered = optionalString(row, "registered_revision_id");
    const activeRevision = registered
      ? await options.resolveRevision(registered)
      : await options.recordDefinitionBytes(
          {
            workingPath: requiredString(row, "relative_path"),
            bytes,
            actor: ActorSchema.parse({
              actorId: requiredString(row, "actor_id"),
              kind: requiredString(row, "actor_kind"),
            }),
            reason: `AC-09 inert materialization for ${input.operationId}`,
            sensitivity: "normal",
            provenanceRefs: Object.freeze([input.sourceRevision]),
          },
          "active",
          "active",
          false,
          input.stageId,
        );
    if (!activeRevision || activeRevision.contentDigest !== input.sourceRevision.contentDigest)
      throw new Error(`Activation stage ${input.stageId} did not materialize exact immutable bytes`);
    return Object.freeze({
      slotKey: input.slotKey,
      stageId: input.stageId,
      sourceRevision: Object.freeze({ ...input.sourceRevision }),
      activeRevision: Object.freeze({ ...activeRevision }),
      published: false,
    });
  };

  const publishCommittedOperation = async (operationId: string): Promise<number> => {
    const operation = await getActivationOperation(operationId);
    if (!operation || operation.status !== "committed") return 0;
    let published = 0;
    for (const materialization of operation.materializations) {
      if (materialization.published) continue;
      const bytes = await options.readVerifiedFile(
        materialization.activeRevision.snapshotPath,
        materialization.activeRevision.contentDigest,
      );
      await options.persistAtomically(
        options.pathsForDefinition(materialization.activeRevision.workingPath).absolute,
        bytes,
      );
      options.database.transaction(() => {
        db.prepare(
          `UPDATE activation_materializations SET published = 1
           WHERE operation_id = ? AND slot_key = ?`,
        ).run(operationId, materialization.slotKey);
      });
      published += 1;
    }
    return published;
  };

  const prepareActivation = async (
    request: Parameters<ProtectedActivationStore["prepare"]>[0],
  ): Promise<ActivationOperationRecord> => {
    const binding = ActivationEvidenceBindingSchema.parse(request.binding);
    const policySnapshot = ActivationPolicySnapshotSchema.parse(request.policySnapshot);
    const decision = ActivationPolicyDecisionSchema.parse(request.decision);
    if (request.bindingDigest !== sha256(canonicalJson(binding)))
      throw new Error("Activation binding digest does not match its canonical evidence binding");
    if (request.policyDigest !== sha256(canonicalJson(policySnapshot)))
      throw new Error("Activation policy digest does not match its immutable snapshot");
    if (
      binding.candidateDigest !== binding.candidateRevision.bundleDigest ||
      binding.manifestDigest !== binding.manifestRevision.contentDigest
    )
      throw new Error("Activation evidence binding contains a mismatched candidate or manifest digest");
    const existing = await getActivationOperation(request.operationId);
    if (existing) {
      if (
        existing.idempotencyKey !== request.idempotencyKey ||
        existing.bindingDigest !== request.bindingDigest ||
        existing.policyDigest !== request.policyDigest ||
        existing.decision !== decision
      )
        throw new Error(`Activation operation ${request.operationId} was reused with different input`);
      return existing;
    }
    const current = currentActivationIdentity();
    if (
      current.revision !== request.expectedActivationRevision ||
      current.activationId !== request.previousActivationId
    )
      throw new Error("Activation snapshot changed before staging (CAS conflict)");
    const currentControlRevision = currentCapabilityControlRevision(binding.candidateRevision.capabilityId);
    if ((currentControlRevision ?? null) !== binding.controlRevisionId)
      throw new Error("Capability pin/veto controls changed before staging (CAS conflict)");
    const slots = new Set<string>();
    for (const staged of request.stagedDefinitions) {
      if (!staged.slotKey || slots.has(staged.slotKey))
        throw new Error(`Activation definition slot is missing or duplicated: ${staged.slotKey}`);
      slots.add(staged.slotKey);
    }
    if (decision === "block" && request.stagedDefinitions.length !== 0)
      throw new Error("Blocked activation decisions cannot materialize active definitions");
    if (decision === "approval_required" && request.approvalId === undefined)
      throw new Error("Approval-required activation is missing its stable approval identity");
    if (decision !== "approval_required" && request.approvalId !== undefined)
      throw new Error("Only approval-required activation may create an approval record");
    const materializations: ActivationMaterializationRecord[] = [];
    for (const staged of request.stagedDefinitions)
      materializations.push(
        await materializeActivationStage({
          operationId: request.operationId,
          slotKey: staged.slotKey,
          stageId: staged.stageId,
          sourceRevision: staged.sourceRevision,
        }),
      );
    if (decision !== "block" && materializations.length === 0)
      throw new Error("An activatable capability must materialize a complete non-empty definition set");
    if (
      decision !== "block" &&
      sha256(
        canonicalJson(
          materializations.map(({ slotKey, sourceRevision }) => ({
            slotKey,
            sourceRevision,
          })),
        ),
      ) !== binding.definitionSetDigest
    )
      throw new Error("Materialized activation slots do not match the complete bound definition set");
    const createdAt = options.now();
    const status =
      decision === "block" ? "blocked" : decision === "approval_required" ? "pending_approval" : "staged";
    options.database.transaction(() => {
      const committedControlRevision = currentCapabilityControlRevision(
        binding.candidateRevision.capabilityId,
      );
      if ((committedControlRevision ?? null) !== binding.controlRevisionId)
        throw new Error("Capability pin/veto controls changed during staging (CAS conflict)");
      options.assertStoredReference(binding.manifestRevision);
      options.assertStoredReference(databaseRef("preflight_reports", binding.preflightId));
      options.assertStoredReference(databaseRef("preflight_plans", binding.planId));
      db.prepare(
        `INSERT INTO activation_operations(
          operation_id, idempotency_key, activation_id, experiment_id,
          candidate_revision_json, manifest_revision_json, preflight_id, plan_id,
          binding_json, binding_digest, policy_snapshot_json, policy_digest,
          decision, status, expected_activation_revision, previous_activation_id,
          approval_id, created_at, updated_at, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        request.operationId,
        request.idempotencyKey,
        request.activationId,
        binding.experimentId,
        JSON.stringify(binding.candidateRevision),
        JSON.stringify(binding.manifestRevision),
        binding.preflightId,
        binding.planId,
        JSON.stringify(binding),
        request.bindingDigest,
        JSON.stringify(policySnapshot),
        request.policyDigest,
        decision,
        status,
        request.expectedActivationRevision,
        request.previousActivationId,
        request.approvalId ?? null,
        createdAt,
        createdAt,
      );
      for (const materialization of materializations)
        db.prepare(
          `INSERT INTO activation_materializations(
            operation_id, slot_key, stage_id, source_revision_json, active_revision_json, published
          ) VALUES (?, ?, ?, ?, ?, 0)`,
        ).run(
          request.operationId,
          materialization.slotKey,
          materialization.stageId,
          JSON.stringify(materialization.sourceRevision),
          JSON.stringify(materialization.activeRevision),
        );
      if (request.approvalId)
        db.prepare(
          `INSERT INTO activation_approvals(
            approval_id, operation_id, binding_digest, policy_digest, status,
            requested_at, decided_at, decision_actor
          ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL)`,
        ).run(
          request.approvalId,
          request.operationId,
          request.bindingDigest,
          request.policyDigest,
          createdAt,
        );
      options.recordActivity(
        { actorId: "protected-activation", kind: "system" },
        status === "blocked" ? "activation.blocked" : "activation.staged",
        "activation_operation",
        request.operationId,
        [
          binding.candidateRevision,
          binding.manifestRevision,
          databaseRef("preflight_reports", binding.preflightId),
        ],
      );
    });
    const prepared = await getActivationOperation(request.operationId);
    if (!prepared) throw new Error(`Activation operation ${request.operationId} was not recorded`);
    return prepared;
  };

  const decideActivationApproval = async (
    request: Parameters<ProtectedActivationStore["decideApproval"]>[0],
  ): Promise<ActivationOperationRecord> => {
    options.database.transaction(() => {
      const approvalRow = db
        .prepare("SELECT * FROM activation_approvals WHERE approval_id = ?")
        .get(request.approvalId);
      if (approvalRow === undefined) throw new Error(`Unknown activation approval ${request.approvalId}`);
      const approval = decodeActivationApproval(approvalRow);
      if (approval.operationId !== request.operationId || approval.bindingDigest !== request.bindingDigest)
        throw new Error("Activation approval request does not match its exact pending binding");
      if (approval.status !== "pending") {
        if (approval.status !== request.decision)
          throw new Error(`Activation approval ${request.approvalId} is already ${approval.status}`);
        return;
      }
      const operationRow = db
        .prepare("SELECT status, binding_digest FROM activation_operations WHERE operation_id = ?")
        .get(request.operationId);
      if (
        operationRow === undefined ||
        requiredString(operationRow, "status") !== "pending_approval" ||
        requiredString(operationRow, "binding_digest") !== request.bindingDigest
      )
        throw new Error("Pending activation operation no longer matches its approval");
      const decidedAt = options.now();
      db.prepare(
        `UPDATE activation_approvals SET status = ?, decided_at = ?, decision_actor = ?
         WHERE approval_id = ?`,
      ).run(request.decision, decidedAt, request.actorId, request.approvalId);
      db.prepare(`UPDATE activation_operations SET status = ?, updated_at = ? WHERE operation_id = ?`).run(
        request.decision,
        decidedAt,
        request.operationId,
      );
      options.recordActivity(
        { actorId: request.actorId, kind: "user" },
        `activation.approval_${request.decision}`,
        "activation_approval",
        request.approvalId,
      );
    });
    const operation = await getActivationOperation(request.operationId);
    if (!operation) throw new Error(`Activation operation ${request.operationId} disappeared`);
    return operation;
  };

  const supersedeActivationOperation = async (request: {
    readonly operationId: string;
    readonly supersededByOperationId: string;
  }): Promise<ActivationOperationRecord> => {
    if (!request.supersededByOperationId)
      throw new Error("A superseded activation operation requires its successor identity");
    options.database.transaction(() => {
      const row = db
        .prepare(
          "SELECT status, approval_id, superseded_by_operation_id FROM activation_operations WHERE operation_id = ?",
        )
        .get(request.operationId);
      if (row === undefined) throw new Error(`Unknown activation operation ${request.operationId}`);
      const status = ActivationOperationStatusSchema.parse(requiredString(row, "status"));
      const priorSuccessor = optionalString(row, "superseded_by_operation_id");
      if (priorSuccessor !== undefined) {
        if (priorSuccessor !== request.supersededByOperationId)
          throw new Error(`Activation operation ${request.operationId} has a different successor`);
        return;
      }
      if (status === "committed" || status === "blocked" || status === "rejected")
        throw new Error(`Activation operation ${request.operationId} cannot be superseded from ${status}`);
      const timestamp = options.now();
      db.prepare(
        `UPDATE activation_operations
         SET status = 'rejected', superseded_by_operation_id = ?, updated_at = ?
         WHERE operation_id = ?`,
      ).run(request.supersededByOperationId, timestamp, request.operationId);
      const approvalId = optionalString(row, "approval_id");
      if (approvalId)
        db.prepare(
          `UPDATE activation_approvals
           SET status = 'rejected', decided_at = ?, decision_actor = 'protected-activation:stale-cas'
           WHERE approval_id = ? AND status != 'rejected'`,
        ).run(timestamp, approvalId);
      options.recordActivity(
        { actorId: "protected-activation", kind: "system" },
        "activation.superseded",
        "activation_operation",
        request.operationId,
        [request.supersededByOperationId],
      );
    });
    const superseded = await getActivationOperation(request.operationId);
    if (!superseded) throw new Error(`Superseded activation operation ${request.operationId} disappeared`);
    return superseded;
  };

  const commitActivation = async (
    request: Parameters<ProtectedActivationStore["commit"]>[0],
  ): Promise<ActivationOperationRecord> => {
    const before = await getActivationOperation(request.operationId);
    if (!before) throw new Error(`Unknown activation operation ${request.operationId}`);
    if (before.bindingDigest !== request.bindingDigest)
      throw new Error("Activation commit does not match the staged evidence binding");
    if (before.status === "committed") return before;
    if (before.status !== "staged" && before.status !== "approved")
      throw new Error(`Activation operation ${request.operationId} cannot commit from ${before.status}`);
    options.beforeActivationCommitForTesting?.();
    options.database.transaction(() => {
      const row = db
        .prepare("SELECT * FROM activation_operations WHERE operation_id = ?")
        .get(request.operationId);
      if (row === undefined) throw new Error(`Unknown activation operation ${request.operationId}`);
      const status = ActivationOperationStatusSchema.parse(requiredString(row, "status"));
      if (status === "committed") return;
      if (status !== "staged" && status !== "approved")
        throw new Error(`Activation operation ${request.operationId} changed to ${status}`);
      if (requiredString(row, "binding_digest") !== request.bindingDigest)
        throw new Error("Activation binding changed before commit");
      const current = currentActivationIdentity();
      const expectedRevision = requiredNumber(row, "expected_activation_revision");
      const expectedPrevious = optionalString(row, "previous_activation_id") ?? null;
      if (current.revision !== expectedRevision || current.activationId !== expectedPrevious)
        throw new Error("Activation snapshot changed during atomic commit (CAS conflict)");
      const previous =
        current.activationId === null
          ? undefined
          : decodeActivation(
              db.prepare("SELECT * FROM activations WHERE activation_id = ?").get(current.activationId),
            );
      const previousDefinitions = previous?.activeDefinitions ?? {};
      const previousCapabilities = z
        .record(z.string(), CapabilityRevisionRefSchema)
        .parse(previous?.activeCapabilityRevisions ?? {});
      const binding = ActivationEvidenceBindingSchema.parse(parseJson(requiredString(row, "binding_json")));
      const experimentRow = db
        .prepare("SELECT status, data_json FROM experiments WHERE experiment_id = ?")
        .get(binding.experimentId);
      if (experimentRow === undefined)
        throw new Error(`Activation experiment ${binding.experimentId} is missing`);
      const activationExperiment = ExperimentSchema.parse(
        parseJson(requiredString(experimentRow, "data_json")),
      );
      if (
        activationExperiment.status !== "preflight" ||
        activationExperiment.sourceAdjustmentId !== binding.sourceAdjustmentId ||
        activationExperiment.preflightRef?.rowId !== binding.preflightId ||
        activationExperiment.candidateRevisions.length !== 1 ||
        activationExperiment.candidateRevisions[0] === undefined ||
        !sameCapabilityRevisionRef(activationExperiment.candidateRevisions[0], binding.candidateRevision)
      )
        throw new Error("Activation experiment changed before atomic commit (CAS conflict)");
      const currentControlRevision = currentCapabilityControlRevision(binding.candidateRevision.capabilityId);
      if ((currentControlRevision ?? null) !== binding.controlRevisionId)
        throw new Error("Capability pin/veto controls changed during activation (CAS conflict)");
      const materializations = materializationsFor(request.operationId);
      if (materializations.length === 0)
        throw new Error("Activation operation has no materialized definitions");
      const definitionPrefix = `${sha256(binding.candidateRevision.capabilityId)}:`;
      const activeDefinitions = Object.freeze({
        ...Object.fromEntries(
          Object.entries(previousDefinitions).filter(([key]) => !key.startsWith(definitionPrefix)),
        ),
        ...Object.fromEntries(
          materializations.map((item) => [`${definitionPrefix}${item.slotKey}`, item.activeRevision]),
        ),
      });
      const activeCapabilityRevisions = Object.freeze({
        ...previousCapabilities,
        [binding.candidateRevision.capabilityId]: binding.candidateRevision,
      });
      const committedAt = options.now();
      const activationRevision = expectedRevision + 1;
      const activationId = requiredString(row, "activation_id");
      db.prepare(
        `INSERT INTO activations(
          activation_id, revision, previous_activation_id, definitions_json,
          capability_revisions_json, preflight_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        activationId,
        activationRevision,
        expectedPrevious,
        JSON.stringify(activeDefinitions),
        JSON.stringify(activeCapabilityRevisions),
        binding.preflightId,
        committedAt,
      );
      options.duringActivationCommitForTesting?.();
      const pointerId = `activation_pointer_${sha256(binding.candidateRevision.capabilityId).slice(0, 32)}`;
      db.prepare(
        `INSERT INTO activation_pointers(
          pointer_id, capability_id, activation_id, capability_revision_id, updated_at,
          capability_revision_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(capability_id) DO UPDATE SET
          pointer_id = excluded.pointer_id, activation_id = excluded.activation_id,
          capability_revision_id = excluded.capability_revision_id,
          capability_revision_json = excluded.capability_revision_json,
          updated_at = excluded.updated_at`,
      ).run(
        pointerId,
        binding.candidateRevision.capabilityId,
        activationId,
        binding.candidateRevision.capabilityRevisionId,
        committedAt,
        JSON.stringify(binding.candidateRevision),
      );
      db.prepare(
        `INSERT INTO activation_state(state_id, activation_id, revision, updated_at)
         VALUES ('current', ?, ?, ?)
         ON CONFLICT(state_id) DO UPDATE SET
           activation_id = excluded.activation_id, revision = excluded.revision,
           updated_at = excluded.updated_at`,
      ).run(activationId, activationRevision, committedAt);
      const observingExperiment = ExperimentSchema.parse({
        ...activationExperiment,
        status: "observing",
        activatedRevision: binding.candidateRevision,
      });
      db.prepare(
        "UPDATE experiments SET status = 'observing', data_json = ?, updated_at = ? WHERE experiment_id = ?",
      ).run(JSON.stringify(observingExperiment), committedAt, binding.experimentId);
      if (binding.sourceAdjustmentId !== undefined) {
        const source = db
          .prepare("SELECT project_id FROM working_adjustments WHERE adjustment_id = ?")
          .get(binding.sourceAdjustmentId);
        if (source === undefined)
          throw new Error(`Activation source adjustment ${binding.sourceAdjustmentId} is missing`);
        db.prepare(
          `DELETE FROM active_project_adjustments
           WHERE project_id = ? AND adjustment_id = ?`,
        ).run(requiredString(source, "project_id"), binding.sourceAdjustmentId);
      }
      db.prepare(
        `UPDATE activation_operations SET status = 'committed', updated_at = ?, committed_at = ?
         WHERE operation_id = ?`,
      ).run(committedAt, committedAt, request.operationId);
      options.recordActivity(
        { actorId: "protected-activation", kind: "system" },
        "activation.committed",
        "activation",
        activationId,
        [databaseRef("preflight_reports", binding.preflightId), binding.candidateRevision],
      );
    });
    options.afterActivationCommitForTesting?.();
    await publishCommittedOperation(request.operationId);
    const committed = await getActivationOperation(request.operationId);
    if (!committed || committed.status !== "committed")
      throw new Error(`Activation operation ${request.operationId} did not commit`);
    return committed;
  };

  const getTurnActivationPin = async (sessionId: string, turnId: string) =>
    decodeOptional(
      db
        .prepare("SELECT * FROM turn_activation_pins WHERE session_id = ? AND turn_id = ?")
        .get(sessionId, turnId),
      decodeTurnActivationPin,
    );

  const pinTurnActivation = async (request: { readonly sessionId: string; readonly turnId: string }) => {
    if (!request.sessionId || !request.turnId) throw new Error("Turn activation pin requires stable IDs");
    const existing = await getTurnActivationPin(request.sessionId, request.turnId);
    if (existing) return existing;
    let current = await currentActivation();
    if (!current) {
      const createdAt = options.now();
      options.database.transaction(() => {
        const identity = currentActivationIdentity();
        if (identity.activationId !== null || identity.revision !== 0) return;
        db.prepare(
          `INSERT INTO activations(
            activation_id, revision, previous_activation_id, definitions_json,
            capability_revisions_json, preflight_id, created_at
          ) VALUES ('activation_genesis', 1, NULL, '{}', '{}', NULL, ?)`,
        ).run(createdAt);
        db.prepare(
          `INSERT INTO activation_state(state_id, activation_id, revision, updated_at)
           VALUES ('current', 'activation_genesis', 1, ?)`,
        ).run(createdAt);
        options.recordActivity(
          { actorId: "protected-activation", kind: "system" },
          "activation.genesis_initialized",
          "activation",
          "activation_genesis",
        );
      });
      current = await currentActivation();
    }
    if (!current) throw new Error("No activation snapshot exists to pin for this turn");
    const activeCapabilityRevisions = z
      .record(z.string(), CapabilityRevisionRefSchema)
      .parse(current.activeCapabilityRevisions);
    const turnKey = `turn_activation_${sha256(`${request.sessionId}:${request.turnId}`).slice(0, 32)}`;
    const pinnedAt = options.now();
    options.database.transaction(() => {
      db.prepare(
        `INSERT OR IGNORE INTO turn_activation_pins(
          turn_key, session_id, turn_id, activation_id, activation_revision,
          definitions_json, capability_revisions_json, pinned_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        turnKey,
        request.sessionId,
        request.turnId,
        current.activationId,
        current.revision,
        JSON.stringify(current.activeDefinitions),
        JSON.stringify(activeCapabilityRevisions),
        pinnedAt,
      );
      options.recordActivity(
        { actorId: "protected-activation", kind: "system" },
        "activation.turn_pinned",
        "turn_activation_pin",
        turnKey,
        [current.activationId],
      );
    });
    const pinned = await getTurnActivationPin(request.sessionId, request.turnId);
    if (!pinned) throw new Error(`Turn activation pin ${turnKey} was not recorded`);
    return pinned;
  };

  const getTurnPlan = async (sessionId: string, turnId: string): Promise<FrozenTurnPlan | undefined> => {
    const row = db
      .prepare("SELECT plan_json FROM frozen_turn_plans WHERE session_id = ? AND turn_id = ?")
      .get(sessionId, turnId);
    return row === undefined
      ? undefined
      : validateFrozenTurnPlan(parseJson(requiredString(row, "plan_json")));
  };

  const admitTurnPlan = async (input: FrozenTurnPlan): Promise<FrozenTurnPlan> => {
    const plan = validateFrozenTurnPlan(input);
    const existing = await getTurnPlan(plan.sessionId, plan.turnId);
    if (existing) {
      if (existing.planId !== plan.planId || existing.canonicalDigest !== plan.canonicalDigest)
        throw new Error(`Turn ${plan.turnId} was already admitted with a different frozen plan`);
      return existing;
    }
    for (const selection of plan.selectedCapabilities) {
      for (const material of [
        ...selection.promptModules,
        ...selection.skills,
        ...selection.tools,
        selection.router,
      ]) {
        options.assertStoredReference(material.revision);
        if (sha256(material.content) !== material.revision.contentDigest)
          throw new Error(
            `Frozen turn plan material ${material.revision.revisionId} changed before admission`,
          );
      }
    }
    const turnKey = `turn_activation_${sha256(`${plan.sessionId}:${plan.turnId}`).slice(0, 32)}`;
    options.database.transaction(() => {
      const current = currentActivationIdentity();
      if (current.activationId !== plan.activationId || current.revision !== plan.activationRevision)
        throw new Error("Activation snapshot changed before frozen turn admission (CAS conflict)");
      if (plan.project !== undefined) {
        const activeAdjustment = db
          .prepare("SELECT adjustment_id FROM active_project_adjustments WHERE project_id = ?")
          .get(plan.project.projectId);
        const activeAdjustmentId =
          activeAdjustment === undefined ? undefined : requiredString(activeAdjustment, "adjustment_id");
        if (activeAdjustmentId !== plan.workingAdjustmentId) throw workingAdjustmentAdmissionConflictError();
        if (activeAdjustmentId !== undefined) {
          const adjustment = db
            .prepare(
              `SELECT project_root FROM working_adjustments
               WHERE project_id = ? AND adjustment_id = ?`,
            )
            .get(plan.project.projectId, activeAdjustmentId);
          if (adjustment === undefined || requiredString(adjustment, "project_root") !== plan.project.root)
            throw new Error("Working adjustment project identity is inconsistent at turn admission");
        }
      }
      const activationRow = db
        .prepare("SELECT * FROM activations WHERE activation_id = ?")
        .get(plan.activationId);
      if (activationRow === undefined) throw new Error(`Activation ${plan.activationId} is missing`);
      const activation = decodeActivation(activationRow);
      for (const selection of plan.selectedCapabilities) {
        const active = activation.activeCapabilityRevisions[selection.capabilityId];
        if (
          !active ||
          active.kind !== "capability_revision" ||
          !sameCapabilityRevisionRef(active, selection.revision)
        )
          throw new Error(
            `Frozen turn plan selected inactive revision ${selection.revision.capabilityRevisionId}`,
          );
      }
      const insertedPin = db
        .prepare(
          `INSERT OR IGNORE INTO turn_activation_pins(
            turn_key, session_id, turn_id, activation_id, activation_revision,
            definitions_json, capability_revisions_json, pinned_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          turnKey,
          plan.sessionId,
          plan.turnId,
          plan.activationId,
          plan.activationRevision,
          JSON.stringify(activation.activeDefinitions),
          JSON.stringify(activation.activeCapabilityRevisions),
          plan.createdAt,
        );
      if (insertedPin.changes !== 1)
        throw new Error(`Turn ${plan.turnId} acquired an activation pin concurrently`);
      db.prepare(
        `INSERT INTO frozen_turn_plans(
          plan_id, session_id, turn_id, schema_version, activation_id,
          activation_revision, plan_json, canonical_digest, created_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      ).run(
        plan.planId,
        plan.sessionId,
        plan.turnId,
        plan.activationId,
        plan.activationRevision,
        JSON.stringify(plan),
        plan.canonicalDigest,
        plan.createdAt,
      );
      const session = db.prepare("SELECT status FROM sessions WHERE session_id = ?").get(plan.sessionId);
      if (session !== undefined) {
        const sessionStatus = requiredString(session, "status");
        if (sessionStatus !== "idle" && sessionStatus !== "running")
          throw new Error(`Session ${plan.sessionId} cannot admit a turn from status ${sessionStatus}`);
        db.prepare(
          `INSERT INTO foreground_turns(
            turn_id, session_id, plan_id, status, outcome_id, admitted_at, settled_at
          ) VALUES (?, ?, ?, 'running', NULL, ?, NULL)`,
        ).run(plan.turnId, plan.sessionId, plan.planId, plan.createdAt);
        db.prepare("UPDATE sessions SET status = 'running', updated_at = ? WHERE session_id = ?").run(
          plan.createdAt,
          plan.sessionId,
        );
      }
      options.recordActivity(
        { actorId: "runtime-turn-planner", kind: "system" },
        "turn.plan_admitted",
        "frozen_turn_plan",
        plan.planId,
        [plan.activationId],
      );
    });
    const admitted = await getTurnPlan(plan.sessionId, plan.turnId);
    if (!admitted) throw new Error(`Frozen turn plan ${plan.planId} was not recorded`);
    return admitted;
  };

  const bootstrapGenesis = async (request: {
    readonly capabilityRevision: CapabilityRevisionRef;
    readonly activeDefinitions: Readonly<Record<string, FileRevisionRef>>;
  }): Promise<ActivationRecord> => {
    const capabilityRevision = CapabilityRevisionRefSchema.parse(request.capabilityRevision);
    const activeDefinitions = z.record(z.string(), FileRevisionRefSchema).parse(request.activeDefinitions);
    for (const reference of Object.values(activeDefinitions)) options.assertStoredReference(reference);
    const current = await currentActivation();
    const alreadyActive = current?.activeCapabilityRevisions[capabilityRevision.capabilityId];
    if (
      current &&
      alreadyActive?.kind === "capability_revision" &&
      sameCapabilityRevisionRef(alreadyActive, capabilityRevision)
    )
      return current;
    const createdAt = options.now();
    const previousActivationId = current?.activationId ?? null;
    const revision = (current?.revision ?? 0) + 1;
    const activationId =
      current === undefined
        ? "activation_genesis"
        : `activation_genesis_${capabilityRevision.bundleDigest.slice(0, 24)}`;
    options.database.transaction(() => {
      const identity = currentActivationIdentity();
      if (identity.activationId !== previousActivationId || identity.revision !== (current?.revision ?? 0))
        throw new Error("Activation snapshot changed during genesis bootstrap (CAS conflict)");
      const definitions = Object.freeze({
        ...(current?.activeDefinitions ?? {}),
        ...activeDefinitions,
      });
      const revisions = Object.freeze({
        ...(current?.activeCapabilityRevisions ?? {}),
        [capabilityRevision.capabilityId]: capabilityRevision,
      });
      db.prepare(
        `INSERT INTO activations(
          activation_id, revision, previous_activation_id, definitions_json,
          capability_revisions_json, preflight_id, created_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        activationId,
        revision,
        previousActivationId,
        JSON.stringify(definitions),
        JSON.stringify(revisions),
        createdAt,
      );
      const pointerId = `activation_pointer_${sha256(capabilityRevision.capabilityId).slice(0, 32)}`;
      db.prepare(
        `INSERT INTO activation_pointers(
          pointer_id, capability_id, activation_id, capability_revision_id, updated_at,
          capability_revision_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(capability_id) DO UPDATE SET
          pointer_id = excluded.pointer_id,
          activation_id = excluded.activation_id,
          capability_revision_id = excluded.capability_revision_id,
          capability_revision_json = excluded.capability_revision_json,
          updated_at = excluded.updated_at`,
      ).run(
        pointerId,
        capabilityRevision.capabilityId,
        activationId,
        capabilityRevision.capabilityRevisionId,
        createdAt,
        JSON.stringify(capabilityRevision),
      );
      db.prepare(
        `INSERT INTO activation_state(state_id, activation_id, revision, updated_at)
         VALUES ('current', ?, ?, ?)
         ON CONFLICT(state_id) DO UPDATE SET
           activation_id = excluded.activation_id,
           revision = excluded.revision,
           updated_at = excluded.updated_at`,
      ).run(activationId, revision, createdAt);
      options.recordActivity(
        { actorId: "protected-genesis-bootstrap", kind: "system" },
        "activation.genesis_baseline_initialized",
        "activation",
        activationId,
        [capabilityRevision, ...Object.values(activeDefinitions)],
      );
    });
    const bootstrapped = await currentActivation();
    if (!bootstrapped) throw new Error("Genesis baseline activation was not recorded");
    return bootstrapped;
  };

  const recoverCommittedActivationPublications = async (): Promise<number> => {
    const rows = db
      .prepare(
        `SELECT DISTINCT operation_id FROM activation_operations
         WHERE status = 'committed' AND operation_id IN (
           SELECT operation_id FROM activation_materializations WHERE published = 0
         ) ORDER BY operation_id`,
      )
      .all();
    let recovered = 0;
    for (const row of rows) recovered += await publishCommittedOperation(requiredString(row, "operation_id"));
    return recovered;
  };

  const protectedActivations: ProtectedActivationStore = Object.freeze({
    prepare: prepareActivation,
    getOperation: getActivationOperation,
    listOperations: async (limit = 100) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
        throw new Error("Activation operation list limit must be between 1 and 1000");
      return Object.freeze(
        db
          .prepare("SELECT * FROM activation_operations ORDER BY created_at DESC, operation_id LIMIT ?")
          .all(limit)
          .map(decodeActivationOperation),
      );
    },
    getApproval: async (approvalId: string) =>
      decodeOptional(
        db.prepare("SELECT * FROM activation_approvals WHERE approval_id = ?").get(approvalId),
        decodeActivationApproval,
      ),
    supersede: supersedeActivationOperation,
    decideApproval: decideActivationApproval,
    commit: commitActivation,
    current: currentActivation,
    pinTurn: pinTurnActivation,
    getTurnPin: getTurnActivationPin,
    admitTurnPlan,
    getTurnPlan,
    bootstrapGenesis,
    recoverCommittedPublications: recoverCommittedActivationPublications,
  });
  await recoverCommittedActivationPublications();
  return protectedActivations;
}
