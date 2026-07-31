import type { AgentActionEvent, NoesisAgentRuntime } from "@noesis/agent-types";
import { compileContext } from "@noesis/context";
import {
  compareTrailRecency,
  type InteractionCommand,
  type InteractionDispatchOptions,
  type InteractionDispatchResult,
  type InteractionPendingIntent,
  type InteractionSnapshot,
  SESSION_PICKER_LIMIT,
  type NoesisRuntime,
  type RunTurnOptions,
  type RuntimeTranscriptAction,
  type RuntimeTranscriptEntry,
  type TrailState,
  type TrailSummary,
  type TurnResult,
} from "@noesis/runtime";

export interface TestNoesisRuntime extends NoesisRuntime {
  readonly runTurn: (trailId: string, input: string, options?: RunTurnOptions) => Promise<TurnResult>;
  readonly resumedTrailIds: readonly string[];
  readonly failedTurnCount: number;
}

interface TestInteractionState {
  phase: InteractionSnapshot["phase"];
  queuePaused: boolean;
  active?: {
    readonly intentId: string;
    readonly turnId: string;
    readonly text: string;
    readonly mode: "turn" | "steer";
  };
  readonly pending: InteractionPendingIntent[];
  observer?: NonNullable<InteractionDispatchOptions["onEvent"]>;
  drain?: Promise<void>;
}

interface StoredTrail {
  state: TrailState;
  readonly createdAt: string;
  updatedAt: string;
}

