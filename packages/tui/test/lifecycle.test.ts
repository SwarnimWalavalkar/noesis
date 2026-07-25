import type { Terminal } from "@earendil-works/pi-tui";
import type { NoesisAgentRuntime } from "@noesis/agent-types";
import { describe, expect, test, vi } from "vitest";
import { startNoesisTui } from "../src/index.ts";
import { createInMemoryTestRuntime, type TestNoesisRuntime } from "./support/in-memory-runtime.ts";

interface TestTerminal extends Terminal {
  readonly starts: number;
  readonly stops: number;
  readonly drains: number;
  readonly output: string;
  readonly type: (text: string) => void;
  readonly send: (data: string) => void;
  readonly resize: (columns: number, rows: number) => void;
}

function createTestTerminal(): TestTerminal {
  let starts = 0;
  let stops = 0;
  let drains = 0;
  let output = "";
  let input: ((data: string) => void) | undefined;
  let resizeHandler: (() => void) | undefined;
  let columns = 80;
  let rows = 24;
  return {
    kittyProtocolActive: false,
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
    get drains() {
      return drains;
    },
    get output() {
      return output;
    },
    start(onInput, onResize) {
      starts += 1;
      input = onInput;
      resizeHandler = onResize;
    },
    stop() {
      stops += 1;
      input = undefined;
      resizeHandler = undefined;
    },
    async drainInput() {
      drains += 1;
    },
    type(text) {
      for (const character of text) input?.(character);
    },
    send(data) {
      input?.(data);
    },
    resize(nextColumns, nextRows) {
      columns = nextColumns;
      rows = nextRows;
      resizeHandler?.();
    },
    write(data) {
      output += data;
    },
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  };
}

const containsUnsafeTextControl = (text: string): boolean =>
  [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159);
  });

const containsC1 = (text: string): boolean =>
  [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 128 && code <= 159;
  });

async function createRuntime(agent: NoesisAgentRuntime): Promise<TestNoesisRuntime> {
  return createInMemoryTestRuntime(agent);
}

