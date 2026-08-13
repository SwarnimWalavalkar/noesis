import type { UserCriterionRepository } from "@noesis/config";
import {
  type CapabilityRevision,
  type CapabilityRevisionRef,
  canonicalJson,
  type DurableJobRecord,
  type EvidenceRef,
  type Experiment,
  sha256,
  toJsonValue,
} from "@noesis/domain";
import type { ContinuousFeedbackController } from "@noesis/runtime";
import type {
  TuiLearningAuditSnapshot,
  TuiLearningPrimitive,
  TuiLearningPrimitiveGroup,
  TuiLearningPrimitiveKind,
  TuiLearningRelation,
} from "@noesis/tui";
import type { NoesisWorkspaceStore } from "@noesis/workspace";
import type { ProtectedWorkspaceRuntime } from "../../../packages/workspace/src/protected-runtime.ts";

const AUDIT_LIMIT = 1_000;
const RAW_JSON_LIMIT = 64_000;

interface LearningAuditSource {
  readonly workspace: NoesisWorkspaceStore;
  readonly criteria: Pick<UserCriterionRepository, "list">;
  readonly activations: Pick<
    ProtectedWorkspaceRuntime["activations"],
    "current" | "listOperations" | "getApproval"
  >;
  readonly feedback: Pick<
    ProtectedWorkspaceRuntime["feedback"],
    "listObservations" | "listResearchRuns" | "getOutcome" | "getSuccessorInput"
  >;
  readonly continuousFeedback: Pick<ContinuousFeedbackController, "experimentComparison">;
  readonly resolveRevision: (reference: CapabilityRevisionRef) => Promise<CapabilityRevision | undefined>;
  readonly resolveCapability: (capabilityId: string) =>
    | Readonly<{
        readonly capabilityId: string;
        readonly name: string;
        readonly scope: string;
        readonly intent: string;
      }>
    | undefined;
  readonly projectId: string;
  readonly now?: () => Date;
}

interface PrimitiveInput extends Omit<TuiLearningPrimitive, "evidence" | "relations" | "rawJson" | "tone"> {
  readonly evidence?: readonly EvidenceRef[];
  readonly relations?: readonly TuiLearningRelation[];
  readonly raw: unknown;
  readonly sensitivity?: "normal" | "private" | "secret";
  readonly tone?: TuiLearningPrimitive["tone"];
}

function nativeId(kind: TuiLearningPrimitiveKind, id: string): string {
  return `${kind}:${id}`;
}

function relation(label: string, kind: TuiLearningPrimitiveKind, id: string | undefined) {
  return id ? Object.freeze({ label, targetId: nativeId(kind, id) }) : undefined;
}

function defined<Value>(value: Value | undefined): value is Value {
  return value !== undefined;
}

function evidenceIdentity(reference: EvidenceRef): string {
  if (reference.kind === "database_row") return `${reference.table}:${reference.rowId}`;
  if (reference.kind === "artifact_file") return `artifact:${reference.artifactId}`;
  return `${reference.kind}:${reference.revisionId}`;
}

function boundedRawJson(value: unknown, sensitivity: "normal" | "private" | "secret" = "normal"): string {
  if (sensitivity !== "normal")
    return canonicalJson({
      redacted: true,
      sensitivity,
      reason: "This runtime has no admitted TUI grant for sensitive learning payloads.",
    });
  const encoded = canonicalJson(toJsonValue(value));
  if (encoded.length <= RAW_JSON_LIMIT) return encoded;
  return canonicalJson({
    truncated: true,
    characterCount: encoded.length,
    digest: sha256(encoded),
    preview: encoded.slice(0, RAW_JSON_LIMIT - 1),
  });
}

