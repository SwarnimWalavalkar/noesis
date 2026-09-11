import { captureClipboardToFile, disposeAttachmentInput } from "./attachment-capture.ts";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { type ComposerFileInput } from "@noesis/domain";

export const ATTACHMENT_INPUT_TIMEOUT_MS = 3_000;
export { attachmentImageDimensions, MAX_IMAGE_PIXELS, MAX_IMAGE_DIMENSION } from "@noesis/domain";
const fallback = "Use /attach <path> instead.";
export type ClipboardCommand = Readonly<{
  command: string;
  args: readonly string[];
  encoding: "binary" | "base64";
}>;

/** Pure construction; clipboard access happens only on explicit invocation. */
export function clipboardCommands(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): readonly ClipboardCommand[] {
  if (env["SSH_CONNECTION"] || env["SSH_CLIENT"] || env["SSH_TTY"])
    throw new Error(`Clipboard unavailable in SSH sessions. ${fallback}`);
  if (platform === "darwin")
    return [
      {
        command: "osascript",
        args: [
          "-l",
          "JavaScript",
          "-e",
          `ObjC.import('AppKit'); var p = $.NSPasteboard.generalPasteboard; var d = p.dataForType('public.png'); if (!d || d.isNil()) { var t = p.dataForType('public.tiff'); if (!t || t.isNil()) throw Error('No clipboard image'); var r = $.NSBitmapImageRep.imageRepWithData(t); d = r.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({})); } if (!d || d.isNil()) throw Error('No clipboard image'); ObjC.unwrap(d.base64EncodedStringWithOptions(0));`,
        ],
        encoding: "base64",
      },
    ];
  if (platform === "win32")
    return [
      {
        command: "powershell.exe",
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-STA",
          "-Command",
          "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $i=[System.Windows.Forms.Clipboard]::GetImage(); if ($null -eq $i) { throw 'No clipboard image' }; $s=New-Object System.IO.MemoryStream; try { $i.Save($s,[System.Drawing.Imaging.ImageFormat]::Png); [Console]::Out.Write([Convert]::ToBase64String($s.ToArray())) } finally { $s.Dispose(); $i.Dispose() }",
        ],
        encoding: "base64",
      },
    ];
  if (platform === "linux") {
    const commands: ClipboardCommand[] = [];
    if (env["WAYLAND_DISPLAY"])
      commands.push({
        command: "wl-paste",
        args: ["--no-newline", "--type", "image/png"],
        encoding: "binary",
      });
    if (env["DISPLAY"])
      commands.push({
        command: "xclip",
        args: ["-selection", "clipboard", "-t", "image/png", "-o"],
        encoding: "binary",
      });
    if (commands.length) return commands;
  }
  throw new Error(`No supported local image clipboard available. ${fallback}`);
}

/** Probe file representations before requesting any image (which may be a file icon). */
export function clipboardFileCommand(image: ClipboardCommand): ClipboardCommand {
  if (image.command === "osascript")
    return {
      command: image.command,
      encoding: "binary",
      args: [
        "-l",
        "JavaScript",
        "-e",
        `ObjC.import('AppKit'); var p=$.NSPasteboard.generalPasteboard; var a=p.propertyListForType('NSFilenamesPboardType'); var paths=[]; if (a && !a.isNil()) { paths=ObjC.deepUnwrap(a); } else { var urls=p.readObjectsForClassesOptions([$.NSURL], $({'NSPasteboardURLReadingFileURLsOnlyKey':true})); if (urls && !urls.isNil()) for(var i=0;i<urls.count;i++) paths.push(ObjC.unwrap(urls.objectAtIndex(i).path)); } if (!paths.length && (p.types.containsObject('public.file-url') || p.types.containsObject('NSFilenamesPboardType'))) throw Error('Empty clipboard file references'); JSON.stringify(paths);`,
      ],
    };
  if (image.command === "powershell.exe")
    return {
      command: image.command,
      encoding: "binary",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-Command",
        "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); Add-Type -AssemblyName System.Windows.Forms; $paths=@([System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }); if ([System.Windows.Forms.Clipboard]::ContainsFileDropList() -and $paths.Count -eq 0) { throw 'Empty clipboard file references' }; [Console]::Out.Write((ConvertTo-Json -InputObject $paths -Compress))",
      ],
    };
  return {
    command: image.command,
    encoding: "binary",
    args:
      image.command === "wl-paste" ? ["--list-types"] : ["-selection", "clipboard", "-t", "TARGETS", "-o"],
  };
}

function referencedPaths(bytes: Buffer): readonly string[] {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !Array.isArray(value) ||
    !value.every(
      (path): path is string => typeof path === "string" && path.length > 0 && !path.includes("\0"),
    )
  )
    throw new Error("Invalid clipboard file references.");
  return value;
}

function uriPaths(bytes: Buffer, copiedFiles: boolean): readonly string[] {
  const lines = bytes.toString("utf8").split(/\r?\n/u);
  if (copiedFiles && !["copy", "cut"].includes(lines.shift() ?? ""))
    throw new Error("Invalid copied-file clipboard header.");
  const paths = lines
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const url = new URL(line);
      if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost"))
        throw new Error("Clipboard references a non-local file.");
      return fileURLToPath(url);
    });
  if (!paths.length) throw new Error("Clipboard file representation is empty.");
  return paths;
}

