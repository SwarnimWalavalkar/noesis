import type { NoesisAgentRuntime } from "@noesis/agent-types";
import { describe, expect, test, vi } from "vitest";
import {
  createTuiMcpInteractionBridge,
  startNoesisTui,
  type TuiMcpFormElicitationResult,
  type TuiMcpInteractionPresenter,
} from "../src/index.ts";
import { createInMemoryTestRuntime } from "./support/in-memory-runtime.ts";
import { createTestTerminal } from "./support/test-terminal.ts";

const ENTER = "\r";
const DOWN = "\u001b[B";
const ESCAPE = "\u001b";
const DECLINE = "\u0004";

describe("MCP TUI interaction bridge", () => {
  test("queues server elicitation before the TUI attaches and presents requests in order", async () => {
    const bridge = createTuiMcpInteractionBridge();
    const first = bridge.handlers.elicitForm({
      serverName: "research",
      title: "Choose a source",
      message: "The server needs one preference.",
      fields: [{ type: "text", name: "topic", label: "Topic", required: true }],
    });
    const second = bridge.handlers.elicitUrl({
      serverName: "research",
      elicitationId: "research-auth",
      title: "Authorize",
      message: "Continue authentication.",
      url: "https://auth.example.test",
    });
    expect(bridge.pendingCount()).toBe(2);

    let settleForm: ((result: TuiMcpFormElicitationResult) => void) | undefined;
    let formCancelled = 0;
    const presenter: TuiMcpInteractionPresenter = {
      presentForm: () => ({
        result: new Promise((resolve) => {
          settleForm = resolve;
        }),
        cancel: () => {
          formCancelled += 1;
        },
      }),
      presentUrl: () => ({
        result: Promise.resolve({ action: "accept" }),
        cancel: () => undefined,
      }),
    };
    const detach = bridge.attach(presenter);
    expect(bridge.pendingCount()).toBe(2);
    settleForm?.({ action: "accept", values: { topic: "agents" } });

    await expect(first).resolves.toEqual({ action: "accept", values: { topic: "agents" } });
    await expect(second).resolves.toEqual({ action: "accept" });
    expect(bridge.pendingCount()).toBe(0);
    detach();
    expect(formCancelled).toBe(0);
  });

  test("shutdown cancels active, queued, and future server requests", async () => {
    const bridge = createTuiMcpInteractionBridge();
    let cancelled = 0;
    bridge.attach({
      presentForm: () => ({
        result: new Promise(() => undefined),
        cancel: () => {
          cancelled += 1;
        },
      }),
      presentUrl: () => ({
        result: new Promise(() => undefined),
        cancel: () => {
          cancelled += 1;
        },
      }),
    });
    const active = bridge.handlers.elicitForm({
      serverName: "one",
      title: "Input",
      message: "Input needed",
      fields: [],
    });
    const queued = bridge.handlers.elicitUrl({
      serverName: "two",
      elicitationId: "two-auth",
      title: "Authorize",
      message: "Authorization needed",
      url: "https://example.test",
    });

    bridge.shutdown();

    await expect(active).resolves.toEqual({ action: "cancel" });
    await expect(queued).resolves.toEqual({ action: "cancel" });
    await expect(
      bridge.handlers.elicitForm({
        serverName: "three",
        title: "Input",
        message: "Input needed",
        fields: [],
      }),
    ).resolves.toEqual({ action: "cancel" });
    expect(cancelled).toBe(1);
    expect(bridge.pendingCount()).toBe(0);
  });

  test("aborts only the exact queued or active request", async () => {
    const bridge = createTuiMcpInteractionBridge();
    let settleActive: ((result: TuiMcpFormElicitationResult) => void) | undefined;
    let activeCancelled = 0;
    let presentedUrls = 0;
    bridge.attach({
      presentForm: () => ({
        result: new Promise((resolve) => {
          settleActive = resolve;
        }),
        cancel: () => {
          activeCancelled += 1;
        },
      }),
      presentUrl: () => {
        presentedUrls += 1;
        return { result: new Promise(() => undefined), cancel: () => undefined };
      },
    });
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const active = bridge.handlers.elicitForm(
      { serverName: "one", title: "Input", message: "Input needed", fields: [] },
      activeController.signal,
    );
    const queued = bridge.handlers.elicitUrl(
      {
        serverName: "two",
        elicitationId: "two-auth",
        title: "Authorize",
        message: "Authorization needed",
        url: "https://example.test",
      },
      queuedController.signal,
    );

    queuedController.abort();
    await expect(queued).resolves.toEqual({ action: "cancel" });
    expect(presentedUrls).toBe(0);
    expect(bridge.pendingCount()).toBe(1);

    activeController.abort();
    await expect(active).resolves.toEqual({ action: "cancel" });
    expect(activeCancelled).toBe(1);
    expect(bridge.pendingCount()).toBe(0);
    settleActive?.({ action: "accept", values: {} });
    expect(bridge.pendingCount()).toBe(0);
  });

  test("settles only the URL request named by a completion notification", async () => {
    const bridge = createTuiMcpInteractionBridge();
    let cancelled = 0;
    bridge.attach({
      presentForm: () => ({ result: new Promise(() => undefined), cancel: () => undefined }),
      presentUrl: () => ({
        result: new Promise(() => undefined),
        cancel: () => {
          cancelled += 1;
        },
      }),
    });
    const request = bridge.handlers.elicitUrl({
      serverName: "linear",
      elicitationId: "external-auth",
      title: "Authorize",
      message: "Authorization needed",
      url: "https://example.test",
    });

    expect(bridge.completeUrl("linear", "unknown")).toBe(false);
    expect(bridge.pendingCount()).toBe(1);
    expect(bridge.completeUrl("linear", "external-auth")).toBe(true);
    await expect(request).resolves.toEqual({ action: "accept" });
    expect(cancelled).toBe(1);
    expect(bridge.pendingCount()).toBe(0);
  });

  test("renders form and URL elicitation inside the mounted TUI", async () => {
    const agent: NoesisAgentRuntime = {
      name: "mcp-elicitation-scripted",
      async run(request) {
        return {
          text: request.prompt,
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer() {
        return { status: "consumed", timelineSequence: 1, consumedAt: new Date().toISOString() };
      },
      async abort() {},
    };
    const bridge = createTuiMcpInteractionBridge();
    const terminal = createTestTerminal();
    const opened: string[] = [];
    const running = startNoesisTui(
      createInMemoryTestRuntime(agent),
      {
        mcpInteractionBridge: bridge,
        openUrl: async (url) => {
          opened.push(url);
        },
      },
      terminal,
    );
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    const form = bridge.handlers.elicitForm({
      serverName: "linear",
      title: "Create issue",
      message: "Choose the issue properties.",
      fields: [
        { type: "secret", name: "token", label: "Temporary token", required: true },
        {
          type: "select",
          name: "priority",
          label: "Priority",
          choices: [
            { value: "normal", label: "Normal" },
            { value: "urgent", label: "Urgent" },
          ],
        },
        {
          type: "multiselect",
          name: "labels",
          label: "Labels",
          choices: [
            { value: "source", label: "Source" },
            { value: "issues", label: "Issues" },
          ],
          defaultValue: ["source"],
        },
      ],
    });
    await vi.waitFor(() => expect(terminal.output).toContain("Temporary token"));
    terminal.type("top-secret");
    await vi.waitFor(() => expect(terminal.output).toContain("•••"));
    expect(terminal.output).not.toContain("top-secret");
    terminal.send(ENTER);
    await vi.waitFor(() => expect(terminal.output).toContain("Priority"));
    terminal.send(DOWN);
    terminal.send(ENTER);
    await vi.waitFor(() => expect(terminal.output).toContain("Labels"));
    expect(terminal.output).toContain("[x] Source");
    terminal.send(DOWN);
    terminal.send(" ");
    terminal.send(ENTER);
    await expect(form).resolves.toEqual({
      action: "accept",
      values: { token: "top-secret", priority: "urgent", labels: ["source", "issues"] },
    });

    const url = bridge.handlers.elicitUrl({
      serverName: "linear",
      elicitationId: "linear-auth",
      title: "Authorize",
      message: "Grant access in your browser.",
      url: "https://auth.linear.test/authorize",
    });
    await vi.waitFor(() => expect(terminal.output).toContain("https://auth.linear.test/authorize"));
    expect(terminal.output).toContain("Domain · auth.linear.test");
    expect(opened).toEqual([]);
    terminal.send(ENTER);
    await expect(url).resolves.toEqual({ action: "accept" });
    await vi.waitFor(() => expect(opened).toEqual(["https://auth.linear.test/authorize"]));

    const declined = bridge.handlers.elicitUrl({
      serverName: "linear",
      elicitationId: "linear-decline",
      title: "Authorize",
      message: "Grant access in your browser.",
      url: "https://decline.linear.test/authorize",
    });
    await vi.waitFor(() => expect(terminal.output).toContain("decline.linear.test"));
    terminal.send(DECLINE);
    await expect(declined).resolves.toEqual({ action: "decline" });
    expect(opened).toEqual(["https://auth.linear.test/authorize"]);

    const cancelled = bridge.handlers.elicitUrl({
      serverName: "linear",
      elicitationId: "linear-cancel",
      title: "Authorize",
      message: "Grant access in your browser.",
      url: "https://cancel.linear.test/authorize",
    });
    await vi.waitFor(() => expect(terminal.output).toContain("cancel.linear.test"));
    terminal.send(ESCAPE);
    await expect(cancelled).resolves.toEqual({ action: "cancel" });
    expect(opened).toEqual(["https://auth.linear.test/authorize"]);

    terminal.type("/quit\n");
    await running;
    expect(bridge.pendingCount()).toBe(0);
  });

  test("sanitizes server-controlled form and URL strings before rendering", async () => {
    const agent: NoesisAgentRuntime = {
      name: "mcp-elicitation-sanitization",
      async run(request) {
        return {
          text: request.prompt,
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer() {
        return { status: "consumed", timelineSequence: 1, consumedAt: new Date().toISOString() };
      },
      async abort() {},
    };
    const bridge = createTuiMcpInteractionBridge();
    const terminal = createTestTerminal();
    const opened: string[] = [];
    const running = startNoesisTui(
      createInMemoryTestRuntime(agent),
      {
        mcpInteractionBridge: bridge,
        openUrl: async (url) => {
          opened.push(url);
        },
      },
      terminal,
    );
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));
    const hostile = "server\u001b]8;;https://attacker.test\u0007link\u001b]8;;\u001b\\";

    const form = bridge.handlers.elicitForm({
      serverName: hostile,
      title: hostile,
      message: hostile,
      fields: [
        {
          type: "select",
          name: "choice",
          label: hostile,
          description: hostile,
          choices: [{ value: "safe", label: hostile }],
        },
      ],
    });
    await vi.waitFor(() => expect(terminal.output).toContain("attacker.test"));
    expect(terminal.output).not.toContain("\u001b]8;;https://attacker.test");
    expect(terminal.output).not.toContain(hostile);
    terminal.send(ESCAPE);
    await expect(form).resolves.toEqual({ action: "cancel" });

    const url = bridge.handlers.elicitUrl({
      serverName: hostile,
      elicitationId: "hostile-url",
      title: hostile,
      message: hostile,
      url: "https://safe.example.test/path?label=%1B%5D8",
    });
    await vi.waitFor(() => expect(terminal.output).toContain("Domain · safe.example.test"));
    expect(terminal.output).not.toContain("\u001b]8;;https://attacker.test");
    expect(terminal.output).not.toContain(hostile);
    expect(opened).toEqual([]);
    terminal.send(ESCAPE);
    await expect(url).resolves.toEqual({ action: "cancel" });
    expect(opened).toEqual([]);

    terminal.type("/quit\n");
    await running;
  });
});
