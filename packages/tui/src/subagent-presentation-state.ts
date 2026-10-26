import { createConditionalObject } from "@noesis/domain";
import type { AgentRuntimeEvent, SubAgentSummary } from "@noesis/agent-types";
import { summarizeNestedAction } from "./action-summary.ts";

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

/** Names what a running agent is doing right now, e.g. `shell.run rg capability`. */
function toolPhase(event: Extract<AgentRuntimeEvent, { readonly type: "tool-start" }>): string {
  const summary = summarizeNestedAction(
    createConditionalObject({ actionId: event.actionId, name: event.name, status: "running" } as const)
      .addOptional(event.input === undefined ? undefined : { input: event.input })
      .finish(),
  );
  return summary.subject ? `${summary.name} ${summary.subject}` : summary.name;
}

export function reduceSubAgentPhase(
  phases: Readonly<Record<string, string>>,
  agentId: string,
  event: AgentRuntimeEvent,
): Readonly<Record<string, string>> {
  if (event.type === "tool-update") return phases;
  const phase =
    event.type === "reasoning-delta" || event.type === "reasoning-message"
      ? "thinking"
      : event.type === "delta" || event.type === "assistant-message"
        ? "responding"
        : event.type === "tool-start"
          ? toolPhase(event)
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
