import type {
  AgentAddress,
  AgentMessageReceipt,
  AgentRuntimeEvent,
  AgentSteerResult,
  SubAgentHandle,
  SubAgentInspection,
  SubAgentRuntimeEvent,
  SubAgentSummary,
  SubAgentTaskResult,
} from "@noesis/agent-types";
import type {
  AgentMailboxMessageRecord,
  NoesisWorkspaceStore,
  SessionRecord,
  SubAgentRecord,
  SubAgentTaskRecord,
} from "@noesis/workspace";
import { createConditionalObject } from "@noesis/domain";
import type { RuntimeTranscriptEntry } from "./index.ts";

const terminalTaskStatuses: ReadonlySet<SubAgentTaskRecord["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export interface SubAgentTaskExecutionPort {
  readonly run: (request: {
    readonly agent: SubAgentRecord;
    readonly task: SubAgentTaskRecord;
    readonly messages: readonly AgentMailboxMessageRecord[];
    readonly emit: (event: AgentRuntimeEvent) => void;
  }) => Promise<{
    readonly text: string;
    readonly usage?: SubAgentTaskResult["usage"];
  }>;
  readonly steer: (taskId: string, message: string) => Promise<AgentSteerResult>;
  readonly cancel: (taskId: string) => Promise<void>;
}

export interface SubAgentSupervisor {
  readonly spawn: (request: {
    readonly agent: SubAgentRecord;
    readonly task: SubAgentTaskRecord;
    readonly message: AgentMailboxMessageRecord;
    readonly childSession: SessionRecord;
  }) => Promise<SubAgentHandle>;
  readonly send: (request: {
    readonly projectId: string;
    readonly sender: AgentAddress;
    readonly recipient: AgentAddress;
    readonly content: string;
    readonly sensitivity?: AgentMailboxMessageRecord["sensitivity"];
  }) => Promise<AgentMessageReceipt>;
  readonly wait: (taskId: string, signal?: AbortSignal, timeoutMs?: number) => Promise<SubAgentTaskResult>;
  readonly cancel: (taskId: string, reason?: string) => Promise<SubAgentTaskResult>;
  readonly close: (agentId: string, reason?: string) => Promise<void>;
  readonly list: (projectId: string) => Promise<readonly SubAgentSummary[]>;
  readonly inspect: (projectId: string, agentId: string, taskId?: string) => Promise<SubAgentInspection>;
  readonly transcript: (
    projectId: string,
    agentId: string,
    taskId?: string,
  ) => Promise<readonly RuntimeTranscriptEntry[]>;
  /** Retry accepted child messages once the addressed foreground session can consume steering. */
  readonly deliverPendingForeground: (sessionId: string) => Promise<number>;
  readonly subscribe: (listener: (event: SubAgentRuntimeEvent) => void) => () => void;
  readonly shutdown: () => Promise<void>;
}

export interface CreateSubAgentSupervisorOptions {
  readonly workspace: Pick<NoesisWorkspaceStore, "operational">;
  readonly taskExecution: SubAgentTaskExecutionPort;
  readonly createId: (prefix: "task" | "message") => string;
  readonly now?: () => string;
  readonly persistResult: (request: {
    readonly agent: SubAgentRecord;
    readonly task: SubAgentTaskRecord;
    readonly text: string;
  }) => Promise<{ readonly artifactId: string; readonly preview: string }>;
  readonly transcript: (agent: SubAgentRecord, taskId?: string) => Promise<readonly RuntimeTranscriptEntry[]>;
  readonly transcriptArtifact?: (
    agent: SubAgentRecord,
    taskId?: string,
  ) => Promise<SubAgentInspection["transcriptArtifact"]>;
  readonly persistDeliveredMessage: (request: {
    readonly agent: SubAgentRecord;
    readonly task: SubAgentTaskRecord;
    readonly message: AgentMailboxMessageRecord;
    readonly timelineSequence: number;
    readonly consumedAt: string;
  }) => Promise<void>;
  readonly deliverForeground?: (request: {
    readonly message: AgentMailboxMessageRecord;
  }) => Promise<"delivered" | "pending">;
}

