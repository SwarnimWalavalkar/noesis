import { expect, test } from "vitest";
import { sha256 } from "@noesis/domain";
import {
  frozenTurnPlanDigest,
  validateFrozenTurnPlan,
  type FrozenConversationHistoryEntry,
  type FrozenTurnPlan,
} from "../src/index.ts";

const attachment = {
  name: "pixel.png",
  mimeType: "image/png",
  artifact: {
    kind: "artifact_file" as const,
    artifactId: "pixel",
    path: ".noesis/artifacts/pixel.png",
    mediaType: "image/png",
  },
};
const history: FrozenConversationHistoryEntry = {
  messageId: "message",
  messageRef: { kind: "database_row", table: "messages", rowId: "message" },
  role: "user",
  content: "",
  contentDigest: sha256(""),
  createdAt: "2026-01-01",
  attachments: [attachment],
};
function freeze(entry: FrozenConversationHistoryEntry) {
  const unsigned: Omit<FrozenTurnPlan, "canonicalDigest"> = {
    schemaVersion: 1,
    planId: "plan",
    sessionId: "session",
    turnId: "turn",
    activationId: "activation",
    activationRevision: 1,
    selectedCapabilities: [],
    renderedSystemPrompt: "System",
    provider: "controlled",
    model: "controlled",
    thinkingLevel: "off",
    permissionSnapshot: { effects: [], resourcePatterns: [], credentialRefs: [] },
    retrievalCitations: [],
    routing: { strategyId: "baseline", reason: "test" },
    createdAt: "2026-01-01",
    conversationHistory: [entry],
  };
  return { ...unsigned, canonicalDigest: frozenTurnPlanDigest(unsigned) };
}
test("freezes attachment-only user history without weakening content or canonical digests", () => {
  const plan = freeze(history);
  expect(validateFrozenTurnPlan(plan).conversationHistory?.[0]?.attachments).toEqual([attachment]);
  expect(() => validateFrozenTurnPlan(freeze({ ...history, contentDigest: sha256("other") }))).toThrow(
    "content digest",
  );
  expect(() =>
    validateFrozenTurnPlan({
      ...plan,
      conversationHistory: [{ ...history, attachments: [{ ...attachment, name: "changed.png" }] }],
    }),
  ).toThrow("canonical digest");
  expect(() => validateFrozenTurnPlan(freeze({ ...history, attachments: [] }))).toThrow(
    "History requires text or user attachments",
  );
  expect(() => validateFrozenTurnPlan(freeze({ ...history, role: "assistant" }))).toThrow(
    "History requires text or user attachments",
  );
  expect(() =>
    validateFrozenTurnPlan({
      ...plan,
      conversationHistory: [{ ...history, images: [{ mimeType: "image/png", data: "private" }] }],
    }),
  ).toThrow();
});
