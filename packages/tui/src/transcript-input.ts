import { matchesKey, type TUI } from "@earendil-works/pi-tui";
import type { NoesisView } from "./rendering.ts";

const INSPECTOR_PAGE_ROWS = 10;

/** Routes keys shared by the transcript navigator and its nested run inspector. */
export function createTranscriptInputHandler(options: {
  readonly tui: TUI;
  readonly view: NoesisView;
  readonly inspectorMaxScroll: () => number;
  readonly openRunInspector: (actionId: string) => void;
}): (data: string) => boolean {
  return (data) => {
    const state = options.view.state;
    if (state.inspector) {
      const maxScroll = options.inspectorMaxScroll();
      if (matchesKey(data, "up")) options.view.dispatch({ type: "inspector-scrolled", delta: -1, maxScroll });
      else if (matchesKey(data, "down"))
        options.view.dispatch({ type: "inspector-scrolled", delta: 1, maxScroll });
      else if (matchesKey(data, "pageUp"))
        options.view.dispatch({
          type: "inspector-scrolled",
          delta: -INSPECTOR_PAGE_ROWS,
          maxScroll,
        });
      else if (matchesKey(data, "pageDown"))
        options.view.dispatch({
          type: "inspector-scrolled",
          delta: INSPECTOR_PAGE_ROWS,
          maxScroll,
        });
      else if (matchesKey(data, "space")) options.view.dispatch({ type: "inspector-view-toggled" });
      else return false;
      options.tui.requestRender();
      return true;
    }

    if (state.actionCursor) {
      if (matchesKey(data, "ctrl+o")) {
        options.view.dispatch({ type: "action-cursor-cleared" });
        options.tui.requestRender();
        return true;
      }
      if (matchesKey(data, "up"))
        options.view.dispatch({ type: "action-cursor-moved", direction: "previous" });
      else if (matchesKey(data, "down"))
        options.view.dispatch({ type: "action-cursor-moved", direction: "next" });
      else if (matchesKey(data, "space"))
        options.view.dispatch({ type: "action-expansion-toggled", actionId: state.actionCursor });
      else if (matchesKey(data, "enter")) {
        options.openRunInspector(state.actionCursor);
        return true;
      } else return false;
      options.tui.requestRender();
      return true;
    }

    if (!matchesKey(data, "ctrl+o")) return false;
    options.view.dispatch({ type: "action-cursor-moved", direction: "previous" });
    options.tui.requestRender();
    return true;
  };
}
