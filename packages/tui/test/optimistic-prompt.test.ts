import { expect, test } from "vitest";
import { createOptimisticPromptEcho } from "../src/optimistic-prompt.ts";
import { createNoesisView } from "../src/rendering.ts";
import { initialTuiState } from "../src/state.ts";

test("attachment-only echo retains metadata, reconciles once, and removes failed sends", () => {
  const view = createNoesisView(initialTuiState("fake"), () => 24);
  const echo = createOptimisticPromptEcho(view, () => {});
  const draft = { name: "photo.png", mimeType: "image/png", data: "large image bytes" };
  const id = echo.echoIfIdle(view.state.interaction, "session", "", [draft]);
  expect(id).toBeDefined();
  expect(view.state.timeline).toEqual([
    {
      kind: "message",
      role: "user",
      text: "",
      localSubmissionId: id,
      attachments: [{ name: draft.name, mimeType: draft.mimeType }],
    },
  ]);
  const admitted = {
    name: draft.name,
    mimeType: draft.mimeType,
    artifact: {
      kind: "artifact_file" as const,
      artifactId: "image1",
      path: "photo.png",
      mediaType: "image/png",
    },
  };
  expect(echo.admit("session", "", "turn1", [admitted])).toBe(true);
  expect(echo.admit("session", "", "turn1", [admitted])).toBe(false);
  expect(view.state.timeline).toEqual([
    {
      kind: "message",
      role: "user",
      text: "",
      turnId: "turn1",
      attachments: [admitted],
    },
  ]);
  const retryId = echo.echoIfIdle(view.state.interaction, "session", "", [draft]);
  expect(retryId).toBeDefined();
  expect(echo.reject(retryId ?? "missing")).toBe(true);
  expect(view.state.timeline).toHaveLength(1);
  expect(echo.hasPending()).toBe(false);
});

test("busy sessions leave attachment messages in the queue instead of echoing them as active turns", () => {
  const view = createNoesisView(initialTuiState("fake"), () => 24);
  const echo = createOptimisticPromptEcho(view, () => {});
  expect(
    echo.echoIfIdle({ ...view.state.interaction, phase: "running" }, "session", "", [
      { name: "notes.txt", mimeType: "text/plain" },
    ]),
  ).toBeUndefined();
  expect(view.state.timeline).toEqual([]);
});
