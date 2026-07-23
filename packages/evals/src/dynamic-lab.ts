import { randomUUID } from "node:crypto";
import type { AgentRunRequest } from "@noesis/agent-types";
import {
  type CapabilityRevisionRef,
  canonicalJson,
  capabilityRevisionDigest,
  type EvidenceRef,
  type EvidenceRevisionRef,
  type ExperimentTrial,
  err,
  ok,
  sameCapabilityRevisionRef,
  sha256,
} from "@noesis/domain";
import {
  allReportEvidenceRefs,
  type BlindJudgment,
  BlindJudgmentSchema,
  type CaseComparison,
  type CriterionSelectionResult,
  type CriterionSnapshotPort,
  configurationEvidenceRefs,
  DynamicEvaluationConfigSchema,
  type DynamicEvaluationLaboratory,
  type DynamicEvaluationLaboratoryOptions,
  type DynamicPreflightInput,
  DynamicPreflightInputBoundarySchema,
  type DynamicPreflightReport,
  type DynamicPreflightResult,
  type EvaluationAggregationStrategy,
  type EvaluationCase,
  EvaluationCaseSchema,
  type EvaluationCriterionSet,
  EvaluationCriterionSetSchema,
  type EvaluationFailure,
  type EvaluationGeneratorStrategy,
  type EvaluationJudgeStrategy,
  type EvaluationRailResult,
  type EvaluationRoleRunRequest,
  type EvaluationRoleTrace,
  type GeneratedCaseOutput,
  GeneratedCaseOutputSchema,
  type RoleInvocationConfiguration,
  type TrialArtifact,
  TrialArtifactSchema,
  type TrialResult,
} from "./dynamic-contracts.ts";
import {
  BUILT_IN_AGGREGATION_STRATEGIES,
  BUILT_IN_GENERATOR_STRATEGIES,
  BUILT_IN_JUDGE_STRATEGIES,
  decisionFromEvaluation,
} from "./dynamic-strategies.ts";

function uniqueById<T>(values: readonly T[], select: (value: T) => string): boolean {
  return new Set(values.map(select)).size === values.length;
}

function evidenceKey(reference: EvidenceRef): string {
  return canonicalJson(reference);
}

function freezeCriterionSet(value: EvaluationCriterionSet): EvaluationCriterionSet {
  return Object.freeze({
    ...value,
    candidateRevision: Object.freeze({ ...value.candidateRevision }),
    criteria: Object.freeze(
      value.criteria.map((criterion) =>
        Object.freeze({
          ...criterion,
          evidenceRefs: Object.freeze(
            criterion.evidenceRefs.map((reference) => Object.freeze({ ...reference })),
          ),
          definitionRevision: Object.freeze({ ...criterion.definitionRevision }),
        }),
      ),
    ),
  });
}

function criterionSnapshotDigest(input: {
  readonly snapshotId: string;
  readonly scope: string;
  readonly candidateRevision: CapabilityRevisionRef;
  readonly criteria: EvaluationCriterionSet["criteria"];
  readonly sourceSnapshotDigest: string;
}): string {
  return sha256(
    canonicalJson({
      snapshotId: input.snapshotId,
      scope: input.scope,
      candidateRevision: input.candidateRevision,
      criteria: input.criteria,
      sourceSnapshotDigest: input.sourceSnapshotDigest,
    }),
  );
}

