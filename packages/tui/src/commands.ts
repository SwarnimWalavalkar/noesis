import { paginateInspectorText } from "./lifecycle-utils.ts";
import type { AgentThinkingLevel } from "@noesis/agent-types";
import type {
  NoesisTuiRuntime,
  TuiInteractionResult,
  TuiLearningActivitySummary,
  TuiLearningInspection,
  TuiModelRoute,
  TuiWorkingAdjustmentState,
} from "./runtime-port.ts";
import type { NoesisTuiAction } from "./state.ts";
import { resumableTrail } from "./session-picker.ts";

export interface TuiRoutePickerIntent {
  readonly kind: "model" | "reasoning";
  readonly currentProvider: string;
  readonly currentModel: string;
  readonly currentThinkingLevel: AgentThinkingLevel;
}

export interface TuiProviderPickerIntent {
  readonly currentProvider: string;
}

export interface TuiProviderPickerSelection {
  readonly provider: string;
  readonly providerName: string;
}

export interface TuiRoutePickerSelection {
  readonly route: TuiModelRoute;
  readonly thinkingLevel: AgentThinkingLevel;
}

export interface SlashCommandContext {
  readonly runtime: NoesisTuiRuntime;
  readonly trailId: string;
  /** Publishes bounded read-only output, dropping results from superseded submissions. */
  readonly publishInspector: (message: string) => void;
  readonly dispatch: (action: NoesisTuiAction) => void;
  /** Completes durable queued-intent handoff before a new session becomes visible. */
  readonly prepareTrailSelection?: (trailId: string) => Promise<void>;
  readonly requestRender: () => void;
  readonly openMcpManager?: () => void;
  readonly openLearningAudit?: () => void;
  readonly selectRoute?: (intent: TuiRoutePickerIntent) => Promise<TuiRoutePickerSelection | undefined>;
  readonly selectProvider?: (
    intent: TuiProviderPickerIntent,
  ) => Promise<TuiProviderPickerSelection | undefined>;
  readonly ensureProviderAuthenticated?: (providerId: string, providerName: string) => Promise<boolean>;
  readonly selectSession?: () => Promise<string | undefined>;
}

// SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
export const HELP_LINES = [
  "/provider manages connections · /model selects a model · /reasoning selects reasoning",
  "/provider ID · /model ID · /reasoning LEVEL are quick inline changes",
  "provider or model changes start an empty session; the current session is preserved",
  "the prior transcript is not replayed in the new session",
  "/context · /capabilities",
  "/skills · /programs · /runs · /learning",
  "/refine [REQUEST] deliberately improves a lasting Noesis behavior",
  "/mcp manages servers, authentication, and discovered capabilities",
  "/skill NAME inspects · /skill:NAME [instructions] invokes command-name collisions",
  "/program MODE NAME · /run ID",
  "/resume · /fork · /compact [FOCUS] · /steer [MESSAGE] · /queue resume",
  "enter queues behind active turns and commands · alt+↑ edits newest queued · esc esc interrupts",
  "shift+enter newline · ctrl+g external editor",
  "ctrl+o inspect runs · space expand · enter open the run inspector",
  "/quit · learning, experiments, activation, and revert run ambiently",
] as const;

const THINKING_LEVELS = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly AgentThinkingLevel[]);

function isThinkingLevel(value: string): value is AgentThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value);
}

async function refreshedModelRoutes(runtime: NoesisTuiRuntime): Promise<readonly TuiModelRoute[]> {
  if (!runtime.refreshModelRoutes) return runtime.listModelRoutes?.() ?? [];
  try {
    return await runtime.refreshModelRoutes();
  } catch {
    return runtime.listModelRoutes?.() ?? [];
  }
}

const routeChangeNotice = (provider: string, model: string, thinkingLevel: AgentThinkingLevel): string =>
  [
    `Route changed to ${provider}/${model} · reasoning ${thinkingLevel} in a fresh session.`,
    "The previous session is preserved and can be resumed from the session picker.",
    "No prior transcript was replayed, preserving prompt-cache isolation.",
  ].join(" ");

const routeThinkingLevel = (
  route: Pick<TuiModelRoute, "thinkingLevels">,
  current: AgentThinkingLevel,
): AgentThinkingLevel =>
  route.thinkingLevels.includes(current) ? current : (route.thinkingLevels.at(-1) ?? "off");

