import { AgentHarness, formatSkillsForSystemPrompt, type Skill } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage, MutableModels, UserMessage } from "@earendil-works/pi-ai";
import type {
  AgentAssistantMessageBoundary,
  AgentContextUsage,
  AgentRuntimeEvent,
  AgentRuntimeRequest,
  AgentRuntimeResult,
  AgentSteerResult,
  FrozenTurnPlan,
  NoesisAgentRuntime,
} from "@noesis/agent-types";
import { validateFrozenTurnPlan } from "@noesis/agent-types";
import { toAgentActionPayload } from "./action-payload.ts";
import {
  createPiExecuteTool,
  type PiCodeExecutionAdapter,
  type PreparedPiCodeExecution,
} from "./execute-tool.ts";
import { frozenPlanMaterialUses } from "./frozen-session-tools.ts";
import {
  createHotbarToolAliases,
  createPiHotbarTools,
  reconcileHotbarTools,
  resolveHotbarTools,
} from "./hotbar-tools.ts";
import { createPiSelfTools, type PiSelfToolAdapter } from "./self-tools.ts";
import { createEphemeralPiSession, releasePiSessionResources } from "./session-lifecycle.ts";
import { resolvePiSkillInvocation } from "./skill-invocation.ts";
import type { PiSkillLibrary } from "./skill-library.ts";

export type {
  AgentCompletedStopReason,
  AgentContextUsage,
  AgentRuntimeEvent,
  AgentRuntimeRequest,
  AgentRuntimeResult,
  AgentSteerResult,
  AgentThinkingLevel,
  NoesisAgentRuntime,
} from "@noesis/agent-types";
export * from "./action-payload.ts";
export * from "./auth.ts";
export * from "./execute-tool.ts";
export * from "./experiment-fixtures.ts";
export type {
  FrozenPlanMaterialKind,
  FrozenPlanMaterialUse,
  FrozenSessionToolResolution,
  FrozenSessionToolResolver,
} from "./frozen-session-tools.ts";
export {
  frozenPlanMaterialUses,
  resolveFrozenSessionToolDefinitions,
} from "./frozen-session-tools.ts";
export * from "./hotbar-tools.ts";
export * from "./model-selection.ts";
export * from "./mcp-sampling.ts";
export * from "./pi-role-backend.ts";
export * from "./role-context.ts";
export * from "./role-runner.ts";
export * from "./role-types.ts";
export * from "./self-tools.ts";
export * from "./skill-invocation.ts";
export * from "./skill-library.ts";

function assistantText(message: { readonly content: readonly unknown[] }): string {
  return message.content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text" || !("text" in part))
        return [];
      return typeof part.text === "string" ? [part.text] : [];
    })
    .join("");
}

function userMessageText(message: { readonly content: string | readonly unknown[] }): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text" || !("text" in part))
        return [];
      return typeof part.text === "string" ? [part.text] : [];
    })
    .join("");
}

function verifyFrozenRequest(request: AgentRuntimeRequest): FrozenTurnPlan | undefined {
  if (!request.frozenTurnPlan) return undefined;
  const plan = validateFrozenTurnPlan(request.frozenTurnPlan);
  if (
    plan.sessionId !== request.trailId ||
    plan.provider !== request.provider ||
    plan.model !== request.model ||
    plan.thinkingLevel !== request.thinkingLevel ||
    plan.renderedSystemPrompt !== request.systemPrompt
  )
    throw new Error(`Runtime request does not match frozen turn plan ${plan.planId}`);
  for (const selection of plan.selectedCapabilities) {
    for (const prompt of selection.promptModules) {
      const content = prompt.content.trim();
      if (content && !plan.renderedSystemPrompt.includes(content))
        throw new Error(
          `Frozen turn plan ${plan.planId} does not serve prompt material ${prompt.revision.revisionId}`,
        );
    }
  }
  return plan;
}

