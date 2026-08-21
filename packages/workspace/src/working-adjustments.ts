import type { DatabaseRow } from "./database.ts";
import {
  type ActorRef,
  type DatabaseRowRef,
  type EvidenceRef,
  type WorkingAdjustment,
  WorkingAdjustmentSchema,
} from "@noesis/domain";
import { parseJson, requiredString, type WorkspaceDatabase } from "./database.ts";
import type { ProtectedWorkingAdjustmentStore } from "./types.ts";

interface CreateWorkingAdjustmentStoreOptions {
  readonly database: WorkspaceDatabase;
  readonly now: () => string;
  readonly assertStoredReference: (reference: EvidenceRef) => void;
  /** BOUNDARY: Activity references are serialized by the authoritative workspace activity writer. */
  readonly recordActivity: (
    actor: ActorRef,
    kind: string,
    subjectKind: string,
    subjectId: string,
    references?: unknown,
  ) => DatabaseRowRef<"activity_log">;
}

const actor: ActorRef = Object.freeze({ actorId: "working-adjustment", kind: "system" });

export function createProtectedWorkingAdjustmentStore(
  options: CreateWorkingAdjustmentStoreOptions,
): ProtectedWorkingAdjustmentStore {
  const db = options.database.connection;

  const decode = (row: DatabaseRow | undefined): WorkingAdjustment | undefined => {
    if (row === undefined) return undefined;
    return WorkingAdjustmentSchema.parse(parseJson(requiredString(row, "data_json")));
  };

  const get = async (adjustmentId: string): Promise<WorkingAdjustment | undefined> =>
    decode(db.prepare("SELECT data_json FROM working_adjustments WHERE adjustment_id = ?").get(adjustmentId));

  const getActive = async (projectId: string): Promise<WorkingAdjustment | undefined> =>
    decode(
      db
        .prepare(
          `SELECT adjustment.data_json
           FROM active_project_adjustments AS active
           JOIN working_adjustments AS adjustment
             ON adjustment.project_id = active.project_id
            AND adjustment.adjustment_id = active.adjustment_id
           WHERE active.project_id = ?`,
        )
        .get(projectId),
    );

  const list: NonNullable<ProtectedWorkingAdjustmentStore["list"]> = async (request) => {
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 1_000)
      throw new Error("Working adjustment list limit must be an integer between 1 and 1000");
    const rows = request.projectId
      ? db
          .prepare(
            "SELECT data_json FROM working_adjustments WHERE project_id = ? ORDER BY created_at DESC, adjustment_id LIMIT ?",
          )
          .all(request.projectId, request.limit)
      : db
          .prepare(
            "SELECT data_json FROM working_adjustments ORDER BY created_at DESC, adjustment_id LIMIT ?",
          )
          .all(request.limit);
    return Object.freeze(
      rows.map((row) => WorkingAdjustmentSchema.parse(parseJson(requiredString(row, "data_json")))),
    );
  };

  const activeId = (projectId: string): string | null => {
    const row = db
      .prepare("SELECT adjustment_id FROM active_project_adjustments WHERE project_id = ?")
      .get(projectId);
    return row === undefined ? null : requiredString(row, "adjustment_id");
  };

  const listSettledEvidence: ProtectedWorkingAdjustmentStore["listSettledEvidence"] = async (request) => {
    if (!request.projectId) throw new Error("Working adjustment evidence requires a project ID");
    if (!request.adjustmentId) throw new Error("Working adjustment evidence requires an adjustment ID");
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100)
      throw new Error("Working adjustment evidence limit must be an integer between 1 and 100");
    const adjustment = await get(request.adjustmentId);
    if (!adjustment || adjustment.scope.projectId !== request.projectId) return Object.freeze([]);
    return Object.freeze(
      db
        .prepare(
          `SELECT plan.plan_id, turn.session_id, turn.turn_id, turn.outcome_id, turn.settled_at
           FROM frozen_turn_plans AS plan
           JOIN foreground_turns AS turn ON turn.plan_id = plan.plan_id
           WHERE turn.status = 'completed'
             AND turn.outcome_id IS NOT NULL
             AND turn.settled_at IS NOT NULL
             AND json_extract(plan.plan_json, '$.project.projectId') = ?
             AND json_extract(plan.plan_json, '$.workingAdjustmentId') = ?
           ORDER BY turn.settled_at DESC, turn.turn_id DESC
           LIMIT ?`,
        )
        .all(request.projectId, request.adjustmentId, request.limit)
        .map((row) =>
          Object.freeze({
            planId: requiredString(row, "plan_id"),
            sessionId: requiredString(row, "session_id"),
            turnId: requiredString(row, "turn_id"),
            outcomeId: requiredString(row, "outcome_id"),
            settledAt: requiredString(row, "settled_at"),
          }),
        ),
    );
  };

  const apply: ProtectedWorkingAdjustmentStore["apply"] = async (request) => {
    const adjustment = WorkingAdjustmentSchema.parse(request.adjustment);
    const encoded = JSON.stringify(adjustment);
    return options.database.transaction(() => {
      const existingProject = db
        .prepare(
          `SELECT project_root FROM working_adjustments
           WHERE project_id = ? ORDER BY created_at, adjustment_id LIMIT 1`,
        )
        .get(adjustment.scope.projectId);
      if (
        existingProject !== undefined &&
        requiredString(existingProject, "project_root") !== adjustment.scope.root
      )
        throw new Error(`Project ${adjustment.scope.projectId} is already bound to another canonical root`);
      const currentId = activeId(adjustment.scope.projectId);
      const existing = db
        .prepare("SELECT data_json FROM working_adjustments WHERE adjustment_id = ?")
        .get(adjustment.adjustmentId);
      if (existing !== undefined && requiredString(existing, "data_json") !== encoded)
        throw new Error(
          `Immutable working adjustment ${adjustment.adjustmentId} already exists with different data`,
        );
      if (currentId === adjustment.adjustmentId) {
        if (existing === undefined)
          throw new Error(
            `Active working adjustment ${adjustment.adjustmentId} is missing its immutable row`,
          );
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        return Object.freeze({
          status: "applied" as const,
          adjustment,
          replacedAdjustmentId: null,
        });
      }
      if (currentId !== request.expectedActiveAdjustmentId) {
        options.recordActivity(
          actor,
          "working_adjustment.apply_stale",
          "working_adjustment",
          adjustment.adjustmentId,
          Object.freeze([currentId]),
        );
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        return Object.freeze({
          status: "stale" as const,
          adjustmentId: adjustment.adjustmentId,
          currentActiveAdjustmentId: currentId,
        });
      }
      for (const reference of adjustment.evidenceRefs) options.assertStoredReference(reference);
      if (existing === undefined)
        db.prepare(
          `INSERT INTO working_adjustments(
             adjustment_id, project_id, project_root, data_json, created_from_turn_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          adjustment.adjustmentId,
          adjustment.scope.projectId,
          adjustment.scope.root,
          encoded,
          adjustment.createdFromTurnId,
          options.now(),
        );
      db.prepare(
        `INSERT INTO active_project_adjustments(project_id, adjustment_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           adjustment_id = excluded.adjustment_id,
           updated_at = excluded.updated_at`,
      ).run(adjustment.scope.projectId, adjustment.adjustmentId, options.now());
      options.recordActivity(
        actor,
        currentId === null ? "working_adjustment.applied" : "working_adjustment.replaced",
        "working_adjustment",
        adjustment.adjustmentId,
        Object.freeze(currentId === null ? [] : [currentId]),
      );
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return Object.freeze({
        status: "applied" as const,
        adjustment,
        replacedAdjustmentId: currentId,
      });
    });
  };

  const unapply: ProtectedWorkingAdjustmentStore["unapply"] = async (request) =>
    options.database.transaction(() => {
      const target = db
        .prepare("SELECT project_id FROM working_adjustments WHERE adjustment_id = ?")
        .get(request.expectedActiveAdjustmentId);
      if (target === undefined)
        throw new Error(`Unknown working adjustment ${request.expectedActiveAdjustmentId}`);
      if (requiredString(target, "project_id") !== request.projectId)
        throw new Error(
          `Working adjustment ${request.expectedActiveAdjustmentId} belongs to another project`,
        );
      const currentId = activeId(request.projectId);
      if (currentId !== request.expectedActiveAdjustmentId) {
        options.recordActivity(
          actor,
          "working_adjustment.unapply_stale",
          "working_adjustment",
          request.expectedActiveAdjustmentId,
          Object.freeze([currentId]),
        );
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        return Object.freeze({
          status: "stale" as const,
          adjustmentId: request.expectedActiveAdjustmentId,
          currentActiveAdjustmentId: currentId,
        });
      }
      db.prepare("DELETE FROM active_project_adjustments WHERE project_id = ? AND adjustment_id = ?").run(
        request.projectId,
        request.expectedActiveAdjustmentId,
      );
      options.recordActivity(
        actor,
        "working_adjustment.unapplied",
        "working_adjustment",
        request.expectedActiveAdjustmentId,
      );
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return Object.freeze({
        status: "unapplied" as const,
        adjustmentId: request.expectedActiveAdjustmentId,
      });
    });

  return Object.freeze({ get, getActive, list, listSettledEvidence, apply, unapply });
}
