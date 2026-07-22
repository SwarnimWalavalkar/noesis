import {
  canonicalJson,
  sameCapabilityRevisionRef,
  sha256,
  type CapabilityRevision,
  type CapabilityRevisionRef,
  type PermissionDelta,
  type PermissionManifest,
  type PreflightDecision,
} from "@noesis/domain";
import type { CapabilityControlReadModel } from "@noesis/capabilities";

export type ActivationRisk = "low" | "medium" | "high";
export type PreflightPolicyOutcome = "block" | "approval_required" | "eligible_auto_activate";

export interface ActivationAutonomyPolicy {
  readonly riskLevel: "off" | ActivationRisk;
  readonly approval: "authority_expansion" | "all_changes";
  readonly pins: "respect";
  readonly vetoes: "respect";
}

export interface DerivedPermissionExpansion extends PermissionDelta {
  readonly expandsAuthority: boolean;
  readonly matchesDeclaredDelta: boolean;
}

export interface PreflightPolicyInput {
  readonly canonicalDecision: PreflightDecision;
  readonly candidateRevision: CapabilityRevisionRef;
  readonly candidate: CapabilityRevision;
  readonly baseline: CapabilityRevision;
  readonly lineage: readonly CapabilityRevisionRef[];
  readonly controls: CapabilityControlReadModel;
  readonly controlsValid: boolean;
  readonly identityBound: boolean;
  readonly scopeBound: boolean;
  readonly allRailsPassed: boolean;
  readonly risk: ActivationRisk;
  readonly autonomy: ActivationAutonomyPolicy;
  readonly permissionExpansion: DerivedPermissionExpansion;
}

export interface PreflightPolicyDecision {
  readonly outcome: PreflightPolicyOutcome;
  readonly reasonCodes: readonly string[];
  readonly risk: ActivationRisk;
  readonly permissionExpansion: DerivedPermissionExpansion;
  readonly snapshotDigest: string;
}

const uniqueSorted = (values: readonly string[]): readonly string[] =>
  Object.freeze([...new Set(values)].sort());

const difference = (next: readonly string[], previous: readonly string[]): readonly string[] => {
  const present = new Set(previous);
  return uniqueSorted(next.filter((value) => !present.has(value)));
};

const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
  const a = uniqueSorted(left);
  const b = uniqueSorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

/**
 * Conservatively derives authority expansion from the complete baseline and candidate manifests.
 * A resource-pattern change is treated as expansion unless the exact pattern was already authorized.
 */
export function derivePermissionExpansion(
  baseline: PermissionManifest,
  candidate: PermissionManifest,
  declared: PermissionDelta,
): DerivedPermissionExpansion {
  const addedEffects = difference(candidate.effects, baseline.effects);
  const widenedResources = difference(candidate.resourcePatterns, baseline.resourcePatterns);
  const addedCredentialRefs = difference(candidate.credentialRefs, baseline.credentialRefs);
  return Object.freeze({
    addedEffects,
    widenedResources,
    addedCredentialRefs,
    expandsAuthority:
      addedEffects.length > 0 || widenedResources.length > 0 || addedCredentialRefs.length > 0,
    matchesDeclaredDelta:
      sameSet(addedEffects, declared.addedEffects) &&
      sameSet(widenedResources, declared.widenedResources) &&
      sameSet(addedCredentialRefs, declared.addedCredentialRefs),
  });
}

const riskRank: Readonly<Record<ActivationRisk, number>> = Object.freeze({ low: 1, medium: 2, high: 3 });

function controlIdentityIsStale(
  control: CapabilityRevisionRef,
  lineage: readonly CapabilityRevisionRef[],
): boolean {
  return lineage.some(
    (revision) =>
      revision.capabilityId === control.capabilityId &&
      revision.capabilityRevisionId === control.capabilityRevisionId &&
      !sameCapabilityRevisionRef(revision, control),
  );
}

function frozenDecision(
  outcome: PreflightPolicyOutcome,
  reasonCodes: readonly string[],
  input: PreflightPolicyInput,
): PreflightPolicyDecision {
  const snapshot = Object.freeze({
    outcome,
    reasonCodes: Object.freeze([...reasonCodes]),
    risk: input.risk,
    permissionExpansion: input.permissionExpansion,
  });
  return Object.freeze({ ...snapshot, snapshotDigest: sha256(canonicalJson(snapshot)) });
}

/** Pure protected-policy interpretation. It has no persistence or authority handles. */
export function decidePreflightActivation(input: PreflightPolicyInput): PreflightPolicyDecision {
  const blockReasons: string[] = [];
  if (input.canonicalDecision === "block" || input.canonicalDecision === "inconclusive")
    blockReasons.push(`preflight_${input.canonicalDecision}`);
  if (!input.identityBound) blockReasons.push("identity_mismatch");
  if (!input.scopeBound) blockReasons.push("scope_mismatch");
  if (!input.allRailsPassed) blockReasons.push("protected_rail_failed");
  if (!input.permissionExpansion.matchesDeclaredDelta) blockReasons.push("permission_delta_mismatch");
  if (!input.controlsValid) blockReasons.push("control_identity_mismatch");
  if (input.autonomy.riskLevel === "off") blockReasons.push("autonomy_disabled");
  if (
    input.lineage.length === 0 ||
    !input.lineage.some((revision) => sameCapabilityRevisionRef(revision, input.candidateRevision))
  )
    blockReasons.push("candidate_lineage_mismatch");
  if (input.controls.capabilityId !== input.candidateRevision.capabilityId)
    blockReasons.push("control_scope_mismatch");
  const pin = input.controls.pin;
  if (pin) {
    if (controlIdentityIsStale(pin.revision, input.lineage)) blockReasons.push("pin_identity_mismatch");
    if (!sameCapabilityRevisionRef(pin.revision, input.candidateRevision))
      blockReasons.push("pinned_revision");
  }
  for (const veto of input.controls.vetoes) {
    if (controlIdentityIsStale(veto.rootRevision, input.lineage)) blockReasons.push("veto_identity_mismatch");
    if (input.lineage.some((revision) => sameCapabilityRevisionRef(revision, veto.rootRevision)))
      blockReasons.push("vetoed_lineage");
  }
  if (blockReasons.length > 0) return frozenDecision("block", uniqueSorted(blockReasons), input);

  const approvalReasons: string[] = [];
  if (input.canonicalDecision === "approval_required") approvalReasons.push("preflight_approval_required");
  if (input.candidate.activationPolicy.mode === "approval_required") approvalReasons.push("candidate_policy");
  if (input.permissionExpansion.expandsAuthority) approvalReasons.push("authority_expansion");
  if (input.autonomy.approval === "all_changes") approvalReasons.push("all_changes_require_approval");
  if (input.autonomy.riskLevel !== "off" && riskRank[input.risk] > riskRank[input.autonomy.riskLevel])
    approvalReasons.push("risk_exceeds_autonomy");
  if (approvalReasons.length > 0)
    return frozenDecision("approval_required", uniqueSorted(approvalReasons), input);
  return frozenDecision("eligible_auto_activate", Object.freeze(["low_risk_pass"]), input);
}
