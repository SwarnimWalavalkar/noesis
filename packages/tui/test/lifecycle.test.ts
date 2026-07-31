import type { NoesisAgentRuntime } from "@noesis/agent-types";
import type { RuntimeTranscriptEntry } from "@noesis/runtime";
import { describe, expect, test, vi } from "vitest";
import { actionIdentityForView, boundedInspectorText, startNoesisTui } from "../src/index.ts";
import { createInMemoryTestRuntime, type TestNoesisRuntime } from "./support/in-memory-runtime.ts";
import { createTestTerminal } from "./support/test-terminal.ts";

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

const consumeSteer: NoesisAgentRuntime["steer"] = async () =>
  Object.freeze({
    status: "consumed" as const,
    timelineSequence: 1,
    consumedAt: "2026-07-31T00:00:00.000Z",
  });

async function createRuntime(agent: NoesisAgentRuntime): Promise<TestNoesisRuntime> {
  return createInMemoryTestRuntime(agent);
}

describe("Noesis TUI lifecycle", () => {
  test("bounds and sanitizes inspector text", () => {
    const inspected = boundedInspectorText(`unsafe\u001b[2J${"x".repeat(30_000)}`);

    expect(inspected).not.toContain("\u001b[2J");
    expect(inspected).toContain("inspector preview truncated");
    expect(inspected.length).toBeLessThan(25_000);
  });

  test("keeps runtime action identities byte-identical to hydrated transcript identities", () => {
    const persistedActionId = "turn_42:execute_7";
    const persistedParentActionId = "turn_42:execute_1";
    expect(
      actionIdentityForView({
        type: "tool-start",
        actionId: persistedActionId,
        parentActionId: persistedParentActionId,
        name: "shell.run",
        input: { command: "pwd" },
      }),
    ).toEqual({
      actionId: persistedActionId,
      parentActionId: persistedParentActionId,
    });
  });

  test("drops stale inspector results when a prompt supersedes them", async () => {
    const base = await createRuntime({
      name: "inspector-race-scripted",
      async run(request) {
        return {
          text: `reply:${request.prompt}`,
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer: consumeSteer,
      async abort() {},
    });
    let releaseInspector: (() => void) | undefined;
    const inspectorGate = new Promise<void>((resolve) => {
      releaseInspector = resolve;
    });
    let inspectorStarted = false;
    const runtime = Object.freeze({
      ...base,
      inspectScript: async () => {
        inspectorStarted = true;
        await inspectorGate;
        return {
          name: "stale-script",
          description: "STALE_INSPECTOR_RESULT",
          revision: 1,
          requiredTools: Object.freeze([]),
          sourceDigest: "a".repeat(64),
          workingPath: "scripts/stale/index.mjs",
          source: "return null;",
          inputSchema: "{}",
          outputSchema: "{}",
        };
      },
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("/script stale\r");
    await vi.waitFor(() => expect(inspectorStarted).toBe(true));
    terminal.type("new prompt\r");
    await vi.waitFor(() => expect(terminal.output).toContain("reply:new prompt"));
    releaseInspector?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(terminal.output).not.toContain("STALE_INSPECTOR_RESULT");
    terminal.type("/quit\n");
    await running;
  });

  test("drops stale inspector failures after switching trails", async () => {
    const base = await createRuntime({
      name: "inspector-rejection-race-scripted",
      async run(request) {
        return {
          text: `reply:${request.prompt}`,
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer: consumeSteer,
      async abort() {},
    });
    let rejectInspector: ((error: Error) => void) | undefined;
    let inspectorStarted = false;
    const runtime = Object.freeze({
      ...base,
      inspectScript: async () =>
        await new Promise<never>((_resolve, reject) => {
          inspectorStarted = true;
          rejectInspector = reject;
        }),
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));
    const originalTrailId = runtime.listTrails()[0]?.trailId;
    if (!originalTrailId) throw new Error("Expected the initial trail");

    terminal.type("/script stale\r");
    await vi.waitFor(() => expect(inspectorStarted).toBe(true));
    terminal.type("/fork\r");
    await vi.waitFor(() => {
      const currentTrailId = runtime.listTrailSummaries()[0]?.trailId;
      expect(currentTrailId).toBeDefined();
      expect(currentTrailId).not.toBe(originalTrailId);
    });
    rejectInspector?.(new Error("STALE_INSPECTOR_REJECTION"));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(terminal.output).not.toContain("STALE_INSPECTOR_REJECTION");
    expect(terminal.output).toContain("● IDLE");
    terminal.type("/quit\n");
    await running;
  });

  test("renders a forked trail when the trail-switching command settles", async () => {
    const base = await createRuntime({
      name: "fork-render-scripted",
      async run(request) {
        return {
          text: request.prompt,
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer: consumeSteer,
      async abort() {},
    });
    let releaseFork: (() => void) | undefined;
    const forkGate = new Promise<void>((resolve) => {
      releaseFork = resolve;
    });
    let forkStarted = false;
    const runtime = Object.freeze({
      ...base,
      forkTrail: async (trailId: string) => {
        forkStarted = true;
        await forkGate;
        const forked = await base.forkTrail(trailId);
        return Object.freeze({ ...forked, model: "forked" });
      },
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("/fork\r");
    await vi.waitFor(() => expect(forkStarted).toBe(true));
    releaseFork?.();
    await vi.waitFor(() => expect(terminal.output).toContain("test-provider/forked"));

    terminal.type("/quit\n");
    await running;
  });

  test("renders a newly selected model when the trail-switching command settles", async () => {
    const base = await createRuntime({
      name: "model-render-scripted",
      async run(request) {
        return {
          text: request.prompt,
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer: consumeSteer,
      async abort() {},
    });
    let releaseModel: (() => void) | undefined;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    let starts = 0;
    let modelStarted = false;
    const runtime = Object.freeze({
      ...base,
      startTrail: async (input: Parameters<typeof base.startTrail>[0]) => {
        starts += 1;
        if (starts > 1) {
          modelStarted = true;
          await modelGate;
        }
        return await base.startTrail(input);
      },
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("/model visible/v1\r");
    await vi.waitFor(() => expect(modelStarted).toBe(true));
    releaseModel?.();
    await vi.waitFor(() => expect(terminal.output).toContain("visible/v1"));

    terminal.type("/quit\n");
    await running;
  });

  test("distinguishes unsupported inspectors from supported empty libraries", async () => {
    const agent: NoesisAgentRuntime = {
      name: "inspector-support-scripted",
      async run(request) {
        return {
          text: request.prompt,
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer: consumeSteer,
      async abort() {},
    };
    const unsupported = await createRuntime(agent);
    const unsupportedTerminal = createTestTerminal();
    const unsupportedRun = startNoesisTui(unsupported, {}, unsupportedTerminal);
    await vi.waitFor(() => expect(unsupportedTerminal.output).toContain("● IDLE"));
    unsupportedTerminal.type("/skills\r");
    await vi.waitFor(() => expect(unsupportedTerminal.output).toContain("unavailable in this runtime"));
    unsupportedTerminal.type("/quit\n");
    await unsupportedRun;

    const empty = Object.freeze({
      ...(await createRuntime(agent)),
      listSkills: async () => Object.freeze([]),
    });
    const emptyTerminal = createTestTerminal();
    const emptyRun = startNoesisTui(empty, {}, emptyTerminal);
    await vi.waitFor(() => expect(emptyTerminal.output).toContain("● IDLE"));
    emptyTerminal.type("/skills\r");
    await vi.waitFor(() => expect(emptyTerminal.output).toContain("No skills are installed"));
    expect(emptyTerminal.output).not.toContain("unavailable in this runtime");
    emptyTerminal.type("/quit\n");
    await emptyRun;
  });

  test("serializes slash commands with prompts and other commands", async () => {
    let releaseCompact: (() => void) | undefined;
    const compactGate = new Promise<void>((resolve) => {
      releaseCompact = resolve;
    });
    let compactStarted = false;
    const prompts: string[] = [];
    const base = await createRuntime({
      name: "command-serialization-scripted",
      async run(request) {
        prompts.push(request.prompt);
        return {
          text: `reply:${request.prompt}`,
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer: consumeSteer,
      async abort() {},
    });
    const runtime = Object.freeze({
      ...base,
      compact: async () => {
        compactStarted = true;
        await compactGate;
      },
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("/compact\r");
    await vi.waitFor(() => expect(compactStarted).toBe(true));
    terminal.type("do not overlap\r");
    await vi.waitFor(() => expect(terminal.output).toContain("A command is active."));
    expect(prompts).toEqual([]);

    releaseCompact?.();
    await vi.waitFor(() => expect(terminal.output).toContain("Trail compacted."));
    terminal.type("after compact\r");
    await vi.waitFor(() => expect(terminal.output).toContain("reply:after compact"));
    expect(prompts).toEqual(["after compact"]);

    terminal.type("/quit\n");
    await running;
  });

  test("recognizes a coalesced /quit plus LF chunk", async () => {
    const runtime = await createRuntime({
      name: "coalesced-quit-scripted",
      async run(request) {
        return {
          text: request.prompt,
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer: consumeSteer,
      async abort() {},
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.send("/quit\n");

    await running;
    expect(terminal.stops).toBe(1);
  });

  test("never recognizes /quit plus LF while bracketed paste owns the input", async () => {
    const runtime = await createRuntime({
      name: "pasted-quit-scripted",
      async run(request) {
        return {
          text: request.prompt,
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer: consumeSteer,
      async abort() {},
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.send("\u001b[200~");
    terminal.send("/quit\n");
    terminal.send("\u001b[201~");
    terminal.send("\u0007");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(terminal.stops).toBe(0);
    expect(terminal.starts).toBe(1);
    terminal.send("\u0003");
    await running;
  });

  test.each([
    ["/quit", "/quit\r"],
    ["Ctrl+C", "\u0003"],
  ] as const)("releases the terminal immediately and settles an active compact before %s shutdown completes", async (_exit, exitInput) => {
    let releaseCompact: (() => void) | undefined;
    const compactGate = new Promise<void>((resolve) => {
      releaseCompact = resolve;
    });
    let compactStarted = false;
    let compactFinished = false;
    const base = await createRuntime({
      name: "command-shutdown-scripted",
      async run(request) {
        return {
          text: request.prompt,
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer: consumeSteer,
      async abort() {},
    });
    const runtime = Object.freeze({
      ...base,
      compact: async () => {
        compactStarted = true;
        await compactGate;
        compactFinished = true;
      },
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    let shutdownCompleted = false;
    void running.then(() => {
      shutdownCompleted = true;
    });
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("/compact\r");
    await vi.waitFor(() => expect(compactStarted).toBe(true));
    terminal.type(exitInput);
    await vi.waitFor(() => expect(terminal.stops).toBe(1));
    expect(shutdownCompleted).toBe(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(shutdownCompleted).toBe(false);

    releaseCompact?.();
    await running;
    expect(compactFinished).toBe(true);
    expect(terminal.output).not.toContain("Trail compacted.");
    expect(terminal.stops).toBe(1);
  });

  test("queues prompts submitted during a turn and drains them in FIFO order", async () => {
    let releaseTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const prompts: string[] = [];
    const runtime = await createRuntime({
      name: "prompt-serialization-scripted",
      async run(request) {
        prompts.push(request.prompt);
        await turnGate;
        return {
          text: `reply:${request.prompt}`,
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer: consumeSteer,
      async abort() {},
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("first prompt\r");
    terminal.type("second prompt\r");
    await vi.waitFor(() => expect(terminal.output).toContain("QUEUED · 1"));
    expect(terminal.output).toContain("second prompt");
    expect(prompts).toEqual(["first prompt"]);

    releaseTurn?.();
    await vi.waitFor(() => expect(terminal.output).toContain("reply:first prompt"));
    await vi.waitFor(() => expect(prompts).toEqual(["first prompt", "second prompt"]));
    await vi.waitFor(() => expect(terminal.output).toContain("reply:second prompt"));
    terminal.type("/quit\n");
    await running;
  });

  test("promotes the newest queued prompt to a steer and accepts explicit steering text", async () => {
    let releaseTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const steer = vi.fn(async () => ({
      status: "consumed" as const,
      timelineSequence: 1,
      consumedAt: "2026-07-31T00:00:00.000Z",
    }));
    const runtime = await createRuntime({
      name: "steering-scripted",
      async run(request) {
        await turnGate;
        return {
          text: "done",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer,
      async abort() {
        releaseTurn?.();
      },
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("first\r");
    await vi.waitFor(() => expect(terminal.output).toContain("● THINKING"));
    terminal.type("promote me\r");
    await vi.waitFor(() => expect(terminal.output).toContain("QUEUED · 1"));
    terminal.type("/steer\r");
    await vi.waitFor(() => expect(steer).toHaveBeenCalledWith(expect.any(String), "promote me"));
    terminal.type("/steer redirect now\r");
    await vi.waitFor(() => expect(steer).toHaveBeenCalledWith(expect.any(String), "redirect now"));

    releaseTurn?.();
    terminal.type("/quit\n");
    await running;
  });

  test("restores the newest queued prompt into the current draft with Alt+Up", async () => {
    let releaseTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const prompts: string[] = [];
    const runtime = await createRuntime({
      name: "restore-queued-scripted",
      async run(request) {
        prompts.push(request.prompt);
        await turnGate;
        return {
          text: "done",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer: consumeSteer,
      async abort() {
        releaseTurn?.();
      },
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("first\r");
    terminal.type("queued message\r");
    await vi.waitFor(() => expect(terminal.output).toContain("QUEUED · 1"));
    terminal.type("draft prefix");
    terminal.send("\u001bp");
    const trail = runtime.listTrails()[0];
    if (!trail) throw new Error("Expected active trail");
    await vi.waitFor(async () =>
      expect((await runtime.inspectInteraction(trail.trailId)).pending).toHaveLength(0),
    );
    terminal.send("\r");
    releaseTurn?.();
    await vi.waitFor(() => expect(prompts).toContain("draft prefix\nqueued message"));

    terminal.type("/quit\n");
    await running;
  });

  test("blocks session-mutating slash commands while a turn is active", async () => {
    let releaseTurn: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const base = await createRuntime({
      name: "active-command-guard-scripted",
      async run(request) {
        await gate;
        return {
          text: "done",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer: consumeSteer,
      async abort() {
        releaseTurn?.();
      },
    });
    const compact = vi.fn(base.compact);
    const runtime = Object.freeze({ ...base, compact });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("first\r");
    await vi.waitFor(() => expect(terminal.output).toContain("● THINKING"));
    terminal.type("/compact\r");
    await vi.waitFor(() => expect(terminal.output).toContain("changes the session"));
    expect(compact).not.toHaveBeenCalled();

    releaseTurn?.();
    terminal.type("/quit\n");
    await running;
  });

  test("preserves leading and trailing whitespace in ordinary prompts", async () => {
    const prompts: string[] = [];
    const runtime = await createRuntime({
      name: "prompt-whitespace-scripted",
      async run(request) {
        prompts.push(request.prompt);
        return {
          text: "preserved",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer: consumeSteer,
      async abort() {},
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("  indented value  \r");
    await vi.waitFor(() => expect(prompts).toEqual(["  indented value  "]));
    const trail = runtime.listTrails()[0];
    if (!trail) throw new Error("Expected prompt whitespace trail");
    await vi.waitFor(() =>
      expect(runtime.getTrail(trail.trailId).turns[0]?.input).toBe("  indented value  "),
    );

    terminal.type("/quit\n");
    await running;
  });

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
      steer: consumeSteer,
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
      steer: consumeSteer,
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

  test("restores durable tool calls as expandable transcript rows", async () => {
    const base = await createRuntime({
      name: "resume-actions-scripted",
      async run(request) {
        return {
          text: `reply:${request.prompt}`,
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer: consumeSteer,
      async abort() {},
    });
    const selected = await base.startTrail({ title: "selected" });
    const transcript: readonly RuntimeTranscriptEntry[] = [
      {
        kind: "message",
        messageId: "message-user",
        turnId: "turn-1",
        role: "user",
        text: "where am I?",
        createdAt: "2026-07-31T10:00:00.000Z",
      },
      {
        kind: "action",
        actionId: "execute-1",
        turnId: "turn-1",
        executionId: "execution-1",
        name: "execute",
        status: "completed",
        input: { source: "return await tools.shell.run({ command: 'pwd' });" },
        output: { calls: 1 },
        startedAt: "2026-07-31T10:00:01.000Z",
        completedAt: "2026-07-31T10:00:02.000Z",
      },
      {
        kind: "action",
        actionId: "shell-1",
        turnId: "turn-1",
        parentActionId: "execute-1",
        name: "shell.run",
        status: "completed",
        input: { command: "pwd" },
        output: { stdout: "/workspace", exitCode: 0 },
        startedAt: "2026-07-31T10:00:01.250Z",
        completedAt: "2026-07-31T10:00:01.750Z",
      },
      {
        kind: "message",
        messageId: "message-assistant",
        turnId: "turn-1",
        role: "assistant",
        text: "You are in /workspace.",
        createdAt: "2026-07-31T10:00:03.000Z",
      },
    ];
    const runtime = Object.freeze({
      ...base,
      getTranscript: async (trailId: string) =>
        trailId === selected.trailId ? transcript : base.getTranscript(trailId),
    });
    const terminal = createTestTerminal();

    const running = startNoesisTui(
      runtime,
      { session: { mode: "resume", trailId: selected.trailId } },
      terminal,
    );
    await vi.waitFor(() => expect(terminal.output).toContain("shell.run"));
    expect(terminal.output).toContain("You are in /workspace.");

    terminal.type("\u000f");
    terminal.type(" ");
    await vi.waitFor(() => expect(terminal.output).toContain('"command": "pwd"'));
    expect(terminal.output).toContain('"stdout": "/workspace"');

    terminal.type("\u001b");
    terminal.type("/quit\n");
    await running;
  });

  test("renders lifecycle and usage updates from real runtime events", async () => {
    let releaseTool: (() => void) | undefined;
    const toolBlocked = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const runtime = await createRuntime({
      name: "telemetry-scripted",
      async run(request, emit) {
        emit({
          type: "model",
          provider: request.provider,
          model: request.model,
          contextWindow: 4_000,
        });
        emit({ type: "status", status: "started" });
        emit({
          type: "tool-start",
          actionId: "inspect-1",
          name: "inspect",
          input: {},
        });
        await toolBlocked;
        emit({
          type: "tool-end",
          actionId: "inspect-1",
          name: "inspect",
          isError: false,
          result: { ok: true },
        });
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
      steer: consumeSteer,
      async abort() {},
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("use the snapshot\r");
    await vi.waitFor(() => expect(terminal.output).toContain("● TOOL"));
    await vi.waitFor(() => expect(terminal.output).toContain("● inspect"));
    expect(terminal.output).not.toContain("ACTIONS");
    expect(terminal.output).toContain("inspect");
    releaseTool?.();
    await vi.waitFor(() => expect(terminal.output).toContain("ctx  25%"));
    await vi.waitFor(() => expect(terminal.output).toContain("grounded answer"));
    await vi.waitFor(() => expect(terminal.output).toContain("1t"));
    expect(terminal.output.lastIndexOf("✓ inspect")).toBeLessThan(
      terminal.output.lastIndexOf("grounded answer"),
    );

    terminal.type("/quit\n");
    await running;
  });

  test("collapses codemode detail until the selected row is expanded", async () => {
    const source = Array.from({ length: 20 }, (_, index) => `source line ${String(index + 1)}`).join("\n");
    const runtime = await createRuntime({
      name: "actions-scripted",
      async run(request, emit) {
        emit({ type: "status", status: "started" });
        emit({
          type: "tool-start",
          actionId: "execute-long",
          name: "execute",
          input: { source },
        });
        emit({
          type: "tool-end",
          actionId: "execute-long",
          name: "execute",
          isError: false,
          result: { calls: 2 },
        });
        emit({ type: "status", status: "completed" });
        return {
          text: "done",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer: consumeSteer,
      async abort() {},
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("run it\r");
    await vi.waitFor(() => expect(terminal.output).toContain("✓ execute"));
    expect(terminal.output).not.toContain("source line 20");

    // Ctrl+O selects the most recent action, then space expands just that row.
    terminal.send("\u000f");
    await vi.waitFor(() => expect(terminal.output).toContain("▸"));
    terminal.send(" ");
    await vi.waitFor(() => expect(terminal.output).toContain("source line 5"));

    terminal.send("\u001b");
    terminal.type("/quit\n");
    await running;
  });

  test("never erases terminal scrollback while the transcript grows and shrinks", async () => {
    const source = Array.from({ length: 40 }, (_, index) => `source line ${String(index + 1)}`).join("\n");
    const runtime = await createRuntime({
      name: "scrollback-scripted",
      async run(request, emit) {
        emit({ type: "status", status: "started" });
        emit({
          type: "tool-start",
          actionId: "execute-1",
          name: "execute",
          input: { source },
        });
        emit({
          type: "tool-start",
          actionId: "execute-1:call:1",
          parentActionId: "execute-1",
          name: "files.read",
          input: { path: "state.ts" },
        });
        emit({
          type: "tool-end",
          actionId: "execute-1:call:1",
          parentActionId: "execute-1",
          name: "files.read",
          isError: false,
          result: {
            path: "state.ts",
            content: "x".repeat(4_000),
            totalLines: 287,
          },
        });
        emit({
          type: "tool-end",
          actionId: "execute-1",
          name: "execute",
          isError: false,
          result: { calls: 1 },
        });
        emit({ type: "status", status: "completed" });
        return {
          text: "done",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer: consumeSteer,
      async abort() {},
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("run it\r");
    await vi.waitFor(() => expect(terminal.output).toContain("287 lines"));
    // Ctrl+O selects the newest action, the nested read; step up to its parent execute.
    terminal.send("\u000f");
    terminal.send("\u001b[A");
    terminal.send(" ");
    await vi.waitFor(() => expect(terminal.output).toContain("source line 5"));
    // Collapsing shrinks the rendered content; that must not clear what has scrolled away.
    const beforeCollapse = terminal.output.length;
    terminal.send(" ");
    await vi.waitFor(() => expect(terminal.output.length).toBeGreaterThan(beforeCollapse));
    expect(terminal.output.slice(beforeCollapse)).not.toContain("source line 5");
    terminal.send("\u001b");

    expect(terminal.output).not.toContain("\u001b[3J");

    terminal.type("/quit\n");
    await running;
  });

  test("opens and closes the run inspector from the transcript", async () => {
    const runtime = await createRuntime({
      name: "inspector-scripted",
      async run(request, emit) {
        emit({ type: "status", status: "started" });
        emit({
          type: "tool-start",
          actionId: "execute-1",
          name: "execute",
          input: {
            source: "return await tools.shell.run({ command: 'pwd' });",
          },
        });
        emit({
          type: "tool-end",
          actionId: "execute-1",
          name: "execute",
          isError: false,
          result: { calls: 0 },
        });
        emit({ type: "status", status: "completed" });
        return {
          text: "done",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer: consumeSteer,
      async abort() {},
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("run it\r");
    await vi.waitFor(() => expect(terminal.output).toContain("✓ execute"));
    terminal.send("\u000f");
    terminal.send("\r");
    await vi.waitFor(() => expect(terminal.output).toContain("esc close"));
    expect(terminal.output).toContain("tools.shell.run");

    terminal.send("\u001b");
    await vi.waitFor(() => expect(terminal.output).toContain("↑/↓ select"));

    terminal.send("\u001b");
    terminal.type("/quit\n");
    await running;
  });

  test("keeps a tall run inspector footer and final rows reachable after resize", async () => {
    const source = Array.from({ length: 80 }, (_, index) => `source line ${String(index + 1)}`).join("\n");
    const runtime = await createRuntime({
      name: "tall-inspector-scripted",
      async run(request, emit) {
        emit({ type: "status", status: "started" });
        emit({
          type: "tool-start",
          actionId: "execute-1",
          name: "execute",
          input: { source },
        });
        emit({
          type: "tool-end",
          actionId: "execute-1",
          name: "execute",
          isError: false,
          result: { calls: 0 },
        });
        emit({ type: "status", status: "completed" });
        return {
          text: "done",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer: consumeSteer,
      async abort() {},
    });
    const terminal = createTestTerminal();
    terminal.resize(100, 50);
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("run it\r");
    await vi.waitFor(() => expect(terminal.output).toContain("✓ execute"));
    terminal.send("\u000f");
    terminal.send("\r");
    await vi.waitFor(() => expect(terminal.output).toContain("pgup/pgdn scroll"));

    for (let index = 0; index < 12; index += 1) terminal.send("\u001b[6~");
    await vi.waitFor(() => expect(terminal.output).toContain('"calls": 0'));

    const resizedAt = terminal.output.length;
    terminal.resize(100, 40);
    await vi.waitFor(() => expect(terminal.output.slice(resizedAt)).toContain("pgup/pgdn scroll"));
    for (let page = 0; page < 8; page += 1) terminal.send("\u001b[6~");
    await vi.waitFor(() => expect(terminal.output.slice(resizedAt)).toContain('"calls": 0'));

    terminal.send("\u001b");
    terminal.send("\u001b");
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
        emit({
          type: "tool-start",
          actionId: "inspect-1",
          name: "inspect",
          input: {},
        });
        emit({
          type: "tool-end",
          actionId: "inspect-1",
          name: "inspect",
          isError: false,
          result: { ok: true },
        });
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
      steer: consumeSteer,
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
      steer: consumeSteer,
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
      steer: consumeSteer,
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

  test("surfaces unexpected agent errors and permits a later turn", async () => {
    const unexpected = new Error("unexpected adapter failure");
    let runs = 0;
    const runtime = await createRuntime({
      name: "throwing-scripted",
      async run(request) {
        runs += 1;
        if (runs === 1) throw unexpected;
        return {
          text: "recovered",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer: consumeSteer,
      async abort() {},
    });
    const trail = await runtime.startTrail({ title: "unexpected failure" });

    await expect(runtime.runTurn(trail.trailId, "first")).rejects.toBe(unexpected);
    expect(runtime.getTrail(trail.trailId).status).toBe("idle");
    await expect(runtime.runTurn(trail.trailId, "second")).resolves.toMatchObject({
      outcome: "completed",
      output: "recovered",
    });
    expect(runtime.getTrail(trail.trailId).turns).toEqual([{ input: "second", output: "recovered" }]);
  });

  test("interrupts gracefully, preserves queued work, and resumes only on request", async () => {
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
      steer: consumeSteer,
      abort,
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("block this turn\r");
    await vi.waitFor(() => expect(terminal.output).toContain("● STREAMING"));
    terminal.type("another turn\r");
    await vi.waitFor(() => expect(terminal.output).toContain("QUEUED · 1"));
    expect(runs).toBe(1);

    terminal.send("\u001b");
    await vi.waitFor(() => expect(terminal.output).toContain("● ABORTING"));
    await vi.waitFor(() => expect(terminal.output).toContain("Turn interrupted."));
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));
    expect(abort).toHaveBeenCalledOnce();
    expect(terminal.stops).toBe(0);
    expect(runs).toBe(1);
    expect(terminal.output).toContain("paused");

    terminal.type("/queue resume\r");
    await vi.waitFor(() => expect(runs).toBe(3));
    await vi.waitFor(() => expect(runtime.listTrails()[0]?.turns).toHaveLength(2));

    terminal.type("/quit\n");
    await running;
    expect(terminal.stops).toBe(1);
  });

  test("does not treat a fragmented bracketed-paste opener as active-turn Escape", async () => {
    let releaseBlocked: (() => void) | undefined;
    const abort = vi.fn(async () => {
      releaseBlocked?.();
    });
    const runtime = await createRuntime({
      name: "fragmented-paste-active-turn-scripted",
      async run(request, emit) {
        emit({ type: "delta", text: "still running" });
        await new Promise<void>((resolve) => {
          releaseBlocked = resolve;
        });
        return {
          text: "",
          provider: request.provider,
          model: request.model,
          outcome: "aborted",
          stopReason: "aborted",
        };
      },
      steer: consumeSteer,
      abort,
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));
    terminal.type("block this turn\r");
    await vi.waitFor(() => expect(terminal.output).toContain("still running"));

    terminal.send("\u001b");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    terminal.send("[20");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    terminal.send("0~pasted\u0003\r\u001b[201~");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(abort).not.toHaveBeenCalled();
    expect(terminal.stops).toBe(0);
    expect(terminal.output).toContain("● STREAMING");

    terminal.send("\u0003");
    await running;
    expect(abort).toHaveBeenCalledOnce();
    expect(terminal.stops).toBe(1);
  });

  test("does not let delayed Escape feedback abort the successor to the visible turn", async () => {
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    let secondInterrupted = false;
    let runs = 0;
    const abort = vi.fn(async () => {
      secondInterrupted = true;
      releaseSecond?.();
    });
    const runtime = await createRuntime({
      name: "stale-interrupt-scripted",
      async run(request, emit) {
        runs += 1;
        const currentRun = runs;
        if (currentRun === 1) emit({ type: "delta", text: "running 1" });
        await new Promise<void>((resolve) => {
          if (currentRun === 1) releaseFirst = resolve;
          else releaseSecond = resolve;
        });
        if (currentRun === 2 && secondInterrupted)
          return {
            text: "finished 2",
            provider: request.provider,
            model: request.model,
            outcome: "aborted",
            stopReason: "aborted",
          };
        return {
          text: `finished ${String(currentRun)}`,
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      steer: consumeSteer,
      abort,
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("first\r");
    await vi.waitFor(() => expect(terminal.output).toContain("running 1"));
    terminal.type("second\r");
    await vi.waitFor(() => expect(terminal.output).toContain("QUEUED · 1"));
    terminal.send("\u001b");
    releaseFirst?.();
    await vi.waitFor(() => expect(runs).toBe(2));
    await new Promise<void>((resolve) => setTimeout(resolve, 40));

    expect(abort).not.toHaveBeenCalled();
    expect(terminal.output).toContain("● THINKING");

    terminal.send("\u001b");
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(terminal.output).toContain("Turn interrupted."));
    terminal.type("/quit\n");
    await running;
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
      steer: consumeSteer,
      async abort() {},
    });
    const mainTerminal = createTestTerminal();
    mainTerminal.resize(120, 35);
    const main = startNoesisTui(runtime, {}, mainTerminal);
    await vi.waitFor(() => expect(mainTerminal.output).toContain("███╗   ██╗ ██████╗"));
    mainTerminal.resize(50, 9);
    await vi.waitFor(() => expect(mainTerminal.output).toContain("? help · ctrl+o inspect runs"));
    expect(mainTerminal.output).toContain("› message");
    mainTerminal.type("/quit\n");
    await main;

    for (let index = 0; index < 12; index += 1)
      await runtime.startTrail({
        title: `picker resize ${String(index).padStart(2, "0")}`,
      });
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
      steer: consumeSteer,
      async abort() {},
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("? help · ctrl+o inspect runs"));
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
      steer: consumeSteer,
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
    expect(terminal.output).toContain(`s ${selected.trailId.slice(6, 14)}`);
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
      steer: consumeSteer,
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
    await vi.waitFor(() => expect(terminal.output).toContain(`s ${older.trailId.slice(6, 14)}`));
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
      steer: consumeSteer,
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
      steer: consumeSteer,
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
      steer: consumeSteer,
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
      steer: consumeSteer,
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
      steer: consumeSteer,
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
      steer: consumeSteer,
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
