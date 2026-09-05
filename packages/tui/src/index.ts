import { createConditionalObject } from "@noesis/domain";
import {
  type Component,
  Container,
  isKeyRelease,
  matchesKey,
  ProcessTerminal,
  type Terminal,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import type { RuntimeTranscriptEntry, TrailState } from "@noesis/runtime";
import { tuiActionForAgentEvent } from "./agent-event.ts";
import {
  exclusiveSlashCommandScope,
  isExclusiveSlashCommand,
  isSlashCommandSubmission,
  runSlashCommand,
  steerFeedback,
} from "./commands.ts";
import { createEscapeRouting } from "./escape-routing.ts";
import { createExclusiveCommandBarrier, type ExclusiveCommandBarrier } from "./exclusive-command-barrier.ts";
import { editTextInExternalEditor } from "./external-editor.ts";
import { learningDiagnosticNotice, reconcileSettledTurnPresentation } from "./learning-presentation.ts";
import { boundedInspectorText, TUI_TIMINGS, type ShutdownSettlement } from "./lifecycle-utils.ts";
import { createTuiInspectorOrchestration } from "./inspector-orchestration.ts";
import { createTuiLearningOrchestration } from "./learning.ts";
import { createTuiMcpOrchestration } from "./mcp.ts";
import { createOptimisticPromptEcho } from "./optimistic-prompt.ts";
import {
  createHeaderView,
  createHelpView,
  createInputLabelView,
  createNoesisView,
  createQueuedInputsView,
  createStatusView,
  createSubagentsView,
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
import { createTuiSelectionOrchestration } from "./selection-orchestration.ts";
import { resolveTuiSessionRequest, resumableTrail, type TuiStartOptions } from "./session-picker.ts";
import {
  executionForInteractionPhase,
  initialTuiState,
  interactionViewFromSnapshot,
  type NoesisTuiAction,
} from "./state.ts";
import type { ActiveTurnToken } from "./stream-delta-buffer.ts";
import { detectTrueColor, safeTerminalText, shouldUseColor } from "./theme.ts";
import { pickStartupNote } from "./startup-note.ts";
import { createTuiSubAgentOrchestration } from "./subagent-orchestration.ts";
import { createTranscriptInputHandler } from "./transcript-input.ts";
import { createTuiStreamBuffers } from "./turn-stream-buffers.ts";
import { startWorkingAnimation } from "./working-animation.ts";
export * from "./public-surface.ts";
export async function startNoesisTui(
  runtime: NoesisTuiRuntime,
  options: TuiStartOptions = {},
  terminal: Terminal = new ProcessTerminal(),
): Promise<void> {
  const session = resolveTuiSessionRequest(runtime, options.session);
  const tui = new TuiMainScreen(terminal);
  tui.setClearOnShrink(false);
  const root = new Container();
  const requestedProvider = options.provider ?? runtime.agentDefaults.provider;
  const requestedReasoning = options.thinkingLevel ?? runtime.agentDefaults.thinkingLevel;
  const colorEnabled =
    terminal instanceof ProcessTerminal && shouldUseColor(process.env) && process.stdout.hasColors();
  const selectTheme = createSelectTheme(colorEnabled);
  const view = createNoesisView(
    initialTuiState(runtime.agentName ?? "runtime", {
      provider: requestedProvider,
      model: options.model ?? runtime.agentDefaults.model,
      reasoningLevel: requestedReasoning,
      colorEnabled,
    }),
    () => terminal.rows,
  );
  const editor = createSafeEditor(tui, colorEnabled, selectTheme, () => terminal.rows, [], {
    listModelRoutes: () => runtime.listModelRoutes?.() ?? [],
    currentRoute: () => view.state,
  });
  const reportFailure = (cause: unknown): void => {
    view.dispatch({
      type: "failed",
      error: safeTerminalText(cause instanceof Error ? cause.message : String(cause)),
    });
    tui.requestRender();
  };
  const reportLearningDiagnostic = (cause: unknown): void => {
    view.dispatch({ type: "system-message", text: learningDiagnosticNotice(cause) });
    tui.requestRender();
  };
  const startupNote = options.startupNote ?? pickStartupNote();
  const headerView = createHeaderView(
    colorEnabled,
    () => terminal.rows,
    colorEnabled && detectTrueColor(process.env),
    startupNote,
  );
  const inspector = createTuiInspectorOrchestration({
    runtime,
    view,
    tui,
    height: () => terminal.rows,
  });
  const optimisticPrompts = createOptimisticPromptEcho(view, () => tui.requestRender());
  const mcp = createTuiMcpOrchestration(
    createConditionalObject({
      runtime,
      tui,
      colorEnabled,
      height: () => terminal.rows,
    } as const)
      .addOptional(
        options.mcpInteractionBridge ? { interactionBridge: options.mcpInteractionBridge } : undefined,
      )
      .addOptional(options.openUrl ? { openUrl: options.openUrl } : undefined)
      .add({
        mutationsEnabled: () => view.state.interaction.phase === "idle",
        reportUnavailable: (text: string) => view.dispatch({ type: "system-message", text }),
      } as const)
      .finish(),
  );
  const learning = createTuiLearningOrchestration({
    runtime,
    tui,
    colorEnabled,
    height: () => terminal.rows,
    reportUnavailable: (text: string) => view.dispatch({ type: "system-message", text }),
  });
  const selection = createTuiSelectionOrchestration({
    runtime,
    tui,
    theme: selectTheme,
    colorEnabled,
    height: () => terminal.rows,
    currentTrailId: () => view.state.trailId,
    openUrl: options.openUrl,
  });
  const statusView = createStatusView(view, () => terminal.rows);
  const subagentsView = createSubagentsView(view, () => terminal.rows);
  const queuedInputsView = createQueuedInputsView(view, () => terminal.rows);
  const inputLabelView = createInputLabelView(view, () => terminal.rows);
  const helpView = createHelpView(view, () => terminal.rows);
  let phase: "picker" | "main" | "stopped" = session.mode === "pick" ? "picker" : "main";
  enrichEditorSkills(editor, runtime.listSkills, () => phase !== "stopped");
  let exclusiveCommands: ExclusiveCommandBarrier | undefined;
  let externalEditorActive = false,
    turnGeneration = 0,
    inspectorGeneration = 0;
  let activeTurnToken: ActiveTurnToken | undefined;
  const isCurrentTurn = (token: ActiveTurnToken): boolean =>
    phase === "main" &&
    activeTurnToken === token &&
    token.generation === turnGeneration &&
    view.state.trailId === token.trailId;
  const streams = createTuiStreamBuffers<ActiveTurnToken>({
    isCurrent: isCurrentTurn,
    timeline: () => view.state.timeline,
    publishAssistant: (text) => {
      view.dispatch({ type: "stream-delta", text });
      tui.requestRender();
    },
    publishReasoning: (text) => {
      view.dispatch({ type: "reasoning-delta", text });
      tui.requestRender();
    },
  });
  const streamDeltas = streams.assistant,
    reasoningDeltas = streams.reasoning;
  let removeExitInputListener = (): void => undefined;
  let removeSubAgentListener = (): void => undefined;
  let terminalStopped = false;
  let shutdownPromise: Promise<void> | undefined;
  const stopWorkingAnimation = startWorkingAnimation(
    // Closing outlives the main phase: the farewell glyph keeps breathing until the terminal stops.
    () =>
      (phase === "main" || view.state.execution === "closing") &&
      view.state.execution !== "idle" &&
      view.state.execution !== "error",
    () => {
      view.dispatch({ type: "animation-tick" });
      tui.requestRender();
    },
  );
  let resolveShutdown: (() => void) | undefined;
  let rejectShutdown: ((cause: unknown) => void) | undefined;
  const shutdownCompleted = new Promise<void>((resolve, reject) => {
    resolveShutdown = resolve;
    rejectShutdown = reject;
  });
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    const visibleTurnId = view.state.interaction.active?.turnId;
    const trailId = view.state.trailId;
    const exclusiveCommand = exclusiveCommands?.activeWork();
    const abortAndSettle =
      trailId && view.state.interaction.phase !== "idle"
        ? Promise.resolve()
            .then(async () => await runtime.interact(trailId, stopVisibleInteraction(visibleTurnId)))
            .then<ShutdownSettlement, ShutdownSettlement>(
              () => ({ status: "settled" }),
              (cause: unknown) => ({ status: "rejected", error: cause }),
            )
        : undefined;
    shutdownPromise = (async () => {
      phase = "stopped";
      turnGeneration += 1;
      inspectorGeneration += 1;
      activeTurnToken = undefined;
      inspector.hideOverlay();
      optimisticPrompts.clear();
      view.dispatch({ type: "execution-changed", execution: "closing" });
      editor.disableSubmit = true;
      editor.onSubmit = (): void => undefined;
      removeExitInputListener();
      removeSubAgentListener();
      tui.requestRender();
      await new Promise<void>((resolve) => setTimeout(resolve, TUI_TIMINGS.closingFeedbackMs));
      selection.dispose();
      learning.dispose();
      await mcp.dispose();
      streamDeltas.clear();
      reasoningDeltas.clear();
      try {
        let shutdownFailure:
          | {
              readonly error: unknown;
            }
          | undefined;
        if (abortAndSettle) {
          let graceTimer: NodeJS.Timeout | undefined;
          const settlement = await Promise.race<ShutdownSettlement>([
            abortAndSettle,
            new Promise<ShutdownSettlement>((resolve) => {
              graceTimer = setTimeout(() => resolve({ status: "timed-out" }), TUI_TIMINGS.shutdownGraceMs);
              graceTimer.unref();
            }),
          ]);
          if (graceTimer) clearTimeout(graceTimer);
          if (settlement.status === "rejected") shutdownFailure = { error: settlement.error };
          if (settlement.status === "timed-out") void abortAndSettle;
        }
        if (exclusiveCommand) {
          try {
            await exclusiveCommand;
          } catch (error) {
            shutdownFailure ??= { error };
          }
        }
        if (!shutdownFailure && trailId) await runtime.discardTrailIfEmpty(trailId);
        await options.onShutdown?.();
        if (shutdownFailure) throw shutdownFailure.error;
      } finally {
        try {
          await terminal.drainInput(1000);
        } finally {
          stopWorkingAnimation();
          if (!terminalStopped) {
            terminalStopped = true;
            tui.stop();
          }
        }
      }
    })();
    shutdownPromise.then(resolveShutdown, rejectShutdown);
    return shutdownPromise;
  };
  const subAgents = createTuiSubAgentOrchestration({
    runtime,
    view,
    showInspector: inspector.openSynthetic,
    requestRender: () => tui.requestRender(),
    reportFailure,
  });
  removeSubAgentListener = subAgents.dispose;
  const handleTranscriptKey = createTranscriptInputHandler({
    tui,
    view,
    inspectorMaxScroll: inspector.maxScroll,
    openRunInspector: inspector.openRun,
    openSubAgentInspector: subAgents.openInspector,
    closeRunInspector: inspector.close,
  });
  const applyInteractionSnapshot = (snapshot: TuiInteractionSnapshot): void => {
    if (view.state.trailId !== snapshot.sessionId) return;
    view.dispatch({
      type: "interaction-changed",
      interaction: interactionViewFromSnapshot(snapshot),
    });
    const execution =
      snapshot.phase === "idle" && optimisticPrompts.hasPending()
        ? undefined
        : executionForInteractionPhase(view.state.execution, snapshot.phase);
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
        rememberLearningFocus: (recordId) => learning.rememberFocus(recordId),
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
      optimisticPrompts.rejectForTrail(interactionEvent.sessionId);
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
      const echoed = optimisticPrompts.admit(
        interactionEvent.sessionId,
        interactionEvent.text,
        interactionEvent.turnId,
      );
      if (!echoed) view.dispatch({ type: "prompt-submitted", text: interactionEvent.text });
      tui.requestRender();
      return;
    }
    if (interactionEvent.type === "steer-delivered") {
      if (activeTurnToken) {
        reasoningDeltas.flush(activeTurnToken);
        streamDeltas.flush(activeTurnToken);
      }
      view.dispatch({ type: "steer-delivered", text: interactionEvent.text });
      tui.requestRender();
      return;
    }
    if (interactionEvent.type === "turn-settled") {
      const token = activeTurnToken;
      if (token?.turnId === interactionEvent.turnId) {
        reasoningDeltas.flush(token);
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
    if (event.type === "reasoning-delta") {
      streamDeltas.flush(token);
      reasoningDeltas.queue(token, event.text);
      return;
    }
    if (event.type === "delta") {
      reasoningDeltas.flush(token);
      streamDeltas.queue(token, event.text);
      return;
    }
    reasoningDeltas.flush(token);
    streamDeltas.flush(token);
    const action = tuiActionForAgentEvent(event);
    if (action) view.dispatch(action);
    tui.requestRender();
  };
  const interactWithSession = async (
    trailId: string,
    command: TuiInteractionCommand,
  ): Promise<TuiInteractionResult> => {
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const result = await runtime.interact(
      trailId,
      command,
      createConditionalObject({
        onEvent: onInteractionEvent,
      } as const)
        .add({ thinkingLevel: view.state.reasoningLevel })
        .finish(),
    );
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
    discardSessionIfEmpty: runtime.discardTrailIfEmpty,
  });
  const interruptActiveTurn = async (): Promise<TuiInteractionResult> => {
    const visibleTurnId = view.state.interaction.active?.turnId;
    if (view.state.interaction.phase !== "idle") {
      view.dispatch({ type: "execution-changed", execution: "aborting" });
      tui.requestRender(true);
      await new Promise<void>((resolve) => setTimeout(resolve, TUI_TIMINGS.interruptFeedbackMs));
    }
    return interact(stopVisibleInteraction(visibleTurnId));
  };
  const escapeRouting = createEscapeRouting({
    view,
    isMainPhase: () => phase === "main",
    armWindowMs: TUI_TIMINGS.escInterruptArmMs,
    closeRunInspector: inspector.close,
    interruptActiveTurn: () => void interruptActiveTurn().catch(reportFailure),
    requestRender: () => tui.requestRender(),
  });
  editor.createStandaloneEscapeHandler = escapeRouting.createStandaloneEscapeHandler;
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
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    void editTextInExternalEditor(
      createConditionalObject({
        content: original,
      } as const)
        .addOptional(
          options.externalEditorCommand ? { configuredCommand: options.externalEditorCommand } : undefined,
        )
        .finish(),
    )
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
    // Pi filters Kitty key releases before focused components, but global listeners run first.
    // Consume releases here so transcript commands observe the same press-only key stream.
    if (isKeyRelease(data)) return { consume: true };
    if (phase !== "main") {
      if (matchesKey(data, "ctrl+c")) {
        selection.dispose();
        void shutdown();
        return { consume: true };
      }
      return undefined;
    }
    escapeRouting.observeInput(data);
    if (mcp.ownsKeyboardFocus() || learning.ownsKeyboardFocus() || selection.ownsKeyboardFocus()) {
      if (matchesKey(data, "ctrl+c")) {
        void shutdown();
        return { consume: true };
      }
      return undefined;
    }
    // Inspection owns every byte; bypassing the editor preserves its draft and paste parser.
    if (view.state.actionCursor || view.state.subAgentCursor || view.state.inspector) {
      handleTranscriptKey(data);
      return { consume: true };
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
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        const result = await interact(
          createConditionalObject({
            type: "steer",
          } as const)
            .addOptional(steeringText ? { text: steeringText } : undefined)
            .finish(),
        );
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
      if (isSlashCommandSubmission(text)) {
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        const commandWork = runSlashCommand(
          normalizedInput,
          createConditionalObject({
            runtime,
            trailId: submittedTrailId,
            publishInspector,
            prepareTrailSelection: async (trailId: string) =>
              await exclusiveCommands?.prepareDestination(trailId),
            dispatch: (action: NoesisTuiAction) => {
              if (!isCurrentSubmission()) return;
              view.dispatch(action);
              if (action.type === "trail-selected") ownedTrailId = action.trail.trailId;
            },
            requestRender: () => {
              if (isCurrentSubmission()) tui.requestRender();
            },
            openMcpManager: mcp.openManager,
            selectRoute: selection.selectRoute,
            selectProvider: selection.selectProvider,
            ensureProviderAuthenticated: selection.ensureProviderAuthenticated,
            selectSession: selection.selectSession,
          } as const)
            .addOptional(
              runtime.inspectLearningAudit
                ? {
                    openLearningAudit: () => learning.open(submittedTrailId),
                  }
                : undefined,
            )
            .finish(),
        );
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
      const optimisticId = optimisticPrompts.echoIfIdle(view.state.interaction, submittedTrailId, text);
      try {
        await interact({ type: "submit", text });
      } catch (error) {
        if (optimisticId) optimisticPrompts.reject(optimisticId);
        throw error;
      }
    };
    const reportSubmissionFailure = (cause: unknown): void => {
      if (isCurrentSubmission()) reportFailure(cause);
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
  // Inspect mode pauses and hides the editor while keys navigate the transcript.
  const editorSlot: Component = {
    invalidate: () => editor.invalidate(),
    render: (width) =>
      view.state.actionCursor || view.state.subAgentCursor || view.state.inspector
        ? []
        : editor.render(width),
  };
  tui.addChild(root);
  const mountMain = (
    trail: TrailState,
    transcript: readonly RuntimeTranscriptEntry[],
    interaction: TuiInteractionSnapshot,
  ): void => {
    phase = "main";
    inspector.hideOverlay();
    optimisticPrompts.clear();
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
    root.addChild(subagentsView);
    root.addChild(queuedInputsView);
    root.addChild(inputLabelView);
    root.addChild(editorSlot);
    root.addChild(statusView);
    root.addChild(helpView);
    tui.setFocus(editor);
    tui.requestRender();
  };
  try {
    if (session.mode === "pick") {
      const trailId = await selection.selectSession({ startTui: true });
      if (!trailId) {
        await shutdown();
        await shutdownCompleted;
        return;
      }
      try {
        const trail = await resumableTrail(runtime, trailId);
        const [transcript, interaction] = await Promise.all([
          runtime.getTranscript(trail.trailId),
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
              model: options.model ?? runtime.agentDefaults.model,
              thinkingLevel: requestedReasoning,
            });
      const [transcript, interaction] = await Promise.all([
        runtime.getTranscript(trail.trailId),
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
