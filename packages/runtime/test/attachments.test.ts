import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  COMPOSER_IMAGE_PROJECTION_LIMITS,
  composerContentDigest,
  validateComposerAttachmentInputs,
} from "@noesis/domain";
import { createWorkspaceStore } from "@noesis/workspace";
import {
  createTurnInteractionController,
  persistComposerAttachments,
  resolveComposerAttachmentImages,
  projectComposerAttachmentImages,
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
test("validates canonical base64 and safe names without count/byte admission caps", () => {
  expect(validateComposerAttachmentInputs([{ ...input, data: "" }])).toHaveLength(1);
  expect(() => validateComposerAttachmentInputs([{ ...input, data: "Zh==" }])).toThrow();
  expect(() => validateComposerAttachmentInputs([{ ...input, name: "../escape" }])).toThrow();
  expect(validateComposerAttachmentInputs([{ ...input, mimeType: "image/png" }])).toHaveLength(1);
  expect(validateComposerAttachmentInputs(Array.from({ length: 9 }, () => input))).toHaveLength(9);
  const nearLimit = {
    ...input,
    data: Buffer.alloc(COMPOSER_IMAGE_PROJECTION_LIMITS.perImageBytes).toString("base64"),
  };
  expect(validateComposerAttachmentInputs([nearLimit])).toHaveLength(1);
  expect(validateComposerAttachmentInputs([nearLimit, nearLimit, input])).toHaveLength(3);
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
  ).rejects.toThrow(/artifact reference/);
  await writeFile(join(root, first.artifact.path), "changed");
  await expect(persistComposerAttachments(workspace, "source", [first])).rejects.toThrow(
    "authoritative metadata",
  );
  await expect(workspace.reads.readArtifact(first.artifact, 100)).rejects.toThrow(/digest mismatch/);
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

test("image resolution never reads generic artifacts, but validates MIME references", async () => {
  const { workspace } = await setup();
  try {
    const refs = await persistComposerAttachments(workspace, "source", [input, png]);
    const readArtifact = vi.fn(workspace.reads.readArtifact);
    const instrumented = { ...workspace, reads: { ...workspace.reads, readArtifact } };
    expect(await resolveComposerAttachmentImages(instrumented, refs)).toEqual([
      { mimeType: png.mimeType, data: png.data },
    ]);
    expect(readArtifact).toHaveBeenCalledTimes(1);
    expect(readArtifact).toHaveBeenCalledWith(
      refs[1]?.artifact,
      COMPOSER_IMAGE_PROJECTION_LIMITS.perImageBytes,
    );
    const generic = refs[0];
    if (!generic) throw new Error("Missing generic fixture");
    await expect(
      resolveComposerAttachmentImages(instrumented, [{ ...generic, mimeType: "application/pdf" }]),
    ).rejects.toThrow("MIME differs");
  } finally {
    await workspace.close();
  }
});

test("attachment digests cannot collide with literal serialization in text-only intents", async () => {
  const { workspace } = await setup();
  try {
    const refs = await persistComposerAttachments(workspace, "source", [input]);
    const literal = JSON.stringify({ text: "", attachments: refs });
    expect(composerContentDigest("", refs)).not.toBe(composerContentDigest(literal));
    const options = {
      intentId: "separated",
      sessionId: "source",
      createdAt: "2026-01-01",
      text: "",
      attachments: refs,
    };
    await workspace.operational.userIntents.enqueue(options);
    await expect(
      workspace.operational.userIntents.enqueue({ ...options, text: literal, attachments: [] }),
    ).rejects.toThrow();
  } finally {
    await workspace.close();
  }
});

test("tiny image lists retain all originals while bounding image blocks before artifact reads", async () => {
  const { workspace } = await setup();
  try {
    const refs = await persistComposerAttachments(
      workspace,
      "source",
      Array.from({ length: 20 }, () => png),
    );
    const readArtifact = vi.fn(workspace.reads.readArtifact);
    const instrumented = { ...workspace, reads: { ...workspace.reads, readArtifact } };
    const projection = await projectComposerAttachmentImages(instrumented, refs);
    expect(refs).toHaveLength(20);
    expect(projection.images).toHaveLength(COMPOSER_IMAGE_PROJECTION_LIMITS.imageCount);
    expect(projection.notice).toContain("Non-inlined original contents are not verified");
    expect(readArtifact).toHaveBeenCalledTimes(COMPOSER_IMAGE_PROJECTION_LIMITS.imageCount);
  } finally {
    await workspace.close();
  }
});

test.each(["missing", "same-length corruption"])(
  "image projection rejects artifact %s instead of claiming an available original",
  async (failure) => {
    const { workspace } = await setup();
    try {
      const refs = await persistComposerAttachments(workspace, "source", [png]);
      const ref = refs[0];
      if (!ref) throw new Error("Missing fixture reference");
      const path = join(workspace.paths.root, ref.artifact.path);
      if (failure === "missing") await rm(path);
      else await writeFile(path, Buffer.alloc(Buffer.byteLength(png.data, "base64")));
      await expect(resolveComposerAttachmentImages(workspace, refs)).rejects.toThrow();
    } finally {
      await workspace.close();
    }
  },
);