function taskResult(task: SubAgentTaskRecord): SubAgentTaskResult {
  return Object.freeze(
    createConditionalObject({
      taskId: task.taskId,
      agentId: task.agentId,
      status: task.status,
    } as const)
      .addOptional(task.resultPreview !== undefined ? { result: task.resultPreview } : undefined)
      .addOptional(task.error ? { error: task.error } : undefined)
      .addOptional(task.usage ? { usage: task.usage } : undefined)
      .addOptional(task.startedAt ? { startedAt: task.startedAt } : undefined)
      .addOptional(task.completedAt ? { completedAt: task.completedAt } : undefined)
      .finish(),
  );
}

function isTerminal(task: SubAgentTaskRecord): boolean {
  return terminalTaskStatuses.has(task.status);
}

function collaborationMessage(message: AgentMailboxMessageRecord): string {
  return [
    `<collaboration_message sender_kind="${message.sender.kind}" sender_id="${message.sender.id}" message_id="${message.messageId}">`,
    message.content,
    "</collaboration_message>",
  ].join("\n");
}

export function createSubAgentSupervisor(options: CreateSubAgentSupervisorOptions): SubAgentSupervisor {
  const now = options.now ?? (() => new Date().toISOString());
  const listeners = new Set<(event: SubAgentRuntimeEvent) => void>();
  const running = new Map<string, Promise<void>>();
  const deliveries = new Set<Promise<void>>();
  const waiters = new Map<string, Set<(result: SubAgentTaskResult) => void>>();
  const agentTails = new Map<string, Promise<void>>();
  let closing = false;

  const publish = (event: SubAgentRuntimeEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const serializeAgent = async <Value>(agentId: string, operation: () => Promise<Value>): Promise<Value> => {
    const prior = agentTails.get(agentId) ?? Promise.resolve();
    const active = prior.catch(() => undefined).then(operation);
    const tail = active.then(
      () => undefined,
      () => undefined,
    );
    agentTails.set(agentId, tail);
    try {
      return await active;
    } finally {
      if (agentTails.get(agentId) === tail) agentTails.delete(agentId);
    }
  };
  const resolveWaiters = (task: SubAgentTaskRecord): void => {
    if (!isTerminal(task)) return;
    const pending = waiters.get(task.taskId);
    if (!pending) return;
    waiters.delete(task.taskId);
    const result = taskResult(task);
    for (const resolve of pending) resolve(result);
  };
  const updateAgentStatus = async (
    agent: SubAgentRecord,
    status: SubAgentRecord["status"],
    updatedAt: string,
    closedAt?: string,
  ): Promise<SubAgentRecord> => {
    const updated = Object.freeze(
      createConditionalObject({ ...agent, status, updatedAt })
        .addOptional(closedAt ? { closedAt } : undefined)
        .finish(),
    );
    await options.workspace.operational.subAgents.put(updated);
    publish({ type: "changed", agentId: agent.agentId });
    return updated;
  };
  const settleTask = async (
    task: SubAgentTaskRecord,
    settlement: Pick<SubAgentTaskRecord, "status" | "resultArtifactId" | "resultPreview" | "error" | "usage">,
  ): Promise<SubAgentTaskRecord> => {
    const settled = Object.freeze({
      ...task,
      ...settlement,
      completedAt: now(),
    });
    await options.workspace.operational.subAgents.putTask(settled);
    resolveWaiters(settled);
    publish({ type: "changed", agentId: task.agentId, taskId: task.taskId });
    return settled;
  };
  const schedule = (agentId: string, taskId: string): void => {
    if (closing || running.has(taskId)) return;
    const execution = (async () => {
      const startedAt = now();
      const claimed = await options.workspace.operational.subAgents.claimTask(taskId, startedAt);
      if (!claimed) return;
      let agent = await options.workspace.operational.subAgents.get(agentId);
      if (!agent || agent.status === "closed" || agent.status === "suspended") {
        await settleTask(claimed, {
          status: "interrupted",
          error: "Subagent became unavailable before task start",
        });
        return;
      }
      agent = await updateAgentStatus(agent, "running", startedAt);
      const allMessages = await options.workspace.operational.subAgents.listMessages(agentId);
      const messages = allMessages.filter((message) => message.taskId === taskId);
      for (const message of messages) {
        if (message.status !== "accepted") continue;
        await options.workspace.operational.subAgents.putMessage({
          ...message,
          status: "claimed",
          claimedAt: startedAt,
        });
      }
      publish({ type: "changed", agentId, taskId });
      try {
        const result = await options.taskExecution.run({
          agent,
          task: claimed,
          messages,
          emit: (event) => publish({ type: "live", agentId, taskId, event }),
        });
        const persisted = await options.persistResult({ agent, task: claimed, text: result.text });
        const settled = await settleTask(
          claimed,
          createConditionalObject({
            status: "completed" as const,
            resultArtifactId: persisted.artifactId,
            resultPreview: persisted.preview,
          })
            .addOptional(result.usage ? { usage: result.usage } : undefined)
            .finish(),
        );
        for (const message of messages) {
          const current = await options.workspace.operational.subAgents.getMessage(message.messageId);
          if (!current || current.status !== "claimed") continue;
          await options.workspace.operational.subAgents.putMessage({
            ...current,
            status: "delivered",
            deliveredAt: settled.completedAt ?? now(),
          });
        }
      } catch (cause) {
        const current = await options.workspace.operational.subAgents.getTask(taskId);
        if (!current || isTerminal(current)) return;
        const error = cause instanceof Error ? cause.message : String(cause);
        await settleTask(current, {
          status: error === "Subagent task was cancelled" ? "cancelled" : "failed",
          error,
        });
      } finally {
        const currentAgent = await options.workspace.operational.subAgents.get(agentId);
        if (currentAgent && currentAgent.status === "running")
          await updateAgentStatus(currentAgent, closing ? "suspended" : "idle", now());
      }
    })()
      .catch(async (cause: unknown) => {
        const current = await options.workspace.operational.subAgents.getTask(taskId);
        if (current && !isTerminal(current))
          await settleTask(current, {
            status: "failed",
            error: cause instanceof Error ? cause.message : String(cause),
          });
        const agent = await options.workspace.operational.subAgents.get(agentId);
        if (agent?.status === "running")
          await updateAgentStatus(agent, closing ? "suspended" : "idle", now());
      })
      .finally(() => running.delete(taskId));
    running.set(taskId, execution);
    void execution;
  };
  const trackDelivery = (operation: Promise<void>): void => {
    deliveries.add(operation);
    void operation.finally(() => deliveries.delete(operation));
  };

  const spawn: SubAgentSupervisor["spawn"] = async (request) => {
    if (closing) throw new Error("Subagent supervisor is shutting down");
    await options.workspace.operational.subAgents.admit(request);
    publish({ type: "changed", agentId: request.agent.agentId, taskId: request.task.taskId });
    schedule(request.agent.agentId, request.task.taskId);
    return Object.freeze(
      createConditionalObject({
        agentId: request.agent.agentId,
        taskId: request.task.taskId,
        status: "accepted" as const,
      })
        .addOptional(request.agent.name ? { name: request.agent.name } : undefined)
        .finish(),
    );
  };

  const deliverForegroundMessage = async (message: AgentMailboxMessageRecord): Promise<boolean> => {
    const current = await options.workspace.operational.subAgents.getMessage(message.messageId);
    if (!current || current.status !== "accepted") return false;
    const delivered = await options.deliverForeground?.({ message: current });
    if (delivered !== "delivered") return false;
    const claimedAt = now();
    await options.workspace.operational.subAgents.putMessage({
      ...current,
      status: "claimed",
      claimedAt,
    });
    await options.workspace.operational.subAgents.putMessage({
      ...current,
      status: "delivered",
      claimedAt,
      deliveredAt: now(),
    });
    publish({
      type: "message",
      agentId: current.sender.id,
      messageId: current.messageId,
      recipient: current.recipient,
      status: "delivered",
    });
    return true;
  };

  const deliverPendingForeground: SubAgentSupervisor["deliverPendingForeground"] = async (sessionId) =>
    await serializeAgent(`foreground:${sessionId}`, async () => {
      const pending = await options.workspace.operational.subAgents.listAcceptedMessagesForRecipient({
        kind: "foreground",
        id: sessionId,
      });
      let delivered = 0;
      for (const message of pending) {
        if (await deliverForegroundMessage(message)) delivered += 1;
      }
      return delivered;
    });

  const send: SubAgentSupervisor["send"] = async (request) => {
    if (closing) throw new Error("Subagent supervisor is shutting down");
    if (!request.content.trim()) throw new Error("Agent message must not be empty");
    const messageId = options.createId("message");
    if (request.recipient.kind === "foreground") {
      const message = await options.workspace.operational.subAgents.appendMessage({
        messageId,
        projectId: request.projectId,
        sender: request.sender,
        recipient: request.recipient,
        content: request.content,
        sensitivity: request.sensitivity ?? "normal",
        status: "accepted",
        createdAt: now(),
      });
      publish({
        type: "message",
        agentId: request.sender.id,
        messageId,
        recipient: request.recipient,
        status: "accepted",
      });
      trackDelivery(
        serializeAgent(`foreground:${request.recipient.id}`, async () => {
          await deliverForegroundMessage(message);
        }).catch(async (cause: unknown) => {
          const current = await options.workspace.operational.subAgents.getMessage(message.messageId);
          if (current?.status === "accepted")
            await options.workspace.operational.subAgents.putMessage({
              ...current,
              status: "failed",
              failedAt: now(),
              failure: cause instanceof Error ? cause.message : String(cause),
            });
        }),
      );
      return Object.freeze({ messageId, status: "accepted" as const });
    }
    return await serializeAgent(request.recipient.id, async () => {
      const agent = await options.workspace.operational.subAgents.get(request.recipient.id);
      if (!agent || agent.projectId !== request.projectId || agent.status === "closed")
        throw new Error(`Subagent ${request.recipient.id} is unavailable`);
      const tasks = await options.workspace.operational.subAgents.listTasks(agent.agentId);
      const active = tasks.find((task) => task.status === "pending" || task.status === "running");
      if (active) {
        const message = await options.workspace.operational.subAgents.appendMessage({
          messageId,
          projectId: request.projectId,
          sender: request.sender,
          recipient: request.recipient,
          content: request.content,
          sensitivity: request.sensitivity ?? "normal",
          status: "accepted",
          taskId: active.taskId,
          createdAt: now(),
        });
        publish({
          type: "message",
          agentId: agent.agentId,
          messageId,
          recipient: request.recipient,
          status: "accepted",
        });
        const currentTask = await options.workspace.operational.subAgents.getTask(active.taskId);
        if (currentTask?.status === "running") {
          const claimedAt = now();
          await options.workspace.operational.subAgents.putMessage({
            ...message,
            status: "claimed",
            claimedAt,
          });
          trackDelivery(
            options.taskExecution
              .steer(active.taskId, collaborationMessage(message))
              .then(async (delivery) => {
                if (delivery.status === "consumed") {
                  await options.persistDeliveredMessage({
                    agent,
                    task: currentTask,
                    message,
                    timelineSequence: delivery.timelineSequence,
                    consumedAt: delivery.consumedAt,
                  });
                  const current = await options.workspace.operational.subAgents.getMessage(messageId);
                  if (current?.status === "claimed")
                    await options.workspace.operational.subAgents.putMessage({
                      ...current,
                      status: "delivered",
                      deliveredAt: delivery.consumedAt,
                    });
                  return;
                }
                const current = await options.workspace.operational.subAgents.getMessage(messageId);
                if (current?.status === "claimed")
                  await options.workspace.operational.subAgents.putMessage({
                    ...current,
                    status: "failed",
                    failedAt: now(),
                    failure: "The target task settled before it could consume this message",
                  });
              })
              .catch(async (cause: unknown) => {
                const current = await options.workspace.operational.subAgents.getMessage(messageId);
                if (current?.status === "claimed")
                  await options.workspace.operational.subAgents.putMessage({
                    ...current,
                    status: "failed",
                    failedAt: now(),
                    failure: cause instanceof Error ? cause.message : String(cause),
                  });
              }),
          );
        }
        return Object.freeze({ messageId, taskId: active.taskId, status: "accepted" as const });
      }
      if (agent.status !== "idle") throw new Error(`Subagent ${agent.agentId} cannot accept new work`);
      const taskId = options.createId("task");
      const createdAt = now();
      const task: SubAgentTaskRecord = Object.freeze({
        taskId,
        agentId: agent.agentId,
        triggerMessageId: messageId,
        status: "pending",
        createdAt,
      });
      await options.workspace.operational.subAgents.admitMessageTask({
        message: {
          messageId,
          projectId: request.projectId,
          sender: request.sender,
          recipient: request.recipient,
          content: request.content,
          sensitivity: request.sensitivity ?? "normal",
          status: "accepted",
          taskId,
          createdAt,
        },
        task,
      });
      publish({
        type: "message",
        agentId: agent.agentId,
        messageId,
        recipient: request.recipient,
        status: "accepted",
      });
      publish({ type: "changed", agentId: agent.agentId, taskId });
      schedule(agent.agentId, taskId);
      return Object.freeze({ messageId, taskId, status: "accepted" as const });
    });
  };

  const wait: SubAgentSupervisor["wait"] = async (taskId, signal, timeoutMs) => {
    const current = await options.workspace.operational.subAgents.getTask(taskId);
    if (!current) throw new Error(`Subagent task ${taskId} does not exist`);
    if (isTerminal(current)) return taskResult(current);
    return await new Promise<SubAgentTaskResult>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const listenersForTask = waiters.get(taskId) ?? new Set();
      const settle = (result: SubAgentTaskResult): void => {
        cleanup();
        resolve(result);
      };
      const abort = (): void => {
        cleanup();
        reject(new Error("Subagent wait was cancelled; the task is still running"));
      };
      const cleanup = (): void => {
        listenersForTask.delete(settle);
        if (listenersForTask.size === 0) waiters.delete(taskId);
        signal?.removeEventListener("abort", abort);
        if (timer) clearTimeout(timer);
      };
      listenersForTask.add(settle);
      waiters.set(taskId, listenersForTask);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      if (timeoutMs !== undefined)
        timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for subagent task ${taskId}; the task is still running`));
        }, timeoutMs);
      void options.workspace.operational.subAgents.getTask(taskId).then((latest) => {
        if (latest && isTerminal(latest)) settle(taskResult(latest));
      }, reject);
    });
  };

  const cancel: SubAgentSupervisor["cancel"] = async (taskId, reason) => {
    const task = await options.workspace.operational.subAgents.getTask(taskId);
    if (!task) throw new Error(`Subagent task ${taskId} does not exist`);
    if (isTerminal(task)) return taskResult(task);
    await options.taskExecution.cancel(taskId);
    const current = await options.workspace.operational.subAgents.getTask(taskId);
    if (current && isTerminal(current)) return taskResult(current);
    const settled = await settleTask(current ?? task, {
      status: "cancelled",
      error: reason?.trim() || "Subagent task was cancelled",
    });
    const agent = await options.workspace.operational.subAgents.get(task.agentId);
    if (agent && agent.status === "running") await updateAgentStatus(agent, "idle", now());
    return taskResult(settled);
  };

  const close: SubAgentSupervisor["close"] = async (agentId, reason) => {
    await serializeAgent(agentId, async () => {
      const agent = await options.workspace.operational.subAgents.get(agentId);
      if (!agent || agent.status === "closed") return;
      const active = (await options.workspace.operational.subAgents.listTasks(agentId)).find(
        (task) => task.status === "pending" || task.status === "running",
      );
      if (active) await cancel(active.taskId, reason ?? "Subagent was closed");
      const current = (await options.workspace.operational.subAgents.get(agentId)) ?? agent;
      await updateAgentStatus(current, "closed", now(), now());
    });
  };

  const list: SubAgentSupervisor["list"] = async (projectId) => {
    const agents = await options.workspace.operational.subAgents.listForProject(projectId);
    return Object.freeze(
      await Promise.all(
        agents.map(async (agent): Promise<SubAgentSummary> => {
          const tasks = await options.workspace.operational.subAgents.listTasks(agent.agentId);
          const latest = tasks.at(-1);
          const active = tasks.find((task) => task.status === "pending" || task.status === "running");
          return Object.freeze(
            createConditionalObject({
              agentId: agent.agentId,
              childSessionId: agent.childSessionId,
              projectId: agent.projectId,
              originSessionId: agent.originSessionId,
              status: agent.status,
              route: Object.freeze({ ...agent.frozenPlan.route }),
              thinkingLevel: agent.frozenPlan.thinkingLevel,
              createdAt: agent.createdAt,
              updatedAt: agent.updatedAt,
            } as const)
              .addOptional(agent.parentAgentId ? { parentAgentId: agent.parentAgentId } : undefined)
              .addOptional(agent.name ? { name: agent.name } : undefined)
              .addOptional(active ? { activeTaskId: active.taskId } : undefined)
              .addOptional(
                latest ? { latestTaskId: latest.taskId, latestTaskStatus: latest.status } : undefined,
              )
              .addOptional(
                latest
                  ? { latestActivity: latest.completedAt ?? latest.startedAt ?? latest.createdAt }
                  : undefined,
              )
              .finish(),
          );
        }),
      ),
    );
  };

  const inspect: SubAgentSupervisor["inspect"] = async (projectId, agentId, taskId) => {
    const agent = await options.workspace.operational.subAgents.get(agentId);
    if (!agent || agent.projectId !== projectId) throw new Error(`Subagent ${agentId} is unavailable`);
    const summaries = await list(projectId);
    const summary = summaries.find((candidate) => candidate.agentId === agentId);
    if (!summary) throw new Error(`Subagent ${agentId} is unavailable`);
    const tasks = await options.workspace.operational.subAgents.listTasks(agentId);
    if (taskId && !tasks.some((task) => task.taskId === taskId))
      throw new Error(`Task ${taskId} does not belong to subagent ${agentId}`);
    const messages = await options.workspace.operational.subAgents.listMessages(agentId);
    const artifact = await options.transcriptArtifact?.(agent, taskId);
    return Object.freeze(
      createConditionalObject({
        ...summary,
        systemPrompt: agent.frozenPlan.renderedSystemPrompt,
        tools: Object.freeze(agent.frozenPlan.frozenTools.map((tool) => tool.name)),
        tasks: Object.freeze(tasks.map(taskResult)),
        recentMessages: Object.freeze(
          messages.slice(-50).map((message) =>
            Object.freeze({
              messageId: message.messageId,
              sender: Object.freeze({ ...message.sender }),
              recipient: Object.freeze({ ...message.recipient }),
              content: message.content,
              status: message.status,
              createdAt: message.createdAt,
            }),
          ),
        ),
      } as const)
        .addOptional(artifact ? { transcriptArtifact: artifact } : undefined)
        .finish(),
    );
  };

  const transcript: SubAgentSupervisor["transcript"] = async (projectId, agentId, taskId) => {
    const agent = await options.workspace.operational.subAgents.get(agentId);
    if (!agent || agent.projectId !== projectId) throw new Error(`Subagent ${agentId} is unavailable`);
    return await options.transcript(agent, taskId);
  };

  const shutdown: SubAgentSupervisor["shutdown"] = async () => {
    if (closing) return;
    closing = true;
    const agents = await Promise.all(
      [...running.keys()].map(async (taskId) => {
        const task = await options.workspace.operational.subAgents.getTask(taskId);
        if (task) await options.taskExecution.cancel(taskId).catch(() => undefined);
        return task;
      }),
    );
    await Promise.allSettled(running.values());
    await Promise.allSettled(deliveries);
    const interruptedAt = now();
    for (const task of agents) {
      if (!task) continue;
      const current = await options.workspace.operational.subAgents.getTask(task.taskId);
      if (current && !isTerminal(current))
        await settleTask(current, {
          status: "interrupted",
          error: "Primary process shut down before task settled",
        });
      const agent = await options.workspace.operational.subAgents.get(task.agentId);
      if (agent && agent.status !== "closed" && agent.status !== "suspended")
        await updateAgentStatus(agent, "suspended", interruptedAt);
    }
  };

  return Object.freeze({
    spawn,
    send,
    wait,
    cancel,
    close,
    list,
    inspect,
    transcript,
    deliverPendingForeground,
    subscribe: (listener: (event: SubAgentRuntimeEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    shutdown,
  });
}
