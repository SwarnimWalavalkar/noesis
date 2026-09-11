import { Worker, type WorkerOptions } from "node:worker_threads";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, truncate } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { COMPOSER_ATTACHMENT_LIMITS } from "@noesis/domain";
import {
  attachmentImageDimensions,
  attachmentPath,
  clipboardCommands,
  clipboardFileCommand,
  readAttachmentPath,
  readClipboardAttachment,
  runClipboardCommand,
} from "../src/attachment-input.ts";
import { createAttachmentThumbnail } from "../src/attachment-thumbnail.ts";

function image(width = 2, height = 1, jpeg = false) {
  const decoded = new PhotonImage(new Uint8Array(width * height * 4).fill(255), width, height);
  try {
    return {
      name: jpeg ? "test.jpg" : "test.png",
      mimeType: jpeg ? "image/jpeg" : "image/png",
      data: Buffer.from(jpeg ? decoded.get_bytes_jpeg(80) : decoded.get_bytes()).toString("base64"),
    };
  } finally {
    decoded.free();
  }
}
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "noesis-attachment-"));
  dirs.push(dir);
  return dir;
}

describe("explicit clipboard access", () => {
  it("constructs argv for macOS, Wayland, X11 and Windows without shell", () => {
    expect(clipboardCommands("darwin", {})[0]).toMatchObject({ command: "osascript", encoding: "base64" });
    expect(clipboardCommands("win32", {})[0]?.args).toContain("-STA");
    expect(clipboardCommands("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" })).toEqual([
      { command: "wl-paste", args: ["--no-newline", "--type", "image/png"], encoding: "binary" },
      { command: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"], encoding: "binary" },
    ]);
  });
  it("never invokes local clipboard over SSH or without a display", async () => {
    const run = vi.fn();
    await expect(
      readClipboardAttachment({ platform: "darwin", env: { SSH_CONNECTION: "remote" }, run }),
    ).rejects.toThrow("/attach");
    await expect(readClipboardAttachment({ platform: "linux", env: {}, run })).rejects.toThrow("/attach");
    expect(run).not.toHaveBeenCalled();
  });
  it("falls back from failed Wayland to X11 and preserves original bytes", async () => {
    const input = image();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce(Buffer.from("image/png"))
      .mockResolvedValueOnce(Buffer.from(input.data, "base64"));
    await expect(
      readClipboardAttachment({ platform: "linux", env: { WAYLAND_DISPLAY: "w", DISPLAY: ":0" }, run }),
    ).resolves.toEqual([{ ...input, name: "clipboard.png" }]);
    expect(run).toHaveBeenCalledTimes(3);
  });
  it("reports empty or oversized clipboard output with /attach fallback", async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(COMPOSER_ATTACHMENT_LIMITS.perFileBytes + 1)]) {
      await expect(
        readClipboardAttachment({ platform: "darwin", env: {}, run: async () => bytes }),
      ).rejects.toThrow("/attach");
    }
  });
  it.each(["darwin", "win32"] as const)(
    "%s file references win over icon data and preserve multiple originals",
    async (platform) => {
      const dir = await directory();
      const paths = [join(dir, "résumé.pdf"), join(dir, "data.bin")];
      const bytes = [Buffer.from("%PDF original"), Buffer.from([0, 255, 17])];
      await Promise.all(paths.map((path, index) => writeFile(path, bytes[index] ?? Buffer.alloc(0))));
      const run = vi.fn(async (_command: import("../src/attachment-input.ts").ClipboardCommand) =>
        Buffer.from(JSON.stringify(paths)),
      );
      const inputs = await readClipboardAttachment({ platform, env: {}, run });
      expect(inputs.map((input) => input.name)).toEqual(["résumé.pdf", "data.bin"]);
      expect(inputs.map((input) => Buffer.from(input.data, "base64"))).toEqual(bytes);
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]).toEqual([
        clipboardFileCommand(
          clipboardCommands(platform, {})[0] ?? { command: "", args: [], encoding: "binary" },
        ),
      ]);
    },
  );
  it.each(["text/uri-list", "x-special/gnome-copied-files"])(
    "reads Linux %s before image targets",
    async (type) => {
      const path = join(await directory(), "a #é.txt");
      await writeFile(path, "original");
      const { pathToFileURL } = await import("node:url");
      const run = vi
        .fn()
        .mockResolvedValueOnce(Buffer.from(`${type}\nimage/png\n`))
        .mockResolvedValueOnce(
          Buffer.from(
            `${type.startsWith("x-special") ? "copy\n" : "# comment\n"}${pathToFileURL(path).href}\r\n`,
          ),
        );
      const inputs = await readClipboardAttachment({ platform: "linux", env: { DISPLAY: ":0" }, run });
      expect(inputs).toEqual([
        { name: "a #é.txt", mimeType: "text/plain", data: Buffer.from("original").toString("base64") },
      ]);
      expect(run).toHaveBeenCalledTimes(2);
    },
  );
  it("fails visibly without icon fallback when any referenced file fails", async () => {
    const dir = await directory();
    const path = join(dir, "good.txt");
    await writeFile(path, "good");
    for (const paths of [[path, join(dir, "missing.pdf")], [dir], Array.from({ length: 9 }, () => path)]) {
      const run = vi.fn(async (_command: import("../src/attachment-input.ts").ClipboardCommand) =>
        Buffer.from(JSON.stringify(paths)),
      );
      await expect(readClipboardAttachment({ platform: "darwin", env: {}, run })).rejects.toThrow("/attach");
      expect(run).toHaveBeenCalledOnce();
    }
  });
  it("preserves genuine clipboard image fallback after an empty file probe", async () => {
    const input = image();
    const run = vi
      .fn()
      .mockResolvedValueOnce(Buffer.from("[]"))
      .mockResolvedValueOnce(Buffer.from(input.data, "base64"));
    await expect(readClipboardAttachment({ platform: "darwin", env: {}, run })).resolves.toEqual([
      { ...input, name: "clipboard.png" },
    ]);
  });
  it("does not turn a failed file probe into an icon", async () => {
    const run = vi.fn().mockRejectedValue(new Error("probe failed"));
    await expect(readClipboardAttachment({ platform: "darwin", env: {}, run })).rejects.toThrow(
      "probe failed",
    );
    expect(run).toHaveBeenCalledOnce();
  });
  it("bounds actual subprocess time and output and rejects invalid base64", async () => {
    const command = { command: process.execPath, encoding: "base64" as const };
    await expect(
      runClipboardCommand({ ...command, args: ["-e", "process.stdout.write('!')"] }),
    ).rejects.toThrow("invalid image data");
    await expect(
      runClipboardCommand({ ...command, args: ["-e", "process.stdout.write('A'.repeat(15*1024*1024))"] }),
    ).rejects.toThrow("failed or timed out");
    await expect(
      runClipboardCommand({ ...command, args: ["-e", "setInterval(()=>{},1000)"] }),
    ).rejects.toThrow("timed out");
  }, 8_000);
});

