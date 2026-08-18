import type { RuntimeTranscriptEntry, TrailState } from "@noesis/runtime";
import type { TuiLearningActivitySummary } from "./runtime-port.ts";
import type { NoesisTuiAction, TuiContextUsage } from "./state.ts";
import { safeTerminalText } from "./theme.ts";

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

interface LearningActivityLoad {
  readonly activities: readonly TuiLearningActivitySummary[];
  readonly failure?: Readonly<{ readonly error: unknown }>;
}

const noLearningActivity: readonly TuiLearningActivitySummary[] = Object.freeze([]);
const MAX_DIAGNOSTIC_LENGTH = 240;

export interface SettledTurnPresentationRequest {
  readonly trailId: string;
  readonly turnId: string;
  readonly outcome: "completed" | "aborted" | "failed";
  readonly contextUsage: TuiContextUsage | undefined;
}

export interface SettledTurnPresentation {
  readonly actions: readonly NoesisTuiAction[];
  readonly pendingReflectionJobId?: string;
  readonly learningFocusId?: string;
  readonly learningActivityFailure?: Readonly<{ readonly error: unknown }>;
}

export function learningAuditFocusId(activity: TuiLearningActivitySummary): string {
  if (activity.capabilityId) return `capability:${activity.capabilityId}`;
  if (activity.stage === "reflection" && (activity.status === "unapplied" || activity.status === "stale"))
    return `reflection:${activity.jobId}`;
  if (activity.adjustmentId) return `working_adjustment:${activity.adjustmentId}`;
  if (activity.experimentId) return `experiment:${activity.experimentId}`;
  if (activity.stage === "reflection") return `reflection:${activity.jobId}`;
  return `job:${activity.jobId}`;
}

export function workingAdjustmentNotice(activity: TuiLearningActivitySummary): string | undefined {
  if (activity.status === "activated") return `Capability active · ${activity.summary}`;
  if (activity.status === "revised") return `Capability updated · ${activity.summary}`;
  if (activity.status === "pending") return `Capability needs a decision · ${activity.summary}`;
  if (activity.status === "paused") return `Capability paused · ${activity.summary}`;
  if (activity.status === "restored") return `Capability restored · ${activity.summary}`;
  if (activity.status === "binding_changed") return `Capability settings updated · ${activity.summary}`;
  if (activity.status === "adjusted" || activity.status === "replaced") {
    const strategy = activity.workingAdjustment?.strategy;
    return `adjusted · ${activity.summary}${strategy ? `\nstrategy · ${strategy}` : ""}`;
  }
  if (activity.status === "unapplied") return `unapplied · ${activity.summary}`;
  if (activity.status === "stale") return `unchanged · ${activity.summary}`;
  return undefined;
}

/** Keep an auxiliary learning failure visible without turning a settled foreground turn into an error. */
export function learningDiagnosticNotice(error: unknown): string {
  let message = "";
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    // Unknown rejection values may not support string conversion. The diagnostic must remain nonfatal.
  }
  const detail = safeTerminalText(message).replaceAll("\n", " ").slice(0, MAX_DIAGNOSTIC_LENGTH);
  return `learning · unavailable${detail ? ` · ${detail}` : ""}`;
}

/** Run the single exact-job late refresh without making the TUI root own job orchestration. */
export function startLateLearningNoticeRefresh(
  runtime: LateLearningRefreshRuntime,
  request: Readonly<{
    trailId: string;
    jobId: string;
    onNotice: (notice: string, focusId: string) => void;
    onFailure: (error: unknown) => void;
    onError: (error: unknown) => void;
  }>,
): void {
  if (!runtime.waitForLearningActivity) return;
  void runtime
    .waitForLearningActivity(request.trailId, request.jobId)
    .then((activity) => {
      if (!activity) return;
      const notice = workingAdjustmentNotice(activity);
      if (notice) request.onNotice(notice, learningAuditFocusId(activity));
    }, request.onFailure)
    .catch(request.onError);
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
  const learningActivity: Promise<LearningActivityLoad> = runtime.listLearningActivity
    ? runtime.listLearningActivity(request.trailId).then(
        (activities) => Object.freeze({ activities }),
        (error: unknown) =>
          Object.freeze({
            activities: noLearningActivity,
            failure: Object.freeze({ error }),
          }),
      )
    : Promise.resolve(Object.freeze({ activities: noLearningActivity }));
  const [transcript, trail, learning] = await Promise.all([
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
  const learningNotice = workingAdjustmentNoticeForTurn(learning.activities, request.turnId);
  if (learningNotice)
    actions.push({
      type: "notification-shown",
      text: learningNotice,
      tone: learningNotice.startsWith("Capability needs") ? "attention" : "success",
    });
  const focusActivity = learning.activities.find(
    (activity) => activity.turnId === request.turnId && workingAdjustmentNotice(activity) !== undefined,
  );
  const pendingReflectionJobId = learning.activities.find(
    (activity) =>
      activity.turnId === request.turnId &&
      activity.stage === "reflection" &&
      (activity.status === "queued" || activity.status === "running"),
  )?.jobId;
  return Object.freeze({
    actions: Object.freeze(actions),
    ...(pendingReflectionJobId ? { pendingReflectionJobId } : {}),
    ...(focusActivity ? { learningFocusId: learningAuditFocusId(focusActivity) } : {}),
    ...(learning.failure ? { learningActivityFailure: learning.failure } : {}),
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
    reportDiagnostic: (error: unknown) => void;
    reportFailure: (error: unknown) => void;
    rememberLearningFocus?: (recordId: string) => void;
  }>,
): void {
  void settledTurnPresentation(runtime, request)
    .then((presentation) => {
      const currentTrail = host.isTrailCurrent();
      if (currentTrail && presentation.pendingReflectionJobId)
        startLateLearningNoticeRefresh(runtime, {
          trailId: request.trailId,
          jobId: presentation.pendingReflectionJobId,
          onNotice: (notice, focusId) => {
            if (!host.isTrailCurrent()) return;
            host.dispatch({
              type: "notification-shown",
              text: notice,
              tone: notice.startsWith("Capability needs") ? "attention" : "success",
            });
            host.rememberLearningFocus?.(focusId);
            host.requestRender();
          },
          onFailure: (error) => {
            if (host.isTrailCurrent()) host.reportDiagnostic(error);
          },
          onError: (error) => {
            if (host.isTrailCurrent()) host.reportFailure(error);
          },
        });
      if (!currentTrail || !host.canApplySettledState()) {
        if (currentTrail && request.outcome === "completed") {
          for (const action of presentation.actions) {
            if (action.type === "system-message" || action.type === "notification-shown")
              host.dispatch(action);
          }
          host.requestRender();
        }
        if (currentTrail && presentation.learningFocusId)
          host.rememberLearningFocus?.(presentation.learningFocusId);
        if (currentTrail && presentation.learningActivityFailure)
          host.reportDiagnostic(presentation.learningActivityFailure.error);
        return;
      }
      for (const action of presentation.actions) host.dispatch(action);
      if (presentation.learningFocusId) host.rememberLearningFocus?.(presentation.learningFocusId);
      host.requestRender();
      if (presentation.learningActivityFailure)
        host.reportDiagnostic(presentation.learningActivityFailure.error);
    })
    .catch((error: unknown) => {
      if (host.isTrailCurrent()) host.reportFailure(error);
    });
}
