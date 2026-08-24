import type { DatabaseRow } from "./database.ts";
import {
  createConditionalObject,
  type CapabilityBinding,
  CapabilityBindingSchema,
  type CapabilityDefinition,
  CapabilityDefinitionSchema,
  type CapabilityFeedback,
  CapabilityFeedbackSchema,
  type CapabilityGateRequest,
  CapabilityGateRequestSchema,
  type CapabilityLifecycleRevision,
  CapabilityLifecycleRevisionSchema,
  CapabilityRevisionSchema,
  type CapabilityScope,
  canonicalJson,
  capabilityRevisionRef,
  type EvidenceRef,
  sameCapabilityRevisionRef,
  WorkingAdjustmentSchema,
} from "@noesis/domain";
import { parseJson, requiredNumber, requiredString, type WorkspaceDatabase } from "./database.ts";
import type { CapabilityLifecycleStore } from "./types.ts";
interface CapabilityLifecycleStoreOptions {
  readonly database: WorkspaceDatabase;
  readonly now: () => string;
  readonly assertStoredReference: (reference: EvidenceRef) => void;
}
function decodeDefinition(row: DatabaseRow | undefined): CapabilityDefinition | undefined {
  return row === undefined
    ? undefined
    : CapabilityDefinitionSchema.parse(parseJson(requiredString(row, "definition_json")));
}
function decodeRevision(row: DatabaseRow | undefined): CapabilityLifecycleRevision | undefined {
  if (row === undefined) return undefined;
  const parsed = CapabilityLifecycleRevisionSchema.parse(parseJson(requiredString(row, "revision_json")));
  const revision = normalizeLifecycleRevision(parsed);
  const expected = capabilityRevisionRef(revision.revision);
  if (!sameCapabilityRevisionRef(expected, revision.reference))
    throw new Error(`Capability revision ${revision.reference.capabilityRevisionId} has a stale digest`);
  return revision;
}
function decodeBinding(row: DatabaseRow | undefined): CapabilityBinding | undefined {
  if (row === undefined) return undefined;
  return CapabilityBindingSchema.parse({
    capabilityId: requiredString(row, "capability_id"),
    revision: parseJson(requiredString(row, "revision_json")),
    scope: parseJson(requiredString(row, "scope_json")),
    activationMode: requiredString(row, "activation_mode"),
    state: requiredString(row, "state"),
    revisionNumber: requiredNumber(row, "binding_revision"),
    updatedAt: requiredString(row, "updated_at"),
  });
}
function decodeFeedback(row: DatabaseRow | undefined): CapabilityFeedback | undefined {
  return row === undefined
    ? undefined
    : CapabilityFeedbackSchema.parse(parseJson(requiredString(row, "feedback_json")));
}
function decodeGate(row: DatabaseRow | undefined): CapabilityGateRequest | undefined {
  if (row === undefined) return undefined;
  return normalizeGate(CapabilityGateRequestSchema.parse(parseJson(requiredString(row, "request_json"))));
}
function normalizeLifecycleRevision(value: unknown): CapabilityLifecycleRevision {
  const parsed = CapabilityLifecycleRevisionSchema.parse(value);
  const bundle = CapabilityRevisionSchema.parse(parsed.revision);
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const revision = Object.freeze(
    createConditionalObject({
      capabilityRevisionId: bundle.capabilityRevisionId,
      capabilityId: bundle.capabilityId,
    } as const)
      .addOptional(
        !(bundle.predecessorRevisionId === undefined)
          ? {
              predecessorRevisionId: bundle.predecessorRevisionId,
            }
          : undefined,
      )
      .addOptional(!(bundle.effects === undefined) ? { effects: Object.freeze(bundle.effects) } : undefined)
      .add({
        promptModules: Object.freeze(bundle.promptModules),
        skills: Object.freeze(bundle.skills),
        tools: Object.freeze(bundle.tools),
        toolset: Object.freeze(bundle.toolset),
        activationPolicy: Object.freeze(bundle.activationPolicy),
      } as const)
      .addOptional(
        !(bundle.dependencyLock === undefined) ? { dependencyLock: bundle.dependencyLock } : undefined,
      )
      .add({
        permissionManifest: Object.freeze(bundle.permissionManifest),
        evidenceRefs: Object.freeze(bundle.evidenceRefs),
        sourceEvaluationDefinitions: Object.freeze(bundle.sourceEvaluationDefinitions),
        requestedPermissionDelta: Object.freeze(bundle.requestedPermissionDelta),
      } as const)
      .finish(),
  );
  return Object.freeze({
    revision,
    reference: Object.freeze(parsed.reference),
    summary: parsed.summary,
    rationale: parsed.rationale,
    anticipatedEffect: parsed.anticipatedEffect,
    createdAt: parsed.createdAt,
  });
}
function normalizeGate(value: unknown): CapabilityGateRequest {
  const parsed = CapabilityGateRequestSchema.parse(value);
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze(
    createConditionalObject({
      gateRequestId: parsed.gateRequestId,
      capabilityId: parsed.capabilityId,
      revision: Object.freeze(parsed.revision),
      expectedBindingRevision: parsed.expectedBindingRevision,
      proposedScope: Object.freeze(parsed.proposedScope),
      proposedActivationMode: parsed.proposedActivationMode,
      consequence: parsed.consequence,
      status: parsed.status,
    } as const)
      .addOptional(!(parsed.instruction === undefined) ? { instruction: parsed.instruction } : undefined)
      .add({
        createdAt: parsed.createdAt,
      } as const)
      .addOptional(!(parsed.settledAt === undefined) ? { settledAt: parsed.settledAt } : undefined)
      .finish(),
  );
}
function assertRevisionSupportsScope(revision: CapabilityLifecycleRevision, scope: CapabilityScope): void {
  for (const effect of revision.revision.effects ?? []) {
    if (effect.kind !== "program") continue;
    const { program } = effect;
    if (
      scope.kind !== "project" ||
      scope.project.projectId !== program.project.projectId ||
      scope.project.root !== program.project.root
    )
      throw new Error(
        `Capability Program ${program.name} must remain bound to project ${program.project.projectId}`,
      );
  }
}
export function createCapabilityLifecycleStore(
  options: CapabilityLifecycleStoreOptions,
): CapabilityLifecycleStore {
  const db = options.database.connection;
  const getDefinition: CapabilityLifecycleStore["getDefinition"] = async (capabilityId) =>
    decodeDefinition(
      db.prepare("SELECT definition_json FROM capabilities WHERE capability_id = ?").get(capabilityId),
    );
  const getRevision: CapabilityLifecycleStore["getRevision"] = async (reference) => {
    const revision = decodeRevision(
      db
        .prepare(
          "SELECT revision_json FROM capability_revisions WHERE capability_revision_id = ? AND capability_id = ?",
        )
        .get(reference.capabilityRevisionId, reference.capabilityId),
    );
    return revision && sameCapabilityRevisionRef(revision.reference, reference) ? revision : undefined;
  };
  const getRevisionById: CapabilityLifecycleStore["getRevisionById"] = async (
    capabilityId,
    capabilityRevisionId,
  ) =>
    decodeRevision(
      db
        .prepare(
          "SELECT revision_json FROM capability_revisions WHERE capability_revision_id = ? AND capability_id = ?",
        )
        .get(capabilityRevisionId, capabilityId),
    );
  const getBinding: CapabilityLifecycleStore["getBinding"] = async (capabilityId) =>
    decodeBinding(db.prepare("SELECT * FROM capability_bindings WHERE capability_id = ?").get(capabilityId));
  const assertBatchIds = (capabilityIds: readonly string[]): readonly string[] => {
    const unique = Object.freeze([...new Set(capabilityIds)]);
    if (unique.length > 1000) throw new Error("Capability lifecycle batch lookup cannot exceed 1000 ids");
    if (unique.some((capabilityId) => capabilityId.length === 0))
      throw new Error("Capability lifecycle batch lookup requires non-empty ids");
    return unique;
  };
  const getBindings: CapabilityLifecycleStore["getBindings"] = async (capabilityIds) => {
    const ids = assertBatchIds(capabilityIds);
    if (ids.length === 0) return Object.freeze([]);
    const placeholders = ids.map(() => "?").join(", ");
    return Object.freeze(
      db
        .prepare(`SELECT * FROM capability_bindings WHERE capability_id IN (${placeholders})`)
        .all(...ids)
        .map((row) => {
          const value = decodeBinding(row);
          if (!value) throw new Error("Capability binding row disappeared during decoding");
          return value;
        }),
    );
  };
  const assertRevision = (revision: CapabilityLifecycleRevision): CapabilityLifecycleRevision => {
    const parsed = normalizeLifecycleRevision(revision);
    if (parsed.revision.capabilityId !== parsed.reference.capabilityId)
      throw new Error("Capability revision bundle and reference identify different capabilities");
    const expected = capabilityRevisionRef(parsed.revision);
    if (!sameCapabilityRevisionRef(expected, parsed.reference))
      throw new Error("Capability revision reference does not match its exact bundle");
    for (const reference of [
      ...(parsed.revision.effects ?? []).map((effect) =>
        effect.kind === "instruction" || effect.kind === "skill"
          ? effect.material
          : effect.program.definitionRevision,
      ),
      ...parsed.revision.promptModules,
      ...parsed.revision.skills,
      ...parsed.revision.tools,
      parsed.revision.toolset.routerRevision,
      ...(parsed.revision.dependencyLock ? [parsed.revision.dependencyLock] : []),
      ...parsed.revision.sourceEvaluationDefinitions,
      ...parsed.revision.evidenceRefs,
    ])
      options.assertStoredReference(reference);
    return parsed;
  };
  const assertLimit = (limit: number): void => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("Capability lifecycle list limit must be an integer between 1 and 1000");
  };
  const scopedWhere = `(
    json_extract(scope_json, '$.kind') = 'global'
    OR (
      json_extract(scope_json, '$.kind') = 'project'
      AND json_extract(scope_json, '$.project.projectId') = ?
      AND json_extract(scope_json, '$.project.root') = ?
    )
    OR (
      json_extract(scope_json, '$.kind') = 'session'
      AND json_extract(scope_json, '$.sessionId') = ?
    )
  )`;
  const insertRevision = (revision: CapabilityLifecycleRevision): void => {
    const existing = db
      .prepare("SELECT revision_json FROM capability_revisions WHERE capability_revision_id = ?")
      .get(revision.reference.capabilityRevisionId);
    const encoded = canonicalJson(revision);
    if (existing !== undefined) {
      if (requiredString(existing, "revision_json") !== encoded)
        throw new Error(
          `Immutable capability revision ${revision.reference.capabilityRevisionId} already differs`,
        );
      return;
    }
    if (revision.revision.predecessorRevisionId) {
      const predecessor = db
        .prepare("SELECT capability_id FROM capability_revisions WHERE capability_revision_id = ?")
        .get(revision.revision.predecessorRevisionId);
      if (
        predecessor === undefined ||
        requiredString(predecessor, "capability_id") !== revision.reference.capabilityId
      )
        throw new Error("Capability predecessor must be an existing revision of the same capability");
    }
    db.prepare(`INSERT INTO capability_revisions(
        capability_revision_id, capability_id, predecessor_revision_id, revision_json, created_at
      ) VALUES (?, ?, ?, ?, ?)`).run(
      revision.reference.capabilityRevisionId,
      revision.reference.capabilityId,
      revision.revision.predecessorRevisionId ?? null,
      encoded,
      revision.createdAt,
    );
  };
  const insertFeedback = (feedback: CapabilityFeedback): CapabilityFeedback => {
    const existing = decodeFeedback(
      db
        .prepare("SELECT feedback_json FROM capability_feedback WHERE feedback_id = ?")
        .get(feedback.feedbackId),
    );
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(feedback))
        throw new Error(`Immutable capability feedback ${feedback.feedbackId} differs`);
      return existing;
    }
    if (!storedRevisionExists(db, feedback.revision))
      throw new Error(`Unknown capability revision ${feedback.revision.capabilityRevisionId}`);
    db.prepare(`INSERT INTO capability_feedback(
        feedback_id, capability_id, revision_json, feedback_json, created_at
      ) VALUES (?, ?, ?, ?, ?)`).run(
      feedback.feedbackId,
      feedback.capabilityId,
      canonicalJson(feedback.revision),
      canonicalJson(feedback),
      feedback.createdAt,
    );
    return feedback;
  };
  const insertGate = (gate: CapabilityGateRequest): CapabilityGateRequest => {
    if (gate.status !== "pending") throw new Error("A new capability gate must be pending");
    const existing = decodeGate(
      db
        .prepare("SELECT request_json FROM capability_gate_requests WHERE gate_request_id = ?")
        .get(gate.gateRequestId),
    );
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(gate))
        throw new Error(`Immutable capability gate ${gate.gateRequestId} differs`);
      return existing;
    }
    const revision = readStoredRevision(db, gate.revision);
    if (!revision) throw new Error(`Unknown capability revision ${gate.revision.capabilityRevisionId}`);
    assertRevisionSupportsScope(revision, gate.proposedScope);
    db.prepare(`INSERT INTO capability_gate_requests(
        gate_request_id, capability_id, revision_json, request_json, status, created_at, settled_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(
      gate.gateRequestId,
      gate.capabilityId,
      canonicalJson(gate.revision),
      canonicalJson(gate),
      gate.status,
      gate.createdAt,
    );
    return gate;
  };
  const settlePendingGate = (
    current: CapabilityGateRequest,
    status: "approved" | "denied" | "superseded",
    instruction?: string,
  ): CapabilityGateRequest => {
    if (current.status !== "pending")
      throw new Error(`Capability gate ${current.gateRequestId} is already ${current.status}`);
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const settled = normalizeGate(
      createConditionalObject({
        ...current,
        status,
      } as const)
        .addOptional(instruction ? { instruction } : undefined)
        .add({
          settledAt: options.now(),
        } as const)
        .finish(),
    );
    const result = db
      .prepare(`UPDATE capability_gate_requests
         SET request_json = ?, status = ?, settled_at = ?
         WHERE gate_request_id = ? AND status = 'pending'`)
      .run(canonicalJson(settled), settled.status, settled.settledAt ?? null, settled.gateRequestId);
    if (Number(result.changes) !== 1)
      throw new Error(`Capability gate ${current.gateRequestId} changed concurrently`);
    return settled;
  };
  const updateBindingRow = (request: {
    readonly capabilityId: string;
    readonly expectedRevisionNumber: number;
    readonly revision?: import("@noesis/domain").CapabilityRevisionRef;
    readonly scope?: import("@noesis/domain").CapabilityScope;
    readonly activationMode?: import("@noesis/domain").CapabilityActivationMode;
    readonly state?: import("@noesis/domain").CapabilityBindingState;
  }) => {
    const current = decodeBinding(
      db.prepare("SELECT * FROM capability_bindings WHERE capability_id = ?").get(request.capabilityId),
    );
    if (!current) throw new Error(`Unknown capability binding ${request.capabilityId}`);
    if (current.revisionNumber !== request.expectedRevisionNumber)
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return Object.freeze({ status: "stale" as const, binding: current });
    if (request.revision && request.revision.capabilityId !== request.capabilityId)
      throw new Error("A capability binding cannot point at another capability's revision");
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const next = CapabilityBindingSchema.parse(
      createConditionalObject({
        ...current,
      } as const)
        .addOptional(request.revision ? { revision: request.revision } : undefined)
        .addOptional(request.scope ? { scope: request.scope } : undefined)
        .addOptional(request.activationMode ? { activationMode: request.activationMode } : undefined)
        .addOptional(request.state ? { state: request.state } : undefined)
        .add({
          revisionNumber: current.revisionNumber + 1,
          updatedAt: options.now(),
        } as const)
        .finish(),
    );
    const storedRevision = readStoredRevision(db, next.revision);
    if (!storedRevision) throw new Error(`Unknown capability revision ${next.revision.capabilityRevisionId}`);
    assertRevisionSupportsScope(storedRevision, next.scope);
    const result = db
      .prepare(`UPDATE capability_bindings SET
          revision_json = ?, scope_json = ?, activation_mode = ?, state = ?,
          binding_revision = ?, updated_at = ?
         WHERE capability_id = ? AND binding_revision = ?`)
      .run(
        canonicalJson(next.revision),
        canonicalJson(next.scope),
        next.activationMode,
        next.state,
        next.revisionNumber,
        next.updatedAt,
        next.capabilityId,
        current.revisionNumber,
      );
    if (Number(result.changes) !== 1) throw new Error("Capability binding compare-and-swap failed");
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return Object.freeze({ status: "updated" as const, binding: next });
  };
  const create: CapabilityLifecycleStore["create"] = async (request) => {
    const definition = CapabilityDefinitionSchema.parse(request.definition);
    const revision = assertRevision(request.revision);
    if (
      definition.capabilityId !== revision.reference.capabilityId ||
      request.binding.capabilityId !== definition.capabilityId ||
      !sameCapabilityRevisionRef(request.binding.revision, revision.reference)
    )
      throw new Error("Capability definition, revision, and binding identities do not match");
    const updatedAt = options.now();
    const binding = CapabilityBindingSchema.parse({
      ...request.binding,
      revisionNumber: 1,
      updatedAt,
    });
    assertRevisionSupportsScope(revision, binding.scope);
    const gate = request.gate ? normalizeGate(request.gate) : undefined;
    if (
      gate &&
      (gate.capabilityId !== binding.capabilityId ||
        !sameCapabilityRevisionRef(gate.revision, binding.revision) ||
        gate.expectedBindingRevision !== binding.revisionNumber ||
        canonicalJson(gate.proposedScope) !== canonicalJson(binding.scope) ||
        gate.proposedActivationMode !== binding.activationMode ||
        binding.state !== "paused")
    )
      throw new Error("A gated capability creation must bind the exact pending revision");
    return options.database.transaction(() => {
      const existing = db
        .prepare("SELECT definition_json FROM capabilities WHERE capability_id = ?")
        .get(definition.capabilityId);
      const encodedDefinition = canonicalJson(definition);
      if (existing !== undefined && requiredString(existing, "definition_json") !== encodedDefinition)
        throw new Error(`Capability identity collision for ${definition.capabilityId}`);
      if (existing === undefined)
        db.prepare(
          "INSERT INTO capabilities(capability_id, definition_json, created_at) VALUES (?, ?, ?)",
        ).run(definition.capabilityId, encodedDefinition, definition.createdAt);
      insertRevision(revision);
      const current = decodeBinding(
        db.prepare("SELECT * FROM capability_bindings WHERE capability_id = ?").get(definition.capabilityId),
      );
      if (current) {
        if (
          !sameCapabilityRevisionRef(current.revision, binding.revision) ||
          canonicalJson(current.scope) !== canonicalJson(binding.scope) ||
          current.activationMode !== binding.activationMode ||
          current.state !== binding.state
        )
          throw new Error(`Capability ${definition.capabilityId} already has another binding`);
        if (gate) insertGate(gate);
        return current;
      }
      db.prepare(`INSERT INTO capability_bindings(
          capability_id, revision_json, scope_json, activation_mode, state, binding_revision, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        binding.capabilityId,
        canonicalJson(binding.revision),
        canonicalJson(binding.scope),
        binding.activationMode,
        binding.state,
        binding.revisionNumber,
        binding.updatedAt,
      );
      if (gate) insertGate(gate);
      return binding;
    });
  };
  const addRevision: CapabilityLifecycleStore["addRevision"] = async (input) => {
    const revision = assertRevision(input);
    return options.database.transaction(() => {
      if (
        db
          .prepare("SELECT 1 FROM capabilities WHERE capability_id = ?")
          .get(revision.reference.capabilityId) === undefined
      )
        throw new Error(`Unknown capability ${revision.reference.capabilityId}`);
      insertRevision(revision);
      return revision;
    });
  };
  const listDefinitions: CapabilityLifecycleStore["listDefinitions"] = async () =>
    Object.freeze(
      db
        .prepare("SELECT definition_json FROM capabilities ORDER BY created_at DESC, capability_id")
        .all()
        .map((row) => CapabilityDefinitionSchema.parse(parseJson(requiredString(row, "definition_json")))),
    );
  const getDefinitions: CapabilityLifecycleStore["getDefinitions"] = async (capabilityIds) => {
    const ids = assertBatchIds(capabilityIds);
    if (ids.length === 0) return Object.freeze([]);
    const placeholders = ids.map(() => "?").join(", ");
    return Object.freeze(
      db
        .prepare(`SELECT definition_json FROM capabilities WHERE capability_id IN (${placeholders})`)
        .all(...ids)
        .map((row) => {
          const value = decodeDefinition(row);
          if (!value) throw new Error("Capability definition row disappeared during decoding");
          return value;
        }),
    );
  };
  const listRevisions: CapabilityLifecycleStore["listRevisions"] = async (capabilityId, request) => {
    if (request) assertLimit(request.limit);
    const rows = request
      ? db
          .prepare(
            "SELECT revision_json FROM capability_revisions WHERE capability_id = ? ORDER BY created_at DESC, capability_revision_id DESC LIMIT ?",
          )
          .all(capabilityId, request.limit)
      : db
          .prepare(
            "SELECT revision_json FROM capability_revisions WHERE capability_id = ? ORDER BY created_at, capability_revision_id",
          )
          .all(capabilityId);
    return Object.freeze(
      rows.map((row) => {
        const value = decodeRevision(row);
        if (!value) throw new Error("Capability revision row disappeared during decoding");
        return value;
      }),
    );
  };
  const listRevisionPage: CapabilityLifecycleStore["listRevisionPage"] = async (request) => {
    assertLimit(request.limit);
    const rows = request.after
      ? db
          .prepare(`SELECT revision_json, created_at, capability_revision_id
             FROM capability_revisions
             WHERE capability_id = ?
               AND (created_at < ? OR (created_at = ? AND capability_revision_id < ?))
             ORDER BY created_at DESC, capability_revision_id DESC
             LIMIT ?`)
          .all(
            request.capabilityId,
            request.after.createdAt,
            request.after.createdAt,
            request.after.id,
            request.limit + 1,
          )
      : db
          .prepare(`SELECT revision_json, created_at, capability_revision_id
             FROM capability_revisions
             WHERE capability_id = ?
             ORDER BY created_at DESC, capability_revision_id DESC
             LIMIT ?`)
          .all(request.capabilityId, request.limit + 1);
    const visible = rows.slice(0, request.limit);
    const last = visible.at(-1);
    return Object.freeze(
      createConditionalObject({
        items: Object.freeze(
          visible.map((row) => {
            const value = decodeRevision(row);
            if (!value) throw new Error("Capability revision row disappeared during decoding");
            return value;
          }),
        ),
      } as const)
        .addOptional(
          rows.length > request.limit && last
            ? {
                nextCursor: Object.freeze({
                  createdAt: requiredString(last, "created_at"),
                  id: requiredString(last, "capability_revision_id"),
                }),
              }
            : undefined,
        )
        .finish(),
    );
  };
  const listBindings: CapabilityLifecycleStore["listBindings"] = async (request) => {
    if (request) assertLimit(request.limit);
    const rows = request
      ? db
          .prepare(`SELECT * FROM capability_bindings
             WHERE ${scopedWhere}
             ORDER BY updated_at DESC, capability_id
             LIMIT ?`)
          .all(request.project.projectId, request.project.root, request.sessionId, request.limit)
      : db.prepare("SELECT * FROM capability_bindings ORDER BY updated_at DESC, capability_id").all();
    return Object.freeze(
      rows.map((row) => {
        const value = decodeBinding(row);
        if (!value) throw new Error("Capability binding row disappeared during decoding");
        return value;
      }),
    );
  };
  const listEligibleBindings: CapabilityLifecycleStore["listEligibleBindings"] = async (request) =>
    Object.freeze(
      db
        .prepare(`SELECT * FROM (
             SELECT * FROM capability_bindings
             WHERE state = 'active' AND json_extract(scope_json, '$.kind') = 'global'
             UNION ALL
             SELECT * FROM capability_bindings
             WHERE state = 'active'
               AND json_extract(scope_json, '$.kind') = 'project'
               AND json_extract(scope_json, '$.project.projectId') = ?
               AND json_extract(scope_json, '$.project.root') = ?
             UNION ALL
             SELECT * FROM capability_bindings
             WHERE state = 'active'
               AND json_extract(scope_json, '$.kind') = 'session'
               AND json_extract(scope_json, '$.sessionId') = ?
           )
           ORDER BY updated_at DESC, capability_id`)
        .all(request.project.projectId, request.project.root, request.sessionId)
        .map((row) => {
          const value = decodeBinding(row);
          if (!value) throw new Error("Capability binding row disappeared during decoding");
          return value;
        }),
    );
  const updateBinding: CapabilityLifecycleStore["updateBinding"] = async (request) =>
    options.database.transaction(() => updateBindingRow(request));
  const updateBindingWithFeedback: CapabilityLifecycleStore["updateBindingWithFeedback"] = async (
    request,
  ) => {
    const feedback = CapabilityFeedbackSchema.parse(request.feedback);
    for (const reference of feedback.evidenceRefs) options.assertStoredReference(reference);
    return options.database.transaction(() => {
      const current = decodeBinding(
        db.prepare("SELECT * FROM capability_bindings WHERE capability_id = ?").get(request.capabilityId),
      );
      if (!current) throw new Error(`Unknown capability binding ${request.capabilityId}`);
      if (current.revisionNumber !== request.expectedRevisionNumber)
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        return Object.freeze({ status: "stale" as const, binding: current });
      if (!sameCapabilityRevisionRef(feedback.revision, current.revision))
        throw new Error("Capability feedback must describe the binding being changed");
      insertFeedback(feedback);
      return updateBindingRow(request);
    });
  };
  const addFeedback: CapabilityLifecycleStore["addFeedback"] = async (input) => {
    const feedback = CapabilityFeedbackSchema.parse(input);
    for (const reference of feedback.evidenceRefs) options.assertStoredReference(reference);
    return options.database.transaction(() => insertFeedback(feedback));
  };
  const listFeedback: CapabilityLifecycleStore["listFeedback"] = async (capabilityId, request) => {
    if (request) assertLimit(request.limit);
    const rows = request
      ? db
          .prepare(
            "SELECT feedback_json FROM capability_feedback WHERE capability_id = ? ORDER BY created_at DESC, feedback_id DESC LIMIT ?",
          )
          .all(capabilityId, request.limit)
      : db
          .prepare(
            "SELECT feedback_json FROM capability_feedback WHERE capability_id = ? ORDER BY created_at DESC, feedback_id DESC",
          )
          .all(capabilityId);
    return Object.freeze(
      rows.map((row) => CapabilityFeedbackSchema.parse(parseJson(requiredString(row, "feedback_json")))),
    );
  };
  const listFeedbackPage: CapabilityLifecycleStore["listFeedbackPage"] = async (request) => {
    assertLimit(request.limit);
    const rows = request.after
      ? db
          .prepare(`SELECT feedback_json, created_at, feedback_id
             FROM capability_feedback
             WHERE capability_id = ?
               AND (created_at < ? OR (created_at = ? AND feedback_id < ?))
             ORDER BY created_at DESC, feedback_id DESC
             LIMIT ?`)
          .all(
            request.capabilityId,
            request.after.createdAt,
            request.after.createdAt,
            request.after.id,
            request.limit + 1,
          )
      : db
          .prepare(`SELECT feedback_json, created_at, feedback_id
             FROM capability_feedback
             WHERE capability_id = ?
             ORDER BY created_at DESC, feedback_id DESC
             LIMIT ?`)
          .all(request.capabilityId, request.limit + 1);
    const visible = rows.slice(0, request.limit);
    const last = visible.at(-1);
    return Object.freeze(
      createConditionalObject({
        items: Object.freeze(
          visible.map((row) =>
            CapabilityFeedbackSchema.parse(parseJson(requiredString(row, "feedback_json"))),
          ),
        ),
      } as const)
        .addOptional(
          rows.length > request.limit && last
            ? {
                nextCursor: Object.freeze({
                  createdAt: requiredString(last, "created_at"),
                  id: requiredString(last, "feedback_id"),
                }),
              }
            : undefined,
        )
        .finish(),
    );
  };
  const stageGatedRevision: CapabilityLifecycleStore["stageGatedRevision"] = async (request) => {
    const revision = assertRevision(request.revision);
    const gate = normalizeGate(request.gate);
    const feedback = request.feedback ? CapabilityFeedbackSchema.parse(request.feedback) : undefined;
    if (!sameCapabilityRevisionRef(gate.revision, revision.reference))
      throw new Error("A capability gate must bind the exact staged revision");
    if (feedback) for (const reference of feedback.evidenceRefs) options.assertStoredReference(reference);
    return options.database.transaction(() => {
      const binding = decodeBinding(
        db.prepare("SELECT * FROM capability_bindings WHERE capability_id = ?").get(gate.capabilityId),
      );
      if (!binding) throw new Error(`Unknown capability ${gate.capabilityId}`);
      if (gate.expectedBindingRevision !== binding.revisionNumber)
        return Object.freeze({ status: "stale" as const, binding });
      const supersededGate = request.supersedeGateRequestId
        ? decodeGate(
            db
              .prepare("SELECT request_json FROM capability_gate_requests WHERE gate_request_id = ?")
              .get(request.supersedeGateRequestId),
          )
        : undefined;
      if (request.supersedeGateRequestId && !supersededGate)
        throw new Error(`Unknown capability gate ${request.supersedeGateRequestId}`);
      if (supersededGate && supersededGate.capabilityId !== gate.capabilityId)
        throw new Error("A replacement gate cannot supersede another capability's request");
      if (supersededGate && supersededGate.expectedBindingRevision !== binding.revisionNumber)
        return Object.freeze({ status: "stale" as const, binding });
      const expectedPredecessor =
        supersededGate?.revision.capabilityRevisionId ?? binding.revision.capabilityRevisionId;
      if (revision.revision.predecessorRevisionId !== expectedPredecessor)
        throw new Error(
          supersededGate
            ? "A replacement gate revision must succeed the superseded staged revision"
            : "A gated capability revision must succeed the current bound revision",
        );
      if (feedback && !sameCapabilityRevisionRef(feedback.revision, binding.revision))
        if (!request.supersedeGateRequestId)
          throw new Error("Gated capability feedback must describe the current binding");
      insertRevision(revision);
      if (supersededGate) {
        if (
          feedback &&
          !sameCapabilityRevisionRef(feedback.revision, binding.revision) &&
          !sameCapabilityRevisionRef(feedback.revision, supersededGate.revision)
        )
          throw new Error("Replacement gate feedback must describe the binding or superseded revision");
        settlePendingGate(supersededGate, "superseded", gate.instruction);
      }
      if (feedback) insertFeedback(feedback);
      return Object.freeze({ status: "staged" as const, gate: insertGate(gate) });
    });
  };
  const applyRevision: CapabilityLifecycleStore["applyRevision"] = async (request) => {
    const revision = assertRevision(request.revision);
    const feedback = CapabilityFeedbackSchema.parse(request.feedback);
    for (const reference of feedback.evidenceRefs) options.assertStoredReference(reference);
    return options.database.transaction(() => {
      const current = decodeBinding(
        db
          .prepare("SELECT * FROM capability_bindings WHERE capability_id = ?")
          .get(revision.reference.capabilityId),
      );
      if (!current) throw new Error(`Unknown capability ${revision.reference.capabilityId}`);
      if (current.revisionNumber !== request.expectedBindingRevision)
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        return Object.freeze({ status: "stale" as const, binding: current });
      if (!sameCapabilityRevisionRef(feedback.revision, current.revision))
        throw new Error("Capability revision feedback must describe the current binding");
      if (revision.revision.predecessorRevisionId !== current.revision.capabilityRevisionId)
        throw new Error("A capability revision must succeed the current bound revision");
      insertRevision(revision);
      insertFeedback(feedback);
      return updateBindingRow({
        capabilityId: revision.reference.capabilityId,
        expectedRevisionNumber: request.expectedBindingRevision,
        revision: revision.reference,
        scope: request.scope,
        activationMode: request.activationMode,
        state: current.state,
      });
    });
  };
  const createGate: CapabilityLifecycleStore["createGate"] = async (input) => {
    const gate = normalizeGate(input);
    return options.database.transaction(() => insertGate(gate));
  };
  const getGate: CapabilityLifecycleStore["getGate"] = async (gateRequestId) =>
    decodeGate(
      db
        .prepare("SELECT request_json FROM capability_gate_requests WHERE gate_request_id = ?")
        .get(gateRequestId),
    );
  const listPendingGates: CapabilityLifecycleStore["listPendingGates"] = async (request) => {
    if (request) assertLimit(request.limit);
    const rows = request
      ? db
          .prepare(`SELECT gate.request_json
             FROM capability_gate_requests AS gate
             JOIN capability_bindings AS binding ON binding.capability_id = gate.capability_id
             WHERE gate.status = 'pending' AND ${scopedWhere}
             ORDER BY gate.created_at, gate.gate_request_id
             LIMIT ?`)
          .all(request.project.projectId, request.project.root, request.sessionId, request.limit)
      : db
          .prepare(
            "SELECT request_json FROM capability_gate_requests WHERE status = 'pending' ORDER BY created_at, gate_request_id",
          )
          .all();
    return Object.freeze(rows.map((row) => normalizeGate(parseJson(requiredString(row, "request_json")))));
  };
  const listGates: CapabilityLifecycleStore["listGates"] = async (capabilityId) =>
    Object.freeze(
      db
        .prepare(
          "SELECT request_json FROM capability_gate_requests WHERE capability_id = ? ORDER BY created_at DESC, gate_request_id DESC",
        )
        .all(capabilityId)
        .map((row) => normalizeGate(parseJson(requiredString(row, "request_json")))),
    );
  const listGatePage: CapabilityLifecycleStore["listGatePage"] = async (request) => {
    assertLimit(request.limit);
    const rows = request.after
      ? db
          .prepare(`SELECT request_json, created_at, gate_request_id
             FROM capability_gate_requests
             WHERE capability_id = ?
               AND (created_at < ? OR (created_at = ? AND gate_request_id < ?))
             ORDER BY created_at DESC, gate_request_id DESC
             LIMIT ?`)
          .all(
            request.capabilityId,
            request.after.createdAt,
            request.after.createdAt,
            request.after.id,
            request.limit + 1,
          )
      : db
          .prepare(`SELECT request_json, created_at, gate_request_id
             FROM capability_gate_requests
             WHERE capability_id = ?
             ORDER BY created_at DESC, gate_request_id DESC
             LIMIT ?`)
          .all(request.capabilityId, request.limit + 1);
    const visible = rows.slice(0, request.limit);
    const last = visible.at(-1);
    return Object.freeze(
      createConditionalObject({
        items: Object.freeze(
          visible.map((row) => normalizeGate(parseJson(requiredString(row, "request_json")))),
        ),
      } as const)
        .addOptional(
          rows.length > request.limit && last
            ? {
                nextCursor: Object.freeze({
                  createdAt: requiredString(last, "created_at"),
                  id: requiredString(last, "gate_request_id"),
                }),
              }
            : undefined,
        )
        .finish(),
    );
  };
  const countLifecycle: CapabilityLifecycleStore["countLifecycle"] = async (capabilityId) => {
    const row = db
      .prepare(`SELECT
          (SELECT COUNT(*) FROM capability_revisions WHERE capability_id = ?) AS revisions,
          (SELECT COUNT(*) FROM capability_feedback WHERE capability_id = ?) AS feedback,
          (SELECT COUNT(*) FROM capability_gate_requests WHERE capability_id = ?) AS gates`)
      .get(capabilityId, capabilityId, capabilityId);
    if (!row) throw new Error("Capability lifecycle counts could not be read");
    return Object.freeze({
      revisions: requiredNumber(row, "revisions"),
      feedback: requiredNumber(row, "feedback"),
      gates: requiredNumber(row, "gates"),
    });
  };
  const decideGate: CapabilityLifecycleStore["decideGate"] = async (request) =>
    options.database.transaction(() => {
      const gate = decodeGate(
        db
          .prepare("SELECT request_json FROM capability_gate_requests WHERE gate_request_id = ?")
          .get(request.gateRequestId),
      );
      if (!gate) throw new Error(`Unknown capability gate ${request.gateRequestId}`);
      if (gate.status !== "pending")
        throw new Error(`Capability gate ${request.gateRequestId} is already ${gate.status}`);
      const binding = decodeBinding(
        db.prepare("SELECT * FROM capability_bindings WHERE capability_id = ?").get(gate.capabilityId),
      );
      if (!binding) throw new Error(`Unknown capability ${gate.capabilityId}`);
      if (request.decision === "deny") {
        const settled = settlePendingGate(gate, "denied");
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        return Object.freeze({ status: "updated" as const, gate: settled, binding });
      }
      const updated = updateBindingRow({
        capabilityId: gate.capabilityId,
        expectedRevisionNumber: gate.expectedBindingRevision,
        revision: gate.revision,
        scope: gate.proposedScope,
        activationMode: gate.proposedActivationMode,
        state: "active",
      });
      if (updated.status === "stale") return Object.freeze({ ...updated, gate });
      const settled = settlePendingGate(gate, "approved");
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return Object.freeze({ status: "updated" as const, gate: settled, binding: updated.binding });
    });
  const settleGate: CapabilityLifecycleStore["settleGate"] = async (request) =>
    options.database.transaction(() => {
      const current = decodeGate(
        db
          .prepare("SELECT request_json FROM capability_gate_requests WHERE gate_request_id = ?")
          .get(request.gateRequestId),
      );
      if (!current) throw new Error(`Unknown capability gate ${request.gateRequestId}`);
      if (current.status !== "pending") {
        if (current.status !== request.status)
          throw new Error(`Capability gate ${request.gateRequestId} is already ${current.status}`);
        return current;
      }
      return settlePendingGate(current, request.status, request.instruction);
    });
  const listActiveLegacyAdjustments: CapabilityLifecycleStore["listActiveLegacyAdjustments"] = async () =>
    Object.freeze(
      db
        .prepare(`SELECT adjustment.data_json
           FROM active_project_adjustments AS active
           JOIN working_adjustments AS adjustment
             ON adjustment.project_id = active.project_id
            AND adjustment.adjustment_id = active.adjustment_id
           ORDER BY active.project_id`)
        .all()
        .map((row) => WorkingAdjustmentSchema.parse(parseJson(requiredString(row, "data_json")))),
    );
  const recordCutoverFailure: CapabilityLifecycleStore["recordCutoverFailure"] = async (
    adjustment,
    failure,
  ) => {
    options.database.transaction(() => {
      db.prepare(`INSERT INTO capability_learning_cutover_failures(
          source_project_id, source_adjustment_id, failure, occurred_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(source_project_id, source_adjustment_id) DO UPDATE SET
          failure = excluded.failure,
          occurred_at = excluded.occurred_at`).run(
        adjustment.scope.projectId,
        adjustment.adjustmentId,
        failure.slice(0, 8192),
        options.now(),
      );
    });
  };
  const clearCutoverFailure: CapabilityLifecycleStore["clearCutoverFailure"] = async (adjustment) => {
    options.database.transaction(() => {
      db.prepare(`DELETE FROM capability_learning_cutover_failures
         WHERE source_project_id = ? AND source_adjustment_id = ?`).run(
        adjustment.scope.projectId,
        adjustment.adjustmentId,
      );
    });
  };
  const isCutoverComplete: CapabilityLifecycleStore["isCutoverComplete"] = async () =>
    db.prepare("SELECT 1 FROM capability_learning_cutovers WHERE cutover_version = 1").get() !== undefined;
  const completeCutover: CapabilityLifecycleStore["completeCutover"] = async () =>
    options.database.transaction(() => {
      if (db.prepare("SELECT 1 FROM capability_learning_cutovers WHERE cutover_version = 1").get())
        return false;
      db.prepare(`DELETE FROM capability_learning_cutover_failures
         WHERE NOT EXISTS (
           SELECT 1
           FROM active_project_adjustments AS active
           JOIN working_adjustments AS adjustment
             ON adjustment.project_id = active.project_id
            AND adjustment.adjustment_id = active.adjustment_id
           WHERE adjustment.project_id = capability_learning_cutover_failures.source_project_id
             AND adjustment.adjustment_id = capability_learning_cutover_failures.source_adjustment_id
         )`).run();
      if (db.prepare("SELECT 1 FROM capability_learning_cutover_failures LIMIT 1").get())
        throw new Error("Capability learning cutover still has recorded failures");
      db.prepare("INSERT INTO capability_learning_cutovers(cutover_version, completed_at) VALUES (1, ?)").run(
        options.now(),
      );
      db.prepare(`UPDATE jobs
         SET status = 'cancelled', completed_at = ?, lease_token = NULL, lease_until = NULL
         WHERE status IN ('scheduled', 'running')
           AND kind IN ('runtime.author_revision', 'runtime.preflight', 'runtime.outcome_judge')`).run(
        options.now(),
      );
      db.prepare("DELETE FROM active_project_adjustments").run();
      return true;
    });
  return Object.freeze({
    create,
    getDefinition,
    listDefinitions,
    getDefinitions,
    getRevision,
    getRevisionById,
    listRevisions,
    listRevisionPage,
    addRevision,
    getBinding,
    getBindings,
    listBindings,
    listEligibleBindings,
    updateBinding,
    updateBindingWithFeedback,
    addFeedback,
    listFeedback,
    listFeedbackPage,
    stageGatedRevision,
    applyRevision,
    createGate,
    getGate,
    listPendingGates,
    listGates,
    listGatePage,
    countLifecycle,
    decideGate,
    settleGate,
    completeCutover,
    isCutoverComplete,
    listActiveLegacyAdjustments,
    recordCutoverFailure,
    clearCutoverFailure,
  });
}
function readStoredRevision(
  db: WorkspaceDatabase["connection"],
  reference: import("@noesis/domain").CapabilityRevisionRef,
): CapabilityLifecycleRevision | undefined {
  const row = db
    .prepare(
      "SELECT revision_json FROM capability_revisions WHERE capability_revision_id = ? AND capability_id = ?",
    )
    .get(reference.capabilityRevisionId, reference.capabilityId);
  const revision = decodeRevision(row);
  return revision && sameCapabilityRevisionRef(revision.reference, reference) ? revision : undefined;
}
function storedRevisionExists(
  db: WorkspaceDatabase["connection"],
  reference: import("@noesis/domain").CapabilityRevisionRef,
): boolean {
  return readStoredRevision(db, reference) !== undefined;
}
