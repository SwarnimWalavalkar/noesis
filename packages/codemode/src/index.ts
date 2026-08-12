import { type ChildProcess, fork } from "node:child_process";
import { createId, type JsonValue, JsonValueSchema, sha256, toJsonValue } from "@noesis/domain";
import type { ToolBroker, ToolInvocationResult } from "@noesis/tools";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CALLS = 128;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_PROGRESS_BYTES = 256 * 1024;
const DEFAULT_MAX_PROGRESS_VALUE_BYTES = 64 * 1024;
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
const DEFAULT_MAX_SDK_REQUEST_BYTES = 256 * 1024;
const DEFAULT_MAX_CHILD_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_CHILD_IPC_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STORE_BYTES = 256 * 1024;
const DEFAULT_MAX_STORE_ENTRIES = 256;
const DEFAULT_MAX_FAILURE_MESSAGE_BYTES = 32 * 1024;
const DEFAULT_MAX_FAILURE_STACK_BYTES = 96 * 1024;
const DEFAULT_MAX_TOOL_ERROR_DETAILS_BYTES = 64 * 1024;
const PENDING_SDK_ABORT_GRACE_MS = 500;

const childMessageSchema = z.union([
  z.strictObject({ type: z.literal("ready") }),
  z.strictObject({
    type: z.literal("sdk-call"),
    requestId: z.string().min(1),
    kind: z.literal("search"),
    query: z.string(),
    limit: z.number().int().optional(),
  }),
  z.strictObject({
    type: z.literal("sdk-call"),
    requestId: z.string().min(1),
    kind: z.literal("describe"),
    name: z.string(),
  }),
  z.strictObject({
    type: z.literal("sdk-call"),
    requestId: z.string().min(1),
    kind: z.literal("invoke"),
    name: z.string(),
    input: JsonValueSchema,
  }),
  z.strictObject({
    type: z.literal("progress"),
    value: JsonValueSchema,
  }),
  z.strictObject({
    type: z.literal("result"),
    value: JsonValueSchema,
    storeMutations: z.array(z.tuple([z.string(), JsonValueSchema])),
  }),
  z.strictObject({
    type: z.literal("failure"),
    error: z.string(),
    stack: z.string().optional(),
  }),
]);

type ChildMessage = z.infer<typeof childMessageSchema>;

export type CodeExecutionEvent =
  | { readonly type: "started"; readonly executionId: string }
  | { readonly type: "stdout"; readonly executionId: string; readonly text: string }
  | { readonly type: "stderr"; readonly executionId: string; readonly text: string }
  | {
      readonly type: "progress";
      readonly executionId: string;
      readonly value: JsonValue;
      readonly callId?: string;
      readonly name?: string;
      readonly callIndex?: number;
    }
  | {
      readonly type: "tool-start";
      readonly executionId: string;
      readonly callId: string;
      readonly name: string;
      readonly callIndex: number;
      readonly input: JsonValue;
    }
  | {
      readonly type: "tool-end";
      readonly executionId: string;
      readonly callId: string;
      readonly name: string;
      readonly callIndex: number;
      readonly ok: boolean;
      readonly result?: JsonValue;
      readonly error?: string;
    }
  | {
      readonly type: "completed";
      readonly executionId: string;
      readonly calls: number;
      readonly durationMs: number;
    }
  | {
      readonly type: "failed" | "cancelled";
      readonly executionId: string;
      readonly error: string;
    };

