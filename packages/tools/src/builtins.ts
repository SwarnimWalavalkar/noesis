import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type JsonValue, sha256 } from "@noesis/domain";
import { z } from "zod";
import { defineTool, type ToolDefinition } from "./index.ts";

const textBound = z.string().max(256 * 1024);
const pathSchema = z.string().trim().min(1).max(4_096);

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
  const maximum = input.maxOutputBytes ?? 256 * 1024;
  return await new Promise<ProcessResult>((resolveResult, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let truncated = false;
    let terminationStarted = false;
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
    const terminate = (): void => {
      if (terminationStarted) return;
      terminationStarted = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 500);
    };
    const timer = setTimeout(terminate, input.timeoutMs);
    input.signal.addEventListener("abort", terminate, { once: true });
    child.stdout.on("data", (chunk: Buffer | string) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer | string) => append("stderr", chunk));
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal.removeEventListener("abort", terminate);
      if (input.signal.aborted) {
        reject(new Error("Process was cancelled"));
        return;
      }
      resolveResult(Object.freeze({ exitCode, signal, stdout, stderr, truncated }));
    });
  });
}

export interface CreateLocalWorkToolsOptions {
  readonly cwd: string;
  readonly writeArtifact: (input: { readonly path: string; readonly content: string }) => Promise<{
    readonly path: string;
    readonly bytes: number;
    readonly contentDigest: string;
  }>;
}

export function createLocalWorkTools(options: CreateLocalWorkToolsOptions): readonly ToolDefinition[] {
  const read = defineTool({
    name: "files.read",
    label: "Read file",
    description: "Read a UTF-8 file, optionally selecting a bounded line range.",
    visibility: "codemode_only",
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
      resource: `file:${resolvedPath(options.cwd, path)}`,
      estimatedCost: 0,
    }),
    execute: async ({ path, startLine = 1, endLine }) => {
      const absolute = resolvedPath(options.cwd, path);
      const content = await readFile(absolute, "utf8");
      const lines = content.split("\n");
      const requestedEnd = Math.max(startLine - 1, Math.min(endLine ?? lines.length, lines.length));
      let selected = lines.slice(startLine - 1, requestedEnd).join("\n");
      let truncated = requestedEnd < lines.length;
      if (Buffer.byteLength(selected, "utf8") > 256 * 1024) {
        selected = Buffer.from(selected, "utf8")
          .subarray(0, 256 * 1024)
          .toString("utf8");
        truncated = true;
      }
      return {
        path: absolute,
        content: selected,
        startLine,
        endLine: requestedEnd,
        totalLines: lines.length,
        contentDigest: sha256(content),
        truncated,
      };
    },
  });
  const list = defineTool({
    name: "files.list",
    label: "List directory",
    description: "List one directory with entry kinds and stable lexical ordering.",
    visibility: "codemode_only",
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
      resource: `directory:${resolvedPath(options.cwd, path)}`,
      estimatedCost: 0,
    }),
    execute: async ({ path = "." }) => {
      const absolute = resolvedPath(options.cwd, path);
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
      resource: `search:${resolvedPath(options.cwd, path)}`,
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
      const result = await runProcess({
        command: "rg",
        args,
        cwd: options.cwd,
        signal: context.signal,
        timeoutMs: 30_000,
      });
      if (result.exitCode !== 0 && result.exitCode !== 1)
        throw new Error(result.stderr.trim() || `rg exited with ${String(result.exitCode)}`);
      const lines = result.stdout.split("\n").filter(Boolean);
      const matches = lines.slice(0, maxMatches).flatMap((line) => {
        const match = /^(.*?):([0-9]+):(.*)$/u.exec(line);
        if (!match) return [];
        const [, matchPath, lineNumber, text] = match;
        if (!matchPath || !lineNumber || text === undefined) return [];
        return [{ path: resolvedPath(options.cwd, matchPath), line: Number(lineNumber), text }];
      });
      return { matches, truncated: result.truncated || lines.length > maxMatches };
    },
  });
  const write = defineTool({
    name: "files.write",
    label: "Write file",
    description: "Create or replace a UTF-8 file on the user's machine.",
    visibility: "codemode_only",
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
      resource: `file:${resolvedPath(options.cwd, path)}`,
      estimatedCost: 1,
    }),
    execute: async ({ path, content, createParents = false }) => {
      const absolute = resolvedPath(options.cwd, path);
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
      resource: `file:${resolvedPath(options.cwd, path)}`,
      estimatedCost: 1,
    }),
    execute: async ({ path, oldText, newText, expectedOccurrences = 1 }) => {
      const absolute = resolvedPath(options.cwd, path);
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
    effect: ({ command, cwd = "." }) => ({
      effect: "execute",
      resource: `shell:${resolvedPath(options.cwd, cwd)}:${sha256(command)}`,
      estimatedCost: 1,
    }),
    execute: async ({ command, cwd = ".", timeoutMs = 120_000 }, context) =>
      await runProcess({
        command: process.env["SHELL"] ?? "/bin/sh",
        args: ["-lc", command],
        cwd: resolvedPath(options.cwd, cwd),
        signal: context.signal,
        timeoutMs,
      }),
  });
  const fetchTool = defineTool({
    name: "web.fetch",
    label: "Fetch URL",
    description: "Fetch an HTTP(S) resource and return bounded response text and headers.",
    visibility: "codemode_only",
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
      const response = await fetch(parsed, { method, signal: context.signal, redirect: "follow" });
      const raw = method === "HEAD" ? "" : await response.text();
      const encoded = Buffer.from(raw, "utf8");
      const body = encoded.subarray(0, 256 * 1024).toString("utf8");
      return {
        url: response.url,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
        truncated: encoded.byteLength > Buffer.byteLength(body, "utf8"),
      };
    },
  });
  const artifact = defineTool({
    name: "artifacts.write",
    label: "Write artifact",
    description: "Write a durable artifact beneath the Noesis workspace artifact directory.",
    visibility: "codemode_only",
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
    execute: async ({ path, content }) => await options.writeArtifact({ path, content }),
  });

  return Object.freeze([read, list, search, write, edit, shell, fetchTool, artifact]);
}

export function jsonOutputSchema(): z.ZodType<JsonValue> {
  return z.json();
}
