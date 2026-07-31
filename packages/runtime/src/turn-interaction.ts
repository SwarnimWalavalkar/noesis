import type { AgentRuntimeEvent, AgentThinkingLevel } from "@noesis/agent-types";
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
  readonly effect: "queued" | "steered" | "restored" | "resumed" | "interrupted" | "idle";
  readonly snapshot: InteractionSnapshot;
  readonly intentId?: string;
  readonly restoredText?: string;
}

export interface TurnInteractionIntentStore {
  readonly enqueue: (request: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly text: string;
    readonly mode: "turn" | "steer";
    readonly queuedBehindTurnId?: string;
    readonly createdAt: string;
  }) => Promise<UserIntentRecord>;
  readonly listPending: (sessionId: string) => Promise<readonly UserIntentRecord[]>;
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
  readonly withdrawNewestPending: (request: {
    readonly sessionId: string;
    readonly withdrawnAt: string;
  }) => Promise<UserIntentRecord | undefined>;
  readonly markDelivered: (request: {
    readonly sessionId: string;
    readonly intentId: string;
    readonly targetTurnId: string;
    readonly deliveredAt: string;
  }) => Promise<UserIntentRecord | undefined>;
  readonly releaseFailedDispatch: (request: {
    readonly sessionId: string;
    readonly intentId: string;
    readonly releasedAt: string;
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
  readonly steer: (sessionId: string, text: string) => Promise<void>;
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
  readonly close: () => void;
}

interface SessionInteractionState {
  phase: InteractionSnapshot["phase"];
  queuePaused: boolean;
  active?: InteractionActiveTurn;
  observer?: (event: TurnInteractionEvent) => void;
  recovery?: Promise<void>;
  commandTail: Promise<void>;
  drain?: Promise<void>;
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

const pendingIntent = (record: UserIntentRecord): InteractionPendingIntent =>
  Object.freeze({
    intentId: record.intentId,
    text: record.text,
    mode: record.deliveryMode,
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

  const stateFor = (sessionId: string): SessionInteractionState => {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionInteractionState = {
      phase: "idle",
      queuePaused: true,
      commandTail: Promise.resolve(),
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
    const pending = await options.intents.listPending(sessionId);
    return Object.freeze({
      sessionId,
      phase: state.phase,
      queuePaused: state.queuePaused,
      ...(state.active ? { active: Object.freeze({ ...state.active }) } : {}),
      pending: Object.freeze(pending.map(pendingIntent)),
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
    await options.intents.releaseFailedDispatch({
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
        text: claimed.text,
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
    return await serialize(state, async () => {
      await ensureRecovered(sessionId, state);
      if (command.type === "submit") {
        if (!command.text) throw new Error("Cannot queue an empty message");
        const intent = await options.intents.enqueue({
          intentId: options.createIntentId(),
          sessionId,
          text: command.text,
          mode: "turn",
          createdAt: now(),
        });
        state.queuePaused = false;
        state.resumeGeneration += 1;
        const current = await snapshot(sessionId, state);
        scheduleDrain(sessionId, state, dispatchOptions.thinkingLevel);
        return Object.freeze({ effect: "queued" as const, intentId: intent.intentId, snapshot: current });
      }
      if (command.type === "resume-queue") {
        state.queuePaused = false;
        state.resumeGeneration += 1;
        const current = await snapshot(sessionId, state);
        notify(state, { type: "state", snapshot: current });
        scheduleDrain(sessionId, state, dispatchOptions.thinkingLevel);
        return Object.freeze({ effect: "resumed" as const, snapshot: current });
      }
      if (command.type === "restore-newest") {
        const restored = await options.intents.withdrawNewestPending({
          sessionId,
          withdrawnAt: now(),
        });
        const current = await snapshot(sessionId, state);
        notify(state, { type: "state", snapshot: current });
        return Object.freeze(
          restored
            ? {
                effect: "restored" as const,
                intentId: restored.intentId,
                restoredText: restored.text,
                snapshot: current,
              }
            : { effect: "idle" as const, snapshot: current },
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
          return Object.freeze({ effect: "idle" as const, snapshot: current });
        }
        state.phase = "interrupting";
        state.interruptRequested = true;
        await notifyState(sessionId, state);
        await options.interrupt(sessionId);
        return Object.freeze({
          effect: "interrupted" as const,
          intentId: active.intentId,
          snapshot: await snapshot(sessionId, state),
        });
      }

      const active =
        state.phase === "running" && state.steerableIntentId === state.active?.intentId
          ? state.active
          : undefined;
      if (!active && command.text !== undefined) {
        if (!command.text) throw new Error("Cannot steer with an empty message");
        const intent = await options.intents.enqueue({
          intentId: options.createIntentId(),
          sessionId,
          text: command.text,
          mode: "turn",
          createdAt: now(),
        });
        state.queuePaused = false;
        state.resumeGeneration += 1;
        const current = await snapshot(sessionId, state);
        scheduleDrain(sessionId, state, dispatchOptions.thinkingLevel);
        return Object.freeze({
          effect: "queued" as const,
          intentId: intent.intentId,
          snapshot: current,
        });
      }
      if (!active)
        return Object.freeze({ effect: "idle" as const, snapshot: await snapshot(sessionId, state) });
      let steeringIntent: UserIntentRecord | undefined;
      if (command.text !== undefined) {
        if (!command.text) throw new Error("Cannot steer with an empty message");
        const enqueued = await options.intents.enqueue({
          intentId: options.createIntentId(),
          sessionId,
          text: command.text,
          // Explicit steering is still an ordinary turn if delivery fails. Promotion records the
          // attempted in-flight delivery without creating an undrainable steer-only queue item.
          mode: "turn",
          createdAt: now(),
        });
        steeringIntent = await options.intents.promoteNewestPendingToSteer({
          sessionId,
          targetTurnId: active.turnId,
          promotedAt: now(),
        });
        if (!steeringIntent || steeringIntent.intentId !== enqueued.intentId) {
          const restored = await options.intents.withdrawNewestPending({
            sessionId,
            withdrawnAt: now(),
          });
          return Object.freeze({
            effect: "idle" as const,
            ...(restored ? { restoredText: restored.text, intentId: restored.intentId } : {}),
            snapshot: await snapshot(sessionId, state),
          });
        }
      } else {
        steeringIntent = await options.intents.promoteNewestPendingToSteer({
          sessionId,
          targetTurnId: active.turnId,
          promotedAt: now(),
        });
        if (!steeringIntent)
          return Object.freeze({ effect: "idle" as const, snapshot: await snapshot(sessionId, state) });
      }
      try {
        await options.steer(sessionId, steeringIntent.text);
        const deliveredAt = now();
        await options.recordSteerDelivery({
          sessionId,
          intentId: steeringIntent.intentId,
          turnId: active.turnId,
          text: steeringIntent.text,
          deliveredAt,
        });
        const delivered = await options.intents.markDelivered({
          sessionId,
          intentId: steeringIntent.intentId,
          targetTurnId: active.turnId,
          deliveredAt,
        });
        if (!delivered) throw new Error(`Steer intent ${steeringIntent.intentId} was not delivered`);
      } catch (error) {
        await options.intents.releaseFailedDispatch({
          sessionId,
          intentId: steeringIntent.intentId,
          releasedAt: now(),
        });
        throw error;
      }
      const current = await snapshot(sessionId, state);
      notify(state, { type: "state", snapshot: current });
      return Object.freeze({
        effect: "steered" as const,
        intentId: steeringIntent.intentId,
        snapshot: current,
      });
    });
  };

  const close = (): void => {
    closed = true;
    for (const state of sessions.values()) {
      state.queuePaused = true;
      state.cancelScheduled?.();
      delete state.cancelScheduled;
      delete state.observer;
    }
    observedSessionId = undefined;
  };

  return Object.freeze({ inspect, dispatch, close });
}
