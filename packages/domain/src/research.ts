// SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
// Some names are dropped tables (working adjustments, experiments, feedback signals, preflight,
// evaluations, activation pointers). Stored provenance and job references may still cite them, and
// those references must keep decoding and keep failing closed when resolved.
export const DATABASE_TABLES = [
  "sessions",
  "messages",
  "tool_calls",
  "outcomes",
  "jobs",
  "working_adjustments",
  "experiments",
  "experiment_trials",
  "feedback_signals",
  "experiment_observations",
  "experiment_research_runs",
  "experiment_outcomes",
  "successor_lineage_inputs",
  "preflight_plans",
  "preflight_reports",
  "evaluations",
  "activation_pointers",
  "search_configuration",
  "activity_log",
  "file_revisions",
  "capabilities",
  "capability_revisions",
  "capability_bindings",
  "capability_feedback",
  "capability_gate_requests",
] as const;

export type DatabaseTable = (typeof DATABASE_TABLES)[number];

export interface DatabaseRowRef<Table extends DatabaseTable = DatabaseTable> {
  readonly kind: "database_row";
  readonly table: Table;
  readonly rowId: string;
}

export interface FileRevisionRef {
  readonly kind: "file_revision";
  readonly revisionId: string;
  readonly workingPath: string;
  readonly snapshotPath: string;
  readonly contentDigest: string;
}

export type EvidenceKind = "input" | "output" | "tool_trace" | "judgment" | "report";

export interface EvidenceRevisionRef<Kind extends EvidenceKind = EvidenceKind> {
  readonly kind: "evidence_revision";
  readonly revisionId: string;
  readonly workingPath: string;
  readonly snapshotPath: string;
  readonly contentDigest: string;
  readonly evidenceKind: Kind;
}

export interface ArtifactFileRef {
  readonly kind: "artifact_file";
  readonly artifactId: string;
  readonly path: string;
  readonly mediaType: string;
}

export type EvidenceRef = DatabaseRowRef | FileRevisionRef | EvidenceRevisionRef | ArtifactFileRef;

/** Host-derived identity for the canonical active directory. */
export interface ProjectRef {
  readonly projectId: string;
  readonly root: string;
}

export type ActorKind = "user" | "noesis" | "external_system" | "system";

export interface ActorRef {
  readonly actorId: string;
  readonly kind: ActorKind;
}

export interface FileRevision {
  readonly revisionId: string;
  readonly workingPath: string;
  readonly snapshotPath: string;
  readonly contentDigest: string;
  readonly predecessorRevisionId?: string;
  readonly actor: ActorRef;
  readonly reason?: string;
  readonly recordedAt: string;
}

export interface EvidenceRevision extends FileRevision {
  readonly evidenceKind: EvidenceKind;
  readonly supersedesRevisionId?: string;
}

export interface PermissionManifest {
  readonly effects: readonly string[];
  readonly resourcePatterns: readonly string[];
  readonly credentialRefs: readonly string[];
}

/**
 * One exact Capability revision. Its first effect is always the instruction file revision; it may
 * also attach one exact project Program revision.
 */