describe("attachment files", () => {
  it("only expands tilde and matching outer quotes, preserving whitespace and metacharacters", () => {
    expect(attachmentPath("'~/a b'")).toBe(join(homedir(), "a b"));
    expect(attachmentPath(" a $(echo nope) ")).toBe(" a $(echo nope) ");
    expect(attachmentPath('"a b"')).toBe("a b");
    expect(attachmentPath("'unmatched")).toBe("'unmatched");
  });
  it("reads exact bytes, whitespace filenames, and MIME from image bytes not extension", async () => {
    const path = join(await directory(), " image with spaces ");
    const input = image();
    await writeFile(path, Buffer.from(input.data, "base64"));
    await expect(readAttachmentPath(`"${path}"`)).resolves.toEqual({ ...input, name: " image with spaces " });
  });
  it("rejects empty, oversize, missing and non-regular files", async () => {
    const dir = await directory();
    const path = join(dir, "file");
    await writeFile(path, "");
    await expect(readAttachmentPath(path)).rejects.toThrow("empty");
    await truncate(path, COMPOSER_ATTACHMENT_LIMITS.perFileBytes + 1);
    await expect(readAttachmentPath(path)).rejects.toThrow("10 MiB");
    await expect(readAttachmentPath(dir)).rejects.toThrow("regular file");
    await expect(readAttachmentPath(join(dir, "missing"))).rejects.toThrow();
  });
  it.skipIf(process.platform === "win32")(
    "rejects FIFO without waiting for a writer",
    async () => {
      const path = join(await directory(), "pipe");
      execFileSync("mkfifo", [path]);
      await expect(readAttachmentPath(path)).rejects.toThrow("regular file");
    },
    1_000,
  );
});