function primitive(input: PrimitiveInput): TuiLearningPrimitive {
  const { raw, sensitivity, ...record } = input;
  return Object.freeze({
    ...record,
    tone: input.tone ?? "neutral",
    evidence: Object.freeze((input.evidence ?? []).map(evidenceIdentity)),
    relations: Object.freeze((input.relations ?? []).filter(defined)),
    rawJson: boundedRawJson(raw, sensitivity),
  });
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const field = Reflect.get(value, key);
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

async function listProjectReflectionJobs(
  workspace: NoesisWorkspaceStore,
  projectId: string,
): Promise<readonly DurableJobRecord[]> {
  return await workspace.jobs.list({
    kind: "runtime.reflect_turn",
    payloadProjectId: projectId,
    order: "newest",
    limit: AUDIT_LIMIT,
  });
}

async function listExperimentJobs(
  workspace: NoesisWorkspaceStore,
  experimentIds: readonly string[],
): Promise<readonly DurableJobRecord[]> {
  const chunks: string[][] = [];
  for (let index = 0; index < experimentIds.length; index += 250)
    chunks.push(experimentIds.slice(index, index + 250));
  const jobs = (
    await Promise.all(
      chunks.map((payloadExperimentIds) =>
        workspace.jobs.list({ payloadExperimentIds, order: "newest", limit: AUDIT_LIMIT }),
      ),
    )
  ).flat();
  return Object.freeze(
    [...new Map(jobs.map((job) => [job.jobId, job] as const)).values()]
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.jobId.localeCompare(left.jobId),
      )
      .slice(0, AUDIT_LIMIT),
  );
}

async function listSourceSessionJobs(
  workspace: NoesisWorkspaceStore,
  sessionIds: readonly string[],
): Promise<readonly DurableJobRecord[]> {
  const chunks: string[][] = [];
  for (let index = 0; index < sessionIds.length; index += 250)
    chunks.push(sessionIds.slice(index, index + 250));
  const jobs = (
    await Promise.all(
      chunks.map((payloadSourceSessionIds) =>
        workspace.jobs.list({ payloadSourceSessionIds, order: "newest", limit: AUDIT_LIMIT }),
      ),
    )
  ).flat();
  return Object.freeze([...new Map(jobs.map((job) => [job.jobId, job] as const)).values()]);
}

async function resolveProjectExperiments(
  workspace: NoesisWorkspaceStore,
  originJobs: readonly DurableJobRecord[],
  adjustments: Awaited<ReturnType<NoesisWorkspaceStore["workingAdjustments"]["list"]>>,
): Promise<readonly Experiment[]> {
  const adjustmentIds = adjustments.map((adjustment) => adjustment.adjustmentId);
  const adjustmentExperiments =
    adjustmentIds.length === 0
      ? []
      : await workspace.research.experiments.listExperiments({
          sourceAdjustmentIds: adjustmentIds,
          limit: AUDIT_LIMIT,
        });
  const knownById = new Map(
    adjustmentExperiments.map((experiment) => [experiment.experimentId, experiment] as const),
  );
  const queue = [
    ...new Set([
      ...originJobs.map(jobExperimentId).filter(defined),
      ...adjustmentExperiments.map((experiment) => experiment.experimentId),
    ]),
  ];
  const selected = new Map<string, Experiment>();
  for (let index = 0; index < queue.length && selected.size < AUDIT_LIMIT; index += 1) {
    const experimentId = queue[index];
    if (experimentId === undefined || selected.has(experimentId)) continue;
    const experiment =
      knownById.get(experimentId) ?? (await workspace.research.experiments.getExperiment(experimentId));
    if (experiment === undefined) continue;
    selected.set(experimentId, experiment);
    if (experiment.followUpExperimentId !== undefined) queue.push(experiment.followUpExperimentId);
  }
  return Object.freeze([...selected.values()]);
}

function jobExperimentId(job: DurableJobRecord): string | undefined {
  return stringField(job.payload, "experimentId") ?? stringField(job.result, "experimentId");
}

function jobProjectId(job: DurableJobRecord): string | undefined {
  const direct = stringField(job.result, "projectId");
  if (direct) return direct;
  if (job.kind !== "runtime.reflect_turn" || typeof job.payload !== "object" || job.payload === null)
    return undefined;
  const turn = Reflect.get(job.payload, "turn");
  const project = typeof turn === "object" && turn !== null ? Reflect.get(turn, "project") : undefined;
  return stringField(project, "projectId");
}

function jobSessionId(job: DurableJobRecord): string | undefined {
  if (job.kind === "runtime.reflect_turn" && typeof job.payload === "object" && job.payload !== null)
    return stringField(Reflect.get(job.payload, "turn"), "sessionId");
  return stringField(job.payload, "sourceSessionId");
}

function reflectionTurnId(job: DurableJobRecord): string | undefined {
  if (job.kind !== "runtime.reflect_turn" || typeof job.payload !== "object" || job.payload === null)
    return undefined;
  return stringField(Reflect.get(job.payload, "turn"), "turnId");
}