export interface CapabilityRevision {
  readonly capabilityRevisionId: string;
  readonly capabilityId: string;
  readonly predecessorRevisionId?: string;
  readonly effects: readonly CapabilityEffect[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

/** One exact instruction layer injected into the selected turn's system prompt. */
export interface CapabilityInstructionEffect {
  readonly kind: "instruction";
  readonly material: FileRevisionRef;
}

export type ProgramMode = "script" | "workflow";

/** One immutable revision of an ordinary project Program. */
export interface ProgramRevisionRef {
  readonly mode: ProgramMode;
  readonly name: string;
  readonly project: ProjectRef;
  readonly definitionRevision: FileRevisionRef;
}

export interface CapabilityProgramEffect {
  readonly kind: "program";
  readonly program: ProgramRevisionRef;
}

export type CapabilityEffect = CapabilityInstructionEffect | CapabilityProgramEffect;

/** Immutable identity for the complete Capability revision. */
export interface CapabilityRevisionRef {
  readonly kind: "capability_revision";
  readonly capabilityId: string;
  readonly capabilityRevisionId: string;
  readonly bundleDigest: string;
}

/** Stable, user-facing identity for one thing Noesis can do better. */
export interface CapabilityDefinition {
  readonly capabilityId: string;
  readonly name: string;
  readonly description: string;
  readonly applicability: string;
  readonly createdAt: string;
}

/** Immutable lifecycle metadata around one exact Capability revision. */
export interface CapabilityLifecycleRevision {
  readonly revision: CapabilityRevision;
  readonly reference: CapabilityRevisionRef;
  readonly summary: string;
  readonly rationale: string;
  readonly anticipatedEffect: string;
  readonly evidence?: CapabilityEvidenceClaim;
  readonly createdAt: string;
}

/** How a Capability did in one turn that used it, as judged by reflection on that exchange. */
export interface CapabilityOutcome {
  readonly outcomeId: string;
  readonly capabilityId: string;
  readonly capabilityRevisionId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly result: "helped" | "hurt" | "unclear";
  readonly reason: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly createdAt: string;
}

/** Counts of judged outcomes for one Capability revision. */
export interface CapabilityTrackRecord {
  readonly capabilityRevisionId: string;
  readonly helped: number;
  readonly hurt: number;
  readonly unclear: number;
}

/** The authoring model's statement of what supports a learned Capability. */
export interface CapabilityEvidenceClaim {
  readonly kind: "explicit_request" | "user_correction" | "repeated_across_sessions" | "verified_method";
  readonly quote: string;
  readonly wouldOtherwise: string;
}

export type CapabilityScope =
  | { readonly kind: "global" }
  | { readonly kind: "project"; readonly project: ProjectRef }
  | { readonly kind: "session"; readonly sessionId: string };

export type CapabilityActivationMode = "relevant" | "always";
export type CapabilityBindingState = "active" | "paused";

/** Sole operational authority for which exact revision may enter future frozen turns. */
export interface CapabilityBinding {
  readonly capabilityId: string;
  readonly revision: CapabilityRevisionRef;
  readonly scope: CapabilityScope;
  readonly activationMode: CapabilityActivationMode;
  readonly state: CapabilityBindingState;
  readonly revisionNumber: number;
  readonly updatedAt: string;
}

export type CapabilityFeedbackDisposition =
  | "positive"
  | "correction"
  | "regression"
  | "scope_change"
  | "activation_change"
  | "restore_request";

export interface CapabilityFeedback {
  readonly feedbackId: string;
  readonly capabilityId: string;
  readonly revision: CapabilityRevisionRef;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly interpretation: string;
  readonly disposition: CapabilityFeedbackDisposition;
  readonly createdAt: string;
}

export type CapabilityGateStatus = "pending" | "approved" | "denied" | "superseded";

export interface CapabilityGateRequest {
  readonly gateRequestId: string;
  readonly capabilityId: string;
  readonly revision: CapabilityRevisionRef;
  readonly expectedBindingRevision: number;
  readonly proposedScope: CapabilityScope;
  readonly proposedActivationMode: CapabilityActivationMode;
  readonly consequence: string;
  readonly status: CapabilityGateStatus;
  readonly instruction?: string;
  readonly createdAt: string;
  readonly settledAt?: string;
}

export function sameCapabilityRevisionRef(
  left: CapabilityRevisionRef,
  right: CapabilityRevisionRef,
): boolean {
  return (
    left.capabilityId === right.capabilityId &&
    left.capabilityRevisionId === right.capabilityRevisionId &&
    left.bundleDigest === right.bundleDigest
  );
}

export interface ExperimentVariantRef {
  readonly variantId: string;
  readonly axis: "role" | "retrieval" | "routing" | "evaluation" | "tool_runtime" | "activation";
  readonly configurationRefs: readonly FileRevisionRef[];
}

/**
 * A Capability revision carries exactly one instruction effect first and may attach one Program.
 * Throws when the effects break that shape.
 */
/** A Capability revision is its instruction effect, optionally followed by one Program effect. */
export function isCapabilityRevisionEffects(effects: readonly { readonly kind: string }[]): boolean {
  const [first, ...rest] = effects;
  return (
    first?.kind === "instruction" && rest.length <= 1 && rest.every((effect) => effect.kind === "program")
  );
}

export function validateCapabilityEffects(effects: readonly CapabilityEffect[]): readonly CapabilityEffect[] {
  if (!isCapabilityRevisionEffects(effects))
    throw new Error("A Capability revision is its instruction effect and at most one Program effect");
  return Object.freeze([...effects]);
}

/**
 * Project Programs keep their existing project authority, so a Capability that attaches one must
 * be bound to that same project.
 */
export function assertCapabilityEffectsEligible(input: {
  readonly effects: readonly CapabilityEffect[];
  readonly scope: CapabilityScope;
  readonly project: ProjectRef;
}): void {
  for (const effect of input.effects) {
    if (effect.kind !== "program") continue;
    const { program } = effect;
    if (program.project.projectId !== input.project.projectId || program.project.root !== input.project.root)
      throw new Error(`Capability Program ${program.name} belongs to another project`);
    if (input.scope.kind !== "project")
      throw new Error(`Capability Program ${program.name} requires a project-scoped binding`);
    if (
      input.scope.project.projectId !== program.project.projectId ||
      input.scope.project.root !== program.project.root
    )
      throw new Error(`Capability Program ${program.name} does not match its binding project`);
  }
}
