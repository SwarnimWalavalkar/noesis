import type { AutomaticLearningOrgan, ExperimentBrief } from "@noesis/learning";
import {
  createWorkspaceExperimentBriefStore,
  createWorkspaceLearningCandidateManifestStore,
} from "@noesis/learning";
import {
  createLearningPreflightInput,
  type DynamicEvaluationConfig,
  type DynamicEvaluationLaboratory,
  type EvaluationCriterionSet,
  type ProtectedEvaluationSuiteRevision,
} from "@noesis/evals";
import {
  capabilityRevisionRef,
  sameCapabilityRevisionRef,
  toJsonValue,
  type CapabilityRevision,
  type CapabilityRevisionRef,
} from "@noesis/domain";
import type { NoesisWorkspaceStore } from "@noesis/workspace";
import {
  coordinatorOperationError,
  type AuthorRevisionJobPayload,
  type CoordinatorCandidateResult,
  type CoordinatorResearchTelemetry,
  type PreflightJobPayload,
  type ReflectTurnJobPayload,
  type RuntimeCoordinatorConfig,
  type RuntimeCoordinatorResearchPort,
} from "./coordinator-contracts.ts";
import { createRuntimeCoordinator, type RuntimeCoordinator } from "./coordinator.ts";

export interface CapabilityRevisionResolverPort {
  readonly resolve: (reference: CapabilityRevisionRef) => Promise<CapabilityRevision | undefined>;
}

export interface CoordinatorPreflightPreparation {
  readonly prepare: (input: {
    readonly experimentId: string;
    readonly preflightId: string;
    readonly candidateRevision: CapabilityRevisionRef;
    readonly scope: string;
    readonly signal: AbortSignal;
  }) => Promise<{
    readonly criteria: EvaluationCriterionSet;
    readonly protectedSuite: ProtectedEvaluationSuiteRevision;
    readonly budget: {
      readonly maxCases: number;
      readonly maxAttemptsPerArm: number;
      readonly maxCost: number;
    };
    readonly config: DynamicEvaluationConfig;
  }>;
}

export interface RuntimeCoordinatorCompositionOptions {
  readonly workspace: NoesisWorkspaceStore;
  readonly learning: AutomaticLearningOrgan;
  readonly evaluation: DynamicEvaluationLaboratory;
  readonly baselineRevisions: CapabilityRevisionResolverPort;
  readonly preflightPreparation: CoordinatorPreflightPreparation;
  readonly config?: RuntimeCoordinatorConfig;
  readonly workerId?: string;
  readonly now?: () => Date;
}

function cancelled(signal: AbortSignal): void {
  if (signal.aborted)
    throw coordinatorOperationError("Coordinator research operation was cancelled", {
      code: "cancelled",
      retryable: false,
    });
}

function telemetry(values: Readonly<Record<string, unknown>>): CoordinatorResearchTelemetry {
  return Object.freeze(
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, toJsonValue(value)])),
  );
}

function exactBaseline(
  reference: CapabilityRevisionRef,
  revision: CapabilityRevision | undefined,
): CapabilityRevision {
  if (!revision || !sameCapabilityRevisionRef(reference, capabilityRevisionRef(revision)))
    throw coordinatorOperationError("Baseline revision could not be rehydrated from exact pinned bytes", {
      code: "baseline_identity_mismatch",
      retryable: false,
    });
  return revision;
}

function briefFor(brief: ExperimentBrief | undefined, experimentId: string): ExperimentBrief {
  if (!brief || brief.experimentId !== experimentId)
    throw coordinatorOperationError(`Durable experiment brief is missing for ${experimentId}`, {
      code: "experiment_brief_missing",
      retryable: false,
    });
  return brief;
}

