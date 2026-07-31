import type { UserIntentRecord } from "@noesis/workspace";
import { describe, expect, test } from "vitest";
import {
  createTurnInteractionController,
  type TurnInteractionControllerOptions,
  type TurnInteractionEvent,
  type TurnInteractionIntentStore,
} from "../src/index.ts";

const timestamp = (tick: number): string => `2026-07-31T00:00:${String(tick).padStart(2, "0")}.000Z`;

function createIntentStore(): TurnInteractionIntentStore & {
  readonly records: () => readonly UserIntentRecord[];
} {
  const records = new Map<string, UserIntentRecord>();
  const update = (record: UserIntentRecord): UserIntentRecord => {
    const frozen = Object.freeze(record);
    records.set(record.intentId, frozen);
    return frozen;
  };
  const pending = (sessionId: string): UserIntentRecord[] =>
    [...records.values()]
      .filter((record) => record.sessionId === sessionId && record.status === "pending")
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.intentId.localeCompare(right.intentId),
      );
  const store: TurnInteractionIntentStore & {
    readonly records: () => readonly UserIntentRecord[];
  } = {
    enqueue: async (request) =>
      update({
        intentId: request.intentId,
        sessionId: request.sessionId,
        text: request.text,
        contentDigest: `digest:${request.text}`,
        deliveryMode: "turn",
        status: "pending",
        queueSequence: records.size + 1,
        ...(request.queuedBehindTurnId ? { queuedBehindTurnId: request.queuedBehindTurnId } : {}),
        createdAt: request.createdAt,
        updatedAt: request.createdAt,
        attemptCount: 0,
      }),
    listPending: async (sessionId) => Object.freeze(pending(sessionId)),
    listUnresolved: async (sessionId) =>
      Object.freeze(
        [...records.values()].filter(
          (record) => record.sessionId === sessionId && record.status === "unresolved",
        ),
      ),
    claimOldestPending: async ({ sessionId, targetTurnId, claimedAt }) => {
      const current = pending(sessionId).find((record) => record.deliveryMode === "turn");
      return current
        ? update({
            ...current,
            status: "dispatching",
            targetTurnId,
            updatedAt: claimedAt,
            attemptCount: current.attemptCount + 1,
          })
        : undefined;
    },
    promoteNewestPendingToSteer: async ({ sessionId, targetTurnId, promotedAt }) => {
      const current = pending(sessionId)
        .filter((record) => record.deliveryMode === "turn")
        .at(-1);
      return current
        ? update({
            ...current,
            deliveryMode: "steer",
            status: "dispatching",
            targetTurnId,
            promotedAt,
            updatedAt: promotedAt,
            attemptCount: current.attemptCount + 1,
          })
        : undefined;
    },
    enqueueAndPromoteToSteer: async ({ sessionId, intentId, text, targetTurnId, createdAt, promotedAt }) => {
      const existing = records.get(intentId);
      if (existing) return existing;
      return update({
        intentId,
        sessionId,
        text,
        contentDigest: `digest:${text}`,
        deliveryMode: "steer",
        status: "dispatching",
        queueSequence: records.size + 1,
        queuedBehindTurnId: targetTurnId,
        targetTurnId,
        createdAt,
        promotedAt,
        updatedAt: promotedAt,
        attemptCount: 1,
      });
    },
    withdraw: async ({ sessionId, intentId, withdrawnAt }) => {
      const current = records.get(intentId);
      const withdrawable = current?.status === "pending" || current?.status === "unresolved";
      return current?.sessionId === sessionId && withdrawable
        ? update({
            ...current,
            deliveryMode: "turn",
            status: "withdrawn",
            withdrawnAt,
            updatedAt: withdrawnAt,
          })
        : undefined;
    },
    markDelivered: async ({ sessionId, intentId, targetTurnId, deliveredAt }) => {
      const current = records.get(intentId);
      return current?.sessionId === sessionId &&
        current.status === "dispatching" &&
        current.targetTurnId === targetTurnId
        ? update({
            ...current,
            status: "delivered",
            deliveredAt,
            updatedAt: deliveredAt,
          })
        : undefined;
    },
    releaseUnconsumedDispatch: async ({ sessionId, intentId, releasedAt }) => {
      const current = records.get(intentId);
      if (current?.sessionId !== sessionId || current.status !== "dispatching") return undefined;
      const { targetTurnId: _targetTurnId, promotedAt: _promotedAt, ...rest } = current;
      return update({
        ...rest,
        deliveryMode: "turn",
        status: "pending",
        updatedAt: releasedAt,
      });
    },
    withdrawUnconsumedSteerDispatch: async ({ sessionId, intentId, targetTurnId, withdrawnAt }) => {
      const current = records.get(intentId);
      if (
        current?.sessionId !== sessionId ||
        current.status !== "dispatching" ||
        current.deliveryMode !== "steer" ||
        current.targetTurnId !== targetTurnId
      )
        return undefined;
      const {
        targetTurnId: _targetTurnId,
        promotedAt: _promotedAt,
        unresolvedAt: _unresolvedAt,
        ...rest
      } = current;
      return update({
        ...rest,
        deliveryMode: "turn",
        status: "withdrawn",
        withdrawnAt,
        updatedAt: withdrawnAt,
      });
    },
    markUnresolved: async ({ sessionId, intentId, targetTurnId, unresolvedAt }) => {
      const current = records.get(intentId);
      return current?.sessionId === sessionId &&
        current.status === "dispatching" &&
        current.targetTurnId === targetTurnId
        ? update({
            ...current,
            status: "unresolved",
            unresolvedAt,
            updatedAt: unresolvedAt,
          })
        : undefined;
    },
    recoverDispatching: async ({ sessionId, recoveredAt }) => {
      let released = 0;
      for (const record of records.values()) {
        if (record.sessionId !== sessionId || record.status !== "dispatching") continue;
        if (record.deliveryMode === "steer") {
          update({ ...record, status: "unresolved", unresolvedAt: recoveredAt, updatedAt: recoveredAt });
        } else {
          const { targetTurnId: _targetTurnId, promotedAt: _promotedAt, ...rest } = record;
          update({ ...rest, deliveryMode: "turn", status: "pending", updatedAt: recoveredAt });
          released += 1;
        }
      }
      return Object.freeze({
        released,
        delivered: 0,
        unresolved: [...records.values()].filter(
          (record) => record.sessionId === sessionId && record.status === "unresolved",
        ).length,
      });
    },
    records: () => Object.freeze([...records.values()]),
  };
  return Object.freeze(store);
}

