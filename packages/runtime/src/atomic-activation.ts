import { basename } from "node:path";
import {
  CapabilityPinMetadataSchema,
  CapabilityVetoMetadataSchema,
  type CapabilityControlReadModel,
} from "@noesis/capabilities";
import {
  CapabilityRevisionRefSchema,
  CapabilityRevisionSchema,
  ExperimentSchema,
  FileRevisionRefSchema,
  PreflightPlanSchema,
  PreflightReportSchema,
  canonicalJson,
  capabilityRevisionRef,
  preflightReportMatchesPlan,
  sameCapabilityRevisionRef,
  sha256,
  type CapabilityRevision,
  type CapabilityRevisionRef,
  type FileRevisionRef,
} from "@noesis/domain";
import type {
  ActivationEvidenceBinding,
  ActivationOperationRecord,
  NoesisWorkspaceStore,
  TurnActivationPinRecord,
} from "@noesis/workspace";
import type { ProtectedWorkspaceRuntime } from "../../workspace/src/protected-runtime.ts";
import { z } from "zod";
import type { PreflightActivationHandoff } from "./coordinator-contracts.ts";
import {
  decidePreflightActivation,
  derivePermissionExpansion,
  type ActivationAutonomyPolicy,
  type ActivationRisk,
  type PreflightPolicyDecision,
} from "./preflight-policy.ts";

const CandidateManifestBindingSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("learning_candidate_revision"),
  brief: z.object({ experimentId: z.string().min(1) }).passthrough(),
  revision: CapabilityRevisionSchema,
  revisionRef: CapabilityRevisionRefSchema,
  researchRefs: z
    .object({
      experiment: z.object({ rowId: z.string().min(1) }).passthrough(),
    })
    .passthrough(),
});
const AutonomyPolicySchema = z.strictObject({
  riskLevel: z.enum(["off", "low", "medium", "high"]),
  approval: z.enum(["authority_expansion", "all_changes"]),
  pins: z.literal("respect"),
  vetoes: z.literal("respect"),
});
const CapabilityControlReadModelSchema = z.strictObject({
  capabilityId: z.string().min(1),
  pin: CapabilityPinMetadataSchema.nullable(),
  vetoes: z.array(CapabilityVetoMetadataSchema),
});

export interface ActivationCandidateResolver {
  readonly resolve: (reference: CapabilityRevisionRef) => Promise<CapabilityRevision | undefined>;
  readonly lineage: (reference: CapabilityRevisionRef) => Promise<readonly CapabilityRevisionRef[]>;
  readonly controls: (capabilityId: string) => Promise<CapabilityControlReadModel | undefined>;
}

export interface AtomicActivationControllerOptions {
  readonly workspace: NoesisWorkspaceStore;
  readonly protectedRuntime: ProtectedWorkspaceRuntime;
  readonly candidates: ActivationCandidateResolver;
  readonly autonomy: ActivationAutonomyPolicy;
  readonly classifyRisk?: (input: {
    readonly scope: string;
    readonly candidate: CapabilityRevision;
    readonly handoff: PreflightActivationHandoff;
  }) => ActivationRisk;
  readonly actorId?: string;
}

export type ActivationAttemptResult =
  | {
      readonly ok: true;
      readonly status: "blocked";
      readonly operation: ActivationOperationRecord;
      readonly policy: PreflightPolicyDecision;
    }
  | {
      readonly ok: true;
      readonly status: "pending_approval";
      readonly operation: ActivationOperationRecord;
      readonly policy: PreflightPolicyDecision;
      readonly approvalId: string;
      readonly bindingDigest: string;
    }
  | {
      readonly ok: true;
      readonly status: "activated";
      readonly operation: ActivationOperationRecord;
      readonly policy: PreflightPolicyDecision;
    }
  | {
      readonly ok: true;
      readonly status: "rejected";
      readonly operation: ActivationOperationRecord;
    }
  | {
      readonly ok: false;
      readonly code: "validation_failed" | "authority_denied" | "activation_conflict";
      readonly message: string;
    };