function historyForRequest(
  request: AgentRuntimeRequest,
  plan: FrozenTurnPlan | undefined,
): NonNullable<AgentRuntimeRequest["history"]> {
  if (!plan) return Object.freeze([...(request.history ?? [])]);
  const frozen = Object.freeze([
    ...(plan.contextCheckpoint
      ? [
          Object.freeze({
            role: "assistant" as const,
            content: plan.contextCheckpoint.summary,
            createdAt: plan.contextCheckpoint.createdAt,
          }),
        ]
      : []),
    ...(plan.conversationHistory ?? []).map(({ role, content, createdAt }) =>
      Object.freeze({ role, content, createdAt }),
    ),
  ]);
  if (request.history !== undefined) {
    const matches =
      request.history.length === frozen.length &&
      request.history.every(
        (message, index) =>
          message.role === frozen[index]?.role &&
          message.content === frozen[index]?.content &&
          message.createdAt === frozen[index]?.createdAt,
      );
    if (!matches) throw new Error(`Runtime history does not match frozen turn plan ${plan.planId}`);
  }
  return frozen;
}

export interface AssistantDeltaAggregator {
  /** Start the next Pi assistant message in the same tool-loop turn. */
  readonly beginMessage: () => void;
  /** Return the exact display delta, including a separator between text-bearing assistant messages. */
  readonly push: (delta: string) => string;
  readonly text: () => string;
}

export function createAssistantDeltaAggregator(): AssistantDeltaAggregator {
  let aggregate = "";
  let currentMessageHasText = false;
  return {
    beginMessage() {
      currentMessageHasText = false;
    },
    push(delta) {
      if (!delta) return "";
      const separator = aggregate && !currentMessageHasText ? "\n\n" : "";
      const emitted = `${separator}${delta}`;
      aggregate += emitted;
      currentMessageHasText = true;
      return emitted;
    },
    text: () => aggregate,
  };
}

const emptyUsage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

function historyTimestamp(createdAt: string | undefined, fallback: number): number {
  if (!createdAt) return fallback;
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function priorUserMessage(content: string, timestamp: number): UserMessage {
  const message: UserMessage = {
    role: "user",
    content: [{ type: "text", text: content }],
    timestamp,
  };
  return Object.freeze(message);
}

function priorAssistantMessage(
  content: string,
  timestamp: number,
  model: NonNullable<ReturnType<MutableModels["getModel"]>>,
): AssistantMessage {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage,
    stopReason: "stop",
    timestamp,
  };
  return Object.freeze(message);
}

function piToolUpdatePayload(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("details" in value)) return value;
  const details = value.details;
  if (
    !details ||
    typeof details !== "object" ||
    !("kind" in details) ||
    details.kind !== "activity" ||
    !("event" in details)
  )
    return value;
  const executionId =
    "executionId" in details && typeof details.executionId === "string" ? details.executionId : undefined;
  return Object.freeze({
    kind: "activity",
    ...(executionId ? { executionId } : {}),
    activity: details.event,
  });
}

export interface PiAgentRuntime extends NoesisAgentRuntime {
  readonly name: "pi-agent-harness-0.80.6";
}

export interface CreatePiAgentRuntimeOptions {
  readonly codeExecution?: PiCodeExecutionAdapter;
  readonly selfTools?: PiSelfToolAdapter;
  readonly skills?: PiSkillLibrary;
  readonly requirePinnedSkillSnapshot?: boolean;
  readonly now?: () => string;
}