export async function selectEvaluationCriteria(
  port: CriterionSnapshotPort,
  input: {
    readonly snapshotId: string;
    readonly scope: string;
    readonly candidateRevision: CapabilityRevisionRef;
    readonly selectedCriterionIds?: readonly string[];
  },
): Promise<CriterionSelectionResult> {
  const selected = await port.snapshotRelevant(input);
  if (!selected.ok)
    return err({
      code: "criterion_selection_failed" as const,
      message: selected.error.message,
    });
  if (
    !selected.value.candidateRevision ||
    !sameCapabilityRevisionRef(selected.value.candidateRevision, input.candidateRevision)
  ) {
    return err({
      code: "criterion_selection_failed" as const,
      message: "Criterion relevance snapshot is not pinned to the requested candidate revision",
    });
  }
  const criteria = [];
  for (const criterion of selected.value.criteria) {
    if (criterion.evidenceRefs.length === 0) {
      return err({
        code: "incomplete_criterion_provenance" as const,
        message: `Criterion ${criterion.criterionId}@${criterion.revision} has no evidence citation`,
        criterionId: criterion.criterionId,
      });
    }
    criteria.push({
      criterionId: criterion.criterionId,
      revision: criterion.revision,
      scope: criterion.scope,
      evaluatorInstruction: criterion.evaluatorInstruction,
      evidenceRefs: criterion.evidenceRefs,
      definitionRevision: criterion.definitionRevision,
    });
  }
  const snapshotDigest = criterionSnapshotDigest({
    snapshotId: selected.value.snapshotId,
    scope: selected.value.scope,
    candidateRevision: selected.value.candidateRevision,
    criteria,
    sourceSnapshotDigest: selected.value.snapshotDigest,
  });
  const parsed = EvaluationCriterionSetSchema.safeParse({
    snapshotId: selected.value.snapshotId,
    scope: selected.value.scope,
    candidateRevision: selected.value.candidateRevision,
    criteria,
    sourceSnapshotDigest: selected.value.snapshotDigest,
    snapshotDigest,
  });
  if (!parsed.success)
    return err({
      code: "criterion_selection_failed" as const,
      message: `Invalid evaluation criterion snapshot: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    });
  return ok(freezeCriterionSet(parsed.data));
}

export interface CandidateAuthorCaseView {
  readonly sourceCases: readonly EvaluationCase[];
}

export function createCandidateAuthorCaseView(cases: readonly EvaluationCase[]): CandidateAuthorCaseView {
  return Object.freeze({
    sourceCases: Object.freeze(
      cases
        .filter(
          (evaluationCase) => evaluationCase.owner === "candidate_author" && evaluationCase.kind === "source",
        )
        .map((evaluationCase) => Object.freeze({ ...evaluationCase })),
    ),
  });
}

function failure(input: EvaluationFailure): DynamicPreflightResult {
  return err(Object.freeze(input));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEvaluationRoleTrace(value: unknown): value is EvaluationRoleTrace {
  return (
    value !== null &&
    typeof value === "object" &&
    "traceId" in value &&
    typeof value.traceId === "string" &&
    "role" in value &&
    typeof value.role === "string" &&
    "variant" in value &&
    value.variant !== null &&
    typeof value.variant === "object" &&
    "telemetry" in value &&
    value.telemetry !== null &&
    typeof value.telemetry === "object"
  );
}

function roleTraceFrom(error: unknown): EvaluationRoleTrace | undefined {
  if (!error || typeof error !== "object" || !("trace" in error)) return undefined;
  const trace = error.trace;
  return isEvaluationRoleTrace(trace) ? trace : undefined;
}

function classifyRoleFailure(
  error: unknown,
  stage: EvaluationFailure["stage"],
  role: NonNullable<EvaluationFailure["role"]>,
  signal: AbortSignal | undefined,
  context: Pick<EvaluationFailure, "caseId" | "arm"> = {},
): DynamicPreflightResult {
  const trace = roleTraceFrom(error);
  const codeValue = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  const code =
    signal?.aborted || codeValue === "aborted"
      ? "cancelled"
      : codeValue === "malformed_output"
        ? "malformed_role_output"
        : "role_failed";
  return failure({
    code,
    message: errorMessage(error),
    stage,
    role,
    ...context,
    ...(trace ? { trace } : {}),
  });
}

function requireStrategy<T extends { readonly strategyId: string }>(
  strategies: readonly T[],
  strategyId: string,
  kind: string,
): T {
  const strategy = strategies.find((candidate) => candidate.strategyId === strategyId);
  if (!strategy) throw new Error(`Unknown ${kind} strategy ${strategyId}`);
  return strategy;
}

function configurationIsPinned(configuration: RoleInvocationConfiguration): boolean {
  return configuration.variant.configurationRefs.some(
    (reference) =>
      reference.revisionId === configuration.promptRevision.revisionId &&
      reference.contentDigest === configuration.promptRevision.contentDigest &&
      reference.snapshotPath === configuration.promptRevision.snapshotPath &&
      reference.workingPath === configuration.promptRevision.workingPath,
  );
}

function traceConfigurationMismatch(
  configuration: RoleInvocationConfiguration,
  trace: EvaluationRoleTrace,
): string | undefined {
  if (
    trace.variant.variantId !== configuration.variant.variantId ||
    trace.variant.axis !== configuration.variant.axis
  )
    return `Role trace variant ${trace.variant.variantId} does not match pinned variant ${configuration.variant.variantId}`;
  if (
    trace.telemetry.provider !== configuration.provider ||
    trace.telemetry.model !== configuration.model ||
    trace.telemetry.reasoning !== configuration.reasoning
  )
    return `Role trace runtime ${trace.telemetry.provider}/${trace.telemetry.model}/${trace.telemetry.reasoning} does not match pinned runtime ${configuration.provider}/${configuration.model}/${configuration.reasoning}`;
  return undefined;
}

function validateCaseOwnership(input: DynamicPreflightInput): string | undefined {
  if (
    input.sourceCases.some(
      (evaluationCase) =>
        evaluationCase.kind !== "source" ||
        evaluationCase.owner !== "candidate_author" ||
        !evaluationCase.definitionRevision,
    )
  )
    return "Source cases must be immutable author-visible source definitions";
  if (
    input.protectedCases.some(
      (evaluationCase) => evaluationCase.kind !== "protected" || evaluationCase.owner !== "evaluator",
    )
  )
    return "Protected cases must remain evaluator-owned";
  if (!uniqueById([...input.sourceCases, ...input.protectedCases], (item) => item.caseId))
    return "Evaluation case IDs must be unique";
  const selectedCriteria = new Set(
    input.criteria.criteria.map((criterion) => `${criterion.criterionId}@${criterion.revision}`),
  );
  if (
    [...input.sourceCases, ...input.protectedCases].some((evaluationCase) =>
      evaluationCase.criterionRefs.some(
        (criterion) => !selectedCriteria.has(`${criterion.criterionId}@${criterion.revision}`),
      ),
    )
  )
    return "Evaluation cases may cite only selected immutable criterion revisions";
  return undefined;
}

function suiteDigest(input: DynamicPreflightInput, cases: readonly EvaluationCase[]): string {
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      behaviorObjective: input.behaviorObjective,
      baselineRevision: input.baseline.ref,
      candidateRevision: input.candidate.ref,
      criterionSnapshot: input.criteria,
      cases,
      budget: input.budget,
      config: input.config,
    }),
  );
}

function comparisonInputDigest(
  input: DynamicPreflightInput,
  evaluationCase: EvaluationCase,
  caseEvidence: EvidenceRevisionRef<"input">,
): string {
  return sha256(
    canonicalJson({
      caseId: evaluationCase.caseId,
      instruction: evaluationCase.instruction,
      input: evaluationCase.input,
      evidenceRefs: evaluationCase.evidenceRefs,
      caseSnapshotDigest: caseEvidence.contentDigest,
      budget: input.budget,
      runtimeVariant: input.config.trial.variant,
    }),
  );
}

function runRequest(input: {
  readonly runId: string;
  readonly role: AgentRunRequest["role"];
  readonly configuration: RoleInvocationConfiguration;
  readonly messages: AgentRunRequest["messages"];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly capabilityRevisions: readonly CapabilityRevisionRef[];
  readonly signal?: AbortSignal;
}): EvaluationRoleRunRequest {
  return Object.freeze({
    runId: input.runId,
    role: input.role,
    variant: input.configuration.variant,
    messages: Object.freeze(input.messages.map((message) => Object.freeze({ ...message }))),
    evidenceRefs: Object.freeze(input.evidenceRefs.map((reference) => Object.freeze({ ...reference }))),
    availableTools: Object.freeze([]),
    capabilityRevisions: Object.freeze(
      input.capabilityRevisions.map((revision) => Object.freeze({ ...revision })),
    ),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

function assertReturnedRevision(
  actual: readonly CapabilityRevisionRef[],
  expected: CapabilityRevisionRef,
): boolean {
  return actual.length === 1 && actual[0] !== undefined && sameCapabilityRevisionRef(actual[0], expected);
}

function artifactMatchesRevision(
  artifact: Readonly<{ readonly identity: Omit<CapabilityRevisionRef, "kind"> }>,
  revision: CapabilityRevisionRef,
): boolean {
  return (
    artifact.identity.capabilityId === revision.capabilityId &&
    artifact.identity.capabilityRevisionId === revision.capabilityRevisionId &&
    artifact.identity.bundleDigest === revision.bundleDigest
  );
}

function blindArtifact(artifact: TrialResult["artifact"]): object {
  return Object.freeze({
    content: artifact.content,
    valid: artifact.valid,
    invalidArtifacts: artifact.invalidArtifacts,
    unexpectedEffects: artifact.unexpectedEffects,
    sourceAssertions: artifact.sourceAssertions,
  });
}

function labelsFor(
  preflightId: string,
  caseId: string,
): Readonly<Record<"A" | "B", "baseline" | "candidate">> {
  const swap = Number.parseInt(sha256(`${preflightId}\u0000${caseId}`).slice(0, 2), 16) % 2 === 1;
  return Object.freeze(
    swap
      ? { A: "candidate" as const, B: "baseline" as const }
      : { A: "baseline" as const, B: "candidate" as const },
  );
}

function winnerFromBlind(
  winner: "A" | "B" | "tie" | "inconclusive",
  labels: Readonly<Record<"A" | "B", "baseline" | "candidate">>,
): "baseline" | "candidate" | "tie" | "inconclusive" {
  return winner === "A" || winner === "B" ? labels[winner] : winner;
}

function approvalRequired(input: DynamicPreflightInput): boolean {
  const delta = input.candidate.revision.requestedPermissionDelta;
  const declaredExpansion =
    delta.addedEffects.length > 0 ||
    delta.widenedResources.length > 0 ||
    delta.addedCredentialRefs.length > 0;
  const baseline = input.baseline.revision.permissionManifest;
  const candidate = input.candidate.revision.permissionManifest;
  const manifestExpansion =
    candidate.effects.some((effect) => !baseline.effects.includes(effect)) ||
    candidate.resourcePatterns.some((resource) => !baseline.resourcePatterns.includes(resource)) ||
    candidate.credentialRefs.some((credential) => !baseline.credentialRefs.includes(credential));
  return (
    input.candidate.revision.activationPolicy.mode === "approval_required" ||
    declaredExpansion ||
    manifestExpansion
  );
}

function railChecks(
  input: DynamicPreflightInput,
  trials: readonly TrialResult[],
): readonly EvaluationRailResult[] {
  const candidateTrials = trials.filter((trial) => trial.arm === "candidate");
  const sourceCaseIds = new Set(input.sourceCases.map((evaluationCase) => evaluationCase.caseId));
  const sourceTrials = candidateTrials.filter((trial) => sourceCaseIds.has(trial.caseId));
  const identityFailures = trials.filter(
    (trial) =>
      !artifactMatchesRevision(
        trial.artifact,
        trial.arm === "candidate" ? input.candidate.ref : input.baseline.ref,
      ),
  );
  const sourceFailures = sourceTrials.flatMap((trial) =>
    trial.artifact.sourceAssertions.filter((assertion) => !assertion.passed),
  );
  const missingSourceAssertions = sourceTrials.filter(
    (trial) => trial.artifact.sourceAssertions.length === 0,
  );
  const invalidTrials = candidateTrials.filter(
    (trial) => !trial.artifact.valid || trial.artifact.invalidArtifacts.length > 0,
  );
  const effectTrials = candidateTrials.filter((trial) => trial.artifact.unexpectedEffects.length > 0);
  return Object.freeze([
    Object.freeze({
      rail: "capability_identity" as const,
      passed: identityFailures.length === 0,
      evidenceRefs: Object.freeze(trials.flatMap((trial) => [trial.outputEvidence])),
      details: Object.freeze(
        identityFailures.map(
          (trial) => `${trial.caseId}/${trial.arm} returned a different capability identity`,
        ),
      ),
    }),
    Object.freeze({
      rail: "source_regression" as const,
      passed:
        missingSourceAssertions.length === 0 &&
        sourceFailures.length <= input.config.rails.sourceRegressionTolerance,
      evidenceRefs: Object.freeze(sourceTrials.map((trial) => trial.outputEvidence)),
      details: Object.freeze([
        ...sourceFailures.map((assertion) => assertion.assertionId),
        ...missingSourceAssertions.map((trial) => `${trial.caseId}:missing-source-assertion`),
      ]),
    }),
    Object.freeze({
      rail: "artifact_validity" as const,
      passed: invalidTrials.length === 0,
      evidenceRefs: Object.freeze(invalidTrials.map((trial) => trial.outputEvidence)),
      details: Object.freeze(
        invalidTrials.flatMap((trial) =>
          trial.artifact.invalidArtifacts.length > 0
            ? trial.artifact.invalidArtifacts
            : [`${trial.caseId}: artifact marked invalid`],
        ),
      ),
    }),
    Object.freeze({
      rail: "unexpected_effects" as const,
      passed: effectTrials.length === 0,
      evidenceRefs: Object.freeze(effectTrials.map((trial) => trial.outputEvidence)),
      details: Object.freeze(effectTrials.flatMap((trial) => trial.artifact.unexpectedEffects)),
    }),
  ]);
}

export function createDynamicEvaluationLaboratory(
  options: DynamicEvaluationLaboratoryOptions,
): DynamicEvaluationLaboratory {
  const generators = options.generatorStrategies ?? BUILT_IN_GENERATOR_STRATEGIES;
  const judges = options.judgeStrategies ?? BUILT_IN_JUDGE_STRATEGIES;
  const aggregators = options.aggregationStrategies ?? BUILT_IN_AGGREGATION_STRATEGIES;
  const createRunId = options.createRunId ?? ((prefix: string) => `${prefix}_${randomUUID()}`);

  const runPreflight = async (rawInput: DynamicPreflightInput): Promise<DynamicPreflightResult> => {
    const parsed = DynamicPreflightInputBoundarySchema.safeParse(rawInput);
    if (!parsed.success)
      return failure({
        code: "configuration",
        message: `Invalid dynamic preflight input: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
        stage: "setup",
      });
    const configParsed = DynamicEvaluationConfigSchema.safeParse(rawInput.config);
    if (!configParsed.success)
      return failure({
        code: "configuration",
        message: `Invalid evaluation config v1: ${configParsed.error.issues[0]?.message ?? "unknown error"}`,
        stage: "setup",
      });
    const ownershipError = validateCaseOwnership(rawInput);
    if (ownershipError) return failure({ code: "configuration", message: ownershipError, stage: "setup" });
    if (!sameCapabilityRevisionRef(rawInput.criteria.candidateRevision, rawInput.candidate.ref))
      return failure({
        code: "configuration",
        message: "Criterion snapshot is not pinned to this candidate revision",
        stage: "setup",
      });
    if (
      rawInput.criteria.scope !== rawInput.scope ||
      rawInput.criteria.snapshotDigest !== criterionSnapshotDigest(rawInput.criteria) ||
      !uniqueById(rawInput.criteria.criteria, (criterion) => `${criterion.criterionId}@${criterion.revision}`)
    )
      return failure({
        code: "configuration",
        message: "Criterion snapshot scope, digest, or revision identities are inconsistent",
        stage: "setup",
      });
    for (const configuration of [rawInput.config.generator, rawInput.config.trial, rawInput.config.judge]) {
      if (!configurationIsPinned(configuration))
        return failure({
          code: "configuration",
          message: `Role prompt ${configuration.promptRevision.revisionId} is not pinned by variant ${configuration.variant.variantId}`,
          stage: "setup",
        });
    }

    let generator: EvaluationGeneratorStrategy;
    let judge: EvaluationJudgeStrategy;
    let aggregator: EvaluationAggregationStrategy;
    try {
      generator = requireStrategy(generators, rawInput.config.generator.strategyId, "generator");
      judge = requireStrategy(judges, rawInput.config.judge.strategyId, "judge");
      aggregator = requireStrategy(aggregators, rawInput.config.aggregation.strategyId, "aggregation");
    } catch (error) {
      return failure({
        code: "configuration",
        message: errorMessage(error),
        stage: "setup",
      });
    }

    const canonicalBaselineDigest = capabilityRevisionDigest(rawInput.baseline.revision);
    const canonicalCandidateDigest = capabilityRevisionDigest(rawInput.candidate.revision);
    const identityDetails = [];
    if (
      rawInput.baseline.ref.capabilityId !== rawInput.baseline.revision.capabilityId ||
      rawInput.baseline.ref.capabilityRevisionId !== rawInput.baseline.revision.capabilityRevisionId ||
      rawInput.baseline.ref.bundleDigest !== canonicalBaselineDigest
    )
      identityDetails.push("Baseline CapabilityRevisionRef does not match complete materialized bytes");
    if (
      rawInput.candidate.ref.capabilityId !== rawInput.candidate.revision.capabilityId ||
      rawInput.candidate.ref.capabilityRevisionId !== rawInput.candidate.revision.capabilityRevisionId ||
      rawInput.candidate.ref.bundleDigest !== canonicalCandidateDigest
    )
      identityDetails.push("Candidate CapabilityRevisionRef does not match complete materialized bytes");
    if (rawInput.baseline.ref.capabilityId !== rawInput.candidate.ref.capabilityId)
      identityDetails.push("Baseline and candidate belong to different capabilities");
    if (identityDetails.length > 0)
      return failure({
        code: "identity_mismatch",
        message: identityDetails.join("; "),
        stage: "setup",
      });

    if (rawInput.signal?.aborted)
      return failure({
        code: "cancelled",
        message: "Evaluation cancelled before case generation",
        stage: "case_generation",
        role: "case_generator",
      });

    const maxGeneratedCases = Math.max(
      0,
      rawInput.budget.maxCases - rawInput.sourceCases.length - rawInput.protectedCases.length,
    );
    if (maxGeneratedCases === 0)
      return failure({
        code: "configuration",
        message: "Evaluation budget leaves no room for criterion-guided generated cases",
        stage: "case_generation",
      });

    const generatorEvidence = Object.freeze([
      ...rawInput.sourceCases.flatMap((evaluationCase) => evaluationCase.evidenceRefs),
      ...rawInput.criteria.criteria.flatMap((criterion) => [
        criterion.definitionRevision,
        ...criterion.evidenceRefs,
      ]),
      ...configurationEvidenceRefs(rawInput.config.generator),
    ]);
    let generatedOutput: GeneratedCaseOutput;
    let generatorTrace: EvaluationRoleTrace;
    try {
      const generated = await options.structuredRoles.run(
        runRequest({
          runId: createRunId("case_generator"),
          role: "case_generator",
          configuration: rawInput.config.generator,
          messages: [
            {
              role: "user",
              name: "behavioral_objective",
              content: rawInput.behaviorObjective,
            },
            {
              role: "user",
              name: "evidence",
              content: canonicalJson(
                rawInput.sourceCases.map((evaluationCase) => ({
                  caseId: evaluationCase.caseId,
                  instruction: evaluationCase.instruction,
                  input: evaluationCase.input,
                  evidenceRefs: evaluationCase.evidenceRefs,
                })),
              ),
            },
            {
              role: "user",
              name: "user_criteria",
              content: generator.renderPrompt({
                behaviorObjective: rawInput.behaviorObjective,
                sourceCases: rawInput.sourceCases,
                criteria: rawInput.criteria,
                maxGeneratedCases,
              }),
            },
          ],
          evidenceRefs: generatorEvidence,
          capabilityRevisions: Object.freeze([]),
          ...(rawInput.signal ? { signal: rawInput.signal } : {}),
        }),
        GeneratedCaseOutputSchema,
      );
      generatedOutput = generated.value;
      generatorTrace = generated.trace;
      const mismatch = traceConfigurationMismatch(rawInput.config.generator, generated.trace);
      if (mismatch)
        return failure({
          code: "identity_mismatch",
          message: mismatch,
          stage: "case_generation",
          role: "case_generator",
          trace: generated.trace,
        });
      if (generated.capabilityRevisions.length > 0)
        return failure({
          code: "identity_mismatch",
          message: "Case generator received or returned candidate capability identity",
          stage: "case_generation",
          role: "case_generator",
          trace: generated.trace,
        });
    } catch (error) {
      return classifyRoleFailure(error, "case_generation", "case_generator", rawInput.signal);
    }
    if (generatedOutput.cases.length > maxGeneratedCases)
      return failure({
        code: "malformed_role_output",
        message: `Case generator exceeded the bounded case limit ${maxGeneratedCases}`,
        stage: "case_generation",
        role: "case_generator",
        trace: generatorTrace,
      });
    const allowedEvidence = new Set(generatorEvidence.map(evidenceKey));
    const allowedCriteria = new Set(
      rawInput.criteria.criteria.map((criterion) => `${criterion.criterionId}@${criterion.revision}`),
    );
    const generatedCases: EvaluationCase[] = [];
    for (const generatedCase of generatedOutput.cases) {
      if (generatedCase.sourceEvidenceRefs.some((reference) => !allowedEvidence.has(evidenceKey(reference))))
        return failure({
          code: "malformed_role_output",
          message: `Generated case ${generatedCase.caseId} invented an uncited evidence reference`,
          stage: "case_generation",
          role: "case_generator",
          trace: generatorTrace,
        });
      if (
        generatedCase.criterionRefs.some(
          (reference) => !allowedCriteria.has(`${reference.criterionId}@${reference.revision}`),
        )
      )
        return failure({
          code: "malformed_role_output",
          message: `Generated case ${generatedCase.caseId} cites an unselected criterion revision`,
          stage: "case_generation",
          role: "case_generator",
          trace: generatorTrace,
        });
      generatedCases.push(
        Object.freeze({
          caseId: generatedCase.caseId,
          kind: generatedCase.kind,
          owner: "evaluator" as const,
          instruction: generatedCase.instruction,
          input: generatedCase.input,
          evidenceRefs: Object.freeze(generatedCase.sourceEvidenceRefs),
          criterionRefs: Object.freeze(generatedCase.criterionRefs),
        }),
      );
    }
    const cases = Object.freeze([...rawInput.sourceCases, ...generatedCases, ...rawInput.protectedCases]);
    if (!uniqueById(cases, (item) => item.caseId))
      return failure({
        code: "malformed_role_output",
        message: "Case generator returned an ID that collides with the evaluator suite",
        stage: "case_generation",
        role: "case_generator",
        trace: generatorTrace,
      });

    const caseEvidence = [];
    try {
      for (const evaluationCase of cases) {
        caseEvidence.push(
          await options.recorder.appendEvidence({
            preflightId: rawInput.preflightId,
            name: `case-${evaluationCase.caseId}`,
            kind: "input",
            value: evaluationCase,
            provenanceRefs: Object.freeze([
              ...evaluationCase.evidenceRefs,
              ...(evaluationCase.definitionRevision ? [evaluationCase.definitionRevision] : []),
            ]),
          }),
        );
      }
    } catch (error) {
      return failure({
        code: "recording_failed",
        message: errorMessage(error),
        stage: "recording",
      });
    }

    try {
      await options.recorder.recordPlan(
        Object.freeze({
          planId: rawInput.planId,
          experimentId: rawInput.experimentId,
          candidateRevision: rawInput.candidate.ref,
          baselineRevision: rawInput.baseline.ref,
          caseRefs: Object.freeze([...caseEvidence]),
          judgeVariant: rawInput.config.judge.variant,
          runtimeVariant: rawInput.config.trial.variant,
          budget: rawInput.budget,
        }),
      );
    } catch (error) {
      return failure({
        code: "recording_failed",
        message: errorMessage(error),
        stage: "recording",
      });
    }

    const trials: TrialResult[] = [];
    const roleTelemetry: EvaluationRoleTrace[] = [generatorTrace];
    for (const [caseIndex, evaluationCase] of cases.entries()) {
      const inputEvidence = caseEvidence[caseIndex];
      if (!inputEvidence)
        return failure({
          code: "recording_failed",
          message: `Missing recorded input evidence for ${evaluationCase.caseId}`,
          stage: "recording",
          caseId: evaluationCase.caseId,
        });
      const inputDigest = comparisonInputDigest(rawInput, evaluationCase, inputEvidence);
      const comparisonGroupId = `${rawInput.preflightId}:${evaluationCase.caseId}`;
      for (const arm of ["baseline", "candidate"] as const) {
        const revision = arm === "baseline" ? rawInput.baseline.ref : rawInput.candidate.ref;
        let trialOutput: {
          readonly value: TrialArtifact;
          readonly trace: EvaluationRoleTrace;
          readonly capabilityRevisions: readonly CapabilityRevisionRef[];
        };
        try {
          trialOutput = await options.structuredRoles.run(
            runRequest({
              runId: createRunId(`trial_${evaluationCase.caseId}_${arm}`),
              role: "trial",
              configuration: rawInput.config.trial,
              messages: [
                {
                  role: "user",
                  name: "case",
                  content: canonicalJson({
                    caseId: evaluationCase.caseId,
                    instruction: evaluationCase.instruction,
                    input: evaluationCase.input,
                    evidenceRefs: [...evaluationCase.evidenceRefs, inputEvidence],
                    inputDigest,
                    budget: rawInput.budget,
                  }),
                },
                {
                  role: "user",
                  name: "arm",
                  content: canonicalJson({ capabilityRevision: revision }),
                },
              ],
              evidenceRefs: Object.freeze([
                ...evaluationCase.evidenceRefs,
                inputEvidence,
                ...configurationEvidenceRefs(rawInput.config.trial),
              ]),
              capabilityRevisions: Object.freeze([revision]),
              ...(rawInput.signal ? { signal: rawInput.signal } : {}),
            }),
            TrialArtifactSchema,
          );
        } catch (error) {
          return classifyRoleFailure(error, "trial", "trial", rawInput.signal, {
            caseId: evaluationCase.caseId,
            arm,
          });
        }
        roleTelemetry.push(trialOutput.trace);
        const traceMismatch = traceConfigurationMismatch(rawInput.config.trial, trialOutput.trace);
        if (traceMismatch)
          return failure({
            code: "identity_mismatch",
            message: traceMismatch,
            stage: "trial",
            role: "trial",
            caseId: evaluationCase.caseId,
            arm,
            trace: trialOutput.trace,
          });
        if (trialOutput.trace.telemetry.attempts > rawInput.budget.maxAttemptsPerArm)
          return failure({
            code: "role_failed",
            message: `Trial ${evaluationCase.caseId}/${arm} exceeded maxAttemptsPerArm`,
            stage: "trial",
            role: "trial",
            caseId: evaluationCase.caseId,
            arm,
            trace: trialOutput.trace,
          });
        if (!assertReturnedRevision(trialOutput.capabilityRevisions, revision))
          trialOutput = Object.freeze({
            ...trialOutput,
            value: Object.freeze({
              ...trialOutput.value,
              identity: Object.freeze({
                capabilityId: "identity-mismatch",
                capabilityRevisionId: "identity-mismatch",
                bundleDigest: "0".repeat(64),
              }),
            }),
          });
        try {
          const trialId = `${comparisonGroupId}:${arm}`;
          const outputEvidence = await options.recorder.appendEvidence({
            preflightId: rawInput.preflightId,
            name: `trial-${evaluationCase.caseId}-${arm}`,
            kind: "output",
            value: trialOutput.value,
            provenanceRefs: Object.freeze([
              inputEvidence,
              ...evaluationCase.evidenceRefs,
              ...configurationEvidenceRefs(rawInput.config.trial),
            ]),
          });
          const traceEvidence = await options.recorder.appendEvidence({
            preflightId: rawInput.preflightId,
            name: `trial-${evaluationCase.caseId}-${arm}-trace`,
            kind: "tool_trace",
            value: trialOutput.trace,
            provenanceRefs: Object.freeze([inputEvidence, outputEvidence]),
          });
          const experimentTrial: ExperimentTrial = Object.freeze({
            trialId,
            experimentId: rawInput.experimentId,
            comparisonGroupId,
            arm,
            capabilityRevision: revision,
            inputRefs: Object.freeze([...evaluationCase.evidenceRefs, inputEvidence]),
            outputEvidenceRefs: Object.freeze([outputEvidence]),
            traceEvidenceRefs: Object.freeze([traceEvidence]),
            variant: rawInput.config.trial.variant,
            status: "completed",
          });
          const trialRowRef = await options.recorder.recordTrial(experimentTrial);
          trials.push(
            Object.freeze({
              trialId,
              comparisonGroupId,
              caseId: evaluationCase.caseId,
              arm,
              capabilityRevision: revision,
              inputDigest,
              artifact: trialOutput.value,
              outputEvidence,
              traceEvidence,
              trialRowRef,
              roleTrace: trialOutput.trace,
            }),
          );
        } catch (error) {
          return failure({
            code: "recording_failed",
            message: errorMessage(error),
            stage: "recording",
            caseId: evaluationCase.caseId,
            arm,
          });
        }
      }
    }

    const comparisons: CaseComparison[] = [];
    for (const [caseIndex, evaluationCase] of cases.entries()) {
      const baseline = trials.find(
        (trial) => trial.caseId === evaluationCase.caseId && trial.arm === "baseline",
      );
      const candidate = trials.find(
        (trial) => trial.caseId === evaluationCase.caseId && trial.arm === "candidate",
      );
      const inputEvidence = caseEvidence[caseIndex];
      if (!baseline || !candidate || !inputEvidence)
        return failure({
          code: "recording_failed",
          message: `Incomplete paired trial for ${evaluationCase.caseId}`,
          stage: "recording",
          caseId: evaluationCase.caseId,
        });
      if (baseline.inputDigest !== candidate.inputDigest)
        return failure({
          code: "identity_mismatch",
          message: `Paired trial inputs differ for ${evaluationCase.caseId}`,
          stage: "trial",
          caseId: evaluationCase.caseId,
        });
      const labels = labelsFor(rawInput.preflightId, evaluationCase.caseId);
      const armA = labels.A === "baseline" ? baseline : candidate;
      const armB = labels.B === "baseline" ? baseline : candidate;
      let judged: {
        readonly value: BlindJudgment;
        readonly trace: EvaluationRoleTrace;
        readonly capabilityRevisions: readonly CapabilityRevisionRef[];
      };
      try {
        judged = await options.structuredRoles.run(
          runRequest({
            runId: createRunId(`judge_${evaluationCase.caseId}`),
            role: "judge_critic",
            configuration: rawInput.config.judge,
            messages: [
              {
                role: "user",
                name: "rubric",
                content: judge.renderRubric({
                  behaviorObjective: rawInput.behaviorObjective,
                  evaluationCase,
                  criteria: rawInput.criteria,
                }),
              },
              {
                role: "user",
                name: "arm_A",
                content: canonicalJson(blindArtifact(armA.artifact)),
              },
              {
                role: "user",
                name: "arm_B",
                content: canonicalJson(blindArtifact(armB.artifact)),
              },
            ],
            evidenceRefs: Object.freeze([
              inputEvidence,
              ...rawInput.criteria.criteria.flatMap((criterion) => [
                criterion.definitionRevision,
                ...criterion.evidenceRefs,
              ]),
              ...configurationEvidenceRefs(rawInput.config.judge),
            ]),
            capabilityRevisions: Object.freeze([]),
            ...(rawInput.signal ? { signal: rawInput.signal } : {}),
          }),
          BlindJudgmentSchema,
        );
      } catch (error) {
        return classifyRoleFailure(error, "judgment", "judge_critic", rawInput.signal, {
          caseId: evaluationCase.caseId,
        });
      }
      roleTelemetry.push(judged.trace);
      const judgeTraceMismatch = traceConfigurationMismatch(rawInput.config.judge, judged.trace);
      if (judgeTraceMismatch)
        return failure({
          code: "identity_mismatch",
          message: judgeTraceMismatch,
          stage: "judgment",
          role: "judge_critic",
          caseId: evaluationCase.caseId,
          trace: judged.trace,
        });
      if (judged.capabilityRevisions.length > 0)
        return failure({
          code: "identity_mismatch",
          message: "Blind judge received or returned arm capability identity",
          stage: "judgment",
          role: "judge_critic",
          caseId: evaluationCase.caseId,
          trace: judged.trace,
        });
      const expectedCriteria = new Set(
        rawInput.criteria.criteria.map((criterion) => `${criterion.criterionId}@${criterion.revision}`),
      );
      const judgedCriteria = new Set(
        judged.value.appliedCriteria.map((criterion) => `${criterion.criterionId}@${criterion.revision}`),
      );
      if (
        expectedCriteria.size !== judgedCriteria.size ||
        [...expectedCriteria].some((criterion) => !judgedCriteria.has(criterion))
      )
        return failure({
          code: "malformed_role_output",
          message: `Judge did not apply the exact selected criterion revisions for ${evaluationCase.caseId}`,
          stage: "judgment",
          role: "judge_critic",
          caseId: evaluationCase.caseId,
          trace: judged.trace,
        });
      try {
        const judgmentEvidence = await options.recorder.appendEvidence({
          preflightId: rawInput.preflightId,
          name: `judgment-${evaluationCase.caseId}`,
          kind: "judgment",
          value: {
            blindLabels: labels,
            judgment: judged.value,
            strategyId: judge.strategyId,
            judgeConfiguration: rawInput.config.judge,
          },
          provenanceRefs: Object.freeze([
            inputEvidence,
            baseline.outputEvidence,
            candidate.outputEvidence,
            ...rawInput.criteria.criteria.flatMap((criterion) => [
              criterion.definitionRevision,
              ...criterion.evidenceRefs,
            ]),
            ...configurationEvidenceRefs(rawInput.config.judge),
          ]),
        });
        comparisons.push(
          Object.freeze({
            caseId: evaluationCase.caseId,
            blindLabels: labels,
            judgment: judged.value,
            winner: winnerFromBlind(judged.value.winner, labels),
            judgmentEvidence,
          }),
        );
      } catch (error) {
        return failure({
          code: "recording_failed",
          message: errorMessage(error),
          stage: "recording",
          caseId: evaluationCase.caseId,
        });
      }
    }

    const aggregation = aggregator.aggregate(comparisons, rawInput.config.aggregation);
    const estimatedCost = roleTelemetry.reduce((total, trace) => total + trace.usage.estimatedCost, 0);
    if (estimatedCost > rawInput.budget.maxCost)
      return failure({
        code: "role_failed",
        message: `Evaluation cost ${estimatedCost} exceeded budget ${rawInput.budget.maxCost}`,
        stage: "judgment",
      });
    const rails = railChecks(rawInput, trials);
    const decision = decisionFromEvaluation({
      approvalRequired: approvalRequired(rawInput),
      railsPassed: rails.every((rail) => rail.passed),
      aggregation,
      config: rawInput.config,
    });
    const reportDraft = Object.freeze({
      schemaVersion: 1 as const,
      preflightId: rawInput.preflightId,
      experimentId: rawInput.experimentId,
      planId: rawInput.planId,
      baselineRevision: rawInput.baseline.ref,
      candidateRevision: rawInput.candidate.ref,
      canonicalCandidateDigest,
      suiteDigest: suiteDigest(rawInput, cases),
      criterionSnapshot: rawInput.criteria,
      cases,
      caseEvidence: Object.freeze(caseEvidence),
      trials: Object.freeze(trials),
      comparisons: Object.freeze(comparisons),
      aggregation,
      railChecks: rails,
      config: rawInput.config,
      roleTelemetry: Object.freeze(roleTelemetry),
      decision,
    });
    try {
      const reportEvidence = await options.recorder.appendEvidence({
        preflightId: rawInput.preflightId,
        name: "preflight-report",
        kind: "report",
        value: reportDraft,
        provenanceRefs: allReportEvidenceRefs(reportDraft),
      });
      const report: DynamicPreflightReport = Object.freeze({ ...reportDraft, reportEvidence });
      await options.recorder.recordReport(report);
      return ok(report);
    } catch (error) {
      return failure({
        code: "recording_failed",
        message: errorMessage(error),
        stage: "recording",
      });
    }
  };

  return Object.freeze({ runPreflight });
}

export function validateEvaluationCase(value: unknown): EvaluationCase | undefined {
  const parsed = EvaluationCaseSchema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : undefined;
}
