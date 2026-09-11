import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { ComposerAttachment } from "@noesis/domain";
import { startNoesisTui } from "../src/index.ts";
import type { NoesisTuiRuntime } from "../src/runtime-port.ts";
import { createInMemoryTestRuntime } from "./support/in-memory-runtime.ts";
import { createTestTerminal } from "./support/test-terminal.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

test("live composer reads an explicit image, keeps failed admission draft, and renders admitted labels", async () => {
  const directory = await mkdtemp(join(tmpdir(), "noesis-composer-"));
  const path = join(directory, "photo.png");
  await writeFile(path, Buffer.from(png, "base64"));
  // The controlled seam is message admission only; no model call is needed to test terminal wiring.
  const base = createInMemoryTestRuntime({
    name: "composer-admission-fixture",
    async run() {
      throw new Error("Unexpected model execution in admission-only test");
    },
    async steer() {
      return { status: "consumed", timelineSequence: 1, consumedAt: new Date().toISOString() };
    },
    async abort() {},
  });
  const admission = Promise.withResolvers<void>();
  let attempt = 0;
  const submit = vi.fn<NoesisTuiRuntime["interact"]>(async (sessionId, command, options) => {
    if (command.type !== "submit") return base.interact(sessionId, command, options);
    attempt++;
    if (attempt === 1) {
      await admission.promise;
      throw new Error("Admission unavailable");
    }
    const attachments: readonly ComposerAttachment[] = [
      {
        name: "photo.png",
        mimeType: "image/png",
        artifact: {
          kind: "artifact_file",
          artifactId: "image1",
          path: "attachments/photo.png",
          mediaType: "image/png",
        },
      },
    ];
    options?.onEvent?.({
      type: "turn-started",
      sessionId,
      intentId: "intent1",
      turnId: "turn1",
      text: command.text,
      attachments,
    });
    return { effect: "queued", snapshot: { sessionId, phase: "idle", queuePaused: false, pending: [] } };
  });
  const runtime: NoesisTuiRuntime = { ...base, interact: submit };
  const terminal = createTestTerminal();
  const running = startNoesisTui(runtime, {}, terminal);
  try {
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));
    terminal.type(`/attach ${path}\r`);
    await vi.waitFor(() => expect(terminal.output).toContain("1 photo.png"));
    terminal.type("inspect this\r");
    await vi.waitFor(() => expect(terminal.output).toContain("[image: photo.png]"));
    expect(terminal.output).not.toContain("draft retained");
    admission.resolve();
    await vi.waitFor(() => expect(terminal.output).toContain("draft retained"));
    expect(submit.mock.calls[0]?.[1]).toMatchObject({
      type: "submit",
      text: "inspect this",
      attachments: [
        {
          name: "photo.png",
          mimeType: "image/png",
          sourcePath: path,
          sourceSize: Buffer.byteLength(png, "base64"),
        },
      ],
    });
    terminal.send("\r");
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1]?.[1]).toEqual(submit.mock.calls[0]?.[1]);
    await vi.waitFor(() => expect(terminal.output).toContain("[image: photo.png]"));
  } finally {
    admission.resolve();
    terminal.send("\u0003");
    await running;
    await rm(directory, { recursive: true, force: true });
  }
});