describe("image preparation", () => {
  it("bounds dimensions before decoding", () => {
    expect(attachmentImageDimensions(image())).toEqual({ width: 2, height: 1 });
    const bytes = Buffer.from(image().data, "base64");
    bytes.writeUInt32BE(100_000, 16);
    expect(() => attachmentImageDimensions({ ...image(), data: bytes.toString("base64") })).toThrow(
      "dimensions",
    );
    expect(() => attachmentImageDimensions({ name: "bad.png", mimeType: "image/png", data: "AAAA" })).toThrow(
      "dimensions",
    );
  });
  it("asynchronously produces compact PNG even from original JPEG", async () => {
    const input = image(640, 320, true);
    const original = input.data;
    const result = await createAttachmentThumbnail(input);
    expect(result).toMatchObject({ mimeType: "image/png", width: 320, height: 160 });
    expect(Buffer.from(result.data, "base64").subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(result.data.length).toBeLessThan(700_000);
    expect(input.data).toBe(original);
  });
  it("does not inherit embedding host flags such as --input-type=module", async () => {
    const createWorker = vi.fn((source: string, options: WorkerOptions) => {
      expect(options.eval).toBe(true);
      expect(options.execArgv).toEqual([]);
      return new Worker(source, options);
    });
    await expect(createAttachmentThumbnail(image(), { createWorker })).resolves.toMatchObject({
      mimeType: "image/png",
    });
    expect(createWorker).toHaveBeenCalledOnce();
  });
  it("serializes concurrent decodes including termination and recovers after failure", async () => {
    const workerCounts = { active: 0, peak: 0 };
    const options = {
      createWorker: (source: string, workerOptions: WorkerOptions) => {
        const worker = new Worker(source, workerOptions);
        workerCounts.active += 1;
        workerCounts.peak = Math.max(workerCounts.peak, workerCounts.active);
        worker.once("exit", () => {
          workerCounts.active -= 1;
        });
        return worker;
      },
    };
    const input = image();
    const invalid = { ...input, data: Buffer.from(input.data, "base64").subarray(0, 24).toString("base64") };
    const results = await Promise.allSettled([
      createAttachmentThumbnail(invalid, options),
      ...Array.from({ length: 8 }, () => createAttachmentThumbnail(input, options)),
    ]);
    expect(results[0]?.status).toBe("rejected");
    expect(results.slice(1).every((result) => result.status === "fulfilled")).toBe(true);
    expect(workerCounts.peak).toBe(1);
    expect(workerCounts.active).toBe(0);
  });
  it("does not upscale and rejects a corrupt decode without hanging", async () => {
    await expect(createAttachmentThumbnail(image())).resolves.toMatchObject({ width: 2, height: 1 });
    const input = image();
    await expect(
      createAttachmentThumbnail({
        ...input,
        data: Buffer.from(input.data, "base64").subarray(0, 24).toString("base64"),
      }),
    ).rejects.toThrow();
  });
});
