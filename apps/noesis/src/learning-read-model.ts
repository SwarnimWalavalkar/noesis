// biome-ignore-all lint/complexity/useLiteralKeys: unknown durable job results require bracket access under noPropertyAccessFromIndexSignature.
import type {
  CoordinatorJobKind,
  CoordinatorJobView,
  ReflectTurnJobPayload,
  RuntimeCoordinator,
} from "@noesis/runtime";
import type { TuiLearningActivitySummary } from "@noesis/tui";

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
  return job.kind === "runtime.reflect_turn" && stringField(job.job.result, "status") === "no_change"
    ? "no_change"
    : "completed";
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
    ...(failed && job.job.lastError ? { failure: job.job.lastError.message } : {}),
  });
}

/** Projects authoritative coordinator jobs into one session's quiet learning activity view. */
export function learningActivityForSession(
  jobs: readonly CoordinatorJobView[],
  sessionId: string,
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
      .filter(
        (job) =>
          (isReflection(job) && job.payload.turn.sessionId === sessionId) ||
          (!isReflection(job) && experimentIds.has(stringField(job.payload, "experimentId") ?? "")),
      )
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
): Promise<readonly TuiLearningActivitySummary[]> {
  const reflections = await listAllScopedJobs(coordinator, {
    kind: "runtime.reflect_turn",
    sessionId,
  });
  const experimentIds = Object.freeze(
    [...new Set(reflections.flatMap((job) => resultExperimentId(job) ?? []))].sort(),
  );
  const linked = await Promise.all(
    chunks(experimentIds, EXPERIMENT_QUERY_CHUNK_SIZE).flatMap((experimentChunk) =>
      (["runtime.author_revision", "runtime.preflight"] as const).map(
        async (kind) =>
          await listAllScopedJobs(coordinator, {
            kind,
            experimentIds: experimentChunk,
          }),
      ),
    ),
  );
  return learningActivityForSession([...reflections, ...linked.flat()], sessionId);
}
