import { describe, expect, test } from "vitest";
import { MAX_FROZEN_CONVERSATION_HISTORY_ENTRY_CHARACTERS } from "@noesis/agent-types";
import {
  buildContextCheckpointRecord,
  contextCheckpointActivationRequestDigest,
  estimateContextTokens,
  prepareCompactionWindow,
  resolveContextTokenBudget,
  resolveHistoryTokenBudget,
  resolvedSessionContext,
  serializeCompactionWindow,
  type SessionContextMessage,
} from "../src/session-compaction.ts";

const message = (
  id: string,
  content: string,
  startsTurn: boolean,
  role: "user" | "assistant" = startsTurn ? "user" : "assistant",
): SessionContextMessage =>
  Object.freeze({
    messageId: id,
    role,
    content,
    createdAt: `2026-08-13T00:00:${id.padStart(2, "0")}.000Z`,
    sensitivity: "normal",
    startsTurn,
  });

describe("session compaction", () => {
  test("uses the configured 160k budget only below the selected model's input capacity", () => {
    expect(resolveContextTokenBudget(160_000, { contextWindow: 200_000, maxOutputTokens: 20_000 })).toBe(
      160_000,
    );
    expect(resolveContextTokenBudget(160_000, { contextWindow: 128_000, maxOutputTokens: 8_000 })).toBe(
      120_000,
    );
    expect(() =>
      resolveContextTokenBudget(160_000, { contextWindow: 200_000, maxOutputTokens: Number.NaN }),
    ).toThrow("no usable output token allowance");
  });

  test("reserves non-history request capacity inside the configured context budget", () => {
    expect(resolveHistoryTokenBudget(160_000, ["system", "current input"])).toBe(128_000);
    expect(resolveHistoryTokenBudget(10_000, ["x".repeat(4_000)])).toBe(4_904);
    expect(() => resolveHistoryTokenBudget(100, ["x".repeat(400)])).toThrow("no room");
  });

  test("estimates provider-neutral tokens from UTF-8 bytes", () => {
    expect(estimateContextTokens("a".repeat(12))).toBe(3);
    expect(estimateContextTokens("你好世界")).toBe(3);
    expect(estimateContextTokens("2 + 2 = 4")).toBe(3);
  });

  test("counts unfinished-turn labels before deciding whether compaction is required", () => {
    const failed = Object.freeze({
      ...message("1", "retry this operation", true),
      turnStatus: "failed" as const,
    });
    const rawOnlyBudget = estimateContextTokens(failed.content);

    const current = resolvedSessionContext(Object.freeze([failed]), undefined, rawOnlyBudget);

    expect(current.estimatedTokens).toBeGreaterThan(rawOnlyBudget);
    expect(current.exceedsBudget).toBe(true);
  });

  test("applies frozen character bounds to the rendered unfinished message", () => {
    const failed = Object.freeze({
      ...message("1", "x".repeat(MAX_FROZEN_CONVERSATION_HISTORY_ENTRY_CHARACTERS), true),
      turnStatus: "failed" as const,
    });

    const current = resolvedSessionContext(Object.freeze([failed]), undefined, 1_000_000);

    expect(current.exceedsBudget).toBe(true);
  });

  test("compacts only complete oldest turns and retains a complete recent raw tail", () => {
    const messages = Object.freeze([
      message("1", "a".repeat(48), true),
      message("2", "b".repeat(48), false),
      message("3", "c".repeat(48), true),
      message("4", "d".repeat(48), false),
      message("5", "e".repeat(48), true),
      message("6", "f".repeat(48), false),
    ]);

    const window = prepareCompactionWindow(messages, undefined, 68, {
      compactorInputTokenBudget: 1_000,
    });

    expect(window?.sourceMessages.map(({ messageId }) => messageId)).toEqual(["1", "2"]);
    expect(window?.retainedMessages.map(({ messageId }) => messageId)).toEqual(["3", "4", "5", "6"]);
    expect(window?.sourceMessages[0]?.startsTurn).toBe(true);
  });

  test("includes leading steering messages in the oldest complete turn", () => {
    const messages = Object.freeze([
      message("0", "leading steer", false, "user"),
      message("1", "first request", true),
      message("2", "first response", false),
      message("3", "recent request", true),
      message("4", "recent response", false),
    ]);

    const window = prepareCompactionWindow(messages, undefined, 15, {
      compactorInputTokenBudget: 1_000,
    });

    expect(window?.sourceMessages.map(({ messageId }) => messageId)).toEqual(["0", "1", "2"]);
    expect(window?.retainedMessages.map(({ messageId }) => messageId)).toEqual(["3", "4"]);
  });

  test("resolves repeated compaction from the prior retained boundary without reusing old sources", () => {
    const messages = Object.freeze([
      message("1", "old-user", true),
      message("2", "old-assistant", false),
      message("3", "retained-user", true),
      message("4", "retained-assistant", false),
      message("5", "new-user", true),
      message("6", "new-assistant", false),
    ]);
    const checkpoint = Object.freeze({
      checkpointId: "checkpoint-1",
      sessionId: "session-1",
      summary: "prior summary",
      summaryDigest: "a".repeat(64),
      sourceDigest: "b".repeat(64),
      sources: Object.freeze([
        Object.freeze({ messageId: "1", contentDigest: "c".repeat(64) }),
        Object.freeze({ messageId: "2", contentDigest: "d".repeat(64) }),
      ]),
      firstRetainedMessageId: "3",
      lastCoveredMessageId: "2",
      tokenBudget: 40,
      estimatedSummaryTokens: estimateContextTokens("prior summary"),
      sensitivity: "normal" as const,
      provider: "controlled",
      model: "controlled",
      thinkingLevel: "off" as const,
      usage: Object.freeze({ inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 }),
      createdAt: "2026-08-13T00:00:00.000Z",
    });

    const current = resolvedSessionContext(messages, checkpoint, 15);
    const window = prepareCompactionWindow(messages, checkpoint, 15, {
      compactorInputTokenBudget: 1_000,
    });

    expect(current.messages.map(({ messageId }) => messageId)).toEqual(["3", "4", "5", "6"]);
    expect(window?.sourceMessages.map(({ messageId }) => messageId)).toEqual(["3", "4"]);
    expect(window?.previousCheckpoint?.checkpointId).toBe("checkpoint-1");
  });

  test("manual compaction covers an oldest complete turn below the automatic threshold", () => {
    const messages = Object.freeze([
      message("1", "old-user", true),
      message("2", "old-assistant", false),
      message("3", "recent-user", true),
      message("4", "recent-assistant", false),
    ]);

    const window = prepareCompactionWindow(messages, undefined, 10_000, {
      force: true,
      compactorInputTokenBudget: 20_000,
    });

    expect(window?.sourceMessages.map(({ messageId }) => messageId)).toEqual(["1", "2"]);
    expect(window?.retainedMessages.map(({ messageId }) => messageId)).toEqual(["3", "4"]);
  });

  test("manual compaction covers a single completed turn below the automatic threshold", () => {
    const messages = Object.freeze([
      message("1", "only request", true),
      message("2", "only response", false),
    ]);

    const window = prepareCompactionWindow(messages, undefined, 10_000, {
      force: true,
      compactorInputTokenBudget: 20_000,
    });

    expect(window?.sourceMessages.map(({ messageId }) => messageId)).toEqual(["1", "2"]);
    expect(window?.retainedMessages).toEqual([]);
  });

  test("covers only complete bytes supplied to the compactor and retains the exact remaining suffix", () => {
    const largeContent = `${"head".repeat(8_000)}middle-marker${"tail".repeat(8_000)}`;
    const messages = Object.freeze([
      message("1", largeContent, true),
      message("2", "answer", false),
      message("3", "next", true),
      message("4", "next-answer", false),
    ]);
    const window = prepareCompactionWindow(messages, undefined, 20, {
      compactorInputTokenBudget: 100_000,
    });
    if (!window) throw new Error("Expected a compaction window");

    expect(serializeCompactionWindow(window)).toContain("middle-marker");
    expect(window.retainedMessages.map(({ messageId }) => messageId)).toEqual(["3", "4"]);
    expect(() =>
      prepareCompactionWindow(messages, undefined, 10, { compactorInputTokenBudget: 1_000 }),
    ).toThrow("oldest complete turn exceeds");
  });

  test("keeps checkpoint activation identity stable across runtime metadata", () => {
    const messages = Object.freeze([
      message("1", "old request", true),
      message("2", "old response", false),
      message("3", "recent request", true),
      message("4", "recent response", false),
    ]);
    const window = prepareCompactionWindow(messages, undefined, 10, {
      compactorInputTokenBudget: 1_000,
    });
    if (!window) throw new Error("Expected a compaction window");
    const base = buildContextCheckpointRecord({
      checkpointId: "checkpoint-1",
      sessionId: "session-1",
      window,
      summary: "stable summary",
      sensitivity: "normal",
      provider: "controlled",
      model: "controlled",
      thinkingLevel: "off",
      usage: Object.freeze({ inputTokens: 1, outputTokens: 2, totalTokens: 3, estimatedCost: 0 }),
      createdAt: "2026-08-13T00:00:00.000Z",
    });
    const retried = Object.freeze({
      ...base,
      usage: Object.freeze({ inputTokens: 4, outputTokens: 5, totalTokens: 9, estimatedCost: 1 }),
      createdAt: "2026-08-13T00:01:00.000Z",
    });

    expect(contextCheckpointActivationRequestDigest(retried)).toBe(
      contextCheckpointActivationRequestDigest(base),
    );
  });
});
