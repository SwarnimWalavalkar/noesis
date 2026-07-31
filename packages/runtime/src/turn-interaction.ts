import type { AgentRuntimeEvent, AgentSteerResult, AgentThinkingLevel } from "@noesis/agent-types";
import type { UserIntentRecord } from "@noesis/workspace";

export type InteractionCommand =
  | { readonly type: "submit"; readonly text: string }
  | { readonly type: "steer"; readonly text?: string }
  | { readonly type: "restore-newest" }
  | { readonly type: "resume-queue" }
  | { readonly type: "interrupt" };

export interface InteractionPendingIntent {
  readonly intentId: string;
  readonly text: string;
  readonly mode: "turn" | "steer";
  readonly status: "pending" | "unresolved";
  readonly createdAt: string;
}

export interface InteractionActiveTurn {
  readonly intentId: string;
  readonly turnId: string;
  readonly text: string;
  readonly mode: "turn" | "steer";
}

export interface InteractionSnapshot {
  readonly sessionId: string;
  readonly phase: "idle" | "running" | "interrupting";
  readonly queuePaused: boolean;
  readonly active?: InteractionActiveTurn;
  readonly pending: readonly InteractionPendingIntent[];
}

export type TurnInteractionEvent =
  | { readonly type: "state"; readonly snapshot: InteractionSnapshot }
  | {
      readonly type: "turn-started";
      readonly sessionId: string;
      readonly intentId: string;
      readonly turnId: string;
      readonly text: string;
    }
  | {
      readonly type: "agent";
      readonly sessionId: string;
      readonly turnId: string;
      readonly event: AgentRuntimeEvent;
    }
  | {
      readonly type: "steer-delivered";
      readonly sessionId: string;
      readonly intentId: string;
      readonly turnId: string;
      readonly text: string;
      readonly deliveredAt: string;
    }
  | {
      readonly type: "turn-settled";
      readonly sessionId: string;
      readonly intentId: string;
      readonly turnId: string;
      readonly outcome: "completed" | "aborted" | "failed";
      readonly error?: string;
    };

export interface InteractionDispatchOptions {
  /**
   * Replaces the observer currently attached to this controller. It remains active after dispatch
   * resolves so background turns can continue reporting events without accumulating callbacks.
   */
  readonly onEvent?: (event: TurnInteractionEvent) => void;
  readonly thinkingLevel?: AgentThinkingLevel;
}

export interface InteractionDispatchResult {
  readonly effect: "queued" | "steered" | "unresolved" | "restored" | "resumed" | "interrupted" | "idle";
  readonly snapshot: InteractionSnapshot;
  readonly intentId?: string;
  readonly restoredText?: string;
}

export interface TurnInteractionIntentStore {
  readonly enqueue: (request: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly text: string;
    readonly queuedBehindTurnId?: string;
    readonly createdAt: string;
  }) => Promise<UserIntentRecord>;
  readonly listPending: (sessionId: string) => Promise<readonly UserIntentRecord[]>;
  readonly listUnresolved: (sessionId: string) => Promise<readonly UserIntentRecord[]>;
  readonly claimOldestPending: (request: {
    readonly sessionId: string;
    readonly targetTurnId: string;
    readonly claimedAt: string;
  }) => Promise<UserIntentRecord | undefined>;
  readonly promoteNewestPendingToSteer: (request: {
    readonly sessionId: string;
    readonly targetTurnId: string;
    readonly promotedAt: string;
  }) => Promise<UserIntentRecord | undefined>;
  readonly promotePendingToSteer: (request: {
    readonly sessionId: string;
    readonly intentId: string;
    readonly targetTurnId: string;
    readonly promotedAt: string;
  }) => Promise<UserIntentRecord | undefined>;
  readonly withdraw: (request: {
    readonly sessionId: string;
    readonly intentId: string;
    readonly withdrawnAt: string;
  }) => Promise<UserIntentRecord | undefined>;
  readonly markDelivered: (request: {
    readonly sessionId: string;
    readonly intentId: string;
    readonly targetTurnId: string;
    readonly deliveredAt: string;
  }) => Promise<UserIntentRecord | undefined>;
  readonly releaseUnconsumedDispatch: (request: {
    readonly sessionId: string;
    readonly intentId: string;
    readonly releasedAt: string;
  }) => Promise<UserIntentRecord | undefined>;
  readonly markUnresolved: (request: {
    readonly sessionId: string;
    readonly intentId: string;
    readonly targetTurnId: string;
    readonly unresolvedAt: string;
  }) => Promise<UserIntentRecord | undefined>;
  readonly recoverDispatching: (request: {
    readonly sessionId: string;
    readonly recoveredAt: string;
  }) => Promise<{
    readonly released: number;
    readonly delivered: number;
    readonly unresolved: number;
  }>;
}

