import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNoesisConfig } from "@noesis/config";
import { type ComposerAttachmentInput, ComposerAttachmentsSchema } from "@noesis/domain";
import { createPiAgentRoleRunner, createPiAgentRuntime } from "@noesis/runtime-pi";
import { afterEach, expect, test, vi } from "vitest";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  type ControlledPiPrompt,
  createControlledPiModels,
} from "../../../packages/runtime-pi/test/support/controlled-pi-models.ts";
import { createApplicationRuntimeComposition } from "../src/runtime-composition.ts";
import { researchLoopControlledResponse } from "./support/research-loop-controlled-response.ts";
const homes: string[] = [];
const image: ComposerAttachmentInput = {
  name: "pixel.png",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
};
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture(imageInput: boolean, beforeResponse?: (prompt: ControlledPiPrompt) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "noesis-attachments-acceptance-"));
  homes.push(home);
  const config = await resolveNoesisConfig({
    home,
    env: Object.freeze({}),
    cli: { provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL },
  });
  const prompts: ControlledPiPrompt[] = [];
  const controlled = createControlledPiModels({
    imageInput,
    respond: async (prompt) => {
      if (!prompt.systemPrompt.includes("role:")) {
        prompts.push(prompt);
        await beforeResponse?.(prompt);
      }
      return researchLoopControlledResponse(prompt);
    },
  });
  const open = () =>
    createApplicationRuntimeComposition({
      config,
      createAgent: (_tools, codeExecution) =>
        createPiAgentRuntime(home, controlled.models, { codeExecution }),
      createRoleRunner: (configurations) => createPiAgentRoleRunner(home, controlled.models, configurations),
    });
  return { home, prompts, open };
}
function imagesIn(prompt: ControlledPiPrompt | undefined): readonly string[] {
  return (
    prompt?.context.messages.flatMap((message) =>
      typeof message.content === "string"
        ? []
        : message.content.flatMap((part) => (part.type === "image" ? [part.data] : [])),
    ) ?? []
  );
}
type Application = Awaited<ReturnType<typeof createApplicationRuntimeComposition>>;
async function send(
  runtime: Application,
  trailId: string,
  text: string,
  attachments?: readonly ComposerAttachmentInput[],
) {
  const settled = Promise.withResolvers<void>();
  await runtime.interact(
    trailId,
    { type: "submit", text, attachments: attachments ?? [] },
    {
      onEvent: (event) => {
        if (event.type === "turn-settled") {
          if (event.outcome === "failed") settled.reject(new Error(event.error));
          else settled.resolve();
        }
        if (event.type === "interaction-failed") settled.reject(new Error(event.error));
      },
    },
  );
  await settled.promise;
}
test("image-only submission reaches Pi and retains artifact references through reopen and fork", async () => {
  const { prompts, open } = await fixture(true);
  const first = await open();
  const trail = await first.startTrail({ title: "Image attachment" });
  try {
    await send(first, trail.trailId, "", [image]);
    expect(imagesIn(prompts.at(-1))).toEqual([image.data]);
    const user = (await first.debug.workspace.operational.messages.listForSession(trail.trailId)).find(
      (message) => message.role === "user",
    );
    expect(user?.content).toBe("");
    const attachments = ComposerAttachmentsSchema.parse(user?.metadata["attachments"]);
    expect(attachments).toHaveLength(1);
    expect(JSON.stringify(user)).not.toContain(image.data);
    const attachment = attachments[0];
    if (!attachment) throw new Error("Missing attachment");
    expect(await readFile(join(first.debug.workspace.paths.root, attachment.artifact.path))).toEqual(
      Buffer.from(image.data, "base64"),
    );
  } finally {
    await first.shutdown();
  }
  const reopened = await open();
  try {
    await send(reopened, trail.trailId, "Describe the earlier image again.");
    expect(imagesIn(prompts.at(-1))).toEqual([image.data]);
    const fork = await reopened.forkTrail(trail.trailId);
    await send(reopened, fork.trailId, "Keep using that image.");
    expect(imagesIn(prompts.at(-1))).toEqual([image.data]);
  } finally {
    await reopened.shutdown();
  }
});
test("generic file queue restoration retains exact references and exposes readable paths", async () => {
  const { prompts, open } = await fixture(false);
  const runtime = await open();
  const trail = await runtime.startTrail({ title: "File attachment" });
  const file: ComposerAttachmentInput = {
    name: "notes.txt",
    mimeType: "text/plain",
    data: Buffer.from("original file bytes\n").toString("base64"),
  };
  try {
    await runtime.interact(trail.trailId, { type: "pause-queue" });
    await runtime.interact(trail.trailId, { type: "enqueue", text: "Read this file", attachments: [file] });
    const restored = await runtime.interact(trail.trailId, { type: "restore-newest" });
    expect(restored.restoredText).toBe("Read this file");
    expect(restored.restoredAttachments).toHaveLength(1);
    await runtime.interact(trail.trailId, {
      type: "enqueue",
      text: restored.restoredText ?? "",
      attachments: restored.restoredAttachments ?? [],
    });
    const settled = Promise.withResolvers<void>();
    await runtime.interact(
      trail.trailId,
      { type: "resume-queue" },
      {
        onEvent: (event) => {
          if (event.type === "interaction-failed") settled.reject(new Error(event.error));
          if (event.type === "turn-settled") {
            if (event.outcome === "failed") settled.reject(new Error(event.error));
            else settled.resolve();
          }
        },
      },
    );
    await settled.promise;
    const text = prompts.at(-1)?.lastUserText ?? "";
    expect(text).toContain("notes.txt");
    const attachment = restored.restoredAttachments?.[0];
    if (!attachment) throw new Error("Missing restored file");
    expect(text).toContain(join(runtime.debug.workspace.paths.root, attachment.artifact.path));
    expect(imagesIn(prompts.at(-1))).toEqual([]);
  } finally {
    await runtime.shutdown();
  }
});
test.each([false, true])(
  "original images remain attached when model support/safe decode is unavailable (%s)",
  async (supportsImages) => {
    const { open, prompts } = await fixture(supportsImages);
    const runtime = await open();
    try {
      const trail = await runtime.startTrail({ title: "Original image retained" });
      const bytes = Buffer.from(image.data, "base64");
      if (supportsImages) bytes.writeUInt32BE(100_000, 16);
      const events: string[] = [];
      const order: string[] = [];
      const result = await runtime.interact(
        trail.trailId,
        {
          type: "submit",
          text: "See this",
          attachments: [{ ...image, data: bytes.toString("base64") }],
        },
        {
          onEvent: (event) => {
            if (event.type === "turn-started") order.push("started");
            if (event.type === "agent" && event.event.type === "notice") {
              events.push(event.event.text);
              order.push("notice");
            }
          },
        },
      );
      expect(result.effect).toBe("queued");
      await vi.waitFor(() => expect(runtime.getTrail(trail.trailId).turns).toHaveLength(1));
      expect(events.join("\n")).toContain("not inlined");
      expect(order).toEqual(["started", "notice"]);
      const user = (await runtime.debug.workspace.operational.messages.listForSession(trail.trailId)).find(
        (message) => message.role === "user",
      );
      const refs = ComposerAttachmentsSchema.parse(user?.metadata["attachments"]);
      expect(refs).toHaveLength(1);
      const ref = refs[0];
      if (!ref) throw new Error("Missing original image");
      expect(await readFile(join(runtime.debug.workspace.paths.root, ref.artifact.path))).toEqual(bytes);
      const blocks = prompts
        .flatMap((prompt) => prompt.context.messages)
        .filter((message) => message.role === "user")
        .flatMap((message) => (typeof message.content === "string" ? [] : message.content));
      expect(blocks.some((block) => block.type === "image")).toBe(false);
      expect(JSON.stringify(blocks)).toContain("not inlined");
    } finally {
      await runtime.shutdown();
    }
  },
);

test("steering commits original text and image references only after Pi consumes them", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const { open, prompts } = await fixture(true, async () => {
    if (++calls === 1) {
      started.resolve();
      await release.promise;
    }
  });
  const runtime = await open();
  const trail = await runtime.startTrail({ title: "Image steering" });
  try {
    const running = send(runtime, trail.trailId, "Initial request");
    await started.promise;
    const steering = runtime.interact(trail.trailId, {
      type: "steer",
      text: "Inspect this instead",
      attachments: [image],
    });
    await expect
      .poll(async () =>
        (await runtime.debug.workspace.operational.userIntents.listDispatching(trail.trailId)).some(
          (intent) => intent.deliveryMode === "steer",
        ),
      )
      .toBe(true);
    release.resolve();
    await steering;
    await running;
    expect(imagesIn(prompts.at(-1))).toEqual([image.data]);
    const message = (await runtime.debug.workspace.operational.messages.listForSession(trail.trailId)).find(
      (entry) => entry.metadata["deliveryMode"] === "steer",
    );
    expect(message?.content).toBe("Inspect this instead");
    expect(ComposerAttachmentsSchema.parse(message?.metadata["attachments"])).toHaveLength(1);
  } finally {
    release.resolve();
    await runtime.shutdown();
  }
});
