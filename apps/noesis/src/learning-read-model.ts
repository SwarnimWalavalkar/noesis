// biome-ignore-all lint/complexity/useLiteralKeys: unknown durable job results require bracket access under noPropertyAccessFromIndexSignature.
import type { WorkingAdjustment, WorkingAdjustmentReadPort } from "@noesis/domain";
import type {
  CoordinatorJobKind,
  CoordinatorJobView,
  ReflectTurnJobPayload,
  RuntimeCoordinator,
} from "@noesis/runtime";
import type {
  TuiLearningActivitySummary,
  TuiLearningInspection,
  TuiWorkingAdjustmentState,
} from "@noesis/tui";
import type { OutcomeRecord } from "@noesis/workspace";

interface UnknownRecord {
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function resultExperimentId(job: CoordinatorJobView): string | undefined {
  return stringField(job.job.result, "experimentId");
}

type ReflectionJob = CoordinatorJobView & {
  readonly kind: "runtime.reflect_turn";
  readonly payload: ReflectTurnJobPayload;
};

function isReflection(job: CoordinatorJobView): job is ReflectionJob {
  return job.kind === "runtime.reflect_turn";
}

function experimentId(job: CoordinatorJobView): string | undefined {
  return isReflection(job) ? resultExperimentId(job) : stringField(job.payload, "experimentId");
}

function stage(job: CoordinatorJobView): TuiLearningActivitySummary["stage"] {
  if (job.kind === "runtime.reflect_turn") return "reflection";
  if (job.kind === "runtime.author_revision") return "authoring";
  return "preflight";
}

function status(job: CoordinatorJobView): TuiLearningActivitySummary["status"] {
  if (job.job.status === "scheduled") return "queued";
  if (job.job.status === "running") return "running";
  if (job.job.status !== "completed") return "failed";
  if (job.kind !== "runtime.reflect_turn") return "completed";
  const resultStatus = stringField(job.job.result, "status");
  if (
    resultStatus === "no_change" ||
    resultStatus === "adjusted" ||
    resultStatus === "replaced" ||
    resultStatus === "unapplied" ||
    resultStatus === "stale"
  )
    return resultStatus;
  return "completed";
}

function activeSummary(job: CoordinatorJobView): string {
  const state = job.job.status === "scheduled" ? "Queued" : "Running";
  if (job.kind === "runtime.reflect_turn") return `${state} reflection on the completed turn`;
  if (job.kind === "runtime.author_revision") return `${state} candidate revision authoring`;
  return `${state} candidate preflight`;
}

function completedSummary(job: CoordinatorJobView): string {
  const resultStatus = stringField(job.job.result, "status");
  if (job.kind === "runtime.reflect_turn") {
    if (resultStatus === "no_change")
      return stringField(job.job.result, "reason") ?? "Reflection found no useful change";
    if (resultStatus === "deduped") return "Reflection matched an existing experiment";
    if (resultStatus === "adjusted" || resultStatus === "replaced")
      return (
        stringField(job.job.result, "rationale") ??
        (resultStatus === "replaced"
          ? "Reflection replaced the project working adjustment"
          : "Reflection applied a project working adjustment")
      );
    if (resultStatus === "unapplied")
      return stringField(job.job.result, "reason") ?? "Reflection unapplied the project working adjustment";
    if (resultStatus === "stale") return "Reflection left newer project adjustment state unchanged";
    return "Reflection proposed an experiment";
  }
  if (job.kind === "runtime.author_revision") return "Candidate revision authored";
  const decision = stringField(job.job.result, "decision");
  return decision ? `Preflight decision: ${decision.replaceAll("_", " ")}` : "Candidate preflight completed";
}

function summary(job: CoordinatorJobView): string {
  if (job.job.status === "scheduled" || job.job.status === "running") return activeSummary(job);
  if (job.job.status === "completed") return completedSummary(job);
  return job.job.lastError?.message ?? `Learning job ${job.job.status.replaceAll("_", " ")}`;
}

function candidateRevision(job: CoordinatorJobView): UnknownRecord | undefined {
  if (!isRecord(job.job.result)) return undefined;
  const value = job.job.result["candidateRevision"];
  return isRecord(value) ? value : undefined;
}

function activity(job: CoordinatorJobView): TuiLearningActivitySummary {
  const candidate = candidateRevision(job);
  const experiment = experimentId(job);
  const candidateCapabilityId = stringField(candidate, "capabilityId");
  const candidateRevisionId = stringField(candidate, "capabilityRevisionId");
  const projectId =
    stringField(job.job.result, "projectId") ??
    (isReflection(job) ? job.payload.turn.project?.projectId : undefined);
  const expectedAdjustmentId = isReflection(job) ? job.payload.turn.expectedActiveAdjustmentId : undefined;
  const adjustmentId =
    stringField(job.job.result, "adjustmentId") ??
    (typeof expectedAdjustmentId === "string" ? expectedAdjustmentId : undefined);
  const activeAdjustmentId = stringField(job.job.result, "activeAdjustmentId");
  const failed =
    job.job.status === "failed" || job.job.status === "cancelled" || job.job.status === "budget_exhausted";
  return Object.freeze({
    jobId: job.job.jobId,
    stage: stage(job),
    status: status(job),
    summary: summary(job),
    updatedAt: job.job.updatedAt,
    ...(isReflection(job) ? { turnId: job.payload.turn.turnId } : {}),
    ...(experiment ? { experimentId: experiment } : {}),
    ...(isReflection(job)
      ? { capabilityId: job.payload.capability.capabilityId }
      : candidateCapabilityId
        ? { capabilityId: candidateCapabilityId }
        : {}),
    ...(candidateRevisionId ? { capabilityRevisionId: candidateRevisionId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(adjustmentId ? { adjustmentId } : {}),
    ...(activeAdjustmentId ? { activeAdjustmentId } : {}),
    ...(failed && job.job.lastError ? { failure: job.job.lastError.message } : {}),
  });
}

export interface WorkingAdjustmentInspectionSource {
  readonly workingAdjustments: WorkingAdjustmentReadPort;
  readonly outcomes: {
    readonly get: (outcomeId: string) => Promise<OutcomeRecord | undefined>;
  };
}

const SERVED_EVIDENCE_LIMIT = 8;
const EVIDENCE_SUMMARY_CHARACTERS = 500;

function boundedSummary(summary: string): string {
  if (summary.length <= EVIDENCE_SUMMARY_CHARACTERS) return summary;
  return `${summary.slice(0, EVIDENCE_SUMMARY_CHARACTERS - 1)}…`;
}

async function workingAdjustmentState(
  projectId: string,
  adjustmentId: string,
  source: WorkingAdjustmentInspectionSource,
): Promise<TuiLearningActivitySummary["workingAdjustment"]> {
  const adjustment = await source.workingAdjustments.get(adjustmentId);
  if (!adjustment) return undefined;
  if (adjustment.scope.projectId !== projectId)
    throw new Error(
      `Working adjustment ${adjustment.adjustmentId} belongs to project ${adjustment.scope.projectId}, not ${projectId}`,
    );
  const [active, settledEvidence] = await Promise.all([
    source.workingAdjustments.getActive(projectId),
    source.workingAdjustments.listSettledEvidence({
      projectId,
      adjustmentId: adjustment.adjustmentId,
      limit: SERVED_EVIDENCE_LIMIT,
    }),
  ]);
  return await inspectedWorkingAdjustmentState(
    adjustment,
    active?.adjustmentId === adjustment.adjustmentId ? "active" : "inactive",
    settledEvidence,
    source,
  );
}

async function inspectedWorkingAdjustmentState(
  adjustment: WorkingAdjustment,
  status: TuiWorkingAdjustmentState["status"],
  settledEvidence: Awaited<ReturnType<WorkingAdjustmentReadPort["listSettledEvidence"]>>,
  source: WorkingAdjustmentInspectionSource,
): Promise<TuiWorkingAdjustmentState> {
  const servedEvidence = Object.freeze(
    (
      await Promise.all(
        settledEvidence.slice(0, SERVED_EVIDENCE_LIMIT).map(async (served) => {
          const outcome = await source.outcomes.get(served.outcomeId);
          if (!outcome) return undefined;
          return Object.freeze({
            planId: served.planId,
            sessionId: served.sessionId,
            turnId: served.turnId,
            outcomeId: served.outcomeId,
            outcome: outcome.status,
            summary: boundedSummary(outcome.summary),
            settledAt: served.settledAt,
          });
        }),
      )
    ).filter((evidence) => evidence !== undefined),
  );
  return Object.freeze({
    adjustmentId: adjustment.adjustmentId,
    projectId: adjustment.scope.projectId,
    status,
    strategy: adjustment.strategy,
    successSignal: adjustment.successSignal,
    servedEvidence,
  });
}

async function currentWorkingAdjustmentState(
  projectId: string,
  source: WorkingAdjustmentInspectionSource,
): Promise<TuiWorkingAdjustmentState | undefined> {
  const active = await source.workingAdjustments.getActive(projectId);
  if (!active) return undefined;
  if (active.scope.projectId !== projectId)
    throw new Error(
      `Active working adjustment ${active.adjustmentId} belongs to project ${active.scope.projectId}, not ${projectId}`,
    );
  const settledEvidence = await source.workingAdjustments.listSettledEvidence({
    projectId,
    adjustmentId: active.adjustmentId,
    limit: SERVED_EVIDENCE_LIMIT,
  });
  return await inspectedWorkingAdjustmentState(active, "active", settledEvidence, source);
}

/** Enriches learning jobs from the authoritative adjustment and settled-outcome stores. */
export async function enrichLearningActivityWithWorkingAdjustments(
  activities: readonly TuiLearningActivitySummary[],
  source: WorkingAdjustmentInspectionSource,
): Promise<readonly TuiLearningActivitySummary[]> {
  const stateByKey = new Map<string, Promise<TuiLearningActivitySummary["workingAdjustment"]>>();
  return Object.freeze(
    await Promise.all(
      activities.map(async (entry) => {
        const inspectedAdjustmentId =
          entry.status === "stale" && entry.activeAdjustmentId
            ? entry.activeAdjustmentId
            : entry.adjustmentId;
        let state: TuiLearningActivitySummary["workingAdjustment"];
        if (entry.projectId && inspectedAdjustmentId) {
          const key = `${entry.projectId}:${inspectedAdjustmentId}`;
          const pending =
            stateByKey.get(key) ?? workingAdjustmentState(entry.projectId, inspectedAdjustmentId, source);
          stateByKey.set(key, pending);
          state = await pending;
        }
        return state ? Object.freeze({ ...entry, workingAdjustment: state }) : entry;
      }),
    ),
  );
}

/** Combines session-local learning jobs with the current authoritative project adjustment. */
export async function loadLearningInspectionForSession(
  coordinator: Pick<RuntimeCoordinator, "listJobPage">,
  sessionId: string,
  projectId: string,
  inspection: WorkingAdjustmentInspectionSource,
): Promise<TuiLearningInspection> {
  const [activity, currentWorkingAdjustment] = await Promise.all([
    loadLearningActivityForSession(coordinator, sessionId, inspection),
    currentWorkingAdjustmentState(projectId, inspection),
  ]);
  const deduplicated = currentWorkingAdjustment
    ? Object.freeze(
        activity.map((entry) => {
          if (entry.workingAdjustment?.adjustmentId !== currentWorkingAdjustment.adjustmentId) return entry;
          const { workingAdjustment: _workingAdjustment, ...withoutDuplicateState } = entry;
          return Object.freeze(withoutDuplicateState);
        }),
      )
    : activity;
  return Object.freeze({
    activity: deduplicated,
    ...(currentWorkingAdjustment ? { currentWorkingAdjustment } : {}),
  });
}

/** Projects authoritative coordinator jobs into one session's quiet learning activity view. */
export function learningActivityForSession(
  jobs: readonly CoordinatorJobView[],
  sessionId: string,
  observedChildJobIds: ReadonlySet<string> = new Set(),
): readonly TuiLearningActivitySummary[] {
  const reflections = jobs.filter(
    (job): job is ReflectionJob => isReflection(job) && job.payload.turn.sessionId === sessionId,
  );
  const experimentIds = new Set(
    reflections.flatMap((job) => {
      const id = resultExperimentId(job);
      return id ? [id] : [];
    }),
  );
  return Object.freeze(
    jobs
      .filter((job) => {
        if (isReflection(job)) return job.payload.turn.sessionId === sessionId;
        if (observedChildJobIds.has(job.job.jobId)) return true;
        const sourceSessionId = stringField(job.payload, "sourceSessionId");
        if (sourceSessionId !== undefined) return false;
        return experimentIds.has(stringField(job.payload, "experimentId") ?? "");
      })
      .map(activity)
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.jobId.localeCompare(right.jobId),
      ),
  );
}

const JOB_PAGE_SIZE = 1_000;
const EXPERIMENT_QUERY_CHUNK_SIZE = 250;

async function listAllScopedJobs(
  coordinator: Pick<RuntimeCoordinator, "listJobPage">,
  request: Readonly<{
    kind: CoordinatorJobKind;
    sessionId?: string;
    experimentIds?: readonly string[];
  }>,
): Promise<readonly CoordinatorJobView[]> {
  const jobs: CoordinatorJobView[] = [];
  let after: { readonly createdAt: string; readonly jobId: string } | undefined;
  while (true) {
    const page = await coordinator.listJobPage({
      ...request,
      limit: JOB_PAGE_SIZE,
      ...(after ? { after } : {}),
    });
    jobs.push(...page.jobs);
    if (page.exhausted) return Object.freeze(jobs);
    if (!page.nextCursor)
      throw new Error(`Non-exhausted ${request.kind} job page did not provide an authoritative cursor`);
    after = page.nextCursor;
  }
}

function chunks<Value>(values: readonly Value[], size: number): readonly (readonly Value[])[] {
  const result: Value[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return Object.freeze(result.map((chunk) => Object.freeze(chunk)));
}

/** Reads complete coordinator job chains before applying the pure session projection above. */
export async function loadLearningActivityForSession(
  coordinator: Pick<RuntimeCoordinator, "listJobPage">,
  sessionId: string,
  inspection?: WorkingAdjustmentInspectionSource,
): Promise<readonly TuiLearningActivitySummary[]> {
  const reflections = await listAllScopedJobs(coordinator, {
    kind: "runtime.reflect_turn",
    sessionId,
  });
  const sessionChildren = await Promise.all(
    (["runtime.author_revision", "runtime.preflight"] as const).map(
      async (kind) => await listAllScopedJobs(coordinator, { kind, sessionId }),
    ),
  );
  const experimentIds = Object.freeze(
    [
      ...new Set([
        ...reflections.flatMap((job) => resultExperimentId(job) ?? []),
        ...sessionChildren.flat().flatMap((job) => experimentId(job) ?? []),
      ]),
    ].sort(),
  );
  const linked: CoordinatorJobView[] = [];
  for (const experimentChunk of chunks(experimentIds, EXPERIMENT_QUERY_CHUNK_SIZE)) {
    const chunkJobs = await Promise.all(
      (["runtime.author_revision", "runtime.preflight"] as const).map(
        async (kind) =>
          await listAllScopedJobs(coordinator, {
            kind,
            experimentIds: experimentChunk,
          }),
      ),
    );
    linked.push(
      ...chunkJobs.flat().filter((job) => stringField(job.payload, "sourceSessionId") === undefined),
    );
  }
  const uniqueLinked = new Map(
    [...sessionChildren.flat(), ...linked].map((job) => [job.job.jobId, job] as const),
  );
  const activity = learningActivityForSession(
    [...reflections, ...uniqueLinked.values()],
    sessionId,
    new Set(sessionChildren.flat().map((job) => job.job.jobId)),
  );
  return inspection ? await enrichLearningActivityWithWorkingAdjustments(activity, inspection) : activity;
}
