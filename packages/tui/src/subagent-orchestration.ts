import { createConditionalObject } from "@noesis/domain";
import type { SubAgentInspection, SubAgentRuntimeEvent } from "@noesis/agent-types";
import type { NoesisView } from "./rendering.ts";
import type { NoesisTuiRuntime, TuiExecutionDetail } from "./runtime-port.ts";
import type { TuiAgentAction } from "./state.ts";

const subAgentActionId = (agentId: string): string => `subagent:${agentId}`;

const subAgentExecutionStatus = (
  status: SubAgentInspection["status"],
): Extract<TuiAgentAction["status"], TuiExecutionDetail["status"]> =>
  status === "starting" || status === "running"
    ? "running"
    : status === "idle"
      ? "completed"
      : status === "closed"
        ? "cancelled"
        : "interrupted";

export interface TuiSubAgentOrchestration {
  readonly openInspector: (agentId: string) => void;
  readonly dispose: () => void;
}

export function createTuiSubAgentOrchestration(options: {
  readonly runtime: NoesisTuiRuntime;
  readonly view: NoesisView;
  readonly showInspector: (actionId: string, syntheticAction: TuiAgentAction) => void;
  readonly requestRender: () => void;
  readonly reportFailure: (cause: unknown) => void;
}): TuiSubAgentOrchestration {
  let disposed = false;
  const loadDetail = async (agentId: string): Promise<TuiExecutionDetail> => {
    const [inspection, transcript] = await Promise.all([
      options.runtime.inspectSubAgent(agentId),
      options.runtime.getSubAgentTranscript(agentId),
    ]);
    const latestTask = inspection.tasks.at(-1);
    const initialMessage = inspection.recentMessages.find(
      (message) => message.recipient.kind === "subagent" && message.recipient.id === agentId,
    );
    return Object.freeze(
      createConditionalObject({
        kind: "subagent" as const,
        executionId: inspection.agentId,
        label: inspection.name ?? `Subagent ${inspection.agentId.slice(-8)}`,
        status: subAgentExecutionStatus(inspection.status),
        toolNames: Object.freeze([...inspection.tools]),
        callCount: transcript.filter((entry) => entry.kind === "action").length,
        startedAt: inspection.createdAt,
      } as const)
        .addOptional(inspection.status === "closed" ? { completedAt: inspection.updatedAt } : undefined)
        .add({
          provider: inspection.route.provider,
          model: inspection.route.model,
          thinkingLevel: inspection.thinkingLevel,
          systemPrompt: inspection.systemPrompt,
        } as const)
        .addOptional(initialMessage ? { prompt: initialMessage.content } : undefined)
        .addOptional(latestTask?.result ? { result: latestTask.result } : undefined)
        .addOptional(latestTask?.error ? { error: latestTask.error } : undefined)
        .add({ subAgent: inspection, transcript } as const)
        .finish(),
    );
  };
  const refreshInspector = async (agentId: string): Promise<void> => {
    const actionId = subAgentActionId(agentId);
    try {
      const detail = await loadDetail(agentId);
      if (disposed) return;
      options.view.dispatch({ type: "inspector-loaded", actionId, detail });
      options.requestRender();
    } catch (cause) {
      if (!disposed && options.view.state.inspector?.actionId === actionId) options.reportFailure(cause);
    }
  };
  const refresh = async (): Promise<void> => {
    const subAgents = await options.runtime.listSubAgents();
    if (disposed) return;
    options.view.dispatch({ type: "subagents-hydrated", subAgents });
    options.requestRender();
  };
  const openInspector = (agentId: string): void => {
    const summary = options.view.state.subAgents.find((agent) => agent.agentId === agentId);
    if (!summary) return;
    const actionId = subAgentActionId(agentId);
    const syntheticAction = createConditionalObject({
      actionId,
      name: summary.name ?? "subagent",
      status: subAgentExecutionStatus(summary.status),
      startedAt: Date.parse(summary.createdAt),
    } as const)
      .addOptional(
        summary.latestActivity
          ? {
              durationMs: Math.max(0, Date.parse(summary.latestActivity) - Date.parse(summary.createdAt)),
            }
          : undefined,
      )
      .finish();
    options.showInspector(actionId, syntheticAction);
    void refreshInspector(agentId);
  };
  const onEvent = (event: SubAgentRuntimeEvent): void => {
    if (event.type === "live") {
      options.view.dispatch({
        type: "subagent-live-event",
        actionId: subAgentActionId(event.agentId),
        event,
      });
      options.requestRender();
      return;
    }
    if (event.type === "message" && event.status === "accepted" && event.recipient.kind === "foreground")
      options.view.dispatch({
        type: "notification-shown",
        text:
          event.recipient.id === options.view.state.trailId
            ? "A subagent message is waiting for this session's next safe boundary."
            : "A subagent message is waiting in another session; resume it to deliver.",
        tone: "info",
      });
    void refresh().catch(options.reportFailure);
    if (options.view.state.inspector?.actionId === subAgentActionId(event.agentId))
      void refreshInspector(event.agentId);
  };
  const removeListener = options.runtime.subscribeSubAgents(onEvent);
  void refresh().catch(options.reportFailure);
  return Object.freeze({
    openInspector,
    dispose: () => {
      disposed = true;
      removeListener();
    },
  });
}
