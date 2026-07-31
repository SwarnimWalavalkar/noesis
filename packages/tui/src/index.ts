import {
  Container,
  matchesKey,
  ProcessTerminal,
  type OverlayHandle,
  type Terminal,
  TUI,
} from "@earendil-works/pi-tui";
import type { RuntimeTranscriptEntry, TrailState } from "@noesis/runtime";
import { executionIdOf } from "./action-summary.ts";
import { isExclusiveSlashCommand, runSlashCommand } from "./commands.ts";
import {
  createHeaderView,
  createHelpView,
  createInputLabelView,
  createNoesisView,
  createRunInspectorOverlay,
  createStaticLineView,
  createStatusView,
} from "./rendering.ts";
import type { NoesisTuiRuntime } from "./runtime-port.ts";
import { createSafeEditor, createSelectTheme } from "./safe-editor.ts";
import {
  createResponsiveSessionPicker,
  createSessionPickerItems,
  resumableTrail,
  type TuiStartOptions,
} from "./session-picker.ts";
import { initialTuiState, timelineActions } from "./state.ts";
import { ANSI, safeTerminalText, shouldUseColor, styled } from "./theme.ts";

export * from "./action-summary.ts";
export * from "./commands.ts";
export * from "./onboarding.ts";
export * from "./rendering.ts";
export * from "./runtime-port.ts";
export * from "./safe-editor.ts";
export * from "./session-picker.ts";
export * from "./state.ts";

const SHUTDOWN_GRACE_MS = 250;
const INSPECTOR_PREVIEW_CHARACTERS = 24_000;
const INSPECTOR_PAGE_ROWS = 10;

export function boundedInspectorText(text: string): string {
  const safe = safeTerminalText(text);
  if (safe.length <= INSPECTOR_PREVIEW_CHARACTERS) return safe;
  return `${safe.slice(0, INSPECTOR_PREVIEW_CHARACTERS)}\n\n… inspector preview truncated`;
}

export function streamingFrameDelay(activeCharacters: number, pendingCharacters: number): number {
  const total = Math.max(0, activeCharacters) + Math.max(0, pendingCharacters);
  return Math.min(80, 16 + Math.floor(total / 4_000) * 8);
}

type ShutdownSettlement =
  | { readonly status: "settled" }
  | { readonly status: "rejected"; readonly error: unknown }
  | { readonly status: "timed-out" };

