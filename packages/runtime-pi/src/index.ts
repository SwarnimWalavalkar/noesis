import { createConditionalObject } from "@noesis/domain";
import { AgentHarness, TODO_CONTEXT, type AgentLane, type Skill } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Models, UserMessage } from "@earendil-works/pi-ai";
import {
  type AgentAssistantMessageBoundary,
  type AgentContextUsage,
  type AgentRuntimeEvent,
  type AgentRuntimeRequest,
  type AgentRuntimeResult,
  type AgentSteerResult,
  type FrozenTurnPlan,
  type NoesisAgentRuntime,
  renderFrozenConversationHistoryContent,
  validateFrozenTurnPlan,
} from "@noesis/agent-types";
import { toAgentActionPayload } from "./action-payload.ts";
import { createPiRequestBudgetProjector, createPiRequestGuardedModels } from "./context-budget.ts";
import {
  createPiExecuteTool,
  type PiCodeExecutionAdapter,
  type PreparedPiCodeExecution,
} from "./execute-tool.ts";
import { frozenPlanMaterialUses } from "./frozen-session-tools.ts";
import {
  createBrokerToolAliases,
  createPiBrokerTools,
  FOREGROUND_DIRECT_TOOL_NAMES,
} from "./broker-tools.ts";
import {
  createEphemeralPiSession,
  NOESIS_PI_COMPACTION_SETTINGS,
  NOESIS_PI_LANE_NAME,
} from "./session-lifecycle.ts";
import { resolvePiSkillInvocation } from "./skill-invocation.ts";
import type { PiSkillLibrary, PiSkillResource } from "./skill-library.ts";
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
export * from "./auth-recovery.ts";
export * from "./context-budget.ts";
export * from "./execute-tool.ts";
export * from "./experiment-fixtures.ts";
export type {
  FrozenPlanMaterialKind,
  FrozenPlanMaterialUse,
  FrozenSessionToolResolution,
  FrozenSessionToolResolver,
} from "./frozen-session-tools.ts";
export { frozenPlanMaterialUses, resolveFrozenSessionToolDefinitions } from "./frozen-session-tools.ts";
export * from "./broker-tools.ts";
export * from "./model-catalog.ts";
export * from "./model-selection.ts";
export * from "./mcp-sampling.ts";
export * from "./pi-role-backend.ts";
export * from "./provider-ids.ts";
export * from "./role-context.ts";
export * from "./role-runner.ts";
export * from "./role-types.ts";
export * from "./skill-invocation.ts";
export * from "./skill-library.ts";
export * from "./subagent-run.ts";
function assistantText(message: { readonly content: readonly unknown[] }): string {
  return message.content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text" || !("text" in part))
        return [];
      return typeof part.text === "string" ? [part.text] : [];
    })
    .join("");
}
function assistantReasoning(message: { readonly content: readonly unknown[] }): string {
  return message.content
    .flatMap((part) => {
      if (
        !part ||
        typeof part !== "object" ||
        !("type" in part) ||
        part.type !== "thinking" ||
        !("thinking" in part) ||
        ("redacted" in part && part.redacted === true)
      )
        return [];
      return typeof part.thinking === "string" && part.thinking.length > 0 ? [part.thinking] : [];
    })
    .join("\n\n");
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
function escapeSkillPromptXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
function formatSkillsForNoesisPrompt(skills: readonly Skill[], canLoad: boolean): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (!canLoad || visible.length === 0) return "";
  return [
    "The following skills provide specialized instructions for matching tasks.",
    "Load the full frozen instructions through `execute` with `tools.skills.load({ name })`; do not read a listed skill as a project file.",
    "",
    "<available_skills>",
    ...visible.flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeSkillPromptXml(skill.name)}</name>`,
      `    <description>${escapeSkillPromptXml(skill.description)}</description>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
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
    for (const effect of selection.effects ?? []) {
      if (effect.kind !== "instruction") continue;
      const content = effect.material.content.trim();
      if (content && !plan.renderedSystemPrompt.includes(content))
        throw new Error(
          `Frozen turn plan ${plan.planId} does not serve instruction effect ${effect.material.revision.revisionId}`,
        );
    }
  }
  return plan;
}
function capabilitySkillResources(plan: FrozenTurnPlan | undefined): readonly PiSkillResource[] {
  if (!plan) return Object.freeze([]);
  return Object.freeze(
    plan.selectedCapabilities.flatMap((selection) =>
      (selection.effects ?? []).flatMap((effect) =>
        effect.kind === "skill"
          ? [
              Object.freeze({
                name: effect.name,
                description: effect.description,
                content: effect.material.content,
                filePath: effect.material.revision.workingPath,
                contentDigest: effect.material.revision.contentDigest,
                capabilityRevision: effect.material.revision,
                disableModelInvocation: false,
              }),
            ]
          : [],
      ),
    ),
  );
}
function mergeSkillResources(
  discovered: readonly PiSkillResource[],
  capability: readonly PiSkillResource[],
): readonly PiSkillResource[] {
  const merged = new Map(discovered.map((skill) => [skill.name, skill]));
  const commandOwners = new Map<string, string>();
  for (const skill of discovered)
    for (const command of [skill.name, ...(skill.aliases ?? [])]) commandOwners.set(command, skill.name);
  for (const skill of capability) {
    const existing = merged.get(skill.name);
    if (existing && existing.contentDigest !== skill.contentDigest)
      throw new Error(`Capability skill ${skill.name} conflicts with another frozen skill`);
    if (existing) continue;
    const commandOwner = commandOwners.get(skill.name);
    if (commandOwner)
      throw new Error(
        `Capability skill ${skill.name} conflicts with an explicit command owned by ${commandOwner}`,
      );
    merged.set(skill.name, skill);
    commandOwners.set(skill.name, skill.name);
  }
  return Object.freeze([...merged.values()].sort((left, right) => left.name.localeCompare(right.name)));
}
function historyForRequest(
  request: AgentRuntimeRequest,
  plan: FrozenTurnPlan | undefined,
): NonNullable<AgentRuntimeRequest["history"]> {
  if (!plan) return Object.freeze([...(request.history ?? [])]);
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
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
    ...(plan.conversationHistory ?? []).map((entry) =>
      Object.freeze({
        role: entry.role,
        content: renderFrozenConversationHistoryContent(entry),
        createdAt: entry.createdAt,
      }),
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
  model: NonNullable<ReturnType<Models["getModel"]>>,
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
// BOUNDARY: Pi owns this callback payload and does not publish a concrete update contract; this
// adapter recognizes its optional activity envelope and preserves every other payload unchanged.
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
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze(
    createConditionalObject({
      kind: "activity",
    } as const)
      .addOptional(executionId ? { executionId } : undefined)
      .add({
        activity: details.event,
      } as const)
      .finish(),
  );
}
export interface PiAgentRuntime extends NoesisAgentRuntime {
  readonly name: "pi-agent-harness-0.85.0";
}
export interface CreatePiAgentRuntimeOptions {
  readonly codeExecution?: PiCodeExecutionAdapter;
  readonly skills?: PiSkillLibrary;
  readonly requirePinnedSkillSnapshot?: boolean;
  readonly now?: () => string;
}
export function createPiAgentRuntime(
  cwd: string,
  models: Models,
  options: CreatePiAgentRuntimeOptions = {},
): PiAgentRuntime {
  interface ActivePiExecution {
    readonly controller: AbortController;
    readonly pendingSteers: PendingPiSteer[];
    acceptsSteering: boolean;
    hasQueuedSteering: boolean;
    harness?: AgentHarness;
    lane?: AgentLane;
    closePiSession?: () => Promise<void>;
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
    reason: Extract<
      AgentSteerResult,
      {
        readonly status: "not-consumed";
      }
    >["reason"],
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
      hasQueuedSteering: false,
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
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
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
        if (request.provider === "opencode-go")
          throw new Error(
            "OpenCode Go authentication is missing. Set OPENCODE_GO_API_KEY or run `noesis auth login opencode-go`.",
          );
        throw new Error(`Pi credentials are missing for provider ${request.provider}.`);
      }
      const pinnedSkillSnapshot = plan ? options.skills?.claimPinnedSnapshot(plan.planId) : undefined;
      if (plan && options.skills && options.requirePinnedSkillSnapshot && !pinnedSkillSnapshot)
        throw new Error(`Frozen turn plan ${plan.planId} has no skill snapshot pinned at admission`);
      const discoveredSkillSnapshot =
        pinnedSkillSnapshot ??
        (options.skills
          ? await options.skills.snapshot(execution.controller.signal)
          : Object.freeze({ skills: Object.freeze([]), diagnostics: Object.freeze([]) }));
      const skillSnapshot = Object.freeze({
        skills: mergeSkillResources(discoveredSkillSnapshot.skills, capabilitySkillResources(plan)),
        diagnostics: discoveredSkillSnapshot.diagnostics,
      });
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
      const brokerRecordedDirectActionIds = new Set<string>();
      const emitCodeEvent = (
        event: Parameters<Parameters<typeof createPiExecuteTool>[0]["emit"]>[0],
        parentActionId?: string,
        recordedByBroker = false,
      ): void => {
        if (
          recordedByBroker &&
          parentActionId === undefined &&
          event.type === "tool-start" &&
          event.callId.startsWith("direct:")
        )
          brokerRecordedDirectActionIds.add(event.callId);
        if (event.type === "tool-start")
          // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
          emit(
            createConditionalObject({
              type: "tool-start",
              actionId: event.callId,
            } as const)
              .addOptional(parentActionId ? { parentActionId } : undefined)
              .add({
                name: event.name,
                input: toAgentActionPayload(event.input ?? {}),
                timelineSequence: claimTimelineSequence(),
              } as const)
              .addOptional(recordedByBroker ? { recordedByBroker: true } : undefined)
              .finish(),
          );
        else if (event.type === "progress" && event.callId && event.name)
          // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
          emit(
            createConditionalObject({
              type: "tool-update",
              actionId: event.callId,
            } as const)
              .addOptional(parentActionId ? { parentActionId } : undefined)
              .add({
                name: event.name,
                update: toAgentActionPayload(event.value),
              } as const)
              .addOptional(recordedByBroker ? { recordedByBroker: true } : undefined)
              .finish(),
          );
        else if (event.type === "tool-end")
          // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
          emit(
            createConditionalObject({
              type: "tool-end",
              actionId: event.callId,
            } as const)
              .addOptional(parentActionId ? { parentActionId } : undefined)
              .add({
                name: event.name,
                isError: !event.ok,
                result: toAgentActionPayload(
                  event.result ?? (event.error ? { error: event.error } : { ok: event.ok }),
                ),
              } as const)
              .addOptional(recordedByBroker ? { recordedByBroker: true } : undefined)
              .finish(),
          );
      };
      const directAliases = preparedCode
        ? createBrokerToolAliases(preparedCode.catalog)
        : new Map<string, string>();
      const { session, close } = await createEphemeralPiSession();
      execution.closePiSession = close;
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
      const directTools =
        plan && preparedCode
          ? createPiBrokerTools({
              prepared: preparedCode,
              turnId: plan.turnId,
              signal: execution.controller.signal,
              canonicalNames: FOREGROUND_DIRECT_TOOL_NAMES,
              emit: emitCodeEvent,
            })
          : Object.freeze([]);
      const directToolNames = new Set(directTools.map((tool) => tool.name));
      const canonicalDirectToolNames = new Map(
        FOREGROUND_DIRECT_TOOL_NAMES.flatMap((canonicalName) => {
          const alias = directAliases.get(canonicalName);
          return alias ? [[alias, canonicalName] as const] : [];
        }),
      );
      const pendingDirectToolInputs = new Map<string, ReturnType<typeof toAgentActionPayload>>();
      const piSkills = skillSnapshot.skills.map((skill): Skill => ({
        name: skill.name,
        description: skill.description,
        content: skill.content,
        filePath: skill.filePath,
        disableModelInvocation: skill.disableModelInvocation,
      }));
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
      const agentTools = executeTool ? [executeTool, ...directTools] : [];
      const initialActiveToolNames = executeTool
        ? [
            "execute",
            ...FOREGROUND_DIRECT_TOOL_NAMES.map((name) => {
              const alias = directAliases.get(name);
              if (!alias) throw new Error(`Frozen tool catalog has no direct alias for ${name}`);
              return alias;
            }),
          ]
        : [];
      const skillsSystemPrompt = formatSkillsForNoesisPrompt(piSkills, executeTool !== undefined);
      const completeSystemPrompt = [request.systemPrompt, skillsSystemPrompt].filter(Boolean).join("\n\n");
      let requestBudgetFailure: Error | undefined;
      const requestModels = createPiRequestGuardedModels(models, () => requestBudgetFailure);
      const { harness } = await AgentHarness.create(
        {
          session,
          models: requestModels,
          model,
          tools: agentTools,
          activeToolNames: initialActiveToolNames,
          thinkingLevel: request.thinkingLevel,
          compaction: NOESIS_PI_COMPACTION_SETTINGS,
          steeringMode: "all",
          toolExecution: "sequential",
          resources: {
            skills: piSkills,
          },
          systemPrompt: completeSystemPrompt,
        },
        TODO_CONTEXT,
      );
      execution.harness = harness;
      const lane = await harness.lane(NOESIS_PI_LANE_NAME, TODO_CONTEXT);
      execution.lane = lane;
      const requestBudget =
        plan?.requestTokenBudget === undefined
          ? undefined
          : Object.freeze({ planId: plan.planId, tokens: plan.requestTokenBudget });
      const requestBudgetProjector = createPiRequestBudgetProjector();
      const unsubscribeBudgetGuard =
        requestBudget === undefined
          ? () => undefined
          : harness.hooks.on("transform_context", async ({ messages }, context) => {
              try {
                const activeToolNames = new Set(await lane.getActiveTools(context));
                const activeTools = (await harness.getTools(context)).filter((tool) =>
                  activeToolNames.has(tool.name),
                );
                const activeToolMaterial = JSON.stringify(
                  activeTools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  })),
                );
                const projection = requestBudgetProjector.project({
                  messages,
                  systemPrompt: completeSystemPrompt,
                  activeToolMaterial,
                  activeToolCount: activeTools.length,
                  tokenBudget: requestBudget.tokens,
                  planId: requestBudget.planId,
                });
                requestBudgetFailure = undefined;
                return { messages: projection.messages };
              } catch (cause) {
                requestBudgetFailure = cause instanceof Error ? cause : new Error(String(cause));
                return undefined;
              }
            });
      const historyBaseTimestamp = Date.now() - history.length;
      for (const [index, message] of history.entries()) {
        if (message.role === "assistant" && message.content.length === 0) continue;
        const timestamp = historyTimestamp(message.createdAt, historyBaseTimestamp + index);
        await lane.appendMessage(
          message.role === "user"
            ? priorUserMessage(message.content, timestamp)
            : priorAssistantMessage(message.content, timestamp, model),
          TODO_CONTEXT,
        );
      }
      let abortPromise: Promise<void> | undefined;
      const requestHarnessAbort = (): Promise<void> => {
        abortPromise ??= lane.abort(TODO_CONTEXT).then(
          () => undefined,
          (cause: unknown) => {
            execution.abortError = cause;
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
      let terminalAssistant: AssistantMessage | undefined;
      const unsubscribers = [
        harness.events.on("queue_update", (event) => {
          execution.hasQueuedSteering = event.queues.some((item) => item.kind === "steer");
        }),
        harness.events.on("message_start", (event) => {
          if (event.message.role !== "assistant") return;
          assistantDeltas.beginMessage();
        }),
        harness.events.on("message_end", (event) => {
          if (event.message.role === "user") {
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
            return;
          }
          if (event.message.role !== "assistant") return;
          terminalAssistant = event.message;
          if (execution.controller.signal.aborted) return;
          const reasoning = assistantReasoning(event.message);
          if (reasoning.length > 0)
            emit({
              type: "reasoning-message",
              text: reasoning,
              timelineSequence: claimTimelineSequence(),
              createdAt: now(),
            });
          const text = assistantText(event.message);
          if (text.length === 0) return;
          const boundary = Object.freeze({
            text,
            timelineSequence: claimTimelineSequence(),
            createdAt: now(),
          });
          assistantMessages.push(boundary);
          emit({ type: "assistant-message", ...boundary });
        }),
        harness.events.on("message_update", (event) => {
          if (event.event.type === "text_delta") {
            const delta = assistantDeltas.push(event.event.delta);
            if (delta) emit({ type: "delta", text: delta });
          } else if (event.event.type === "thinking_delta" && event.event.delta.length > 0)
            emit({ type: "reasoning-delta", text: event.event.delta });
        }),
        harness.events.on("tool_start", (event) => {
          if (directToolNames.has(event.toolName)) {
            pendingDirectToolInputs.set(event.toolCallId, toAgentActionPayload(event.args));
            return;
          }
          emit({
            type: "tool-start",
            actionId: event.toolCallId,
            name: event.toolName,
            input: toAgentActionPayload(event.args),
            timelineSequence: claimTimelineSequence(),
          });
        }),
        harness.events.on("tool_update", (event) => {
          if (directToolNames.has(event.toolName)) return;
          emit({
            type: "tool-update",
            actionId: event.toolCallId,
            name: event.toolName,
            update: toAgentActionPayload(piToolUpdatePayload(event.partialResult)),
          });
        }),
        harness.events.on("tool_end", (event) => {
          if (directToolNames.has(event.toolName)) {
            const actionId = `direct:${event.toolCallId}`;
            const directInput = pendingDirectToolInputs.get(event.toolCallId) ?? {};
            pendingDirectToolInputs.delete(event.toolCallId);
            if (brokerRecordedDirectActionIds.delete(actionId)) return;
            const canonicalName = canonicalDirectToolNames.get(event.toolName) ?? event.toolName;
            emit({
              type: "tool-start",
              actionId,
              name: canonicalName,
              input: directInput,
              timelineSequence: claimTimelineSequence(),
            });
            emit({
              type: "tool-end",
              actionId,
              name: canonicalName,
              isError: event.isError,
              result: toAgentActionPayload(event.result),
            });
            return;
          }
          emit({
            type: "tool-end",
            actionId: event.toolCallId,
            name: event.toolName,
            isError: event.isError,
            result: toAgentActionPayload(event.result),
          });
        }),
      ];
      const unsubscribe = (): void => {
        for (const dispose of unsubscribers.toReversed()) dispose();
      };
      const unsubscribeSteeringToolGuard = harness.hooks.on("before_tool", () =>
        execution.hasQueuedSteering
          ? {
              block: { reason: "Skipped because a newer user steering message is pending." },
            }
          : undefined,
      );
      const unsubscribeProviderAbort = harness.hooks.on("after_response", async (event, context) => {
        if (event.message.stopReason === "aborted") await lane.requestAbort(event.runId, context);
        return undefined;
      });
      execution.acceptsSteering = true;
      emit({ type: "status", status: "started" });
      try {
        if (execution.controller.signal.aborted) return abortedBeforePrompt();
        const runResult = await lane.prompt(explicitSkill?.prompt ?? request.prompt, undefined, TODO_CONTEXT);
        if (!runResult.ok) throw runResult.error;
        if (execution.controller.signal.aborted) return abortedBeforePrompt();
        if (runResult.value.status === "suspended") {
          await requestHarnessAbort();
          throw new Error("Pi suspended the foreground run for a deferred response");
        }
        const message = terminalAssistant;
        if (!message) {
          const detail = runResult.value.error?.message ?? `operation ${runResult.value.status}`;
          throw new Error(`Pi run ended without a terminal assistant response: ${detail}`);
        }
        if (message.stopReason === "pending" || message.stopReason === "deferred")
          throw new Error(`Pi run ended with a ${message.stopReason} assistant response`);
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
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        const base = createConditionalObject({
          text,
          assistantMessages: Object.freeze([...assistantMessages]),
          provider: message.provider,
          model: message.model,
        } as const)
          .addOptional(contextUsage ? { contextUsage } : undefined)
          .finish();
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
        unsubscribeSteeringToolGuard();
        unsubscribeProviderAbort();
        unsubscribeBudgetGuard();
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
          if (execution.lane) await execution.lane.waitForIdle(TODO_CONTEXT);
        } finally {
          try {
            await execution.harness?.close(TODO_CONTEXT);
          } finally {
            try {
              await execution.preparedCode?.close().catch(() => undefined);
            } finally {
              await execution.closePiSession?.();
            }
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
    const lane = execution?.lane;
    if (!execution || !lane) return notConsumed("not-running");
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
      const queued = await lane.steer(text, undefined, TODO_CONTEXT);
      if (!queued.ok) throw queued.error;
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
  return Object.freeze({ name: "pi-agent-harness-0.85.0", run, steer, abort });
}
