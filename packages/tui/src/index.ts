import { Container, matchesKey, ProcessTerminal, type Terminal, TUI } from "@earendil-works/pi-tui";
import type { TrailState } from "@noesis/runtime";
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
import { createSafeEditor, createSelectTheme } from "./safe-editor.ts";
import {
  createResponsiveSessionPicker,
  createSessionPickerItems,
  resumableTrail,
  type TuiStartOptions,
} from "./session-picker.ts";
import { initialTuiState } from "./state.ts";

export * from "./onboarding.ts";
export * from "./rendering.ts";
export * from "./runtime-port.ts";
export * from "./safe-editor.ts";
export * from "./session-picker.ts";
export * from "./state.ts";

const SHUTDOWN_GRACE_MS = 250;
const INSPECTOR_PREVIEW_CHARACTERS = 24_000;

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
    if (phase === "main" && matchesKey(data, "ctrl+o")) {
      view.dispatch({ type: "agent-actions-expansion-toggled" });
      tui.requestRender();
      return { consume: true };
    }
    if (phase === "main" && data === "\n" && editor.getText().trim() === "/quit") {
      void shutdown();
      return { consume: true };
    }
    return undefined;
  });
  editor.onSubmit = (text) => {
    const submittedTrailId = view.state.trailId;
    if (!submittedTrailId || !text.trim()) return;
    inspectorGeneration += 1;
    const submittedInspectorGeneration = inspectorGeneration;
    const isCurrentSubmission = (): boolean =>
      phase === "main" &&
      inspectorGeneration === submittedInspectorGeneration &&
      view.state.trailId === submittedTrailId;
    const publishInspector = (message: string): void => {
      if (!isCurrentSubmission() || activeTurn) return;
      view.dispatch({
        type: "system-message",
        text: boundedInspectorText(message),
      });
      tui.requestRender();
    };
    void (async () => {
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
      if (text === "/skills") {
        if (!runtime.listSkills) {
          publishInspector("Skill inspection is unavailable in this runtime.");
          return;
        }
        const skills = await runtime.listSkills();
        publishInspector(
          skills.length === 0
            ? "No skills are installed or discoverable."
            : [
                `Skills · ${skills.length}`,
                ...skills.map(
                  (skill) =>
                    `• ${skill.name}${skill.disableModelInvocation ? " · explicit only" : ""}\n  ${skill.description}\n  ${skill.filePath}`,
                ),
                "",
                "Install with: noesis skills install SOURCE [--workspace]",
                "Invoke with: /skill:<name> [instructions]",
              ].join("\n"),
        );
        return;
      }
      if (text.startsWith("/skill ")) {
        const name = text.slice("/skill ".length).trim();
        if (!runtime.inspectSkill) {
          publishInspector("Skill detail inspection is unavailable in this runtime.");
          return;
        }
        const skill = await runtime.inspectSkill(name);
        publishInspector(
          skill
            ? [
                `${skill.name}${skill.disableModelInvocation ? " · explicit only" : ""}`,
                skill.description,
                skill.filePath,
                `digest ${skill.contentDigest}`,
                "",
                skill.content,
              ].join("\n")
            : `Unknown skill: ${name}`,
        );
        return;
      }
      if (text === "/scripts") {
        if (!runtime.listScripts) {
          publishInspector("Script inspection is unavailable in this runtime.");
          return;
        }
        const scripts = await runtime.listScripts();
        publishInspector(
          scripts.length === 0
            ? "No reusable scripts have been saved yet."
            : [
                `Scripts · ${scripts.length}`,
                ...scripts.map(
                  (script) =>
                    `• ${script.name} · r${String(script.revision)}\n  ${script.description}\n  ${script.requiredTools.join(", ") || "pure JavaScript"}\n  ${script.workingPath}`,
                ),
                "",
                "Ask Noesis to run one by name, or say “save that as a script” after useful work.",
              ].join("\n"),
        );
        return;
      }
      if (text.startsWith("/script ")) {
        const name = text.slice("/script ".length).trim();
        if (!runtime.inspectScript) {
          publishInspector("Script detail inspection is unavailable in this runtime.");
          return;
        }
        const script = await runtime.inspectScript(name);
        publishInspector(
          script
            ? [
                `${script.name} · r${String(script.revision)}`,
                script.description,
                script.workingPath,
                `requires: ${script.requiredTools.join(", ") || "pure JavaScript"}`,
                "",
                `Input schema\n${script.inputSchema}`,
                "",
                `Output schema\n${script.outputSchema}`,
                "",
                `Source\n${script.source}`,
              ].join("\n")
            : `Unknown script: ${name}`,
        );
        return;
      }
      if (text === "/workflows") {
        if (!runtime.listWorkflows) {
          publishInspector("Workflow inspection is unavailable in this runtime.");
          return;
        }
        const workflows = await runtime.listWorkflows();
        publishInspector(
          workflows.length === 0
            ? "No multi-phase workflows have been saved yet."
            : [
                `Workflows · ${workflows.length}`,
                ...workflows.map(
                  (workflow) =>
                    `• ${workflow.name} · r${String(workflow.revision)} · ${workflow.phaseNames.length} phases\n  ${workflow.description}\n  ${workflow.phaseNames.join(" → ")}\n  ${workflow.workingPath}`,
                ),
                "",
                "Ask Noesis to run or resume a workflow by name.",
              ].join("\n"),
        );
        return;
      }
      if (text.startsWith("/workflow ")) {
        const name = text.slice("/workflow ".length).trim();
        if (!runtime.inspectWorkflow) {
          publishInspector("Workflow detail inspection is unavailable in this runtime.");
          return;
        }
        const workflow = await runtime.inspectWorkflow(name);
        publishInspector(
          workflow
            ? [
                `${workflow.name} · r${String(workflow.revision)}`,
                workflow.description,
                workflow.workingPath,
                "",
                ...workflow.phases.flatMap((workflowPhase, index) => [
                  `${String(index + 1)}. ${workflowPhase.name} · ${workflowPhase.description}`,
                  `   requires: ${workflowPhase.requiredTools.join(", ") || "pure JavaScript"}`,
                  workflowPhase.source,
                  "",
                ]),
              ].join("\n")
            : `Unknown workflow: ${name}`,
        );
        return;
      }
      if (text === "/runs") {
        if (!runtime.listExecutions) {
          publishInspector("Run inspection is unavailable in this runtime.");
          return;
        }
        const runs = await runtime.listExecutions(submittedTrailId);
        publishInspector(
          runs.length === 0
            ? "No codemode executions have run in this session."
            : [
                `Runs · ${runs.length}`,
                ...runs.map(
                  (run) =>
                    `• ${run.kind} · ${run.label} · ${run.executionId}\n  ${run.status} · ${run.callCount} ${run.kind === "workflow" ? "phases" : "calls"} · ${run.toolNames.join(", ") || "no nested calls"}\n  ${run.startedAt}`,
                ),
              ].join("\n"),
        );
        return;
      }
      if (text.startsWith("/run ")) {
        const executionId = text.slice("/run ".length).trim();
        if (!runtime.inspectExecution) {
          publishInspector("Run detail inspection is unavailable in this runtime.");
          return;
        }
        const run = await runtime.inspectExecution(submittedTrailId, executionId);
        publishInspector(
          run
            ? [
                `${run.kind} · ${run.label}`,
                `${run.executionId} · ${run.status}`,
                ...(run.parentExecutionId ? [`parent ${run.parentExecutionId}`] : []),
                ...(run.catalogDigest ? [`catalog ${run.catalogDigest}`] : []),
                ...(run.sourceDigest ? [`source ${run.sourceDigest}`] : []),
                ...(run.sourceArtifact
                  ? [
                      "",
                      `Source · ${run.sourceArtifact.path}${run.sourceArtifact.truncated ? " · preview truncated" : ""}`,
                      run.sourceArtifact.preview || "(empty)",
                    ]
                  : []),
                ...(run.stdoutArtifact
                  ? [
                      "",
                      `Stdout · ${run.stdoutArtifact.path}${run.stdoutArtifact.truncated ? " · preview truncated" : ""}`,
                      run.stdoutArtifact.preview || "(empty)",
                    ]
                  : []),
                ...(run.stderrArtifact
                  ? [
                      "",
                      `Stderr · ${run.stderrArtifact.path}${run.stderrArtifact.truncated ? " · preview truncated" : ""}`,
                      run.stderrArtifact.preview || "(empty)",
                    ]
                  : []),
                ...(run.phases ?? []).map(
                  (runPhase) =>
                    `${String(runPhase.index + 1)}. ${runPhase.name} · ${runPhase.status}${runPhase.executionId ? ` · ${runPhase.executionId}` : ""}${runPhase.error ? `\n   ${runPhase.error}` : ""}`,
                ),
                ...(run.result ? ["", `Result\n${run.result}`] : []),
                ...(run.error ? ["", `Error\n${run.error}`] : []),
              ].join("\n")
            : `Unknown run in this session: ${executionId}`,
        );
        return;
      }
      if (text === "?" || text === "/help") {
        view.dispatch({
          type: "system-message",
          text: [
            "/model provider/model · /context · /capabilities",
            "/skills · /scripts · /workflows · /runs",
            "/skill NAME · /script NAME · /workflow NAME · /run ID",
            "/fork · /compact · /abort",
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
        await runtime.compact(submittedTrailId);
        view.dispatch({ type: "compacted" });
        view.dispatch({ type: "system-message", text: "Trail compacted." });
        tui.requestRender();
        return;
      }
      if (text === "/fork") {
        const trail = await runtime.forkTrail(submittedTrailId);
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
