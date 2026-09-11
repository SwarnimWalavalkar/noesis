import { createRequire } from "node:module";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { type } from "arktype";
import { validateComposerAttachmentInputs, type ComposerAttachmentInput } from "@noesis/domain";
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
): Promise<AttachmentThumbnail> {
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
      void worker.terminate().then(() => {
        if (error) reject(error);
        else if (data) resolve({ data, mimeType: "image/png", width, height });
      }, reject);
    };
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

// Serialize decoding globally, including worker termination: WASM memory is not
// constrained by V8's heap limit. The composer separately bounds queued inputs.
let thumbnailQueue: Promise<void> = Promise.resolve();
export function createAttachmentThumbnail(
  input: ComposerAttachmentInput,
  options: { createWorker?: (source: string, options: WorkerOptions) => Worker } = {},
): Promise<AttachmentThumbnail> {
  const result = thumbnailQueue.then(() =>
    prepareThumbnail(
      input,
      options.createWorker ?? ((source, workerOptions) => new Worker(source, workerOptions)),
    ),
  );
  thumbnailQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
