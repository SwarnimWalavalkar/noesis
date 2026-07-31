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
        initialMode: request.mode,
        deliveryMode: request.mode,
        status: "pending",
        queueSequence: records.size + 1,
        ...(request.queuedBehindTurnId ? { queuedBehindTurnId: request.queuedBehindTurnId } : {}),
        createdAt: request.createdAt,
        updatedAt: request.createdAt,
        attemptCount: 0,
      }),
    listPending: async (sessionId) => Object.freeze(pending(sessionId)),
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
    withdrawNewestPending: async ({ sessionId, withdrawnAt }) => {
      const current = pending(sessionId).at(-1);
      return current
        ? update({
            ...current,
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
    releaseFailedDispatch: async ({ sessionId, intentId, releasedAt }) => {
      const current = records.get(intentId);
      if (current?.sessionId !== sessionId || current.status !== "dispatching") return undefined;
      const { targetTurnId: _targetTurnId, promotedAt: _promotedAt, ...rest } = current;
      return update({
        ...rest,
        deliveryMode: current.initialMode,
        status: "pending",
        updatedAt: releasedAt,
      });
    },
    recoverDispatching: async ({ sessionId, recoveredAt }) => {
      let released = 0;
      for (const record of records.values()) {
        if (record.sessionId !== sessionId || record.status !== "dispatching") continue;
        const { targetTurnId: _targetTurnId, promotedAt: _promotedAt, ...rest } = record;
        update({
          ...rest,
          deliveryMode: record.initialMode,
          status: "pending",
          updatedAt: recoveredAt,
        });
        released += 1;
      }
      return Object.freeze({ released, delivered: 0, unresolved: 0 });
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
      steer: async () => undefined,
      recordSteerDelivery: async () => undefined,
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
    controller.close();
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
      steer: async () => undefined,
      recordSteerDelivery: async () => undefined,
      interrupt: async () => undefined,
    });
    await controller.dispatch("session-1", { type: "submit", text: "one" });
    await controller.dispatch("session-1", { type: "submit", text: "two" });
    scheduler.flushOne();
    await waitUntil(() => requests.length === 1);
    await controller.dispatch("session-1", { type: "submit", text: "three" });
    first.resolve({ outcome: "completed" });
    await waitUntil(() => requests.length === 3);

    expect(requests.map((request) => request.text)).toEqual(["one", "two", "three"]);
    expect(new Set(requests.map((request) => request.turnId)).size).toBe(3);
    expect(intents.records().filter((record) => record.status === "delivered")).toHaveLength(3);
    controller.close();
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
      steer: async () => undefined,
      recordSteerDelivery: async () => undefined,
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
    controller.close();
  });

  test("promotes the newest queued turn to steer and restores failed steering to FIFO", async () => {
    const intents = createIntentStore();
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
        if (failSteer) throw new Error("steer failed");
        steered.push(text);
      },
      recordSteerDelivery: async ({ intentId, turnId, text }) => {
        recorded.push({ intentId, turnId, text });
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
    await expect(controller.dispatch("session-1", { type: "steer", text: "explicit steer" })).rejects.toThrow(
      "steer failed",
    );
    expect((await controller.inspect("session-1")).pending.map((intent) => intent.text)).toEqual([
      "older",
      "explicit steer",
    ]);
    active.resolve({ outcome: "aborted" });
    await waitUntil(async () => (await controller.inspect("session-1")).phase === "idle");
    controller.close();
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
      steer: async () => undefined,
      recordSteerDelivery: async () => undefined,
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
    controller.close();
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
      steer: async () => undefined,
      recordSteerDelivery: async () => undefined,
      interrupt: async () => undefined,
    });
    await controller.dispatch("session-1", { type: "submit", text: "planning" });
    scheduler.flushOne();
    await waitUntil(async () => (await controller.inspect("session-1")).phase === "running");

    await controller.dispatch("session-1", { type: "interrupt" });
    releasePlanning.resolve();
    await waitUntil(async () => (await controller.inspect("session-1")).phase === "idle");

    expect(interrupted).toBe(true);
    expect((await controller.inspect("session-1")).queuePaused).toBe(true);
    controller.close();
  });

  test("restores the newest exact multiline draft and leaves recovered startup work inert", async () => {
    const intents = createIntentStore();
    const scheduler = createScheduler();
    let id = 0;
    await intents.enqueue({
      intentId: "persisted",
      sessionId: "session-1",
      text: "persisted across restart",
      mode: "turn",
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
      steer: async () => undefined,
      recordSteerDelivery: async () => undefined,
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
    controller.close();
  });
});