export interface AtomicActivationController {
  readonly activateFromPreflight: (handoff: PreflightActivationHandoff) => Promise<ActivationAttemptResult>;
  readonly approve: (request: {
    readonly approvalId: string;
    readonly operationId: string;
    readonly bindingDigest: string;
  }) => Promise<ActivationAttemptResult>;
  readonly reject: (request: {
    readonly approvalId: string;
    readonly operationId: string;
    readonly bindingDigest: string;
  }) => Promise<ActivationAttemptResult>;
  readonly getOperation: (operationId: string) => Promise<ActivationOperationRecord | undefined>;
  readonly pinTurnActivation: (sessionId: string, turnId: string) => Promise<TurnActivationPinRecord>;
}

interface ValidatedActivationInput {
  readonly binding: ActivationEvidenceBinding;
  readonly candidate: CapabilityRevision;
  readonly baseline: CapabilityRevision;
  readonly lineage: readonly CapabilityRevisionRef[];
  readonly controls: CapabilityControlReadModel;
  readonly controlsValid: boolean;
  readonly identityBound: boolean;
  readonly scopeBound: boolean;
  readonly allRailsPassed: boolean;
}

const emptyControls = (capabilityId: string): CapabilityControlReadModel =>
  Object.freeze({ capabilityId, pin: null, vetoes: Object.freeze([]) });

function exactFileRef(left: FileRevisionRef, right: FileRevisionRef): boolean {
  return (
    left.revisionId === right.revisionId &&
    left.workingPath === right.workingPath &&
    left.snapshotPath === right.snapshotPath &&
    left.contentDigest === right.contentDigest
  );
}

function parsedCapabilityRevision(value: unknown): CapabilityRevision {
  const parsed = CapabilityRevisionSchema.parse(value);
  const { predecessorRevisionId, dependencyLock, ...required } = parsed;
  return Object.freeze({
    ...required,
    ...(predecessorRevisionId === undefined ? {} : { predecessorRevisionId }),
    ...(dependencyLock === undefined ? {} : { dependencyLock }),
  });
}

function safeSlotName(value: string): string {
  const normalized = value.replaceAll(/[^A-Za-z0-9._-]/gu, "-");
  if (!normalized) throw new Error("Activation definition slot has no safe name");
  return normalized;
}

function completeDefinitionSlots(
  manifestRevision: FileRevisionRef,
  revision: CapabilityRevision,
): readonly { readonly slotKey: string; readonly sourceRevision: FileRevisionRef }[] {
  const expectedToolIds = revision.tools.map((tool) => tool.revisionId);
  if (
    expectedToolIds.length !== revision.toolset.toolRevisionIds.length ||
    !expectedToolIds.every((revisionId, index) => revision.toolset.toolRevisionIds[index] === revisionId)
  )
    throw new Error("Capability toolset does not bind the complete ordered tool revision set");
  const slots = [
    { slotKey: "manifest", sourceRevision: manifestRevision },
    ...revision.promptModules.map((sourceRevision, index) => ({
      slotKey: `prompt-${index}`,
      sourceRevision,
    })),
    ...revision.skills.map((sourceRevision, index) => ({ slotKey: `skill-${index}`, sourceRevision })),
    ...revision.tools.map((sourceRevision, index) => ({ slotKey: `tool-${index}`, sourceRevision })),
    { slotKey: "router", sourceRevision: revision.toolset.routerRevision },
    ...(revision.dependencyLock
      ? [{ slotKey: "dependency-lock", sourceRevision: revision.dependencyLock }]
      : []),
  ];
  if (revision.promptModules.length === 0 || revision.skills.length === 0)
    throw new Error("Capability revision is missing a prompt or skill definition");
  const identities = new Set<string>();
  for (const { sourceRevision } of slots) {
    FileRevisionRefSchema.parse(sourceRevision);
    const identity = `${sourceRevision.revisionId}:${sourceRevision.contentDigest}`;
    if (identities.has(identity))
      throw new Error("Complete capability materialization contains a duplicated revision identity");
    identities.add(identity);
  }
  return Object.freeze(slots.map((slot) => Object.freeze(slot)));
}

