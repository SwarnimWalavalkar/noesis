import type { AgentRuntimeEvent, AgentSteerResult, AgentThinkingLevel } from "@noesis/agent-types";
import type { UserIntentRecord } from "@noesis/workspace";

export type InteractionCommand =
  | { readonly type: "submit"; readonly text: string }
  | { readonly type: "steer"; readonly text?: string }
  | { readonly type: "restore-newest" }
  | { readonly type: "resume-queue" }
  | { readonly type: "pause-queue" }
  | { readonly type: "interrupt"; readonly turnId: string };

export interface InteractionPendingIntent {
  readonly intentId: string;
  readonly text: string;
  readonly mode: "turn" | "steer";
  readonly status: "pending" | "held" | "unresolved";
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
    }
  | {
      readonly type: "interaction-failed";
      readonly sessionId: string;
      readonly error: string;
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
  readonly listHeld: (sessionId: string) => Promise<readonly UserIntentRecord[]>;
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
  readonly enqueueAndPromoteToSteer: (request: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly text: string;
    readonly targetTurnId: string;
    readonly createdAt: string;
    readonly promotedAt: string;
  }) => Promise<UserIntentRecord | undefined>;
  readonly holdExplicitSteer: (request: {
    readonly intentId: string;
    readonly sessionId: string;
    readonly text: string;
    readonly targetTurnId: string;
    readonly createdAt: string;
    readonly heldAt: string;
  }) => Promise<UserIntentRecord | undefined>;
  readonly holdNewestPendingToSteer: (request: {
    readonly sessionId: string;
    readonly targetTurnId: string;
    readonly heldAt: string;
  }) => Promise<UserIntentRecord | undefined>;
  readonly activateHeldSteer: (request: {
    readonly sessionId: string;
    readonly intentId: string;
    readonly targetTurnId: string;
    readonly promotedAt: string;
  }) => Promise<UserIntentRecord | undefined>;
  readonly releaseHeldSteer: (request: {
    readonly sessionId: string;
    readonly intentId: string;
    readonly targetTurnId: string;
    readonly releasedAt: string;
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
  readonly withdrawUnconsumedSteerDispatch: (request: {
    readonly sessionId: string;
    readonly intentId: string;
    readonly targetTurnId: string;
    readonly withdrawnAt: string;
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
    readonly timelineSequence: number;
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
  drainFailure?: unknown;
  steerDeliveries: Set<Promise<InteractionDispatchResult>>;
  steerDeliveryTail: Promise<void>;
  steerReadiness?: TurnSteerReadiness;
  cancelScheduled?: () => void;
  wakeRequested: boolean;
  resumeGeneration: number;
  cancellationGeneration: number;
  interruptRequested: boolean;
  steerAdmissionTurnId?: string;
  steerableIntentId?: string;
}

interface TurnSteerReadiness {
  readonly turnId: string;
  readonly promise: Promise<boolean>;
  readonly settle: (ready: boolean) => void;
  settled: boolean;
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
    status:
      record.status === "unresolved"
        ? ("unresolved" as const)
        : record.status === "held"
          ? ("held" as const)
          : ("pending" as const),
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
      steerDeliveryTail: Promise.resolve(),
      wakeRequested: false,
      resumeGeneration: 0,
      cancellationGeneration: 0,
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
    const [pending, held, unresolved] = await Promise.all([
      options.intents.listPending(sessionId),
      options.intents.listHeld(sessionId),
      options.intents.listUnresolved(sessionId),
    ]);
    const available = [...pending, ...held, ...unresolved].sort(
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

  const createSteerReadiness = (turnId: string): TurnSteerReadiness => {
    let resolveReady: ((ready: boolean) => void) | undefined;
    const promise = new Promise<boolean>((resolve) => {
      resolveReady = resolve;
    });
    const readiness: TurnSteerReadiness = {
      turnId,
      promise,
      settled: false,
      settle: (ready) => {
        if (readiness.settled) return;
        readiness.settled = true;
        resolveReady?.(ready);
      },
    };
    return readiness;
  };

  const enqueueSteerDelivery = (
    state: SessionInteractionState,
    deliver: () => Promise<InteractionDispatchResult>,
  ): Promise<InteractionDispatchResult> => {
    const settlement = state.steerDeliveryTail.then(deliver);
    state.steerDeliveryTail = settlement.then(
      () => undefined,
      () => undefined,
    );
    state.steerDeliveries.add(settlement);
    return settlement;
  };

  const settleSteerDeliveries = async (state: SessionInteractionState): Promise<string | undefined> => {
    // Stop admitting new steers, then let any serialized command which already observed this turn
    // install its delivery settlement before taking the barrier snapshot.
    delete state.steerAdmissionTurnId;
    delete state.steerableIntentId;
    state.steerReadiness?.settle(false);
    await state.commandTail;
    const deliveries = [...state.steerDeliveries];
    const settlements = await Promise.allSettled(deliveries);
    for (const delivery of deliveries) state.steerDeliveries.delete(delivery);
    state.steerDeliveryTail = Promise.resolve();
    delete state.steerReadiness;
    const rejected = settlements.find(
      (settlement): settlement is PromiseRejectedResult => settlement.status === "rejected",
    );
    return rejected
      ? rejected.reason instanceof Error
        ? rejected.reason.message
        : String(rejected.reason)
      : undefined;
  };

  const settleFailedDispatch = async (
    sessionId: string,
    state: SessionInteractionState,
    active: InteractionActiveTurn,
    resumeGenerationAtStart: number,
    outcome: "aborted" | "failed",
    error?: string,
  ): Promise<void> => {
    const steerFailure = await settleSteerDeliveries(state);
    const released = await options.intents.releaseUnconsumedDispatch({
      sessionId,
      intentId: active.intentId,
      releasedAt: now(),
    });
    if (!released) {
      state.queuePaused = true;
      throw new Error(`Failed turn ${active.turnId} could not release its claimed intent`);
    }
    if (state.resumeGeneration === resumeGenerationAtStart || steerFailure) state.queuePaused = true;
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
      ...(error || steerFailure ? { error: [error, steerFailure].filter(Boolean).join("; ") } : {}),
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
      const cancellationGenerationAtClaim = state.cancellationGeneration;
      const claimed = await options.intents.claimOldestPending({
        sessionId,
        targetTurnId: turnId,
        claimedAt: now(),
      });
      if (!claimed) return;
      if (closed || state.queuePaused || state.cancellationGeneration !== cancellationGenerationAtClaim) {
        const released = await options.intents.releaseUnconsumedDispatch({
          sessionId,
          intentId: claimed.intentId,
          releasedAt: now(),
        });
        if (!released) throw new Error(`Cancelled claim ${claimed.intentId} could not be released`);
        if (!closed) await notifyState(sessionId, state);
        return;
      }
      const active = Object.freeze({
        intentId: claimed.intentId,
        turnId,
        text: intentText(claimed),
        mode: "turn" as const,
      });
      state.active = active;
      state.phase = "running";
      state.interruptRequested = false;
      state.steerAdmissionTurnId = turnId;
      delete state.steerableIntentId;
      const steerReadiness = createSteerReadiness(turnId);
      state.steerReadiness = steerReadiness;
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
            steerReadiness.settle(true);
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
        const steerFailure = await settleSteerDeliveries(state);
        const delivered = await options.intents.markDelivered({
          sessionId,
          intentId: active.intentId,
          targetTurnId: turnId,
          deliveredAt: now(),
        });
        if (!delivered) throw new Error(`Completed turn ${turnId} did not settle its claimed intent`);
        delete state.active;
        state.interruptRequested = false;
        state.phase = "idle";
        if (steerFailure) state.queuePaused = true;
        notify(state, {
          type: "turn-settled",
          sessionId,
          intentId: active.intentId,
          turnId,
          outcome: steerFailure ? "failed" : "completed",
          ...(steerFailure ? { error: steerFailure } : {}),
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
      const running = drain(sessionId, state, thinkingLevel).catch(async (error: unknown) => {
        state.queuePaused = true;
        const active = state.active;
        state.steerReadiness?.settle(false);
        await state.commandTail;
        await Promise.allSettled(state.steerDeliveries);
        state.steerDeliveries.clear();
        state.steerDeliveryTail = Promise.resolve();
        let recoveryFailure: unknown;
        try {
          await options.intents.recoverDispatching({ sessionId, recoveredAt: now() });
        } catch (recoveryError) {
          recoveryFailure = recoveryError;
        }
        delete state.active;
        delete state.steerAdmissionTurnId;
        delete state.steerableIntentId;
        delete state.steerReadiness;
        state.interruptRequested = false;
        state.phase = "idle";
        const failure =
          recoveryFailure === undefined
            ? error
            : new AggregateError([error, recoveryFailure], "Interaction drain and recovery failed");
        state.drainFailure = failure;
        const message = failure instanceof Error ? failure.message : String(failure);
        if (active)
          notify(state, {
            type: "turn-settled",
            sessionId,
            intentId: active.intentId,
            turnId: active.turnId,
            outcome: "failed",
            error: message,
          });
        else notify(state, { type: "interaction-failed", sessionId, error: message });
        try {
          await notifyState(sessionId, state);
        } catch {
          // The original failure remains owned and visible to shutdown even if the read model is unavailable.
        }
      });
      state.drain = running;
      const finish = (): void => {
        delete state.drain;
        if (state.wakeRequested && !state.queuePaused) scheduleDrain(sessionId, state, thinkingLevel);
      };
      void running.then(finish, finish);
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
        delete state.drainFailure;
        state.resumeGeneration += 1;
        const current = await snapshot(sessionId, state);
        scheduleDrain(sessionId, state, dispatchOptions.thinkingLevel);
        return Object.freeze({
          result: Object.freeze({ effect: "queued" as const, intentId: intent.intentId, snapshot: current }),
        });
      }
      if (command.type === "resume-queue") {
        state.queuePaused = false;
        delete state.drainFailure;
        state.resumeGeneration += 1;
        const current = await snapshot(sessionId, state);
        notify(state, { type: "state", snapshot: current });
        scheduleDrain(sessionId, state, dispatchOptions.thinkingLevel);
        return Object.freeze({ result: Object.freeze({ effect: "resumed" as const, snapshot: current }) });
      }
      if (command.type === "pause-queue") {
        state.queuePaused = true;
        state.cancellationGeneration += 1;
        state.cancelScheduled?.();
        delete state.cancelScheduled;
        const current = await snapshot(sessionId, state);
        notify(state, { type: "state", snapshot: current });
        return Object.freeze({ result: Object.freeze({ effect: "idle" as const, snapshot: current }) });
      }
      if (command.type === "restore-newest") {
        const available = (await snapshot(sessionId, state)).pending;
        const newest = available.at(-1);
        let restored: UserIntentRecord | undefined;
        if (newest?.status === "held" && state.active) {
          const released = await options.intents.releaseHeldSteer({
            sessionId,
            intentId: newest.intentId,
            targetTurnId: state.active.turnId,
            releasedAt: now(),
          });
          restored =
            released?.status === "pending"
              ? await options.intents.withdraw({
                  sessionId,
                  intentId: released.intentId,
                  withdrawnAt: now(),
                })
              : released?.status === "withdrawn"
                ? released
                : undefined;
        } else if (newest) {
          restored = await options.intents.withdraw({
            sessionId,
            intentId: newest.intentId,
            withdrawnAt: now(),
          });
        }
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
        if (!command.turnId) throw new Error("Interrupt requires a visible active turn identity");
        state.queuePaused = true;
        state.cancellationGeneration += 1;
        state.cancelScheduled?.();
        delete state.cancelScheduled;
        const active = state.active;
        if (!active || command.turnId !== active.turnId) {
          const current = await snapshot(sessionId, state);
          notify(state, { type: "state", snapshot: current });
          return Object.freeze({ result: Object.freeze({ effect: "idle" as const, snapshot: current }) });
        }
        state.interruptRequested = true;
        state.phase = "interrupting";
        await notifyState(sessionId, state);
        await options.interrupt(sessionId);
        const settlement = (async (): Promise<InteractionDispatchResult> => {
          if (state.drain) await state.drain;
          return Object.freeze({
            effect: "interrupted" as const,
            intentId: active.intentId,
            snapshot: await snapshot(sessionId, state),
          });
        })();
        return Object.freeze({
          settlement,
        });
      }

      const active =
        state.phase === "running" && state.steerAdmissionTurnId === state.active?.turnId
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
      const ready = state.steerableIntentId === active.intentId;
      const readiness = state.steerReadiness;
      const held = !ready;
      if (command.text !== undefined) {
        if (!command.text) throw new Error("Cannot steer with an empty message");
        const createdAt = now();
        steeringIntent = ready
          ? await options.intents.enqueueAndPromoteToSteer({
              intentId: options.createIntentId(),
              sessionId,
              text: command.text,
              targetTurnId: active.turnId,
              createdAt,
              promotedAt: now(),
            })
          : await options.intents.holdExplicitSteer({
              intentId: options.createIntentId(),
              sessionId,
              text: command.text,
              targetTurnId: active.turnId,
              createdAt,
              heldAt: now(),
            });
        if (!steeringIntent) {
          return Object.freeze({
            result: Object.freeze({
              effect: "idle" as const,
              restoredText: command.text,
              snapshot: await snapshot(sessionId, state),
            }),
          });
        }
      } else {
        steeringIntent = ready
          ? await options.intents.promoteNewestPendingToSteer({
              sessionId,
              targetTurnId: active.turnId,
              promotedAt: now(),
            })
          : await options.intents.holdNewestPendingToSteer({
              sessionId,
              targetTurnId: active.turnId,
              heldAt: now(),
            });
        if (!steeringIntent)
          return Object.freeze({
            result: Object.freeze({ effect: "idle" as const, snapshot: await snapshot(sessionId, state) }),
          });
      }
      const heldIntent = steeringIntent;
      const settlement = enqueueSteerDelivery(state, async (): Promise<InteractionDispatchResult> => {
        let intent: UserIntentRecord | undefined = heldIntent;
        if (held) {
          const becameReady = readiness?.turnId === active.turnId ? await readiness.promise : false;
          intent = becameReady
            ? await options.intents.activateHeldSteer({
                sessionId,
                intentId: heldIntent.intentId,
                targetTurnId: active.turnId,
                promotedAt: now(),
              })
            : undefined;
          if (!intent) {
            const released = await options.intents.releaseHeldSteer({
              sessionId,
              intentId: heldIntent.intentId,
              targetTurnId: active.turnId,
              releasedAt: now(),
            });
            const current = await snapshot(sessionId, state);
            notify(state, { type: "state", snapshot: current });
            if (!released) return Object.freeze({ effect: "idle" as const, snapshot: current });
            return explicit
              ? Object.freeze({
                  effect: "restored" as const,
                  intentId: released.intentId,
                  restoredText: intentText(released),
                  snapshot: current,
                })
              : Object.freeze({ effect: "queued" as const, intentId: released.intentId, snapshot: current });
          }
        }
        const text = intentText(intent);
        let receipt: AgentSteerResult;
        try {
          receipt = await options.steer(sessionId, text);
        } catch {
          const unresolved = await options.intents.markUnresolved({
            sessionId,
            intentId: intent.intentId,
            targetTurnId: active.turnId,
            unresolvedAt: now(),
          });
          if (!unresolved) throw new Error(`Steer ${intent.intentId} could not be durably marked unresolved`);
          const current = await snapshot(sessionId, state);
          notify(state, { type: "state", snapshot: current });
          return Object.freeze({ effect: "unresolved", intentId: intent.intentId, snapshot: current });
        }
        if (receipt.status === "not-consumed") {
          if (explicit) {
            const restored = await options.intents.withdrawUnconsumedSteerDispatch({
              sessionId,
              intentId: intent.intentId,
              targetTurnId: active.turnId,
              withdrawnAt: now(),
            });
            if (!restored)
              throw new Error(`Unconsumed explicit steer ${intent.intentId} could not be withdrawn`);
            const current = await snapshot(sessionId, state);
            notify(state, { type: "state", snapshot: current });
            return Object.freeze({
              effect: "restored" as const,
              intentId: intent.intentId,
              restoredText: intentText(restored),
              snapshot: current,
            });
          }
          const released = await options.intents.releaseUnconsumedDispatch({
            sessionId,
            intentId: intent.intentId,
            releasedAt: now(),
          });
          if (!released) throw new Error(`Unconsumed steer ${intent.intentId} could not be released`);
          const current = await snapshot(sessionId, state);
          notify(state, { type: "state", snapshot: current });
          return Object.freeze({ effect: "queued", intentId: intent.intentId, snapshot: current });
        }
        const deliveredAt = receipt.consumedAt;
        try {
          await options.recordSteerDelivery({
            sessionId,
            intentId: intent.intentId,
            turnId: active.turnId,
            text,
            timelineSequence: receipt.timelineSequence,
            deliveredAt,
          });
        } catch {
          const unresolved = await options.intents.markUnresolved({
            sessionId,
            intentId: intent.intentId,
            targetTurnId: active.turnId,
            unresolvedAt: now(),
          });
          if (!unresolved) throw new Error(`Steer ${intent.intentId} could not be durably marked unresolved`);
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
      });
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
        state.cancellationGeneration += 1;
        state.cancelScheduled?.();
        delete state.cancelScheduled;
        if (state.active) state.phase = "interrupting";
        state.interruptRequested = true;
        state.steerReadiness?.settle(false);
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
        interruptFailures[0] ??
        settlements.find((settlement) => settlement.status === "rejected")?.reason ??
        [...sessions.values()].find((state) => state.drainFailure !== undefined)?.drainFailure;
      if (failure !== undefined) throw failure;
    })();
    return closePromise;
  };

  return Object.freeze({ inspect, dispatch, close });
}
