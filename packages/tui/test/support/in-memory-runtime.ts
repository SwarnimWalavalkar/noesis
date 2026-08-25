import { createConditionalObject } from "@noesis/domain";
import type { AgentActionEvent, NoesisAgentRuntime } from "@noesis/agent-types";
import { compileContext } from "@noesis/context";
import {
  compareTrailRecency,
  type InteractionCommand,
  type InteractionDispatchOptions,
  type InteractionDispatchResult,
  type InteractionPendingIntent,
  type InteractionSnapshot,
  type NoesisRuntime,
  type RunTurnOptions,
  type RuntimeTranscriptAction,
  type RuntimeTranscriptEntry,
  SESSION_PICKER_LIMIT,
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
      thinkingLevel: input.thinkingLevel ?? "off",
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
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  const listTrailSummaries = (): readonly TrailSummary[] =>
    Object.freeze(
      [...trails.values()]
        .filter(({ state }) => {
          const interaction = interactions.get(state.trailId);
          return (
            state.turns.length > 0 || Boolean(interaction?.active) || Boolean(interaction?.pending.length)
          );
        })
        .map(({ state, createdAt, updatedAt }) =>
          Object.freeze(
            createConditionalObject({
              trailId: state.trailId,
            } as const)
              .addOptional(
                !(state.parentTrailId === undefined) ? { parentTrailId: state.parentTrailId } : undefined,
              )
              .add({
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
              } as const)
              .finish(),
          ),
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
  const deleteTrail: NoesisRuntime["deleteTrail"] = async (trailId) => {
    const stored = getStored(trailId);
    const interaction = interactions.get(trailId);
    if (stored.state.status === "running" || interaction?.phase === "running")
      throw new Error("A running session cannot be deleted.");
    if (interaction?.pending.length) throw new Error("A session with queued work cannot be deleted.");
    trails.delete(trailId);
    interactions.delete(trailId);
    turnIdsByTrail.delete(trailId);
    actionsByTrail.delete(trailId);
  };
  const discardTrailIfEmpty: NoesisRuntime["discardTrailIfEmpty"] = async (trailId) => {
    const stored = trails.get(trailId);
    const interaction = interactions.get(trailId);
    if (
      !stored ||
      stored.state.turns.length > 0 ||
      stored.state.status === "running" ||
      interaction?.phase === "running" ||
      Boolean(interaction?.active) ||
      Boolean(interaction?.pending.length)
    )
      return false;
    await deleteTrail(trailId);
    return true;
  };
  const forkTrail: NoesisRuntime["forkTrail"] = async (trailId, title) => {
    const parent = getStored(trailId).state;
    const forked = await startTrail({
      title: title ?? `${parent.title} (fork)`,
      provider: parent.provider,
      model: parent.model,
      thinkingLevel: parent.thinkingLevel,
    });
    const stored = getStored(forked.trailId);
    return replaceState(
      stored,
      Object.freeze({
        ...forked,
        parentTrailId: parent.trailId,
        turns: Object.freeze([...parent.turns]),
      }),
    );
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
      { maxTokens: 4000, maxFragmentTokens: 4000 },
    );
    const result = await (async () => {
      try {
        return await agent.run(
          {
            trailId,
            provider: stored.state.provider,
            model: stored.state.model,
            thinkingLevel: options.thinkingLevel ?? stored.state.thinkingLevel,
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
      // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
      return Object.freeze(
        createConditionalObject({
          outcome: "aborted",
          output: result.text,
          context,
          usedCapabilities: Object.freeze({}),
        } as const)
          .addOptional(
            !(result.contextUsage === undefined) ? { contextUsage: result.contextUsage } : undefined,
          )
          .finish(),
      );
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
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    return Object.freeze(
      createConditionalObject({
        outcome: "completed",
        output: result.text,
        context,
        usedCapabilities: Object.freeze({}),
      } as const)
        .addOptional(!(result.contextUsage === undefined) ? { contextUsage: result.contextUsage } : undefined)
        .finish(),
    );
  };
  const interactionState = (trailId: string): TestInteractionState => {
    const existing = interactions.get(trailId);
    if (existing) return existing;
    getStored(trailId);
    const created: TestInteractionState = {
      phase: "idle",
      queuePaused: true,
      pending: [],
    };
    interactions.set(trailId, created);
    return created;
  };
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  const interactionSnapshot = (trailId: string, state = interactionState(trailId)): InteractionSnapshot =>
    Object.freeze(
      createConditionalObject({
        sessionId: trailId,
        phase: state.phase,
        queuePaused: state.queuePaused,
      } as const)
        .addOptional(state.active ? { active: Object.freeze({ ...state.active }) } : undefined)
        .add({
          pending: Object.freeze(state.pending.map((intent) => Object.freeze({ ...intent }))),
        } as const)
        .finish(),
    );
  const emitInteractionState = (trailId: string, state: TestInteractionState): void => {
    state.observer?.({
      type: "state",
      snapshot: interactionSnapshot(trailId, state),
    });
  };
  const persistAction = (trailId: string, turnId: string, event: AgentActionEvent): AgentActionEvent => {
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const durableEvent = Object.freeze(
      createConditionalObject({
        ...event,
        actionId: `${turnId}:${event.actionId}`,
      } as const)
        .addOptional(
          event.parentActionId ? { parentActionId: `${turnId}:${event.parentActionId}` } : undefined,
        )
        .finish(),
    );
    const actions = actionsByTrail.get(trailId) ?? [];
    actionsByTrail.set(trailId, actions);
    const existingIndex = actions.findIndex((action) => action.actionId === durableEvent.actionId);
    const current = existingIndex < 0 ? undefined : actions[existingIndex];
    const occurredAt = timestamp();
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const next: RuntimeTranscriptAction =
      durableEvent.type === "tool-start"
        ? Object.freeze(
            createConditionalObject({
              kind: "action",
              actionId: durableEvent.actionId,
              turnId,
            } as const)
              .addOptional(
                durableEvent.parentActionId ? { parentActionId: durableEvent.parentActionId } : undefined,
              )
              .add({
                name: durableEvent.name,
                status: "running",
                input: durableEvent.input,
                startedAt: occurredAt,
              } as const)
              .finish(),
          )
        : durableEvent.type === "tool-update"
          ? Object.freeze({
              ...(current ??
                createConditionalObject({
                  kind: "action" as const,
                  actionId: durableEvent.actionId,
                  turnId,
                } as const)
                  .addOptional(
                    durableEvent.parentActionId ? { parentActionId: durableEvent.parentActionId } : undefined,
                  )
                  .add({
                    name: durableEvent.name,
                    status: "running" as const,
                    startedAt: occurredAt,
                  } as const)
                  .finish()),
              update: durableEvent.update,
            })
          : Object.freeze({
              ...(current ??
                createConditionalObject({
                  kind: "action" as const,
                  actionId: durableEvent.actionId,
                  turnId,
                } as const)
                  .addOptional(
                    durableEvent.parentActionId ? { parentActionId: durableEvent.parentActionId } : undefined,
                  )
                  .add({
                    name: durableEvent.name,
                    startedAt: occurredAt,
                  } as const)
                  .finish()),
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
    let queueWasHeld: boolean | undefined;
    if (command.type === "submit" || command.type === "enqueue") {
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
      if (command.type === "submit") state.queuePaused = false;
      effect = "queued";
      emitInteractionState(trailId, state);
      if (command.type === "submit") scheduleInteractionDrain(trailId, state);
    } else if (command.type === "reroute-pending") {
      const source = interactionState(command.sourceSessionId);
      const selected = source.pending.filter((intent) => command.intentIds.includes(intent.intentId));
      if (selected.length !== command.intentIds.length)
        throw new Error("A source intent is no longer pending");
      source.pending.splice(
        0,
        source.pending.length,
        ...source.pending.filter((intent) => !command.intentIds.includes(intent.intentId)),
      );
      for (const intent of selected) {
        interactionSequence += 1;
        state.pending.push(
          Object.freeze({ ...intent, intentId: `${trailId}:intent:${String(interactionSequence)}` }),
        );
      }
      effect = "rerouted";
      emitInteractionState(command.sourceSessionId, source);
      emitInteractionState(trailId, state);
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
    } else if (command.type === "pause-queue") {
      queueWasHeld = state.queuePaused && state.pending.length > 0;
      state.queuePaused = true;
      emitInteractionState(trailId, state);
    } else if (command.type === "interrupt" && state.active && command.turnId === state.active.turnId) {
      state.phase = "interrupting";
      state.queuePaused = true;
      effect = "interrupted";
      emitInteractionState(trailId, state);
      await agent.abort(trailId);
    }
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    return Object.freeze(
      createConditionalObject({
        effect,
        snapshot: interactionSnapshot(trailId, state),
      } as const)
        .addOptional(!(restoredText === undefined) ? { restoredText } : undefined)
        .addOptional(!(intentId === undefined) ? { intentId } : undefined)
        .addOptional(!(queueWasHeld === undefined) ? { queueWasHeld } : undefined)
        .finish(),
    );
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
    deleteTrail,
    discardTrailIfEmpty,
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