function createScheduler(): {
  readonly schedule: NonNullable<TurnInteractionControllerOptions["schedule"]>;
  readonly flushOne: () => void;
  readonly size: () => number;
} {
  const tasks: { task: () => void; cancelled: boolean }[] = [];
  return {
    schedule: (task) => {
      const scheduled = { task, cancelled: false };
      tasks.push(scheduled);
      return () => {
        scheduled.cancelled = true;
      };
    },
    flushOne: () => {
      const scheduled = tasks.shift();
      if (scheduled && !scheduled.cancelled) scheduled.task();
    },
    size: () => tasks.filter((task) => !task.cancelled).length,
  };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (await predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for interaction state");
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error),
  };
}

describe("TurnInteractionController", () => {
  test("returns after enqueue and keeps one replaceable observer for later background events", async () => {
    const intents = createIntentStore();
    const scheduler = createScheduler();
    const turn = deferred<{ readonly outcome: "completed" | "aborted" }>();
    const runRequests: string[] = [];
    const firstEvents: TurnInteractionEvent[] = [];
    const replacementEvents: TurnInteractionEvent[] = [];
    let id = 0;
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      schedule: scheduler.schedule,
      runTurn: async ({ text, onEvent, onReady }) => {
        onReady();
        runRequests.push(text);
        onEvent({ type: "status", status: "started" });
        return await turn.promise;
      },
      steer: async () => ({ status: "consumed" as const }),
      recordSteerDelivery: async (request) => {
        await intents.markDelivered({
          sessionId: request.sessionId,
          intentId: request.intentId,
          targetTurnId: request.turnId,
          deliveredAt: request.deliveredAt,
        });
      },
      interrupt: async () => undefined,
    });

    const queued = await controller.dispatch(
      "session-1",
      { type: "submit", text: "first" },
      { onEvent: (event) => firstEvents.push(event) },
    );
    const second = await controller.dispatch(
      "session-1",
      { type: "submit", text: "second" },
      { onEvent: (event) => replacementEvents.push(event) },
    );

    expect(queued.effect).toBe("queued");
    expect(second.effect).toBe("queued");
    expect(runRequests).toEqual([]);
    expect(firstEvents).toEqual([]);
    expect(replacementEvents).toEqual([]);
    expect(scheduler.size()).toBe(1);
    const firstCount = firstEvents.length;
    scheduler.flushOne();
    await waitUntil(() => runRequests.length === 1);
    expect(firstEvents).toHaveLength(firstCount);
    expect(
      replacementEvents.filter((event) => event.type === "agent" && event.event.type === "status"),
    ).toHaveLength(1);
    turn.resolve({ outcome: "completed" });
    await waitUntil(() => intents.records().some((record) => record.status === "delivered"));
    await controller.close();
  });

  test("drains FIFO as distinct ordinary turns and catches an enqueue at settlement", async () => {
    const intents = createIntentStore();
    const scheduler = createScheduler();
    const first = deferred<{ readonly outcome: "completed" | "aborted" }>();
    const requests: { text: string; turnId: string }[] = [];
    let id = 0;
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      schedule: scheduler.schedule,
      runTurn: async ({ text, turnId, onReady }) => {
        onReady();
        requests.push({ text, turnId });
        return requests.length === 1 ? await first.promise : { outcome: "completed" };
      },
      steer: async () => ({ status: "consumed" as const }),
      recordSteerDelivery: async (request) => {
        await intents.markDelivered({
          sessionId: request.sessionId,
          intentId: request.intentId,
          targetTurnId: request.turnId,
          deliveredAt: request.deliveredAt,
        });
      },
      interrupt: async () => undefined,
    });
    await controller.dispatch("session-1", { type: "submit", text: "one" });
    await controller.dispatch("session-1", { type: "submit", text: "two" });
    scheduler.flushOne();
    await waitUntil(() => requests.length === 1);
    await controller.dispatch("session-1", { type: "submit", text: "three" });
    first.resolve({ outcome: "completed" });
    await waitUntil(() => requests.length === 3);
    await waitUntil(() => intents.records().filter((record) => record.status === "delivered").length === 3);

    expect(requests.map((request) => request.text)).toEqual(["one", "two", "three"]);
    expect(new Set(requests.map((request) => request.turnId)).size).toBe(3);
    expect(intents.records().filter((record) => record.status === "delivered")).toHaveLength(3);
    await controller.close();
  });

  test.each([
    ["aborted", { outcome: "aborted" as const }],
    ["failed", new Error("model failed")],
  ])("stops draining and preserves the active plus remaining queue when a turn is %s", async (_, ending) => {
    const intents = createIntentStore();
    const scheduler = createScheduler();
    const requests: string[] = [];
    let id = 0;
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      schedule: scheduler.schedule,
      runTurn: async ({ text, onReady }) => {
        onReady();
        requests.push(text);
        if (ending instanceof Error) throw ending;
        return ending;
      },
      steer: async () => ({ status: "consumed" as const }),
      recordSteerDelivery: async (request) => {
        await intents.markDelivered({
          sessionId: request.sessionId,
          intentId: request.intentId,
          targetTurnId: request.turnId,
          deliveredAt: request.deliveredAt,
        });
      },
      interrupt: async () => undefined,
    });
    await controller.dispatch("session-1", { type: "submit", text: "one" });
    await controller.dispatch("session-1", { type: "submit", text: "two" });
    scheduler.flushOne();
    await waitUntil(async () => {
      const current = await controller.inspect("session-1");
      return current.queuePaused && current.pending.length === 2;
    });
    const current = await controller.inspect("session-1");

    expect(requests).toEqual(["one"]);
    expect(current.queuePaused).toBe(true);
    expect(current.pending.map((intent) => intent.text)).toEqual(["one", "two"]);
    await controller.close();
  });

  test("promotes the newest queued turn and restores an explicit failed steer without entering FIFO", async () => {
    const baseIntents = createIntentStore();
    const releaseUnconsumedDispatch = baseIntents.releaseUnconsumedDispatch;
    let releasedDispatches = 0;
    const intents: TurnInteractionIntentStore & {
      readonly records: () => readonly UserIntentRecord[];
    } = Object.freeze({
      ...baseIntents,
      releaseUnconsumedDispatch: async (
        request: Parameters<TurnInteractionIntentStore["releaseUnconsumedDispatch"]>[0],
      ) => {
        releasedDispatches += 1;
        return await releaseUnconsumedDispatch(request);
      },
    });
    const scheduler = createScheduler();
    const active = deferred<{ readonly outcome: "completed" | "aborted" }>();
    const steered: string[] = [];
    const recorded: { intentId: string; turnId: string; text: string }[] = [];
    let id = 0;
    let failSteer = false;
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      schedule: scheduler.schedule,
      runTurn: async ({ onReady }) => {
        onReady();
        return await active.promise;
      },
      steer: async (_sessionId, text) => {
        if (failSteer)
          return Object.freeze({ status: "not-consumed" as const, reason: "turn-ended" as const });
        steered.push(text);
        return Object.freeze({ status: "consumed" as const });
      },
      recordSteerDelivery: async ({ sessionId, intentId, turnId, text, deliveredAt }) => {
        recorded.push({ intentId, turnId, text });
        await intents.markDelivered({ sessionId, intentId, targetTurnId: turnId, deliveredAt });
      },
      interrupt: async () => undefined,
    });
    await controller.dispatch("session-1", { type: "submit", text: "active" });
    scheduler.flushOne();
    await waitUntil(async () => (await controller.inspect("session-1")).phase === "running");
    await controller.dispatch("session-1", { type: "submit", text: "older" });
    await controller.dispatch("session-1", { type: "submit", text: "newest" });

    const promoted = await controller.dispatch("session-1", { type: "steer" });
    expect(promoted.effect).toBe("steered");
    expect(steered).toEqual(["newest"]);
    expect(recorded).toEqual([
      {
        intentId: promoted.intentId,
        turnId: expect.stringMatching(/^turn-/u),
        text: "newest",
      },
    ]);
    expect((await controller.inspect("session-1")).pending.map((intent) => intent.text)).toEqual(["older"]);

    failSteer = true;
    await expect(
      controller.dispatch("session-1", { type: "steer", text: "explicit steer" }),
    ).resolves.toMatchObject({ effect: "restored", restoredText: "explicit steer" });
    expect(releasedDispatches).toBe(0);
    expect((await controller.inspect("session-1")).pending.map((intent) => intent.text)).toEqual(["older"]);
    active.resolve({ outcome: "aborted" });
    await waitUntil(async () => (await controller.inspect("session-1")).phase === "idle");
    await controller.close();
  });

  test("a submission racing aborted settlement unpauses and drains the preserved FIFO queue", async () => {
    const intents = createIntentStore();
    const scheduler = createScheduler();
    const first = deferred<{ readonly outcome: "completed" | "aborted" }>();
    const requests: string[] = [];
    let id = 0;
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      schedule: scheduler.schedule,
      runTurn: async ({ text, onReady }) => {
        onReady();
        requests.push(text);
        return requests.length === 1 ? await first.promise : { outcome: "completed" };
      },
      steer: async () => ({ status: "consumed" as const }),
      recordSteerDelivery: async (request) => {
        await intents.markDelivered({
          sessionId: request.sessionId,
          intentId: request.intentId,
          targetTurnId: request.turnId,
          deliveredAt: request.deliveredAt,
        });
      },
      interrupt: async () => undefined,
    });
    await controller.dispatch("session-1", { type: "submit", text: "active" });
    scheduler.flushOne();
    await waitUntil(() => requests.length === 1);

    await controller.dispatch("session-1", { type: "submit", text: "new submission" });
    first.resolve({ outcome: "aborted" });
    await waitUntil(() => scheduler.size() === 1);
    scheduler.flushOne();
    await waitUntil(() => requests.length === 3);

    expect(requests).toEqual(["active", "active", "new submission"]);
    expect((await controller.inspect("session-1")).pending).toEqual([]);
    await controller.close();
  });

  test("observes an interrupt requested before the agent becomes ready", async () => {
    const intents = createIntentStore();
    const scheduler = createScheduler();
    const releasePlanning = deferred<void>();
    let interrupted = false;
    let id = 0;
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      schedule: scheduler.schedule,
      runTurn: async ({ isInterruptRequested }) => {
        await releasePlanning.promise;
        interrupted = isInterruptRequested();
        return { outcome: interrupted ? "aborted" : "completed" };
      },
      steer: async () => ({ status: "consumed" as const }),
      recordSteerDelivery: async (request) => {
        await intents.markDelivered({
          sessionId: request.sessionId,
          intentId: request.intentId,
          targetTurnId: request.turnId,
          deliveredAt: request.deliveredAt,
        });
      },
      interrupt: async () => undefined,
    });
    await controller.dispatch("session-1", { type: "submit", text: "planning" });
    scheduler.flushOne();
    await waitUntil(async () => (await controller.inspect("session-1")).phase === "running");

    const interrupt = controller.dispatch("session-1", { type: "interrupt" });
    await waitUntil(async () => (await controller.inspect("session-1")).phase === "interrupting");
    releasePlanning.resolve();
    await interrupt;
    await waitUntil(async () => (await controller.inspect("session-1")).phase === "idle");

    expect(interrupted).toBe(true);
    expect((await controller.inspect("session-1")).queuePaused).toBe(true);
    await controller.close();
  });

  test("releases a claim which resolves after an interrupt without starting the turn", async () => {
    const baseIntents = createIntentStore();
    const scheduler = createScheduler();
    const claimStarted = deferred<void>();
    const allowClaim = deferred<void>();
    const claimOldestPending = baseIntents.claimOldestPending;
    const intents: TurnInteractionIntentStore & {
      readonly records: () => readonly UserIntentRecord[];
    } = Object.freeze({
      ...baseIntents,
      claimOldestPending: async (
        request: Parameters<TurnInteractionIntentStore["claimOldestPending"]>[0],
      ) => {
        claimStarted.resolve();
        await allowClaim.promise;
        return await claimOldestPending(request);
      },
    });
    const requests: string[] = [];
    let id = 0;
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      schedule: scheduler.schedule,
      runTurn: async ({ text }) => {
        requests.push(text);
        return { outcome: "completed" };
      },
      steer: async () => ({ status: "consumed" }),
      recordSteerDelivery: async () => undefined,
      interrupt: async () => undefined,
    });
    await controller.dispatch("session-1", { type: "submit", text: "cancel before install" });
    scheduler.flushOne();
    await claimStarted.promise;

    await expect(controller.dispatch("session-1", { type: "interrupt" })).resolves.toMatchObject({
      effect: "idle",
    });
    allowClaim.resolve();
    await waitUntil(() => intents.records().some((record) => record.status === "pending"));

    expect(requests).toEqual([]);
    await expect(controller.inspect("session-1")).resolves.toMatchObject({
      phase: "idle",
      queuePaused: true,
      pending: [expect.objectContaining({ text: "cancel before install" })],
    });
    await controller.close();
  });

  test("does not revive an interrupted claim when a later submission resumes the queue", async () => {
    const baseIntents = createIntentStore();
    const scheduler = createScheduler();
    const claimStarted = deferred<void>();
    const allowClaim = deferred<void>();
    const claimOldestPending = baseIntents.claimOldestPending;
    let claims = 0;
    const intents: TurnInteractionIntentStore & {
      readonly records: () => readonly UserIntentRecord[];
    } = Object.freeze({
      ...baseIntents,
      claimOldestPending: async (
        request: Parameters<TurnInteractionIntentStore["claimOldestPending"]>[0],
      ) => {
        claims += 1;
        if (claims === 1) {
          claimStarted.resolve();
          await allowClaim.promise;
        }
        return await claimOldestPending(request);
      },
    });
    const requests: string[] = [];
    let id = 0;
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      schedule: scheduler.schedule,
      runTurn: async ({ text, onReady }) => {
        onReady();
        requests.push(text);
        return { outcome: "completed" };
      },
      steer: async () => ({ status: "consumed" }),
      recordSteerDelivery: async () => undefined,
      interrupt: async () => undefined,
    });
    await controller.dispatch("session-1", { type: "submit", text: "first" });
    scheduler.flushOne();
    await claimStarted.promise;
    await controller.dispatch("session-1", { type: "interrupt" });
    await controller.dispatch("session-1", { type: "submit", text: "second" });

    allowClaim.resolve();
    await waitUntil(() => scheduler.size() === 1);
    expect(requests).toEqual([]);
    scheduler.flushOne();
    await waitUntil(() => requests.length === 2);

    expect(requests).toEqual(["first", "second"]);
    expect(claims).toBeGreaterThanOrEqual(3);
    await controller.close();
  });

  test("releases a claim which resolves during close without starting the turn", async () => {
    const baseIntents = createIntentStore();
    const scheduler = createScheduler();
    const claimStarted = deferred<void>();
    const allowClaim = deferred<void>();
    const claimOldestPending = baseIntents.claimOldestPending;
    const intents: TurnInteractionIntentStore & {
      readonly records: () => readonly UserIntentRecord[];
    } = Object.freeze({
      ...baseIntents,
      claimOldestPending: async (
        request: Parameters<TurnInteractionIntentStore["claimOldestPending"]>[0],
      ) => {
        claimStarted.resolve();
        await allowClaim.promise;
        return await claimOldestPending(request);
      },
    });
    const requests: string[] = [];
    let id = 0;
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      schedule: scheduler.schedule,
      runTurn: async ({ text }) => {
        requests.push(text);
        return { outcome: "completed" };
      },
      steer: async () => ({ status: "consumed" }),
      recordSteerDelivery: async () => undefined,
      interrupt: async () => undefined,
    });
    await controller.dispatch("session-1", { type: "submit", text: "close before install" });
    scheduler.flushOne();
    await claimStarted.promise;

    let didClose = false;
    const closing = controller.close().then(() => {
      didClose = true;
    });
    await Promise.resolve();
    expect(didClose).toBe(false);
    allowClaim.resolve();
    await closing;

    expect(requests).toEqual([]);
    expect(intents.records()).toEqual([
      expect.objectContaining({ text: "close before install", status: "pending" }),
    ]);
  });

  test("restores the newest exact multiline draft and leaves recovered startup work inert", async () => {
    const intents = createIntentStore();
    const scheduler = createScheduler();
    let id = 0;
    await intents.enqueue({
      intentId: "persisted",
      sessionId: "session-1",
      text: "persisted across restart",
      createdAt: timestamp(0),
    });
    const requests: string[] = [];
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      schedule: scheduler.schedule,
      runTurn: async ({ text, onReady }) => {
        onReady();
        requests.push(text);
        return { outcome: "completed" };
      },
      steer: async () => ({ status: "consumed" as const }),
      recordSteerDelivery: async (request) => {
        await intents.markDelivered({
          sessionId: request.sessionId,
          intentId: request.intentId,
          targetTurnId: request.turnId,
          deliveredAt: request.deliveredAt,
        });
      },
      interrupt: async () => undefined,
    });

    const initial = await controller.inspect("session-1");
    expect(initial.queuePaused).toBe(true);
    expect(initial.pending.map((intent) => intent.text)).toEqual(["persisted across restart"]);
    expect(scheduler.size()).toBe(0);
    await controller.dispatch("session-1", { type: "submit", text: "line one\n\nline three  " });
    const restored = await controller.dispatch("session-1", { type: "restore-newest" });
    expect(restored).toMatchObject({
      effect: "restored",
      restoredText: "line one\n\nline three  ",
    });
    expect(requests).toEqual([]);
    await controller.close();
  });

  test("restores explicit steering text when no turn is active without creating queued work", async () => {
    const intents = createIntentStore();
    let id = 0;
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      runTurn: async () => ({ outcome: "completed" }),
      steer: async () => ({ status: "not-consumed", reason: "not-running" }),
      recordSteerDelivery: async () => undefined,
      interrupt: async () => undefined,
    });

    await expect(
      controller.dispatch("session-1", { type: "steer", text: "keep this exact draft  " }),
    ).resolves.toMatchObject({
      effect: "idle",
      restoredText: "keep this exact draft  ",
    });
    expect(intents.records()).toEqual([]);
    await controller.close();
  });

  test("does not let an unacknowledged steer block interrupt and lets the user restore it", async () => {
    const intents = createIntentStore();
    const scheduler = createScheduler();
    const active = deferred<{ readonly outcome: "completed" | "aborted" }>();
    const steering = deferred<never>();
    let id = 0;
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      schedule: scheduler.schedule,
      runTurn: async ({ onReady }) => {
        onReady();
        return await active.promise;
      },
      steer: async () => await steering.promise,
      recordSteerDelivery: async () => undefined,
      interrupt: async () => {
        steering.reject(new Error("delivery outcome lost"));
        active.resolve({ outcome: "aborted" });
      },
    });
    await controller.dispatch("session-1", { type: "submit", text: "active" });
    scheduler.flushOne();
    await waitUntil(async () => (await controller.inspect("session-1")).phase === "running");

    const steer = controller.dispatch("session-1", { type: "steer", text: "uncertain steering" });
    await waitUntil(() =>
      intents.records().some((record) => record.deliveryMode === "steer" && record.status === "dispatching"),
    );
    await expect(controller.dispatch("session-1", { type: "interrupt" })).resolves.toMatchObject({
      effect: "interrupted",
    });
    await expect(steer).resolves.toMatchObject({ effect: "unresolved" });
    expect((await controller.inspect("session-1")).pending).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "uncertain steering", status: "unresolved" })]),
    );
    await expect(controller.dispatch("session-1", { type: "restore-newest" })).resolves.toMatchObject({
      effect: "restored",
      restoredText: "uncertain steering",
    });
    await controller.close();
  });

  test("keeps shutdown owned until an active turn has durably settled", async () => {
    const intents = createIntentStore();
    const scheduler = createScheduler();
    const active = deferred<{ readonly outcome: "completed" | "aborted" }>();
    let interruptCount = 0;
    let id = 0;
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      schedule: scheduler.schedule,
      runTurn: async ({ onReady }) => {
        onReady();
        return await active.promise;
      },
      steer: async () => ({ status: "consumed" }),
      recordSteerDelivery: async () => undefined,
      interrupt: async () => {
        interruptCount += 1;
      },
    });
    await controller.dispatch("session-1", { type: "submit", text: "active" });
    scheduler.flushOne();
    await waitUntil(async () => (await controller.inspect("session-1")).phase === "running");

    let closed = false;
    const closing = controller.close().then(() => {
      closed = true;
    });
    await waitUntil(() => interruptCount === 1);
    await Promise.resolve();
    expect(closed).toBe(false);
    active.resolve({ outcome: "aborted" });
    await closing;
    expect(closed).toBe(true);
    expect(intents.records().find((record) => record.text === "active")?.status).toBe("pending");
  });

  test("commits a consumed steer before the next queued turn starts", async () => {
    const intents = createIntentStore();
    const scheduler = createScheduler();
    const first = deferred<{ readonly outcome: "completed" | "aborted" }>();
    const allowSteerCommit = deferred<void>();
    const steerCommitStarted = deferred<void>();
    const requests: string[] = [];
    let id = 0;
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      schedule: scheduler.schedule,
      runTurn: async ({ text, onReady }) => {
        requests.push(text);
        onReady();
        return requests.length === 1 ? await first.promise : { outcome: "completed" };
      },
      steer: async () => ({ status: "consumed" }),
      recordSteerDelivery: async (request) => {
        steerCommitStarted.resolve();
        await allowSteerCommit.promise;
        await intents.markDelivered({
          sessionId: request.sessionId,
          intentId: request.intentId,
          targetTurnId: request.turnId,
          deliveredAt: request.deliveredAt,
        });
      },
      interrupt: async () => undefined,
    });
    await controller.dispatch("session-1", { type: "submit", text: "first" });
    scheduler.flushOne();
    await waitUntil(() => requests.length === 1);
    await controller.dispatch("session-1", { type: "submit", text: "second" });
    const steer = controller.dispatch("session-1", { type: "steer", text: "guide" });
    await steerCommitStarted.promise;
    first.resolve({ outcome: "completed" });
    await Promise.resolve();
    expect(requests).toEqual(["first"]);
    allowSteerCommit.resolve();
    await steer;
    await waitUntil(() => requests.length === 2);
    expect(requests).toEqual(["first", "second"]);
    await controller.close();
  });

  test.each([
    ["completed", { outcome: "completed" as const }],
    ["aborted", { outcome: "aborted" as const }],
    ["failed", new Error("turn failed")],
  ])("settles a consumed steer before emitting a %s terminal turn event", async (_, ending) => {
    const intents = createIntentStore();
    const scheduler = createScheduler();
    const turnEnding = deferred<void>();
    const allowSteerCommit = deferred<void>();
    const steerCommitStarted = deferred<void>();
    const events: TurnInteractionEvent[] = [];
    let id = 0;
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      schedule: scheduler.schedule,
      runTurn: async ({ onReady }) => {
        onReady();
        await turnEnding.promise;
        if (ending instanceof Error) throw ending;
        return ending;
      },
      steer: async () => ({ status: "consumed" }),
      recordSteerDelivery: async (request) => {
        steerCommitStarted.resolve();
        await allowSteerCommit.promise;
        await intents.markDelivered({
          sessionId: request.sessionId,
          intentId: request.intentId,
          targetTurnId: request.turnId,
          deliveredAt: request.deliveredAt,
        });
      },
      interrupt: async () => undefined,
    });
    await controller.dispatch(
      "session-1",
      { type: "submit", text: "active" },
      { onEvent: (event) => events.push(event) },
    );
    scheduler.flushOne();
    await waitUntil(async () => (await controller.inspect("session-1")).phase === "running");
    const steering = controller.dispatch("session-1", { type: "steer", text: "guide" });
    await steerCommitStarted.promise;

    turnEnding.resolve();
    await Promise.resolve();
    expect(events.some((event) => event.type === "turn-settled")).toBe(false);
    allowSteerCommit.resolve();
    await steering;
    await waitUntil(() => events.some((event) => event.type === "turn-settled"));

    const deliveredIndex = events.findIndex((event) => event.type === "steer-delivered");
    const settledIndex = events.findIndex((event) => event.type === "turn-settled");
    expect(deliveredIndex).toBeGreaterThanOrEqual(0);
    expect(settledIndex).toBeGreaterThan(deliveredIndex);
    await controller.close();
  });

  test("pauses the queue and reports failure when a steer cannot reach a durable terminal state", async () => {
    const baseIntents = createIntentStore();
    const intents: TurnInteractionIntentStore & {
      readonly records: () => readonly UserIntentRecord[];
    } = Object.freeze({
      ...baseIntents,
      markUnresolved: async () => {
        throw new Error("cannot persist unresolved steer");
      },
    });
    const scheduler = createScheduler();
    const active = deferred<{ readonly outcome: "completed" | "aborted" }>();
    const requests: string[] = [];
    const events: TurnInteractionEvent[] = [];
    let id = 0;
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      schedule: scheduler.schedule,
      runTurn: async ({ text, onReady }) => {
        requests.push(text);
        onReady();
        return requests.length === 1 ? await active.promise : { outcome: "completed" };
      },
      steer: async () => ({ status: "consumed" }),
      recordSteerDelivery: async () => {
        throw new Error("cannot persist steer message");
      },
      interrupt: async () => undefined,
    });
    await controller.dispatch(
      "session-1",
      { type: "submit", text: "active" },
      { onEvent: (event) => events.push(event) },
    );
    scheduler.flushOne();
    await waitUntil(() => requests.length === 1);
    await controller.dispatch("session-1", { type: "submit", text: "must stay queued" });

    await expect(controller.dispatch("session-1", { type: "steer", text: "ambiguous" })).rejects.toThrow(
      "cannot persist unresolved steer",
    );
    active.resolve({ outcome: "completed" });
    await waitUntil(() => events.some((event) => event.type === "turn-settled"));

    expect(requests).toEqual(["active"]);
    await expect(controller.inspect("session-1")).resolves.toMatchObject({
      queuePaused: true,
      phase: "idle",
    });
    expect(events.find((event) => event.type === "turn-settled")).toMatchObject({
      outcome: "failed",
      error: "cannot persist unresolved steer",
    });
    await controller.close();
  });
});
