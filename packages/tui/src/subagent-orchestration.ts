import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { createConditionalObject } from "@noesis/domain";
import type { SubAgentInspection, SubAgentRuntimeEvent } from "@noesis/agent-types";
import { createAgentViewOverlay } from "./agent-view.ts";
import type { NoesisView } from "./rendering.ts";
import type { NoesisTuiRuntime } from "./runtime-port.ts";
import { isActiveSubAgent, siblingAgents } from "./state.ts";
import { startWorkingAnimation } from "./working-animation.ts";

/** Say who reported and when the foreground agent will actually see it. */
export function foregroundMessageNotice(
  event: Extract<SubAgentRuntimeEvent, { readonly type: "message" }>,
  state: {
    readonly trailId?: string;
    readonly subAgents: readonly Pick<SubAgentInspection, "agentId" | "name">[];
    readonly interaction: { readonly phase: string; readonly queuePaused: boolean };
  },
): string {
  const name = state.subAgents.find((agent) => agent.agentId === event.agentId)?.name ?? "A subagent";
  const what = event.kind === "completion" ? `${name} finished` : `${name} sent a message`;
  if (event.recipient.id !== state.trailId) return `${what} · reported to the session that asked`;
  if (state.interaction.phase !== "idle") return `${what} · the agent sees it at its next step`;
  if (state.interaction.queuePaused) return `${what} · it reaches the agent with your next message`;
  return `${what} · resuming the agent`;
}

export interface TuiSubAgentOrchestration {
  /** Opens an agent's transcript; `nested` keeps the current agent as the Esc destination. */
  readonly open: (agentId: string, options?: { readonly nested?: boolean }) => void;
  /** Esc: return to the agent this one was opened from, or to the session. */
  readonly back: () => void;
  /** Left/Right: open the previous or next agent in strip order. */
  readonly cycle: (direction: "previous" | "next") => void;
  readonly maxScroll: () => number;
  readonly hideOverlay: () => void;
  readonly dispose: () => void;
}

export function createTuiSubAgentOrchestration(options: {
  readonly runtime: NoesisTuiRuntime;
  readonly view: NoesisView;
  readonly tui: TUI;
  readonly height: () => number;
  readonly reportFailure: (cause: unknown) => void;
}): TuiSubAgentOrchestration {
  const { view, tui } = options;
  let disposed = false;
  let maxScroll = 0;
  // Reads can overlap when lifecycle events arrive while one is in flight; only the newest applies.
  let hydration = 0;
  let handle: OverlayHandle | undefined;
  const overlay = createAgentViewOverlay(
    () => view.state,
    options.height,
    (next) => {
      maxScroll = next;
    },
  );
  const hideOverlay = (): void => {
    handle?.hide();
    handle = undefined;
  };
  const hydrate = async (agentId: string): Promise<void> => {
    const generation = ++hydration;
    const current = (): boolean =>
      !disposed && generation === hydration && view.state.agentView?.agentId === agentId;
    try {
      const [inspection, transcript] = await Promise.all([
        options.runtime.inspectSubAgent(agentId),
        options.runtime.getSubAgentTranscript(agentId),
      ]);
      if (!current()) return;
      const failure = inspection.tasks.at(-1)?.error;
      view.dispatch(
        createConditionalObject({
          type: "agent-view-hydrated",
          agentId,
          transcript,
          systemPrompt: inspection.systemPrompt,
        } as const)
          .addOptional(failure ? { taskError: failure } : undefined)
          .finish(),
      );
      tui.requestRender();
    } catch (cause) {
      if (current()) options.reportFailure(cause);
    }
  };
  const show = (agentId: string, parents: readonly string[]): void => {
    maxScroll = 0;
    view.dispatch({ type: "agent-view-opened", agentId, parents });
    // Non-capturing: the session's input listener routes keys, and the composer keeps its draft.
    handle ??= tui.showOverlay(overlay, { anchor: "top-left", width: "100%", nonCapturing: true });
    tui.requestRender();
    void hydrate(agentId);
  };
  const open: TuiSubAgentOrchestration["open"] = (agentId, openOptions = {}) => {
    const current = view.state.agentView;
    if (current?.agentId === agentId) return;
    const parents =
      current && openOptions.nested ? [...current.parents, current.agentId] : (current?.parents ?? []);
    show(agentId, parents);
  };
  const back = (): void => {
    const current = view.state.agentView;
    if (!current) return;
    const parent = current.parents.at(-1);
    if (parent) {
      show(parent, current.parents.slice(0, -1));
      return;
    }
    view.dispatch({ type: "agent-view-closed" });
    hideOverlay();
    tui.requestRender();
  };
  const cycle = (direction: "previous" | "next"): void => {
    const current = view.state.agentView;
    if (!current) return;
    const siblings = siblingAgents(view.state, current.agentId);
    if (siblings.length < 2) return;
    const index = siblings.findIndex((agent) => agent.agentId === current.agentId);
    const offset = direction === "next" ? 1 : -1;
    const next = siblings[(Math.max(0, index) + offset + siblings.length) % siblings.length];
    if (next) show(next.agentId, current.parents);
  };
  const refresh = async (): Promise<void> => {
    const subAgents = await options.runtime.listSubAgents();
    if (disposed) return;
    view.dispatch({ type: "subagents-hydrated", subAgents });
    tui.requestRender();
  };
  const onEvent = (event: SubAgentRuntimeEvent): void => {
    if (disposed) return;
    if (event.type === "live") {
      view.dispatch({
        type: "subagent-live-event",
        agentId: event.agentId,
        event: event.event,
        at: Date.now(),
      });
      tui.requestRender();
      return;
    }
    if (event.type === "reminder-delivered") {
      if (event.sessionId === view.state.trailId) {
        view.dispatch({ type: "collaboration-delivered", text: event.text });
        tui.requestRender();
      }
      return;
    }
    if (event.type === "message" && event.status === "accepted" && event.recipient.kind === "foreground")
      view.dispatch({
        type: "notification-shown",
        text: foregroundMessageNotice(event, view.state),
        tone: "info",
      });
    void refresh().catch(options.reportFailure);
    if (view.state.agentView?.agentId === event.agentId) void hydrate(event.agentId);
  };
  const removeListener = options.runtime.subscribeSubAgents(onEvent);
  // Agents keep their own clock: elapsed time and the pulse advance even while the session idles.
  const stopClock = startWorkingAnimation(
    () => !disposed && view.state.subAgents.some(isActiveSubAgent),
    () => {
      view.dispatch({ type: "agents-ticked", now: Date.now() });
      tui.requestRender();
    },
  );
  void refresh().catch(options.reportFailure);
  return Object.freeze({
    open,
    back,
    cycle,
    maxScroll: () => maxScroll,
    hideOverlay,
    dispose: () => {
      disposed = true;
      stopClock();
      hideOverlay();
      removeListener();
    },
  });
}
