import { createConditionalObject } from "@noesis/domain";
import type { AgentSteerResult } from "@noesis/agent-types";
import type { UserIntentRecord } from "@noesis/workspace";
import { describe, expect, test } from "vitest";
import {
  createTurnInteractionController,
  type TurnInteractionControllerOptions,
  type TurnInteractionEvent,
  type TurnInteractionIntentStore,
} from "../src/index.ts";
const timestamp = (tick: number): string => `2026-07-31T00:00:${String(tick).padStart(2, "0")}.000Z`;
const consumedSteer = (): AgentSteerResult =>
  Object.freeze({ status: "consumed", timelineSequence: 1, consumedAt: timestamp(59) });
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
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  const store: TurnInteractionIntentStore & {
    readonly records: () => readonly UserIntentRecord[];
  } = {
    enqueue: async (request) =>
      update(
        createConditionalObject({
          intentId: request.intentId,
          sessionId: request.sessionId,
          text: request.text,
          contentDigest: `digest:${request.text}`,
          deliveryMode: "turn",
          status: "pending",
          queueSequence: records.size + 1,
        } as const)
          .addOptional(
            request.queuedBehindTurnId ? { queuedBehindTurnId: request.queuedBehindTurnId } : undefined,
          )
          .add({
            createdAt: request.createdAt,
            updatedAt: request.createdAt,
            attemptCount: 0,
          } as const)
          .finish(),
      ),
    reroutePending: async ({ sourceSessionId, destinationSessionId, intents, reroutedAt }) => {
      const rerouted: UserIntentRecord[] = [];
      for (const { sourceIntentId, destinationIntentId } of intents) {
        const source = records.get(sourceIntentId);
        if (source?.sessionId !== sourceSessionId || source.status !== "pending" || source.text === undefined)
          throw new Error(`Source intent ${sourceIntentId} is not pending`);
        update({ ...source, status: "withdrawn", withdrawnAt: reroutedAt, updatedAt: reroutedAt });
        rerouted.push(
          update({
            ...source,
            intentId: destinationIntentId,
            sessionId: destinationSessionId,
            status: "pending",
            queueSequence: records.size + 1,
            updatedAt: reroutedAt,
          }),
        );
      }
      return Object.freeze(rerouted);
    },
    listPending: async (sessionId) => Object.freeze(pending(sessionId)),
    listHeld: async (sessionId) =>
      Object.freeze(
        [...records.values()].filter((record) => record.sessionId === sessionId && record.status === "held"),
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
    holdExplicitSteer: async ({ sessionId, intentId, text, targetTurnId, createdAt, heldAt }) =>
      update({
        intentId,
        sessionId,
        text,
        contentDigest: `digest:${text}`,
        deliveryMode: "steer",
        status: "held",
        queueSequence: records.size + 1,
        queuedBehindTurnId: targetTurnId,
        targetTurnId,
        createdAt,
        heldAt,
        updatedAt: heldAt,
        steerOrigin: "explicit",
        attemptCount: 0,
      }),
    holdNewestPendingToSteer: async ({ sessionId, targetTurnId, heldAt }) => {
      const current = pending(sessionId)
        .filter((record) => record.deliveryMode === "turn")
        .at(-1);
      return current
        ? update({
            ...current,
            deliveryMode: "steer",
            status: "held",
            targetTurnId,
            heldAt,
            updatedAt: heldAt,
            steerOrigin: "queued",
          })
        : undefined;
    },
    activateHeldSteer: async ({ sessionId, intentId, targetTurnId, promotedAt }) => {
      const current = records.get(intentId);
      return current?.sessionId === sessionId &&
        current.status === "held" &&
        current.targetTurnId === targetTurnId
        ? update({
            ...current,
            status: "dispatching",
            promotedAt,
            updatedAt: promotedAt,
            attemptCount: current.attemptCount + 1,
          })
        : undefined;
    },
    releaseHeldSteer: async ({ sessionId, intentId, targetTurnId, releasedAt }) => {
      const current = records.get(intentId);
      if (
        current?.sessionId !== sessionId ||
        current.status !== "held" ||
        current.targetTurnId !== targetTurnId
      )
        return undefined;
      const { targetTurnId: _targetTurnId, heldAt: _heldAt, steerOrigin: _steerOrigin, ...rest } = current;
      return current.steerOrigin === "queued"
        ? update({
            ...rest,
            deliveryMode: "turn",
            status: "pending",
            updatedAt: releasedAt,
          })
        : update({
            ...rest,
            deliveryMode: "turn",
            status: "withdrawn",
            withdrawnAt: releasedAt,
            updatedAt: releasedAt,
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
  const tasks: {
    task: () => void;
    cancelled: boolean;
  }[] = [];
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
  readonly reject: (cause: unknown) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((cause: unknown) => void) | undefined;
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
  test("durably enqueues without resuming delivery until the existing queue is released", async () => {
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
        return { outcome: "completed" };
      },
      steer: async () => consumedSteer(),
      recordSteerDelivery: async () => undefined,
      interrupt: async () => undefined,
    });
    await controller.dispatch("session-1", { type: "enqueue", text: "first" });
    await controller.dispatch("session-1", { type: "enqueue", text: "second" });
    expect(scheduler.size()).toBe(0);
    await expect(controller.inspect("session-1")).resolves.toMatchObject({
      queuePaused: true,
      pending: [{ text: "first" }, { text: "second" }],
    });
    await controller.dispatch("session-1", { type: "resume-queue" });
    expect(scheduler.size()).toBe(1);
    scheduler.flushOne();
    await waitUntil(() => requests.length === 2);
    expect(requests).toEqual(["first", "second"]);
    await controller.close();
  });
  test("atomically reroutes exact queued intents into a destination without starting delivery", async () => {
    const intents = createIntentStore();
    let id = 0;
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      runTurn: async ({ onReady }) => {
        onReady();
        return { outcome: "completed" };
      },
      steer: async () => consumedSteer(),
      recordSteerDelivery: async () => undefined,
      interrupt: async () => undefined,
    });
    const first = await controller.dispatch("source", { type: "enqueue", text: "first" });
    const second = await controller.dispatch("source", { type: "enqueue", text: "second" });
    if (!first.intentId || !second.intentId) throw new Error("Expected durable intent identities");
    await expect(
      controller.dispatch("destination", {
        type: "reroute-pending",
        sourceSessionId: "source",
        intentIds: [first.intentId, second.intentId],
      }),
    ).resolves.toMatchObject({
      effect: "rerouted",
      snapshot: {
        sessionId: "destination",
        queuePaused: true,
        pending: [{ text: "first" }, { text: "second" }],
      },
    });
    await expect(controller.inspect("source")).resolves.toMatchObject({ pending: [] });
    expect(
      intents
        .records()
        .filter((record) => record.sessionId === "source")
        .map((record) => record.status),
    ).toEqual(["withdrawn", "withdrawn"]);
    await controller.close();
  });
  test("returns after enqueue and keeps one replaceable observer for later background events", async () => {
    const intents = createIntentStore();
    const scheduler = createScheduler();
    const turn = deferred<{
      readonly outcome: "completed" | "aborted";
    }>();
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
      steer: async () => consumedSteer(),
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
    const first = deferred<{
      readonly outcome: "completed" | "aborted";
    }>();
    const requests: {
      text: string;
      turnId: string;
    }[] = [];
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
      steer: async () => consumedSteer(),
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
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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
      steer: async () => consumedSteer(),
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
    const active = deferred<{
      readonly outcome: "completed" | "aborted";
    }>();
    const steered: string[] = [];
    const recorded: {
      intentId: string;
      turnId: string;
      text: string;
    }[] = [];
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
          // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
          return Object.freeze({ status: "not-consumed" as const, reason: "turn-ended" as const });
        steered.push(text);
        return consumedSteer();
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
    const first = deferred<{
      readonly outcome: "completed" | "aborted";
    }>();
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
      steer: async () => consumedSteer(),
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
      steer: async () => consumedSteer(),
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
    const visibleTurnId = (await controller.inspect("session-1")).active?.turnId;
    if (!visibleTurnId) throw new Error("Expected an active turn");
    const interrupt = controller.dispatch("session-1", { type: "interrupt", turnId: visibleTurnId });
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
      steer: async () => consumedSteer(),
      recordSteerDelivery: async () => undefined,
      interrupt: async () => undefined,
    });
    await controller.dispatch("session-1", { type: "submit", text: "cancel before install" });
    scheduler.flushOne();
    await claimStarted.promise;
    await expect(controller.dispatch("session-1", { type: "pause-queue" })).resolves.toMatchObject({
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
      steer: async () => consumedSteer(),
      recordSteerDelivery: async () => undefined,
      interrupt: async () => undefined,
    });
    await controller.dispatch("session-1", { type: "submit", text: "first" });
    scheduler.flushOne();
    await claimStarted.promise;
    await controller.dispatch("session-1", { type: "pause-queue" });
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
      steer: async () => consumedSteer(),
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
      steer: async () => consumedSteer(),
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
  test("restores a pre-ready explicit steer when its durable target can no longer be bound", async () => {
    const baseIntents = createIntentStore();
    const intents: TurnInteractionIntentStore & {
      readonly records: () => readonly UserIntentRecord[];
    } = Object.freeze({
      ...baseIntents,
      holdExplicitSteer: async () => undefined,
    });
    const scheduler = createScheduler();
    const active = deferred<{
      readonly outcome: "completed" | "aborted";
    }>();
    const runEntered = deferred<void>();
    let id = 0;
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      schedule: scheduler.schedule,
      runTurn: async () => {
        runEntered.resolve();
        return await active.promise;
      },
      steer: async () => consumedSteer(),
      recordSteerDelivery: async () => undefined,
      interrupt: async () => undefined,
    });
    await controller.dispatch("session-1", { type: "submit", text: "active" });
    scheduler.flushOne();
    await runEntered.promise;
    await expect(
      controller.dispatch("session-1", { type: "steer", text: "keep this in the editor" }),
    ).resolves.toMatchObject({
      effect: "idle",
      restoredText: "keep this in the editor",
    });
    expect(intents.records()).toHaveLength(1);
    expect(intents.records()[0]).toMatchObject({ text: "active", status: "dispatching" });
    active.resolve({ outcome: "aborted" });
    await waitUntil(async () => (await controller.inspect("session-1")).phase === "idle");
    await controller.close();
  });
  test("does not present an unacknowledged steer as queued after interrupt", async () => {
    const intents = createIntentStore();
    const scheduler = createScheduler();
    const active = deferred<{
      readonly outcome: "completed" | "aborted";
    }>();
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
    const visibleTurnId = (await controller.inspect("session-1")).active?.turnId;
    if (!visibleTurnId) throw new Error("Expected an active turn");
    const steer = controller.dispatch("session-1", { type: "steer", text: "uncertain steering" });
    await waitUntil(() =>
      intents.records().some((record) => record.deliveryMode === "steer" && record.status === "dispatching"),
    );
    await expect(
      controller.dispatch("session-1", { type: "interrupt", turnId: visibleTurnId }),
    ).resolves.toMatchObject({
      effect: "interrupted",
    });
    await expect(steer).resolves.toMatchObject({ effect: "unresolved" });
    expect((await controller.inspect("session-1")).pending).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "uncertain steering" })]),
    );
    expect(intents.records()).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "uncertain steering", status: "unresolved" })]),
    );
    await controller.close();
  });
  test("keeps shutdown owned until an active turn has durably settled", async () => {
    const intents = createIntentStore();
    const scheduler = createScheduler();
    const active = deferred<{
      readonly outcome: "completed" | "aborted";
    }>();
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
      steer: async () => consumedSteer(),
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
    const first = deferred<{
      readonly outcome: "completed" | "aborted";
    }>();
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
      steer: async () => consumedSteer(),
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
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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
      steer: async () => consumedSteer(),
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
    const active = deferred<{
      readonly outcome: "completed" | "aborted";
    }>();
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
      steer: async () => consumedSteer(),
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
  test("holds pre-ready steers durably and delivers them in command order once the turn is ready", async () => {
    const intents = createIntentStore();
    const scheduler = createScheduler();
    const active = deferred<{
      readonly outcome: "completed" | "aborted";
    }>();
    const runEntered = deferred<void>();
    const delivered: string[] = [];
    let signalReady: (() => void) | undefined;
    let id = 0;
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      schedule: scheduler.schedule,
      runTurn: async ({ onReady }) => {
        signalReady = onReady;
        runEntered.resolve();
        return await active.promise;
      },
      steer: async (_sessionId, text) => {
        delivered.push(text);
        return consumedSteer();
      },
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
    await runEntered.promise;
    await controller.dispatch("session-1", { type: "submit", text: "queued steer" });
    const explicit = controller.dispatch("session-1", { type: "steer", text: "explicit steer" });
    const promoted = controller.dispatch("session-1", { type: "steer" });
    await waitUntil(async () => {
      const snapshot = await controller.inspect("session-1");
      return snapshot.pending.filter((intent) => intent.status === "held").length === 2;
    });
    expect(delivered).toEqual([]);
    signalReady?.();
    await expect(Promise.all([explicit, promoted])).resolves.toEqual([
      expect.objectContaining({ effect: "steered" }),
      expect.objectContaining({ effect: "steered" }),
    ]);
    expect(delivered).toEqual(["explicit steer", "queued steer"]);
    active.resolve({ outcome: "completed" });
    await waitUntil(async () => (await controller.inspect("session-1")).phase === "idle");
    await controller.close();
  });
  test("releases held steers without loss when a turn settles before becoming steerable", async () => {
    const intents = createIntentStore();
    const scheduler = createScheduler();
    const active = deferred<{
      readonly outcome: "completed" | "aborted";
    }>();
    const runEntered = deferred<void>();
    const delivered: string[] = [];
    let id = 0;
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      schedule: scheduler.schedule,
      runTurn: async () => {
        runEntered.resolve();
        return await active.promise;
      },
      steer: async (_sessionId, text) => {
        delivered.push(text);
        return consumedSteer();
      },
      recordSteerDelivery: async () => undefined,
      interrupt: async () => undefined,
    });
    await controller.dispatch("session-1", { type: "submit", text: "active" });
    scheduler.flushOne();
    await runEntered.promise;
    await controller.dispatch("session-1", { type: "submit", text: "queued steer" });
    const explicit = controller.dispatch("session-1", { type: "steer", text: "explicit steer" });
    const promoted = controller.dispatch("session-1", { type: "steer" });
    await waitUntil(async () => {
      const held = (await controller.inspect("session-1")).pending.filter(
        (intent) => intent.status === "held",
      );
      return held.length === 2;
    });
    active.resolve({ outcome: "completed" });
    await expect(explicit).resolves.toMatchObject({
      effect: "restored",
      restoredText: "explicit steer",
    });
    await expect(promoted).resolves.toMatchObject({ effect: "queued" });
    await waitUntil(async () => (await controller.inspect("session-1")).phase === "idle");
    expect(delivered).toEqual([]);
    expect(intents.records()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "explicit steer", status: "withdrawn" }),
        expect.objectContaining({ text: "queued steer", status: "delivered" }),
      ]),
    );
    await controller.close();
  });
  test("returns conversational steer results when an authoritative target can no longer be bound", async () => {
    const baseIntents = createIntentStore();
    const intents: TurnInteractionIntentStore & {
      readonly records: () => readonly UserIntentRecord[];
    } = Object.freeze({
      ...baseIntents,
      enqueueAndPromoteToSteer: async () => undefined,
      promoteNewestPendingToSteer: async () => undefined,
    });
    const scheduler = createScheduler();
    const active = deferred<{
      readonly outcome: "completed" | "aborted";
    }>();
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
      steer: async () => consumedSteer(),
      recordSteerDelivery: async () => undefined,
      interrupt: async () => undefined,
    });
    await controller.dispatch("session-1", { type: "submit", text: "active" });
    scheduler.flushOne();
    await waitUntil(async () => (await controller.inspect("session-1")).phase === "running");
    await controller.dispatch("session-1", { type: "submit", text: "still queued" });
    await expect(
      controller.dispatch("session-1", { type: "steer", text: "keep in editor" }),
    ).resolves.toMatchObject({ effect: "idle", restoredText: "keep in editor" });
    await expect(controller.dispatch("session-1", { type: "steer" })).resolves.toMatchObject({
      effect: "idle",
    });
    await expect(controller.inspect("session-1")).resolves.toMatchObject({
      pending: [expect.objectContaining({ text: "still queued", status: "pending" })],
    });
    active.resolve({ outcome: "completed" });
    await waitUntil(async () => (await controller.inspect("session-1")).phase === "idle");
    await controller.close();
  });
  test("a delayed interrupt targeting a settled turn never aborts its successor", async () => {
    const intents = createIntentStore();
    const scheduler = createScheduler();
    const first = deferred<{
      readonly outcome: "completed" | "aborted";
    }>();
    const second = deferred<{
      readonly outcome: "completed" | "aborted";
    }>();
    const requests: string[] = [];
    const interruptedSessions: string[] = [];
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
        return requests.length === 1 ? await first.promise : await second.promise;
      },
      steer: async () => consumedSteer(),
      recordSteerDelivery: async () => undefined,
      interrupt: async (sessionId) => {
        interruptedSessions.push(sessionId);
      },
    });
    await controller.dispatch("session-1", { type: "submit", text: "first" });
    await controller.dispatch("session-1", { type: "submit", text: "second" });
    scheduler.flushOne();
    await waitUntil(() => requests.length === 1);
    const firstTurnId = (await controller.inspect("session-1")).active?.turnId;
    if (!firstTurnId) throw new Error("Expected the first active turn identity");
    await expect(controller.dispatch("session-1", { type: "interrupt", turnId: "" })).rejects.toThrow(
      "visible active turn identity",
    );
    first.resolve({ outcome: "completed" });
    await waitUntil(() => requests.length === 2);
    const stale = await controller.dispatch("session-1", {
      type: "interrupt",
      turnId: firstTurnId,
    });
    expect(stale.effect).toBe("idle");
    expect(interruptedSessions).toEqual([]);
    await expect(controller.inspect("session-1")).resolves.toMatchObject({
      phase: "running",
      queuePaused: true,
      active: { text: "second" },
    });
    second.resolve({ outcome: "completed" });
    await waitUntil(async () => (await controller.inspect("session-1")).phase === "idle");
    await controller.close();
  });
  test("owns background drain rejection, pauses fail-closed, and reports it again on close", async () => {
    const baseIntents = createIntentStore();
    const intents: TurnInteractionIntentStore & {
      readonly records: () => readonly UserIntentRecord[];
    } = Object.freeze({
      ...baseIntents,
      claimOldestPending: async () => {
        throw new Error("claim failed");
      },
    });
    const scheduler = createScheduler();
    const events: TurnInteractionEvent[] = [];
    let id = 0;
    const controller = createTurnInteractionController({
      intents,
      createIntentId: () => `intent-${String(++id)}`,
      createTurnId: () => `turn-${String(++id)}`,
      now: () => timestamp(++id),
      schedule: scheduler.schedule,
      runTurn: async () => ({ outcome: "completed" }),
      steer: async () => consumedSteer(),
      recordSteerDelivery: async () => undefined,
      interrupt: async () => undefined,
    });
    await controller.dispatch(
      "session-1",
      { type: "submit", text: "queued" },
      { onEvent: (event) => events.push(event) },
    );
    scheduler.flushOne();
    await waitUntil(() => events.some((event) => event.type === "interaction-failed"));
    await expect(controller.inspect("session-1")).resolves.toMatchObject({
      phase: "idle",
      queuePaused: true,
      pending: [expect.objectContaining({ text: "queued" })],
    });
    expect(events.find((event) => event.type === "interaction-failed")).toMatchObject({
      error: "claim failed",
    });
    await expect(controller.close()).rejects.toThrow("claim failed");
  });
});
