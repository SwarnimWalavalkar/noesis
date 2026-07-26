import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, matchesGlob, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { type JsonValue, sha256 } from "@noesis/domain";
import { createEffectExecutionFailure } from "@noesis/policy";
import { z } from "zod";
import { defineTool, type ToolDefinition } from "./index.ts";
import { MAX_TOOL_TEXT_BYTES } from "./limits.ts";

const textBound = z.string().max(MAX_TOOL_TEXT_BYTES);
const pathSchema = z.string().trim().min(1).max(4_096);
const PROCESS_TERMINATION_GRACE_MS = 500;

function resolvedPath(cwd: string, path: string): string {
  return resolve(cwd, path);
}

interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

async function runProcess(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
}): Promise<ProcessResult> {
  if (input.signal.aborted)
    throw createEffectExecutionFailure("cancelled", "Process was cancelled before it started");
  const maximum = input.maxOutputBytes ?? MAX_TOOL_TEXT_BYTES;
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
    let bytes = 0;
    let truncated = false;
    let settled = false;
    let terminationReason: "cancelled" | "timeout" | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const append = (kind: "stdout" | "stderr", chunk: Buffer | string): void => {
      const encoded = Buffer.from(String(chunk), "utf8");
      const remaining = Math.max(0, maximum - bytes);
      const accepted = encoded.subarray(0, remaining).toString("utf8");
      if (kind === "stdout") stdout += accepted;
      else stderr += accepted;
      bytes += Buffer.byteLength(accepted, "utf8");
      if (encoded.byteLength > remaining) truncated = true;
    };
    const killTree = (signal: NodeJS.Signals): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (detached && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The process may have exited between the state check and signal delivery.
        try {
          child.kill(signal);
        } catch {
          // A second ESRCH-style race means the desired terminal state is already reached.
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
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => terminate("timeout"), input.timeoutMs);
    const cancel = (): void => terminate("cancelled");
    input.signal.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (chunk: Buffer | string) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer | string) => append("stderr", chunk));
    child.once("error", rejectOnce);
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminationReason === "cancelled" || input.signal.aborted) {
        reject(createEffectExecutionFailure("cancelled", "Process was cancelled"));
        return;
      }
      if (terminationReason === "timeout") {
        reject(new Error(`Process timed out after ${input.timeoutMs}ms`));
        return;
      }
      resolveResult(Object.freeze({ exitCode, signal, stdout, stderr, truncated }));
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
  let selectedLines = 0;
  let lineNumber = 1;
  let outputTruncated = false;
  const selected = (line: number): boolean => line >= startLine && (endLine === undefined || line <= endLine);
  const append = (value: string): void => {
    if (!value || selectedBytes >= MAX_TOOL_TEXT_BYTES) {
      if (value) outputTruncated = true;
      return;
    }
    const bytes = Buffer.from(value, "utf8");
    const remaining = MAX_TOOL_TEXT_BYTES - selectedBytes;
    const accepted = bytes.subarray(0, remaining).toString("utf8");
    if (accepted) chunks.push(accepted);
    selectedBytes += Buffer.byteLength(accepted, "utf8");
    if (bytes.byteLength > remaining) outputTruncated = true;
  };
  const beginSelectedLine = (): void => {
    if (!selected(lineNumber)) return;
    if (selectedLines > 0) append("\n");
    selectedLines += 1;
  };
  const consumeText = (text: string): void => {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      const boundary = newline === -1 ? text.length : newline;
      if (selected(lineNumber)) append(text.slice(offset, boundary));
      if (newline === -1) return;
      lineNumber += 1;
      beginSelectedLine();
      offset = newline + 1;
    }
  };

  beginSelectedLine();
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    consumeText(decoder.decode(bytes, { stream: true }));
  }
  consumeText(decoder.decode(new Uint8Array()));
  const totalLines = lineNumber;
  const requestedEnd = Math.max(startLine - 1, Math.min(endLine ?? totalLines, totalLines));
  return Object.freeze({
    content: chunks.join(""),
    endLine: requestedEnd,
    totalLines,
    contentDigest: hash.digest("hex"),
    truncated: outputTruncated || requestedEnd < totalLines,
  });
}

async function readBoundedResponseBody(
  response: Response,
): Promise<{ readonly body: string; readonly truncated: boolean }> {
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
  readonly cwd: string;
  readonly path: string;
  readonly query: string;
  readonly glob?: string;
  readonly maxMatches: number;
  readonly signal: AbortSignal;
}): Promise<{
  readonly matches: readonly { readonly path: string; readonly line: number; readonly text: string }[];
  readonly truncated: boolean;
}> {
  const root = resolvedPath(input.cwd, input.path);
  const expression = new RegExp(input.query, "u");
  const matches: { path: string; line: number; text: string }[] = [];
  let truncated = false;

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
      if (entry.isDirectory()) yield* files(absolute);
      else if (entry.isFile()) yield absolute;
    }
  }

  for await (const file of files(root)) {
    const relativePath = relative(input.cwd, file);
    if (input.glob && !matchesGlob(relativePath, input.glob)) continue;
    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        if (input.signal.aborted)
          throw createEffectExecutionFailure("cancelled", "File search was cancelled");
        lineNumber += 1;
        if (!expression.test(line)) continue;
        if (matches.length >= input.maxMatches) {
          truncated = true;
          break;
        }
        matches.push({ path: file, line: lineNumber, text: line });
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    if (truncated) break;
  }
  return Object.freeze({ matches: Object.freeze(matches), truncated });
}

