import { mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ComposerFileInput } from "@noesis/domain";
import { createWorkspaceStore } from "@noesis/workspace";
import {
  persistComposerAttachments,
  projectComposerAttachmentImages,
  renderComposerAttachmentText,
} from "../src/index.ts";
import { composerManifestPath } from "../src/composer-files.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "noesis-large-attachments-"));
  roots.push(root);
  const workspace = await createWorkspaceStore(join(root, "workspace"));
  await workspace.operational.sessions.put({
    sessionId: "source",
    title: "large",
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
async function selected(sourcePath: string): Promise<ComposerFileInput> {
  const info = await stat(sourcePath);
  return {
    name: basename(sourcePath),
    mimeType: "application/octet-stream",
    sourcePath,
    sourceSize: info.size,
    sourceMtimeMs: info.mtimeMs,
    sourceCtimeMs: info.ctimeMs,
    sourceDev: info.dev,
    sourceIno: info.ino,
  };
}

test("many, large and empty originals survive source deletion; restored refs do not read contents and complete manifest is bounded in prompts", async () => {
  const { root, workspace } = await setup();
  try {
    const inputs: ComposerFileInput[] = [];
    for (let index = 0; index < 12; index++) {
      const path = join(root, `file-${index}.bin`);
      const file = await open(path, "wx");
      await file.truncate(index < 2 ? 16 * 1024 * 1024 + index : 0);
      await file.close();
      inputs.push(await selected(path));
    }
    const refs = await persistComposerAttachments(workspace, "source", inputs);
    expect(refs).toHaveLength(12);
    await Promise.all(inputs.map((input) => rm(input.sourcePath)));
    const readArtifact = vi.fn(workspace.reads.readArtifact);
    const instrumented = { ...workspace, reads: { ...workspace.reads, readArtifact } };
    expect(await persistComposerAttachments(instrumented, "source", refs)).toEqual(refs);
    expect((await projectComposerAttachmentImages(instrumented, refs)).images).toEqual([]);
    expect(readArtifact).not.toHaveBeenCalled();
    for (const [index, ref] of refs.entries())
      expect((await stat(join(workspace.paths.root, ref.artifact.path))).size).toBe(
        inputs[index]?.sourceSize,
      );
    const rendered = renderComposerAttachmentText("question", refs, workspace.paths.root);
    expect(rendered.length).toBeLessThan(5000);
    expect(rendered).toContain("Showing 8 of 12");
    const manifest = await readFile(join(workspace.paths.artifacts, composerManifestPath(refs)), "utf8");
    expect(
      manifest
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(refs);
    await workspace.operational.userIntents.enqueue({
      intentId: "many",
      sessionId: "source",
      text: "",
      attachments: refs,
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect((await workspace.operational.userIntents.listPending("source"))[0]?.attachments).toEqual(refs);
  } finally {
    await workspace.close();
  }
});

test("source replacement with preserved size/mtime rejects before any batch writes; failed imports retry without duplicating completed originals", async () => {
  const { root, workspace } = await setup();
  try {
    const firstPath = join(root, "first.bin"),
      secondPath = join(root, "second.bin");
    await writeFile(firstPath, "first");
    await writeFile(secondPath, "ABC");
    const first = await selected(firstPath),
      second = await selected(secondPath);
    await rm(secondPath);
    await writeFile(secondPath, "XYZ");
    await utimes(secondPath, new Date(), second.sourceMtimeMs / 1000);
    const before = await readdir(workspace.paths.artifacts, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(persistComposerAttachments(workspace, "source", [first, second])).rejects.toThrow(
        "changed",
      );
    expect(await readdir(workspace.paths.artifacts, { recursive: true })).toEqual(before);
    const fresh = await selected(secondPath);
    const failing = {
      ...workspace,
      artifacts: {
        ...workspace.artifacts,
        importArtifact: vi.fn(async (request: Parameters<typeof workspace.artifacts.importArtifact>[0]) => {
          if (request.sourcePath === secondPath) throw new Error("ENOSPC fixture");
          return workspace.artifacts.importArtifact(request);
        }),
      },
    };
    await expect(persistComposerAttachments(failing, "source", [first, fresh])).rejects.toThrow("ENOSPC");
    const afterFirstFailure = await readdir(workspace.paths.artifacts, { recursive: true });
    await expect(persistComposerAttachments(failing, "source", [first, fresh])).rejects.toThrow("ENOSPC");
    expect(await readdir(workspace.paths.artifacts, { recursive: true })).toEqual(afterFirstFailure);
    expect(await persistComposerAttachments(workspace, "source", [first, fresh])).toHaveLength(2);
  } finally {
    await workspace.close();
  }
});

test("streamed import cancellation terminates before a large file is read and removes partial staging", async () => {
  const { root, workspace } = await setup();
  try {
    const path = join(root, "large.bin");
    const file = await open(path, "wx");
    await file.truncate(256 * 1024 * 1024);
    await file.close();
    const controller = new AbortController();
    const pending = persistComposerAttachments(
      workspace,
      "source",
      [await selected(path)],
      controller.signal,
    );
    let observedPartial = false;
    const timer = setInterval(() => {
      void (async () => {
        for (const entry of await readdir(workspace.paths.artifacts, { recursive: true })) {
          if (!entry.endsWith(".tmp")) continue;
          const info = await stat(join(workspace.paths.artifacts, entry)).catch(() => undefined);
          if (info && info.size > 0) {
            observedPartial = true;
            controller.abort();
          }
        }
      })();
    }, 1);
    try {
      await expect(pending).rejects.toThrow();
    } finally {
      clearInterval(timer);
    }
    expect(observedPartial).toBe(true);
    const paths = await readdir(workspace.paths.artifacts, { recursive: true });
    expect(paths.some((path) => path.endsWith(".tmp") || path.endsWith("large.bin"))).toBe(false);
  } finally {
    await workspace.close();
  }
}, 5000);

test("large inline API payloads use chunked spool/import rather than whole-byte artifact writes", async () => {
  const { workspace } = await setup();
  try {
    const writeArtifact = vi.fn(workspace.artifacts.writeArtifact);
    const importArtifact = vi.fn(workspace.artifacts.importArtifact);
    const refs = await persistComposerAttachments(
      { ...workspace, artifacts: { ...workspace.artifacts, writeArtifact, importArtifact } },
      "source",
      [
        {
          name: "inline.bin",
          mimeType: "application/octet-stream",
          data: Buffer.alloc(21 * 1024 * 1024).toString("base64"),
        },
      ],
    );
    expect(writeArtifact).not.toHaveBeenCalled();
    expect(importArtifact).toHaveBeenCalledOnce();
    const ref = refs[0];
    if (!ref) throw new Error("Missing inline artifact");
    expect((await workspace.reads.inspectArtifact(ref.artifact)).byteLength).toBe(21 * 1024 * 1024);
  } finally {
    await workspace.close();
  }
});
