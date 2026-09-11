import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ComposerDraftAttachment } from "@noesis/domain";
import type { ClipboardCommand } from "./attachment-input.ts";

const owned = new Map<string, string>();
let capturing = false;
export async function disposeAttachmentInput(
  input: ComposerDraftAttachment | { readonly sourcePath: string },
): Promise<void> {
  if (!("sourcePath" in input)) return;
  const directory = owned.get(input.sourcePath);
  if (!directory) return;
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  owned.delete(input.sourcePath);
}

/** Image stdout is piped to an owned file, with backpressure and bounded base64 carry. */
export async function captureClipboardToFile(
  command: ClipboardCommand,
  signal?: AbortSignal,
  fixtureBytes?: Buffer,
): Promise<string> {
  signal?.throwIfAborted();
  if (capturing) throw new Error("Clipboard capture is already running; wait before trying again.");
  capturing = true;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "noesis-clipboard-"));
    signal?.throwIfAborted();
    const path = join(directory, "clipboard.png");
    if (fixtureBytes) await writeFile(path, fixtureBytes, { mode: 0o600 });
    else {
      const child = spawn(command.command, [...command.args], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      const abort = () => child.kill("SIGKILL");
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 3000);
      let carry = "";
      const decoder = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          try {
            const text = carry + chunk.toString("latin1").replaceAll(/\s/gu, "");
            if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(text)) throw new Error("Invalid clipboard base64");
            const length = Math.max(0, Math.floor((text.length - 4) / 4) * 4);
            const part = text.slice(0, length);
            if (part.includes("=")) throw new Error("Invalid clipboard base64 padding");
            carry = text.slice(length);
            done(null, Buffer.from(part, "base64"));
          } catch (error) {
            done(error instanceof Error ? error : new Error("Invalid clipboard data"));
          }
        },
        flush(done) {
          const bytes = Buffer.from(carry, "base64");
          if (bytes.toString("base64") !== carry) done(new Error("Invalid clipboard base64"));
          else done(null, bytes);
        },
      });
      try {
        const exited = new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) =>
            code === 0 ? resolve() : reject(new Error("Clipboard helper failed or timed out.")),
          );
        });
        const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
        await Promise.all([
          command.encoding === "base64"
            ? pipeline(child.stdout, decoder, output)
            : pipeline(child.stdout, output),
          exited,
        ]);
        signal?.throwIfAborted();
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    }
    signal?.throwIfAborted();
    owned.set(path, directory);
    return path;
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    throw error;
  } finally {
    capturing = false;
  }
}