export function createInMemoryTestRuntime(agent: NoesisAgentRuntime): TestNoesisRuntime {
  const trails = new Map<string, StoredTrail>();
  const resumedTrailIds: string[] = [];
  let sequence = 0;
  let interactionSequence = 0;
  let failedTurnCount = 0;
  const interactions = new Map<string, TestInteractionState>();
  const turnIdsByTrail = new Map<string, string[]>();
  const actionsByTrail = new Map<string, RuntimeTranscriptAction[]>();
  const timestamp = (): string => new Date(Date.now() + sequence).toISOString();
  const getStored = (trailId: string): StoredTrail => {
    const trail = trails.get(trailId);
    if (!trail) throw new Error(`Trail not found: ${trailId}`);
    return trail;
  };
  const replaceState = (stored: StoredTrail, state: TrailState): TrailState => {
    stored.state = Object.freeze(state);
    stored.updatedAt = timestamp();
    return stored.state;
  };
  const startTrail: NoesisRuntime["startTrail"] = async (input) => {
    sequence += 1;
    const trailId = `trail_test_${String(sequence).padStart(4, "0")}`;
    const createdAt = timestamp();
    const state: TrailState = Object.freeze({
      trailId,
      title: input.title,
      status: "idle",
      provider: input.provider ?? "test-provider",
      model: input.model ?? "test-model",
      runtime: agent.name,
      capabilityVersions: Object.freeze({}),
      turns: Object.freeze([]),
    });
    trails.set(trailId, { state, createdAt, updatedAt: createdAt });
    return state;
  };
  const listTrails = (): readonly TrailState[] =>
    Object.freeze([...trails.values()].map(({ state }) => state));
  const getTrail = (trailId: string): TrailState => getStored(trailId).state;
  const getTranscript = async (trailId: string): Promise<readonly RuntimeTranscriptEntry[]> => {
    const stored = getStored(trailId);
    const turnIds = turnIdsByTrail.get(trailId) ?? [];
    const actions = actionsByTrail.get(trailId) ?? [];
    return Object.freeze(
      stored.state.turns.flatMap((turn, index): readonly RuntimeTranscriptEntry[] => {
        const turnId = turnIds[index] ?? `${trailId}:turn:${String(index)}`;
        return [
          Object.freeze({
            kind: "message",
            messageId: `${turnId}:user`,
            turnId,
            role: "user",
            text: turn.input,
            createdAt: stored.createdAt,
          }),
          ...actions.filter((action) => action.turnId === turnId),
          Object.freeze({
            kind: "message",
            messageId: `${turnId}:assistant`,
            turnId,
            role: "assistant",
            text: turn.output,
            createdAt: stored.updatedAt,
          }),
        ];
      }),
    );
  };
  const listTrailSummaries = (): readonly TrailSummary[] =>
    Object.freeze(
      [...trails.values()]
        .map(({ state, createdAt, updatedAt }) =>
          Object.freeze({
            trailId: state.trailId,
            ...(state.parentTrailId === undefined ? {} : { parentTrailId: state.parentTrailId }),
            title: state.title,
            status: state.status,
            provider: state.provider,
            model: state.model,
            runtime: state.runtime,
            createdAt,
            updatedAt,
            turnCount: state.turns.length,
            messageCount: state.turns.length * 2,
            preview: state.turns.at(-1)?.input ?? "",
          }),
        )
        .sort(compareTrailRecency)
        .slice(0, SESSION_PICKER_LIMIT),
    );
  const resumeTrail: NoesisRuntime["resumeTrail"] = async (trailId) => {
    const stored = getStored(trailId);
    if (stored.state.status === "running")
      throw new Error(`Session ${trailId} is already running and cannot be resumed`);
    resumedTrailIds.push(trailId);
    const interaction = interactions.get(trailId);
    if (interaction?.pending.length) interaction.queuePaused = true;
    stored.updatedAt = timestamp();
    return stored.state;
  };
  const forkTrail: NoesisRuntime["forkTrail"] = async (trailId, title) => {
    const parent = getStored(trailId).state;
    const forked = await startTrail({
      title: title ?? `${parent.title} (fork)`,
      provider: parent.provider,
      model: parent.model,
    });
    const stored = getStored(forked.trailId);
    return replaceState(stored, Object.freeze({ ...forked, parentTrailId: parent.trailId }));
  };
  const runTurn = async (
    trailId: string,
    input: string,
    options: RunTurnOptions = {},
  ): Promise<TurnResult> => {
    const stored = getStored(trailId);
    if (stored.state.status === "running") throw new Error(`Session ${trailId} is already running`);
    replaceState(stored, Object.freeze({ ...stored.state, status: "running" }));
    const context = compileContext(
      [
        {
          id: `${trailId}:user`,
          kind: "user",
          content: input,
          provenance: ["test"],
          priority: 100,
        },
      ],
      stored.state.capabilityVersions,
      { maxTokens: 4_000, maxFragmentTokens: 4_000 },
    );
    const result = await (async () => {
      try {
        return await agent.run(
          {
            trailId,
            provider: stored.state.provider,
            model: stored.state.model,
            thinkingLevel: options.thinkingLevel ?? "off",
            systemPrompt: "",
            prompt: input,
            activeCapabilities: [],
          },
          (event) => options.onEvent?.(event),
        );
      } catch (error) {
        replaceState(stored, Object.freeze({ ...stored.state, status: "idle" }));
        throw error;
      }
    })();
    if (result.outcome === "failed") {
      failedTurnCount += 1;
      replaceState(stored, Object.freeze({ ...stored.state, status: "failed" }));
      throw new Error(result.error);
    }
    if (result.outcome === "aborted") {
      replaceState(stored, Object.freeze({ ...stored.state, status: "idle" }));
      return Object.freeze({
        outcome: "aborted",
        output: result.text,
        context,
        usedCapabilities: Object.freeze({}),
        ...(result.contextUsage === undefined ? {} : { contextUsage: result.contextUsage }),
      });
    }
    replaceState(
      stored,
      Object.freeze({
        ...stored.state,
        status: "idle",
        contextSnapshotId: context.snapshotId,
        context,
        turns: Object.freeze([...stored.state.turns, Object.freeze({ input, output: result.text })]),
      }),
    );
    return Object.freeze({
      outcome: "completed",
      output: result.text,
      context,
      usedCapabilities: Object.freeze({}),
      ...(result.contextUsage === undefined ? {} : { contextUsage: result.contextUsage }),
    });
  };
  const interactionState = (trailId: string): TestInteractionState => {
    const existing = interactions.get(trailId);
    if (existing) return existing;
    getStored(trailId);
    const created: TestInteractionState = {
      phase: "idle",
      queuePaused: false,
      pending: [],
    };
    interactions.set(trailId, created);
    return created;
  };
  const interactionSnapshot = (trailId: string, state = interactionState(trailId)): InteractionSnapshot =>
    Object.freeze({
      sessionId: trailId,
      phase: state.phase,
      queuePaused: state.queuePaused,
      ...(state.active ? { active: Object.freeze({ ...state.active }) } : {}),
      pending: Object.freeze(state.pending.map((intent) => Object.freeze({ ...intent }))),
    });
  const emitInteractionState = (trailId: string, state: TestInteractionState): void => {
    state.observer?.({
      type: "state",
      snapshot: interactionSnapshot(trailId, state),
    });
  };
  const persistAction = (trailId: string, turnId: string, event: AgentActionEvent): AgentActionEvent => {
    const durableEvent = Object.freeze({
      ...event,
      actionId: `${turnId}:${event.actionId}`,
      ...(event.parentActionId ? { parentActionId: `${turnId}:${event.parentActionId}` } : {}),
    });
    const actions = actionsByTrail.get(trailId) ?? [];
    actionsByTrail.set(trailId, actions);
    const existingIndex = actions.findIndex((action) => action.actionId === durableEvent.actionId);
    const current = existingIndex < 0 ? undefined : actions[existingIndex];
    const occurredAt = timestamp();
    const next: RuntimeTranscriptAction =
      durableEvent.type === "tool-start"
        ? Object.freeze({
            kind: "action",
            actionId: durableEvent.actionId,
            turnId,
            ...(durableEvent.parentActionId ? { parentActionId: durableEvent.parentActionId } : {}),
            name: durableEvent.name,
            status: "running",
            input: durableEvent.input,
            startedAt: occurredAt,
          })
        : durableEvent.type === "tool-update"
          ? Object.freeze({
              ...(current ?? {
                kind: "action" as const,
                actionId: durableEvent.actionId,
                turnId,
                ...(durableEvent.parentActionId ? { parentActionId: durableEvent.parentActionId } : {}),
                name: durableEvent.name,
                status: "running" as const,
                startedAt: occurredAt,
              }),
              update: durableEvent.update,
            })
          : Object.freeze({
              ...(current ?? {
                kind: "action" as const,
                actionId: durableEvent.actionId,
                turnId,
                ...(durableEvent.parentActionId ? { parentActionId: durableEvent.parentActionId } : {}),
                name: durableEvent.name,
                startedAt: occurredAt,
              }),
              status: durableEvent.isError ? ("failed" as const) : ("completed" as const),
              output: durableEvent.result,
              completedAt: occurredAt,
            });
    if (existingIndex < 0) actions.push(next);
    else actions[existingIndex] = next;
    return durableEvent;
  };
  const scheduleInteractionDrain = (trailId: string, state: TestInteractionState): void => {
    if (state.drain || state.queuePaused || state.pending.length === 0) return;
    const drain = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(async () => {
      while (!state.queuePaused) {
        const intent = state.pending.shift();
        if (!intent) break;
        interactionSequence += 1;
        const turnId = `${trailId}:interaction:${String(interactionSequence)}`;
        state.active = {
          intentId: intent.intentId,
          turnId,
          text: intent.text,
          mode: intent.mode,
        };
        state.phase = "running";
        emitInteractionState(trailId, state);
        state.observer?.({
          type: "turn-started",
          sessionId: trailId,
          intentId: intent.intentId,
          turnId,
          text: intent.text,
        });
        try {
          const result = await runTurn(trailId, intent.text, {
            onEvent: (event) => {
              const emitted =
                event.type === "tool-start" || event.type === "tool-update" || event.type === "tool-end"
                  ? persistAction(trailId, turnId, event)
                  : event;
              state.observer?.({
                type: "agent",
                sessionId: trailId,
                turnId,
                event: emitted,
              });
            },
          });
          if (result.outcome === "completed") {
            const turnIds = turnIdsByTrail.get(trailId) ?? [];
            turnIds.push(turnId);
            turnIdsByTrail.set(trailId, turnIds);
          }
          if (result.outcome === "aborted")
            state.pending.unshift(
              Object.freeze({
                ...intent,
                mode: "turn",
              }),
            );
          state.observer?.({
            type: "turn-settled",
            sessionId: trailId,
            intentId: intent.intentId,
            turnId,
            outcome: result.outcome === "aborted" ? "aborted" : "completed",
          });
        } catch (error) {
          state.observer?.({
            type: "turn-settled",
            sessionId: trailId,
            intentId: intent.intentId,
            turnId,
            outcome: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        delete state.active;
        state.phase = "idle";
        emitInteractionState(trailId, state);
      }
    });
    state.drain = drain;
    void drain.finally(() => {
      delete state.drain;
      if (!state.queuePaused && state.pending.length > 0) scheduleInteractionDrain(trailId, state);
    });
  };
  const inspectInteraction: NoesisRuntime["inspectInteraction"] = async (trailId) =>
    interactionSnapshot(trailId);
  const interact: NoesisRuntime["interact"] = async (
    trailId: string,
    command: InteractionCommand,
    options: InteractionDispatchOptions = {},
  ): Promise<InteractionDispatchResult> => {
    const state = interactionState(trailId);
    if (options.onEvent) state.observer = options.onEvent;
    let effect: InteractionDispatchResult["effect"] = "idle";
    let restoredText: string | undefined;
    let intentId: string | undefined;
    if (command.type === "submit") {
      interactionSequence += 1;
      intentId = `${trailId}:intent:${String(interactionSequence)}`;
      state.pending.push(
        Object.freeze({
          intentId,
          text: command.text,
          mode: "turn",
          status: "pending",
          createdAt: timestamp(),
        }),
      );
      state.queuePaused = false;
      effect = "queued";
      emitInteractionState(trailId, state);
      scheduleInteractionDrain(trailId, state);
    } else if (command.type === "steer" && state.active) {
      const queued = command.text === undefined ? state.pending.pop() : undefined;
      const text = command.text ?? queued?.text;
      if (text) {
        const receipt = await agent.steer(trailId, text);
        if (receipt.status === "consumed") {
          effect = "steered";
          intentId = queued?.intentId;
          state.observer?.({
            type: "steer-delivered",
            sessionId: trailId,
            intentId: queued?.intentId ?? `${trailId}:explicit-steer`,
            turnId: state.active.turnId,
            text,
            deliveredAt: timestamp(),
          });
        } else if (command.text !== undefined) {
          effect = "restored";
          restoredText = command.text;
        } else if (queued) {
          state.pending.push(queued);
          effect = "queued";
        }
        emitInteractionState(trailId, state);
      }
    } else if (command.type === "steer" && command.text !== undefined) {
      restoredText = command.text;
    } else if (command.type === "restore-newest") {
      const restored = state.pending.pop();
      if (restored) {
        effect = "restored";
        restoredText = restored.text;
        intentId = restored.intentId;
        emitInteractionState(trailId, state);
      }
    } else if (command.type === "resume-queue" && state.pending.length > 0) {
      state.queuePaused = false;
      effect = "resumed";
      emitInteractionState(trailId, state);
      scheduleInteractionDrain(trailId, state);
    } else if (command.type === "interrupt" && state.active) {
      state.phase = "interrupting";
      state.queuePaused = true;
      effect = "interrupted";
      emitInteractionState(trailId, state);
      await agent.abort(trailId);
    }
    return Object.freeze({
      effect,
      snapshot: interactionSnapshot(trailId, state),
      ...(restoredText === undefined ? {} : { restoredText }),
      ...(intentId === undefined ? {} : { intentId }),
    });
  };

  return Object.freeze({
    agentDefaults: Object.freeze({
      provider: "test-provider",
      model: "test-model",
      thinkingLevel: "off",
    }),
    startTrail,
    listTrails,
    listTrailSummaries,
    getTrail,
    getTranscript,
    interact,
    inspectInteraction,
    resumeTrail,
    forkTrail,
    runTurn,
    compact: async () => undefined,
    get resumedTrailIds() {
      return Object.freeze([...resumedTrailIds]);
    },
    get failedTurnCount() {
      return failedTurnCount;
    },
  });
}