export function runClipboardCommand(command: ClipboardCommand, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      command.command,
      [...command.args],
      {
        encoding: "buffer",
        signal,
        timeout: ATTACHMENT_INPUT_TIMEOUT_MS,
        // File-reference metadata only; image pixels are spooled with backpressure.
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        killSignal: "SIGKILL",
      },
      (error, stdout) => {
        if (error) {
          reject(new Error(`Clipboard helper ${command.command} failed or timed out. ${fallback}`));
          return;
        }
        if (command.encoding === "binary") {
          resolve(stdout);
          return;
        }
        const text = stdout.toString("utf8").trim();
        const bytes = Buffer.from(text, "base64");
        if (!text || bytes.toString("base64") !== text) {
          reject(new Error(`Clipboard helper returned invalid image data. ${fallback}`));
          return;
        }
        resolve(bytes);
      },
    );
  });
}

function attachmentMimeType(name: string, bytes: Buffer): string {
  let mimeType = "application/octet-stream";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mimeType = "image/png";
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mimeType = "image/jpeg";
  else if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) mimeType = "image/gif";
  else if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    mimeType = "image/webp";
  else if (extname(name).toLowerCase() === ".txt") mimeType = "text/plain";
  else if (extname(name).toLowerCase() === ".pdf") mimeType = "application/pdf";
  return mimeType;
}

export async function readClipboardAttachment(
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    run?: (command: ClipboardCommand) => Promise<Buffer>;
    signal?: AbortSignal;
  } = {},
): Promise<readonly ComposerFileInput[]> {
  options.signal?.throwIfAborted();
  const commands = clipboardCommands(options.platform ?? process.platform, options.env ?? process.env);
  const run = options.run ?? ((command: ClipboardCommand) => runClipboardCommand(command, options.signal));
  let requireFiles = false;
  for (const command of commands) {
    let probe: Buffer;
    try {
      probe = await run(clipboardFileCommand(command));
    } catch (error) {
      options.signal?.throwIfAborted();
      // Another display backend may be available, but never request an image from
      // a backend whose file representations could not be inspected.
      if (command !== commands.at(-1)) continue;
      throw new Error(
        `Could not inspect clipboard files: ${error instanceof Error ? error.message : "unknown error"} ${fallback}`,
      );
    }
    try {
      let paths: readonly string[];
      if (command.command === "osascript" || command.command === "powershell.exe")
        paths = referencedPaths(probe);
      else {
        const types = probe.toString("utf8").split(/\r?\n/u);
        const type = ["x-special/gnome-copied-files", "text/uri-list"].find((candidate) =>
          types.includes(candidate),
        );
        if (type) {
          requireFiles = true;
          let references: Buffer;
          try {
            references = await run({
              ...command,
              args:
                command.command === "wl-paste"
                  ? ["--no-newline", "--type", type]
                  : ["-selection", "clipboard", "-t", type, "-o"],
            });
          } catch (error) {
            options.signal?.throwIfAborted();
            // Another backend may supply the original file references, but an icon
            // can never substitute for an advertised file representation.
            if (command !== commands.at(-1)) continue;
            throw error;
          }
          paths = uriPaths(references, type === "x-special/gnome-copied-files");
        } else paths = [];
      }
      if (paths.length) {
        const inputs: ComposerFileInput[] = [];
        for (const path of paths) {
          try {
            options.signal?.throwIfAborted();
            inputs.push(await readAttachmentFile(path, options.signal));
          } catch (error) {
            options.signal?.throwIfAborted();
            throw new Error(
              `Could not read copied file ${path}: ${error instanceof Error ? error.message : "unknown error"}`,
            );
          }
        }
        return inputs;
      }
      if (requireFiles) throw new Error("Clipboard file references could not be read from any backend.");
      let capturedPath: string;
      try {
        capturedPath = await captureClipboardToFile(
          command,
          options.signal,
          options.run ? await run(command) : undefined,
        );
      } catch (error) {
        options.signal?.throwIfAborted();
        if (command !== commands.at(-1)) continue;
        throw error;
      }
      try {
        const input = await readAttachmentFile(capturedPath, options.signal);
        if (input.mimeType !== "image/png") throw new Error("Clipboard did not contain PNG image data.");
        return [input];
      } catch (error) {
        await disposeAttachmentInput({ sourcePath: capturedPath });
        options.signal?.throwIfAborted();
        if (command !== commands.at(-1)) continue;
        throw error;
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      throw new Error(
        `Could not read clipboard attachment: ${error instanceof Error ? error.message : "unknown error"} ${fallback}`,
      );
    }
  }
  throw new Error(`No local clipboard available. ${fallback}`);
}

/** Only remove matching outer quotes and expand a leading ~/; never trim or evaluate. */
export function attachmentPath(value: string): string {
  let path = value;
  if (
    path.length >= 2 &&
    ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'")))
  )
    path = path.slice(1, -1);
  if (!path || path.includes("\0")) throw new Error("Provide a non-empty attachment path.");
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export async function readAttachmentPath(value: string, signal?: AbortSignal): Promise<ComposerFileInput> {
  return readAttachmentFile(attachmentPath(value), signal);
}

async function readAttachmentFile(path: string, signal?: AbortSignal): Promise<ComposerFileInput> {
  signal?.throwIfAborted();
  // O_NONBLOCK prevents FIFO open hangs; fstat checks the opened object, not a racy pathname.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Attachment must be a regular file.");
    // Only sniff a small header; source bytes stay on disk until streamed admission.
    const header = Buffer.alloc(Math.min(stat.size, 64 * 1024));
    let length = 0;
    while (length < header.length) {
      signal?.throwIfAborted();
      const read = await file.read(header, length, header.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    signal?.throwIfAborted();
    const name = basename(path);
    return {
      name,
      mimeType: attachmentMimeType(name, header.subarray(0, length)),
      sourcePath: path,
      sourceSize: stat.size,
      sourceMtimeMs: stat.mtimeMs,
      sourceCtimeMs: stat.ctimeMs,
      sourceIno: stat.ino,
      sourceDev: stat.dev,
    };
  } finally {
    await file.close();
  }
}
