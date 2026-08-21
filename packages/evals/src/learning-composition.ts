import {
  createConditionalObject,
  type CapabilityRevision,
  type CapabilityRevisionRef,
  capabilityRevisionRef,
  err,
  type EvidenceRef,
  type Experiment,
  ok,
  type Result,
  sameCapabilityRevisionRef,
} from "@noesis/domain";
import type {
  DynamicEvaluationConfig,
  DynamicPreflightInput,
  EvaluationCase,
  EvaluationCriterionSet,
  ProtectedEvaluationSuiteRevision,
} from "./dynamic-contracts.ts";
export interface LearningAuthoredCandidate {
  readonly brief: {
    readonly experimentId: string;
    readonly hypothesis: string;
    readonly scope: string;
    readonly baselineRevision: CapabilityRevisionRef;
    readonly sourceCases: readonly {
      readonly caseId: string;
      readonly scope: string;
      readonly input: string;
      readonly expectedBehavior: string;
      readonly evidenceRefs: readonly EvidenceRef[];
    }[];
  };
  readonly revision: CapabilityRevision;
  readonly revisionRef: CapabilityRevisionRef;
  readonly experiment: Experiment;
}
export interface LearningPreflightCompositionRequest {
  readonly preflightId: string;
  readonly planId: string;
  readonly authored: LearningAuthoredCandidate;
  readonly baselineRevision: CapabilityRevision;
  readonly criteria: EvaluationCriterionSet;
  readonly protectedSuite: ProtectedEvaluationSuiteRevision;
  readonly budget: DynamicPreflightInput["budget"];
  readonly config: DynamicEvaluationConfig;
  readonly signal?: AbortSignal;
}
export interface LearningPreflightCompositionFailure {
  readonly code: "identity_mismatch" | "invalid_source_cases";
  readonly message: string;
}
export type LearningPreflightCompositionResult = Result<
  DynamicPreflightInput,
  LearningPreflightCompositionFailure
>;
function identityFailure(message: string): LearningPreflightCompositionResult {
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return err(Object.freeze({ code: "identity_mismatch" as const, message }));
}
function sourceCaseFailure(message: string): LearningPreflightCompositionResult {
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return err(Object.freeze({ code: "invalid_source_cases" as const, message }));
}
/**
 * Composes the immutable AC-05 output with AC-06 inputs. AC-08 owns scheduling and lifecycle
 * transitions around this factory; this contract neither activates a revision nor mutates an experiment.
 */
