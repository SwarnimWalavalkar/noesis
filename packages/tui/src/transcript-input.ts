import { matchesKey, type TUI } from "@earendil-works/pi-tui";
import { boundAgent } from "./agent-presentation.ts";
import type { NoesisView } from "./rendering.ts";
import { timelineActions } from "./state.ts";

const PAGE_ROWS = 10;

/**
 * Routes keys while navigation owns input. The layout is spatial: transcript actions sit above the
 * agent strip, which sits above the composer, so arrows move between them without a mode toggle.
 * An opened agent is a read-only transcript with the same keys plus Left/Right to switch agents.
 */
export function createTranscriptInputHandler(options: {
  readonly tui: TUI;
  readonly view: NoesisView;
  readonly inspectorMaxScroll: () => number;
  readonly agentViewMaxScroll: () => number;
  readonly openRunInspector: (actionId: string) => void;
  readonly openAgent: (agentId: string, options?: { readonly nested?: boolean }) => void;
  readonly closeAgent: () => void;
  readonly cycleAgent: (direction: "previous" | "next") => void;
  readonly closeRunInspector: () => void;
}): (data: string) => boolean {
  const { view } = options;
  const render = (): true => {
    options.tui.requestRender();
    return true;
  };
  /** Enter on an `agents.*` row opens that agent; any other row opens the run inspector. */
  const openAction = (
    actionId: string,
    timeline: Parameters<typeof timelineActions>[0],
    nested: boolean,
  ): void => {
    const action = timelineActions(timeline).find((candidate) => candidate.actionId === actionId);
    const agent = action ? boundAgent(action, view.state.subAgents) : undefined;
    if (agent) options.openAgent(agent.agentId, { nested });
    else options.openRunInspector(actionId);
  };
  return (data) => {
    const state = view.state;
    if (state.inspector) {
      const maxScroll = options.inspectorMaxScroll();
      if (matchesKey(data, "escape")) {
        options.closeRunInspector();
        return true;
      }
      if (matchesKey(data, "up")) view.dispatch({ type: "inspector-scrolled", delta: -1, maxScroll });
      else if (matchesKey(data, "down")) view.dispatch({ type: "inspector-scrolled", delta: 1, maxScroll });
      else if (matchesKey(data, "pageUp"))
        view.dispatch({ type: "inspector-scrolled", delta: -PAGE_ROWS, maxScroll });
      else if (matchesKey(data, "pageDown"))
        view.dispatch({ type: "inspector-scrolled", delta: PAGE_ROWS, maxScroll });
      else if (matchesKey(data, "space")) view.dispatch({ type: "inspector-view-toggled" });
      // Unmatched keys are consumed: the editor is paused while the inspector owns the keyboard.
      else return true;
      return render();
    }

    const agentView = state.agentView;
    if (agentView) {
      const maxScroll = options.agentViewMaxScroll();
      if (matchesKey(data, "escape")) {
        if (agentView.actionCursor) view.dispatch({ type: "agent-view-cursor-cleared" });
        else options.closeAgent();
        return render();
      }
      if (matchesKey(data, "up")) view.dispatch({ type: "agent-view-cursor-moved", direction: "previous" });
      else if (matchesKey(data, "down")) {
        if (agentView.actionCursor) view.dispatch({ type: "agent-view-cursor-moved", direction: "next" });
        // Paging scrolls the followed transcript; while an action is selected the window follows it.
      } else if (!agentView.actionCursor && matchesKey(data, "pageUp"))
        view.dispatch({ type: "agent-view-scrolled", delta: PAGE_ROWS, maxScroll });
      else if (!agentView.actionCursor && matchesKey(data, "pageDown"))
        view.dispatch({ type: "agent-view-scrolled", delta: -PAGE_ROWS, maxScroll });
      else if (matchesKey(data, "left")) options.cycleAgent("previous");
      else if (matchesKey(data, "right")) options.cycleAgent("next");
      else if (matchesKey(data, "space")) view.dispatch({ type: "agent-view-expansion-toggled" });
      else if (data === "s") view.dispatch({ type: "agent-view-system-prompt-toggled" });
      else if (matchesKey(data, "enter")) {
        if (agentView.actionCursor) openAction(agentView.actionCursor, agentView.timeline, true);
      } else return true;
      return render();
    }

    if (state.subAgentCursor) {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+o")) {
        view.dispatch({ type: "action-cursor-cleared" });
        return render();
      }
      if (matchesKey(data, "up")) view.dispatch({ type: "navigation-moved", direction: "previous" });
      else if (matchesKey(data, "down")) view.dispatch({ type: "navigation-moved", direction: "next" });
      else if (matchesKey(data, "space")) view.dispatch({ type: "agent-strip-toggled" });
      else if (data === "a") view.dispatch({ type: "agent-strip-scope-toggled" });
      else if (matchesKey(data, "enter")) {
        options.openAgent(state.subAgentCursor);
        return true;
      } else return true;
      return render();
    }

    if (state.actionCursor) {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+o")) {
        view.dispatch({ type: "action-cursor-cleared" });
        return render();
      }
      if (matchesKey(data, "up")) view.dispatch({ type: "navigation-moved", direction: "previous" });
      else if (matchesKey(data, "down")) view.dispatch({ type: "navigation-moved", direction: "next" });
      else if (matchesKey(data, "space"))
        view.dispatch({ type: "action-expansion-toggled", actionId: state.actionCursor });
      else if (matchesKey(data, "enter")) {
        openAction(state.actionCursor, state.timeline, false);
        return true;
        // Unmatched keys are consumed: typing is disabled while keys navigate the transcript.
      } else return true;
      return render();
    }

    if (!matchesKey(data, "ctrl+o")) return false;
    view.dispatch({ type: "navigation-entered" });
    return render();
  };
}
