import { paginateInspectorText } from "./lifecycle-utils.ts";
import type {
  NoesisTuiRuntime,
  TuiInteractionResult,
  TuiLearningActivitySummary,
  TuiLearningInspection,
  TuiWorkingAdjustmentState,
} from "./runtime-port.ts";
import type { NoesisTuiAction } from "./state.ts";

export interface SlashCommandContext {
  readonly runtime: NoesisTuiRuntime;
  readonly trailId: string;
  /** Publishes bounded read-only output, dropping results from superseded submissions. */
  readonly publishInspector: (message: string) => void;
  readonly dispatch: (action: NoesisTuiAction) => void;
  readonly requestRender: () => void;
  readonly openMcpManager?: () => void;
}

export const HELP_LINES = [
  "/model provider/model · /context · /capabilities",
  "/skills · /scripts · /workflows · /runs · /learning",
  "/mcp manages servers, authentication, and discovered capabilities",
  "/skill NAME inspects · /skill:NAME [instructions] invokes command-name collisions",
  "/script NAME · /workflow NAME · /run ID",
  "/fork · /compact · /steer [MESSAGE] · /queue resume",
  "enter queues during work · alt+↑ edits newest queued · esc interrupts",
  "shift+enter newline · ctrl+g external editor",
  "ctrl+o inspect runs · space expand · enter open the run inspector",
  "/quit · learning, experiments, activation, and revert run ambiently",
] as const;

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
  return command === "/compact" || command === "/fork" || command.startsWith("/model ");
}

export function steerFeedback(result: TuiInteractionResult, explicit: boolean): string | undefined {
  if (result.effect === "unresolved")
    return "Steer delivery could not be confirmed. It is held for inspection and will not retry automatically.";
  if (result.effect !== "idle") return undefined;
  return explicit ? "No active turn is available to steer." : "No queued message is available to promote.";
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
                `• ${skill.name}${skill.disableModelInvocation ? " · explicit only" : ""}\n  ${skill.description}\n  ${skill.filePath}`,
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

  if (command === "/scripts") {
    if (!runtime.listScripts) {
      publishInspector("Script inspection is unavailable in this runtime.");
      return true;
    }
    const scripts = await runtime.listScripts();
    publishInspector(
      scripts.length === 0
        ? "No reusable scripts have been saved yet."
        : [
            `Scripts · ${String(scripts.length)}`,
            ...scripts.map(
              (script) =>
                `• ${script.name} · r${String(script.revision)}\n  ${script.description}\n  ${script.requiredTools.join(", ") || "pure JavaScript"}\n  ${script.workingPath}`,
            ),
            "",
            "Ask Noesis to run one by name, or say “save that as a script” after useful work.",
          ].join("\n"),
    );
    return true;
  }

  if (command.startsWith("/script ")) {
    const name = command.slice("/script ".length).trim();
    if (!runtime.inspectScript) {
      publishInspector("Script detail inspection is unavailable in this runtime.");
      return true;
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
    return true;
  }

  if (command === "/workflows") {
    if (!runtime.listWorkflows) {
      publishInspector("Workflow inspection is unavailable in this runtime.");
      return true;
    }
    const workflows = await runtime.listWorkflows();
    publishInspector(
      workflows.length === 0
        ? "No multi-phase workflows have been saved yet."
        : [
            `Workflows · ${String(workflows.length)}`,
            ...workflows.map(
              (workflow) =>
                `• ${workflow.name} · r${String(workflow.revision)} · ${String(workflow.phaseNames.length)} phases\n  ${workflow.description}\n  ${workflow.phaseNames.join(" → ")}\n  ${workflow.workingPath}`,
            ),
            "",
            "Ask Noesis to run or resume a workflow by name.",
          ].join("\n"),
    );
    return true;
  }

  if (command.startsWith("/workflow ")) {
    const name = command.slice("/workflow ".length).trim();
    if (!runtime.inspectWorkflow) {
      publishInspector("Workflow detail inspection is unavailable in this runtime.");
      return true;
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

  if (command === "/compact") {
    dispatch({ type: "execution-changed", execution: "compacting" });
    requestRender();
    await runtime.compact(trailId);
    dispatch({ type: "compacted" });
    dispatch({ type: "system-message", text: "Trail compacted." });
    requestRender();
    return true;
  }

  if (command === "/fork") {
    const trail = await runtime.forkTrail(trailId);
    const transcript = await runtime.getTranscript(trail.trailId);
    dispatch({ type: "trail-selected", trail });
    dispatch({ type: "transcript-hydrated", trailId: trail.trailId, transcript });
    requestRender();
    return true;
  }

  if (command.startsWith("/model ")) {
    const selection = command.slice("/model ".length).trim();
    const separator = selection.indexOf("/");
    if (separator <= 0 || separator === selection.length - 1) {
      dispatch({ type: "failed", error: "Use /model provider/model" });
    } else {
      dispatch({
        type: "trail-selected",
        trail: await runtime.startTrail({
          title: `Model ${selection}`,
          provider: selection.slice(0, separator),
          model: selection.slice(separator + 1),
        }),
      });
    }
    requestRender();
    return true;
  }

  return false;
}