export interface CodeExecutionRequest {
  readonly executionId?: string;
  readonly logicalExecutionId?: string;
  readonly source: string;
  readonly input?: JsonValue;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface CodeExecutionResult {
  readonly executionId: string;
  readonly value: JsonValue;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: number;
  readonly durationMs: number;
}

export interface CodeModeRuntime {
  readonly execute: (
    request: CodeExecutionRequest,
    emit?: (event: CodeExecutionEvent) => void,
  ) => Promise<CodeExecutionResult>;
  readonly terminate: (executionId: string) => Promise<void>;
  readonly shutdown: () => Promise<void>;
}

export interface CreateCodeModeRuntimeOptions {
  readonly cwd: string;
  readonly broker: ToolBroker;
  readonly maxCalls?: number;
  readonly maxOutputBytes?: number;
}

interface ActiveExecution {
  readonly child: ChildProcess;
  readonly controller: AbortController;
  readonly closed: Promise<void>;
  readonly settled: Promise<void>;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function sdkRequestPayload(message: Extract<ChildMessage, { readonly type: "sdk-call" }>): JsonValue {
  if (message.kind === "search") {
    return Object.freeze({
      query: message.query,
      ...(message.limit === undefined ? {} : { limit: message.limit }),
    });
  }
  if (message.kind === "describe") return Object.freeze({ name: message.name });
  return Object.freeze({ name: message.name, input: message.input });
}

function sdkActionInput(message: Extract<ChildMessage, { readonly type: "sdk-call" }>): JsonValue {
  if (message.kind === "search") {
    return Object.freeze({
      query: message.query,
      ...(message.limit === undefined ? {} : { limit: message.limit }),
    });
  }
  if (message.kind === "describe") return Object.freeze({ name: message.name });
  return message.input;
}

function invocationValue(result: ToolInvocationResult): JsonValue {
  if (result.ok) return result.value;
  const serializedDetails = result.details === undefined ? undefined : JSON.stringify(result.details);
  const boundedDetails =
    serializedDetails === undefined
      ? ""
      : Buffer.byteLength(serializedDetails, "utf8") <= DEFAULT_MAX_TOOL_ERROR_DETAILS_BYTES
        ? `\n${serializedDetails}`
        : `\n[Tool error details omitted because they exceed ${String(DEFAULT_MAX_TOOL_ERROR_DETAILS_BYTES)} bytes]`;
  throw new Error(`${result.code}: ${result.message}${boundedDetails}`);
}

async function terminateChild(child: ChildProcess, closed: Promise<void>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const closedAfterTerm = await settleWithin(
    closed.then(() => true),
    500,
    false,
  );
  if (!closedAfterTerm && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await closed;
}

async function settleWithin<T, F>(pending: Promise<T>, maximumWaitMs: number, fallback: F): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<F>((resolve) => {
        timer = setTimeout(() => resolve(fallback), maximumWaitMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForPendingSdkCalls(
  pendingSdkCalls: ReadonlySet<Promise<void>>,
  maximumWaitMs?: number,
): Promise<boolean> {
  const drained = Promise.allSettled([...pendingSdkCalls]).then(() => true);
  if (maximumWaitMs === undefined) return await drained;
  return await settleWithin(drained, maximumWaitMs, false);
}

export function createCodeModeRuntime(options: CreateCodeModeRuntimeOptions): CodeModeRuntime {
  const active = new Map<string, ActiveExecution>();
  const sessionStores = new Map<string, ReadonlyMap<string, JsonValue>>();
  const maxCalls = options.maxCalls ?? DEFAULT_MAX_CALLS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const execute: CodeModeRuntime["execute"] = async (request, emit = () => undefined) => {
    if (!request.source.trim()) throw new Error("Codemode source must not be empty");
    if (Buffer.byteLength(request.source, "utf8") > 128 * 1024)
      throw new Error("Codemode source exceeds 128 KiB");
    if (request.signal?.aborted) throw new Error("Codemode execution was cancelled");
    const executionId = request.executionId ?? createId("execution");
    const logicalExecutionId = request.logicalExecutionId ?? executionId;
    if (active.has(executionId)) throw new Error(`Codemode execution ${executionId} is already running`);
    const startedAt = Date.now();
    const controller = new AbortController();
    const child = fork(new URL("./runner.mjs", import.meta.url), [], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "advanced",
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    let settleActive: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      settleActive = resolve;
    });
    active.set(executionId, Object.freeze({ child, controller, closed, settled }));
    const output = { stdout: "", stderr: "" };
    let outputBytes = 0;
    let progressBytes = 0;
    let childIpcBytes = 0;
    let calls = 0;
    let ready = false;
    let terminal = false;
    let settlingResult = false;
    let timer: NodeJS.Timeout | undefined;
    const pendingSdkCalls = new Set<Promise<void>>();
    const notify = (event: CodeExecutionEvent): void => {
      try {
        emit(event);
      } catch {
        // Event callbacks are observers and must not change execution lifecycle.
      }
    };

    const appendOutput = (kind: "stdout" | "stderr", chunk: string): void => {
      if (!chunk || outputBytes >= maxOutputBytes) return;
      const remaining = maxOutputBytes - outputBytes;
      const bytes = Buffer.from(chunk, "utf8");
      const accepted = bytes.subarray(0, remaining).toString("utf8");
      output[kind] += accepted;
      outputBytes += Buffer.byteLength(accepted, "utf8");
      if (accepted) notify({ type: kind, executionId, text: accepted });
    };

    const abort = (): void => {
      if (controller.signal.aborted) return;
      controller.abort();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    child.stdout?.on("data", (chunk: Buffer | string) => appendOutput("stdout", String(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => appendOutput("stderr", String(chunk)));

    try {
      return await new Promise<CodeExecutionResult>((resolve, reject) => {
        notify({ type: "started", executionId });
        const finishFailure = (error: Error, cancelled = false): void => {
          if (terminal) return;
          terminal = true;
          abort();
          notify({
            type: cancelled ? "cancelled" : "failed",
            executionId,
            error: error.message,
          });
          reject(error);
        };
        const finishSuccess = async (
          value: JsonValue,
          storeMutations: readonly (readonly [string, JsonValue])[],
        ): Promise<void> => {
          if (terminal || settlingResult) return;
          settlingResult = true;
          await waitForPendingSdkCalls(pendingSdkCalls);
          if (terminal) return;
          const nextStore = new Map(sessionStores.get(request.sessionId) ?? new Map());
          for (const [key, storedValue] of storeMutations) nextStore.set(key, storedValue);
          const nextEntries = [...nextStore.entries()];
          if (nextEntries.length > DEFAULT_MAX_STORE_ENTRIES) {
            finishFailure(new Error(`Codemode store exceeds ${String(DEFAULT_MAX_STORE_ENTRIES)} entries`));
            return;
          }
          if (Buffer.byteLength(JSON.stringify(nextEntries), "utf8") > DEFAULT_MAX_STORE_BYTES) {
            finishFailure(new Error(`Codemode store exceeds ${String(DEFAULT_MAX_STORE_BYTES)} bytes`));
            return;
          }
          sessionStores.set(request.sessionId, nextStore);
          terminal = true;
          const durationMs = Date.now() - startedAt;
          notify({ type: "completed", executionId, calls, durationMs });
          resolve(
            Object.freeze({
              executionId,
              value,
              stdout: output.stdout,
              stderr: output.stderr,
              calls,
              durationMs,
            }),
          );
        };
        if (controller.signal.aborted) {
          finishFailure(new Error("Codemode execution was cancelled"), true);
          return;
        }
        const respond = (message: object): void => {
          if (!child.connected) {
            finishFailure(new Error("Codemode IPC channel closed before a response could be sent"));
            return;
          }
          try {
            child.send(message, (error) => {
              if (error) finishFailure(error);
            });
          } catch (error) {
            finishFailure(error instanceof Error ? error : new Error(String(error)));
          }
        };
        const recordProgress = (value: JsonValue): void => {
          const valueBytes = jsonBytes(value);
          if (valueBytes > DEFAULT_MAX_PROGRESS_VALUE_BYTES)
            throw new Error(
              `Codemode progress value exceeds ${String(DEFAULT_MAX_PROGRESS_VALUE_BYTES)} bytes`,
            );
          progressBytes += valueBytes;
          if (progressBytes > DEFAULT_MAX_PROGRESS_BYTES)
            throw new Error(`Codemode progress exceeds ${String(DEFAULT_MAX_PROGRESS_BYTES)} bytes`);
        };
        const handleSdkCall = async (
          message: Extract<ChildMessage, { readonly type: "sdk-call" }>,
        ): Promise<void> => {
          calls += 1;
          if (calls > maxCalls) {
            respond({
              type: "sdk-result",
              requestId: message.requestId,
              ok: false,
              error: `Codemode exceeded ${maxCalls} SDK calls`,
            });
            abort();
            return;
          }
          const callIndex = calls;
          const callId = `tool_call_${sha256(`${logicalExecutionId}:${String(callIndex)}`)}`;
          const name =
            message.kind === "search"
              ? "noesis.search"
              : message.kind === "describe"
                ? "noesis.describe"
                : message.name;
          notify({
            type: "tool-start",
            executionId,
            callId,
            name,
            callIndex,
            input: sdkActionInput(message),
          });
          try {
            const value = toJsonValue(
              message.kind === "search"
                ? options.broker.search(message.query, message.limit)
                : message.kind === "describe"
                  ? (options.broker.describe(message.name) ?? null)
                  : invocationValue(
                      await options.broker.invoke(message.name, message.input, {
                        executionId,
                        parentExecutionId: executionId,
                        logicalExecutionId,
                        callId,
                        sessionId: request.sessionId,
                        ...(request.turnId ? { turnId: request.turnId } : {}),
                        signal: controller.signal,
                        emitUpdate: (update) => {
                          recordProgress(update);
                          notify({
                            type: "progress",
                            executionId,
                            value: update,
                            callId,
                            name,
                            callIndex,
                          });
                        },
                      }),
                    ),
            );
            respond({
              type: "sdk-result",
              requestId: message.requestId,
              ok: true,
              value,
            });
            notify({ type: "tool-end", executionId, callId, name, callIndex, ok: true, result: value });
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            respond({
              type: "sdk-result",
              requestId: message.requestId,
              ok: false,
              error: reason,
            });
            notify({ type: "tool-end", executionId, callId, name, callIndex, ok: false, error: reason });
          }
        };
        child.on("message", (raw: unknown) => {
          try {
            const frameBytes = jsonBytes(raw);
            if (frameBytes > DEFAULT_MAX_CHILD_FRAME_BYTES) {
              finishFailure(
                new Error(`Codemode IPC frame exceeds ${String(DEFAULT_MAX_CHILD_FRAME_BYTES)} bytes`),
              );
              return;
            }
            childIpcBytes += frameBytes;
            if (childIpcBytes > DEFAULT_MAX_CHILD_IPC_BYTES) {
              finishFailure(
                new Error(`Codemode IPC output exceeds ${String(DEFAULT_MAX_CHILD_IPC_BYTES)} bytes`),
              );
              return;
            }
            const parsed = childMessageSchema.safeParse(raw);
            if (!parsed.success) {
              finishFailure(new Error(`Malformed codemode frame: ${z.prettifyError(parsed.error)}`));
              return;
            }
            const message = parsed.data;
            if (message.type === "ready") {
              if (ready) {
                finishFailure(new Error("Codemode child sent duplicate ready frame"));
                return;
              }
              ready = true;
              respond({
                type: "run",
                source: request.source,
                storeEntries: [...(sessionStores.get(request.sessionId) ?? new Map()).entries()],
                ...(request.input === undefined ? {} : { input: request.input }),
              });
            } else if (message.type === "sdk-call") {
              if (jsonBytes(sdkRequestPayload(message)) > DEFAULT_MAX_SDK_REQUEST_BYTES) {
                finishFailure(
                  new Error(`Codemode SDK request exceeds ${String(DEFAULT_MAX_SDK_REQUEST_BYTES)} bytes`),
                );
                return;
              }
              const pending = handleSdkCall(message);
              pendingSdkCalls.add(pending);
              void pending.finally(() => pendingSdkCalls.delete(pending));
            } else if (message.type === "progress") {
              recordProgress(message.value);
              notify({ type: "progress", executionId, value: message.value });
            } else if (message.type === "result") {
              if (jsonBytes(message.value) > DEFAULT_MAX_RESULT_BYTES) {
                finishFailure(new Error(`Codemode result exceeds ${String(DEFAULT_MAX_RESULT_BYTES)} bytes`));
                return;
              }
              if (message.storeMutations.length > DEFAULT_MAX_STORE_ENTRIES) {
                finishFailure(
                  new Error(`Codemode store mutations exceed ${String(DEFAULT_MAX_STORE_ENTRIES)} entries`),
                );
                return;
              }
              if (
                Buffer.byteLength(JSON.stringify(message.storeMutations), "utf8") > DEFAULT_MAX_STORE_BYTES
              ) {
                finishFailure(
                  new Error(`Codemode store mutations exceed ${String(DEFAULT_MAX_STORE_BYTES)} bytes`),
                );
                return;
              }
              void finishSuccess(message.value, message.storeMutations);
            } else {
              if (Buffer.byteLength(message.error, "utf8") > DEFAULT_MAX_FAILURE_MESSAGE_BYTES) {
                finishFailure(
                  new Error(
                    `Codemode failure message exceeds ${String(DEFAULT_MAX_FAILURE_MESSAGE_BYTES)} bytes`,
                  ),
                );
                return;
              }
              if (
                message.stack !== undefined &&
                Buffer.byteLength(message.stack, "utf8") > DEFAULT_MAX_FAILURE_STACK_BYTES
              ) {
                finishFailure(
                  new Error(
                    `Codemode failure stack exceeds ${String(DEFAULT_MAX_FAILURE_STACK_BYTES)} bytes`,
                  ),
                );
                return;
              }
              finishFailure(new Error(message.error));
            }
          } catch (error) {
            finishFailure(error instanceof Error ? error : new Error(String(error)));
          }
        });
        child.once("error", (error) => finishFailure(error));
        child.once("exit", (code, signal) => {
          if (terminal || settlingResult) return;
          if (controller.signal.aborted) finishFailure(new Error("Codemode execution was cancelled"), true);
          else
            finishFailure(
              new Error(
                `Codemode child exited before producing a result (${signal ?? `code ${String(code)}`})`,
              ),
            );
        });
        controller.signal.addEventListener(
          "abort",
          () => finishFailure(new Error("Codemode execution was cancelled"), true),
          { once: true },
        );
        timer = setTimeout(() => {
          finishFailure(new Error("Codemode execution timed out"));
        }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      });
    } finally {
      if (timer) clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      controller.abort();
      await waitForPendingSdkCalls(pendingSdkCalls, PENDING_SDK_ABORT_GRACE_MS);
      await terminateChild(child, closed);
      active.delete(executionId);
      settleActive?.();
    }
  };

  const terminate = async (executionId: string): Promise<void> => {
    const execution = active.get(executionId);
    if (!execution) return;
    execution.controller.abort();
    if (execution.child.exitCode === null && execution.child.signalCode === null)
      execution.child.kill("SIGTERM");
    await execution.settled;
  };

  const shutdown = async (): Promise<void> => {
    const executions = [...active.values()];
    for (const execution of executions) {
      execution.controller.abort();
      if (execution.child.exitCode === null && execution.child.signalCode === null)
        execution.child.kill("SIGTERM");
    }
    await Promise.all(executions.map(async (execution) => await execution.settled));
  };

  return Object.freeze({ execute, terminate, shutdown });
}
