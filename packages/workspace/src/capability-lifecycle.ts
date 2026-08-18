import {
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
  capabilityRevisionRef,
  canonicalJson,
  type EvidenceRef,
  sameCapabilityRevisionRef,
} from "@noesis/domain";
import { parseJson, requiredNumber, requiredString, type WorkspaceDatabase } from "./database.ts";
import type { CapabilityLifecycleStore } from "./types.ts";

interface CapabilityLifecycleStoreOptions {
  readonly database: WorkspaceDatabase;
  readonly now: () => string;
  readonly assertStoredReference: (reference: EvidenceRef) => void;
}

function decodeDefinition(row: unknown): CapabilityDefinition | undefined {
  return row === undefined
    ? undefined
    : CapabilityDefinitionSchema.parse(parseJson(requiredString(row, "definition_json")));
}

function decodeRevision(row: unknown): CapabilityLifecycleRevision | undefined {
  if (row === undefined) return undefined;
  const parsed = CapabilityLifecycleRevisionSchema.parse(parseJson(requiredString(row, "revision_json")));
  const revision = normalizeLifecycleRevision(parsed);
  const expected = capabilityRevisionRef(revision.revision);
  if (!sameCapabilityRevisionRef(expected, revision.reference))
    throw new Error(`Capability revision ${revision.reference.capabilityRevisionId} has a stale digest`);
  return revision;
}