export interface TurnInteractionControllerOptions {
  readonly intents: TurnInteractionIntentStore;
  readonly createIntentId: () => string;
  readonly createTurnId: () => string;
  readonly now?: () => string;
  readonly schedule?: (task: () => void) => () => void;
  readonly runTurn: (request: {
    readonly sessionId: string;
    readonly intentId: string;
    readonly turnId: string;
    readonly text: string;
    readonly thinkingLevel?: AgentThinkingLevel;
    readonly onEvent: (event: AgentRuntimeEvent) => void;
    readonly onReady: () => void;
    readonly isInterruptRequested: () => boolean;
  }) => Promise<{ readonly outcome: "completed" | "aborted" }>;
  readonly steer: (sessionId: string, text: string) => Promise<AgentSteerResult>;
  readonly recordSteerDelivery: (request: {
    readonly sessionId: string;
    readonly intentId: string;
    readonly turnId: string;
    readonly text: string;
    readonly deliveredAt: string;
  }) => Promise<void>;
  readonly interrupt: (sessionId: string) => Promise<void>;
}

export interface TurnInteractionController {
  readonly inspect: (sessionId: string) => Promise<InteractionSnapshot>;
  readonly dispatch: (
    sessionId: string,
    command: InteractionCommand,
    options?: InteractionDispatchOptions,
  ) => Promise<InteractionDispatchResult>;
  readonly close: () => Promise<void>;
}

interface SessionInteractionState {
  phase: InteractionSnapshot["phase"];
  queuePaused: boolean;
  active?: InteractionActiveTurn;
  observer?: (event: TurnInteractionEvent) => void;
  recovery?: Promise<void>;
  commandTail: Promise<void>;
  drain?: Promise<void>;
  steerDeliveries: Set<Promise<InteractionDispatchResult>>;
  cancelScheduled?: () => void;
  wakeRequested: boolean;
  resumeGeneration: number;
  interruptRequested: boolean;
  steerableIntentId?: string;
}

const defaultSchedule = (task: () => void): (() => void) => {
  const handle = setTimeout(task, 0);
  return () => clearTimeout(handle);
};

const intentText = (record: UserIntentRecord): string => {
  if (record.text === undefined)
    throw new Error(`Intent ${record.intentId} has no editable content in status ${record.status}`);
  return record.text;
};

const pendingIntent = (record: UserIntentRecord): InteractionPendingIntent =>
  Object.freeze({
    intentId: record.intentId,
    text: intentText(record),
    mode: record.deliveryMode,
    status: record.status === "unresolved" ? ("unresolved" as const) : ("pending" as const),
    createdAt: record.createdAt,
  });

