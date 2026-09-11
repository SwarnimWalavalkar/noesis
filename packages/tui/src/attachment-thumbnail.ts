import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { type } from "arktype";
import {
  COMPOSER_IMAGE_PROJECTION_LIMITS,
  validateComposerAttachmentInputs,
  type ComposerAttachmentInput,
  type ComposerFileInput,
} from "@noesis/domain";
import { attachmentImageDimensions } from "./attachment-input.ts";

export type AttachmentThumbnail = Readonly<{
  data: string;
  mimeType: "image/png";
  width: number;
  height: number;
}>;
const thumbnailDataSchema = type("string").atLeastLength(1).atMostLength(700_000);
const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const photon = require(workerData.modulePath);
let original, thumbnail;
try {
  original = photon.PhotonImage.new_from_byteslice(Buffer.from(workerData.data, 'base64'));
  if (original.get_width() !== workerData.originalWidth || original.get_height() !== workerData.originalHeight) throw Error('Decoded image dimensions do not match header');
  thumbnail = photon.resize(original, workerData.width, workerData.height, photon.SamplingFilter.Triangle);
  const bytes = thumbnail.get_bytes();
  if (bytes.length > 512 * 1024) throw Error('Thumbnail exceeds output limit');
  parentPort.postMessage(Buffer.from(bytes).toString('base64'));
} finally { if (thumbnail) thumbnail.free(); if (original) original.free(); }
`;

/** Decode/resize/PNG encoding are isolated from the interactive event loop. */
async function prepareThumbnail(
  input: ComposerAttachmentInput,
  createWorker: (source: string, options: WorkerOptions) => Worker,
  signal?: AbortSignal,
): Promise<AttachmentThumbnail> {
  signal?.throwIfAborted();
  validateComposerAttachmentInputs([input]);
  const dimensions = attachmentImageDimensions(input);
  const scale = Math.min(1, 320 / dimensions.width, 160 / dimensions.height);
  const width = Math.max(1, Math.round(dimensions.width * scale));
  const height = Math.max(1, Math.round(dimensions.height * scale));
  // Lazy resolution keeps the live source graph importable without loading WASM.
  const modulePath = createRequire(import.meta.url).resolve("@silvia-odwyer/photon-node");
  return new Promise((resolve, reject) => {
    const worker = createWorker(workerSource, {
      eval: true,
      // This eval source is CommonJS regardless of the embedding host's flags.
      execArgv: [],
      workerData: {
        modulePath,
        data: input.data,
        originalWidth: dimensions.width,
        originalHeight: dimensions.height,
        width,
        height,
      },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    let settled = false;
    const finish = (error?: Error, data?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate().then(() => {
        if (error) reject(error);
        else if (data) resolve({ data, mimeType: "image/png", width, height });
      }, reject);
    };
    const onAbort = () => finish(new Error("Thumbnail preparation cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => finish(new Error("Thumbnail preparation timed out.")), 5_000);
    // Worker messages are an I/O boundary; the bounded schema parses them immediately.
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    worker.once("message", (value: unknown) => {
      const result = thumbnailDataSchema(value);
      if (result instanceof type.errors) finish(new Error("Invalid thumbnail worker output."));
      else finish(undefined, result);
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", () => finish(new Error("Thumbnail worker exited without an image.")));
  });
}

// Serialize decoding including termination. Bound all retained payloads, and remove
// cancelled queued jobs rather than retaining them in an unbounded promise chain.
const MAX_PENDING_THUMBNAILS = 8;
const MAX_RETAINED_THUMBNAIL_BYTES = 20 * 1024 * 1024;
interface ThumbnailJob {
  readonly bytes: number;
  readonly start: () => Promise<void>;
}
const pending: ThumbnailJob[] = [];
let active = false;
let retainedBytes = 0;
function drainThumbnails(): void {
  if (active) return;
  const job = pending.shift();
  if (!job) return;
  active = true;
  void job.start().finally(() => {
    retainedBytes -= job.bytes;
    active = false;
    drainThumbnails();
  });
}
export function createAttachmentThumbnail(
  input: ComposerAttachmentInput | ComposerFileInput,
  options: {
    createWorker?: (source: string, options: WorkerOptions) => Worker;
    signal?: AbortSignal;
  } = {},
): Promise<AttachmentThumbnail> {
  const bytes = "sourcePath" in input ? input.sourceSize : Buffer.byteLength(input.data, "base64");
  if (options.signal?.aborted) return Promise.reject(new Error("Thumbnail preparation cancelled."));
  if (pending.length >= MAX_PENDING_THUMBNAILS || retainedBytes + bytes > MAX_RETAINED_THUMBNAIL_BYTES)
    return Promise.reject(new Error("Thumbnail preparation queue is full."));
  return new Promise((resolve, reject) => {
    const cancelQueued = () => {
      const index = pending.indexOf(job);
      if (index < 0) return;
      pending.splice(index, 1);
      retainedBytes -= job.bytes;
      options.signal?.removeEventListener("abort", cancelQueued);
      reject(new Error("Thumbnail preparation cancelled."));
    };
    const job: ThumbnailJob = {
      bytes,
      start: async () => {
        options.signal?.removeEventListener("abort", cancelQueued);
        try {
          resolve(
            await prepareThumbnail(
              "sourcePath" in input ? await readPreviewInput(input, options.signal) : input,
              options.createWorker ?? ((source, workerOptions) => new Worker(source, workerOptions)),
              options.signal,
            ),
          );
        } catch (error) {
          reject(error);
        }
      },
    };
    options.signal?.addEventListener("abort", cancelQueued, { once: true });
    retainedBytes += bytes;
    pending.push(job);
    drainThumbnails();
  });
}

async function readPreviewInput(
  input: ComposerFileInput,
  signal?: AbortSignal,
): Promise<ComposerAttachmentInput> {
  if (input.sourceSize > COMPOSER_IMAGE_PROJECTION_LIMITS.perImageBytes)
    throw new Error("Original retained; preview working-set budget exceeded.");
  signal?.throwIfAborted();
  const file = await open(input.sourcePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== input.sourceSize || before.mtimeMs !== input.sourceMtimeMs)
      throw new Error("Preview source changed.");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      signal?.throwIfAborted();
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await file.stat();
    if (length !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw new Error("Preview source changed.");
    return { name: input.name, mimeType: input.mimeType, data: bytes.subarray(0, length).toString("base64") };
  } finally {
    await file.close();
  }
}