export function createPiAgentRuntime(
  cwd: string,
  models: MutableModels,
  options: CreatePiAgentRuntimeOptions = {},
): PiAgentRuntime {
  interface ActivePiExecution {
    readonly controller: AbortController;
    readonly pendingSteers: PendingPiSteer[];
    acceptsSteering: boolean;
    harness?: AgentHarness;
    sessionId?: string;
    preparedCode?: PreparedPiCodeExecution;
    requestHarnessAbort?: () => Promise<void>;
    abortError?: unknown;
    abortStatusEmitted?: boolean;
  }

  interface PendingPiSteer {
    readonly text: string;
    readonly promise: Promise<AgentSteerResult>;
    readonly resolve: (result: AgentSteerResult) => void;
  }

  const notConsumed = (
    reason: Extract<AgentSteerResult, { readonly status: "not-consumed" }>["reason"],
  ): AgentSteerResult => Object.freeze({ status: "not-consumed", reason });

  const settlePendingSteers = (execution: ActivePiExecution, result: AgentSteerResult): void => {
    const pending = execution.pendingSteers.splice(0);
    for (const receipt of pending) receipt.resolve(result);
  };

  const active = new Map<string, ActivePiExecution>();

  const run = async (
    request: AgentRuntimeRequest,
    emit: (event: AgentRuntimeEvent) => void,
  ): Promise<AgentRuntimeResult> => {
    const plan = verifyFrozenRequest(request);
    const history = historyForRequest(request, plan);
    if (active.has(request.trailId)) throw new Error(`Trail ${request.trailId} is already active`);
    const execution: ActivePiExecution = {
      controller: new AbortController(),
      pendingSteers: [],
      acceptsSteering: false,
    };
    const now = options.now ?? (() => new Date().toISOString());
    let nextTimelineSequence = 1;
    const claimTimelineSequence = (): number => {
      const sequence = nextTimelineSequence;
      nextTimelineSequence += 1;
      return sequence;
    };
    const assistantMessages: AgentAssistantMessageBoundary[] = [];
    active.set(request.trailId, execution);
    const abortedBeforePrompt = (): AgentRuntimeResult => {
      if (!execution.abortStatusEmitted) {
        execution.abortStatusEmitted = true;
        emit({ type: "status", status: "aborted" });
      }
      return Object.freeze({
        text: "",
        assistantMessages: Object.freeze([]),
        provider: request.provider,
        model: request.model,
        outcome: "aborted" as const,
        stopReason: "aborted" as const,
      });
    };
    try {
      if (execution.controller.signal.aborted) return abortedBeforePrompt();
      const model = models.getModel(request.provider, request.model);
      if (!model) throw new Error(`Pi model not found: ${request.provider}/${request.model}`);
      emit({
        type: "model",
        provider: model.provider,
        model: model.id,
        contextWindow: model.contextWindow,
      });
      const auth = await models.getAuth(model);
      if (execution.controller.signal.aborted) return abortedBeforePrompt();
      if (!auth) {
        if (request.provider === "openai-codex")
          throw new Error(
            "Codex OAuth is not configured. Run `noesis auth login openai-codex` before using this model.",
          );
        if (request.provider === "openrouter")
          throw new Error(
            "OpenRouter authentication is missing. Set OPENROUTER_API_KEY or run `noesis auth login openrouter`.",
          );
        if (request.provider === "anthropic")
          throw new Error(
            "Claude authentication is missing. Set ANTHROPIC_API_KEY or run `noesis auth login anthropic` for Claude Pro/Max OAuth.",
          );
        if (request.provider === "opencode")
          throw new Error(
            "OpenCode Zen authentication is missing. Set OPENCODE_API_KEY or run `noesis auth login opencode`.",
          );
        throw new Error(`Pi credentials are missing for provider ${request.provider}.`);
      }
      const pinnedSkillSnapshot = plan ? options.skills?.claimPinnedSnapshot(plan.planId) : undefined;
      if (plan && options.skills && options.requirePinnedSkillSnapshot && !pinnedSkillSnapshot)
        throw new Error(`Frozen turn plan ${plan.planId} has no skill snapshot pinned at admission`);
      const skillSnapshot =
        pinnedSkillSnapshot ??
        (options.skills
          ? await options.skills.snapshot(execution.controller.signal)
          : Object.freeze({ skills: Object.freeze([]), diagnostics: Object.freeze([]) }));
      const preparedCode =
        plan && options.codeExecution
          ? await options.codeExecution.prepare(plan, execution.controller.signal, {
              skills: skillSnapshot.skills,
            })
          : undefined;
      if (plan && !preparedCode && frozenPlanMaterialUses(plan).length > 0)
        throw new Error(
          `Frozen turn plan ${plan.planId} contains skill, router, or tool material without a codemode execution adapter`,
        );
      if (preparedCode) execution.preparedCode = preparedCode;
      if (execution.controller.signal.aborted) return abortedBeforePrompt();
      const emitCodeEvent = (
        event: Parameters<Parameters<typeof createPiExecuteTool>[0]["emit"]>[0],
        parentActionId?: string,
        recordedByBroker = false,
      ): void => {
        if (event.type === "tool-start")
          emit({
            type: "tool-start",
            actionId: event.callId,
            ...(parentActionId ? { parentActionId } : {}),
            name: event.name,
            input: toAgentActionPayload(event.input ?? {}),
            timelineSequence: claimTimelineSequence(),
            ...(recordedByBroker ? { recordedByBroker: true } : {}),
          });
        else if (event.type === "progress" && event.callId && event.name)
          emit({
            type: "tool-update",
            actionId: event.callId,
            ...(parentActionId ? { parentActionId } : {}),
            name: event.name,
            update: toAgentActionPayload(event.value),
            ...(recordedByBroker ? { recordedByBroker: true } : {}),
          });
        else if (event.type === "tool-end")
          emit({
            type: "tool-end",
            actionId: event.callId,
            ...(parentActionId ? { parentActionId } : {}),
            name: event.name,
            isError: !event.ok,
            result: toAgentActionPayload(
              event.result ?? (event.error ? { error: event.error } : { ok: event.ok }),
            ),
            ...(recordedByBroker ? { recordedByBroker: true } : {}),
          });
      };
      let harness: AgentHarness | undefined;
      const initialHotbar =
        plan && preparedCode && options.selfTools
          ? reconcileHotbarTools(
              preparedCode.catalog,
              await options.selfTools.hotbar({
                plan,
                catalog: preparedCode.catalog,
                signal: execution.controller.signal,
              }),
            ).active
          : Object.freeze([]);
      const hotbarAliases = preparedCode
        ? createHotbarToolAliases(preparedCode.catalog)
        : new Map<string, string>();
      const activeNames = (canonicalNames: readonly string[]): string[] => [
        ...(plan && options.selfTools
          ? ["inspect_self", "remember", ...(preparedCode ? ["adapt"] : [])]
          : []),
        ...(preparedCode
          ? [
              "execute",
              ...canonicalNames.map((name) => {
                const alias = hotbarAliases.get(name);
                if (!alias) throw new Error(`Frozen tool catalog has no direct alias for ${name}`);
                return alias;
              }),
            ]
          : []),
      ];
      const applyHotbar = async (canonicalNames: readonly string[]): Promise<void> => {
        if (!preparedCode) throw new Error("This turn has no executable tool catalog");
        const resolved = resolveHotbarTools(preparedCode.catalog, canonicalNames);
        if (!harness) throw new Error("The direct-tool hotbar is not ready");
        await harness.setActiveTools(activeNames(resolved));
      };
      const selfTools =
        plan && options.selfTools
          ? createPiSelfTools({
              adapter: options.selfTools,
              plan,
              request,
              signal: execution.controller.signal,
              applyHotbar,
              ...(preparedCode
                ? {
                    catalog: preparedCode.catalog,
                  }
                : {}),
            })
          : Object.freeze([]);
      const { session, sessionId } = await createEphemeralPiSession();
      execution.sessionId = sessionId;
      if (execution.controller.signal.aborted) return abortedBeforePrompt();
      const executeTool =
        plan && preparedCode
          ? createPiExecuteTool({
              prepared: preparedCode,
              turnId: plan.turnId,
              signal: execution.controller.signal,
              emit: emitCodeEvent,
            })
          : undefined;
      const hotbarTools =
        plan && preparedCode
          ? createPiHotbarTools({
              prepared: preparedCode,
              turnId: plan.turnId,
              signal: execution.controller.signal,
              emit: emitCodeEvent,
            })
          : Object.freeze([]);
      const directToolNames = new Set(hotbarTools.map((tool) => tool.name));
      const piSkills = skillSnapshot.skills.map(
        (skill): Skill => ({
          name: skill.name,
          description: skill.description,
          content: skill.content,
          filePath: skill.filePath,
          disableModelInvocation: skill.disableModelInvocation,
        }),
      );
      const explicitSkill = resolvePiSkillInvocation(request.prompt, skillSnapshot.skills);
      if (explicitSkill) {
        const actionId = `skill-load:${plan?.turnId ?? request.trailId}:${explicitSkill.name}`;
        emit({
          type: "tool-start",
          actionId,
          name: "skills.load",
          input: Object.freeze({ name: explicitSkill.name }),
          timelineSequence: claimTimelineSequence(),
        });
        emit({
          type: "tool-end",
          actionId,
          name: "skills.load",
          isError: false,
          result: explicitSkill.actionEvidence,
        });
      }
      const agentTools = executeTool ? [...selfTools, executeTool, ...hotbarTools] : [...selfTools];
      const initialActiveToolNames = activeNames(initialHotbar);
      const skillsSystemPrompt = formatSkillsForSystemPrompt(piSkills);
      const completeSystemPrompt = [request.systemPrompt, skillsSystemPrompt].filter(Boolean).join("\n\n");
      if (plan?.requestTokenBudget !== undefined) {
        const activeNameSet = new Set(initialActiveToolNames);
        const activeToolMaterial = JSON.stringify(
          agentTools
            .filter((tool) => activeNameSet.has(tool.name))
            .map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
        );
        const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));
        const estimatedRequestTokens =
          estimateTokens(completeSystemPrompt) +
          estimateTokens(request.prompt) +
          estimateTokens(activeToolMaterial) +
          history.reduce((total, message) => total + estimateTokens(message.content), 0);
        if (estimatedRequestTokens > plan.requestTokenBudget)
          throw new Error(
            `Frozen turn plan ${plan.planId} complete request exceeds its token budget before model invocation`,
          );
      }
      harness = new AgentHarness({
        env: new NodeExecutionEnv({ cwd }),
        session,
        models,
        model,
        tools: agentTools,
        activeToolNames: initialActiveToolNames,
        thinkingLevel: request.thinkingLevel,
        resources: {
          skills: piSkills,
        },
        systemPrompt: completeSystemPrompt,
      });
      const historyBaseTimestamp = Date.now() - history.length;
      for (const [index, message] of history.entries()) {
        if (message.role === "assistant" && message.content.length === 0) continue;
        const timestamp = historyTimestamp(message.createdAt, historyBaseTimestamp + index);
        await harness.appendMessage(
          message.role === "user"
            ? priorUserMessage(message.content, timestamp)
            : priorAssistantMessage(message.content, timestamp, model),
        );
      }
      execution.harness = harness;
      let abortPromise: Promise<void> | undefined;
      const requestHarnessAbort = (): Promise<void> => {
        abortPromise ??= harness.abort().then(
          () => undefined,
          (error: unknown) => {
            execution.abortError = error;
          },
        );
        return abortPromise;
      };
      execution.requestHarnessAbort = requestHarnessAbort;
      const abortHarness = () => requestHarnessAbort();
      execution.controller.signal.addEventListener("abort", abortHarness, { once: true });
      if (execution.controller.signal.aborted) await requestHarnessAbort();
      const assistantDeltas = createAssistantDeltaAggregator();
      let initialUserMessageObserved = false;
      const unsubscribe = harness.subscribe((event) => {
        if (event.type === "message_start" && event.message.role === "assistant") {
          assistantDeltas.beginMessage();
        } else if (event.type === "message_end" && event.message.role === "user") {
          if (!initialUserMessageObserved) {
            initialUserMessageObserved = true;
            return;
          }
          const text = userMessageText(event.message);
          const pendingIndex = execution.pendingSteers.findIndex((receipt) => receipt.text === text);
          if (pendingIndex >= 0) {
            const [receipt] = execution.pendingSteers.splice(pendingIndex, 1);
            receipt?.resolve(
              Object.freeze({
                status: "consumed",
                timelineSequence: claimTimelineSequence(),
                consumedAt: now(),
              }),
            );
          }
        } else if (event.type === "message_end" && event.message.role === "assistant") {
          const text = assistantText(event.message);
          if (text.length === 0) return;
          const boundary = Object.freeze({
            text,
            timelineSequence: claimTimelineSequence(),
            createdAt: now(),
          });
          assistantMessages.push(boundary);
          emit({ type: "assistant-message", ...boundary });
        } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          const delta = assistantDeltas.push(event.assistantMessageEvent.delta);
          if (delta) emit({ type: "delta", text: delta });
        } else if (event.type === "tool_execution_start") {
          if (directToolNames.has(event.toolName)) return;
          emit({
            type: "tool-start",
            actionId: event.toolCallId,
            name: event.toolName,
            input: toAgentActionPayload(event.args),
            timelineSequence: claimTimelineSequence(),
          });
        } else if (event.type === "tool_execution_update") {
          if (directToolNames.has(event.toolName)) return;
          emit({
            type: "tool-update",
            actionId: event.toolCallId,
            name: event.toolName,
            update: toAgentActionPayload(piToolUpdatePayload(event.partialResult)),
          });
        } else if (event.type === "tool_execution_end") {
          if (directToolNames.has(event.toolName)) return;
          emit({
            type: "tool-end",
            actionId: event.toolCallId,
            name: event.toolName,
            isError: event.isError,
            result: toAgentActionPayload(event.result),
          });
        }
      });
      execution.acceptsSteering = true;
      emit({ type: "status", status: "started" });
      try {
        const message = await harness.prompt(explicitSkill?.prompt ?? request.prompt);
        const finalText = assistantText(message);
        if (assistantMessages.length === 0 && finalText.length > 0) {
          const boundary = Object.freeze({
            text: finalText,
            timelineSequence: claimTimelineSequence(),
            createdAt: now(),
          });
          assistantMessages.push(boundary);
          emit({ type: "assistant-message", ...boundary });
        }
        const text = assistantMessages
          .map((boundary) => boundary.text)
          .filter((part) => part.length > 0)
          .join("\n\n");
        const usedTokens =
          message.usage.totalTokens ||
          message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
        const contextUsage =
          usedTokens > 0 && model.contextWindow > 0
            ? ({
                usedTokens,
                contextWindow: model.contextWindow,
                accuracy: "reported",
              } satisfies AgentContextUsage)
            : undefined;
        if (contextUsage) emit({ type: "usage", ...contextUsage });
        const base = {
          text,
          assistantMessages: Object.freeze([...assistantMessages]),
          provider: message.provider,
          model: message.model,
          ...(contextUsage ? { contextUsage } : {}),
        };
        if (message.stopReason === "error") {
          const error = message.errorMessage?.trim() || "The provider returned an error without details.";
          emit({ type: "status", status: "failed", error });
          return { ...base, outcome: "failed", stopReason: "error", error };
        }
        if (message.stopReason === "aborted") {
          emit({ type: "status", status: "aborted" });
          return { ...base, outcome: "aborted", stopReason: "aborted" };
        }
        emit({ type: "status", status: "completed" });
        return { ...base, outcome: "completed", stopReason: message.stopReason };
      } finally {
        execution.acceptsSteering = false;
        execution.controller.signal.removeEventListener("abort", abortHarness);
        unsubscribe();
        await abortPromise;
        settlePendingSteers(
          execution,
          notConsumed(execution.controller.signal.aborted ? "aborted" : "turn-ended"),
        );
      }
    } catch (error) {
      if (execution.controller.signal.aborted && !execution.harness) return abortedBeforePrompt();
      throw error;
    } finally {
      try {
        try {
          if (execution.harness) await execution.harness.waitForIdle();
        } finally {
          try {
            await execution.preparedCode?.close().catch(() => undefined);
          } finally {
            if (execution.sessionId) releasePiSessionResources(execution.sessionId);
          }
        }
      } finally {
        execution.acceptsSteering = false;
        settlePendingSteers(
          execution,
          notConsumed(execution.controller.signal.aborted ? "aborted" : "turn-ended"),
        );
        if (active.get(request.trailId) === execution) active.delete(request.trailId);
      }
    }
  };

  const steer = async (trailId: string, text: string): Promise<AgentSteerResult> => {
    const execution = active.get(trailId);
    const harness = execution?.harness;
    if (!execution || !harness) return notConsumed("not-running");
    if (!execution.acceptsSteering)
      return notConsumed(execution.controller.signal.aborted ? "aborted" : "turn-ended");
    const deferred = Promise.withResolvers<AgentSteerResult>();
    const receipt: PendingPiSteer = Object.freeze({
      text,
      promise: deferred.promise,
      resolve: deferred.resolve,
    });
    execution.pendingSteers.push(receipt);
    try {
      await harness.steer(text);
    } catch {
      // Pi can fail after queue insertion while notifying queue observers. Keep the receipt pending:
      // only a user message_end or terminal turn settlement can prove the outcome.
    }
    return receipt.promise;
  };

  const abort = async (trailId: string): Promise<void> => {
    const execution = active.get(trailId);
    if (!execution) return;
    execution.acceptsSteering = false;
    execution.controller.abort();
    await execution.requestHarnessAbort?.();
    if (execution.abortError) throw execution.abortError;
  };

  return Object.freeze({ name: "pi-agent-harness-0.80.6", run, steer, abort });
}