export interface CreateLocalWorkToolsOptions {
  readonly cwd: string;
  readonly searchCommand?: string;
  readonly writeArtifact: (input: { readonly path: string; readonly content: string }) => Promise<{
    readonly path: string;
    readonly bytes: number;
    readonly contentDigest: string;
  }>;
}

export function createLocalWorkTools(options: CreateLocalWorkToolsOptions): readonly ToolDefinition[] {
  const cwd = resolve(options.cwd);
  const searchCommand = options.searchCommand ?? "rg";
  const shellPath = process.env["SHELL"] ?? "/bin/sh";
  const writeArtifact = options.writeArtifact;
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
    visibility: "codemode_only",
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
      resource: `file:${resolvedPath(cwd, path)}`,
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
    visibility: "codemode_only",
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
      resource: `directory:${resolvedPath(cwd, path)}`,
      estimatedCost: 0,
    }),
    execute: async ({ path = "." }) => {
      const absolute = resolvedPath(cwd, path);
      const entries = await readdir(absolute, { withFileTypes: true });
      return {
        path: absolute,
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
    visibility: "codemode_only",
    identityMaterial: identity("files.search", { searchCommand }),
    inputSchema: z.strictObject({
      query: z.string().min(1).max(1_000),
      path: pathSchema.optional(),
      glob: z.string().min(1).max(1_000).optional(),
      maxMatches: z.number().int().min(1).max(1_000).optional(),
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
      resource: `search:${resolvedPath(cwd, path)}`,
      estimatedCost: 0,
    }),
    execute: async ({ query, path = ".", glob, maxMatches = 200 }, context) => {
      const args = [
        "--line-number",
        "--color",
        "never",
        "--no-heading",
        ...(glob ? ["--glob", glob] : []),
        "--",
        query,
        path,
      ];
      let result: ProcessResult;
      try {
        result = await runProcess({
          command: searchCommand,
          args,
          cwd,
          signal: context.signal,
          timeoutMs: 30_000,
        });
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
          return await searchWithoutRipgrep({
            cwd,
            path,
            query,
            ...(glob ? { glob } : {}),
            maxMatches,
            signal: context.signal,
          });
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
        return [{ path: resolvedPath(cwd, matchPath), line: Number(lineNumber), text }];
      });
      return { matches, truncated: result.truncated || lines.length > maxMatches };
    },
  });
  const write = defineTool({
    name: "files.write",
    label: "Write file",
    description: "Create or replace a UTF-8 file on the user's machine.",
    visibility: "codemode_only",
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
      resource: `file:${resolvedPath(cwd, path)}`,
      estimatedCost: 1,
    }),
    execute: async ({ path, content, createParents = false }) => {
      const absolute = resolvedPath(cwd, path);
      if (createParents) await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
      return { path: absolute, bytes: Buffer.byteLength(content, "utf8"), contentDigest: sha256(content) };
    },
  });
  const edit = defineTool({
    name: "files.replace",
    label: "Replace text",
    description: "Replace an exact text occurrence in a UTF-8 file, rejecting ambiguous edits.",
    visibility: "codemode_only",
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
      resource: `file:${resolvedPath(cwd, path)}`,
      estimatedCost: 1,
    }),
    execute: async ({ path, oldText, newText, expectedOccurrences = 1 }) => {
      const absolute = resolvedPath(cwd, path);
      const content = await readFile(absolute, "utf8");
      const occurrences = content.split(oldText).length - 1;
      if (occurrences !== expectedOccurrences)
        throw new Error(`Expected ${expectedOccurrences} occurrences but found ${occurrences}`);
      const updated = content.replaceAll(oldText, newText);
      await writeFile(absolute, updated, "utf8");
      return { path: absolute, replacements: occurrences, contentDigest: sha256(updated) };
    },
  });
  const shell = defineTool({
    name: "shell.run",
    label: "Run shell command",
    description: "Run a shell command locally with bounded output, timeout, and cancellation.",
    visibility: "codemode_only",
    identityMaterial: identity("shell.run", { shellPath }),
    inputSchema: z.strictObject({
      command: z.string().trim().min(1).max(32_768),
      cwd: pathSchema.optional(),
      timeoutMs: z.number().int().min(100).max(600_000).optional(),
    }),
    outputSchema: z.strictObject({
      exitCode: z.number().int().nullable(),
      signal: z.string().nullable(),
      stdout: textBound,
      stderr: textBound,
      truncated: z.boolean(),
    }),
    effect: ({ command, cwd: requestedCwd = "." }) => ({
      effect: "execute",
      resource: `shell:${resolvedPath(cwd, requestedCwd)}:${sha256(command)}`,
      estimatedCost: 1,
    }),
    execute: async ({ command, cwd: requestedCwd = ".", timeoutMs = 120_000 }, context) =>
      await runProcess({
        command: shellPath,
        args: ["-c", command],
        cwd: resolvedPath(cwd, requestedCwd),
        signal: context.signal,
        timeoutMs,
      }),
  });
  const fetchTool = defineTool({
    name: "web.fetch",
    label: "Fetch URL",
    description: "Fetch an HTTP(S) resource and return bounded response text and headers.",
    visibility: "codemode_only",
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
    visibility: "codemode_only",
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