describe("Noesis TUI lifecycle", () => {
  test("two plain launches create distinct fresh sessions without prior conversation", async () => {
    const runtime = await createRuntime({
      name: "fresh-scripted",
      async run(request) {
        return {
          text: `reply:${request.prompt}`,
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer() {},
      async followUp() {},
      async abort() {},
    });
    const historical = await runtime.startTrail({ title: "historical" });
    await runtime.runTurn(historical.trailId, "historical-only-message");

    const firstTerminal = createTestTerminal();
    const first = startNoesisTui(runtime, {}, firstTerminal);
    await vi.waitFor(() => expect(firstTerminal.output).toContain("● IDLE"));
    expect(firstTerminal.output).not.toContain("historical-only-message");
    expect(firstTerminal.output.indexOf("› message")).toBeLessThan(firstTerminal.output.indexOf("● IDLE"));
    expect(firstTerminal.output.indexOf("● IDLE")).toBeLessThan(firstTerminal.output.indexOf("? help"));
    firstTerminal.type("/quit\n");
    await first;

    const secondTerminal = createTestTerminal();
    const second = startNoesisTui(runtime, {}, secondTerminal);
    await vi.waitFor(() => expect(secondTerminal.output).toContain("● IDLE"));
    secondTerminal.type("/quit\n");
    await second;

    const summaries = runtime.listTrailSummaries();
    expect(summaries).toHaveLength(3);
    expect(new Set(summaries.map((summary) => summary.trailId)).size).toBe(3);
    expect(summaries.filter((summary) => summary.trailId !== historical.trailId)).toHaveLength(2);
    expect(
      summaries
        .filter((summary) => summary.trailId !== historical.trailId)
        .every((summary) => summary.turnCount === 0),
    ).toBe(true);
  });

  test("direct resume restores only the selected session history", async () => {
    const runtime = await createRuntime({
      name: "resume-scripted",
      async run(request) {
        return {
          text: `reply:${request.prompt}`,
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer() {},
      async followUp() {},
      async abort() {},
    });
    const selected = await runtime.startTrail({ title: "selected" });
    await runtime.runTurn(selected.trailId, "selected-history");
    const other = await runtime.startTrail({ title: "other" });
    await runtime.runTurn(other.trailId, "other-history");
    const terminal = createTestTerminal();

    const running = startNoesisTui(
      runtime,
      { session: { mode: "resume", trailId: selected.trailId } },
      terminal,
    );
    await vi.waitFor(() => expect(terminal.output).toContain("selected-history"));
    expect(terminal.output).not.toContain("other-history");
    terminal.type("/quit\n");
    await running;

    expect(runtime.resumedTrailIds.at(-1)).toBe(selected.trailId);
  });

  test("renders lifecycle and usage updates from real runtime events", async () => {
    let releaseTool: (() => void) | undefined;
    const toolBlocked = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const runtime = await createRuntime({
      name: "telemetry-scripted",
      async run(request, emit) {
        emit({ type: "model", provider: request.provider, model: request.model, contextWindow: 4_000 });
        emit({ type: "status", status: "started" });
        emit({ type: "tool-start", name: "inspect", input: {} });
        await toolBlocked;
        emit({ type: "tool-end", name: "inspect", isError: false });
        emit({ type: "delta", text: "grounded answer" });
        const contextUsage = {
          usedTokens: 1_000,
          contextWindow: 4_000,
          accuracy: "reported" as const,
        };
        emit({ type: "usage", ...contextUsage });
        emit({ type: "status", status: "completed" });
        return {
          text: "grounded answer",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
          contextUsage,
        };
      },
      async steer() {},
      async followUp() {},
      async abort() {},
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("use the snapshot\r");
    await vi.waitFor(() => expect(terminal.output).toContain("● TOOL"));
    releaseTool?.();
    await vi.waitFor(() => expect(terminal.output).toContain("ctx  25%"));
    await vi.waitFor(() => expect(terminal.output).toContain("grounded answer"));
    await vi.waitFor(() => expect(terminal.output).toContain("1t"));

    terminal.type("/quit\n");
    await running;
  });

  test("reconciles tool-loop streaming to authoritative output and ignores late turn events", async () => {
    let emitLate: (() => void) | undefined;
    const runtime = await createRuntime({
      name: "tool-loop-late-scripted",
      async run(request, emit) {
        emit({ type: "status", status: "started" });
        emit({ type: "delta", text: "intermediate reasoning" });
        emit({ type: "tool-start", name: "inspect", input: {} });
        emit({ type: "tool-end", name: "inspect", isError: false });
        emit({ type: "delta", text: "\n\nprovisional answer" });
        emit({ type: "status", status: "completed" });
        emitLate = () => emit({ type: "delta", text: "DETACHED-LATE-DELTA" });
        return {
          text: "authoritative final answer",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer() {},
      async followUp() {},
      async abort() {},
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("use a tool\r");
    await vi.waitFor(() => expect(terminal.output).toContain("authoritative final answer"));
    await vi.waitFor(() => expect(terminal.output).toContain("1t"));
    emitLate?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(terminal.output).not.toContain("DETACHED-LATE-DELTA");
    const trail = runtime.listTrails()[0];
    if (!trail) throw new Error("Expected the completed tool-loop trail");
    expect(runtime.getTrail(trail.trailId).turns.at(-1)?.output).toBe("authoritative final answer");
    terminal.type("/quit\n");
    await running;
  });

  test("sanitizes bracketed C0, C1, ESC, and DEL paste before rendering or runtime submission", async () => {
    let submitted = "";
    const runtime = await createRuntime({
      name: "paste-safe-scripted",
      async run(request) {
        submitted = request.prompt;
        return {
          text: "safe response",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer() {},
      async followUp() {},
      async abort() {},
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.send(
      "\u001b[200~Unicode 界面\tline\n\u001b[2J\u0007\u009b31m\u009dtitle\u009c\u007f end\u001b[201~",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 125));
    terminal.send("\r");
    await vi.waitFor(() => expect(submitted).toContain("Unicode 界面"));

    expect(submitted).toContain("Unicode 界面    line\n");
    expect(submitted).toContain("\n");
    expect(containsUnsafeTextControl(submitted)).toBe(false);
    expect(containsC1(terminal.output)).toBe(false);
    terminal.type("/quit\n");
    await running;
  });

  test("records provider error outcomes as failed and keeps the TUI in ERROR", async () => {
    const runtime = await createRuntime({
      name: "provider-error-scripted",
      async run(request, emit) {
        const error = "Provider rejected the request: invalid offline fixture";
        emit({ type: "status", status: "started" });
        emit({ type: "status", status: "failed", error });
        return {
          text: "",
          provider: request.provider,
          model: request.model,
          outcome: "failed",
          stopReason: "error",
          error,
        };
      },
      async steer() {},
      async followUp() {},
      async abort() {},
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("fail this turn\r");

    await vi.waitFor(() => expect(terminal.output).toContain("● ERROR"));
    expect(terminal.output).toContain("Provider rejected the request: invalid offline fixture");
    await vi.waitFor(() => expect(runtime.failedTurnCount).toBe(1));
    const failedTrail = runtime.listTrails()[0];
    expect(failedTrail).toBeDefined();
    if (!failedTrail) throw new Error("Failed trail fixture was not recorded");
    expect(runtime.getTrail(failedTrail.trailId).status).toBe("failed");

    terminal.type("/quit\n");
    await running;
  });

  test("submits /abort during a blocked turn and remains usable without concurrent turns", async () => {
    let releaseBlocked: (() => void) | undefined;
    let runs = 0;
    const abort = vi.fn(async () => {
      releaseBlocked?.();
    });
    const runtime = await createRuntime({
      name: "abortable-scripted",
      async run(request, emit) {
        runs += 1;
        emit({ type: "status", status: "started" });
        if (runs === 1) {
          emit({ type: "delta", text: "partial" });
          await new Promise<void>((resolve) => {
            releaseBlocked = resolve;
          });
          emit({ type: "status", status: "aborted" });
          return {
            text: "partial",
            provider: request.provider,
            model: request.model,
            outcome: "aborted",
            stopReason: "aborted",
          };
        }
        emit({ type: "delta", text: "usable again" });
        emit({ type: "status", status: "completed" });
        return {
          text: "usable again",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer() {},
      async followUp() {},
      abort,
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("block this turn\r");
    await vi.waitFor(() => expect(terminal.output).toContain("● STREAMING"));
    terminal.type("another turn\r");
    await vi.waitFor(() => expect(terminal.output).toContain("A turn is active. Use /abort"));
    expect(runs).toBe(1);

    terminal.type("/abort\r");
    await vi.waitFor(() => expect(terminal.output).toContain("● ABORTING"));
    await vi.waitFor(() => expect(terminal.output).toContain("Turn aborted."));
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));
    expect(abort).toHaveBeenCalledOnce();
    expect(terminal.stops).toBe(0);

    terminal.type("a usable follow-up\r");
    await vi.waitFor(() => expect(terminal.output).toContain("usable again"));
    expect(runs).toBe(2);
    await vi.waitFor(() => expect(runtime.listTrails()[0]?.turns).toHaveLength(1));

    terminal.type("/quit\n");
    await running;
    expect(terminal.stops).toBe(1);
  });

  test("reflows the main shell and picker from current terminal dimensions", async () => {
    const runtime = await createRuntime({
      name: "resize-scripted",
      async run(request) {
        return {
          text: "done",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer() {},
      async followUp() {},
      async abort() {},
    });
    const mainTerminal = createTestTerminal();
    mainTerminal.resize(120, 35);
    const main = startNoesisTui(runtime, {}, mainTerminal);
    await vi.waitFor(() => expect(mainTerminal.output).toContain("███╗   ██╗ ██████╗"));
    mainTerminal.resize(50, 9);
    await vi.waitFor(() => expect(mainTerminal.output).toContain("? help · /quit exit"));
    expect(mainTerminal.output).toContain("› message");
    mainTerminal.type("/quit\n");
    await main;

    for (let index = 0; index < 12; index += 1)
      await runtime.startTrail({ title: `picker resize ${String(index).padStart(2, "0")}` });
    const pickerTerminal = createTestTerminal();
    pickerTerminal.resize(100, 30);
    const picker = startNoesisTui(runtime, { session: { mode: "pick" } }, pickerTerminal);
    await vi.waitFor(() => expect(pickerTerminal.output).toContain("resume a session"));
    pickerTerminal.resize(46, 7);
    pickerTerminal.send("\u001b[B");
    pickerTerminal.send("\u001b");
    await expect(picker).resolves.toBeUndefined();
    expect(pickerTerminal.stops).toBe(1);
  });

  test("keeps command help discoverable without a permanent command wall", async () => {
    const runtime = await createRuntime({
      name: "help-scripted",
      async run(request) {
        return {
          text: "done",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer() {},
      async followUp() {},
      async abort() {},
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("? help · /quit exit"));
    expect(terminal.output).not.toContain("/learn · /evaluate");

    terminal.type("?\r");
    await vi.waitFor(() =>
      expect(terminal.output).toContain("learning, experiments, activation, and revert run ambiently"),
    );
    expect(terminal.output).not.toContain("/learn · /evaluate");
    expect(terminal.output).toContain("/model provider/model");

    terminal.type("/quit\n");
    await running;
  });

  test("continue resumes the most recently active session without creating or leaking trails", async () => {
    const runtime = await createRuntime({
      name: "continue-scripted",
      async run(request) {
        return {
          text: `reply:${request.prompt}`,
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer() {},
      async followUp() {},
      async abort() {},
    });
    const selected = await runtime.startTrail({
      title: "selected",
      provider: "preserved-provider",
      model: "preserved-model",
    });
    const other = await runtime.startTrail({
      title: "other",
      provider: "other-provider",
      model: "other-model",
    });
    await runtime.runTurn(other.trailId, "other-history");
    await runtime.runTurn(selected.trailId, "selected-latest-history");
    const startsBefore = runtime.listTrails().length;
    const terminal = createTestTerminal();

    const running = startNoesisTui(runtime, { session: { mode: "continue" } }, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("selected-latest-history"));
    expect(terminal.output).toContain(`session ${selected.trailId.slice(6, 14)}`);
    expect(terminal.output).toContain("preserved-provid");
    expect(terminal.output).not.toContain("other-history");
    terminal.type("/quit\n");
    await running;

    expect(runtime.listTrails()).toHaveLength(startsBefore);
    expect(runtime.resumedTrailIds.at(-1)).toBe(selected.trailId);
  });

  test("picker selects the requested session and Escape cancels through normal cleanup", async () => {
    const runtime = await createRuntime({
      name: "picker-scripted",
      async run(request) {
        return {
          text: `reply:${request.prompt}`,
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer() {},
      async followUp() {},
      async abort() {},
    });
    const older = await runtime.startTrail({ title: "older" });
    await runtime.runTurn(older.trailId, "older-history");
    const newer = await runtime.startTrail({ title: "newer" });
    await runtime.runTurn(newer.trailId, "newer-history");
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, { session: { mode: "pick" } }, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("resume a session"));
    terminal.send("\u001b[B");
    terminal.send("\r");
    await vi.waitFor(() => expect(terminal.output).toContain(`session ${older.trailId.slice(6, 14)}`));
    expect(terminal.output).toContain("older-history");
    terminal.type("/quit\n");
    await running;
    expect(runtime.resumedTrailIds.at(-1)).toBe(older.trailId);

    const cancelledTerminal = createTestTerminal();
    const cancelled = startNoesisTui(runtime, { session: { mode: "pick" } }, cancelledTerminal);
    await vi.waitFor(() => expect(cancelledTerminal.output).toContain("resume a session"));
    cancelledTerminal.send("\u001b");
    await expect(cancelled).resolves.toBeUndefined();
    expect(cancelledTerminal.drains).toBe(1);
    expect(cancelledTerminal.stops).toBe(1);
  });

  test("invalid direct session IDs fail actionably without starting the terminal", async () => {
    const runtime = await createRuntime({
      name: "missing-scripted",
      async run(request) {
        return {
          text: "done",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer() {},
      async followUp() {},
      async abort() {},
    });
    const terminal = createTestTerminal();

    await expect(
      startNoesisTui(runtime, { session: { mode: "resume", trailId: "trail_missing" } }, terminal),
    ).rejects.toThrow(/was not found.*--resume/);
    expect(terminal.starts).toBe(0);
  });

  test("an empty resume picker fails with a safe, actionable message", async () => {
    const runtime = await createRuntime({
      name: "empty-scripted",
      async run(request) {
        return {
          text: "done",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer() {},
      async followUp() {},
      async abort() {},
    });
    const terminal = createTestTerminal();

    await expect(startNoesisTui(runtime, { session: { mode: "pick" } }, terminal)).rejects.toThrow(
      /No saved sessions.*without --resume/,
    );
    expect(terminal.starts).toBe(0);
  });

  test("continue on an empty home fails actionably without starting or creating a trail", async () => {
    const runtime = await createRuntime({
      name: "empty-continue-scripted",
      async run(request) {
        return {
          text: "done",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer() {},
      async followUp() {},
      async abort() {},
    });
    const terminal = createTestTerminal();

    await expect(startNoesisTui(runtime, { session: { mode: "continue" } }, terminal)).rejects.toThrow(
      /No saved sessions.*without --continue/,
    );
    expect(terminal.starts).toBe(0);
    expect(runtime.listTrails()).toEqual([]);
  });

  test("treats LF after /quit as shutdown and stops the terminal once", async () => {
    const runtime = await createRuntime({
      name: "lifecycle-scripted",
      async run(request) {
        return {
          text: "done",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer() {},
      async followUp() {},
      async abort() {},
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.starts).toBe(1));

    terminal.type("/quit\n");
    terminal.type("\u0003");

    await expect(running).resolves.toBeUndefined();
    expect(terminal.drains).toBe(1);
    expect(terminal.stops).toBe(1);
  });

  test("Ctrl+C aborts an active turn before startNoesisTui returns", async () => {
    let finishTurn: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const abort = vi.fn(async () => {
      finishTurn?.();
    });
    let emitLate: (() => void) | undefined;
    const runtime = await createRuntime({
      name: "blocking-scripted",
      async run(request, emit) {
        emitLate = () => emit({ type: "delta", text: "SHUTDOWN-LATE-DELTA" });
        markStarted?.();
        await new Promise<void>((resolve) => {
          finishTurn = resolve;
        });
        return {
          text: "",
          provider: request.provider,
          model: request.model,
          outcome: "aborted",
          stopReason: "aborted",
        };
      },
      async steer() {},
      async followUp() {},
      abort,
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.starts).toBe(1));
    terminal.type("hello\r");
    await started;

    terminal.type("\u0003");

    await expect(running).resolves.toBeUndefined();
    expect(abort).toHaveBeenCalledOnce();
    expect(terminal.stops).toBe(1);
    emitLate?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(terminal.output).not.toContain("SHUTDOWN-LATE-DELTA");
  });

  test("detaches after the shutdown grace period when an aborted turn never settles", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const abort = vi.fn(async () => undefined);
    const runtime = await createRuntime({
      name: "stuck-scripted",
      async run() {
        markStarted?.();
        return await new Promise<never>(() => undefined);
      },
      async steer() {},
      async followUp() {},
      abort,
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.starts).toBe(1));
    terminal.type("hello\r");
    await started;

    terminal.type("\u0003");

    await expect(
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("TUI shutdown exceeded one second")), 1_000);
        running.then(
          () => {
            clearTimeout(timeout);
            resolve();
          },
          (error: unknown) => {
            clearTimeout(timeout);
            reject(error);
          },
        );
      }),
    ).resolves.toBeUndefined();
    expect(abort).toHaveBeenCalledOnce();
    expect(terminal.stops).toBe(1);
  });
});
