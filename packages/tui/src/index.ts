import {
  Container,
  matchesKey,
  type OverlayHandle,
  ProcessTerminal,
  type Terminal,
  TUI,
} from "@earendil-works/pi-tui";
import type { RuntimeTranscriptEntry, TrailState } from "@noesis/runtime";
import { executionIdOf } from "./action-summary.ts";
import { tuiActionForAgentEvent } from "./agent-event.ts";
import {
  exclusiveSlashCommandScope,
  isExclusiveSlashCommand,
  runSlashCommand,
  steerFeedback,
} from "./commands.ts";
import { createExclusiveCommandBarrier, type ExclusiveCommandBarrier } from "./exclusive-command-barrier.ts";
import { editTextInExternalEditor } from "./external-editor.ts";
import { learningDiagnosticNotice, reconcileSettledTurnPresentation } from "./learning-presentation.ts";
import { boundedInspectorText, type ShutdownSettlement } from "./lifecycle-utils.ts";
import { createTuiLearningOrchestration } from "./learning.ts";
import { createTuiMcpOrchestration } from "./mcp.ts";
import {
  createHeaderView,
  createHelpView,
  createInputLabelView,
  createNoesisView,
  createQueuedInputsView,
  createRunInspectorOverlay,
  createStaticLineView,
  createStatusView,
} from "./rendering.ts";
import {
  type NoesisTuiRuntime,
  stopVisibleInteraction,
  type TuiInteractionCommand,
  type TuiInteractionEvent,
  type TuiInteractionResult,
  type TuiInteractionSnapshot,
} from "./runtime-port.ts";
import { createSafeEditor, createSelectTheme, enrichEditorSkills } from "./safe-editor.ts";
import {
  createResponsiveSessionPicker,
  createSessionPickerItems,
  resumableTrail,
  type TuiStartOptions,
} from "./session-picker.ts";
import {
  executionForInteractionPhase,
  initialTuiState,
  interactionViewFromSnapshot,
  timelineActions,
} from "./state.ts";
import { createStreamDeltaBuffer } from "./stream-delta-buffer.ts";
import { ANSI, safeTerminalText, shouldUseColor, styled } from "./theme.ts";
export * from "./action-summary.ts";
export * from "./agent-event.ts";
export * from "./commands.ts";
export * from "./external-editor.ts";
export * from "./lifecycle-utils.ts";
export * from "./learning.ts";
export * from "./mcp.ts";
export * from "./onboarding.ts";
export * from "./rendering.ts";
export * from "./runtime-port.ts";
export * from "./safe-editor.ts";
export * from "./session-picker.ts";
export * from "./state.ts";
const SHUTDOWN_GRACE_MS = 250;
const INTERRUPT_FEEDBACK_MS = 20;
const INSPECTOR_PAGE_ROWS = 10;
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
  const reportFailure = (error: unknown): void => {
    view.dispatch({
      type: "failed",
      error: safeTerminalText(error instanceof Error ? error.message : String(error)),
    });
    tui.requestRender();
  };
  const reportLearningDiagnostic = (error: unknown): void => {
    view.dispatch({ type: "system-message", text: learningDiagnosticNotice(error) });
    tui.requestRender();
  };
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
  const mcp = createTuiMcpOrchestration({
    runtime,
    tui,
    colorEnabled,
    height: () => terminal.rows,
    ...(options.mcpInteractionBridge ? { interactionBridge: options.mcpInteractionBridge } : {}),
    ...(options.openUrl ? { openUrl: options.openUrl } : {}),
    mutationsEnabled: () => view.state.interaction.phase === "idle",
    reportUnavailable: (text) => view.dispatch({ type: "system-message", text }),
  });
  const learning = createTuiLearningOrchestration({
    runtime,
    tui,
    colorEnabled,
    height: () => terminal.rows,
    reportUnavailable: (text) => view.dispatch({ type: "system-message", text }),
  });
  const statusView = createStatusView(view, () => terminal.rows);
  const queuedInputsView = createQueuedInputsView(view, () => terminal.rows);
  const inputLabelView = createInputLabelView(colorEnabled, () => terminal.rows);
  const helpView = createHelpView(view, () => terminal.rows);
  let phase: "picker" | "main" | "stopped" = session.mode === "pick" ? "picker" : "main";
  enrichEditorSkills(editor, runtime.listSkills, () => phase !== "stopped");
  let exclusiveCommands: ExclusiveCommandBarrier | undefined;
  let externalEditorActive = false;
  let turnGeneration = 0;
  let inspectorGeneration = 0;
  type ActiveTurnToken = Readonly<{ generation: number; trailId: string; turnId: string }>;
  let activeTurnToken: ActiveTurnToken | undefined;
  const isCurrentTurn = (token: ActiveTurnToken): boolean =>
    phase === "main" &&
    activeTurnToken === token &&
    token.generation === turnGeneration &&
    view.state.trailId === token.trailId;
  const streamDeltas = createStreamDeltaBuffer<ActiveTurnToken>({
    isCurrent: isCurrentTurn,
    activeCharacters: () => {
      const currentEntry = view.state.timeline.at(-1);
      return currentEntry?.kind === "message" && currentEntry.role === "assistant"
        ? currentEntry.text.length
        : 0;
    },
    publish: (text) => {
      view.dispatch({ type: "stream-delta", text });
      tui.requestRender();
    },
  });
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
    const visibleTurnId = view.state.interaction.active?.turnId;
    shutdownPromise = (async () => {
      phase = "stopped";
      turnGeneration += 1;
      inspectorGeneration += 1;
      activeTurnToken = undefined;
      inspectorHandle?.hide();
      inspectorHandle = undefined;
      learning.dispose();
      await mcp.dispose();
      streamDeltas.clear();
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
      const exclusiveCommand = exclusiveCommands?.activeWork();
      let shutdownFailure: { readonly error: unknown } | undefined;
      if (trailId && view.state.interaction.phase !== "idle") {
        const abortAndSettle = runtime
          .interact(trailId, stopVisibleInteraction(visibleTurnId))
          .then<ShutdownSettlement, ShutdownSettlement>(
            () => ({ status: "settled" }),
            (error: unknown) => ({ status: "rejected", error }),
          );
        let graceTimer: NodeJS.Timeout | undefined;
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
          void abortAndSettle;
        }
      }
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
  const handleTranscriptKey = (data: string): boolean => {
    const state = view.state;
    if (state.inspector) {
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
      else if (matchesKey(data, "space")) view.dispatch({ type: "inspector-view-toggled" });
      else return false;
      tui.requestRender();
      return true;
    }
    if (state.actionCursor) {
      if (matchesKey(data, "ctrl+o")) view.dispatch({ type: "action-cursor-cleared" });
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
      } else return false;
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
  const applyInteractionSnapshot = (snapshot: TuiInteractionSnapshot): void => {
    if (view.state.trailId !== snapshot.sessionId) return;
    view.dispatch({
      type: "interaction-changed",
      interaction: interactionViewFromSnapshot(snapshot),
    });
    const execution = executionForInteractionPhase(view.state.execution, snapshot.phase);
    if (execution) view.dispatch({ type: "execution-changed", execution });
    tui.requestRender(snapshot.phase === "interrupting");
  };
  const reconcileSettledTurn = (
    trailId: string,
    turnId: string,
    generation: number,
    outcome: "completed" | "aborted" | "failed",
  ): void => {
    reconcileSettledTurnPresentation(
      runtime,
      { trailId, turnId, outcome, contextUsage: view.state.contextUsage },
      {
        isTrailCurrent: () => phase === "main" && view.state.trailId === trailId,
        canApplySettledState: () => turnGeneration === generation && !activeTurnToken,
        dispatch: (action) => view.dispatch(action),
        requestRender: () => tui.requestRender(),
        reportDiagnostic: reportLearningDiagnostic,
        reportFailure,
      },
    );
  };
  const onInteractionEvent = (interactionEvent: TuiInteractionEvent): void => {
    if (phase !== "main") return;
    if (interactionEvent.type === "state") {
      applyInteractionSnapshot(interactionEvent.snapshot);
      return;
    }
    if (interactionEvent.sessionId !== view.state.trailId) return;
    if (interactionEvent.type === "interaction-failed") {
      reportFailure(interactionEvent.error);
      return;
    }
    if (interactionEvent.type === "turn-started") {
      turnGeneration += 1;
      const token: ActiveTurnToken = {
        generation: turnGeneration,
        trailId: interactionEvent.sessionId,
        turnId: interactionEvent.turnId,
      };
      activeTurnToken = token;
      view.dispatch({ type: "prompt-submitted", text: interactionEvent.text });
      tui.requestRender();
      return;
    }
    if (interactionEvent.type === "steer-delivered") {
      if (activeTurnToken) streamDeltas.flush(activeTurnToken);
      view.dispatch({ type: "steer-delivered", text: interactionEvent.text });
      tui.requestRender();
      return;
    }
    if (interactionEvent.type === "turn-settled") {
      const token = activeTurnToken;
      if (token?.turnId === interactionEvent.turnId) {
        streamDeltas.flush(token);
        activeTurnToken = undefined;
      }
      if (interactionEvent.outcome === "aborted") {
        view.dispatch({ type: "turn-aborted" });
      } else if (interactionEvent.outcome === "failed") {
        reportFailure(interactionEvent.error ?? "Turn failed.");
      }
      reconcileSettledTurn(
        interactionEvent.sessionId,
        interactionEvent.turnId,
        token?.generation ?? turnGeneration,
        interactionEvent.outcome,
      );
      tui.requestRender();
      return;
    }
    const token = activeTurnToken;
    if (!token || token.turnId !== interactionEvent.turnId || !isCurrentTurn(token)) return;
    const event = interactionEvent.event;
    if (event.type === "delta") {
      streamDeltas.queue(token, event.text);
      return;
    }
    streamDeltas.flush(token);
    const action = tuiActionForAgentEvent(event);
    if (action) view.dispatch(action);
    tui.requestRender();
  };
  const interactWithSession = async (
    trailId: string,
    command: TuiInteractionCommand,
  ): Promise<TuiInteractionResult> => {
    const result = await runtime.interact(trailId, command, {
      onEvent: onInteractionEvent,
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    });
    applyInteractionSnapshot(result.snapshot);
    return result;
  };
  const interact = async (command: TuiInteractionCommand): Promise<TuiInteractionResult> => {
    const trailId = view.state.trailId;
    if (!trailId) throw new Error("No active session is available for this interaction.");
    return await interactWithSession(trailId, command);
  };
  exclusiveCommands = createExclusiveCommandBarrier({
    currentSessionId: () => view.state.trailId,
    canDeliver: () => phase === "main",
    interact: interactWithSession,
    onPromptFailure: reportFailure,
  });
  const interruptActiveTurn = async (): Promise<TuiInteractionResult> => {
    const visibleTurnId = view.state.interaction.active?.turnId;
    if (view.state.interaction.phase !== "idle") {
      view.dispatch({ type: "execution-changed", execution: "aborting" });
      tui.requestRender(true);
      await new Promise<void>((resolve) => setTimeout(resolve, INTERRUPT_FEEDBACK_MS));
    }
    return interact(stopVisibleInteraction(visibleTurnId));
  };

  editor.createStandaloneEscapeHandler = () => {
    if (phase !== "main") return undefined;
    const inspectedActionId = view.state.inspector?.actionId;
    if (inspectedActionId)
      return () => {
        if (view.state.inspector?.actionId === inspectedActionId) closeRunInspector();
        return true;
      };
    const selectedActionId = view.state.actionCursor;
    if (selectedActionId)
      return () => {
        if (view.state.actionCursor === selectedActionId) view.dispatch({ type: "action-cursor-cleared" });
        tui.requestRender();
        return true;
      };
    if (view.state.interaction.phase === "idle") return undefined;
    const visibleTurnId = view.state.interaction.active?.turnId;
    if (!visibleTurnId) return () => true;
    return () => {
      if (view.state.interaction.active?.turnId !== visibleTurnId) return true;
      if (view.state.interaction.phase !== "interrupting" && view.state.execution !== "aborting")
        void interruptActiveTurn().catch(reportFailure);
      return true;
    };
  };

  const restoreNewestQueuedInput = (): void => {
    void interact({ type: "restore-newest" }).then((result) => {
      if (result.effect !== "restored" || !result.restoredText) return;
      const draft = editor.getText();
      editor.setText(draft ? `${draft}\n${result.restoredText}` : result.restoredText);
      tui.requestRender();
    }, reportFailure);
  };

  const openExternalEditor = (): void => {
    if (externalEditorActive) return;
    externalEditorActive = true;
    const original = editor.getText();
    editor.disableSubmit = true;
    tui.stop();
    void editTextInExternalEditor({
      content: original,
      ...(options.externalEditorCommand ? { configuredCommand: options.externalEditorCommand } : {}),
    })
      .then((result) => {
        if (phase !== "main") return;
        if (result.status === "edited") editor.setText(result.content);
        else
          view.dispatch({
            type: "system-message",
            text: `External editor left the draft unchanged (${result.reason}).`,
          });
      })
      .finally(() => {
        externalEditorActive = false;
        if (phase !== "main") return;
        editor.disableSubmit = false;
        tui.start();
        tui.setFocus(editor);
        tui.requestRender(true);
      });
  };
  removeExitInputListener = tui.addInputListener((data) => {
    if (phase !== "main") {
      if (matchesKey(data, "ctrl+c")) {
        cancelPicker?.();
        void shutdown();
        return { consume: true };
      }
      return undefined;
    }
    if (mcp.ownsKeyboardFocus() || learning.ownsKeyboardFocus()) {
      if (matchesKey(data, "ctrl+c")) {
        void shutdown();
        return { consume: true };
      }
      return undefined;
    }
    if (editor.capturePotentialPasteInput(data)) return { consume: true };
    if (!editor.acceptsUnbracketedCommandInput()) return undefined;
    if (matchesKey(data, "ctrl+c")) {
      void shutdown();
      return { consume: true };
    }
    if (handleTranscriptKey(data)) return { consume: true };
    if (matchesKey(data, "ctrl+g")) {
      openExternalEditor();
      return { consume: true };
    }
    if (matchesKey(data, "alt+up")) {
      restoreNewestQueuedInput();
      return { consume: true };
    }
    if (data.endsWith("\n") && `${editor.getText()}${data}` === "/quit\n") {
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
    const routed = exclusiveCommands?.routeSubmission(text) ?? "idle";
    if (routed !== "idle") {
      if (routed === "blocked") {
        view.dispatch({
          type: "system-message",
          text: "A command is active. Wait for it to finish before submitting another command.",
        });
        tui.requestRender();
      }
      return;
    }
    inspectorGeneration += 1;
    const submittedInspectorGeneration = inspectorGeneration;
    const isCurrentSubmission = (): boolean =>
      phase === "main" &&
      inspectorGeneration === submittedInspectorGeneration &&
      view.state.trailId === ownedTrailId;
    const publishInspector = (message: string): void => {
      if (!isCurrentSubmission() || view.state.interaction.phase !== "idle") return;
      view.dispatch({
        type: "system-message",
        text: boundedInspectorText(message),
      });
      tui.requestRender();
    };
    const exclusiveScope = exclusiveSlashCommandScope(normalizedInput);
    const performSubmission = async (): Promise<void> => {
      if (normalizedInput === "/abort") {
        const result = await interruptActiveTurn();
        if (result.effect === "idle") view.dispatch({ type: "system-message", text: "No turn is active." });
        tui.requestRender();
        return;
      }
      if (normalizedInput === "/steer" || normalizedInput.startsWith("/steer ")) {
        const steeringText = normalizedInput.slice("/steer".length).trim();
        const result = await interact({
          type: "steer",
          ...(steeringText ? { text: steeringText } : {}),
        });
        const feedback = steerFeedback(result, Boolean(steeringText));
        if (feedback) view.dispatch({ type: "system-message", text: feedback });
        if (result.restoredText) editor.setText(result.restoredText);
        tui.requestRender();
        return;
      }
      if (normalizedInput === "/queue resume") {
        const result = await interact({ type: "resume-queue" });
        if (result.effect === "idle")
          view.dispatch({ type: "system-message", text: "The queue is already idle." });
        tui.requestRender();
        return;
      }
      if (normalizedInput === "/queue" || normalizedInput.startsWith("/queue ")) {
        view.dispatch({ type: "system-message", text: "Use /queue resume." });
        tui.requestRender();
        return;
      }
      if (view.state.interaction.phase !== "idle" && isExclusiveSlashCommand(normalizedInput)) {
        view.dispatch({
          type: "system-message",
          text: "That command changes the session. Wait for the turn to finish or press Esc to interrupt it.",
        });
        tui.requestRender();
        return;
      }
      let handled = false;
      if (normalizedInput === "?" || normalizedInput.startsWith("/")) {
        const commandWork = runSlashCommand(normalizedInput, {
          runtime,
          trailId: submittedTrailId,
          publishInspector,
          prepareTrailSelection: async (trailId) => await exclusiveCommands?.prepareDestination(trailId),
          dispatch: (action) => {
            if (!isCurrentSubmission()) return;
            view.dispatch(action);
            if (action.type === "trail-selected") ownedTrailId = action.trail.trailId;
          },
          requestRender: () => {
            if (isCurrentSubmission()) tui.requestRender();
          },
          openMcpManager: mcp.openManager,
          ...(runtime.inspectLearningAudit
            ? { openLearningAudit: () => learning.open(submittedTrailId) }
            : {}),
        });
        handled = await commandWork;
      }
      if (handled) {
        const selectedTrailId = ownedTrailId;
        if (selectedTrailId && selectedTrailId !== submittedTrailId) {
          const [transcript, interaction] = await Promise.all([
            runtime.getTranscript(selectedTrailId),
            runtime.inspectInteraction(selectedTrailId),
          ]);
          if (isCurrentSubmission()) {
            view.dispatch({
              type: "transcript-hydrated",
              trailId: selectedTrailId,
              transcript,
            });
            applyInteractionSnapshot(interaction);
          }
        }
        return;
      }

      await interact({ type: "submit", text });
    };
    const reportSubmissionFailure = (error: unknown): void => {
      if (isCurrentSubmission()) reportFailure(error);
    };
    if (exclusiveScope)
      exclusiveCommands?.start({
        sourceSessionId: submittedTrailId,
        scope: exclusiveScope,
        execute: performSubmission,
        onCommandFailure: reportSubmissionFailure,
      });
    else void performSubmission().catch(reportSubmissionFailure);
  };
  tui.addChild(root);
  const loadTranscript = (trail: TrailState) => runtime.getTranscript(trail.trailId);
  const mountMain = (
    trail: TrailState,
    transcript: readonly RuntimeTranscriptEntry[],
    interaction: TuiInteractionSnapshot,
  ): void => {
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
    applyInteractionSnapshot(interaction);
    root.clear();
    root.addChild(headerView);
    root.addChild(view);
    root.addChild(queuedInputsView);
    root.addChild(inputLabelView);
    root.addChild(editor);
    root.addChild(statusView);
    root.addChild(helpView);
    tui.setFocus(editor);
    tui.requestRender();
  };

  try {
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
        const [transcript, interaction] = await Promise.all([
          loadTranscript(trail),
          runtime.inspectInteraction(trail.trailId),
        ]);
        mountMain(trail, transcript, interaction);
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
      const [transcript, interaction] = await Promise.all([
        loadTranscript(trail),
        runtime.inspectInteraction(trail.trailId),
      ]);
      mountMain(trail, transcript, interaction);
      tui.start();
    }
  } catch (error) {
    learning.dispose();
    await mcp.dispose();
    throw error;
  }
  await shutdownCompleted;
}
