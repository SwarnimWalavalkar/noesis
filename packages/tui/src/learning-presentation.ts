import { createConditionalObject } from "@noesis/domain";
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
  readonly failure?: Readonly<{
    readonly error: unknown;
  }>;
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
  /** Learning changes for this turn that were already known when the turn settled. */
  readonly settledNoticeCount: number;
  readonly pendingReflectionJobId?: string;
  readonly learningFocusId?: string;
  readonly learningActivityFailure?: Readonly<{
    readonly error: unknown;
  }>;
}
export function learningAuditFocusId(activity: TuiLearningActivitySummary): string {
  if (activity.capabilityId) return `capability:${activity.capabilityId}`;
  return `reflection:${activity.jobId}`;
}
export function learningActivityNotice(activity: TuiLearningActivitySummary): string | undefined {
  const summary = safeTerminalText(activity.summary).replaceAll(/\s+/g, " ").trim();
  if (activity.status === "activated") return `Capability active · ${summary}`;
  if (activity.status === "revised") return `Capability updated · ${summary}`;
  if (activity.status === "pending") return `Capability needs a decision · ${summary}`;
  if (activity.status === "paused") return `Capability paused · ${summary}`;
  if (activity.status === "restored") return `Capability restored · ${summary}`;
  if (activity.status === "binding_changed") return `Capability settings updated · ${summary}`;
  if (activity.status === "stale") return `unchanged · ${summary}`;
  return undefined;
}
/** Learning outcomes carry their own signature tone; structured pending state demands attention. */
export function learningNoticeTone(
  activity: Pick<TuiLearningActivitySummary, "status">,
): "attention" | "learning" {
  return activity.status === "pending" ? "attention" : "learning";
}
/** Keep an auxiliary learning failure visible without turning a settled foreground turn into an error. */
export function learningDiagnosticNotice(cause: unknown): string {
  let message = "";
  try {
    message = cause instanceof Error ? cause.message : String(cause);
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
    /** Changes for the same turn already announced, so the late notice can count them. */
    earlierNotices?: number;
    onNotice: (notice: string, focusId: string, tone: "attention" | "learning") => void;
    onFailure: (cause: unknown) => void;
    onError: (cause: unknown) => void;
  }>,
): void {
  if (!runtime.waitForLearningActivity) return;
  void runtime
    .waitForLearningActivity(request.trailId, request.jobId)
    .then((activity) => {
      if (!activity) return;
      const notice = learningActivityNotice(activity);
      const earlier = request.earlierNotices ?? 0;
      if (notice)
        request.onNotice(
          earlier > 0 ? `${notice} · ${String(earlier)} more in /learning` : notice,
          learningAuditFocusId(activity),
          learningNoticeTone(activity),
        );
    }, request.onFailure)
    .catch(request.onError);
}
/** Present the first user-visible learning outcome for a settled turn. */
export function learningActivityNoticeForTurn(
  activities: readonly TuiLearningActivitySummary[],
  turnId: string,
): string | undefined {
  return activities
    .filter((activity) => activity.turnId === turnId)
    .map(learningActivityNotice)
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
        (cause: unknown) =>
          Object.freeze({
            activities: noLearningActivity,
            failure: Object.freeze({ error: cause }),
          }),
      )
    : Promise.resolve(Object.freeze({ activities: noLearningActivity }));
  const [transcript, trail, learning] = await Promise.all([
    runtime.getTranscript(request.trailId),
    Promise.resolve(runtime.getTrail(request.trailId)),
    learningActivity,
  ]);
  const actions: NoesisTuiAction[] = [
    { type: "transcript-hydrated", trailId: request.trailId, transcript },
    // The agent may have changed the session's title or reasoning level during the turn.
    { type: "session-settings-synced", title: trail.title, reasoningLevel: trail.thinkingLevel },
  ];
  if (request.outcome === "completed" && trail.context)
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    actions.push(
      createConditionalObject({
        type: "turn-completed",
        context: trail.context,
        capabilityVersions: trail.capabilityVersions,
        turnCount: trail.turns.length,
      } as const)
        .addOptional(request.contextUsage ? { contextUsage: request.contextUsage } : undefined)
        .finish(),
    );
  else if (request.outcome === "aborted")
    actions.push(
      { type: "execution-changed", execution: "idle" },
      { type: "system-message", text: "Turn interrupted." },
    );
  // A turn's own reflection waits for the user's reply. This turn's message released the
  // previous turn's reflection, so its result belongs with this turn.
  const releasedByThisTurn = (activity: TuiLearningActivitySummary): boolean =>
    activity.reactionTurnId === request.turnId;
  const notable = learning.activities.filter(
    (activity) =>
      (releasedByThisTurn(activity) || activity.turnId === request.turnId) &&
      learningActivityNotice(activity) !== undefined,
  );
  const focusActivity = notable[0];
  // One notice per turn: the first change, plus how many others /learning holds.
  const firstNotice = focusActivity ? learningActivityNotice(focusActivity) : undefined;
  const learningNotice =
    firstNotice && notable.length > 1
      ? `${firstNotice} · ${String(notable.length - 1)} more in /learning`
      : firstNotice;
  if (focusActivity && learningNotice)
    actions.push({
      type: "notification-shown",
      text: learningNotice,
      tone: learningNoticeTone(focusActivity),
    });
  const pendingReflectionJobId = learning.activities.find(
    (activity) =>
      releasedByThisTurn(activity) &&
      activity.stage === "reflection" &&
      (activity.status === "queued" || activity.status === "running"),
  )?.jobId;
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze(
    createConditionalObject({
      actions: Object.freeze(actions),
      settledNoticeCount: notable.length,
    } as const)
      .addOptional(pendingReflectionJobId ? { pendingReflectionJobId } : undefined)
      .addOptional(focusActivity ? { learningFocusId: learningAuditFocusId(focusActivity) } : undefined)
      .addOptional(learning.failure ? { learningActivityFailure: learning.failure } : undefined)
      .finish(),
  );
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
    reportDiagnostic: (cause: unknown) => void;
    reportFailure: (cause: unknown) => void;
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
          earlierNotices: presentation.settledNoticeCount,
          onNotice: (notice, focusId, tone) => {
            if (!host.isTrailCurrent()) return;
            host.dispatch({
              type: "notification-shown",
              text: notice,
              tone,
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
    .catch((cause: unknown) => {
      if (host.isTrailCurrent()) host.reportFailure(cause);
    });
}
