import { afterEach, describe, expect, test, vi } from "vitest";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import type { ComposerAttachment } from "@noesis/domain";
import { createAttachmentPreview, supportsAttachmentGraphics } from "../src/attachment-preview.ts";
import type { createAttachmentThumbnail } from "../src/attachment-thumbnail.ts";
import { initialTuiState, interactionViewFromSnapshot, reduceTui } from "../src/state.ts";
import { renderMessageBlock } from "../src/transcript.ts";
import { renderQueuedInputs } from "../src/rendering.ts";
import { tuiTimelineFromRuntime } from "../src/timeline-adapter.ts";

const prepare = vi.fn<typeof createAttachmentThumbnail>();
const attachment: ComposerAttachment = {
  name: "photo.png",
  mimeType: "image/png",
  artifact: {
    kind: "artifact_file",
    artifactId: "a1",
    path: "attachments/photo.png",
    mediaType: "image/png",
  },
};
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const settle = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  resetCapabilitiesCache();
});

describe("compact attachment presentation", () => {
  test("unknown, noninteractive, dumb, and multiplexed terminals never receive graphics", () => {
    expect(supportsAttachmentGraphics({}, "kitty", true)).toBe(false);
    for (const env of [
      { TERM_PROGRAM: "kitty", TMUX: "yes" },
      { TERM_PROGRAM: "iTerm.app", STY: "screen" },
      { TERM_PROGRAM: "kitty", TERM: "screen-256color" },
      { TERM_PROGRAM: "kitty", TERM: "dumb" },
      { TERM_PROGRAM: "kitty", PI_IMAGE_PROTOCOL: "none" },
    ]) {
      expect(supportsAttachmentGraphics(env, "kitty", true)).toBe(false);
      expect(supportsAttachmentGraphics(env, "iterm2", true)).toBe(false);
    }
    expect(supportsAttachmentGraphics({ TERM_PROGRAM: "kitty" }, "kitty", false)).toBe(false);
    expect(supportsAttachmentGraphics({ TERM_PROGRAM: "kitty" }, "kitty", true)).toBe(true);
    expect(supportsAttachmentGraphics({ TERM_PROGRAM: "iTerm.app" }, "iterm2", true)).toBe(true);
    expect(supportsAttachmentGraphics({ TERM_PROGRAM: "iTerm.app" }, "kitty", true)).toBe(false);
  });
  test.each(["kitty", "iterm2"] as const)(
    "%s uses only prepared PNG, bounded and cached",
    async (protocol) => {
      vi.stubEnv("TERM_PROGRAM", protocol === "kitty" ? "kitty" : "iTerm.app");
      vi.stubEnv("TERM", "xterm-256color");
      vi.stubEnv("TMUX", "");
      vi.stubEnv("STY", "");
      vi.stubEnv("PI_IMAGE_PROTOCOL", "");
      setCapabilities({ images: protocol, hyperlinks: false, trueColor: false });
      prepare.mockResolvedValue({
        data: png,
        mimeType: "image/png",
        width: 100,
        height: 100,
      });
      const render = vi.fn();
      const preview = createAttachmentPreview(
        { name: "photo.jpg", mimeType: "image/jpeg", data: "originaljpeg" },
        render,
        true,
        prepare,
      );
      expect(preview?.render(80)).toEqual([]);
      await settle();
      const lines = preview?.render(80) ?? [];
      expect(lines.length).toBeLessThanOrEqual(2);
      expect(lines.join("")).toContain(png);
      expect(lines.join("")).not.toContain("originaljpeg");
      if (protocol === "kitty") expect(lines.join("")).toContain("f=100");
      expect(preview?.render(80)).toEqual(lines);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(render).toHaveBeenCalledTimes(1);
    },
  );
  test("removed previews ignore late async completion", async () => {
    vi.stubEnv("TERM_PROGRAM", "kitty");
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("TMUX", "");
    vi.stubEnv("STY", "");
    vi.stubEnv("PI_IMAGE_PROTOCOL", "");
    setCapabilities({ images: "kitty", hyperlinks: false, trueColor: false });
    prepare.mockResolvedValue({
      data: png,
      mimeType: "image/png",
      width: 100,
      height: 100,
    });
    const render = vi.fn();
    const preview = createAttachmentPreview(
      { name: "p.png", mimeType: "image/png", data: png },
      render,
      true,
      prepare,
    );
    preview?.dispose?.();
    await settle();
    expect(render).not.toHaveBeenCalled();
    expect(preview?.render(80)).toEqual([]);
  });
  test("live, resumed, and queued labels preserve exact prompt text", () => {
    const state = reduceTui(initialTuiState("test"), {
      type: "prompt-submitted",
      text: "",
      attachments: [attachment],
    });
    const message = state.timeline[0];
    if (!message || message.kind !== "message") throw new Error("Missing projected user message");
    expect(message.text).toBe("");
    expect(renderMessageBlock(message, 80).join("\n")).toContain("[image: photo.png]");
    const resumed = tuiTimelineFromRuntime([
      {
        kind: "message",
        role: "user",
        text: "",
        messageId: "m1",
        createdAt: "2026-01-01T00:00:00Z",
        attachments: [attachment],
      },
    ]);
    expect(resumed[0]).toMatchObject({ text: "", attachments: [attachment] });
    const interaction = interactionViewFromSnapshot({
      sessionId: "s1",
      phase: "idle",
      queuePaused: true,
      pending: [
        {
          intentId: "i1",
          mode: "turn",
          text: "",
          createdAt: "2026-01-01T00:00:00Z",
          status: "pending",
          attachments: [attachment],
        },
      ],
    });
    expect(interaction.queuedInputs[0]?.text).toBe("");
    expect(renderQueuedInputs({ ...state, interaction }, 80).join("\n")).toContain("[image: photo.png]");
  });
});
