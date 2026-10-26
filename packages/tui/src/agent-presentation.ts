import type { SubAgentSummary } from "@noesis/agent-types";
import { stringField } from "./record-fields.ts";
import type { TuiAgentAction } from "./state.ts";
import { ANSI, safeTerminalText } from "./theme.ts";
import { isPulseDimFrame, WORKING_ANIMATION_INTERVAL_MS } from "./working-animation.ts";

export const AGENTS_SPAWN_ACTION_NAME = "agents.spawn";
const AGENT_REFERENCE_ACTIONS: ReadonlySet<string> = new Set([
  AGENTS_SPAWN_ACTION_NAME,
  "agents.wait",
  "agents.send",
  "agents.inspect",
  "agents.cancel",
  "agents.close",
]);

const isActive = (agent: Pick<SubAgentSummary, "status">): boolean =>
  agent.status === "starting" || agent.status === "running";

/**
 * The retained agent an `agents.*` call refers to. Spawn reports the agent it admitted; a wait
 * names a task, which resolves through the agent's active or latest task handle.
 */
export function boundAgent(
  action: TuiAgentAction,
  subAgents: readonly SubAgentSummary[],
): SubAgentSummary | undefined {
  if (!AGENT_REFERENCE_ACTIONS.has(action.name)) return undefined;
  const agentId = stringField(action.output, "agentId") ?? stringField(action.input, "agentId");
  if (agentId) return subAgents.find((agent) => agent.agentId === agentId);
  const taskId = stringField(action.input, "taskId");
  return taskId
    ? subAgents.find((agent) => agent.activeTaskId === taskId || agent.latestTaskId === taskId)
    : undefined;
}

export function agentDisplayName(agent: Pick<SubAgentSummary, "agentId" | "name">): string {
  const name = safeTerminalText(agent.name ?? "")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return name || `agent ${agent.agentId.slice(-6)}`;
}

/** Compact wall-clock duration that reads at a glance: `0:42`, `12:03`, `1:02:03`. */
export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${String(minutes)}:${seconds}`;
}

/** Running agents count from their start to the view clock; settled agents to their last update. */
export function agentElapsed(
  agent: Pick<SubAgentSummary, "status" | "createdAt" | "updatedAt" | "latestActivity">,
  clock: number,
): string | undefined {
  const started = Date.parse(agent.createdAt);
  if (!Number.isFinite(started)) return undefined;
  if (isActive(agent)) return clock > 0 ? formatElapsed(clock - started) : undefined;
  // A retained actor is updated again when it is suspended or closed; its work ended with its task.
  const ended = Date.parse(agent.latestActivity ?? agent.updatedAt);
  return Number.isFinite(ended) ? formatElapsed(ended - started) : undefined;
}

export type AgentOutcome = "running" | "done" | "failed" | "stopped" | "closed";

/** How the agent's work ended matters more than its actor lifecycle, so the task status leads. */
export function agentOutcome(agent: Pick<SubAgentSummary, "status" | "latestTaskStatus">): AgentOutcome {
  if (isActive(agent)) return "running";
  if (agent.latestTaskStatus === "failed") return "failed";
  if (agent.latestTaskStatus === "cancelled" || agent.latestTaskStatus === "interrupted") return "stopped";
  if (agent.latestTaskStatus === "completed") return "done";
  if (agent.status === "closed") return "closed";
  return agent.status === "suspended" ? "stopped" : "done";
}

export function agentGlyph(outcome: AgentOutcome): string {
  return outcome === "running"
    ? "●"
    : outcome === "done"
      ? "✓"
      : outcome === "failed"
        ? "×"
        : outcome === "stopped"
          ? "■"
          : "○";
}

export function agentColor(outcome: AgentOutcome): string {
  return outcome === "running"
    ? ANSI.cyan
    : outcome === "done"
      ? ANSI.green
      : outcome === "failed"
        ? ANSI.red
        : outcome === "stopped"
          ? ANSI.yellow
          : ANSI.dim;
}

/** Live agents breathe on their own clock, independent of whether the foreground is working. */
export function agentPulseDim(outcome: AgentOutcome, clock: number): boolean {
  return (
    outcome === "running" && clock > 0 && isPulseDimFrame(Math.floor(clock / WORKING_ANIMATION_INTERVAL_MS))
  );
}

/** What the agent is doing now, or how its latest task ended. */
export function agentActivity(
  agent: Pick<SubAgentSummary, "agentId" | "status" | "latestTaskStatus">,
  phases: Readonly<Record<string, string>>,
): string {
  const outcome = agentOutcome(agent);
  if (outcome === "running") {
    const phase = phases[agent.agentId];
    if (!phase) return "starting…";
    const text = safeTerminalText(phase).replaceAll(/\s+/gu, " ").trim();
    // A one-word phase such as `thinking` reads as ongoing with an ellipsis; a tool call with its
    // subject would read as truncated.
    return text.includes(" ") ? text : `${text}…`;
  }
  return outcome === "stopped" ? (agent.latestTaskStatus ?? agent.status) : outcome;
}

export interface AgentCardPresentation {
  readonly outcome: AgentOutcome;
  readonly title: string;
  readonly detail: readonly string[];
  readonly pulseDim: boolean;
}

/**
 * The inline transcript card for a spawned agent. Transcript rows scroll into terminal
 * scrollback, and changing a row above the viewport forces a full repaint, so a card changes only
 * when the agent's outcome does. Ticking time and live activity belong to the agent strip.
 */
export function agentCardPresentation(agent: SubAgentSummary): AgentCardPresentation {
  const outcome = agentOutcome(agent);
  const elapsed = outcome === "running" ? undefined : agentElapsed(agent, 0);
  const label = outcome === "stopped" ? (agent.latestTaskStatus ?? agent.status) : outcome;
  return Object.freeze({
    outcome,
    title: agentDisplayName(agent),
    detail: Object.freeze([label, ...(elapsed ? [elapsed] : [])]),
    pulseDim: false,
  });
}