export function createRuntimeCoordinatorComposition(
  options: RuntimeCoordinatorCompositionOptions,
): RuntimeCoordinator {
  const briefs = createWorkspaceExperimentBriefStore(options.workspace);
  const manifests = createWorkspaceLearningCandidateManifestStore(options.workspace);

  const rehydrateCandidate = async (
    experimentId: string,
  ): Promise<CoordinatorCandidateResult | undefined> => {
    const candidate = await manifests.rehydrate(experimentId);
    if (!candidate) return undefined;
    return Object.freeze({
      experimentId,
      candidateRevision: candidate.revisionRef,
      manifestRevision: candidate.manifestRevision,
      telemetry: telemetry({ recovered: true }),
    });
  };

  const research: RuntimeCoordinatorResearchPort = Object.freeze({
    reflect: async (payload: ReflectTurnJobPayload, signal: AbortSignal) => {
      cancelled(signal);
      const observed = await options.learning.observeTurn({
        turn: payload.turn,
        baselineRevision: payload.baselineRevision,
        capability: payload.capability,
        ...(payload.activeCapabilities === undefined
          ? {}
          : { activeCapabilities: payload.activeCapabilities }),
        ...(payload.userPreferences === undefined ? {} : { userPreferences: payload.userPreferences }),
        signal,
      });
      cancelled(signal);
      if (observed.status === "no_change")
        return Object.freeze({
          status: "no_change" as const,
          reason: observed.reason,
          telemetry: telemetry({
            reflectionRun: observed.reflectionRun ?? null,
            retrievalStrategyId: payload.retrievalStrategyId,
            routingStrategyId: payload.routingStrategyId,
            recurrenceCount: observed.harvest.recurrenceCount,
          }),
        });
      const experiment = Object.freeze({
        experimentId: observed.brief.experimentId,
        hypothesis: observed.brief.hypothesis,
        scope: observed.brief.scope,
        evidenceRefs: observed.brief.evidenceRefs,
        baselineRevision: observed.brief.baselineRevision,
        candidateRevisions: Object.freeze([]),
        feedbackSignalIds: observed.brief.feedbackSignalIds,
        status: "hypothesis" as const,
      });
      return Object.freeze({
        status: observed.status,
        experiment,
        hypothesisDedupeKey: observed.brief.hypothesisDedupeKey,
        telemetry: telemetry({
          reflectionRun: observed.reflectionRun,
          retrievalStrategyId: payload.retrievalStrategyId,
          routingStrategyId: payload.routingStrategyId,
          recurrenceCount: observed.harvest.recurrenceCount,
        }),
      });
    },

    author: async (payload: AuthorRevisionJobPayload, signal: AbortSignal) => {
      cancelled(signal);
      const brief = briefFor(await briefs.findByDedupeKey(payload.hypothesisDedupeKey), payload.experimentId);
      const authored = await options.learning.authorExperimentRevision({ brief, signal });
      cancelled(signal);
      const exact = await manifests.rehydrate(payload.experimentId);
      if (
        !exact ||
        !sameCapabilityRevisionRef(authored.revisionRef, exact.revisionRef) ||
        !sameCapabilityRevisionRef(capabilityRevisionRef(exact.revision), exact.revisionRef)
      )
        throw coordinatorOperationError(
          `Authored candidate manifest failed exact rehydration for ${payload.experimentId}`,
          { code: "candidate_identity_mismatch", retryable: false },
        );
      return Object.freeze({
        experimentId: payload.experimentId,
        candidateRevision: exact.revisionRef,
        manifestRevision: exact.manifestRevision,
        telemetry: telemetry({
          authorRun: authored.authorRun,
          retrievalStrategyId: payload.retrievalStrategyId,
          routingStrategyId: payload.routingStrategyId,
        }),
      });
    },

    rehydrateCandidate,

    preflight: async (payload: PreflightJobPayload, signal: AbortSignal) => {
      cancelled(signal);
      const exact = await manifests.rehydrate(payload.experimentId);
      if (!exact)
        throw coordinatorOperationError(`Candidate manifest is missing for ${payload.experimentId}`, {
          code: "candidate_manifest_missing",
          retryable: false,
        });
      const baseline = exactBaseline(
        exact.brief.baselineRevision,
        await options.baselineRevisions.resolve(exact.brief.baselineRevision),
      );
      const prepared = await options.preflightPreparation.prepare({
        experimentId: payload.experimentId,
        preflightId: payload.preflightId,
        candidateRevision: exact.revisionRef,
        scope: exact.brief.scope,
        signal,
      });
      cancelled(signal);
      const composed = createLearningPreflightInput({
        preflightId: payload.preflightId,
        planId: payload.planId,
        authored: {
          brief: exact.brief,
          revision: exact.revision,
          revisionRef: exact.revisionRef,
          experiment: exact.experiment,
        },
        baselineRevision: baseline,
        criteria: prepared.criteria,
        protectedSuite: prepared.protectedSuite,
        budget: prepared.budget,
        config: prepared.config,
        signal,
      });
      if (!composed.ok)
        throw coordinatorOperationError(composed.error.message, {
          code: composed.error.code,
          retryable: false,
        });
      const evaluated = await options.evaluation.runPreflight(composed.value);
      if (!evaluated.ok) {
        const ambiguous = /ambiguous|unknown outcome/iu.test(evaluated.error.message);
        const retryable =
          !ambiguous &&
          (evaluated.error.code === "role_failed" || evaluated.error.code === "recording_failed");
        throw coordinatorOperationError(evaluated.error.message, {
          code: `preflight_${evaluated.error.code}`,
          retryable,
          ambiguous,
        });
      }
      cancelled(signal);
      const report = await options.workspace.research.preflights.getPreflightReport(
        evaluated.value.preflightId,
      );
      if (
        !report ||
        !sameCapabilityRevisionRef(report.candidateRevision, exact.revisionRef) ||
        report.decision !== evaluated.value.decision
      )
        throw coordinatorOperationError(
          `Preflight ${payload.preflightId} is not durably bound to its candidate`,
          { code: "preflight_recording_mismatch", retryable: false },
        );
      return Object.freeze({
        experimentId: payload.experimentId,
        candidateRevision: exact.revisionRef,
        reportRef: Object.freeze({
          kind: "database_row" as const,
          table: "preflight_reports" as const,
          rowId: report.preflightId,
        }),
        decision: report.decision,
        telemetry: telemetry({
          evaluationConfig: evaluated.value.config,
          roleTelemetry: evaluated.value.roleTelemetry,
          aggregation: evaluated.value.aggregation,
          retrievalStrategyId: payload.retrievalStrategyId,
          routingStrategyId: payload.routingStrategyId,
        }),
      });
    },
  });

  return createRuntimeCoordinator({
    workspace: options.workspace,
    research,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