async function selectFreshRoute(
  current: ReturnType<NoesisTuiRuntime["getTrail"]>,
  route: Pick<TuiModelRoute, "provider" | "providerName" | "model" | "thinkingLevels">,
  context: SlashCommandContext,
  requestedThinkingLevel?: AgentThinkingLevel,
  providerAlreadyAuthenticated = false,
): Promise<void> {
  if (current.provider === route.provider && current.model === route.model) {
    context.dispatch({
      type: "notification-shown",
      text: `Already using ${route.provider}/${route.model} · session unchanged`,
      tone: "info",
    });
    context.requestRender();
    return;
  }
  if (
    !providerAlreadyAuthenticated &&
    context.ensureProviderAuthenticated &&
    !(await context.ensureProviderAuthenticated(route.provider, route.providerName ?? route.provider))
  ) {
    context.dispatch({
      type: "notification-shown",
      text: "Authentication cancelled · session unchanged",
      tone: "info",
    });
    context.requestRender();
    return;
  }
  const thinkingLevel = requestedThinkingLevel ?? routeThinkingLevel(route, current.thinkingLevel);
  const trail = await context.runtime.startTrail({
    title: `${route.provider}/${route.model}`,
    provider: route.provider,
    model: route.model,
    thinkingLevel,
  });
  await context.prepareTrailSelection?.(trail.trailId);
  context.dispatch({ type: "trail-selected", trail });
  context.dispatch({
    type: "system-message",
    text: routeChangeNotice(route.provider, route.model, thinkingLevel),
  });
  context.dispatch({
    type: "notification-shown",
    text: "New empty session · previous preserved · history not replayed",
    tone: "info",
  });
  context.requestRender();
}

async function selectProvider(
  current: ReturnType<NoesisTuiRuntime["getTrail"]>,
  provider: string,
  providerName: string,
  context: SlashCommandContext,
): Promise<void> {
  if (
    context.ensureProviderAuthenticated &&
    !(await context.ensureProviderAuthenticated(provider, providerName))
  ) {
    context.dispatch({
      type: "notification-shown",
      text: "Authentication cancelled · session unchanged",
      tone: "info",
    });
    context.requestRender();
    return;
  }
  if (current.provider === provider) {
    context.dispatch({
      type: "notification-shown",
      text: `Already using provider ${provider} · session unchanged`,
      tone: "info",
    });
    context.requestRender();
    return;
  }
  const routes = (await refreshedModelRoutes(context.runtime)).filter((route) => route.provider === provider);
  const route = routes.find((candidate) => candidate.default) ?? routes[0];
  if (!route) {
    context.publishInspector(
      `${providerName} is connected, but its model catalog is unavailable. The current session is unchanged.`,
    );
    return;
  }
  await selectFreshRoute(current, route, context, undefined, true);
}

async function setCurrentReasoningLevel(
  current: ReturnType<NoesisTuiRuntime["getTrail"]>,
  level: AgentThinkingLevel,
  context: SlashCommandContext,
): Promise<void> {
  if (current.thinkingLevel === level) {
    context.dispatch({
      type: "notification-shown",
      text: `Already using reasoning ${level} · session unchanged`,
      tone: "info",
    });
    context.requestRender();
    return;
  }
  if (!context.runtime.setTrailThinkingLevel) {
    context.publishInspector("Reasoning changes are unavailable in this runtime.");
    return;
  }
  await context.runtime.setTrailThinkingLevel(current.trailId, level);
  context.dispatch({ type: "reasoning-level-changed", reasoningLevel: level });
  context.dispatch({
    type: "notification-shown",
    text: `Reasoning · ${level} · current session`,
    tone: "success",
  });
  context.requestRender();
}

async function applyRoutePickerSelection(
  current: ReturnType<NoesisTuiRuntime["getTrail"]>,
  selection: TuiRoutePickerSelection,
  context: SlashCommandContext,
): Promise<void> {
  if (current.provider === selection.route.provider && current.model === selection.route.model) {
    await setCurrentReasoningLevel(current, selection.thinkingLevel, context);
    return;
  }
  await selectFreshRoute(current, selection.route, context, selection.thinkingLevel);
}

