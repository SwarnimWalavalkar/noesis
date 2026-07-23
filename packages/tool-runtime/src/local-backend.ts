import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { toJsonValue } from "@noesis/domain";
import { z } from "zod";
import {
  GeneratedEffectCallSchema,
  type GeneratedToolBackend,
  type GeneratedToolBackendRequest,
  type GeneratedToolBackendResult,
  type GeneratedToolBackendTrace,
} from "./contracts.ts";

const RUNNER_SOURCE = String.raw`
import { createInterface } from "node:readline";
import run from "./tool.mjs";

const pending = new Map();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");

const requestEffect = (request) => new Promise((resolve, reject) => {
  if (request == null || typeof request !== "object" || typeof request.requestId !== "string") {
    reject(new Error("Effect requests require a stable requestId"));
    return;
  }
  pending.set(request.requestId, { resolve, reject });
  send({ jsonrpc: "2.0", id: request.requestId, method: "effect/invoke", params: request });
});

lines.on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: "run", error: { code: -32700, message: "Invalid parent JSON" } });
    process.exitCode = 1;
    return;
  }
  if (message?.method === "tool/run" && message.id === "run") {
    try {
      const output = await run(message.params.input, Object.freeze({ requestEffect }));
      send({ jsonrpc: "2.0", id: "run", result: output });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: "run",
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      });
      process.exitCode = 1;
    }
    lines.close();
    return;
  }
  if (typeof message?.id === "string" && pending.has(message.id)) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  }
});
`;

const EffectRequestMessageSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.string().min(1),
  method: z.literal("effect/invoke"),
  params: GeneratedEffectCallSchema,
});

const RunResultMessageSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.literal("run"),
  result: z.unknown(),
});

const RunErrorMessageSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.literal("run"),
  error: z.strictObject({ code: z.number().int(), message: z.string() }),
});

type BackendFailureCode = Extract<GeneratedToolBackendResult, { readonly ok: false }>["code"];

function createTrace(
  startedAt: string,
  stdout: string,
  stderr: string,
  brokerRequestCount: number,
): GeneratedToolBackendTrace {
  return Object.freeze({
    backend: "local-child-process",
    previewIsolation: "local_child_process_not_security_boundary",
    startedAt,
    completedAt: new Date().toISOString(),
    stdout,
    stderr,
    brokerRequestCount,
  });
}

async function executeLocalChild(request: GeneratedToolBackendRequest): Promise<GeneratedToolBackendResult> {
  const startedAt = new Date().toISOString();
  const workingDirectory = await mkdtemp(join(tmpdir(), "noesis-generated-tool-"));
  let stdout = "";
  let stderr = "";
  let brokerRequestCount = 0;
  try {
    await Promise.all([
      writeFile(join(workingDirectory, "tool.mjs"), request.tool.source, { encoding: "utf8", mode: 0o600 }),
      writeFile(join(workingDirectory, "runner.mjs"), RUNNER_SOURCE, { encoding: "utf8", mode: 0o600 }),
      writeFile(
        join(workingDirectory, "package.json"),
        `${JSON.stringify({
          private: true,
          type: "module",
          dependencies: request.tool.dependencyLock.dependencies,
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      ),
      writeFile(join(workingDirectory, "pnpm-lock.yaml"), request.tool.dependencyLock.lockfile, {
        encoding: "utf8",
        mode: 0o600,
      }),
    ]);

    if (request.signal?.aborted) {
      return {
        ok: false,
        code: "cancelled",
        reason: "Generated tool execution was cancelled before spawn",
        trace: createTrace(startedAt, stdout, stderr, brokerRequestCount),
      };
    }

    const child = spawn(process.execPath, ["runner.mjs"], {
      cwd: workingDirectory,
      env: {
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC",
        NOESIS_GENERATED_TOOL_PREVIEW: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin.on("error", () => undefined);

    let failure: { readonly code: BackendFailureCode; readonly reason: string } | undefined;
    let output: unknown;
    let hasOutput = false;
    let observedBytes = 0;
    let processing = Promise.resolve();

    const stop = (code: BackendFailureCode, reason: string): void => {
      if (failure) return;
      failure = { code, reason };
      child.kill("SIGKILL");
    };
    child.once("error", (error) => stop("child_error", error.message));

    const observe = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
      observedBytes += chunk.byteLength;
      if (stream === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
      if (observedBytes > request.limits.maxOutputBytes) {
        stop("output_limit", `Generated tool exceeded ${request.limits.maxOutputBytes} output bytes`);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => observe(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => observe(chunk, "stderr"));

    const send = (message: unknown): void => {
      const line = `${JSON.stringify(message)}\n`;
      if (Buffer.byteLength(line) > request.limits.maxBrokerMessageBytes) {
        stop("broker_limit", "A broker response exceeded the bounded JSON-RPC message size");
        return;
      }
      if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(line);
    };

    const handleLine = async (line: string): Promise<void> => {
      if (Buffer.byteLength(line) > request.limits.maxBrokerMessageBytes) {
        stop("broker_limit", "A child JSON-RPC message exceeded the configured bound");
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        stop("protocol_error", "Generated tool wrote non-JSON data to the broker channel");
        return;
      }
      const effectRequest = EffectRequestMessageSchema.safeParse(value);
      if (effectRequest.success) {
        brokerRequestCount += 1;
        if (brokerRequestCount > request.limits.maxBrokerRequests) {
          stop("broker_limit", "Generated tool exceeded the broker request count limit");
          return;
        }
        const result = await request.broker.invoke(effectRequest.data.params);
        if (result.ok) send({ jsonrpc: "2.0", id: effectRequest.data.id, result });
        else {
          send({
            jsonrpc: "2.0",
            id: effectRequest.data.id,
            error: { code: -32001, message: `${result.code}: ${result.reason}` },
          });
        }
        return;
      }
      const runResult = RunResultMessageSchema.safeParse(value);
      if (runResult.success) {
        output = runResult.data.result;
        hasOutput = true;
        return;
      }
      const runError = RunErrorMessageSchema.safeParse(value);
      if (runError.success) {
        failure = { code: "child_error", reason: runError.data.error.message };
        return;
      }
      stop("protocol_error", "Generated tool emitted an unknown JSON-RPC message");
    };

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      processing = processing.then(async () => await handleLine(line));
    });

    const timeout = setTimeout(
      () => stop("timeout", `Generated tool exceeded ${request.limits.timeoutMs}ms`),
      request.limits.timeoutMs,
    );
    const cancel = (): void => stop("cancelled", "Generated tool execution was cancelled");
    request.signal?.addEventListener("abort", cancel, { once: true });

    const close = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    send({ jsonrpc: "2.0", id: "run", method: "tool/run", params: { input: request.input } });
    const closed = await close;
    await processing;
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", cancel);
    lines.close();

    const trace = createTrace(startedAt, stdout, stderr, brokerRequestCount);
    if (failure) return { ok: false, ...failure, trace };
    if (closed.code !== 0) {
      return {
        ok: false,
        code: "child_error",
        reason: `Generated tool child exited with code ${String(closed.code)} (${String(closed.signal)})`,
        trace,
      };
    }
    if (!hasOutput) {
      return {
        ok: false,
        code: "protocol_error",
        reason: "Generated tool exited without a JSON-RPC result",
        trace,
      };
    }
    return { ok: true, output: toJsonValue(output), trace };
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

/** Honest research-preview backend: bounded and sanitized, but not a production sandbox. */
export function createLocalChildProcessBackend(): GeneratedToolBackend {
  return Object.freeze({
    backendId: "local-child-process",
    execute: executeLocalChild,
  });
}
