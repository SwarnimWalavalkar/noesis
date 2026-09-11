import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  COMPOSER_ATTACHMENT_LIMITS,
  composerContentDigest,
  validateComposerAttachmentInputs,
} from "@noesis/domain";
import { createWorkspaceStore } from "@noesis/workspace";
import {
  createTurnInteractionController,
  persistComposerAttachments,
  resolveComposerAttachmentImages,
  renderComposerAttachmentText,
} from "../src/index.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const input = {
  name: "note.txt",
  mimeType: "text/plain",
  data: Buffer.from("immutable original").toString("base64"),
};
const png = {
  name: "pixel.png",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
};
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "noesis-attachments-"));
  roots.push(root);
  const workspace = await createWorkspaceStore(root);
  for (const sessionId of ["source", "destination"])
    await workspace.operational.sessions.put({
      sessionId,
      title: sessionId,
      status: "idle",
      provider: "controlled",
      model: "controlled",
      runtime: "pi",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      metadata: {},
    });
  return { root, workspace };
}
test("validates bounds, canonical base64, safe names, image signatures and empty files", () => {
  expect(validateComposerAttachmentInputs([{ ...input, data: "" }])).toHaveLength(1);
  expect(() => validateComposerAttachmentInputs([{ ...input, data: "Zh==" }])).toThrow();
  expect(() => validateComposerAttachmentInputs([{ ...input, name: "../escape" }])).toThrow();
  expect(() => validateComposerAttachmentInputs([{ ...input, mimeType: "image/png" }])).toThrow(
    /invalid image/,
  );
  expect(() => validateComposerAttachmentInputs(Array.from({ length: 9 }, () => input))).toThrow();
  const nearLimit = {
    ...input,
    data: Buffer.alloc(COMPOSER_ATTACHMENT_LIMITS.perFileBytes).toString("base64"),
  };
  expect(validateComposerAttachmentInputs([nearLimit])).toHaveLength(1);
  expect(() => validateComposerAttachmentInputs([nearLimit, nearLimit, input])).toThrow(/total byte/);
});
test("persists immutable bytes, validates restored refs and rejects corruption or oversized reads", async () => {
  const { root, workspace } = await setup();
  const refs = await persistComposerAttachments(workspace, "source", [input, png]);
  expect(JSON.stringify(refs)).not.toContain(input.data);
  expect(await persistComposerAttachments(workspace, "source", refs)).toEqual(refs);
  expect(await resolveComposerAttachmentImages(workspace, refs)).toEqual([
    { mimeType: png.mimeType, data: png.data },
  ]);
  const first = refs[0];
  if (!first) throw new Error("Missing fixture ref");
  expect(renderComposerAttachmentText("", refs, root)).toContain(join(root, first.artifact.path));
  await expect(workspace.reads.readArtifact(first.artifact, 1)).rejects.toThrow(/byte limit/);
  await expect(
    persistComposerAttachments(workspace, "source", [
      { ...first, artifact: { ...first.artifact, path: "forged" } },
    ]),
  ).rejects.toThrow(/authoritative/);
  await writeFile(join(root, first.artifact.path), "changed");
  await expect(persistComposerAttachments(workspace, "source", [first])).rejects.toThrow(/digest mismatch/);
  await workspace.close();
});
test("attachment-only queue survives reopening, reroutes in order, and restores exact text plus refs", async () => {
  const { root, workspace } = await setup();
  let id = 0;
  const controller = createTurnInteractionController({
    intents: workspace.operational.userIntents,
    createIntentId: () => `intent-${++id}`,
    createTurnId: () => `turn-${++id}`,
    prepareAttachments: (sessionId, inputs) => persistComposerAttachments(workspace, sessionId, inputs),
    runTurn: async () => {
      throw new Error("Must not run queued work");
    },
    steer: async () => ({ status: "not-consumed", reason: "not-running" }),
    recordSteerDelivery: async () => undefined,
    interrupt: async () => undefined,
  });
  const queued = await controller.dispatch("source", {
    type: "enqueue",
    text: "",
    attachments: [input, png],
  });
  const pending = queued.snapshot.pending[0];
  if (!pending) throw new Error("Missing intent");
  expect(pending.text).toBe("");
  expect(pending.attachments).toHaveLength(2);
  expect((await workspace.operational.userIntents.listPending("source"))[0]?.contentDigest).toBe(
    composerContentDigest("", pending.attachments),
  );
  await controller.dispatch("destination", {
    type: "reroute-pending",
    sourceSessionId: "source",
    intentIds: [pending.intentId],
  });
  const restored = await controller.dispatch("destination", { type: "restore-newest" });
  expect(restored.restoredText).toBe("");
  expect(restored.restoredAttachments).toEqual(pending.attachments);
  await controller.dispatch("destination", {
    type: "enqueue",
    text: "caption",
    attachments: restored.restoredAttachments ?? [],
  });
  await controller.close();
  await workspace.close();
  const reopened = await createWorkspaceStore(root);
  expect((await reopened.operational.userIntents.listPending("destination"))[0]).toMatchObject({
    text: "caption",
    attachments: pending.attachments,
  });
  await reopened.close();
});

test.skipIf(process.platform === "win32")(
  "bounded immutable reads reject replaced FIFOs without blocking",
  async () => {
    const { root, workspace } = await setup();
    const refs = await persistComposerAttachments(workspace, "source", [input]);
    const ref = refs[0];
    if (!ref) throw new Error("Missing fixture ref");
    const filename = join(root, ref.artifact.path);
    await rm(filename);
    execFileSync("mkfifo", [filename]);
    await expect(workspace.reads.readArtifact(ref.artifact, 100)).rejects.toThrow(/regular file/);
    await workspace.close();
  },
);
