import { Container, ProcessTerminal, TUI, matchesKey, type Terminal } from "@earendil-works/pi-tui";
import type { TrailState } from "@noesis/runtime";
import { createSafeEditor, createSelectTheme } from "./safe-editor.ts";
import {
  ANSI,
  createHelpView,
  createInputLabelView,
  createNoesisView,
  createStaticLineView,
  createStatusView,
  safeTerminalText,
  shouldUseColor,
  styled,
} from "./rendering.ts";
import type { NoesisTuiRuntime } from "./runtime-port.ts";
import {
  createResponsiveSessionPicker,
  createSessionPickerItems,
  resumableTrail,
  type TuiStartOptions,
} from "./session-picker.ts";
import { initialTuiState } from "./state.ts";

export * from "./runtime-port.ts";
export * from "./state.ts";
export * from "./rendering.ts";
export * from "./safe-editor.ts";
export * from "./session-picker.ts";

const SHUTDOWN_GRACE_MS = 250;

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
  const statusView = createStatusView(view, () => terminal.rows);
  const inputLabelView = createInputLabelView(colorEnabled, () => terminal.rows);
  const helpView = createHelpView(colorEnabled, () => terminal.rows);
  let phase: "picker" | "main" | "stopped" = session.mode === "pick" ? "picker" : "main";
  let activeTurn: Promise<void> | undefined;
  let turnGeneration = 0;
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
    const activeCharacters =
      view.state.messages.at(-1)?.role === "assistant" ? (view.state.messages.at(-1)?.text.length ?? 0) : 0;
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
      activeTurnToken = undefined;
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
      if (activeTurn && trailId) {
        const turn = activeTurn;
        const abortAndSettle = (async () => {
          await runtime.abort(trailId);
          await turn;
        })();
        let graceTimer: NodeJS.Timeout | undefined;
        // Terminal ownership is already released. Give a cooperative runtime a brief chance to
        // settle, then detach: a broken runtime must not keep the CLI lifecycle pending forever.
        const settlement = await Promise.race<ShutdownSettlement>([
          abortAndSettle.then<ShutdownSettlement, ShutdownSettlement>(
            () => ({ status: "settled" }),
            (error: unknown) => ({ status: "rejected", error }),
          ),
          new Promise<ShutdownSettlement>((resolve) => {
            graceTimer = setTimeout(() => resolve({ status: "timed-out" }), SHUTDOWN_GRACE_MS);
            graceTimer.unref();
          }),
        ]);
        if (graceTimer) clearTimeout(graceTimer);
        if (settlement.status === "rejected") throw settlement.error;
        if (settlement.status === "timed-out") {
          // The detached operation may still reject later; observe it without extending shutdown.
          void abortAndSettle.catch(() => undefined);
        }
      }
    })();
    shutdownPromise.then(resolveShutdown, rejectShutdown);
    return shutdownPromise;
  };
  removeExitInputListener = tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      cancelPicker?.();
      void shutdown();
      return { consume: true };
    }
    if (phase === "main" && data === "\n" && editor.getText().trim() === "/quit") {
      void shutdown();
      return { consume: true };
    }
    return undefined;
  });
  editor.onSubmit = (text) => {
    void (async () => {
      if (!view.state.trailId || !text.trim()) return;
      if (text === "/quit") {
        await shutdown();
        return;
      }
      if (activeTurn) {
        if (text.trim() === "/abort") {
          view.dispatch({ type: "execution-changed", execution: "aborting" });
          tui.requestRender();
          // Keep ABORTING observable for one throttled TUI render frame before a cooperative runtime settles.
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          await runtime.abort(view.state.trailId);
        } else {
          view.dispatch({
            type: "system-message",
            text: "A turn is active. Use /abort to stop it before submitting another command.",
          });
          tui.requestRender();
        }
        return;
      }
      if (text === "/context") {
        view.dispatch({ type: "pane-selected", pane: "context" });
        tui.requestRender();
        return;
      }
      if (text === "/capabilities") {
        view.dispatch({ type: "pane-selected", pane: "capabilities" });
        tui.requestRender();
        return;
      }
      if (text === "?" || text === "/help") {
        view.dispatch({
          type: "system-message",
          text: [
            "/model provider/model · /context · /capabilities · /fork · /compact · /abort",
            "/quit · learning, experiments, activation, and revert run ambiently",
          ].join("\n"),
        });
        tui.requestRender();
        return;
      }
      if (text === "/abort") {
        view.dispatch({ type: "system-message", text: "No turn is active." });
        tui.requestRender();
        return;
      }
      if (text === "/compact") {
        view.dispatch({ type: "execution-changed", execution: "compacting" });
        tui.requestRender();
        await runtime.compact(view.state.trailId);
        view.dispatch({ type: "compacted" });
        view.dispatch({ type: "system-message", text: "Trail compacted." });
        tui.requestRender();
        return;
      }
      if (text === "/fork") {
        const trail = await runtime.forkTrail(view.state.trailId);
        view.dispatch({ type: "trail-selected", trail });
        tui.requestRender();
        return;
      }
      if (text.startsWith("/model ")) {
        const selection = text.slice(7).trim();
        const separator = selection.indexOf("/");
        if (separator <= 0 || separator === selection.length - 1) {
          view.dispatch({ type: "failed", error: "Use /model provider/model" });
        } else {
          const trail = await runtime.startTrail({
            title: `Model ${selection}`,
            provider: selection.slice(0, separator),
            model: selection.slice(separator + 1),
          });
          view.dispatch({ type: "trail-selected", trail });
        }
        tui.requestRender();
        return;
      }
      view.dispatch({ type: "prompt-submitted", text });
      tui.requestRender();
      const trailId = view.state.trailId;
      if (!trailId) return;
      turnGeneration += 1;
      const token: ActiveTurnToken = { generation: turnGeneration, trailId };
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
                view.dispatch({ type: "tool-started", name: event.name });
              } else if (event.type === "tool-end") {
                flushStreamDelta(token);
                view.dispatch({ type: "tool-ended" });
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
                view.dispatch({ type: "execution-changed", execution: "thinking" });
              } else if (event.type === "status" && event.status === "aborted") {
                flushStreamDelta(token);
                view.dispatch({ type: "execution-changed", execution: "idle" });
              } else if (event.type === "status" && event.status === "failed") {
                flushStreamDelta(token);
                view.dispatch({ type: "failed", error: safeTerminalText(event.error) });
              }
              tui.requestRender();
            },
          });
          flushStreamDelta(token);
          if (!isCurrentTurn(token)) return;
          // Intermediate tool-loop messages are useful while a turn is live, but durable runtime
          // output is authoritative at settlement and replaces the current assistant block exactly.
          view.dispatch({ type: "stream-reconciled", text: safeTerminalText(result.output) });
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
      view.dispatch({
        type: "failed",
        error: safeTerminalText(error instanceof Error ? error.message : String(error)),
      });
      tui.requestRender();
    });
  };
  tui.addChild(root);
  const mountMain = (trail: TrailState): void => {
    phase = "main";
    cancelPicker = undefined;
    view.dispatch({ type: "trail-selected", trail });
    root.clear();
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
      mountMain(await resumableTrail(runtime, trailId));
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
    mountMain(trail);
    tui.start();
  }
  await shutdownCompleted;
}
