import type { AgentRuntimeEvent, SubAgentSummary } from "@noesis/agent-types";

export function retainActiveSubAgentPhases(
  agents: readonly SubAgentSummary[],
  phases: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const activeAgentIds = new Set(
    agents
      .filter((agent) => agent.status === "starting" || agent.status === "running")
      .map((agent) => agent.agentId),
  );
  return Object.freeze(
    Object.fromEntries(Object.entries(phases).filter(([agentId]) => activeAgentIds.has(agentId))),
  );
}

export function reduceSubAgentPhase(
  phases: Readonly<Record<string, string>>,
  agentId: string,
  event: AgentRuntimeEvent,
): Readonly<Record<string, string>> {
  const phase =
    event.type === "reasoning-delta" || event.type === "reasoning-message"
      ? "thinking"
      : event.type === "delta" || event.type === "assistant-message"
        ? "responding"
        : event.type === "tool-start" || event.type === "tool-update"
          ? `tool · ${event.name}`
          : event.type === "tool-end"
            ? "working"
            : event.type === "status" && event.status === "started"
              ? "working"
              : undefined;
  if (phase) return Object.freeze({ ...phases, [agentId]: phase });
  if (event.type !== "status") return phases;
  return Object.freeze(
    Object.fromEntries(Object.entries(phases).filter(([candidate]) => candidate !== agentId)),
  );
}
