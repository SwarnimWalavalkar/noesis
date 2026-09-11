import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { getImageDimensions } from "@earendil-works/pi-tui";
import {
  COMPOSER_ATTACHMENT_LIMITS,
  validateComposerAttachmentInputs,
  type ComposerAttachmentInput,
} from "@noesis/domain";

export const ATTACHMENT_INPUT_TIMEOUT_MS = 3_000;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const MAX_IMAGE_DIMENSION = 16_384;
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

export function runClipboardCommand(command: ClipboardCommand): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      command.command,
      [...command.args],
      {
        encoding: "buffer",
        timeout: ATTACHMENT_INPUT_TIMEOUT_MS,
        maxBuffer: 4 * Math.ceil(COMPOSER_ATTACHMENT_LIMITS.perFileBytes / 3) + 1024,
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

export function attachmentImageDimensions(input: ComposerAttachmentInput): { width: number; height: number } {
  const dimensions = getImageDimensions(input.data, input.mimeType);
  if (
    !dimensions ||
    dimensions.widthPx < 1 ||
    dimensions.heightPx < 1 ||
    dimensions.widthPx > MAX_IMAGE_DIMENSION ||
    dimensions.heightPx > MAX_IMAGE_DIMENSION ||
    dimensions.widthPx * dimensions.heightPx > MAX_IMAGE_PIXELS
  )
    throw new Error("Image dimensions are invalid or exceed the 16 megapixel preview limit.");
  return { width: dimensions.widthPx, height: dimensions.heightPx };
}

function prepare(name: string, bytes: Buffer): ComposerAttachmentInput {
  if (!bytes.length) throw new Error("Attachment is empty.");
  if (bytes.length > COMPOSER_ATTACHMENT_LIMITS.perFileBytes)
    throw new Error("Attachment exceeds the 10 MiB file limit.");
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
  const input = { name, mimeType, data: bytes.toString("base64") };
  validateComposerAttachmentInputs([input]);
  if (mimeType.startsWith("image/")) attachmentImageDimensions(input);
  return input;
}

export async function readClipboardAttachment(
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    run?: (command: ClipboardCommand) => Promise<Buffer>;
  } = {},
): Promise<readonly ComposerAttachmentInput[]> {
  const commands = clipboardCommands(options.platform ?? process.platform, options.env ?? process.env);
  const run = options.run ?? runClipboardCommand;
  for (const command of commands) {
    let probe: Buffer;
    try {
      probe = await run(clipboardFileCommand(command));
    } catch (error) {
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
        paths = type
          ? uriPaths(
              await run({
                ...command,
                args:
                  command.command === "wl-paste"
                    ? ["--no-newline", "--type", type]
                    : ["-selection", "clipboard", "-t", type, "-o"],
              }),
              type === "x-special/gnome-copied-files",
            )
          : [];
      }
      if (paths.length) {
        if (paths.length > COMPOSER_ATTACHMENT_LIMITS.count)
          throw new Error("Up to 8 attachments per message.");
        const inputs: ComposerAttachmentInput[] = [];
        for (const path of paths) {
          try {
            inputs.push(await readAttachmentFile(path));
          } catch (error) {
            throw new Error(
              `Could not read copied file ${path}: ${error instanceof Error ? error.message : "unknown error"}`,
            );
          }
          validateComposerAttachmentInputs(inputs);
        }
        return inputs;
      }
      const input = prepare("clipboard.png", await run(command));
      if (input.mimeType !== "image/png") throw new Error("Clipboard did not contain PNG image data.");
      return [input];
    } catch (error) {
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

export async function readAttachmentPath(value: string): Promise<ComposerAttachmentInput> {
  return readAttachmentFile(attachmentPath(value));
}

async function readAttachmentFile(path: string): Promise<ComposerAttachmentInput> {
  // O_NONBLOCK prevents FIFO open hangs; fstat checks the opened object, not a racy pathname.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Attachment must be a regular file.");
    if (stat.size > COMPOSER_ATTACHMENT_LIMITS.perFileBytes)
      throw new Error("Attachment exceeds the 10 MiB file limit.");
    const bytes = Buffer.alloc(Math.min(stat.size + 1, COMPOSER_ATTACHMENT_LIMITS.perFileBytes + 1));
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== stat.size) throw new Error("Attachment changed while being read; please retry.");
    return prepare(basename(path), bytes.subarray(0, length));
  } finally {
    await file.close();
  }
}