function operationIdentity(
  binding: ActivationEvidenceBinding,
  policyDigest: string,
  expectedActivation: { readonly activationId: string | null; readonly revision: number },
): {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly activationId: string;
  readonly approvalId: string;
} {
  const digest = sha256(canonicalJson({ binding, policyDigest, expectedActivation }));
  return Object.freeze({
    operationId: `activation_operation_${digest.slice(0, 32)}`,
    idempotencyKey: `activate:${binding.candidateDigest}:${binding.preflightDigest}:${policyDigest}:${expectedActivation.revision}:${expectedActivation.activationId ?? "none"}`,
    activationId: `activation_${digest.slice(0, 32)}`,
    approvalId: `activation_approval_${digest.slice(0, 32)}`,
  });
}

function classifyFailure(error: unknown): ActivationAttemptResult {
  const message = error instanceof Error ? error.message : String(error);
  return Object.freeze({
    ok: false,
    code: /CAS conflict|snapshot changed/iu.test(message) ? "activation_conflict" : "validation_failed",
    message,
  });
}

function recoveredPolicy(operation: ActivationOperationRecord): PreflightPolicyDecision {
  return Object.freeze({
    outcome: operation.decision,
    reasonCodes: z.array(z.string()).parse(operation.policySnapshot["reasonCodes"]),
    risk: z.enum(["low", "medium", "high"]).parse(operation.policySnapshot["risk"]),
    permissionExpansion: z
      .object({
        addedEffects: z.array(z.string()),
        widenedResources: z.array(z.string()),
        addedCredentialRefs: z.array(z.string()),
        expandsAuthority: z.boolean(),
        matchesDeclaredDelta: z.boolean(),
      })
      .parse(operation.policySnapshot["permissionExpansion"]),
    snapshotDigest: operation.policyDigest,
  });
}