function workingAdjustmentLines(adjustment: TuiWorkingAdjustmentState, heading: string): readonly string[] {
  return [
    `${heading} · ${adjustment.status}`,
    `strategy · ${adjustment.strategy}`,
    `success signal · ${adjustment.successSignal}`,
    `served evidence · ${String(adjustment.servedEvidence.length)}`,
    ...adjustment.servedEvidence.flatMap((evidence) => [
      `  ${evidence.outcome} · turn ${evidence.turnId} · ${evidence.settledAt}`,
      `    ${evidence.summary}`,
    ]),
  ];
}

function learningActivityLine(activity: TuiLearningActivitySummary): string {
  const glyph =
    activity.status === "running"
      ? "●"
      : activity.status === "queued"
        ? "○"
        : activity.status === "failed"
          ? "×"
          : activity.status === "stale"
            ? "!"
            : activity.status === "no_change"
              ? "—"
              : "✓";
  const references = [
    activity.turnId ? `turn ${activity.turnId}` : undefined,
    activity.experimentId ? `experiment ${activity.experimentId}` : undefined,
    activity.capabilityRevisionId
      ? `capability ${activity.capabilityId ?? "unknown"}@${activity.capabilityRevisionId}`
      : activity.capabilityId
        ? `capability ${activity.capabilityId}`
        : undefined,
    activity.projectId ? `project ${activity.projectId}` : undefined,
    activity.adjustmentId ? `adjustment ${activity.adjustmentId}` : undefined,
  ].filter((value): value is string => value !== undefined);
  const adjustment = activity.workingAdjustment;
  const adjustmentLines = adjustment
    ? workingAdjustmentLines(adjustment, "working adjustment").map((line) => `  ${line}`)
    : [];
  const decisionEvidenceLines = activity.evidenceRefs
    ? [
        `  decision evidence · ${String(activity.evidenceRefs.length)}`,
        ...activity.evidenceRefs.map((reference) => {
          if (reference.kind === "database_row") return `    ${reference.table}:${reference.rowId}`;
          if (reference.kind === "artifact_file") return `    artifact:${reference.artifactId}`;
          return `    ${reference.kind}:${reference.revisionId}`;
        }),
      ]
    : [];
  return [
    `${glyph} ${activity.status.replaceAll("_", " ")} · ${activity.stage}`,
    `  ${activity.summary}`,
    ...(references.length > 0 ? [`  ${references.join(" · ")}`] : []),
    ...decisionEvidenceLines,
    ...adjustmentLines,
    `  ${activity.updatedAt} · ${activity.jobId}`,
  ].join("\n");
}

/** Commands that change the active trail or its context must not overlap another submission. */
export function isExclusiveSlashCommand(text: string): boolean {
  const command = text.trim();
  return (
    command === "/compact" ||
    command.startsWith("/compact ") ||
    command === "/resume" ||
    command === "/fork" ||
    command === "/model" ||
    command.startsWith("/model ") ||
    command === "/provider" ||
    command.startsWith("/provider ") ||
    command === "/reasoning" ||
    command.startsWith("/reasoning ")
  );
}

export function exclusiveSlashCommandScope(
  text: string,
): "current-session" | "resulting-session" | undefined {
  const command = text.trim();
  if (
    command === "/compact" ||
    command.startsWith("/compact ") ||
    command === "/reasoning" ||
    command.startsWith("/reasoning ")
  )
    return "current-session";
  return isExclusiveSlashCommand(command) ? "resulting-session" : undefined;
}

export function steerFeedback(result: TuiInteractionResult, explicit: boolean): string | undefined {
  if (result.effect === "unresolved")
    return "Steer delivery could not be confirmed. It is held for inspection and will not retry automatically.";
  if (result.effect !== "idle") return undefined;
  return explicit ? "No active turn is available to steer." : "No queued message is available to promote.";
}

export function isSlashCommandSubmission(text: string): boolean {
  const command = text.trim();
  return (
    command === "?" || (command.startsWith("/") && (command !== "/learning" || text === text.trimStart()))
  );
}

/**
 * Handles read-only inspection and session commands. Turn control (`/quit`, `/abort`) stays with
 * the session loop because it owns shutdown and the active turn.
 */
