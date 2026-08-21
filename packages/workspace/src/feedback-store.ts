import type { DatabaseRow } from "./database.ts";
import type { DatabaseSync } from "node:sqlite";
import {
  createConditionalObject,
  type ActorRef,
  CapabilityRevisionRefSchema,
  canonicalJson,
  type DatabaseRowRef,
  type EvidenceRef,
  EvidenceRefSchema,
  ExperimentSchema,
  FeedbackSignalSchema,
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
  decodeActivationOperationRow,
  decodeOptional,
  decodeTurnActivationPin,
} from "./decoders.ts";
import type {
  ActivationMaterializationRecord,
  ActivationOperationRecord,
  ClassifyExperimentObservationsRequest,
  CommitExperimentOutcomeRequest,
  ExperimentObservationRecord,
  ExperimentObservationClassificationResult,
  ExperimentOutcomeOperationRecord,
  ExperimentResearchRunRecord,
  ProtectedFeedbackStore,
  SuccessorLineageInputRecord,
} from "./types.ts";
/** BOUNDARY: Activity references are serialized by the authoritative workspace activity writer. */
type RecordActivity = (
  actor: ActorRef,
  activityKind: string,
  subjectKind: string,
  subjectId: string,
  references?: unknown,
) => DatabaseRowRef<"activity_log">;
interface CreateProtectedFeedbackStoreOptions {
  readonly database: WorkspaceDatabase;
  readonly now: () => string;
  readonly beforeOutcomeCommitForTesting?: () => void;
  readonly duringOutcomeCommitForTesting?: () => void;
  readonly afterOutcomeCommitForTesting?: () => void;
  readonly recordActivity: RecordActivity;
  readonly assertStoredReference: (reference: EvidenceRef | DatabaseRowRef | FileRevisionRef) => void;
  readonly stageActiveRevision: (
    operationId: string,
    publicationKey: string,
    sourceRevision: FileRevisionRef,
  ) => Promise<{
    readonly workingPath: string;
    readonly stagedPath: string;
    readonly contentDigest: string;
  }>;
  readonly publishStagedActiveRevision: (publication: {
    readonly workingPath: string;
    readonly stagedPath: string;
    readonly contentDigest: string;
    readonly sourceRevision: FileRevisionRef;
  }) => Promise<void>;
  readonly deleteActiveDefinition: (workingPath: string) => Promise<void>;
  readonly normalizeActiveWorkingPath: (workingPath: string) => string;
  readonly cleanupOutcomePublicationStage: (operationId: string) => Promise<void>;
}
interface OutcomeActivationPublication {
  readonly publicationKey: string;
  readonly action: "publish" | "delete";
  readonly workingPath: string;
  readonly sourceRevision?: FileRevisionRef;
  readonly stagedPath?: string;
  readonly contentDigest?: string;
}
export async function createProtectedFeedbackStore(
  dependencies: CreateProtectedFeedbackStoreOptions,
): Promise<ProtectedFeedbackStore> {
  const database = dependencies.database;
  const db = database.connection;
  const now = dependencies.now;
  const recordActivity = dependencies.recordActivity;
  const options = dependencies;
  const assertStoredReference = (
    _database: DatabaseSync,
    reference: EvidenceRef | DatabaseRowRef | FileRevisionRef,
  ): void => dependencies.assertStoredReference(reference);
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
  const materializationsFor = (operationId: string): readonly ActivationMaterializationRecord[] =>
    Object.freeze(
      db
        .prepare(
          "SELECT slot_key, stage_id, source_revision_json, active_revision_json, published " +
            "FROM activation_materializations WHERE operation_id = ? ORDER BY slot_key",
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
  const decodeActivationOperation = (row: DatabaseRow | undefined): ActivationOperationRecord =>
    decodeActivationOperationRow(row, materializationsFor(requiredString(row, "operation_id")));
  const decodeObservation = (row: DatabaseRow | undefined): ExperimentObservationRecord => {
    const userDecision = optionalString(row, "user_decision");
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return Object.freeze(
      createConditionalObject({
        observationId: requiredString(row, "observation_id"),
        dedupeKey: requiredString(row, "dedupe_key"),
        experimentId: requiredString(row, "experiment_id"),
        signalId: requiredString(row, "signal_id"),
        outcomeId: requiredString(row, "outcome_id"),
        preflightId: requiredString(row, "preflight_id"),
        experimentActivationId: requiredString(row, "experiment_activation_id"),
        servingActivationId: requiredString(row, "serving_activation_id"),
        activationRevision: requiredNumber(row, "activation_revision"),
        sessionId: requiredString(row, "session_id"),
        turnId: requiredString(row, "turn_id"),
        capabilityRevision: CapabilityRevisionRefSchema.parse(
          parseJson(requiredString(row, "capability_revision_json")),
        ),
        metrics: z
          .strictObject({
            quality: z.number().min(0).max(1).nullable(),
            baselineQuality: z.number().min(0).max(1).nullable(),
            latencyMs: z.number().nonnegative().nullable(),
            baselineLatencyMs: z.number().nonnegative().nullable(),
            cost: z.number().nonnegative().nullable(),
            baselineCost: z.number().nonnegative().nullable(),
            failed: z.boolean(),
            protectedRailViolation: z.boolean(),
          })
          .parse(parseJson(requiredString(row, "metrics_json"))),
        evidenceRefs: z.array(EvidenceRefSchema).parse(parseJson(requiredString(row, "evidence_refs_json"))),
        precedence: z
          .enum(["none", "correction", "preference", "user_veto"])
          .parse(requiredString(row, "precedence")),
      } as const)
        .addOptional(
          !(userDecision === undefined)
            ? {
                userDecision: z.enum(["keep", "revise", "revert"]).parse(userDecision),
              }
            : undefined,
        )
        .add({
          hardRegression: requiredNumber(row, "hard_regression") === 1,
          createdAt: requiredString(row, "created_at"),
        } as const)
        .finish(),
    );
  };
  const decodeResearchRun = (row: DatabaseRow | undefined): ExperimentResearchRunRecord => {
    const proposal = optionalString(row, "proposal");
    const failureMessage = optionalString(row, "failure_message");
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return Object.freeze(
      createConditionalObject({
        runId: requiredString(row, "run_id"),
        experimentId: requiredString(row, "experiment_id"),
        strategyId: requiredString(row, "strategy_id"),
        inputDigest: requiredString(row, "input_digest"),
        status: z.enum(["running", "completed", "failed"]).parse(requiredString(row, "status")),
      } as const)
        .addOptional(
          !(proposal === undefined)
            ? {
                proposal: z.enum(["keep", "revise", "revert"]).parse(proposal),
              }
            : undefined,
        )
        .add({
          citedObservationIds: z
            .array(z.string().min(1))
            .parse(parseJson(requiredString(row, "cited_observation_ids_json"))),
          evidenceRefs: z
            .array(EvidenceRefSchema)
            .parse(parseJson(requiredString(row, "evidence_refs_json"))),
          attempt: requiredNumber(row, "attempt"),
        } as const)
        .addOptional(!(failureMessage === undefined) ? { failureMessage } : undefined)
        .add({
          retryable: requiredNumber(row, "retryable") === 1,
          createdAt: requiredString(row, "created_at"),
          updatedAt: requiredString(row, "updated_at"),
        } as const)
        .finish(),
    );
  };
  const decodeExperimentOutcome = (row: DatabaseRow | undefined): ExperimentOutcomeOperationRecord => {
    const researchRunId = optionalString(row, "research_run_id");
    const restoreSourceActivationId = optionalString(row, "restore_source_activation_id");
    const restoredActivationId = optionalString(row, "restored_activation_id");
    const successorExperimentId = optionalString(row, "successor_experiment_id");
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return Object.freeze(
      createConditionalObject({
        operationId: requiredString(row, "operation_id"),
        idempotencyKey: requiredString(row, "idempotency_key"),
        experimentId: requiredString(row, "experiment_id"),
        decision: z.enum(["keep", "revise", "revert"]).parse(requiredString(row, "decision")),
        strategyId: requiredString(row, "strategy_id"),
      } as const)
        .addOptional(!(researchRunId === undefined) ? { researchRunId } : undefined)
        .add({
          expectedActivationId: requiredString(row, "expected_activation_id"),
          expectedActivationRevision: requiredNumber(row, "expected_activation_revision"),
        } as const)
        .addOptional(!(restoreSourceActivationId === undefined) ? { restoreSourceActivationId } : undefined)
        .addOptional(!(restoredActivationId === undefined) ? { restoredActivationId } : undefined)
        .addOptional(!(successorExperimentId === undefined) ? { successorExperimentId } : undefined)
        .add({
          evidenceRefs: z
            .array(EvidenceRefSchema)
            .parse(parseJson(requiredString(row, "evidence_refs_json"))),
          operationDigest: requiredString(row, "operation_digest"),
          committedAt: requiredString(row, "committed_at"),
        } as const)
        .finish(),
    );
  };
  const pendingOutcomePublications = (operationId: string): readonly OutcomeActivationPublication[] =>
    Object.freeze(
      db
        .prepare(`SELECT publication_key, action, working_path, source_revision_json,
             staged_path, content_digest
           FROM outcome_activation_publications
           WHERE operation_id = ? AND published = 0
           ORDER BY publication_key`)
        .all(operationId)
        .map((row) => {
          const action = z.enum(["publish", "delete"]).parse(requiredString(row, "action"));
          const sourceRevision = optionalString(row, "source_revision_json");
          const stagedPath = optionalString(row, "staged_path");
          const contentDigest = optionalString(row, "content_digest");
          // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
          return Object.freeze(
            createConditionalObject({
              publicationKey: requiredString(row, "publication_key"),
              action,
              workingPath: requiredString(row, "working_path"),
            } as const)
              .addOptional(
                !(sourceRevision === undefined)
                  ? {
                      sourceRevision: FileRevisionRefSchema.parse(parseJson(sourceRevision)),
                    }
                  : undefined,
              )
              .addOptional(!(stagedPath === undefined) ? { stagedPath } : undefined)
              .addOptional(!(contentDigest === undefined) ? { contentDigest } : undefined)
              .finish(),
          );
        }),
    );
  const publishOutcomeRestoration = async (operationId: string): Promise<number> => {
    let published = 0;
    for (const publication of pendingOutcomePublications(operationId)) {
      if (publication.action === "publish") {
        if (!publication.stagedPath || !publication.contentDigest || !publication.sourceRevision)
          throw new Error(`Outcome publication ${publication.publicationKey} is incomplete`);
        if (publication.sourceRevision.contentDigest !== publication.contentDigest)
          throw new Error(`Outcome publication ${publication.publicationKey} changed its source digest`);
        await options.publishStagedActiveRevision({
          workingPath: publication.workingPath,
          stagedPath: publication.stagedPath,
          contentDigest: publication.contentDigest,
          sourceRevision: publication.sourceRevision,
        });
      } else {
        await options.deleteActiveDefinition(publication.workingPath);
      }
      database.transaction(() => {
        db.prepare(`UPDATE outcome_activation_publications SET published = 1
           WHERE operation_id = ? AND publication_key = ?`).run(operationId, publication.publicationKey);
      });
      published += 1;
    }
    if (pendingOutcomePublications(operationId).length === 0)
      await options.cleanupOutcomePublicationStage(operationId);
    return published;
  };
  const recoverCommittedOutcomePublications = async (): Promise<number> => {
    const rows = db
      .prepare(`SELECT DISTINCT operation_id FROM outcome_activation_publications
         WHERE published = 0 ORDER BY operation_id`)
      .all();
    let recovered = 0;
    for (const row of rows) recovered += await publishOutcomeRestoration(requiredString(row, "operation_id"));
    return recovered;
  };
  const decodeSuccessorInput = (row: DatabaseRow | undefined): SuccessorLineageInputRecord =>
    Object.freeze({
      inputId: requiredString(row, "input_id"),
      predecessorExperimentId: requiredString(row, "predecessor_experiment_id"),
      successorExperimentId: requiredString(row, "successor_experiment_id"),
      predecessorActivationId: requiredString(row, "predecessor_activation_id"),
      predecessorRevision: CapabilityRevisionRefSchema.parse(
        parseJson(requiredString(row, "predecessor_revision_json")),
      ),
      baselineRevision: CapabilityRevisionRefSchema.parse(
        parseJson(requiredString(row, "baseline_revision_json")),
      ),
      evidenceRefs: z.array(EvidenceRefSchema).parse(parseJson(requiredString(row, "evidence_refs_json"))),
      createdAt: requiredString(row, "created_at"),
    });
  const operationForActivation = async (
    activationId: string,
  ): Promise<ActivationOperationRecord | undefined> =>
    decodeOptional(
      db
        .prepare("SELECT * FROM activation_operations WHERE activation_id = ? AND status = 'committed'")
        .get(activationId),
      decodeActivationOperation,
    );
  const getObservation = async (observationId: string): Promise<ExperimentObservationRecord | undefined> =>
    decodeOptional(
      db.prepare("SELECT * FROM experiment_observations WHERE observation_id = ?").get(observationId),
      decodeObservation,
    );
  const listObservationsForOutcome = async (
    outcomeId: string,
  ): Promise<readonly ExperimentObservationRecord[]> =>
    Object.freeze(
      db
        .prepare(`SELECT * FROM experiment_observations
           WHERE outcome_id = ? ORDER BY created_at, observation_id`)
        .all(outcomeId)
        .map(decodeObservation),
    );
  const observationIsDecisionBound = (observationId: string): boolean => {
    const citedByRun = db
      .prepare(`SELECT 1 AS found
         FROM experiment_research_runs AS runs, json_each(runs.cited_observation_ids_json) AS cited
         WHERE cited.value = ? LIMIT 1`)
      .get(observationId);
    const citedByOutcome = db
      .prepare(`SELECT 1 AS found
         FROM experiment_outcomes AS outcomes, json_each(outcomes.evidence_refs_json) AS evidence
         WHERE json_extract(evidence.value, '$.kind') = 'database_row'
           AND json_extract(evidence.value, '$.table') = 'experiment_observations'
           AND json_extract(evidence.value, '$.rowId') = ?
         LIMIT 1`)
      .get(observationId);
    return citedByRun !== undefined || citedByOutcome !== undefined;
  };
  const observationClassificationState = async (
    request: ClassifyExperimentObservationsRequest,
  ): Promise<ExperimentObservationClassificationResult | undefined> => {
    const observations = await listObservationsForOutcome(request.outcomeId);
    const desiredPrecedence =
      request.classification === "correction"
        ? "correction"
        : request.classification === "preference"
          ? "preference"
          : "none";
    for (const observation of observations) {
      if (observation.sessionId !== request.sessionId || observation.turnId !== request.turnId)
        throw new Error(
          `Experiment observation ${observation.observationId} does not belong to the classified turn`,
        );
      if (desiredPrecedence === "none" || observation.precedence === desiredPrecedence) continue;
      if (observation.precedence === "user_veto") continue;
      if (observation.precedence !== "none")
        throw new Error(
          `Experiment observation ${observation.observationId} has conflicting semantic precedence`,
        );
    }
    if (
      desiredPrecedence === "none" ||
      observations.every(
        (observation) =>
          observation.precedence === desiredPrecedence || observation.precedence === "user_veto",
      )
    )
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return Object.freeze({ status: "unchanged" as const, observations });
    if (
      observations.some(
        (observation) =>
          observation.precedence === "none" && observationIsDecisionBound(observation.observationId),
      )
    )
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return Object.freeze({ status: "already_bound" as const, observations });
    return undefined;
  };
  const classifyObservations = async (
    request: ClassifyExperimentObservationsRequest,
  ): Promise<ExperimentObservationClassificationResult> => {
    const existing = await observationClassificationState(request);
    if (existing) return existing;
    const desiredPrecedence =
      request.classification === "correction"
        ? "correction"
        : request.classification === "preference"
          ? "preference"
          : "none";
    database.transaction(() => {
      const rows = db
        .prepare(`SELECT * FROM experiment_observations
           WHERE outcome_id = ? ORDER BY created_at, observation_id`)
        .all(request.outcomeId);
      for (const row of rows) {
        const observation = decodeObservation(row);
        if (observation.sessionId !== request.sessionId || observation.turnId !== request.turnId)
          throw new Error(
            `Experiment observation ${observation.observationId} does not belong to the classified turn`,
          );
        if (desiredPrecedence === "none" || observation.precedence === desiredPrecedence) continue;
        if (observation.precedence === "user_veto") continue;
        if (observation.precedence !== "none")
          throw new Error(
            `Experiment observation ${observation.observationId} has conflicting semantic precedence`,
          );
        if (observationIsDecisionBound(observation.observationId))
          throw new Error(`Experiment observation ${observation.observationId} became decision-bound`);
      }
      if (desiredPrecedence === "none") return;
      for (const row of rows) {
        const observation = decodeObservation(row);
        if (observation.precedence !== "none") continue;
        db.prepare(`UPDATE experiment_observations SET precedence = ?
           WHERE observation_id = ? AND precedence = 'none'`).run(
          desiredPrecedence,
          observation.observationId,
        );
        recordActivity(
          { actorId: "protected-feedback", kind: "system" },
          "experiment_observation.classified",
          "experiment_observation",
          observation.observationId,
          [{ kind: "database_row", table: "outcomes", rowId: request.outcomeId }],
        );
      }
    });
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return Object.freeze({
      status: "updated" as const,
      observations: await listObservationsForOutcome(request.outcomeId),
    });
  };
  const recordObservation = async (
    record: Omit<ExperimentObservationRecord, "createdAt">,
    maximumObservations: number,
  ): Promise<ExperimentObservationRecord | undefined> => {
    if (!Number.isInteger(maximumObservations) || maximumObservations < 1 || maximumObservations > 1000)
      throw new Error("Observation window must be an integer between 1 and 1000");
    const existingRow = db
      .prepare("SELECT * FROM experiment_observations WHERE dedupe_key = ?")
      .get(record.dedupeKey);
    if (existingRow !== undefined) {
      const existing = decodeObservation(existingRow);
      if (existing.observationId !== record.observationId || existing.experimentId !== record.experimentId)
        throw new Error("Observation dedupe identity was reused with different input");
      return existing;
    }
    let inserted = false;
    database.transaction(() => {
      const count = requiredNumber(
        db
          .prepare("SELECT count(*) AS count FROM experiment_observations WHERE experiment_id = ?")
          .get(record.experimentId),
        "count",
      );
      if (count >= maximumObservations) return;
      const experimentRow = db
        .prepare("SELECT data_json FROM experiments WHERE experiment_id = ?")
        .get(record.experimentId);
      if (experimentRow === undefined)
        throw new Error(`Observation experiment ${record.experimentId} is missing`);
      const experiment = ExperimentSchema.parse(parseJson(requiredString(experimentRow, "data_json")));
      if (
        experiment.status !== "observing" ||
        !experiment.activatedRevision ||
        !sameCapabilityRevisionRef(experiment.activatedRevision, record.capabilityRevision) ||
        experiment.preflightRef?.rowId !== record.preflightId
      )
        throw new Error("Observation is not bound to the exact open activated experiment");
      const pinRow = db
        .prepare("SELECT * FROM turn_activation_pins WHERE session_id = ? AND turn_id = ?")
        .get(record.sessionId, record.turnId);
      if (pinRow === undefined) throw new Error("Observation has no authoritative turn activation pin");
      const pin = decodeTurnActivationPin(pinRow);
      const pinnedRevision = pin.activeCapabilityRevisions[record.capabilityRevision.capabilityId];
      if (
        pin.activationId !== record.servingActivationId ||
        pin.activationRevision !== record.activationRevision ||
        !pinnedRevision ||
        !sameCapabilityRevisionRef(pinnedRevision, record.capabilityRevision)
      )
        throw new Error("Observation serving identity does not match its turn pin");
      const activationOperationRow = db
        .prepare("SELECT * FROM activation_operations WHERE activation_id = ? AND status = 'committed'")
        .get(record.experimentActivationId);
      if (activationOperationRow === undefined)
        throw new Error("Observation references an uncommitted experiment activation");
      const activationOperation = decodeActivationOperation(activationOperationRow);
      if (
        activationOperation.binding.experimentId !== record.experimentId ||
        activationOperation.binding.preflightId !== record.preflightId ||
        !sameCapabilityRevisionRef(activationOperation.binding.candidateRevision, record.capabilityRevision)
      )
        throw new Error("Observation activation lineage does not match its experiment");
      const signalRow = db
        .prepare("SELECT data_json FROM feedback_signals WHERE signal_id = ?")
        .get(record.signalId);
      const signal = signalRow
        ? FeedbackSignalSchema.parse(parseJson(requiredString(signalRow, "data_json")))
        : undefined;
      if (
        !signal ||
        signal.experimentId !== record.experimentId ||
        signal.capabilityRevisionId !== record.capabilityRevision.capabilityRevisionId
      )
        throw new Error("Observation feedback signal is not exactly attributed");
      const outcomeRow = db
        .prepare("SELECT session_id, turn_id FROM outcomes WHERE outcome_id = ?")
        .get(record.outcomeId);
      if (
        outcomeRow === undefined ||
        requiredString(outcomeRow, "session_id") !== record.sessionId ||
        optionalString(outcomeRow, "turn_id") !== record.turnId
      )
        throw new Error("Observation outcome does not match its session and turn");
      for (const ref of record.evidenceRefs) assertStoredReference(db, ref);
      db.prepare(`INSERT INTO experiment_observations(
          observation_id, dedupe_key, experiment_id, signal_id, outcome_id, preflight_id,
          experiment_activation_id, serving_activation_id, activation_revision, session_id,
          turn_id, capability_id, capability_revision_json, metrics_json, evidence_refs_json,
          precedence, user_decision, hard_regression, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        record.observationId,
        record.dedupeKey,
        record.experimentId,
        record.signalId,
        record.outcomeId,
        record.preflightId,
        record.experimentActivationId,
        record.servingActivationId,
        record.activationRevision,
        record.sessionId,
        record.turnId,
        record.capabilityRevision.capabilityId,
        JSON.stringify(record.capabilityRevision),
        JSON.stringify(record.metrics),
        JSON.stringify(record.evidenceRefs),
        record.precedence,
        record.userDecision ?? null,
        record.hardRegression ? 1 : 0,
        now(),
      );
      const feedbackSignalIds = experiment.feedbackSignalIds.includes(record.signalId)
        ? experiment.feedbackSignalIds
        : Object.freeze([...experiment.feedbackSignalIds, record.signalId]);
      db.prepare("UPDATE experiments SET data_json = ?, updated_at = ? WHERE experiment_id = ?").run(
        JSON.stringify({ ...experiment, feedbackSignalIds }),
        now(),
        experiment.experimentId,
      );
      recordActivity(
        { actorId: "protected-feedback", kind: "system" },
        "experiment.observed",
        "experiment_observation",
        record.observationId,
        record.evidenceRefs,
      );
      inserted = true;
    });
    return inserted ? await getObservation(record.observationId) : undefined;
  };
  const getResearchRun = async (runId: string): Promise<ExperimentResearchRunRecord | undefined> =>
    decodeOptional(
      db.prepare("SELECT * FROM experiment_research_runs WHERE run_id = ?").get(runId),
      decodeResearchRun,
    );
  const putResearchRun = async (
    record: Omit<ExperimentResearchRunRecord, "createdAt" | "updatedAt">,
  ): Promise<ExperimentResearchRunRecord> => {
    for (const ref of record.evidenceRefs) assertStoredReference(db, ref);
    const timestamp = now();
    database.transaction(() => {
      const existing = db
        .prepare(`SELECT experiment_id, strategy_id, input_digest, created_at
           FROM experiment_research_runs WHERE run_id = ?`)
        .get(record.runId);
      if (
        existing !== undefined &&
        (requiredString(existing, "experiment_id") !== record.experimentId ||
          requiredString(existing, "strategy_id") !== record.strategyId ||
          requiredString(existing, "input_digest") !== record.inputDigest)
      )
        throw new Error(`Research run identity ${record.runId} was reused with different input`);
      if (existing === undefined)
        db.prepare(`INSERT INTO experiment_research_runs(
            run_id, experiment_id, strategy_id, input_digest, status, proposal,
            cited_observation_ids_json, evidence_refs_json, attempt, failure_message,
            retryable, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          record.runId,
          record.experimentId,
          record.strategyId,
          record.inputDigest,
          record.status,
          record.proposal ?? null,
          JSON.stringify(record.citedObservationIds),
          JSON.stringify(record.evidenceRefs),
          record.attempt,
          record.failureMessage ?? null,
          record.retryable ? 1 : 0,
          timestamp,
          timestamp,
        );
      else
        db.prepare(`UPDATE experiment_research_runs SET status = ?, proposal = ?,
            cited_observation_ids_json = ?, evidence_refs_json = ?, attempt = ?,
            failure_message = ?, retryable = ?, updated_at = ? WHERE run_id = ?`).run(
          record.status,
          record.proposal ?? null,
          JSON.stringify(record.citedObservationIds),
          JSON.stringify(record.evidenceRefs),
          record.attempt,
          record.failureMessage ?? null,
          record.retryable ? 1 : 0,
          timestamp,
          record.runId,
        );
      recordActivity(
        { actorId: "feedback-judge", kind: "system" },
        `experiment.research_${record.status}`,
        "experiment_research_run",
        record.runId,
        record.evidenceRefs,
      );
    });
    const stored = await getResearchRun(record.runId);
    if (!stored) throw new Error(`Research run ${record.runId} was not recorded`);
    return stored;
  };
  const getExperimentOutcome = async (
    experimentId: string,
  ): Promise<ExperimentOutcomeOperationRecord | undefined> =>
    decodeOptional(
      db.prepare("SELECT * FROM experiment_outcomes WHERE experiment_id = ?").get(experimentId),
      decodeExperimentOutcome,
    );
  const permissionSubset = (
    restored: CommitExperimentOutcomeRequest["restore"] extends infer Value
      ? Value extends {
          readonly restoredPermissionManifest: infer Manifest;
        }
        ? Manifest
        : never
      : never,
    current: CommitExperimentOutcomeRequest["restore"] extends infer Value
      ? Value extends {
          readonly currentPermissionManifest: infer Manifest;
        }
        ? Manifest
        : never
      : never,
  ): boolean => {
    const contains = (haystack: readonly string[], needles: readonly string[]) =>
      needles.every((value) => haystack.includes(value));
    return (
      contains(current.effects, restored.effects) &&
      contains(current.resourcePatterns, restored.resourcePatterns) &&
      contains(current.credentialRefs, restored.credentialRefs)
    );
  };
  const stageRevertPublications = async (
    request: CommitExperimentOutcomeRequest,
  ): Promise<readonly OutcomeActivationPublication[]> => {
    if (request.decision !== "revert") return Object.freeze([]);
    if (!request.restore) throw new Error("Revert requires one exact prior snapshot");
    const current = decodeOptional(
      db.prepare("SELECT * FROM activations WHERE activation_id = ?").get(request.expectedActivationId),
      decodeActivation,
    );
    const source = decodeOptional(
      db.prepare("SELECT * FROM activations WHERE activation_id = ?").get(request.restore.sourceActivationId),
      decodeActivation,
    );
    const experimentRow = db
      .prepare("SELECT data_json FROM experiments WHERE experiment_id = ?")
      .get(request.experimentId);
    if (!current || !source || experimentRow === undefined)
      throw new Error("Revert publication cannot resolve its exact activation snapshots");
    const experiment = ExperimentSchema.parse(parseJson(requiredString(experimentRow, "data_json")));
    if (experiment.status !== "observing" || !experiment.activatedRevision)
      throw new Error(`Experiment ${request.experimentId} is not observing`);
    const definitionPrefix = `${sha256(experiment.activatedRevision.capabilityId)}:`;
    const currentDefinitions = Object.entries(current.activeDefinitions).filter(([slotKey]) =>
      slotKey.startsWith(definitionPrefix),
    );
    const sourceDefinitions = Object.entries(source.activeDefinitions).filter(([slotKey]) =>
      slotKey.startsWith(definitionPrefix),
    );
    const publications: OutcomeActivationPublication[] = [];
    const retainedPaths = new Map<string, FileRevisionRef>();
    const restoredPaths = new Set<string>();
    try {
      for (const [slotKey, reference] of Object.entries(current.activeDefinitions)) {
        if (slotKey.startsWith(definitionPrefix)) continue;
        retainedPaths.set(options.normalizeActiveWorkingPath(reference.workingPath), reference);
      }
      for (const [slotKey, sourceRevision] of sourceDefinitions) {
        dependencies.assertStoredReference(sourceRevision);
        const restoredPath = options.normalizeActiveWorkingPath(sourceRevision.workingPath);
        const retained = retainedPaths.get(restoredPath);
        if (retained && retained.contentDigest !== sourceRevision.contentDigest)
          throw new Error(`Revert contains conflicting active definition path ${restoredPath}`);
        retainedPaths.set(restoredPath, sourceRevision);
        if (restoredPaths.has(restoredPath)) continue;
        restoredPaths.add(restoredPath);
        const publicationKey = `publish:${slotKey}`;
        const staged = await options.stageActiveRevision(request.operationId, publicationKey, sourceRevision);
        if (staged.workingPath !== restoredPath)
          throw new Error(`Revert staged a mismatched active definition path ${staged.workingPath}`);
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        publications.push(
          Object.freeze({
            publicationKey,
            action: "publish" as const,
            workingPath: staged.workingPath,
            sourceRevision,
            stagedPath: staged.stagedPath,
            contentDigest: staged.contentDigest,
          }),
        );
      }
      const deletedPaths = new Set<string>();
      for (const [, currentRevision] of currentDefinitions) {
        const workingPath = options.normalizeActiveWorkingPath(currentRevision.workingPath);
        if (retainedPaths.has(workingPath) || deletedPaths.has(workingPath)) continue;
        deletedPaths.add(workingPath);
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        publications.push(
          Object.freeze({
            publicationKey: `delete:${sha256(workingPath)}`,
            action: "delete" as const,
            workingPath,
          }),
        );
      }
      return Object.freeze(publications);
    } catch (error) {
      const committedAfterFailure = await getExperimentOutcome(request.experimentId);
      if (!committedAfterFailure || committedAfterFailure.operationId !== request.operationId)
        await options.cleanupOutcomePublicationStage(request.operationId);
      throw error;
    }
  };
  const commitExperimentOutcome = async (
    request: CommitExperimentOutcomeRequest,
  ): Promise<ExperimentOutcomeOperationRecord> => {
    const digestInput = {
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      experimentId: request.experimentId,
      decision: request.decision,
      strategyId: request.strategyId,
      researchRunId: request.researchRunId ?? null,
      expectedActivationId: request.expectedActivationId,
      expectedActivationRevision: request.expectedActivationRevision,
      evidenceRefs: request.evidenceRefs,
      restore: request.restore ?? null,
      successor: request.successor ?? null,
    };
    if (request.operationDigest !== sha256(canonicalJson(digestInput)))
      throw new Error("Experiment outcome digest does not match its canonical protected request");
    const existing = await getExperimentOutcome(request.experimentId);
    if (existing) {
      if (
        existing.operationId !== request.operationId ||
        existing.idempotencyKey !== request.idempotencyKey ||
        existing.operationDigest !== request.operationDigest
      )
        throw new Error(`Experiment ${request.experimentId} already has a different outcome operation`);
      return existing;
    }
    options.beforeOutcomeCommitForTesting?.();
    const revertPublications = await stageRevertPublications(request);
    try {
      database.transaction(() => {
        const currentIdentity = currentActivationIdentity();
        if (
          currentIdentity.activationId !== request.expectedActivationId ||
          currentIdentity.revision !== request.expectedActivationRevision
        )
          throw new Error("Experiment outcome activation snapshot changed (CAS conflict)");
        const currentActivationRow = db
          .prepare("SELECT * FROM activations WHERE activation_id = ?")
          .get(request.expectedActivationId);
        const currentActivation = decodeActivation(currentActivationRow);
        if (!currentActivation) throw new Error("Expected current activation snapshot is missing");
        const experimentRow = db
          .prepare("SELECT data_json FROM experiments WHERE experiment_id = ?")
          .get(request.experimentId);
        if (experimentRow === undefined) throw new Error(`Experiment ${request.experimentId} is missing`);
        const experiment = ExperimentSchema.parse(parseJson(requiredString(experimentRow, "data_json")));
        if (experiment.status !== "observing" || !experiment.activatedRevision)
          throw new Error(`Experiment ${request.experimentId} is not observing`);
        const currentServingRevision = z
          .record(z.string(), CapabilityRevisionRefSchema)
          .parse(currentActivation.activeCapabilityRevisions)[experiment.activatedRevision.capabilityId];
        if (
          !currentServingRevision ||
          !sameCapabilityRevisionRef(currentServingRevision, experiment.activatedRevision)
        )
          throw new Error("Experiment outcome no longer targets the active capability revision");
        for (const ref of request.evidenceRefs) assertStoredReference(db, ref);
        if (request.researchRunId) {
          const run = db
            .prepare("SELECT status, proposal FROM experiment_research_runs WHERE run_id = ?")
            .get(request.researchRunId);
          if (
            run === undefined ||
            requiredString(run, "status") !== "completed" ||
            requiredString(run, "proposal") !== request.decision
          )
            throw new Error("Experiment outcome is not bound to its completed research proposal");
        }
        const committedAt = now();
        let restoredActivationId: string | undefined;
        let successorExperimentId: string | undefined;
        if (request.decision === "revert") {
          if (!request.restore || request.successor)
            throw new Error("Revert requires one exact prior snapshot and no successor input");
          if (
            !permissionSubset(
              request.restore.restoredPermissionManifest,
              request.restore.currentPermissionManifest,
            )
          )
            throw new Error("Restoration would widen the current permission manifest");
          const originOperationRow = db
            .prepare("SELECT * FROM activation_operations WHERE experiment_id = ? AND status = 'committed'")
            .get(request.experimentId);
          if (originOperationRow === undefined)
            throw new Error("Revert cannot restore an experiment without a committed activation");
          const originOperation = decodeActivationOperation(originOperationRow);
          if (originOperation.previousActivationId !== request.restore.sourceActivationId)
            throw new Error("Revert target is not the prior snapshot recorded by AC-09");
          const source = decodeActivation(
            db
              .prepare("SELECT * FROM activations WHERE activation_id = ?")
              .get(request.restore.sourceActivationId),
          );
          if (!source) throw new Error("Recorded prior activation snapshot is missing");
          const sourceCapabilities = z
            .record(z.string(), CapabilityRevisionRefSchema)
            .parse(source.activeCapabilityRevisions);
          const targetCapabilityId = experiment.activatedRevision.capabilityId;
          const restoredRevision = sourceCapabilities[targetCapabilityId];
          const restoresExistingSlot = experiment.baselineRevision.capabilityId === targetCapabilityId;
          if (
            restoresExistingSlot &&
            (!restoredRevision || !sameCapabilityRevisionRef(restoredRevision, experiment.baselineRevision))
          )
            throw new Error("Recorded prior snapshot does not restore the experiment baseline revision");
          if (!restoresExistingSlot && restoredRevision)
            throw new Error("A new capability slot cannot replace a capability in the prior snapshot");
          const definitionPrefix = `${sha256(targetCapabilityId)}:`;
          const restoredDefinitions = Object.freeze({
            ...Object.fromEntries(
              Object.entries(currentActivation.activeDefinitions).filter(
                ([slotKey]) => !slotKey.startsWith(definitionPrefix),
              ),
            ),
            ...Object.fromEntries(
              Object.entries(source.activeDefinitions).filter(([slotKey]) =>
                slotKey.startsWith(definitionPrefix),
              ),
            ),
          });
          const currentCapabilities = z
            .record(z.string(), CapabilityRevisionRefSchema)
            .parse(currentActivation.activeCapabilityRevisions);
          const restoredCapabilities = restoresExistingSlot
            ? Object.freeze({
                ...currentCapabilities,
                [targetCapabilityId]: restoredRevision,
              })
            : Object.freeze(
                Object.fromEntries(
                  Object.entries(currentCapabilities).filter(
                    ([capabilityId]) => capabilityId !== targetCapabilityId,
                  ),
                ),
              );
          restoredActivationId = `restoration_${sha256(request.operationId).slice(0, 32)}`;
          db.prepare(`INSERT INTO activations(
            activation_id, revision, previous_activation_id, definitions_json,
            capability_revisions_json, preflight_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
            restoredActivationId,
            request.expectedActivationRevision + 1,
            request.expectedActivationId,
            JSON.stringify(restoredDefinitions),
            JSON.stringify(restoredCapabilities),
            currentActivation.preflightId ?? null,
            committedAt,
          );
          if (restoredRevision)
            db.prepare(`INSERT INTO activation_pointers(
              pointer_id, capability_id, activation_id, capability_revision_id, updated_at,
              capability_revision_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(capability_id) DO UPDATE SET
              pointer_id = excluded.pointer_id, activation_id = excluded.activation_id,
              capability_revision_id = excluded.capability_revision_id,
              capability_revision_json = excluded.capability_revision_json,
              updated_at = excluded.updated_at`).run(
              `activation_pointer_${sha256(targetCapabilityId).slice(0, 32)}`,
              targetCapabilityId,
              restoredActivationId,
              restoredRevision.capabilityRevisionId,
              committedAt,
              JSON.stringify(restoredRevision),
            );
          else db.prepare("DELETE FROM activation_pointers WHERE capability_id = ?").run(targetCapabilityId);
          db.prepare(`UPDATE activation_state SET activation_id = ?, revision = ?, updated_at = ?
           WHERE state_id = 'current'`).run(
            restoredActivationId,
            request.expectedActivationRevision + 1,
            committedAt,
          );
        } else if (request.decision === "revise") {
          if (!request.successor || request.restore)
            throw new Error("Revise requires one successor lineage input and no restoration");
          const successor = ExperimentSchema.parse(request.successor.experiment);
          const lineage = request.successor.lineage;
          if (
            successor.status !== "hypothesis" ||
            successor.candidateRevisions.length !== 0 ||
            !sameCapabilityRevisionRef(successor.baselineRevision, experiment.activatedRevision) ||
            lineage.predecessorExperimentId !== experiment.experimentId ||
            lineage.successorExperimentId !== successor.experimentId ||
            lineage.predecessorActivationId !== request.expectedActivationId ||
            !sameCapabilityRevisionRef(lineage.predecessorRevision, experiment.activatedRevision) ||
            !sameCapabilityRevisionRef(lineage.baselineRevision, experiment.baselineRevision)
          )
            throw new Error("Successor lineage input is not bound to the exact predecessor experiment");
          for (const ref of lineage.evidenceRefs) assertStoredReference(db, ref);
          db.prepare("INSERT INTO experiments VALUES (?, 'hypothesis', ?, ?, ?)").run(
            successor.experimentId,
            JSON.stringify(successor),
            committedAt,
            committedAt,
          );
          db.prepare(`INSERT INTO successor_lineage_inputs(
            input_id, predecessor_experiment_id, successor_experiment_id,
            predecessor_activation_id, predecessor_revision_json, baseline_revision_json,
            evidence_refs_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
            lineage.inputId,
            lineage.predecessorExperimentId,
            lineage.successorExperimentId,
            lineage.predecessorActivationId,
            JSON.stringify(lineage.predecessorRevision),
            JSON.stringify(lineage.baselineRevision),
            JSON.stringify(lineage.evidenceRefs),
            committedAt,
          );
          successorExperimentId = successor.experimentId;
        } else if (request.restore || request.successor) {
          throw new Error("Keep cannot restore activation state or create a successor");
        }
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        const completed = ExperimentSchema.parse(
          createConditionalObject({
            ...experiment,
            status: "completed",
            outcome: request.decision,
          } as const)
            .addOptional(successorExperimentId ? { followUpExperimentId: successorExperimentId } : undefined)
            .finish(),
        );
        db.prepare(
          "UPDATE experiments SET status = 'completed', data_json = ?, updated_at = ? WHERE experiment_id = ?",
        ).run(JSON.stringify(completed), committedAt, experiment.experimentId);
        options.duringOutcomeCommitForTesting?.();
        db.prepare(`INSERT INTO experiment_outcomes(
          operation_id, idempotency_key, experiment_id, decision, strategy_id,
          research_run_id, expected_activation_id, expected_activation_revision,
          restore_source_activation_id, restored_activation_id, successor_experiment_id,
          evidence_refs_json, operation_digest, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          request.operationId,
          request.idempotencyKey,
          request.experimentId,
          request.decision,
          request.strategyId,
          request.researchRunId ?? null,
          request.expectedActivationId,
          request.expectedActivationRevision,
          request.restore?.sourceActivationId ?? null,
          restoredActivationId ?? null,
          successorExperimentId ?? null,
          JSON.stringify(request.evidenceRefs),
          request.operationDigest,
          committedAt,
        );
        recordActivity(
          { actorId: "protected-feedback", kind: "system" },
          `experiment.${request.decision}`,
          "experiment_outcome",
          request.operationId,
          request.evidenceRefs,
        );
        for (const publication of revertPublications)
          db.prepare(`INSERT INTO outcome_activation_publications(
              operation_id, publication_key, action, working_path, source_revision_json,
              staged_path, content_digest, published
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`).run(
            request.operationId,
            publication.publicationKey,
            publication.action,
            publication.workingPath,
            publication.sourceRevision === undefined ? null : JSON.stringify(publication.sourceRevision),
            publication.stagedPath ?? null,
            publication.contentDigest ?? null,
          );
      });
    } catch (error) {
      await options.cleanupOutcomePublicationStage(request.operationId);
      throw error;
    }
    options.afterOutcomeCommitForTesting?.();
    await publishOutcomeRestoration(request.operationId);
    const committed = await getExperimentOutcome(request.experimentId);
    if (!committed) throw new Error(`Experiment outcome ${request.operationId} did not commit`);
    return committed;
  };
  const protectedFeedback = Object.freeze({
    operationForActivation,
    recordObservation,
    classifyObservations,
    getObservationClassification: observationClassificationState,
    getObservation,
    listObservationsForOutcome,
    listObservations: async (experimentId: string, limit: number) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new Error("Observation query limit must be an integer between 1 and 1000");
      return Object.freeze(
        db
          .prepare(`SELECT * FROM experiment_observations WHERE experiment_id = ?
             ORDER BY created_at DESC, observation_id DESC LIMIT ?`)
          .all(experimentId, limit)
          .map(decodeObservation)
          .reverse(),
      );
    },
    putResearchRun,
    getResearchRun,
    listResearchRuns: async (experimentId: string) =>
      Object.freeze(
        db
          .prepare(`SELECT * FROM experiment_research_runs WHERE experiment_id = ?
             ORDER BY created_at, run_id`)
          .all(experimentId)
          .map(decodeResearchRun),
      ),
    getOutcome: getExperimentOutcome,
    commitOutcome: commitExperimentOutcome,
    getSuccessorInput: async (predecessorExperimentId: string) =>
      decodeOptional(
        db
          .prepare("SELECT * FROM successor_lineage_inputs WHERE predecessor_experiment_id = ?")
          .get(predecessorExperimentId),
        decodeSuccessorInput,
      ),
  });
  await recoverCommittedOutcomePublications();
  return protectedFeedback;
}