export function createAtomicActivationController(
  options: AtomicActivationControllerOptions,
): AtomicActivationController {
  const autonomy = Object.freeze(AutonomyPolicySchema.parse(options.autonomy));
  const actorId = z
    .string()
    .min(1)
    .parse(options.actorId ?? "protected-activation-user");
  const classifyRisk = options.classifyRisk ?? (() => "low" as const);

  const validate = async (handoff: PreflightActivationHandoff): Promise<ValidatedActivationInput> => {
    const experiment = ExperimentSchema.parse(handoff.experiment);
    const handedReport = PreflightReportSchema.parse(handoff.report);
    const candidateRef = CapabilityRevisionRefSchema.parse(handoff.candidateRevision);
    const manifestRevision = FileRevisionRefSchema.parse(handoff.manifestRevision);
    if (
      handoff.reportRef.table !== "preflight_reports" ||
      handoff.reportRef.rowId !== handedReport.preflightId
    )
      throw new Error("Preflight report reference does not identify the canonical report");
    const [freshExperiment, recordedReport, plan, candidate, baseline, manifestBytes] = await Promise.all([
      options.workspace.research.experiments.getExperiment(experiment.experimentId),
      options.workspace.research.preflights.getPreflightReport(handedReport.preflightId),
      options.workspace.research.preflights.getPreflightPlan(handedReport.planId),
      options.candidates.resolve(candidateRef),
      options.candidates.resolve(experiment.baselineRevision),
      options.workspace.reads.readRevision(manifestRevision),
    ]);
    if (!freshExperiment || !recordedReport || !plan || !candidate || !baseline)
      throw new Error("Activation handoff cannot rehydrate all authoritative pinned inputs");
    const parsedPlan = PreflightPlanSchema.parse(plan);
    if (
      canonicalJson(freshExperiment) !== canonicalJson(experiment) ||
      canonicalJson(recordedReport) !== canonicalJson(handedReport) ||
      freshExperiment.status !== "preflight" ||
      freshExperiment.preflightRef?.rowId !== handedReport.preflightId ||
      !preflightReportMatchesPlan(parsedPlan, recordedReport)
    )
      throw new Error("Activation handoff contains stale or mismatched preflight evidence");
    await Promise.all([
      options.workspace.reads.readEvidence(recordedReport.reportEvidence),
      ...parsedPlan.caseRefs.map(async (reference) => await options.workspace.reads.readEvidence(reference)),
      ...recordedReport.trialEvidence.map(
        async (reference) => await options.workspace.reads.readEvidence(reference),
      ),
      ...recordedReport.judgmentEvidence.map(
        async (reference) => await options.workspace.reads.readEvidence(reference),
      ),
    ]);
    const manifest = CandidateManifestBindingSchema.parse(
      JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(manifestBytes)),
    );
    const manifestCandidate = capabilityRevisionRef(parsedCapabilityRevision(manifest.revision));
    const freshManifestRef = freshExperiment.evidenceRefs.find(
      (reference): reference is FileRevisionRef =>
        reference.kind === "file_revision" && exactFileRef(reference, manifestRevision),
    );
    const identityBound =
      freshManifestRef !== undefined &&
      manifest.brief.experimentId === experiment.experimentId &&
      manifest.researchRefs.experiment.rowId === experiment.experimentId &&
      sameCapabilityRevisionRef(manifest.revisionRef, candidateRef) &&
      sameCapabilityRevisionRef(manifestCandidate, candidateRef) &&
      sameCapabilityRevisionRef(capabilityRevisionRef(candidate), candidateRef) &&
      sameCapabilityRevisionRef(recordedReport.candidateRevision, candidateRef) &&
      sameCapabilityRevisionRef(parsedPlan.candidateRevision, candidateRef) &&
      freshExperiment.candidateRevisions.length === 1 &&
      freshExperiment.candidateRevisions[0] !== undefined &&
      sameCapabilityRevisionRef(freshExperiment.candidateRevisions[0], candidateRef) &&
      sameCapabilityRevisionRef(capabilityRevisionRef(baseline), experiment.baselineRevision) &&
      sameCapabilityRevisionRef(recordedReport.baselineRevision, experiment.baselineRevision);
    const lineage = Object.freeze(
      (await options.candidates.lineage(candidateRef)).map((reference) =>
        CapabilityRevisionRefSchema.parse(reference),
      ),
    );
    const controls = CapabilityControlReadModelSchema.parse(
      (await options.candidates.controls(candidateRef.capabilityId)) ??
        emptyControls(candidateRef.capabilityId),
    );
    const controlMetadata = await options.workspace.definitionMetadata.getCurrent(
      "capability_control",
      candidateRef.capabilityId,
    );
    const durableControls = controlMetadata
      ? CapabilityControlReadModelSchema.parse(
          JSON.parse(
            new TextDecoder("utf8", { fatal: true }).decode(
              await options.workspace.reads.readRevision(controlMetadata.definitionRevision),
            ),
          ),
        )
      : undefined;
    const controlRefs = Object.freeze([
      ...(controls.pin ? [controls.pin.revision] : []),
      ...controls.vetoes.map((veto) => veto.rootRevision),
    ]);
    const resolvedControls = await Promise.all(
      controlRefs.map(async (reference) => await options.candidates.resolve(reference)),
    );
    const controlsValid =
      (durableControls === undefined || canonicalJson(durableControls) === canonicalJson(controls)) &&
      controlRefs.every((reference, index) => {
        const resolved = resolvedControls[index];
        return (
          resolved !== undefined && sameCapabilityRevisionRef(capabilityRevisionRef(resolved), reference)
        );
      });
    const currentActivation = await options.protectedRuntime.activations.current();
    const currentBaseline =
      currentActivation?.activeCapabilityRevisions[experiment.baselineRevision.capabilityId];
    const currentCandidateSlot = currentActivation?.activeCapabilityRevisions[candidateRef.capabilityId];
    const createsNewSlot =
      candidate.capabilityId !== baseline.capabilityId &&
      candidate.predecessorRevisionId === undefined &&
      currentCandidateSlot === undefined &&
      currentBaseline?.kind === "capability_revision" &&
      sameCapabilityRevisionRef(currentBaseline, experiment.baselineRevision);
    const scopeBound =
      candidate.capabilityId === candidateRef.capabilityId &&
      candidate.activationPolicy.scope === experiment.scope &&
      (candidate.capabilityId === baseline.capabilityId || createsNewSlot);
    const binding = Object.freeze({
      experimentId: experiment.experimentId,
      candidateRevision: candidateRef,
      manifestRevision,
      preflightId: recordedReport.preflightId,
      planId: parsedPlan.planId,
      candidateDigest: candidateRef.bundleDigest,
      manifestDigest: manifestRevision.contentDigest,
      suiteDigest: sha256(
        canonicalJson({
          caseRefs: parsedPlan.caseRefs,
          judgeVariant: parsedPlan.judgeVariant,
          runtimeVariant: parsedPlan.runtimeVariant,
          budget: parsedPlan.budget,
        }),
      ),
      preflightDigest: sha256(canonicalJson({ plan: parsedPlan, report: recordedReport })),
      reportDigest: recordedReport.reportEvidence.contentDigest,
      definitionSetDigest: sha256(
        canonicalJson(
          completeDefinitionSlots(manifestRevision, candidate).map(({ slotKey, sourceRevision }) => ({
            slotKey,
            sourceRevision,
          })),
        ),
      ),
      controlRevisionId: controlMetadata?.definitionRevision.revisionId ?? null,
      ...(experiment.sourceAdjustmentId === undefined
        ? {}
        : { sourceAdjustmentId: experiment.sourceAdjustmentId }),
    }) satisfies ActivationEvidenceBinding;
    return Object.freeze({
      binding,
      candidate,
      baseline,
      lineage,
      controls,
      controlsValid,
      identityBound,
      scopeBound,
      allRailsPassed: recordedReport.railChecks.every((rail) => rail.passed),
    });
  };

  const commitWithAuthority = async (
    operation: ActivationOperationRecord,
    policy?: PreflightPolicyDecision,
  ): Promise<ActivationAttemptResult> => {
    try {
      await options.protectedRuntime.activations.commit({
        operationId: operation.operationId,
        bindingDigest: operation.bindingDigest,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Object.freeze({
        ok: false,
        code: /CAS conflict|snapshot changed/iu.test(message) ? "activation_conflict" : "authority_denied",
        message,
      });
    }
    const committed = await options.protectedRuntime.activations.getOperation(operation.operationId);
    if (!committed || committed.status !== "committed")
      return Object.freeze({
        ok: false,
        code: "activation_conflict",
        message: "Protected activation completed without a committed operation record",
      });
    return Object.freeze({
      ok: true,
      status: "activated",
      operation: committed,
      policy:
        policy ??
        Object.freeze({
          outcome: committed.decision,
          reasonCodes: Object.freeze(["approved_exact_binding"]),
          risk: z.enum(["low", "medium", "high"]).parse(committed.policySnapshot["risk"]),
          permissionExpansion: z
            .object({
              addedEffects: z.array(z.string()),
              widenedResources: z.array(z.string()),
              addedCredentialRefs: z.array(z.string()),
              expandsAuthority: z.boolean(),
              matchesDeclaredDelta: z.boolean(),
            })
            .parse(committed.policySnapshot["permissionExpansion"]),
          snapshotDigest: committed.policyDigest,
        }),
    });
  };

  const attemptActivation = async (
    handoff: PreflightActivationHandoff,
    retriesRemaining: number,
  ): Promise<ActivationAttemptResult> => {
    try {
      const recovered = (await options.protectedRuntime.activations.listOperations(1_000)).find(
        (operation) =>
          operation.status === "committed" &&
          operation.binding.experimentId === handoff.experiment.experimentId &&
          operation.binding.preflightId === handoff.report.preflightId &&
          sameCapabilityRevisionRef(operation.binding.candidateRevision, handoff.candidateRevision),
      );
      if (recovered)
        return Object.freeze({
          ok: true,
          status: "activated",
          operation: recovered,
          policy: recoveredPolicy(recovered),
        });
      const validated = await validate(handoff);
      const permissionExpansion = derivePermissionExpansion(
        validated.baseline.permissionManifest,
        validated.candidate.permissionManifest,
        validated.candidate.requestedPermissionDelta,
      );
      const risk = z.enum(["low", "medium", "high"]).parse(
        classifyRisk({
          scope: handoff.experiment.scope,
          candidate: validated.candidate,
          handoff,
        }),
      );
      const policy = decidePreflightActivation({
        canonicalDecision: handoff.report.decision,
        candidateRevision: handoff.candidateRevision,
        candidate: validated.candidate,
        baseline: validated.baseline,
        lineage: validated.lineage,
        controls: validated.controls,
        controlsValid: validated.controlsValid,
        identityBound: validated.identityBound,
        scopeBound: validated.scopeBound,
        allRailsPassed: validated.allRailsPassed,
        risk,
        autonomy,
        permissionExpansion,
      });
      const policySnapshot = Object.freeze({
        outcome: policy.outcome,
        reasonCodes: policy.reasonCodes,
        risk,
        autonomy,
        activationPolicy: validated.candidate.activationPolicy,
        permissionExpansion,
        controls: validated.controls,
        lineage: validated.lineage,
        identityBound: validated.identityBound,
        scopeBound: validated.scopeBound,
        allRailsPassed: validated.allRailsPassed,
      });
      const policyDigest = sha256(canonicalJson(policySnapshot));
      const current = await options.protectedRuntime.activations.current();
      const expectedActivation = Object.freeze({
        activationId: current?.activationId ?? null,
        revision: current?.revision ?? 0,
      });
      const identities = operationIdentity(validated.binding, policyDigest, expectedActivation);
      const staleAttempts = (await options.protectedRuntime.activations.listOperations(1_000)).filter(
        (operation) =>
          operation.binding.experimentId === handoff.experiment.experimentId &&
          sameCapabilityRevisionRef(operation.binding.candidateRevision, handoff.candidateRevision) &&
          (operation.status === "staged" ||
            operation.status === "approved" ||
            operation.status === "pending_approval") &&
          (operation.expectedActivationRevision !== expectedActivation.revision ||
            operation.previousActivationId !== expectedActivation.activationId),
      );
      for (const stale of staleAttempts)
        await options.protectedRuntime.activations.supersede({
          operationId: stale.operationId,
          supersededByOperationId: identities.operationId,
        });
      const existing = await options.protectedRuntime.activations.getOperation(identities.operationId);
      if (existing) {
        if (existing.status === "committed")
          return Object.freeze({ ok: true, status: "activated", operation: existing, policy });
        if (existing.status === "blocked")
          return Object.freeze({ ok: true, status: "blocked", operation: existing, policy });
        if (existing.status === "pending_approval")
          return Object.freeze({
            ok: true,
            status: "pending_approval",
            operation: existing,
            policy,
            approvalId: existing.approvalId ?? identities.approvalId,
            bindingDigest: existing.bindingDigest,
          });
        if (existing.status === "rejected")
          return Object.freeze({ ok: true, status: "rejected", operation: existing });
        const committed = await commitWithAuthority(existing, policy);
        if (!committed.ok && committed.code === "activation_conflict" && retriesRemaining > 0)
          return await attemptActivation(handoff, retriesRemaining - 1);
        return committed;
      }
      const stagedDefinitions = [];
      if (policy.outcome !== "block") {
        for (const slot of completeDefinitionSlots(validated.binding.manifestRevision, validated.candidate)) {
          const bytes = await options.workspace.reads.readRevision(slot.sourceRevision);
          const staged = await options.workspace.stageDefinition({
            targetArea: "active",
            relativePath: `${safeSlotName(validated.binding.candidateRevision.capabilityId)}/${safeSlotName(validated.binding.candidateRevision.capabilityRevisionId)}/${safeSlotName(slot.slotKey)}-${safeSlotName(basename(slot.sourceRevision.workingPath))}`,
            bytes,
            actor: Object.freeze({ actorId: "protected-activation", kind: "system" as const }),
            reason: `AC-09 ${identities.operationId} ${slot.slotKey}`,
          });
          stagedDefinitions.push(
            Object.freeze({
              slotKey: slot.slotKey,
              stageId: staged.stageId,
              sourceRevision: slot.sourceRevision,
            }),
          );
        }
      }
      const bindingDigest = sha256(canonicalJson(validated.binding));
      const operation = await options.protectedRuntime.activations.prepare({
        operationId: identities.operationId,
        idempotencyKey: identities.idempotencyKey,
        activationId: identities.activationId,
        binding: validated.binding,
        bindingDigest,
        policySnapshot,
        policyDigest,
        decision: policy.outcome,
        expectedActivationRevision: current?.revision ?? 0,
        previousActivationId: current?.activationId ?? null,
        ...(policy.outcome === "approval_required" ? { approvalId: identities.approvalId } : {}),
        stagedDefinitions: Object.freeze(stagedDefinitions),
      });
      if (policy.outcome === "block")
        return Object.freeze({ ok: true, status: "blocked", operation, policy });
      if (policy.outcome === "approval_required")
        return Object.freeze({
          ok: true,
          status: "pending_approval",
          operation,
          policy,
          approvalId: identities.approvalId,
          bindingDigest,
        });
      const committed = await commitWithAuthority(operation, policy);
      if (!committed.ok && committed.code === "activation_conflict" && retriesRemaining > 0)
        return await attemptActivation(handoff, retriesRemaining - 1);
      return committed;
    } catch (error) {
      const failure = classifyFailure(error);
      if (!failure.ok && failure.code === "activation_conflict" && retriesRemaining > 0)
        return await attemptActivation(handoff, retriesRemaining - 1);
      return failure;
    }
  };

  const activateFromPreflight = async (
    handoff: PreflightActivationHandoff,
  ): Promise<ActivationAttemptResult> => await attemptActivation(handoff, 2);

  const approve = async (request: {
    readonly approvalId: string;
    readonly operationId: string;
    readonly bindingDigest: string;
  }): Promise<ActivationAttemptResult> => {
    try {
      const existing = await options.protectedRuntime.activations.getOperation(request.operationId);
      if (!existing) throw new Error(`Unknown activation operation ${request.operationId}`);
      if (existing.approvalId !== request.approvalId || existing.bindingDigest !== request.bindingDigest)
        throw new Error("Activation approval request does not match its exact pending binding");
      if (existing.status === "committed") return await commitWithAuthority(existing);
      if (existing.status === "rejected")
        return Object.freeze({ ok: true, status: "rejected", operation: existing });
      const current = await options.protectedRuntime.activations.current();
      if (
        existing.expectedActivationRevision !== (current?.revision ?? 0) ||
        existing.previousActivationId !== (current?.activationId ?? null)
      ) {
        await options.protectedRuntime.activations.supersede({
          operationId: existing.operationId,
          supersededByOperationId: `activation_revalidation_${sha256(
            `${existing.operationId}:${current?.revision ?? 0}:${current?.activationId ?? "none"}`,
          ).slice(0, 32)}`,
        });
        throw new Error("Activation approval is bound to a stale expected activation snapshot");
      }
      await options.protectedRuntime.activations.decideApproval({
        ...request,
        decision: "approved",
        actorId,
      });
      const approved = await options.protectedRuntime.activations.getOperation(request.operationId);
      if (!approved) throw new Error(`Activation operation ${request.operationId} disappeared`);
      return await commitWithAuthority(approved);
    } catch (error) {
      return classifyFailure(error);
    }
  };

  const reject = async (request: {
    readonly approvalId: string;
    readonly operationId: string;
    readonly bindingDigest: string;
  }): Promise<ActivationAttemptResult> => {
    try {
      const existing = await options.protectedRuntime.activations.getOperation(request.operationId);
      if (
        !existing ||
        existing.approvalId !== request.approvalId ||
        existing.bindingDigest !== request.bindingDigest
      )
        throw new Error("Activation rejection request does not match its exact pending binding");
      if (existing.status === "rejected")
        return Object.freeze({ ok: true, status: "rejected", operation: existing });
      if (existing.status === "committed") throw new Error("Committed activation cannot be rejected");
      await options.protectedRuntime.activations.decideApproval({
        ...request,
        decision: "rejected",
        actorId,
      });
      const rejected = await options.protectedRuntime.activations.getOperation(request.operationId);
      if (!rejected || rejected.status !== "rejected")
        throw new Error("Protected rejection did not persist its exact operation state");
      return Object.freeze({ ok: true, status: "rejected", operation: rejected });
    } catch (error) {
      return classifyFailure(error);
    }
  };

  return Object.freeze({
    activateFromPreflight,
    approve,
    reject,
    getOperation: options.protectedRuntime.activations.getOperation,
    pinTurnActivation: async (sessionId: string, turnId: string) =>
      await options.protectedRuntime.activations.pinTurn({ sessionId, turnId }),
  });
}