export function createLearningPreflightInput(
  request: LearningPreflightCompositionRequest,
): LearningPreflightCompositionResult {
  const { authored } = request;
  if (authored.experiment.status !== "authoring" && authored.experiment.status !== "preflight")
    return identityFailure("Learning handoff requires an authoring or preflight experiment");
  if (
    authored.brief.experimentId !== authored.experiment.experimentId ||
    authored.brief.scope !== authored.experiment.scope ||
    authored.brief.hypothesis !== authored.experiment.hypothesis
  )
    return identityFailure("Experiment brief identity does not match the durable experiment");
  if (
    !sameCapabilityRevisionRef(authored.brief.baselineRevision, authored.experiment.baselineRevision) ||
    !sameCapabilityRevisionRef(
      authored.brief.baselineRevision,
      capabilityRevisionRef(request.baselineRevision),
    )
  )
    return identityFailure("Baseline CapabilityRevisionRef does not match complete materialized bytes");
  if (
    !sameCapabilityRevisionRef(authored.revisionRef, capabilityRevisionRef(authored.revision)) ||
    authored.experiment.candidateRevisions.length !== 1 ||
    authored.experiment.candidateRevisions[0] === undefined ||
    !sameCapabilityRevisionRef(authored.experiment.candidateRevisions[0], authored.revisionRef)
  )
    return identityFailure(
      "Candidate CapabilityRevisionRef does not match the authored experiment and bytes",
    );
  if (
    authored.brief.baselineRevision.capabilityId !== authored.revisionRef.capabilityId &&
    authored.revision.predecessorRevisionId !== undefined
  )
    return identityFailure(
      "A candidate may cross capability identity only when it creates a new slot without a predecessor",
    );
  if (!sameCapabilityRevisionRef(request.criteria.candidateRevision, authored.revisionRef))
    return identityFailure("Criterion snapshot is not pinned to the authored candidate revision");
  if (request.criteria.scope !== authored.brief.scope)
    return identityFailure("Criterion snapshot scope does not match the learning experiment");
  const sourceDefinitions = authored.revision.sourceEvaluationDefinitions;
  const sourceCases = authored.brief.sourceCases;
  if (sourceCases.length === 0) return sourceCaseFailure("Learning handoff has no motivating source cases");
  if (sourceDefinitions.length !== 1 && sourceDefinitions.length !== sourceCases.length)
    return sourceCaseFailure(
      "Source evaluation definitions must be one shared suite or map one-to-one to source cases",
    );
  if (new Set(sourceCases.map((sourceCase) => sourceCase.caseId)).size !== sourceCases.length)
    return sourceCaseFailure("Learning handoff source case IDs must be unique");
  if (
    sourceCases.some(
      (sourceCase) => sourceCase.scope !== authored.brief.scope || sourceCase.evidenceRefs.length === 0,
    )
  )
    return sourceCaseFailure("Learning handoff source cases require matching scope and evidence");
  const evaluationCases: EvaluationCase[] = [];
  for (const [index, sourceCase] of sourceCases.entries()) {
    const definitionRevision =
      sourceDefinitions.length === 1 ? sourceDefinitions[0] : sourceDefinitions[index];
    if (!definitionRevision)
      return sourceCaseFailure("Validated source evaluation definition mapping became incomplete");
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    evaluationCases.push(
      Object.freeze({
        caseId: sourceCase.caseId,
        kind: "source" as const,
        owner: "candidate_author" as const,
        instruction: sourceCase.expectedBehavior,
        input: sourceCase.input,
        evidenceRefs: Object.freeze(
          sourceCase.evidenceRefs.map((reference) => Object.freeze({ ...reference })),
        ),
        definitionRevision: Object.freeze({ ...definitionRevision }),
        criterionRefs: Object.freeze([]),
      }),
    );
  }
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return ok(
    Object.freeze(
      createConditionalObject({
        preflightId: request.preflightId,
        experimentId: authored.experiment.experimentId,
        planId: request.planId,
        scope: authored.brief.scope,
        behaviorObjective: authored.brief.hypothesis,
        baseline: Object.freeze({
          ref: Object.freeze({ ...authored.brief.baselineRevision }),
          revision: request.baselineRevision,
        }),
        candidate: Object.freeze({
          ref: Object.freeze({ ...authored.revisionRef }),
          revision: authored.revision,
        }),
        criteria: request.criteria,
        sourceCases: Object.freeze(evaluationCases),
        protectedSuite: Object.freeze({
          ...request.protectedSuite,
          definitionRevision: Object.freeze({ ...request.protectedSuite.definitionRevision }),
          cases: Object.freeze(
            request.protectedSuite.cases.map((evaluationCase) =>
              Object.freeze(
                createConditionalObject({
                  ...evaluationCase,
                  evidenceRefs: Object.freeze(
                    evaluationCase.evidenceRefs.map((reference) => Object.freeze({ ...reference })),
                  ),
                } as const)
                  .addOptional(
                    evaluationCase.definitionRevision
                      ? {
                          definitionRevision: Object.freeze({ ...evaluationCase.definitionRevision }),
                        }
                      : undefined,
                  )
                  .add({
                    criterionRefs: Object.freeze(
                      evaluationCase.criterionRefs.map((criterion) => Object.freeze({ ...criterion })),
                    ),
                  } as const)
                  .finish(),
              ),
            ),
          ),
        }),
        budget: Object.freeze({ ...request.budget }),
        config: request.config,
      } as const)
        .addOptional(request.signal ? { signal: request.signal } : undefined)
        .finish(),
    ),
  );
}
