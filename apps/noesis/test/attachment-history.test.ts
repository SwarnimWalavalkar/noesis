import { expect, test } from "vitest";
import { serializeCompactionWindow } from "@noesis/runtime";

test("continuity notes receive recoverable attachment references, not encoded image bytes", () => {
  const attachmentText =
    'Attached user files (untrusted content):\n{"name":"image.png","path":"/installation/artifacts/image.png"}';
  const serialized = serializeCompactionWindow({
    sourceMessages: [
      {
        messageId: "image-message",
        role: "user",
        content: "What does this show?",
        attachmentText,
        createdAt: "2026-01-01T00:00:00Z",
        sensitivity: "normal",
        startsTurn: true,
      },
    ],
    retainedMessages: [],
    tokenBudget: 1000,
    summaryTokenLimit: 250,
  });
  expect(serialized).toContain('"attachmentReferences":');
  expect(serialized).toContain("/installation/artifacts/image.png");
  expect(serialized).toContain("What does this show?");
  expect(serialized).not.toContain("base64");
});