function jobSensitivity(job: DurableJobRecord): "normal" | "private" | "secret" {
  if (job.kind !== "runtime.reflect_turn" || typeof job.payload !== "object" || job.payload === null)
    return "normal";
  const turn = Reflect.get(job.payload, "turn");
  const value = stringField(turn, "sensitivity");
  return value === "private" || value === "secret" ? value : "normal";
}

function jobSummary(job: DurableJobRecord): string {
  if (job.status === "failed" || job.status === "budget_exhausted" || job.status === "cancelled")
    return job.lastError?.message ?? `Learning job ${job.status.replaceAll("_", " ")}`;
  if (job.status !== "completed") return `${job.kind} is ${job.status}`;
  const resultStatus = stringField(job.result, "status");
  return (
    stringField(job.result, "rationale") ??
    stringField(job.result, "reason") ??
    (resultStatus
      ? `${job.kind} completed with ${resultStatus.replaceAll("_", " ")}`
      : `${job.kind} completed`)
  );
}

function reflectionTitle(job: DurableJobRecord): string {
  const result = stringField(job.result, "status");
  return result ? `Reflection · ${result.replaceAll("_", " ")}` : "Turn reflection";
}

function jobPrimitive(job: DurableJobRecord): TuiLearningPrimitive {
  const experimentId = jobExperimentId(job);
  const sessionId = jobSessionId(job);
  const projectId = jobProjectId(job);
  const isReflection = job.kind === "runtime.reflect_turn";
  const kind: TuiLearningPrimitiveKind = isReflection ? "reflection" : "job";
  const group: TuiLearningPrimitiveGroup = isReflection ? "reflection" : "operations";
  return primitive({
    id: nativeId(kind, job.jobId),
    kind,
    group,
    status: stringField(job.result, "status") ?? job.status,
    tone:
      job.status === "failed" || job.status === "budget_exhausted" || job.status === "cancelled"
        ? "negative"
        : job.status === "running" || job.status === "scheduled"
          ? "pending"
          : stringField(job.result, "status") === "no_change"
            ? "neutral"
            : "positive",
    title: isReflection ? reflectionTitle(job) : job.kind.replace("runtime.", "").replaceAll("_", " "),
    summary: jobSummary(job),
    occurredAt: job.updatedAt,
    ...(sessionId ? { sessionId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(experimentId ? { experimentId } : {}),
    evidence: job.payloadRefs,
    relations: [
      relation("experiment", "experiment", experimentId),
      relation("adjustment", "working_adjustment", stringField(job.result, "adjustmentId")),
      relation(
        "candidate",
        "capability_revision",
        stringField(
          typeof job.result === "object" && job.result !== null
            ? Reflect.get(job.result, "candidateRevision")
            : undefined,
          "capabilityRevisionId",
        ),
      ),
    ].filter(defined),
    raw: job,
    sensitivity: jobSensitivity(job),
  });
}

function latestJobTime(jobs: readonly DurableJobRecord[], experimentId: string): string | undefined {
  return jobs
    .filter((job) => jobExperimentId(job) === experimentId)
    .map((job) => job.updatedAt)
    .sort((left, right) => right.localeCompare(left))[0];
}

function sortPrimitives(primitives: readonly TuiLearningPrimitive[]): readonly TuiLearningPrimitive[] {
  return Object.freeze(
    [...primitives].sort(
      (left, right) =>
        (right.occurredAt ?? "").localeCompare(left.occurredAt ?? "") ||
        left.group.localeCompare(right.group) ||
        left.id.localeCompare(right.id),
    ),
  );
}

export async function loadLearningAuditSnapshot(
  source: LearningAuditSource,
  sessionId: string,
): Promise<TuiLearningAuditSnapshot> {
  const [
    reflectionJobs,
    adjustments,
    criteriaResult,
    activation,
    allActivationOperations,
    allFeedbackSignals,
  ] = await Promise.all([
    listProjectReflectionJobs(source.workspace, source.projectId),
    source.workspace.workingAdjustments.list({ projectId: source.projectId, limit: AUDIT_LIMIT }),
    source.criteria.list(),
    source.activations.current(),
    source.activations.listOperations(AUDIT_LIMIT),
    source.workspace.research.feedbackSignals.listFeedbackSignals({ limit: AUDIT_LIMIT }),
  ]);
  if (!criteriaResult.ok) throw new Error(criteriaResult.error.message);
  const projectSessionIds = [...new Set(reflectionJobs.map(jobSessionId).filter(defined))];
  const sourceSessionJobs = await listSourceSessionJobs(source.workspace, projectSessionIds);
  const originJobs = [...reflectionJobs, ...sourceSessionJobs];
  const experiments = await resolveProjectExperiments(source.workspace, originJobs, adjustments);
  const experimentIds = new Set(experiments.map((experiment) => experiment.experimentId));
  const experimentJobs = await listExperimentJobs(source.workspace, [...experimentIds]);
  const jobs = Object.freeze(
    [...new Map([...originJobs, ...experimentJobs].map((job) => [job.jobId, job] as const)).values()]
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.jobId.localeCompare(left.jobId),
      )
      .slice(0, AUDIT_LIMIT),
  );
  const activationOperations = allActivationOperations.filter((operation) =>
    experimentIds.has(operation.binding.experimentId),
  );
  const referencedFeedbackSignalIds = new Set(
    experiments.flatMap((experiment) => experiment.feedbackSignalIds),
  );
  const listedFeedbackSignalsById = new Map(
    allFeedbackSignals.map((signal) => [signal.signalId, signal] as const),
  );
  const referencedFeedbackSignals = (
    await Promise.all(
      [...referencedFeedbackSignalIds]
        .filter((signalId) => !listedFeedbackSignalsById.has(signalId))
        .map((signalId) => source.workspace.research.feedbackSignals.getFeedbackSignal(signalId)),
    )
  ).filter(defined);
  const feedbackSignals = [
    ...new Map(
      [...allFeedbackSignals, ...referencedFeedbackSignals]
        .filter(
          (signal) =>
            (signal.experimentId !== undefined && experimentIds.has(signal.experimentId)) ||
            referencedFeedbackSignalIds.has(signal.signalId),
        )
        .map((signal) => [signal.signalId, signal] as const),
    ).values(),
  ];
  const activeAdjustment = await source.workspace.workingAdjustments.getActive(source.projectId);
  const reflectionByTurnId = new Map(
    jobs
      .map((job) => {
        const turnId = reflectionTurnId(job);
        return turnId ? ([turnId, job.jobId] as const) : undefined;
      })
      .filter(defined),
  );
  const primitives: TuiLearningPrimitive[] = jobs.map(jobPrimitive);

  for (const criterion of criteriaResult.value) {
    const definition = criterion.definition;
    primitives.push(
      primitive({
        id: nativeId("criterion", definition.criterionId),
        kind: "criterion",
        group: "memory",
        status: `${definition.status}${definition.pinned ? " · pinned" : ""}`,
        tone: definition.status === "active" ? "active" : "neutral",
        title: definition.criterionId,
        summary: definition.evaluatorInstruction,
        evidence: definition.evidenceRefs,
        relations: [],
        raw: criterion,
      }),
    );
  }

  for (const adjustment of adjustments) {
    const active = activeAdjustment?.adjustmentId === adjustment.adjustmentId;
    primitives.push(
      primitive({
        id: nativeId("working_adjustment", adjustment.adjustmentId),
        kind: "working_adjustment",
        group: "changes",
        status: active ? "active" : "inactive",
        tone: active ? "active" : "neutral",
        title: "Project working adjustment",
        summary: adjustment.strategy,
        projectId: adjustment.scope.projectId,
        evidence: adjustment.evidenceRefs,
        relations: [
          relation("source reflection", "reflection", reflectionByTurnId.get(adjustment.createdFromTurnId)),
        ].filter(defined),
        raw: adjustment,
      }),
    );
  }

  const revisionRefs = new Map<string, CapabilityRevisionRef>();
  for (const experiment of experiments) {
    revisionRefs.set(experiment.baselineRevision.capabilityRevisionId, experiment.baselineRevision);
    for (const candidate of experiment.candidateRevisions)
      revisionRefs.set(candidate.capabilityRevisionId, candidate);
    if (experiment.activatedRevision)
      revisionRefs.set(experiment.activatedRevision.capabilityRevisionId, experiment.activatedRevision);
    const occurredAt = latestJobTime(jobs, experiment.experimentId);
    primitives.push(
      primitive({
        id: nativeId("experiment", experiment.experimentId),
        kind: "experiment",
        group: "changes",
        status: experiment.status === "completed" ? `completed · ${experiment.outcome}` : experiment.status,
        tone:
          experiment.status !== "completed"
            ? "pending"
            : experiment.outcome === "keep"
              ? "positive"
              : experiment.outcome === "revert"
                ? "negative"
                : "neutral",
        title: experiment.hypothesis,
        summary: `Scope: ${experiment.scope}`,
        ...(occurredAt ? { occurredAt } : {}),
        experimentId: experiment.experimentId,
        capabilityId: experiment.baselineRevision.capabilityId,
        evidence: experiment.evidenceRefs,
        relations: [
          relation("baseline", "capability_revision", experiment.baselineRevision.capabilityRevisionId),
          ...experiment.candidateRevisions.map((candidate) =>
            relation("candidate", "capability_revision", candidate.capabilityRevisionId),
          ),
          relation("adjustment", "working_adjustment", experiment.sourceAdjustmentId),
          relation("follow-up", "experiment", experiment.followUpExperimentId),
        ].filter(defined),
        raw: experiment,
      }),
    );

    const [trials, evaluations, comparison, researchRuns, outcome, successorInput] = await Promise.all([
      source.workspace.research.trials.listTrials(experiment.experimentId),
      source.workspace.research.evaluations.listEvaluations(experiment.experimentId),
      experiment.preflightRef
        ? source.continuousFeedback.experimentComparison(experiment.experimentId)
        : undefined,
      source.feedback.listResearchRuns(experiment.experimentId),
      source.feedback.getOutcome(experiment.experimentId),
      source.feedback.getSuccessorInput(experiment.experimentId),
    ]);
    const report = experiment.preflightRef
      ? await source.workspace.research.preflights.getPreflightReport(experiment.preflightRef.rowId)
      : undefined;
    const plan = report
      ? await source.workspace.research.preflights.getPreflightPlan(report.planId)
      : undefined;
    if (plan)
      primitives.push(
        primitive({
          id: nativeId("preflight_plan", plan.planId),
          kind: "preflight_plan",
          group: "evaluation",
          status: "recorded",
          title: "Preflight plan",
          summary: `${String(plan.caseRefs.length)} cases · ${plan.judgeVariant.variantId}`,
          experimentId: experiment.experimentId,
          capabilityId: plan.candidateRevision.capabilityId,
          evidence: plan.caseRefs,
          relations: [
            relation("experiment", "experiment", experiment.experimentId),
            relation("candidate", "capability_revision", plan.candidateRevision.capabilityRevisionId),
          ].filter(defined),
          raw: plan,
        }),
      );
    for (const trial of trials)
      primitives.push(
        primitive({
          id: nativeId("trial", trial.trialId),
          kind: "trial",
          group: "evaluation",
          status: `${trial.status} · ${trial.arm}`,
          tone:
            trial.status === "completed" ? "positive" : trial.status === "failed" ? "negative" : "pending",
          title: `${trial.arm} trial`,
          summary: `${trial.comparisonGroupId} · ${trial.variant.variantId}`,
          experimentId: experiment.experimentId,
          capabilityId: trial.capabilityRevision.capabilityId,
          evidence: [...trial.inputRefs, ...trial.outputEvidenceRefs, ...trial.traceEvidenceRefs],
          relations: [
            relation("experiment", "experiment", experiment.experimentId),
            relation("revision", "capability_revision", trial.capabilityRevision.capabilityRevisionId),
          ].filter(defined),
          raw: trial,
        }),
      );
    for (const evaluation of evaluations)
      primitives.push(
        primitive({
          id: nativeId("evaluation", evaluation.evaluationId),
          kind: "evaluation",
          group: "evaluation",
          status: evaluation.status,
          tone:
            evaluation.status === "completed"
              ? "positive"
              : evaluation.status === "failed"
                ? "negative"
                : "pending",
          title: "Evaluation",
          summary: `${String(evaluation.trialIds.length)} trials`,
          experimentId: experiment.experimentId,
          capabilityId: evaluation.candidateRevision.capabilityId,
          evidence: evaluation.evidenceRefs,
          relations: [
            relation("experiment", "experiment", experiment.experimentId),
            relation("report", "preflight_report", evaluation.preflightId),
            ...evaluation.trialIds.map((trialId) => relation("trial", "trial", trialId)),
          ].filter(defined),
          raw: evaluation,
        }),
      );
    if (report)
      primitives.push(
        primitive({
          id: nativeId("preflight_report", report.preflightId),
          kind: "preflight_report",
          group: "evaluation",
          status: report.decision,
          tone: report.decision === "pass" ? "positive" : "negative",
          title: "Preflight report",
          summary: report.comparison.summary,
          experimentId: experiment.experimentId,
          capabilityId: report.candidateRevision.capabilityId,
          evidence: [...report.trialEvidence, ...report.judgmentEvidence, report.reportEvidence],
          relations: [
            relation("experiment", "experiment", experiment.experimentId),
            relation("plan", "preflight_plan", report.planId),
            ...report.trialRowRefs.map((trial) => relation("trial", "trial", trial.rowId)),
          ].filter(defined),
          raw: report,
        }),
      );
    for (const observation of comparison?.observations ?? [])
      primitives.push(
        primitive({
          id: nativeId("observation", observation.observationId),
          kind: "observation",
          group: "feedback",
          status: observation.hardRegression
            ? "hard regression"
            : (observation.userDecision ?? observation.precedence),
          tone: observation.hardRegression
            ? "negative"
            : observation.userDecision === "keep"
              ? "positive"
              : observation.userDecision === "revert"
                ? "negative"
                : "neutral",
          title: "Live experiment observation",
          summary: `${observation.metrics.failed ? "failed" : "served"} · activation r${String(observation.activationRevision)}`,
          occurredAt: observation.createdAt,
          sessionId: observation.sessionId,
          experimentId: experiment.experimentId,
          capabilityId: observation.capabilityRevision.capabilityId,
          evidence: observation.evidenceRefs,
          relations: [
            relation("experiment", "experiment", experiment.experimentId),
            relation("signal", "feedback_signal", observation.signalId),
          ].filter(defined),
          raw: observation,
        }),
      );
    for (const run of researchRuns)
      primitives.push(
        primitive({
          id: nativeId("outcome_research", run.runId),
          kind: "outcome_research",
          group: "feedback",
          status: run.proposal ? `${run.status} · ${run.proposal}` : run.status,
          tone: run.status === "completed" ? "positive" : run.status === "failed" ? "negative" : "pending",
          title: "Outcome research",
          summary: run.failureMessage ?? `${String(run.citedObservationIds.length)} cited observations`,
          occurredAt: run.updatedAt,
          experimentId: experiment.experimentId,
          evidence: run.evidenceRefs,
          relations: [
            relation("experiment", "experiment", experiment.experimentId),
            ...run.citedObservationIds.map((id) => relation("observation", "observation", id)),
          ].filter(defined),
          raw: run,
        }),
      );
    if (outcome)
      primitives.push(
        primitive({
          id: nativeId("experiment_outcome", outcome.operationId),
          kind: "experiment_outcome",
          group: "feedback",
          status: outcome.decision,
          tone:
            outcome.decision === "keep" ? "positive" : outcome.decision === "revert" ? "negative" : "neutral",
          title: `Experiment outcome · ${outcome.decision}`,
          summary: outcome.strategyId,
          occurredAt: outcome.committedAt,
          experimentId: experiment.experimentId,
          evidence: outcome.evidenceRefs,
          relations: [
            relation("experiment", "experiment", experiment.experimentId),
            relation("research", "outcome_research", outcome.researchRunId),
            relation("successor", "experiment", outcome.successorExperimentId),
          ].filter(defined),
          raw: outcome,
        }),
      );
    if (successorInput)
      primitives.push(
        primitive({
          id: nativeId("successor_lineage", successorInput.inputId),
          kind: "successor_lineage",
          group: "feedback",
          status: "recorded",
          title: "Successor experiment lineage",
          summary: `${successorInput.predecessorExperimentId} → ${successorInput.successorExperimentId}`,
          occurredAt: successorInput.createdAt,
          experimentId: experiment.experimentId,
          evidence: successorInput.evidenceRefs,
          relations: [
            relation("predecessor", "experiment", successorInput.predecessorExperimentId),
            relation("successor", "experiment", successorInput.successorExperimentId),
          ].filter(defined),
          raw: successorInput,
        }),
      );
  }

  for (const reference of revisionRefs.values()) {
    const [revision, capability] = await Promise.all([
      source.resolveRevision(reference),
      Promise.resolve(source.resolveCapability(reference.capabilityId)),
    ]);
    primitives.push(
      primitive({
        id: nativeId("capability_revision", reference.capabilityRevisionId),
        kind: "capability_revision",
        group: "changes",
        status:
          activation?.activeCapabilityRevisions[reference.capabilityId]?.kind === "capability_revision" &&
          activation.activeCapabilityRevisions[reference.capabilityId]?.capabilityRevisionId ===
            reference.capabilityRevisionId
            ? "active"
            : "recorded",
        title: `${capability?.name ?? reference.capabilityId} revision`,
        summary: capability?.intent ?? reference.bundleDigest,
        capabilityId: reference.capabilityId,
        evidence: revision?.evidenceRefs ?? [],
        raw: revision ?? reference,
      }),
    );
  }

  for (const operation of activationOperations) {
    primitives.push(
      primitive({
        id: nativeId("activation", operation.operationId),
        kind: "activation",
        group: "activation",
        status: operation.status,
        tone:
          operation.status === "committed" || operation.status === "approved"
            ? "positive"
            : operation.status === "blocked" || operation.status === "rejected"
              ? "negative"
              : "pending",
        title: `Activation · ${operation.decision.replaceAll("_", " ")}`,
        summary: `${operation.binding.candidateRevision.capabilityId}@${operation.binding.candidateRevision.capabilityRevisionId}`,
        occurredAt: operation.updatedAt,
        experimentId: operation.binding.experimentId,
        capabilityId: operation.binding.candidateRevision.capabilityId,
        evidence: [],
        relations: [
          relation("experiment", "experiment", operation.binding.experimentId),
          relation(
            "candidate",
            "capability_revision",
            operation.binding.candidateRevision.capabilityRevisionId,
          ),
          relation("report", "preflight_report", operation.binding.preflightId),
          relation("approval", "approval", operation.approvalId),
        ].filter(defined),
        raw: operation,
      }),
    );
    if (operation.approvalId) {
      const approval = await source.activations.getApproval(operation.approvalId);
      if (approval)
        primitives.push(
          primitive({
            id: nativeId("approval", approval.approvalId),
            kind: "approval",
            group: "activation",
            status: approval.status,
            tone:
              approval.status === "approved"
                ? "positive"
                : approval.status === "rejected"
                  ? "negative"
                  : "pending",
            title: "Activation approval",
            summary: approval.decisionActor ?? "Awaiting a protected decision",
            occurredAt: approval.decidedAt ?? approval.requestedAt,
            relations: [relation("activation", "activation", approval.operationId)].filter(defined),
            raw: approval,
          }),
        );
    }
  }

  if (activation)
    primitives.push(
      primitive({
        id: nativeId("activation", activation.activationId),
        kind: "activation",
        group: "activation",
        status: "current",
        tone: "active",
        title: `Current activation r${String(activation.revision)}`,
        summary: `${String(Object.keys(activation.activeCapabilityRevisions).length)} active capabilities`,
        occurredAt: activation.createdAt,
        relations: [relation("previous", "activation", activation.previousActivationId ?? undefined)].filter(
          defined,
        ),
        raw: activation,
      }),
    );

  for (const signal of feedbackSignals)
    primitives.push(
      primitive({
        id: nativeId("feedback_signal", signal.signalId),
        kind: "feedback_signal",
        group: "feedback",
        status: signal.kind.replaceAll("_", " "),
        title: "Feedback signal",
        summary: `${signal.scope} · strength ${String(signal.strength)} · novelty ${String(signal.novelty)}`,
        ...(signal.experimentId ? { experimentId: signal.experimentId } : {}),
        evidence: signal.evidenceRefs,
        relations: [
          relation("experiment", "experiment", signal.experimentId),
          relation("revision", "capability_revision", signal.capabilityRevisionId),
        ].filter(defined),
        raw: signal,
        sensitivity: signal.sensitivity,
      }),
    );

  return Object.freeze({
    projectId: source.projectId,
    sessionId,
    generatedAt: (source.now ?? (() => new Date()))().toISOString(),
    ...(activeAdjustment ? { activeAdjustmentId: activeAdjustment.adjustmentId } : {}),
    ...(activation ? { activeActivationId: activation.activationId } : {}),
    primitives: sortPrimitives(primitives),
  });
}