function decodeBinding(row: unknown): CapabilityBinding | undefined {
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

function decodeFeedback(row: unknown): CapabilityFeedback | undefined {
  return row === undefined
    ? undefined
    : CapabilityFeedbackSchema.parse(parseJson(requiredString(row, "feedback_json")));
}

function decodeGate(row: unknown): CapabilityGateRequest | undefined {
  if (row === undefined) return undefined;
  return normalizeGate(CapabilityGateRequestSchema.parse(parseJson(requiredString(row, "request_json"))));
}

function normalizeLifecycleRevision(value: unknown): CapabilityLifecycleRevision {
  const parsed = CapabilityLifecycleRevisionSchema.parse(value);
  const bundle = CapabilityRevisionSchema.parse(parsed.revision);
  const revision = Object.freeze({
    capabilityRevisionId: bundle.capabilityRevisionId,
    capabilityId: bundle.capabilityId,
    ...(bundle.predecessorRevisionId === undefined
      ? {}
      : { predecessorRevisionId: bundle.predecessorRevisionId }),
    promptModules: Object.freeze(bundle.promptModules),
    skills: Object.freeze(bundle.skills),
    tools: Object.freeze(bundle.tools),
    toolset: Object.freeze(bundle.toolset),
    activationPolicy: Object.freeze(bundle.activationPolicy),
    ...(bundle.dependencyLock === undefined ? {} : { dependencyLock: bundle.dependencyLock }),
    permissionManifest: Object.freeze(bundle.permissionManifest),
    evidenceRefs: Object.freeze(bundle.evidenceRefs),
    sourceEvaluationDefinitions: Object.freeze(bundle.sourceEvaluationDefinitions),
    requestedPermissionDelta: Object.freeze(bundle.requestedPermissionDelta),
  });
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
  return Object.freeze({
    gateRequestId: parsed.gateRequestId,
    capabilityId: parsed.capabilityId,
    revision: Object.freeze(parsed.revision),
    expectedBindingRevision: parsed.expectedBindingRevision,
    consequence: parsed.consequence,
    status: parsed.status,
    ...(parsed.instruction === undefined ? {} : { instruction: parsed.instruction }),
    createdAt: parsed.createdAt,
    ...(parsed.settledAt === undefined ? {} : { settledAt: parsed.settledAt }),
  });
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

  const getBinding: CapabilityLifecycleStore["getBinding"] = async (capabilityId) =>
    decodeBinding(db.prepare("SELECT * FROM capability_bindings WHERE capability_id = ?").get(capabilityId));

  const assertRevision = (revision: CapabilityLifecycleRevision): CapabilityLifecycleRevision => {
    const parsed = normalizeLifecycleRevision(revision);
    if (parsed.revision.capabilityId !== parsed.reference.capabilityId)
      throw new Error("Capability revision bundle and reference identify different capabilities");
    const expected = capabilityRevisionRef(parsed.revision);
    if (!sameCapabilityRevisionRef(expected, parsed.reference))
      throw new Error("Capability revision reference does not match its exact bundle");
    for (const reference of parsed.revision.evidenceRefs) options.assertStoredReference(reference);
    return parsed;
  };

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
    db.prepare(
      `INSERT INTO capability_revisions(
        capability_revision_id, capability_id, predecessor_revision_id, revision_json, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      revision.reference.capabilityRevisionId,
      revision.reference.capabilityId,
      revision.revision.predecessorRevisionId ?? null,
      encoded,
      revision.createdAt,
    );
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
        return current;
      }
      db.prepare(
        `INSERT INTO capability_bindings(
          capability_id, revision_json, scope_json, activation_mode, state, binding_revision, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        binding.capabilityId,
        canonicalJson(binding.revision),
        canonicalJson(binding.scope),
        binding.activationMode,
        binding.state,
        binding.revisionNumber,
        binding.updatedAt,
      );
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

  const listRevisions: CapabilityLifecycleStore["listRevisions"] = async (capabilityId) =>
    Object.freeze(
      db
        .prepare(
          "SELECT revision_json FROM capability_revisions WHERE capability_id = ? ORDER BY created_at, capability_revision_id",
        )
        .all(capabilityId)
        .map((row) => {
          const value = decodeRevision(row);
          if (!value) throw new Error("Capability revision row disappeared during decoding");
          return value;
        }),
    );

  const listBindings: CapabilityLifecycleStore["listBindings"] = async () =>
    Object.freeze(
      db
        .prepare("SELECT * FROM capability_bindings ORDER BY updated_at DESC, capability_id")
        .all()
        .map((row) => {
          const value = decodeBinding(row);
          if (!value) throw new Error("Capability binding row disappeared during decoding");
          return value;
        }),
    );

  const listEligibleBindings: CapabilityLifecycleStore["listEligibleBindings"] = async (request) =>
    Object.freeze(
      (await listBindings()).filter(
        (binding) =>
          binding.state === "active" &&
          (binding.scope.kind === "global" ||
            (binding.scope.kind === "project" &&
              binding.scope.project.projectId === request.project.projectId &&
              binding.scope.project.root === request.project.root) ||
            (binding.scope.kind === "session" && binding.scope.sessionId === request.sessionId)),
      ),
    );

  const updateBinding: CapabilityLifecycleStore["updateBinding"] = async (request) =>
    options.database.transaction(() => {
      const current = decodeBinding(
        db.prepare("SELECT * FROM capability_bindings WHERE capability_id = ?").get(request.capabilityId),
      );
      if (!current) throw new Error(`Unknown capability binding ${request.capabilityId}`);
      if (current.revisionNumber !== request.expectedRevisionNumber)
        return Object.freeze({ status: "stale" as const, binding: current });
      const next = CapabilityBindingSchema.parse({
        ...current,
        ...(request.revision ? { revision: request.revision } : {}),
        ...(request.scope ? { scope: request.scope } : {}),
        ...(request.activationMode ? { activationMode: request.activationMode } : {}),
        ...(request.state ? { state: request.state } : {}),
        revisionNumber: current.revisionNumber + 1,
        updatedAt: options.now(),
      });
      if (!awaitableRevisionExists(db, next.revision))
        throw new Error(`Unknown capability revision ${next.revision.capabilityRevisionId}`);
      const result = db
        .prepare(
          `UPDATE capability_bindings SET
            revision_json = ?, scope_json = ?, activation_mode = ?, state = ?,
            binding_revision = ?, updated_at = ?
           WHERE capability_id = ? AND binding_revision = ?`,
        )
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
      return Object.freeze({ status: "updated" as const, binding: next });
    });

  const addFeedback: CapabilityLifecycleStore["addFeedback"] = async (input) => {
    const feedback = CapabilityFeedbackSchema.parse(input);
    for (const reference of feedback.evidenceRefs) options.assertStoredReference(reference);
    return options.database.transaction(() => {
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
      if (!awaitableRevisionExists(db, feedback.revision))
        throw new Error(`Unknown capability revision ${feedback.revision.capabilityRevisionId}`);
      db.prepare(
        `INSERT INTO capability_feedback(
          feedback_id, capability_id, revision_json, feedback_json, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        feedback.feedbackId,
        feedback.capabilityId,
        canonicalJson(feedback.revision),
        canonicalJson(feedback),
        feedback.createdAt,
      );
      return feedback;
    });
  };

  const listFeedback: CapabilityLifecycleStore["listFeedback"] = async (capabilityId) =>
    Object.freeze(
      db
        .prepare(
          "SELECT feedback_json FROM capability_feedback WHERE capability_id = ? ORDER BY created_at DESC, feedback_id DESC",
        )
        .all(capabilityId)
        .map((row) => CapabilityFeedbackSchema.parse(parseJson(requiredString(row, "feedback_json")))),
    );

  const createGate: CapabilityLifecycleStore["createGate"] = async (input) => {
    const gate = normalizeGate(input);
    if (gate.status !== "pending") throw new Error("A new capability gate must be pending");
    return options.database.transaction(() => {
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
      if (!awaitableRevisionExists(db, gate.revision))
        throw new Error(`Unknown capability revision ${gate.revision.capabilityRevisionId}`);
      db.prepare(
        `INSERT INTO capability_gate_requests(
          gate_request_id, capability_id, revision_json, request_json, status, created_at, settled_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        gate.gateRequestId,
        gate.capabilityId,
        canonicalJson(gate.revision),
        canonicalJson(gate),
        gate.status,
        gate.createdAt,
      );
      return gate;
    });
  };

  const getGate: CapabilityLifecycleStore["getGate"] = async (gateRequestId) =>
    decodeGate(
      db
        .prepare("SELECT request_json FROM capability_gate_requests WHERE gate_request_id = ?")
        .get(gateRequestId),
    );

  const listPendingGates: CapabilityLifecycleStore["listPendingGates"] = async () =>
    Object.freeze(
      db
        .prepare(
          "SELECT request_json FROM capability_gate_requests WHERE status = 'pending' ORDER BY created_at, gate_request_id",
        )
        .all()
        .map((row) => normalizeGate(parseJson(requiredString(row, "request_json")))),
    );

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
      const settled = normalizeGate({
        ...current,
        status: request.status,
        ...(request.instruction ? { instruction: request.instruction } : {}),
        settledAt: options.now(),
      });
      db.prepare(
        `UPDATE capability_gate_requests
         SET request_json = ?, status = ?, settled_at = ?
         WHERE gate_request_id = ? AND status = 'pending'`,
      ).run(canonicalJson(settled), settled.status, settled.settledAt ?? null, settled.gateRequestId);
      return settled;
    });

  const isCutoverComplete: CapabilityLifecycleStore["isCutoverComplete"] = async () =>
    db.prepare("SELECT 1 FROM capability_learning_cutovers WHERE cutover_version = 1").get() !== undefined;

  const completeCutover: CapabilityLifecycleStore["completeCutover"] = async () =>
    options.database.transaction(() => {
      if (db.prepare("SELECT 1 FROM capability_learning_cutovers WHERE cutover_version = 1").get())
        return false;
      db.prepare("INSERT INTO capability_learning_cutovers(cutover_version, completed_at) VALUES (1, ?)").run(
        options.now(),
      );
      db.prepare(
        `UPDATE jobs
         SET status = 'cancelled', completed_at = ?, lease_token = NULL, lease_until = NULL
         WHERE status IN ('scheduled', 'running')
           AND kind IN ('runtime.author_revision', 'runtime.preflight', 'runtime.outcome_judge')`,
      ).run(options.now());
      db.prepare("DELETE FROM active_project_adjustments").run();
      return true;
    });

  return Object.freeze({
    create,
    getDefinition,
    listDefinitions,
    getRevision,
    listRevisions,
    addRevision,
    getBinding,
    listBindings,
    listEligibleBindings,
    updateBinding,
    addFeedback,
    listFeedback,
    createGate,
    getGate,
    listPendingGates,
    settleGate,
    completeCutover,
    isCutoverComplete,
  });
}

function awaitableRevisionExists(
  db: WorkspaceDatabase["connection"],
  reference: import("@noesis/domain").CapabilityRevisionRef,
): boolean {
  const row = db
    .prepare(
      "SELECT revision_json FROM capability_revisions WHERE capability_revision_id = ? AND capability_id = ?",
    )
    .get(reference.capabilityRevisionId, reference.capabilityId);
  const revision = decodeRevision(row);
  return revision !== undefined && sameCapabilityRevisionRef(revision.reference, reference);
}
