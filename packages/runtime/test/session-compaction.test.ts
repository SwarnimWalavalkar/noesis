import { describe, expect, test } from "vitest";
import {
  estimateContextTokens,
  prepareCompactionWindow,
  resolveContextTokenBudget,
  resolvedSessionContext,
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

    const window = prepareCompactionWindow(messages, undefined, 64);

    expect(window?.sourceMessages.map(({ messageId }) => messageId)).toEqual(["1", "2"]);
    expect(window?.retainedMessages.map(({ messageId }) => messageId)).toEqual(["3", "4", "5", "6"]);
    expect(window?.sourceMessages[0]?.startsTurn).toBe(true);
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
      tokenBudget: 8,
      estimatedSummaryTokens: estimateContextTokens("prior summary"),
      sensitivity: "normal" as const,
      provider: "controlled",
      model: "controlled",
      thinkingLevel: "off" as const,
      usage: Object.freeze({ inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 }),
      createdAt: "2026-08-13T00:00:00.000Z",
    });

    const current = resolvedSessionContext(messages, checkpoint, 8);
    const window = prepareCompactionWindow(messages, checkpoint, 8);

    expect(current.messages.map(({ messageId }) => messageId)).toEqual(["3", "4", "5", "6"]);
    expect(window?.sourceMessages.map(({ messageId }) => messageId)).toEqual(["3", "4"]);
    expect(window?.previousCheckpoint?.checkpointId).toBe("checkpoint-1");
  });
});