export async function startNoesisTui(
  runtime: NoesisTuiRuntime,
  options: TuiStartOptions = {},
  terminal: Terminal = new ProcessTerminal(),
): Promise<void> {
  const requestedSession = options.session ?? { mode: "new" };
  const session =
    requestedSession.mode === "continue"
      ? (() => {
          const latest = runtime.listTrailSummaries()[0];
          if (!latest)
            throw new Error(
              `No saved sessions were found in ${runtime.home ?? "the configured Noesis home"}. Start a new session with noesis (without --continue).`,
            );
          return { mode: "resume" as const, trailId: latest.trailId };
        })()
      : requestedSession;
  const tui = new TUI(terminal);
  // The transcript grows without bound so history reaches native terminal scrollback. Clearing on
  // shrink would emit an erase-scrollback sequence whenever a block collapses or a streamed
  // message reconciles shorter, destroying that history.
  tui.setClearOnShrink(false);
  const root = new Container();
  const requestedProvider = options.provider ?? runtime.agentDefaults.provider;
  const requestedModel = options.model ?? runtime.agentDefaults.model;
  const requestedReasoning = options.thinkingLevel ?? runtime.agentDefaults.thinkingLevel;
  const colorEnabled =
    terminal instanceof ProcessTerminal && shouldUseColor(process.env) && process.stdout.hasColors();
  const selectTheme = createSelectTheme(colorEnabled);
  const view = createNoesisView(
    initialTuiState(runtime.agentName ?? "runtime", {
      provider: requestedProvider,
      model: requestedModel,
      reasoningLevel: requestedReasoning,
      colorEnabled,
    }),
    () => terminal.rows,
  );
  const editor = createSafeEditor(tui, colorEnabled, selectTheme, () => terminal.rows);
  const headerView = createHeaderView(colorEnabled, () => terminal.rows);
  let inspectorMaxScroll = 0;
  const inspectorOverlay = createRunInspectorOverlay(
    view,
    () => terminal.rows,
    (maxScroll) => {
      inspectorMaxScroll = maxScroll;
    },
  );
  let inspectorHandle: OverlayHandle | undefined;
  const statusView = createStatusView(view, () => terminal.rows);
  const inputLabelView = createInputLabelView(colorEnabled, () => terminal.rows);
  const helpView = createHelpView(view, () => terminal.rows);
  let phase: "picker" | "main" | "stopped" = session.mode === "pick" ? "picker" : "main";
  let activeTurn: Promise<void> | undefined;
  let activeExclusiveCommand: Promise<boolean> | undefined;
  let turnGeneration = 0;
  let inspectorGeneration = 0;
  interface ActiveTurnToken {
    readonly generation: number;
    readonly trailId: string;
  }
  let activeTurnToken: ActiveTurnToken | undefined;
  let pendingStream: { readonly token: ActiveTurnToken; readonly text: string } | undefined;
  let streamRenderTimer: NodeJS.Timeout | undefined;
  let streamRenderTimerToken: ActiveTurnToken | undefined;
  const isCurrentTurn = (token: ActiveTurnToken): boolean =>
    phase === "main" && activeTurnToken === token && token.generation === turnGeneration;
  const flushStreamDelta = (token: ActiveTurnToken): void => {
    if (streamRenderTimer && streamRenderTimerToken !== token) return;
    if (streamRenderTimer) clearTimeout(streamRenderTimer);
    streamRenderTimer = undefined;
    streamRenderTimerToken = undefined;
    if (!isCurrentTurn(token) || pendingStream?.token !== token || !pendingStream.text) return;
    const text = pendingStream.text;
    pendingStream = undefined;
    view.dispatch({ type: "stream-delta", text });
    tui.requestRender();
  };
  const queueStreamDelta = (token: ActiveTurnToken, text: string): void => {
    if (!isCurrentTurn(token) || !text) return;
    pendingStream = {
      token,
      text: `${pendingStream?.token === token ? pendingStream.text : ""}${text}`,
    };
    if (streamRenderTimer) return;
    const currentEntry = view.state.timeline.at(-1);
    const activeCharacters =
      currentEntry?.kind === "message" && currentEntry.role === "assistant" ? currentEntry.text.length : 0;
    streamRenderTimer = setTimeout(
      () => flushStreamDelta(token),
      streamingFrameDelay(activeCharacters, pendingStream.text.length),
    );
    streamRenderTimerToken = token;
  };
  let removeExitInputListener = (): void => undefined;
  let terminalStopped = false;
  let cancelPicker: (() => void) | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let resolveShutdown: (() => void) | undefined;
  let rejectShutdown: ((error: unknown) => void) | undefined;
  const shutdownCompleted = new Promise<void>((resolve, reject) => {
    resolveShutdown = resolve;
    rejectShutdown = reject;
  });
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      phase = "stopped";
      turnGeneration += 1;
      inspectorGeneration += 1;
      activeTurnToken = undefined;
      inspectorHandle?.hide();
      inspectorHandle = undefined;
      if (streamRenderTimer) clearTimeout(streamRenderTimer);
      streamRenderTimer = undefined;
      streamRenderTimerToken = undefined;
      pendingStream = undefined;
      editor.disableSubmit = true;
      editor.onSubmit = (): void => undefined;
      removeExitInputListener();
      try {
        await terminal.drainInput(1_000);
      } finally {
        if (!terminalStopped) {
          terminalStopped = true;
          tui.stop();
        }
      }
      const trailId = view.state.trailId;
      const turn = activeTurn;
      const exclusiveCommand = activeExclusiveCommand;
      let shutdownFailure: { readonly error: unknown } | undefined;
      if (turn && trailId) {
        const abortAndSettle = (async () => {
          await runtime.abort(trailId);
          await turn;
        })().then<ShutdownSettlement, ShutdownSettlement>(
          () => ({ status: "settled" }),
          (error: unknown) => ({ status: "rejected", error }),
        );
        let graceTimer: NodeJS.Timeout | undefined;
        // Terminal ownership is already released. Give a cooperative runtime a brief chance to
        // settle, then detach the abortable turn: a broken runtime must not keep the CLI lifecycle
        // pending forever.
        const settlement = await Promise.race<ShutdownSettlement>([
          abortAndSettle,
          new Promise<ShutdownSettlement>((resolve) => {
            graceTimer = setTimeout(() => resolve({ status: "timed-out" }), SHUTDOWN_GRACE_MS);
            graceTimer.unref();
          }),
        ]);
        if (graceTimer) clearTimeout(graceTimer);
        if (settlement.status === "rejected") shutdownFailure = { error: settlement.error };
        if (settlement.status === "timed-out") {
          // The detached turn may still settle later; the mapped promise observes its rejection.
          void abortAndSettle;
        }
      }
      // Exclusive commands have no cancellation primitive. They remain shutdown-owned after the
      // terminal is released so runtime shutdown cannot race an in-flight mutation.
      if (exclusiveCommand) {
        try {
          await exclusiveCommand;
        } catch (error) {
          shutdownFailure ??= { error };
        }
      }
      if (shutdownFailure) throw shutdownFailure.error;
    })();
    shutdownPromise.then(resolveShutdown, rejectShutdown);
    return shutdownPromise;
  };

  const closeRunInspector = (): void => {
    inspectorMaxScroll = 0;
    view.dispatch({ type: "inspector-closed" });
    inspectorHandle?.hide();
    inspectorHandle = undefined;
    tui.requestRender();
  };

  const openRunInspector = (actionId: string): void => {
    inspectorMaxScroll = 0;
    view.dispatch({ type: "inspector-opened", actionId });
    inspectorHandle ??= tui.showOverlay(inspectorOverlay, {
      anchor: "center",
      width: "90%",
    });
    tui.requestRender();
    const trailId = view.state.trailId;
    const action = timelineActions(view.state.timeline).find((candidate) => candidate.actionId === actionId);
    const executionId = action ? executionIdOf(action) : undefined;
    const settle = (detail?: Awaited<ReturnType<NonNullable<typeof runtime.inspectExecution>>>): void => {
      inspectorMaxScroll = 0;
      view.dispatch({
        type: "inspector-loaded",
        actionId,
        ...(detail ? { detail } : {}),
      });
      tui.requestRender();
    };
    if (!trailId || !executionId || !runtime.inspectExecution) {
      settle();
      return;
    }
    void runtime.inspectExecution(trailId, executionId).then(
      (detail) => settle(detail),
      () => settle(),
    );
  };

  /** Read-only keyboard navigation over transcript actions; the editor keeps input otherwise. */
  const handleTranscriptKey = (data: string): boolean => {
    const state = view.state;
    if (state.inspector) {
      if (matchesKey(data, "escape")) {
        closeRunInspector();
        return true;
      }
      if (matchesKey(data, "up"))
        view.dispatch({
          type: "inspector-scrolled",
          delta: -1,
          maxScroll: inspectorMaxScroll,
        });
      else if (matchesKey(data, "down"))
        view.dispatch({
          type: "inspector-scrolled",
          delta: 1,
          maxScroll: inspectorMaxScroll,
        });
      else if (matchesKey(data, "pageUp"))
        view.dispatch({
          type: "inspector-scrolled",
          delta: -INSPECTOR_PAGE_ROWS,
          maxScroll: inspectorMaxScroll,
        });
      else if (matchesKey(data, "pageDown"))
        view.dispatch({
          type: "inspector-scrolled",
          delta: INSPECTOR_PAGE_ROWS,
          maxScroll: inspectorMaxScroll,
        });
      tui.requestRender();
      return true;
    }
    if (state.actionCursor) {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+o"))
        view.dispatch({ type: "action-cursor-cleared" });
      else if (matchesKey(data, "up")) view.dispatch({ type: "action-cursor-moved", direction: "previous" });
      else if (matchesKey(data, "down")) view.dispatch({ type: "action-cursor-moved", direction: "next" });
      else if (matchesKey(data, "space"))
        view.dispatch({
          type: "action-expansion-toggled",
          actionId: state.actionCursor,
        });
      else if (matchesKey(data, "enter")) {
        openRunInspector(state.actionCursor);
        return true;
      }
      tui.requestRender();
      return true;
    }
    if (matchesKey(data, "ctrl+o")) {
      view.dispatch({ type: "action-cursor-moved", direction: "previous" });
      tui.requestRender();
      return true;
    }
    return false;
  };

  removeExitInputListener = tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      cancelPicker?.();
      void shutdown();
      return { consume: true };
    }
    if (phase !== "main") return undefined;
    if (handleTranscriptKey(data)) return { consume: true };
    if (data === "\n" && editor.getText().trim() === "/quit") {
      void shutdown();
      return { consume: true };
    }
    return undefined;
  });
  editor.onSubmit = (text) => {
    const submittedTrailId = view.state.trailId;
    let ownedTrailId = submittedTrailId;
    const normalizedInput = text.trim();
    if (!submittedTrailId || !normalizedInput) return;
    if (normalizedInput === "/quit") {
      void shutdown();
      return;
    }
    if (activeExclusiveCommand) {
      view.dispatch({
        type: "system-message",
        text: "A command is active. Wait for it to finish before submitting another command or prompt.",
      });
      tui.requestRender();
      return;
    }
    inspectorGeneration += 1;
    const submittedInspectorGeneration = inspectorGeneration;
    const isCurrentSubmission = (): boolean =>
      phase === "main" &&
      inspectorGeneration === submittedInspectorGeneration &&
      view.state.trailId === ownedTrailId;
    const publishInspector = (message: string): void => {
      if (!isCurrentSubmission() || activeTurn) return;
      view.dispatch({
        type: "system-message",
        text: boundedInspectorText(message),
      });
      tui.requestRender();
    };
    void (async () => {
      if (activeTurn) {
        if (normalizedInput === "/abort") {
          view.dispatch({ type: "execution-changed", execution: "aborting" });
          tui.requestRender();
          // Keep ABORTING observable for one throttled TUI render frame before a cooperative runtime settles.
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          await runtime.abort(submittedTrailId);
        } else {
          view.dispatch({
            type: "system-message",
            text: "A turn is active. Use /abort to stop it before submitting another command.",
          });
          tui.requestRender();
        }
        return;
      }
      if (normalizedInput === "/abort") {
        view.dispatch({ type: "system-message", text: "No turn is active." });
        tui.requestRender();
        return;
      }
      let handled = false;
      if (normalizedInput === "?" || normalizedInput.startsWith("/")) {
        const exclusiveCommand = isExclusiveSlashCommand(normalizedInput);
        const commandWork = runSlashCommand(normalizedInput, {
          runtime,
          trailId: submittedTrailId,
          publishInspector,
          dispatch: (action) => {
            if (!isCurrentSubmission()) return;
            view.dispatch(action);
            if (action.type === "trail-selected") ownedTrailId = action.trail.trailId;
          },
          requestRender: () => {
            if (isCurrentSubmission()) tui.requestRender();
          },
        });
        if (exclusiveCommand) activeExclusiveCommand = commandWork;
        try {
          handled = await commandWork;
        } finally {
          if (activeExclusiveCommand === commandWork) activeExclusiveCommand = undefined;
        }
      }
      if (handled) return;

      view.dispatch({ type: "prompt-submitted", text });
      tui.requestRender();
      const trailId = view.state.trailId;
      if (!trailId) return;
      turnGeneration += 1;
      const token: ActiveTurnToken = { generation: turnGeneration, trailId };
      const actionIdForView = (actionId: string): string => `${String(token.generation)}:${actionId}`;
      activeTurnToken = token;
      const turn = (async () => {
        try {
          const result = await runtime.runTurn(trailId, text, {
            ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
            onEvent: (event) => {
              if (!isCurrentTurn(token)) return;
              if (event.type === "delta") {
                queueStreamDelta(token, event.text);
                return;
              } else if (event.type === "tool-start") {
                flushStreamDelta(token);
                view.dispatch({
                  type: "action-started",
                  actionId: actionIdForView(event.actionId),
                  ...(event.parentActionId ? { parentActionId: actionIdForView(event.parentActionId) } : {}),
                  name: event.name,
                  input: event.input,
                  at: Date.now(),
                });
              } else if (event.type === "tool-update") {
                flushStreamDelta(token);
                view.dispatch({
                  type: "action-updated",
                  actionId: actionIdForView(event.actionId),
                  update: event.update,
                });
              } else if (event.type === "tool-end") {
                flushStreamDelta(token);
                view.dispatch({
                  type: "action-ended",
                  actionId: actionIdForView(event.actionId),
                  output: event.result,
                  isError: event.isError,
                  at: Date.now(),
                });
              } else if (event.type === "model") {
                flushStreamDelta(token);
                view.dispatch({
                  type: "model-metadata",
                  provider: event.provider,
                  model: event.model,
                  contextWindow: event.contextWindow,
                });
              } else if (event.type === "usage") {
                flushStreamDelta(token);
                view.dispatch({
                  type: "usage-updated",
                  usedTokens: event.usedTokens,
                  contextWindow: event.contextWindow,
                  accuracy: event.accuracy,
                });
              } else if (event.type === "status" && event.status === "started") {
                flushStreamDelta(token);
                view.dispatch({
                  type: "execution-changed",
                  execution: "thinking",
                });
              } else if (event.type === "status" && event.status === "aborted") {
                flushStreamDelta(token);
                view.dispatch({ type: "execution-changed", execution: "idle" });
              } else if (event.type === "status" && event.status === "failed") {
                flushStreamDelta(token);
                view.dispatch({
                  type: "failed",
                  error: safeTerminalText(event.error),
                });
              }
              tui.requestRender();
            },
          });
          flushStreamDelta(token);
          if (!isCurrentTurn(token)) return;
          // Intermediate tool-loop messages are useful while a turn is live, but durable runtime
          // output is authoritative at settlement and replaces the current assistant block exactly.
          view.dispatch({
            type: "stream-reconciled",
            text: safeTerminalText(result.output),
          });
          if (result.outcome === "aborted") {
            view.dispatch({ type: "turn-aborted" });
            view.dispatch({ type: "system-message", text: "Turn aborted." });
          } else {
            view.dispatch({
              type: "turn-completed",
              context: result.context,
              capabilityVersions: result.usedCapabilities,
              turnCount: runtime.getTrail(trailId).turns.length,
              ...(result.contextUsage ? { contextUsage: result.contextUsage } : {}),
            });
          }
        } catch (error) {
          flushStreamDelta(token);
          if (!isCurrentTurn(token)) return;
          view.dispatch({
            type: "failed",
            error: safeTerminalText(error instanceof Error ? error.message : String(error)),
          });
        } finally {
          if (activeTurnToken === token) {
            activeTurnToken = undefined;
            pendingStream = undefined;
            if (streamRenderTimer) clearTimeout(streamRenderTimer);
            streamRenderTimer = undefined;
            streamRenderTimerToken = undefined;
            tui.requestRender();
          }
        }
      })();
      activeTurn = turn;
      await turn;
      if (activeTurn === turn) activeTurn = undefined;
    })().catch((error: unknown) => {
      if (!isCurrentSubmission()) return;
      view.dispatch({
        type: "failed",
        error: safeTerminalText(error instanceof Error ? error.message : String(error)),
      });
      tui.requestRender();
    });
  };
  tui.addChild(root);
  const loadTranscript = async (trail: TrailState): Promise<readonly RuntimeTranscriptEntry[]> =>
    runtime.getTranscript(trail.trailId);
  const mountMain = (trail: TrailState, transcript: readonly RuntimeTranscriptEntry[]): void => {
    phase = "main";
    cancelPicker = undefined;
    inspectorHandle?.hide();
    inspectorHandle = undefined;
    view.dispatch({ type: "trail-selected", trail });
    view.dispatch({
      type: "transcript-hydrated",
      trailId: trail.trailId,
      transcript,
    });
    root.clear();
    root.addChild(headerView);
    root.addChild(view);
    root.addChild(inputLabelView);
    root.addChild(editor);
    root.addChild(statusView);
    root.addChild(helpView);
    tui.setFocus(editor);
    tui.requestRender();
  };

  if (session.mode === "pick") {
    const items = createSessionPickerItems(runtime.listTrailSummaries());
    if (items.length === 0)
      throw new Error(
        `No saved sessions were found in ${runtime.home ?? "the configured Noesis home"}. Start a new session with noesis (without --resume).`,
      );
    const picker = createResponsiveSessionPicker(items, () => terminal.rows, selectTheme);
    const selected = new Promise<string | undefined>((resolve) => {
      let settled = false;
      const finish = (trailId: string | undefined): void => {
        if (settled) return;
        settled = true;
        resolve(trailId);
      };
      cancelPicker = () => finish(undefined);
      picker.onSelect = (item) => finish(item.value);
      picker.onCancel = () => {
        finish(undefined);
        void shutdown();
      };
    });
    root.addChild(
      createStaticLineView(
        `${styled(colorEnabled, `${ANSI.bold}${ANSI.cyan}`, "NOESIS")}  ${styled(
          colorEnabled,
          ANSI.dim,
          "resume a session",
        )}`,
        () => terminal.rows >= 2,
      ),
    );
    root.addChild(
      createStaticLineView(
        styled(colorEnabled, ANSI.dim, "↑/↓ navigate · Enter resume · Esc cancel"),
        () => terminal.rows >= 3,
      ),
    );
    root.addChild(picker);
    tui.setFocus(picker);
    tui.start();
    const trailId = await selected;
    if (!trailId) {
      await shutdown();
      await shutdownCompleted;
      return;
    }
    try {
      const trail = await resumableTrail(runtime, trailId);
      mountMain(trail, await loadTranscript(trail));
    } catch (error) {
      await shutdown();
      throw error;
    }
  } else {
    const trail =
      session.mode === "resume"
        ? await resumableTrail(runtime, session.trailId)
        : await runtime.startTrail({
            title: "Noesis session",
            provider: requestedProvider,
            model: requestedModel,
          });
    mountMain(trail, await loadTranscript(trail));
    tui.start();
  }
  await shutdownCompleted;
}
