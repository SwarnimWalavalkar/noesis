import { type FrozenTurnPlan, validateFrozenTurnPlan } from "@noesis/agent-types";
import {
  type ActorRef,
  CapabilityRevisionRefSchema,
  type DatabaseRowRef,
  type EvidenceRef,
  type FileRevisionRef,
  isJsonObject,
  sameCapabilityRevisionRef,
  sha256,
} from "@noesis/domain";
import { parseJson, requiredString, type WorkspaceDatabase } from "./database.ts";
import type { ProtectedTurnPlanStore } from "./types.ts";
import { capabilityBindingAdmissionConflictError } from "./types.ts";

/** BOUNDARY: Activity references are serialized by the authoritative workspace activity writer. */
type RecordActivity = (
  actor: ActorRef,
  activityKind: string,
  subjectKind: string,
  subjectId: string,
  references?: unknown,
) => DatabaseRowRef<"activity_log">;

interface CreateProtectedTurnPlanStoreOptions {
  readonly database: WorkspaceDatabase;
  readonly recordActivity: RecordActivity;
  readonly assertStoredReference: (reference: EvidenceRef | DatabaseRowRef | FileRevisionRef) => void;
}

/**
 * Admits frozen foreground turn plans. Admission verifies every frozen material against its
 * immutable revision and every selected Capability against its current binding, then records the
 * plan, the running foreground turn, and the session transition in one SQLite transaction.
 */
export function createProtectedTurnPlanStore(
  options: CreateProtectedTurnPlanStoreOptions,
): ProtectedTurnPlanStore {
  const db = options.database.connection;

  const get = async (sessionId: string, turnId: string): Promise<FrozenTurnPlan | undefined> => {
    const row = db
      .prepare("SELECT plan_json FROM frozen_turn_plans WHERE session_id = ? AND turn_id = ?")
      .get(sessionId, turnId);
    return row === undefined
      ? undefined
      : validateFrozenTurnPlan(parseJson(requiredString(row, "plan_json")));
  };

  const bindingAdmits = (plan: FrozenTurnPlan, selection: FrozenTurnPlan["selectedCapabilities"][number]) => {
    const bindingRow = db
      .prepare("SELECT revision_json, scope_json, state FROM capability_bindings WHERE capability_id = ?")
      .get(selection.capabilityId);
    if (bindingRow === undefined || requiredString(bindingRow, "state") !== "active") return false;
    const reference = CapabilityRevisionRefSchema.parse(
      parseJson(requiredString(bindingRow, "revision_json")),
    );
    if (!sameCapabilityRevisionRef(reference, selection.revision)) return false;
    const scope = parseJson(requiredString(bindingRow, "scope_json"));
    if (!isJsonObject(scope)) return false;
    const kind = scope["kind"];
    if (kind === "global") return true;
    if (kind === "session") return scope["sessionId"] === plan.sessionId;
    if (kind !== "project" || plan.project === undefined) return false;
    const project = scope["project"];
    return (
      isJsonObject(project) &&
      project["projectId"] === plan.project.projectId &&
      project["root"] === plan.project.root
    );
  };

  const admit = async (input: FrozenTurnPlan): Promise<FrozenTurnPlan> => {
    const plan = validateFrozenTurnPlan(input);
    const existing = await get(plan.sessionId, plan.turnId);
    if (existing) {
      if (existing.planId !== plan.planId || existing.canonicalDigest !== plan.canonicalDigest)
        throw new Error(`Turn ${plan.turnId} was already admitted with a different frozen plan`);
      return existing;
    }
    for (const selection of plan.selectedCapabilities) {
      for (const material of selection.effects.map((effect) =>
        effect.kind === "instruction" ? effect.material : effect.definition,
      )) {
        options.assertStoredReference(material.revision);
        if (sha256(material.content) !== material.revision.contentDigest)
          throw new Error(
            `Frozen turn plan material ${material.revision.revisionId} changed before admission`,
          );
      }
    }
    options.database.transaction(() => {
      for (const selection of plan.selectedCapabilities)
        if (!bindingAdmits(plan, selection)) throw capabilityBindingAdmissionConflictError();
      db.prepare(
        `INSERT INTO frozen_turn_plans(
          plan_id, session_id, turn_id, schema_version, plan_json, canonical_digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        plan.planId,
        plan.sessionId,
        plan.turnId,
        plan.schemaVersion,
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
        plan.selectedCapabilities.map((selection) => selection.revision),
      );
    });
    const admitted = await get(plan.sessionId, plan.turnId);
    if (!admitted) throw new Error(`Frozen turn plan ${plan.planId} was not recorded`);
    return admitted;
  };

  return Object.freeze({ admit, get });
}