export function createTurnInteractionController(
  options: TurnInteractionControllerOptions,
): TurnInteractionController {
  const now = options.now ?? (() => new Date().toISOString());
  const schedule = options.schedule ?? defaultSchedule;
  const sessions = new Map<string, SessionInteractionState>();
  let observedSessionId: string | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const stateFor = (sessionId: string): SessionInteractionState => {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionInteractionState = {
      phase: "idle",
      queuePaused: true,
      commandTail: Promise.resolve(),
      steerDeliveries: new Set(),
      wakeRequested: false,
      resumeGeneration: 0,
      interruptRequested: false,
    };
    sessions.set(sessionId, created);
    return created;
  };

  const notify = (state: SessionInteractionState, event: TurnInteractionEvent): void => {
    try {
      state.observer?.(event);
    } catch {
      // Rendering observers never own the interaction lifecycle.
    }
  };

  const ensureRecovered = async (sessionId: string, state: SessionInteractionState): Promise<void> => {
    state.recovery ??= options.intents
      .recoverDispatching({ sessionId, recoveredAt: now() })
      .then(() => undefined);
    await state.recovery;
  };

  const snapshot = async (
    sessionId: string,
    state: SessionInteractionState,
  ): Promise<InteractionSnapshot> => {
    const [pending, unresolved] = await Promise.all([
      options.intents.listPending(sessionId),
      options.intents.listUnresolved(sessionId),
    ]);
    const available = [...pending, ...unresolved].sort(
      (left, right) =>
        left.queueSequence - right.queueSequence || left.intentId.localeCompare(right.intentId),
    );
    return Object.freeze({
      sessionId,
      phase: state.phase,
      queuePaused: state.queuePaused,
      ...(state.active ? { active: Object.freeze({ ...state.active }) } : {}),
      pending: Object.freeze(available.map(pendingIntent)),
    });
  };

  const notifyState = async (sessionId: string, state: SessionInteractionState): Promise<void> => {
    notify(state, { type: "state", snapshot: await snapshot(sessionId, state) });
  };

  const settleFailedDispatch = async (
    sessionId: string,
    state: SessionInteractionState,
    active: InteractionActiveTurn,
    resumeGenerationAtStart: number,
    outcome: "aborted" | "failed",
    error?: string,
  ): Promise<void> => {
    await options.intents.releaseUnconsumedDispatch({
      sessionId,
      intentId: active.intentId,
      releasedAt: now(),
    });
    if (state.resumeGeneration === resumeGenerationAtStart) state.queuePaused = true;
    delete state.active;
    delete state.steerableIntentId;
    state.interruptRequested = false;
    state.phase = "idle";
    notify(state, {
      type: "turn-settled",
      sessionId,
      intentId: active.intentId,
      turnId: active.turnId,
      outcome,
      ...(error ? { error } : {}),
    });
    await notifyState(sessionId, state);
  };

  const drain = async (
    sessionId: string,
    state: SessionInteractionState,
    thinkingLevel?: AgentThinkingLevel,
  ): Promise<void> => {
    while (!closed && !state.queuePaused) {
      state.wakeRequested = false;
      const turnId = options.createTurnId();
      const claimed = await options.intents.claimOldestPending({
        sessionId,
        targetTurnId: turnId,
        claimedAt: now(),
      });
      if (!claimed) return;
      const active = Object.freeze({
        intentId: claimed.intentId,
        turnId,
        text: intentText(claimed),
        mode: "turn" as const,
      });
      state.active = active;
      state.phase = "running";
      state.interruptRequested = false;
      delete state.steerableIntentId;
      const resumeGenerationAtStart = state.resumeGeneration;
      await notifyState(sessionId, state);
      try {
        const result = await options.runTurn({
          sessionId,
          intentId: active.intentId,
          turnId,
          text: active.text,
          ...(thinkingLevel ? { thinkingLevel } : {}),
          onEvent: (event) => notify(state, { type: "agent", sessionId, turnId, event }),
          onReady: () => {
            if (state.active?.intentId !== active.intentId) return;
            if (state.steerableIntentId === active.intentId) return;
            state.steerableIntentId = active.intentId;
            notify(state, {
              type: "turn-started",
              sessionId,
              intentId: active.intentId,
              turnId,
              text: active.text,
            });
          },
          isInterruptRequested: () => state.interruptRequested,
        });
        if (result.outcome === "aborted") {
          await settleFailedDispatch(sessionId, state, active, resumeGenerationAtStart, "aborted");
          return;
        }
        const delivered = await options.intents.markDelivered({
          sessionId,
          intentId: active.intentId,
          targetTurnId: turnId,
          deliveredAt: now(),
        });
        if (!delivered) throw new Error(`Completed turn ${turnId} did not settle its claimed intent`);
        delete state.active;
        delete state.steerableIntentId;
        state.interruptRequested = false;
        state.phase = "idle";
        notify(state, {
          type: "turn-settled",
          sessionId,
          intentId: active.intentId,
          turnId,
          outcome: "completed",
        });
        await notifyState(sessionId, state);
        // A steer can be consumed just before the model turn settles. Commit its durable outcome
        // before the next queued turn builds model history from authoritative messages.
        await Promise.allSettled([...state.steerDeliveries]);
      } catch (error) {
        await settleFailedDispatch(
          sessionId,
          state,
          active,
          resumeGenerationAtStart,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
    }
  };

  const scheduleDrain = (
    sessionId: string,
    state: SessionInteractionState,
    thinkingLevel?: AgentThinkingLevel,
  ): void => {
    if (closed || state.queuePaused) return;
    if (state.drain || state.cancelScheduled) {
      state.wakeRequested = true;
      return;
    }
    state.cancelScheduled = schedule(() => {
      delete state.cancelScheduled;
      if (closed || state.queuePaused) return;
      const running = drain(sessionId, state, thinkingLevel);
      state.drain = running;
      void running.finally(() => {
        delete state.drain;
        if (state.wakeRequested && !state.queuePaused) scheduleDrain(sessionId, state, thinkingLevel);
      });
    });
  };

  const serialize = async <T>(state: SessionInteractionState, operation: () => Promise<T>): Promise<T> => {
    const result = state.commandTail.then(operation, operation);
    state.commandTail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  };

  const inspect = async (sessionId: string): Promise<InteractionSnapshot> => {
    const state = stateFor(sessionId);
    await ensureRecovered(sessionId, state);
    return await snapshot(sessionId, state);
  };

  const dispatch = async (
    sessionId: string,
    command: InteractionCommand,
    dispatchOptions: InteractionDispatchOptions = {},
  ): Promise<InteractionDispatchResult> => {
    if (closed) throw new Error("Turn interaction controller is closed");
    const state = stateFor(sessionId);
    if (dispatchOptions.onEvent) {
      if (observedSessionId && observedSessionId !== sessionId) delete stateFor(observedSessionId).observer;
      observedSessionId = sessionId;
      state.observer = dispatchOptions.onEvent;
    }
    type SerializedDispatch =
      | { readonly result: InteractionDispatchResult }
      | { readonly settlement: Promise<InteractionDispatchResult> };
    const serialized = await serialize<SerializedDispatch>(state, async () => {
      await ensureRecovered(sessionId, state);
      if (command.type === "submit") {
        if (!command.text) throw new Error("Cannot queue an empty message");
        const intent = await options.intents.enqueue({
          intentId: options.createIntentId(),
          sessionId,
          text: command.text,
          createdAt: now(),
        });
        state.queuePaused = false;
        state.resumeGeneration += 1;
        const current = await snapshot(sessionId, state);
        scheduleDrain(sessionId, state, dispatchOptions.thinkingLevel);
        return Object.freeze({
          result: Object.freeze({ effect: "queued" as const, intentId: intent.intentId, snapshot: current }),
        });
      }
      if (command.type === "resume-queue") {
        state.queuePaused = false;
        state.resumeGeneration += 1;
        const current = await snapshot(sessionId, state);
        notify(state, { type: "state", snapshot: current });
        scheduleDrain(sessionId, state, dispatchOptions.thinkingLevel);
        return Object.freeze({ result: Object.freeze({ effect: "resumed" as const, snapshot: current }) });
      }
      if (command.type === "restore-newest") {
        const available = (await snapshot(sessionId, state)).pending;
        const newest = available.at(-1);
        const restored = newest
          ? await options.intents.withdraw({
              sessionId,
              intentId: newest.intentId,
              withdrawnAt: now(),
            })
          : undefined;
        const current = await snapshot(sessionId, state);
        notify(state, { type: "state", snapshot: current });
        return Object.freeze(
          restored
            ? {
                result: Object.freeze({
                  effect: "restored" as const,
                  intentId: restored.intentId,
                  restoredText: intentText(restored),
                  snapshot: current,
                }),
              }
            : { result: Object.freeze({ effect: "idle" as const, snapshot: current }) },
        );
      }
      if (command.type === "interrupt") {
        state.queuePaused = true;
        state.cancelScheduled?.();
        delete state.cancelScheduled;
        const active = state.active;
        if (!active) {
          const current = await snapshot(sessionId, state);
          notify(state, { type: "state", snapshot: current });
          return Object.freeze({ result: Object.freeze({ effect: "idle" as const, snapshot: current }) });
        }
        state.phase = "interrupting";
        state.interruptRequested = true;
        await notifyState(sessionId, state);
        await options.interrupt(sessionId);
        if (state.drain) await state.drain;
        return Object.freeze({
          result: Object.freeze({
            effect: "interrupted" as const,
            intentId: active.intentId,
            snapshot: await snapshot(sessionId, state),
          }),
        });
      }

      const active =
        state.phase === "running" && state.steerableIntentId === state.active?.intentId
          ? state.active
          : undefined;
      if (!active && command.text !== undefined) {
        if (!command.text) throw new Error("Cannot steer with an empty message");
        return Object.freeze({
          result: Object.freeze({
            effect: "idle" as const,
            restoredText: command.text,
            snapshot: await snapshot(sessionId, state),
          }),
        });
      }
      if (!active)
        return Object.freeze({
          result: Object.freeze({ effect: "idle" as const, snapshot: await snapshot(sessionId, state) }),
        });
      let steeringIntent: UserIntentRecord | undefined;
      const explicit = command.text !== undefined;
      if (command.text !== undefined) {
        if (!command.text) throw new Error("Cannot steer with an empty message");
        const enqueued = await options.intents.enqueue({
          intentId: options.createIntentId(),
          sessionId,
          text: command.text,
          createdAt: now(),
        });
        steeringIntent = await options.intents.promotePendingToSteer({
          sessionId,
          intentId: enqueued.intentId,
          targetTurnId: active.turnId,
          promotedAt: now(),
        });
        if (!steeringIntent || steeringIntent.intentId !== enqueued.intentId) {
          const restored = await options.intents.withdraw({
            sessionId,
            intentId: enqueued.intentId,
            withdrawnAt: now(),
          });
          return Object.freeze({
            result: Object.freeze({
              effect: "idle" as const,
              ...(restored ? { restoredText: intentText(restored), intentId: restored.intentId } : {}),
              snapshot: await snapshot(sessionId, state),
            }),
          });
        }
      } else {
        steeringIntent = await options.intents.promoteNewestPendingToSteer({
          sessionId,
          targetTurnId: active.turnId,
          promotedAt: now(),
        });
        if (!steeringIntent)
          return Object.freeze({
            result: Object.freeze({ effect: "idle" as const, snapshot: await snapshot(sessionId, state) }),
          });
      }
      const intent = steeringIntent;
      const text = intentText(intent);
      const settlement = (async (): Promise<InteractionDispatchResult> => {
        let receipt: AgentSteerResult;
        try {
          receipt = await options.steer(sessionId, text);
        } catch {
          await options.intents.markUnresolved({
            sessionId,
            intentId: intent.intentId,
            targetTurnId: active.turnId,
            unresolvedAt: now(),
          });
          const current = await snapshot(sessionId, state);
          notify(state, { type: "state", snapshot: current });
          return Object.freeze({ effect: "unresolved", intentId: intent.intentId, snapshot: current });
        }
        if (receipt.status === "not-consumed") {
          await options.intents.releaseUnconsumedDispatch({
            sessionId,
            intentId: intent.intentId,
            releasedAt: now(),
          });
          if (explicit) {
            const restored = await options.intents.withdraw({
              sessionId,
              intentId: intent.intentId,
              withdrawnAt: now(),
            });
            const current = await snapshot(sessionId, state);
            notify(state, { type: "state", snapshot: current });
            return Object.freeze({
              effect: restored ? ("restored" as const) : ("idle" as const),
              intentId: intent.intentId,
              ...(restored ? { restoredText: intentText(restored) } : {}),
              snapshot: current,
            });
          }
          const current = await snapshot(sessionId, state);
          notify(state, { type: "state", snapshot: current });
          return Object.freeze({ effect: "queued", intentId: intent.intentId, snapshot: current });
        }
        const deliveredAt = now();
        try {
          await options.recordSteerDelivery({
            sessionId,
            intentId: intent.intentId,
            turnId: active.turnId,
            text,
            deliveredAt,
          });
        } catch {
          await options.intents.markUnresolved({
            sessionId,
            intentId: intent.intentId,
            targetTurnId: active.turnId,
            unresolvedAt: now(),
          });
          const current = await snapshot(sessionId, state);
          notify(state, { type: "state", snapshot: current });
          return Object.freeze({ effect: "unresolved", intentId: intent.intentId, snapshot: current });
        }
        notify(state, {
          type: "steer-delivered",
          sessionId,
          intentId: intent.intentId,
          turnId: active.turnId,
          text,
          deliveredAt,
        });
        const current = await snapshot(sessionId, state);
        notify(state, { type: "state", snapshot: current });
        return Object.freeze({ effect: "steered", intentId: intent.intentId, snapshot: current });
      })();
      state.steerDeliveries.add(settlement);
      void settlement.then(
        () => state.steerDeliveries.delete(settlement),
        () => state.steerDeliveries.delete(settlement),
      );
      return Object.freeze({ settlement });
    });
    return "settlement" in serialized ? await serialized.settlement : serialized.result;
  };

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closed = true;
      const interruptFailures: unknown[] = [];
      const interrupts: Promise<void>[] = [];
      for (const [sessionId, state] of sessions) {
        state.queuePaused = true;
        state.cancelScheduled?.();
        delete state.cancelScheduled;
        if (state.active) state.phase = "interrupting";
        state.interruptRequested = true;
        interrupts.push(
          options.interrupt(sessionId).catch((error: unknown) => {
            interruptFailures.push(error);
          }),
        );
      }
      await Promise.all(interrupts);
      await Promise.all([...sessions.values()].map(async (state) => await state.commandTail));
      const settlements = await Promise.allSettled(
        [...sessions.values()].flatMap((state) => [
          ...(state.drain ? [state.drain] : []),
          ...state.steerDeliveries,
        ]),
      );
      for (const state of sessions.values()) delete state.observer;
      observedSessionId = undefined;
      const failure =
        interruptFailures[0] ?? settlements.find((settlement) => settlement.status === "rejected")?.reason;
      if (failure !== undefined) throw failure;
    })();
    return closePromise;
  };

  return Object.freeze({ inspect, dispatch, close });
}
