import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, lstatSync, realpathSync, type WriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { createConditionalObject, type JsonValue, sha256 } from "@noesis/domain";
import { createEffectExecutionFailure } from "@noesis/policy";
import { z } from "zod";
import { defineTool, type ToolDefinition } from "./index.ts";
import { MAX_TOOL_TEXT_BYTES } from "./limits.ts";
const textBound = z.string().max(MAX_TOOL_TEXT_BYTES);
const pathSchema = z.string().trim().min(1).max(4096);
const PROCESS_TERMINATION_GRACE_MS = 500;
export const DEFAULT_MAX_SHELL_OUTPUT_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const FALLBACK_SEARCH_MAX_FILES = 10000;
const FALLBACK_SEARCH_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const FALLBACK_SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;
const FALLBACK_SEARCH_MAX_LINE_BYTES = 4 * 1024;
const FALLBACK_SEARCH_MAX_RETAINED_BYTES = 64 * 1024;
const FALLBACK_SEARCH_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);
function resolvedPath(cwd: string, path: string): string {
  return resolve(cwd, path);
}
function isWithin(root: string, path: string): boolean {
  const displacement = relative(root, path);
  return (
    displacement === "" ||
    (displacement !== ".." && !displacement.startsWith(`..${sep}`) && !isAbsolute(displacement))
  );
}
function projectPath(root: string, path: string): string {
  const requested = resolvedPath(root, path);
  if (!isWithin(root, requested)) throw new Error(`Path is outside the active project: ${path}`);
  let existing = requested;
  while (true) {
    try {
      lstatSync(existing);
      break;
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"))
        throw error;
      const parent = dirname(existing);
      if (parent === existing) throw new Error(`Path has no existing project ancestor: ${path}`);
      existing = parent;
    }
  }
  let canonicalAncestor: string;
  try {
    canonicalAncestor = realpathSync(existing);
  } catch {
    throw new Error(`Path contains an unresolved symbolic link: ${path}`);
  }
  const canonical = resolve(canonicalAncestor, relative(existing, requested));
  if (!isWithin(root, canonical))
    throw new Error(`Path escapes the active project through a symbolic link: ${path}`);
  return canonical;
}
interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
  readonly fullOutputLength: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly fullOutputComplete: boolean;
}
interface ProcessOutputCaptureAppendResult {
  readonly writable: boolean;
  readonly complete: boolean;
}
interface ProcessOutputCapture {
  readonly append: (value: string) => ProcessOutputCaptureAppendResult;
  readonly waitForDrain: () => Promise<boolean>;
  readonly finish: () => Promise<boolean>;
}
function createProcessOutputCapture(path: string, maximumBytes: number): ProcessOutputCapture {
  const stream: WriteStream = createWriteStream(path, { flags: "wx", mode: 0o600 });
  let failure: Error | undefined;
  let writtenBytes = 0;
  let complete = true;
  let completion: Promise<boolean> | undefined;
  stream.on("error", (error) => {
    failure = error;
    complete = false;
  });
  return Object.freeze({
    append: (value: string) => {
      if (!value || failure || stream.destroyed || writtenBytes >= maximumBytes) {
        if (value) complete = false;
        return Object.freeze({ writable: true, complete });
      }
      const accepted = truncateUtf8(value, maximumBytes - writtenBytes);
      const chunk = Buffer.from(accepted, "utf8");
      writtenBytes += chunk.byteLength;
      if (accepted.length < value.length) complete = false;
      const writable = chunk.byteLength === 0 || stream.write(chunk);
      return Object.freeze({ writable, complete });
    },
    waitForDrain: () => {
      if (failure || stream.destroyed) return Promise.resolve(false);
      if (!stream.writableNeedDrain) return Promise.resolve(true);
      return new Promise<boolean>((resolveDrain) => {
        const onError = (): void => {
          stream.off("drain", onDrain);
          complete = false;
          resolveDrain(false);
        };
        const onDrain = (): void => {
          stream.off("error", onError);
          resolveDrain(true);
        };
        stream.once("error", onError);
        stream.once("drain", onDrain);
      });
    },
    finish: () => {
      completion ??= new Promise<boolean>((resolveFinish) => {
        if (failure || stream.destroyed) {
          resolveFinish(false);
          return;
        }
        const onError = (): void => {
          stream.off("finish", onFinish);
          complete = false;
          resolveFinish(false);
        };
        const onFinish = (): void => {
          stream.off("error", onError);
          resolveFinish(complete);
        };
        stream.once("error", onError);
        stream.once("finish", onFinish);
        stream.end();
      });
      return completion;
    },
  });
}
async function runProcess(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number | undefined;
  readonly maxOutputBytes?: number;
  readonly fullOutputPath?: string;
  readonly maxFullOutputBytes?: number;
}): Promise<ProcessResult> {
  if (input.signal.aborted)
    throw createEffectExecutionFailure("cancelled", "Process was cancelled before it started");
  const maximum = input.maxOutputBytes ?? MAX_TOOL_TEXT_BYTES;
  const capture = input.fullOutputPath
    ? createProcessOutputCapture(
        input.fullOutputPath,
        input.maxFullOutputBytes ?? DEFAULT_MAX_SHELL_OUTPUT_ARTIFACT_BYTES,
      )
    : undefined;
  return await new Promise<ProcessResult>((resolveResult, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: process.env,
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const outputChunks: string[] = [];
    let outputStart = 0;
    let outputBytes = 0;
    let bytes = 0;
    let fullOutputLength = 0;
    let fullOutputComplete = true;
    let truncated = false;
    let settled = false;
    let terminationReason: "cancelled" | "timeout" | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();
    const appendOutputTail = (decoded: string): void => {
      outputChunks.push(decoded);
      outputBytes += Buffer.byteLength(decoded, "utf8");
      while (outputBytes > maximum) {
        const first = outputChunks[outputStart];
        if (first === undefined) return;
        const firstBytes = Buffer.byteLength(first, "utf8");
        const excess = outputBytes - maximum;
        if (firstBytes <= excess) {
          outputStart += 1;
          outputBytes -= firstBytes;
          continue;
        }
        const retained = truncateUtf8Tail(first, firstBytes - excess);
        outputChunks[outputStart] = retained;
        outputBytes += Buffer.byteLength(retained, "utf8") - firstBytes;
      }
      if (outputStart > 64 && outputStart * 2 > outputChunks.length) {
        outputChunks.splice(0, outputStart);
        outputStart = 0;
      }
    };
    const appendDecoded = (kind: "stdout" | "stderr", decoded: string): boolean => {
      if (!decoded) return true;
      fullOutputLength += decoded.length;
      appendOutputTail(decoded);
      const remaining = Math.max(0, maximum - bytes);
      const accepted = truncateUtf8(decoded, remaining);
      if (kind === "stdout") stdout += accepted;
      else stderr += accepted;
      bytes += Buffer.byteLength(accepted, "utf8");
      if (accepted.length < decoded.length) truncated = true;
      const captureResult = capture?.append(decoded);
      if (captureResult && !captureResult.complete) fullOutputComplete = false;
      return captureResult?.writable ?? true;
    };
    const flushOutput = (): void => {
      appendDecoded("stdout", stdoutDecoder.decode());
      appendDecoded("stderr", stderrDecoder.decode());
    };
    const killTree = (signal: NodeJS.Signals): void => {
      try {
        if (detached && child.pid !== undefined) {
          // The process group can outlive its leader, so target it even after the direct child exits.
          process.kill(-child.pid, signal);
        } else if (child.exitCode === null && child.signalCode === null) {
          child.kill(signal);
        }
      } catch {
        // The process may have exited between the state check and signal delivery.
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill(signal);
          } catch {
            // A second ESRCH-style race means the desired terminal state is already reached.
          }
        }
      }
    };
    const terminate = (reason: "cancelled" | "timeout"): void => {
      if (terminationReason) return;
      terminationReason = reason;
      killTree("SIGTERM");
      forceKillTimer = setTimeout(() => {
        killTree("SIGKILL");
      }, PROCESS_TERMINATION_GRACE_MS);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal.removeEventListener("abort", cancel);
    };
    const rejectOnce = (cause: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void (capture?.finish() ?? Promise.resolve(true)).then(() => reject(cause), reject);
    };
    let captureBackpressured = false;
    const append = (kind: "stdout" | "stderr", chunk: Buffer | string): void => {
      const encoded = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const decoded =
        kind === "stdout"
          ? stdoutDecoder.decode(encoded, { stream: true })
          : stderrDecoder.decode(encoded, { stream: true });
      const captureWritable = appendDecoded(kind, decoded);
      if (captureWritable || !capture || captureBackpressured) return;
      captureBackpressured = true;
      child.stdout.pause();
      child.stderr.pause();
      void capture.waitForDrain().then((captureHealthy) => {
        if (!captureHealthy) fullOutputComplete = false;
        captureBackpressured = false;
        if (settled) return;
        child.stdout.resume();
        child.stderr.resume();
      });
    };
    const timer =
      input.timeoutMs === undefined ? undefined : setTimeout(() => terminate("timeout"), input.timeoutMs);
    const cancel = (): void => terminate("cancelled");
    input.signal.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (chunk: Buffer | string) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer | string) => append("stderr", chunk));
    child.once("error", rejectOnce);
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (terminationReason) killTree("SIGKILL");
      cleanup();
      flushOutput();
      void (capture?.finish() ?? Promise.resolve(true)).then((captureFinished) => {
        if (!captureFinished) fullOutputComplete = false;
        if (terminationReason === "cancelled" || input.signal.aborted) {
          reject(createEffectExecutionFailure("cancelled", "Process was cancelled"));
          return;
        }
        if (terminationReason === "timeout") {
          reject(new Error(`Process timed out after ${input.timeoutMs}ms`));
          return;
        }
        resolveResult(
          Object.freeze({
            exitCode,
            signal,
            output: outputChunks.slice(outputStart).join(""),
            fullOutputLength,
            stdout,
            stderr,
            truncated,
            fullOutputComplete,
          }),
        );
      }, reject);
    });
  });
}
async function readBoundedFile(
  path: string,
  startLine: number,
  endLine: number | undefined,
): Promise<{
  readonly content: string;
  readonly endLine: number;
  readonly totalLines: number;
  readonly contentDigest: string;
  readonly truncated: boolean;
}> {
  const hash = createHash("sha256");
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let selectedBytes = 0;
  let selectedLinesStarted = 0;
  let lineNumber = 1;
  let totalLines = 0;
  let currentLineHasContent = false;
  let currentOutputLineStarted = false;
  let outputTruncated = false;
  const selected = (line: number): boolean => line >= startLine && (endLine === undefined || line <= endLine);
  const append = (value: string): void => {
    if (!value || selectedBytes >= MAX_TOOL_TEXT_BYTES) {
      if (value) outputTruncated = true;
      return;
    }
    const remaining = MAX_TOOL_TEXT_BYTES - selectedBytes;
    const accepted = truncateUtf8(value, remaining);
    if (accepted) chunks.push(accepted);
    selectedBytes += Buffer.byteLength(accepted, "utf8");
    if (accepted.length < value.length) outputTruncated = true;
  };
  const startOutputLine = (): void => {
    if (currentOutputLineStarted || !selected(lineNumber)) return;
    if (selectedLinesStarted > 0) append("\n");
    selectedLinesStarted += 1;
    currentOutputLineStarted = true;
  };
  const consumeText = (text: string): void => {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      const boundary = newline === -1 ? text.length : newline;
      const segment = text.slice(offset, boundary);
      if (segment) {
        currentLineHasContent = true;
        if (selected(lineNumber)) {
          startOutputLine();
          append(segment);
        }
      }
      if (newline === -1) return;
      startOutputLine();
      totalLines = lineNumber;
      lineNumber += 1;
      currentLineHasContent = false;
      currentOutputLineStarted = false;
      offset = newline + 1;
    }
  };
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    consumeText(decoder.decode(bytes, { stream: true }));
  }
  consumeText(decoder.decode(new Uint8Array()));
  if (currentLineHasContent) totalLines = lineNumber;
  const requestedEnd = Math.min(totalLines, endLine ?? totalLines);
  return Object.freeze({
    content: chunks.join(""),
    endLine: requestedEnd,
    totalLines,
    contentDigest: hash.digest("hex"),
    truncated: outputTruncated || (endLine !== undefined && endLine < totalLines),
  });
}
function truncateUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let accepted = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    accepted += character;
    bytes += characterBytes;
  }
  return accepted;
}
function truncateUtf8Tail(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const characters = [...value];
  let start = characters.length;
  let bytes = 0;
  while (start > 0) {
    const character = characters[start - 1];
    if (character === undefined) break;
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    start -= 1;
    bytes += characterBytes;
  }
  return characters.slice(start).join("");
}
async function readBoundedResponseBody(response: Response): Promise<{
  readonly body: string;
  readonly truncated: boolean;
}> {
  if (!response.body) return Object.freeze({ body: "", truncated: false });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (bytes <= MAX_TOOL_TEXT_BYTES) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = MAX_TOOL_TEXT_BYTES - bytes;
      if (next.value.byteLength > remaining) {
        if (remaining > 0) chunks.push(next.value.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
        await reader.cancel("Noesis response body limit reached");
        break;
      }
      chunks.push(next.value);
      bytes += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return Object.freeze({
    body: Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      bytes,
    ).toString("utf8"),
    truncated,
  });
}
async function searchWithoutRipgrep(input: {
  readonly path: string;
  readonly reportedPath: string;
  readonly query: string;
  readonly glob?: string;
  readonly maxMatches: number;
  readonly signal: AbortSignal;
}): Promise<{
  readonly matches: readonly {
    readonly path: string;
    readonly line: number;
    readonly text: string;
  }[];
  readonly truncated: boolean;
}> {
  const root = input.path;
  const matches: {
    path: string;
    line: number;
    text: string;
  }[] = [];
  let visitedFiles = 0;
  let scannedBytes = 0;
  let retainedBytes = 0;
  let truncated = false;
  let stopTraversal = false;
  async function* files(path: string): AsyncGenerator<string> {
    if (input.signal.aborted) throw createEffectExecutionFailure("cancelled", "File search was cancelled");
    const metadata = await lstat(path);
    if (metadata.isFile()) {
      yield path;
      return;
    }
    if (!metadata.isDirectory()) return;
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = resolve(path, entry.name);
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        !FALLBACK_SEARCH_IGNORED_DIRECTORIES.has(entry.name)
      )
        yield* files(absolute);
      else if (entry.isFile()) yield absolute;
    }
  }
  for await (const file of files(root)) {
    if (visitedFiles >= FALLBACK_SEARCH_MAX_FILES || scannedBytes >= FALLBACK_SEARCH_MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }
    visitedFiles += 1;
    const relativePath = relative(root, file);
    if (input.glob && !matchesGlob(relativePath, input.glob)) continue;
    const stream = createReadStream(file);
    const decoder = new TextDecoder();
    let fileBytes = 0;
    let lineNumber = 1;
    let linePreview = "";
    let lineMatched = false;
    let lineTruncated = false;
    let matchSuffix = "";
    let binary = false;
    let stopped = false;
    const fileMatches: {
      path: string;
      line: number;
      text: string;
    }[] = [];
    let fileRetainedBytes = 0;
    const retainMatch = (): void => {
      if (!lineMatched || binary || stopped) return;
      const text = linePreview.endsWith("\r") ? linePreview.slice(0, -1) : linePreview;
      const retained = Buffer.byteLength(file, "utf8") + Buffer.byteLength(text, "utf8") + 32;
      if (
        matches.length + fileMatches.length >= input.maxMatches ||
        retainedBytes + fileRetainedBytes + retained > FALLBACK_SEARCH_MAX_RETAINED_BYTES
      ) {
        truncated = true;
        stopped = true;
        stopTraversal = true;
        return;
      }
      fileMatches.push({
        path: resolve(input.reportedPath, relativePath),
        line: lineNumber,
        text: lineTruncated ? `${truncateUtf8(text, FALLBACK_SEARCH_MAX_LINE_BYTES - 3)}...` : text,
      });
      fileRetainedBytes += retained;
    };
    const consumeSegment = (segment: string): void => {
      if (!segment || stopped) return;
      if (!lineMatched && `${matchSuffix}${segment}`.includes(input.query)) lineMatched = true;
      const suffixLength = Math.max(0, input.query.length - 1);
      matchSuffix = suffixLength === 0 ? "" : `${matchSuffix}${segment}`.slice(-suffixLength);
      if (Buffer.byteLength(linePreview, "utf8") < FALLBACK_SEARCH_MAX_LINE_BYTES) {
        const remaining = FALLBACK_SEARCH_MAX_LINE_BYTES - Buffer.byteLength(linePreview, "utf8");
        const accepted = truncateUtf8(segment, remaining);
        linePreview += accepted;
        if (accepted.length < segment.length) lineTruncated = true;
      } else {
        lineTruncated = true;
      }
    };
    const consumeText = (text: string): void => {
      let offset = 0;
      while (offset < text.length && !stopped) {
        const newline = text.indexOf("\n", offset);
        const boundary = newline === -1 ? text.length : newline;
        consumeSegment(text.slice(offset, boundary));
        if (newline === -1) return;
        retainMatch();
        lineNumber += 1;
        linePreview = "";
        lineMatched = false;
        lineTruncated = false;
        matchSuffix = "";
        offset = newline + 1;
      }
    };
    try {
      for await (const chunk of stream) {
        if (input.signal.aborted)
          throw createEffectExecutionFailure("cancelled", "File search was cancelled");
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remainingFile = FALLBACK_SEARCH_MAX_FILE_BYTES - fileBytes;
        const remainingTotal = FALLBACK_SEARCH_MAX_TOTAL_BYTES - scannedBytes;
        const acceptedBytes = Math.max(0, Math.min(bytes.byteLength, remainingFile, remainingTotal));
        if (acceptedBytes > 0) {
          const accepted = bytes.subarray(0, acceptedBytes);
          fileBytes += acceptedBytes;
          scannedBytes += acceptedBytes;
          if (accepted.includes(0)) {
            binary = true;
            break;
          }
          consumeText(decoder.decode(accepted, { stream: true }));
        }
        if (acceptedBytes < bytes.byteLength) {
          truncated = true;
          if (!binary) {
            lineTruncated = true;
            retainMatch();
          }
          stopped = true;
          if (remainingTotal <= remainingFile) stopTraversal = true;
          break;
        }
        if (stopped) break;
      }
    } finally {
      stream.destroy();
    }
    if (!binary && !stopped) {
      consumeText(decoder.decode());
      retainMatch();
    }
    if (!binary) {
      matches.push(...fileMatches);
      retainedBytes += fileRetainedBytes;
    }
    if (stopTraversal) break;
  }
  return Object.freeze({ matches: Object.freeze(matches), truncated });
}
export interface CreateLocalWorkToolsOptions {
  readonly cwd: string;
  readonly fileMutationCoordinator?: FileMutationCoordinator;
  readonly searchCommand?: string;
  readonly maxShellOutputArtifactBytes?: number;
  readonly writeArtifact: (input: { readonly path: string; readonly content: string }) => Promise<{
    readonly path: string;
    readonly bytes: number;
    readonly contentDigest: string;
  }>;
  readonly importArtifact: (input: { readonly path: string; readonly sourcePath: string }) => Promise<{
    readonly path: string;
  }>;
}
export interface FileMutationCoordinator {
  readonly run: <Value>(path: string, operation: () => Promise<Value>) => Promise<Value>;
}
export function createFileMutationCoordinator(): FileMutationCoordinator {
  const tails = new Map<string, Promise<void>>();
  return Object.freeze({
    run: async <Value>(path: string, operation: () => Promise<Value>): Promise<Value> => {
      const prior = tails.get(path) ?? Promise.resolve();
      const running = prior.catch(() => undefined).then(operation);
      const tail = running.then(
        () => undefined,
        () => undefined,
      );
      tails.set(path, tail);
      try {
        return await running;
      } finally {
        if (tails.get(path) === tail) tails.delete(path);
      }
    },
  });
}
export function createLocalWorkTools(options: CreateLocalWorkToolsOptions): readonly ToolDefinition[] {
  const cwd = resolve(options.cwd);
  const projectRoot = realpathSync(cwd);
  const searchCommand = options.searchCommand ?? "rg";
  const maxShellOutputArtifactBytes =
    options.maxShellOutputArtifactBytes ?? DEFAULT_MAX_SHELL_OUTPUT_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(maxShellOutputArtifactBytes) || maxShellOutputArtifactBytes <= 0)
    throw new Error("maxShellOutputArtifactBytes must be a positive safe integer");
  const shellPath = process.env["SHELL"] ?? "/bin/sh";
  const writeArtifact = options.writeArtifact;
  const importArtifact = options.importArtifact;
  const fileMutationCoordinator = options.fileMutationCoordinator ?? createFileMutationCoordinator();
  const identity = (tool: string, extra: JsonValue = null): JsonValue =>
    Object.freeze({
      adapterRevision: "local-work-tools-v1",
      cwd,
      tool,
      extra,
    });
  const read = defineTool({
    name: "files.read",
    label: "Read file",
    description: "Read a UTF-8 file, optionally selecting a bounded line range.",
    identityMaterial: identity("files.read"),
    inputSchema: z.strictObject({
      path: pathSchema,
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
    }),
    outputSchema: z.strictObject({
      path: z.string(),
      content: textBound,
      startLine: z.number().int().positive(),
      endLine: z.number().int().nonnegative(),
      totalLines: z.number().int().nonnegative(),
      contentDigest: z.string(),
      truncated: z.boolean(),
    }),
    effect: ({ path }) => ({
      effect: "read",
      resource: `file-read:${resolvedPath(cwd, path)}`,
      estimatedCost: 0,
    }),
    execute: async ({ path, startLine = 1, endLine }) => {
      const absolute = resolvedPath(cwd, path);
      const result = await readBoundedFile(absolute, startLine, endLine);
      return {
        path: absolute,
        content: result.content,
        startLine,
        endLine: result.endLine,
        totalLines: result.totalLines,
        contentDigest: result.contentDigest,
        truncated: result.truncated,
      };
    },
  });
  const list = defineTool({
    name: "files.list",
    label: "List directory",
    description: "List one directory with entry kinds and stable lexical ordering.",
    identityMaterial: identity("files.list"),
    inputSchema: z.strictObject({ path: pathSchema.optional() }),
    outputSchema: z.strictObject({
      path: z.string(),
      entries: z.array(
        z.strictObject({
          name: z.string(),
          kind: z.enum(["file", "directory", "symlink", "other"]),
        }),
      ),
    }),
    effect: ({ path = "." }) => ({
      effect: "read",
      resource: `directory:${projectPath(projectRoot, path)}`,
      estimatedCost: 0,
    }),
    execute: async ({ path = "." }) => {
      const absolute = projectPath(projectRoot, path);
      const entries = await readdir(absolute, { withFileTypes: true });
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return {
        path: resolvedPath(cwd, path),
        entries: entries
          .map((entry) => ({
            name: entry.name,
            kind: entry.isFile()
              ? ("file" as const)
              : entry.isDirectory()
                ? ("directory" as const)
                : entry.isSymbolicLink()
                  ? ("symlink" as const)
                  : ("other" as const),
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      };
    },
  });
  const search = defineTool({
    name: "files.search",
    label: "Search files",
    description: "Search repository text with ripgrep and return bounded cited line matches.",
    identityMaterial: identity("files.search", { searchCommand }),
    inputSchema: z.strictObject({
      query: z.string().min(1).max(1000),
      path: pathSchema.optional(),
      glob: z.string().min(1).max(1000).optional(),
      maxMatches: z.number().int().min(1).max(1000).optional(),
    }),
    outputSchema: z.strictObject({
      matches: z.array(
        z.strictObject({
          path: z.string(),
          line: z.number().int().positive(),
          text: z.string(),
        }),
      ),
      truncated: z.boolean(),
    }),
    effect: ({ path = "." }) => ({
      effect: "execute",
      resource: `search:${projectPath(projectRoot, path)}`,
      estimatedCost: 0,
    }),
    execute: async ({ query, path = ".", glob, maxMatches = 200 }, context) => {
      const absolute = projectPath(projectRoot, path);
      const reportedPath = resolvedPath(cwd, path);
      const args = [
        "--line-number",
        "--color",
        "never",
        "--no-heading",
        "--fixed-strings",
        ...(glob ? ["--glob", glob] : []),
        "--",
        query,
        absolute,
      ];
      let result: ProcessResult;
      try {
        result = await runProcess({
          command: searchCommand,
          args,
          cwd,
          signal: context.signal,
          timeoutMs: undefined,
        });
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
          // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
          return await searchWithoutRipgrep(
            createConditionalObject({
              path: absolute,
              reportedPath,
              query,
            } as const)
              .addOptional(glob ? { glob } : undefined)
              .add({
                maxMatches,
                signal: context.signal,
              } as const)
              .finish(),
          );
        throw error;
      }
      if (result.exitCode !== 0 && result.exitCode !== 1)
        throw new Error(result.stderr.trim() || `rg exited with ${String(result.exitCode)}`);
      const lines = result.stdout.split("\n").filter(Boolean);
      const matches = lines.slice(0, maxMatches).flatMap((line) => {
        const match = /^(.*?):([0-9]+):(.*)$/u.exec(line);
        if (!match) return [];
        const [, matchPath, lineNumber, text] = match;
        if (!matchPath || !lineNumber || text === undefined) return [];
        const canonicalMatchPath = resolvedPath(cwd, matchPath);
        return [
          {
            path: resolve(reportedPath, relative(absolute, canonicalMatchPath)),
            line: Number(lineNumber),
            text,
          },
        ];
      });
      return { matches, truncated: result.truncated || lines.length > maxMatches };
    },
  });
  const write = defineTool({
    name: "files.write",
    label: "Write file",
    description: "Create or completely replace a UTF-8 file, creating parent directories by default.",
    identityMaterial: identity("files.write"),
    inputSchema: z.strictObject({
      path: pathSchema,
      content: textBound,
      createParents: z.boolean().optional(),
    }),
    outputSchema: z.strictObject({
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      contentDigest: z.string(),
    }),
    effect: ({ path }) => ({
      effect: "write",
      resource: `file:${projectPath(projectRoot, path)}`,
      estimatedCost: 1,
    }),
    execute: async ({ path, content, createParents = true }, context) => {
      const absolute = projectPath(projectRoot, path);
      const reportedPath = resolvedPath(cwd, path);
      return await fileMutationCoordinator.run(absolute, async () => {
        if (context.signal.aborted)
          throw createEffectExecutionFailure("cancelled", "File write was cancelled before execution");
        if (createParents) await mkdir(dirname(absolute), { recursive: true });
        if (context.signal.aborted)
          throw createEffectExecutionFailure("cancelled", "File write was cancelled before mutation");
        await writeFile(absolute, content, "utf8");
        return {
          path: reportedPath,
          bytes: Buffer.byteLength(content, "utf8"),
          contentDigest: sha256(content),
        };
      });
    },
  });
  const edit = defineTool({
    name: "files.replace",
    label: "Replace text",
    description: "Replace an exact text occurrence in a UTF-8 file, rejecting ambiguous edits.",
    identityMaterial: identity("files.replace"),
    inputSchema: z.strictObject({
      path: pathSchema,
      oldText: z
        .string()
        .min(1)
        .max(256 * 1024),
      newText: textBound,
      expectedOccurrences: z.number().int().positive().optional(),
    }),
    outputSchema: z.strictObject({
      path: z.string(),
      replacements: z.number().int().positive(),
      contentDigest: z.string(),
    }),
    effect: ({ path }) => ({
      effect: "write",
      resource: `file:${projectPath(projectRoot, path)}`,
      estimatedCost: 1,
    }),
    execute: async ({ path, oldText, newText, expectedOccurrences = 1 }, context) => {
      const absolute = projectPath(projectRoot, path);
      const reportedPath = resolvedPath(cwd, path);
      return await fileMutationCoordinator.run(absolute, async () => {
        if (context.signal.aborted)
          throw createEffectExecutionFailure("cancelled", "File replacement was cancelled before execution");
        const content = await readFile(absolute, "utf8");
        const occurrences = content.split(oldText).length - 1;
        if (occurrences !== expectedOccurrences)
          throw new Error(`Expected ${expectedOccurrences} occurrences but found ${occurrences}`);
        const updated = content.replaceAll(oldText, newText);
        if (context.signal.aborted)
          throw createEffectExecutionFailure("cancelled", "File replacement was cancelled before mutation");
        await writeFile(absolute, updated, "utf8");
        return { path: reportedPath, replacements: occurrences, contentDigest: sha256(updated) };
      });
    },
  });
  const shell = defineTool({
    name: "shell.run",
    label: "Run shell command",
    description:
      "Run a shell command locally with bounded tail output, optional timeout, and cancellation. A truncated preview saves retained output to fullOutputPath for inspection with ordinary file or Unix tools; fullOutputComplete reports whether it is complete.",
    identityMaterial: identity("shell.run", {
      shellPath,
      maxShellOutputArtifactBytes,
      importArtifact: importArtifact.toString(),
    }),
    inputSchema: z.strictObject({
      command: z.string().trim().min(1).max(32768),
      cwd: pathSchema.optional(),
      timeoutMs: z.number().int().min(100).max(2_147_483_647).optional(),
    }),
    outputSchema: z.union([
      z.strictObject({
        exitCode: z.number().int().nullable(),
        signal: z.string().nullable(),
        output: textBound,
        fullOutputLength: z
          .number()
          .int()
          .nonnegative()
          .describe("Decoded character length observed from the process."),
        truncated: z.literal(false),
        fullOutputComplete: z.literal(true),
      }),
      z.strictObject({
        exitCode: z.number().int().nullable(),
        signal: z.string().nullable(),
        output: textBound,
        fullOutputLength: z
          .number()
          .int()
          .nonnegative()
          .describe("Decoded character length observed from the process."),
        truncated: z.literal(true),
        fullOutputPath: z.string().describe("Absolute path to the retained combined process output."),
        fullOutputComplete: z
          .boolean()
          .describe("Whether fullOutputPath contains every decoded character observed from the process."),
      }),
    ]),
    effect: ({ command, cwd: requestedCwd = "." }) => ({
      effect: "execute",
      resource: `shell:${resolvedPath(cwd, requestedCwd)}:${sha256(command)}`,
      estimatedCost: 1,
    }),
    execute: async ({ command, cwd: requestedCwd = ".", timeoutMs }, context) => {
      const temporaryDirectory = await mkdtemp(join(tmpdir(), "noesis-shell-"));
      const temporaryOutputPath = join(temporaryDirectory, "output.log");
      try {
        const result = await runProcess({
          command: shellPath,
          args: ["-c", command],
          cwd: resolvedPath(cwd, requestedCwd),
          signal: context.signal,
          timeoutMs,
          fullOutputPath: temporaryOutputPath,
          maxFullOutputBytes: maxShellOutputArtifactBytes,
        });
        if (!result.truncated)
          return {
            exitCode: result.exitCode,
            signal: result.signal,
            output: result.output,
            fullOutputLength: result.fullOutputLength,
            truncated: false,
            fullOutputComplete: true,
          };
        const artifact = await importArtifact({
          path: `tool-output/${sha256(`${context.executionId}:${context.callId}`)}.log`,
          sourcePath: temporaryOutputPath,
        });
        return {
          exitCode: result.exitCode,
          signal: result.signal,
          output: result.output,
          fullOutputLength: result.fullOutputLength,
          truncated: true,
          fullOutputPath: artifact.path,
          fullOutputComplete: result.fullOutputComplete,
        };
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    },
  });
  const fetchTool = defineTool({
    name: "web.fetch",
    label: "Fetch URL",
    description: "Fetch an HTTP(S) resource and return bounded response text and headers.",
    identityMaterial: identity("web.fetch"),
    inputSchema: z.strictObject({
      url: z.url(),
      method: z.enum(["GET", "HEAD"]).optional(),
    }),
    outputSchema: z.strictObject({
      url: z.string(),
      status: z.number().int(),
      headers: z.record(z.string(), z.string()),
      body: textBound,
      truncated: z.boolean(),
    }),
    effect: ({ url }) => ({ effect: "network", resource: `url:${url}`, estimatedCost: 1 }),
    execute: async ({ url, method = "GET" }, context) => {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new Error("web.fetch supports only HTTP(S) URLs");
      const response = await fetch(parsed, { method, signal: context.signal, redirect: "manual" });
      const body =
        method === "HEAD"
          ? Object.freeze({ body: "", truncated: false })
          : await readBoundedResponseBody(response);
      return {
        url: response.url,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: body.body,
        truncated: body.truncated,
      };
    },
  });
  const artifact = defineTool({
    name: "artifacts.write",
    label: "Write artifact",
    description: "Write a durable artifact beneath the Noesis workspace artifact directory.",
    identityMaterial: identity("artifacts.write", {
      writeArtifact: writeArtifact.toString(),
    }),
    inputSchema: z.strictObject({ path: pathSchema, content: textBound }),
    outputSchema: z.strictObject({
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      contentDigest: z.string(),
    }),
    effect: ({ path }) => ({
      effect: "write",
      resource: `artifact:${path}`,
      estimatedCost: 1,
    }),
    execute: async ({ path, content }) => await writeArtifact({ path, content }),
  });
  return Object.freeze([read, list, search, write, edit, shell, fetchTool, artifact]);
}
export function jsonOutputSchema(): z.ZodType<JsonValue> {
  return z.json();
}
