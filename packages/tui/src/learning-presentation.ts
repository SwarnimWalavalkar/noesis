import type { RuntimeTranscriptEntry, TrailState } from "@noesis/runtime";
import type { TuiLearningActivitySummary } from "./runtime-port.ts";
import type { NoesisTuiAction, TuiContextUsage } from "./state.ts";

interface SettledTurnPresentationRuntime {
  readonly getTranscript: (trailId: string) => Promise<readonly RuntimeTranscriptEntry[]>;
  readonly getTrail: (trailId: string) => TrailState | Promise<TrailState>;
  readonly listLearningActivity?: (trailId: string) => Promise<readonly TuiLearningActivitySummary[]>;
}

interface LateLearningRefreshRuntime {
  readonly waitForLearningActivity?: (
    trailId: string,
    jobId: string,
  ) => Promise<TuiLearningActivitySummary | undefined>;
}

export interface SettledTurnPresentationRequest {
  readonly trailId: string;
  readonly turnId: string;
  readonly outcome: "completed" | "aborted" | "failed";
  readonly contextUsage: TuiContextUsage | undefined;
}

export interface SettledTurnPresentation {
  readonly actions: readonly NoesisTuiAction[];
  readonly pendingReflectionJobId?: string;
}

export function workingAdjustmentNotice(activity: TuiLearningActivitySummary): string | undefined {
  if (activity.status === "adjusted" || activity.status === "replaced") {
    const strategy = activity.workingAdjustment?.strategy;
    return `adjusted · ${activity.summary}${strategy ? `\nstrategy · ${strategy}` : ""}`;
  }
  if (activity.status === "unapplied") return `unapplied · ${activity.summary}`;
  if (activity.status === "stale") return `unchanged · ${activity.summary}`;
  return undefined;
}

/** Run the single exact-job late refresh without making the TUI root own job orchestration. */
export function startLateLearningNoticeRefresh(
  runtime: LateLearningRefreshRuntime,
  request: Readonly<{
    trailId: string;
    jobId: string;
    onNotice: (notice: string) => void;
    onError: (error: unknown) => void;
  }>,
): void {
  if (!runtime.waitForLearningActivity) return;
  void runtime.waitForLearningActivity(request.trailId, request.jobId).then((activity) => {
    if (!activity) return;
    const notice = workingAdjustmentNotice(activity);
    if (notice) request.onNotice(notice);
  }, request.onError);
}

/** Present the first user-visible working-adjustment outcome for a settled turn. */
export function workingAdjustmentNoticeForTurn(
  activities: readonly TuiLearningActivitySummary[],
  turnId: string,
): string | undefined {
  return activities
    .filter((activity) => activity.turnId === turnId)
    .map(workingAdjustmentNotice)
    .find((notice) => notice !== undefined);
}

/** Load authoritative settled state and project it into the actions rendered by the TUI. */
export async function settledTurnPresentation(
  runtime: SettledTurnPresentationRuntime,
  request: SettledTurnPresentationRequest,
): Promise<SettledTurnPresentation> {
  const learningActivity = runtime.listLearningActivity
    ? runtime.listLearningActivity(request.trailId)
    : Promise.resolve(Object.freeze([]));
  const [transcript, trail, activities] = await Promise.all([
    runtime.getTranscript(request.trailId),
    Promise.resolve(runtime.getTrail(request.trailId)),
    learningActivity,
  ]);
  const actions: NoesisTuiAction[] = [{ type: "transcript-hydrated", trailId: request.trailId, transcript }];
  if (request.outcome === "completed" && trail.context)
    actions.push({
      type: "turn-completed",
      context: trail.context,
      capabilityVersions: trail.capabilityVersions,
      turnCount: trail.turns.length,
      ...(request.contextUsage ? { contextUsage: request.contextUsage } : {}),
    });
  else if (request.outcome === "aborted")
    actions.push(
      { type: "execution-changed", execution: "idle" },
      { type: "system-message", text: "Turn interrupted." },
    );
  const learningNotice = workingAdjustmentNoticeForTurn(activities, request.turnId);
  if (learningNotice) actions.push({ type: "system-message", text: learningNotice });
  const pendingReflectionJobId = activities.find(
    (activity) =>
      activity.turnId === request.turnId &&
      activity.stage === "reflection" &&
      (activity.status === "queued" || activity.status === "running"),
  )?.jobId;
  if (pendingReflectionJobId) actions.push({ type: "system-message", text: "learning · reviewing..." });
  return Object.freeze({
    actions: Object.freeze(actions),
    ...(pendingReflectionJobId ? { pendingReflectionJobId } : {}),
  });
}

/** Reconcile one settled turn and its optional one-shot late learning result. */
export function reconcileSettledTurnPresentation(
  runtime: SettledTurnPresentationRuntime & LateLearningRefreshRuntime,
  request: SettledTurnPresentationRequest,
  host: Readonly<{
    isTrailCurrent: () => boolean;
    canApplySettledState: () => boolean;
    dispatch: (action: NoesisTuiAction) => void;
    requestRender: () => void;
    reportFailure: (error: unknown) => void;
  }>,
): void {
  void settledTurnPresentation(runtime, request).then(
    (presentation) => {
      const currentTrail = host.isTrailCurrent();
      if (currentTrail && presentation.pendingReflectionJobId)
        startLateLearningNoticeRefresh(runtime, {
          trailId: request.trailId,
          jobId: presentation.pendingReflectionJobId,
          onNotice: (notice) => {
            if (!host.isTrailCurrent()) return;
            host.dispatch({ type: "system-message", text: notice });
            host.requestRender();
          },
          onError: (error) => {
            if (host.isTrailCurrent()) host.reportFailure(error);
          },
        });
      if (!currentTrail || !host.canApplySettledState()) {
        if (currentTrail && request.outcome === "completed") {
          for (const action of presentation.actions) {
            if (action.type === "system-message") host.dispatch(action);
          }
          host.requestRender();
        }
        return;
      }
      for (const action of presentation.actions) host.dispatch(action);
      host.requestRender();
    },
    (error: unknown) => {
      if (host.isTrailCurrent()) host.reportFailure(error);
    },
  );
}
