import { createConditionalObject } from "@noesis/domain";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { executionIdOf } from "./action-summary.ts";
import { createRunInspectorOverlay, type NoesisView } from "./rendering.ts";
import type { NoesisTuiRuntime } from "./runtime-port.ts";
import { timelineActions, type TuiAgentAction } from "./state.ts";

export function createTuiInspectorOrchestration(options: {
  readonly runtime: NoesisTuiRuntime;
  readonly view: NoesisView;
  readonly tui: TUI;
  readonly height: () => number;
}) {
  let maxScroll = 0;
  let handle: OverlayHandle | undefined;
  const overlay = createRunInspectorOverlay(options.view, options.height, (nextMaxScroll) => {
    maxScroll = nextMaxScroll;
  });
  const showOverlay = (): void => {
    handle ??= options.tui.showOverlay(overlay, { anchor: "center", width: "90%" });
    options.tui.requestRender();
  };
  const hideOverlay = (): void => {
    handle?.hide();
    handle = undefined;
  };
  const close = (): void => {
    maxScroll = 0;
    options.view.dispatch({ type: "inspector-closed" });
    hideOverlay();
    options.tui.requestRender();
  };
  const openSynthetic = (actionId: string, syntheticAction: TuiAgentAction): void => {
    options.view.dispatch({ type: "inspector-opened", actionId, syntheticAction });
    showOverlay();
  };
  const openRun = (actionId: string): void => {
    maxScroll = 0;
    options.view.dispatch({ type: "inspector-opened", actionId });
    showOverlay();
    const trailId = options.view.state.trailId;
    const action = timelineActions(options.view.state.timeline).find(
      (candidate) => candidate.actionId === actionId,
    );
    const executionId = action ? executionIdOf(action) : undefined;
    const settle = (
      detail?: Awaited<ReturnType<NonNullable<typeof options.runtime.inspectExecution>>>,
    ): void => {
      maxScroll = 0;
      options.view.dispatch(
        createConditionalObject({ type: "inspector-loaded", actionId } as const)
          .addOptional(detail ? { detail } : undefined)
          .finish(),
      );
      options.tui.requestRender();
    };
    if (!trailId || !executionId || !options.runtime.inspectExecution) {
      settle();
      return;
    }
    void options.runtime.inspectExecution(trailId, executionId).then(
      (detail) => settle(detail),
      () => settle(),
    );
  };
  return Object.freeze({
    close,
    hideOverlay,
    maxScroll: () => maxScroll,
    openRun,
    openSynthetic,
  });
}