export async function runSlashCommand(text: string, context: SlashCommandContext): Promise<boolean> {
  const { runtime, trailId, publishInspector, dispatch, requestRender } = context;
  const command = text.trim();

  if (command === "?" || command === "/help") {
    dispatch({ type: "system-message", text: HELP_LINES.join("\n") });
    requestRender();
    return true;
  }

  if (command === "/context" || command === "/capabilities") {
    dispatch({
      type: "pane-selected",
      pane: command === "/context" ? "context" : "capabilities",
    });
    requestRender();
    return true;
  }

  if (command === "/mcp") {
    if (!context.openMcpManager) {
      publishInspector("MCP management is unavailable in this runtime.");
      return true;
    }
    context.openMcpManager();
    return true;
  }

  if (command === "/skills") {
    if (!runtime.listSkills) {
      publishInspector("Skill inspection is unavailable in this runtime.");
      return true;
    }
    const skills = await runtime.listSkills();
    publishInspector(
      skills.length === 0
        ? "No skills are installed or discoverable."
        : [
            `Skills · ${String(skills.length)}`,
            ...skills.map(
              (skill) =>
                `• ${skill.name}${skill.aliases?.length ? ` · aliases ${skill.aliases.map((alias) => `/${alias}`).join(", ")}` : ""}${skill.disableModelInvocation ? " · explicit only" : ""}\n  ${skill.description}\n  ${skill.filePath}`,
            ),
            "",
            "Install with: noesis skills install SOURCE [--workspace]",
            "Invoke with: /<name> [instructions]",
          ].join("\n"),
    );
    return true;
  }

  if (command.startsWith("/skill ")) {
    const name = command.slice("/skill ".length).trim();
    if (!runtime.inspectSkill) {
      publishInspector("Skill detail inspection is unavailable in this runtime.");
      return true;
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
    return true;
  }

  if (command === "/programs") {
    if (!runtime.listPrograms) {
      publishInspector("Program inspection is unavailable in this runtime.");
      return true;
    }
    const programs = await runtime.listPrograms();
    publishInspector(
      programs.length === 0
        ? "No Programs have been saved yet."
        : [
            `Programs · ${String(programs.length)}`,
            ...programs.map(
              (program) =>
                `• ${program.name} · ${program.mode} · r${String(program.revision)}${program.mode === "workflow" ? ` · ${String(program.phaseNames.length)} phases` : ""}\n  ${program.description}\n  ${program.mode === "workflow" ? program.phaseNames.join(" → ") : program.requiredTools.join(", ") || "pure JavaScript"}\n  ${program.workingPath}${program.sourceWorkingPath ? `\n  source ${program.sourceWorkingPath}` : ""}`,
            ),
            "",
            "Ask Noesis to run one by name, or to save useful work as a Program.",
          ].join("\n"),
    );
    return true;
  }

  if (command.startsWith("/program ")) {
    const [mode, ...nameParts] = command.slice("/program ".length).trim().split(/\s+/u);
    const name = nameParts.join(" ");
    if ((mode !== "script" && mode !== "workflow") || name.length === 0) {
      publishInspector("Usage: /program <script|workflow> <name>");
      return true;
    }
    if (!runtime.inspectProgram) {
      publishInspector("Program detail inspection is unavailable in this runtime.");
      return true;
    }
    const program = await runtime.inspectProgram(mode, name);
    publishInspector(
      program
        ? [
            `${program.name} · ${program.mode} · r${String(program.revision)}`,
            program.description,
            program.workingPath,
            `definition ${program.definitionDigest}`,
            ...(program.sourceWorkingPath ? [`source ${program.sourceWorkingPath}`] : []),
            ...(program.sourceDigest ? [`source digest ${program.sourceDigest}`] : []),
            ...(program.mode === "script"
              ? [`requires: ${program.requiredTools.join(", ") || "pure JavaScript"}`]
              : []),
            "",
            `Input schema\n${program.inputSchema}`,
            "",
            `Output schema\n${program.outputSchema}`,
            "",
            ...(program.mode === "script" && program.source
              ? [`Source\n${program.source}`]
              : (program.phases ?? []).flatMap((phase, index) => [
                  `${String(index + 1)}. ${phase.name} · ${phase.description}`,
                  `   requires: ${phase.requiredTools.join(", ") || "pure JavaScript"}`,
                  phase.source,
                  "",
                ])),
          ].join("\n")
        : `Unknown ${mode} Program: ${name}`,
    );
    return true;
  }

  if (command === "/runs") {
    if (!runtime.listExecutions) {
      publishInspector("Run inspection is unavailable in this runtime.");
      return true;
    }
    const runs = await runtime.listExecutions(trailId);
    publishInspector(
      runs.length === 0
        ? "No codemode executions have run in this session."
        : [
            `Runs · ${String(runs.length)}`,
            ...runs.map(
              (run) =>
                `• ${run.kind} · ${run.label} · ${run.executionId}\n  ${run.status} · ${String(run.callCount)} ${run.kind === "workflow" ? "phases" : "calls"} · ${run.toolNames.join(", ") || "no nested calls"}\n  ${run.startedAt}`,
            ),
          ].join("\n"),
    );
    return true;
  }

  if (command.startsWith("/run ")) {
    const executionId = command.slice("/run ".length).trim();
    if (!runtime.inspectExecution) {
      publishInspector("Run detail inspection is unavailable in this runtime.");
      return true;
    }
    const run = await runtime.inspectExecution(trailId, executionId);
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
    return true;
  }

  if (command === "/learning") {
    if (context.openLearningAudit) {
      context.openLearningAudit();
      return true;
    }
    if (!runtime.inspectLearning && !runtime.listLearningActivity) {
      publishInspector("Learning activity inspection is unavailable in this runtime.");
      return true;
    }
    const inspection: TuiLearningInspection = runtime.inspectLearning
      ? await runtime.inspectLearning(trailId)
      : runtime.listLearningActivity
        ? Object.freeze({ activity: await runtime.listLearningActivity(trailId) })
        : Object.freeze({ activity: Object.freeze([]) });
    if (inspection.activity.length === 0 && !inspection.currentWorkingAdjustment) {
      publishInspector("No ambient learning activity has been recorded for this session yet.");
      return true;
    }
    const pages = paginateInspectorText(
      `Learning activity · ${String(inspection.activity.length)}`,
      [
        ...(inspection.currentWorkingAdjustment
          ? [
              workingAdjustmentLines(
                inspection.currentWorkingAdjustment,
                "Current project working adjustment",
              ).join("\n"),
            ]
          : []),
        ...inspection.activity.map(learningActivityLine),
        "Noesis reflects after useful work. No change is a normal outcome.",
      ].join("\n\n"),
    );
    for (const page of pages) publishInspector(page);
    return true;
  }

  if (command === "/compact" || command.startsWith("/compact ")) {
    dispatch({ type: "execution-changed", execution: "compacting" });
    requestRender();
    const focus = command === "/compact" ? undefined : command.slice("/compact ".length).trim();
    await runtime.compact(trailId, focus || undefined);
    dispatch({ type: "compacted" });
    dispatch({ type: "system-message", text: "Context compacted" });
    requestRender();
    return true;
  }

  if (command === "/fork") {
    const trail = await runtime.forkTrail(trailId);
    const transcript = await runtime.getTranscript(trail.trailId);
    await context.prepareTrailSelection?.(trail.trailId);
    dispatch({ type: "trail-selected", trail });
    dispatch({ type: "transcript-hydrated", trailId: trail.trailId, transcript });
    requestRender();
    return true;
  }

  if (command === "/resume") {
    if (!context.selectSession) {
      publishInspector("Session selection is unavailable in this runtime.");
      return true;
    }
    const selectedTrailId = await context.selectSession();
    if (!selectedTrailId) return true;
    const trail = await resumableTrail(runtime, selectedTrailId);
    await context.prepareTrailSelection?.(trail.trailId);
    dispatch({ type: "trail-selected", trail });
    requestRender();
    return true;
  }

  if (command === "/provider") {
    const routes = runtime.listModelRoutes?.() ?? [];
    const current = runtime.getTrail(trailId);
    if (context.selectProvider) {
      const selected = await context.selectProvider({ currentProvider: current.provider });
      if (selected) await selectProvider(current, selected.provider, selected.providerName, context);
      return true;
    }
    const providers = [...new Set(routes.map((route) => route.provider))];
    publishInspector(
      providers.length === 0
        ? `Provider · ${current.provider}\nModel catalog is unavailable in this runtime.`
        : [
            `Provider · ${current.provider}`,
            ...providers.map((provider) => {
              const models = routes.filter((route) => route.provider === provider);
              const defaultModel = models.find((route) => route.default) ?? models[0];
              return `• ${provider}${provider === current.provider ? " · current" : ""} · ${String(models.length)} models${defaultModel ? ` · default ${defaultModel.model}` : ""}`;
            }),
            "",
            "Changing provider starts a new empty session. This one is preserved; its transcript is not replayed.",
          ].join("\n"),
    );
    return true;
  }

  if (command.startsWith("/provider ")) {
    const provider = command.slice("/provider ".length).trim();
    const known = (runtime.listModelRoutes?.() ?? []).find((route) => route.provider === provider);
    if (!known) {
      publishInspector(`Unknown provider: ${provider}. Use /provider to list available providers.`);
      return true;
    }
    await selectProvider(runtime.getTrail(trailId), provider, known.providerName ?? provider, context);
    return true;
  }

  if (command === "/model") {
    const current = runtime.getTrail(trailId);
    const routes = (runtime.listModelRoutes?.() ?? []).filter((route) => route.provider === current.provider);
    if (context.selectRoute && routes.length > 0) {
      const selected = await context.selectRoute({
        kind: "model",
        currentProvider: current.provider,
        currentModel: current.model,
        currentThinkingLevel: current.thinkingLevel,
      });
      if (selected) await applyRoutePickerSelection(current, selected, context);
      return true;
    }
    publishInspector(
      routes.length === 0
        ? `Model · ${current.provider}/${current.model}\nModel catalog is unavailable for ${current.provider}.`
        : [
            `Models from ${current.provider} · current ${current.model}`,
            ...routes.map(
              (route) =>
                `• ${route.model}${route.model === current.model ? " · current" : ""}${route.default ? " · default" : ""}\n  ${route.name} · reasoning ${route.thinkingLevels.join(", ") || "off"}`,
            ),
            "",
            "Changing model starts a new empty session. This one is preserved; its transcript is not replayed.",
          ].join("\n"),
    );
    return true;
  }

  if (command.startsWith("/model ")) {
    const model = command.slice("/model ".length).trim();
    const current = runtime.getTrail(trailId);
    const knownRoutes = (await refreshedModelRoutes(runtime)).filter(
      (route) => route.provider === current.provider,
    );
    if (
      knownRoutes.length > 0 &&
      !knownRoutes.some((route) => route.model === model) &&
      !knownRoutes.some((route) => route.allowsCustomModelIds)
    ) {
      publishInspector(`Unknown ${current.provider} model: ${model}. Use /model to list available models.`);
      return true;
    }
    const route = knownRoutes.find((candidate) => candidate.model === model) ?? {
      provider: current.provider,
      model,
      thinkingLevels: Object.freeze([current.thinkingLevel]),
    };
    await selectFreshRoute(current, route, context);
    return true;
  }

  if (command === "/reasoning") {
    const current = runtime.getTrail(trailId);
    const route = runtime
      .listModelRoutes?.()
      .find((candidate) => candidate.provider === current.provider && candidate.model === current.model);
    if (context.selectRoute && route) {
      const selected = await context.selectRoute({
        kind: "reasoning",
        currentProvider: current.provider,
        currentModel: current.model,
        currentThinkingLevel: current.thinkingLevel,
      });
      if (selected) await applyRoutePickerSelection(current, selected, context);
      return true;
    }
    const levels = route?.thinkingLevels ?? THINKING_LEVELS;
    publishInspector(
      [
        `Reasoning · ${current.thinkingLevel}`,
        ...levels.map((level) => `• ${level}${level === current.thinkingLevel ? " · current" : ""}`),
        "",
        "Reasoning changes in this session; provider and model stay fixed.",
      ].join("\n"),
    );
    return true;
  }

  if (command.startsWith("/reasoning ")) {
    const level = command.slice("/reasoning ".length).trim();
    if (!isThinkingLevel(level)) {
      publishInspector(`Unknown reasoning level: ${level}. Use /reasoning to list available levels.`);
      return true;
    }
    const current = runtime.getTrail(trailId);
    const route = (await refreshedModelRoutes(runtime)).find(
      (candidate) => candidate.provider === current.provider && candidate.model === current.model,
    );
    if (route && !route.thinkingLevels.includes(level)) {
      publishInspector(
        `${current.provider}/${current.model} does not support reasoning level ${level}. Supported: ${route.thinkingLevels.join(", ") || "off"}.`,
      );
      return true;
    }
    await setCurrentReasoningLevel(current, level, context);
    return true;
  }

  return false;
}
