import type { NoesisAgentRuntime } from "@noesis/agent-types";
import { describe, expect, test, vi } from "vitest";
import {
  createMcpManagerOverlay,
  startNoesisTui,
  type TuiMcpMutationIntent,
  type TuiMcpServerDetail,
  type TuiMcpServerSummary,
} from "../src/index.ts";
import { createInMemoryTestRuntime } from "./support/in-memory-runtime.ts";
import { createTestTerminal } from "./support/test-terminal.ts";

const ENTER = "\r";
const DOWN = "\u001b[B";
const ESCAPE = "\u001b";

const summary: TuiMcpServerSummary = Object.freeze({
  name: "github",
  scope: "global",
  sourcePath: "/home/user/.noesis/mcp.json",
  enabled: true,
  type: "remote",
  status: "auth_required",
  capabilityCounts: Object.freeze({ tools: 1, prompts: 1, resources: 1, resourceTemplates: 1 }),
});

const detail: TuiMcpServerDetail = Object.freeze({
  ...summary,
  config: Object.freeze({ type: "remote", url: "https://example.test/mcp", oauth: true }),
  instructions: "Use repository-qualified searches.",
  negotiatedCapabilities: Object.freeze(["tools", "prompts", "resources"]),
  tools: Object.freeze([
    Object.freeze({
      name: "search_code",
      description: "Search source code",
      inputSchema: Object.freeze({ type: "object", properties: { query: { type: "string" } } }),
    }),
  ]),
  prompts: Object.freeze([
    Object.freeze({
      name: "review_pull_request",
      description: "Review a pull request",
      arguments: Object.freeze([Object.freeze({ name: "number", required: true })]),
    }),
  ]),
  resources: Object.freeze([
    Object.freeze({ uri: "repo://README.md", name: "README", mimeType: "text/markdown" }),
  ]),
  resourceTemplates: Object.freeze([
    Object.freeze({ uriTemplate: "repo://{path}", name: "Repository file" }),
  ]),
  recentErrors: Object.freeze([Object.freeze({ message: "Authentication expired", operation: "connect" })]),
});

const localDetail: TuiMcpServerDetail = Object.freeze({
  ...detail,
  name: "filesystem",
  type: "local",
  status: "connected",
  config: Object.freeze({ type: "local", command: Object.freeze(["npx", "filesystem-mcp"]) }),
  recentErrors: Object.freeze([]),
});

function createHarness(
  options: {
    readonly servers?: readonly TuiMcpServerSummary[];
    readonly detail?: TuiMcpServerDetail;
    readonly mutationsEnabled?: () => boolean;
    readonly list?: () => Promise<readonly TuiMcpServerSummary[]>;
    readonly mutate?: (
      intent: TuiMcpMutationIntent,
      signal?: AbortSignal,
    ) => Promise<{ readonly message: string; readonly browserUrl?: string }>;
  } = {},
) {
  let closes = 0;
  let renders = 0;
  const mutations: TuiMcpMutationIntent[] = [];
  const component = createMcpManagerOverlay({
    runtime: {
      listMcpServers: options.list ?? (async () => options.servers ?? Object.freeze([summary])),
      inspectMcpServer: async () => options.detail ?? detail,
      mutateMcp: async (intent, signal) => {
        mutations.push(intent);
        return options.mutate?.(intent, signal) ?? { message: `${intent.type} complete` };
      },
    },
    colorEnabled: false,
    height: () => 32,
    mutationsEnabled: options.mutationsEnabled ?? (() => true),
    requestRender: () => {
      renders += 1;
    },
    close: () => {
      closes += 1;
    },
  });
  return {
    component,
    mutations,
    get closes() {
      return closes;
    },
    get renders() {
      return renders;
    },
    output: () => component.render(100).join("\n"),
  };
}

describe("MCP manager overlay", () => {
  test("lets Escape close while initial discovery is still pending", async () => {
    const harness = createHarness({ list: async () => await new Promise(() => undefined) });
    expect(harness.output()).toContain("Refreshing MCP servers");
    harness.component.handleInput?.(ESCAPE);
    expect(harness.closes).toBe(1);
    await harness.component.dispose();
  });

  test("opens from /mcp as a focused overlay and returns to the editor", async () => {
    const agent: NoesisAgentRuntime = {
      name: "mcp-overlay-scripted",
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
    const base = createInMemoryTestRuntime(agent);
    const runtime = Object.freeze({
      ...base,
      listMcpServers: async () => Object.freeze([summary]),
      inspectMcpServer: async () => detail,
      mutateMcp: async (intent: TuiMcpMutationIntent) => ({ message: `${intent.type} complete` }),
    });
    const terminal = createTestTerminal();
    const running = startNoesisTui(runtime, {}, terminal);
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));

    terminal.type("/mcp\r");
    await vi.waitFor(() => expect(terminal.output).toContain("MCP servers"));
    await vi.waitFor(() => expect(terminal.output).toContain("github  global"));
    terminal.send(ESCAPE);
    terminal.type("after overlay\r");
    await vi.waitFor(() => expect(terminal.output).toContain("after overlay"));

    terminal.type("/quit\n");
    await running;
  });

  test("lists scoped servers and opens nested capability inspection", async () => {
    const harness = createHarness();
    await vi.waitFor(() => expect(harness.output()).toContain("github  global"));
    expect(harness.output()).toContain("auth required");
    expect(harness.output()).toContain("4 capabilities");

    harness.component.handleInput?.(ENTER);
    await vi.waitFor(() => expect(harness.output()).toContain("MCP · github"));
    expect(harness.output()).toContain("Tools (1)");
    expect(harness.output()).toContain("Authenticate");

    harness.component.handleInput?.(ENTER);
    expect(harness.output()).toContain("github · tools");
    expect(harness.output()).toContain("search_code");
    harness.component.handleInput?.(ENTER);
    expect(harness.output()).toContain("Input schema");
    expect(harness.output()).toContain('"query"');

    harness.component.handleInput?.(ESCAPE);
    expect(harness.output()).toContain("github · tools");
    harness.component.handleInput?.(ESCAPE);
    expect(harness.output()).toContain("MCP · github");
  });

  test("invokes authentication and keeps the browser URL inspectable", async () => {
    const harness = createHarness({
      mutate: async () => ({
        message: "Continue authentication in your browser.",
        browserUrl: "https://auth.example.test/authorize",
      }),
    });
    await vi.waitFor(() => expect(harness.output()).toContain("github  global"));
    harness.component.handleInput?.(ENTER);
    await vi.waitFor(() => expect(harness.output()).toContain("MCP · github"));

    harness.component.handleInput?.("a");
    await vi.waitFor(() => expect(harness.output()).toContain("https://auth.example.test/authorize"));
    expect(harness.mutations).toContainEqual({ type: "authenticate", scope: "global", name: "github" });
  });

  test("does not offer remote authentication actions for a local server", async () => {
    const localSummary: TuiMcpServerSummary = Object.freeze({
      name: localDetail.name,
      scope: localDetail.scope,
      sourcePath: localDetail.sourcePath,
      enabled: localDetail.enabled,
      type: localDetail.type,
      status: localDetail.status,
      capabilityCounts: localDetail.capabilityCounts,
    });
    const harness = createHarness({ servers: Object.freeze([localSummary]), detail: localDetail });
    await vi.waitFor(() => expect(harness.output()).toContain("filesystem  global"));
    harness.component.handleInput?.(ENTER);
    await vi.waitFor(() => expect(harness.output()).toContain("MCP · filesystem"));
    expect(harness.output()).not.toContain("a auth");
    expect(harness.output()).not.toContain("l logout");

    harness.component.handleInput?.("a");
    harness.component.handleInput?.("l");
    expect(harness.mutations).toEqual([]);
  });

  test("does not offer OAuth actions when a remote server has OAuth disabled", async () => {
    const oauthDisabled = Object.freeze({
      ...detail,
      config: Object.freeze({ type: "remote" as const, url: "https://example.test/mcp", oauth: false }),
    });
    const harness = createHarness({ detail: oauthDisabled });
    await vi.waitFor(() => expect(harness.output()).toContain("github  global"));
    harness.component.handleInput?.(ENTER);
    await vi.waitFor(() => expect(harness.output()).toContain("MCP · github"));
    expect(harness.output()).not.toContain("Authenticate");
    expect(harness.output()).not.toContain("a auth");
    expect(harness.output()).not.toContain("l logout");

    harness.component.handleInput?.("a");
    harness.component.handleInput?.("l");
    expect(harness.mutations).toEqual([]);
  });

  test("keeps inspection available but hides mutations while a turn is active", async () => {
    const harness = createHarness({ mutationsEnabled: () => false });
    await vi.waitFor(() => expect(harness.output()).toContain("github  global"));
    expect(harness.output()).not.toContain("Add local server");
    expect(harness.output()).toContain("Read-only while the active turn finishes");

    harness.component.handleInput?.(ENTER);
    await vi.waitFor(() => expect(harness.output()).toContain("MCP · github"));
    expect(harness.output()).toContain("Tools (1)");
    expect(harness.output()).not.toContain("Authenticate");
    expect(harness.output()).not.toContain("Reconnect");
    expect(harness.output()).not.toContain("Disable");

    for (const shortcut of ["a", "l", "e", "r", "d", "x"]) harness.component.handleInput?.(shortcut);
    expect(harness.mutations).toEqual([]);
  });

  test("renders shadowed definitions as inactive and hides live connection actions", async () => {
    const shadowedSummary = Object.freeze({ ...summary, status: "overridden" as const, shadowed: true });
    const shadowedDetail = Object.freeze({ ...detail, ...shadowedSummary });
    const harness = createHarness({ servers: Object.freeze([shadowedSummary]), detail: shadowedDetail });
    await vi.waitFor(() => expect(harness.output()).toContain("overridden"));
    expect(harness.output()).toContain("inactive");
    harness.component.handleInput?.(ENTER);
    await vi.waitFor(() => expect(harness.output()).toContain("MCP · github"));
    expect(harness.output()).not.toContain("Authenticate");
    expect(harness.output()).not.toContain("Reconnect");
    expect(harness.output()).toContain("Edit");

    harness.component.handleInput?.("a");
    harness.component.handleInput?.("r");
    expect(harness.mutations).toEqual([]);
  });

  test("lets Escape cancel an in-flight authentication", async () => {
    let authenticationSignal: AbortSignal | undefined;
    const harness = createHarness({
      mutate: async (intent, signal) => {
        if (intent.type !== "authenticate") return { message: `${intent.type} complete` };
        authenticationSignal = signal;
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason instanceof Error ? signal.reason : new Error("cancelled")),
            { once: true },
          );
        });
      },
    });
    await vi.waitFor(() => expect(harness.output()).toContain("github  global"));
    harness.component.handleInput?.(ENTER);
    await vi.waitFor(() => expect(harness.output()).toContain("MCP · github"));
    harness.component.handleInput?.("a");
    await vi.waitFor(() => expect(harness.output()).toContain("Esc cancel operation"));

    harness.component.handleInput?.(ESCAPE);
    await vi.waitFor(() => expect(authenticationSignal?.aborted).toBe(true));
    await vi.waitFor(() => expect(harness.output()).toContain("MCP operation cancelled"));
  });

  test("hides reconnect for a disabled server", async () => {
    const disabledSummary = Object.freeze({ ...summary, enabled: false, status: "disabled" as const });
    const disabledDetail = Object.freeze({ ...detail, ...disabledSummary });
    const harness = createHarness({ servers: Object.freeze([disabledSummary]), detail: disabledDetail });
    await vi.waitFor(() => expect(harness.output()).toContain("github  global"));
    harness.component.handleInput?.(ENTER);
    await vi.waitFor(() => expect(harness.output()).toContain("MCP · github"));
    expect(harness.output()).not.toContain("Reconnect");
    harness.component.handleInput?.("r");
    expect(harness.mutations).toEqual([]);
  });

  test("adds a project remote server through a guided form", async () => {
    const harness = createHarness({ servers: Object.freeze([]) });
    await vi.waitFor(() => expect(harness.output()).toContain("Add remote server"));

    harness.component.handleInput?.("r");
    expect(harness.output()).toContain("Where should this server be available?");
    harness.component.handleInput?.(ENTER);
    expect(harness.output()).toContain("Server name");
    for (const character of "linear") harness.component.handleInput?.(character);
    harness.component.handleInput?.(ENTER);
    expect(harness.output()).toContain("Streamable HTTP URL");
    // Replace the pre-filled https:// value.
    harness.component.handleInput?.("\u0001");
    harness.component.handleInput?.("\u000b");
    for (const character of "https://mcp.linear.test") harness.component.handleInput?.(character);
    harness.component.handleInput?.(ENTER);
    expect(harness.output()).toContain("Use MCP OAuth");
    harness.component.handleInput?.(ENTER);

    await vi.waitFor(() =>
      expect(harness.mutations).toContainEqual({
        type: "add-remote",
        scope: "project",
        name: "linear",
        url: "https://mcp.linear.test",
        oauth: true,
      }),
    );
  });

  test("rejects a remote server URL outside HTTP and HTTPS", async () => {
    const harness = createHarness({ servers: Object.freeze([]) });
    await vi.waitFor(() => expect(harness.output()).toContain("Add remote server"));
    harness.component.handleInput?.("r");
    harness.component.handleInput?.(ENTER);
    for (const character of "linear") harness.component.handleInput?.(character);
    harness.component.handleInput?.(ENTER);
    harness.component.handleInput?.("\u0001");
    harness.component.handleInput?.("\u000b");
    for (const character of "ftp://mcp.linear.test") harness.component.handleInput?.(character);
    harness.component.handleInput?.(ENTER);

    expect(harness.output()).toContain("must use http:// or https://");
    expect(harness.mutations).toEqual([]);
  });

  test("Escape never reports a committed non-auth mutation as cancelled and disposal awaits it", async () => {
    let mutationSignal: AbortSignal | undefined;
    let settleMutation: (() => void) | undefined;
    const harness = createHarness({
      mutate: async (_intent, signal) => {
        mutationSignal = signal;
        await new Promise<void>((resolve) => {
          settleMutation = resolve;
        });
        return { message: "finished" };
      },
    });
    await vi.waitFor(() => expect(harness.output()).toContain("github  global"));
    harness.component.handleInput?.(ENTER);
    await vi.waitFor(() => expect(harness.output()).toContain("MCP · github"));
    harness.component.handleInput?.("e");
    await vi.waitFor(() =>
      expect(harness.mutations.some((intent) => intent.type === "set-enabled")).toBe(true),
    );
    expect(mutationSignal).toBeUndefined();
    harness.component.handleInput?.(ESCAPE);
    expect(harness.closes).toBe(1);
    expect(harness.output()).not.toContain("cancel");

    let disposed = false;
    const disposal = harness.component.dispose().then(() => {
      disposed = true;
    });
    expect(disposed).toBe(false);
    settleMutation?.();
    await disposal;
    expect(disposed).toBe(true);
    expect(harness.mutations.filter((intent) => intent.type === "set-enabled")).toHaveLength(1);
  });

  test("keeps the current OAuth mode selected while editing a remote server", async () => {
    const oauthDisabled = Object.freeze({
      ...detail,
      config: Object.freeze({ type: "remote" as const, url: "https://example.test/mcp", oauth: false }),
    });
    const harness = createHarness({ detail: oauthDisabled });
    await vi.waitFor(() => expect(harness.output()).toContain("github  global"));
    harness.component.handleInput?.(ENTER);
    await vi.waitFor(() => expect(harness.output()).toContain("MCP · github"));
    harness.component.handleInput?.("d");
    expect(harness.output()).toContain("Streamable HTTP URL");
    harness.component.handleInput?.(ENTER);
    expect(harness.output()).toContain("Keep OAuth disabled");
    harness.component.handleInput?.(ENTER);

    await vi.waitFor(() =>
      expect(harness.mutations).toContainEqual({
        type: "edit-remote",
        scope: "global",
        name: "github",
        url: "https://example.test/mcp",
        oauth: false,
      }),
    );
  });

  test("confirms destructive removal and supports enable, reconnect, and logout shortcuts", async () => {
    const harness = createHarness();
    await vi.waitFor(() => expect(harness.output()).toContain("github  global"));
    harness.component.handleInput?.(ENTER);
    await vi.waitFor(() => expect(harness.output()).toContain("MCP · github"));

    harness.component.handleInput?.("e");
    await vi.waitFor(() =>
      expect(harness.mutations).toContainEqual({
        type: "set-enabled",
        scope: "global",
        name: "github",
        enabled: false,
      }),
    );
    await vi.waitFor(() => expect(harness.output()).toContain("set-enabled complete"));
    harness.component.handleInput?.("r");
    await vi.waitFor(() =>
      expect(harness.mutations).toContainEqual({ type: "reconnect", scope: "global", name: "github" }),
    );
    await vi.waitFor(() => expect(harness.output()).toContain("reconnect complete"));
    harness.component.handleInput?.("l");
    await vi.waitFor(() =>
      expect(harness.mutations).toContainEqual({ type: "logout", scope: "global", name: "github" }),
    );
    await vi.waitFor(() => expect(harness.output()).toContain("logout complete"));

    harness.component.handleInput?.("x");
    expect(harness.output()).toContain("cannot be undone");
    expect(harness.mutations.some((intent) => intent.type === "remove")).toBe(false);
    harness.component.handleInput?.("y");
    await vi.waitFor(() =>
      expect(harness.mutations).toContainEqual({ type: "remove", scope: "global", name: "github" }),
    );
  });

  test("closes only from the top-level list", async () => {
    const harness = createHarness();
    await vi.waitFor(() => expect(harness.output()).toContain("github  global"));
    harness.component.handleInput?.(ENTER);
    await vi.waitFor(() => expect(harness.output()).toContain("MCP · github"));
    harness.component.handleInput?.(ESCAPE);
    expect(harness.closes).toBe(0);
    harness.component.handleInput?.(ESCAPE);
    expect(harness.closes).toBe(1);
  });

  test("navigates the add actions with arrows as well as shortcuts", async () => {
    const harness = createHarness({ servers: Object.freeze([]) });
    await vi.waitFor(() => expect(harness.output()).toContain("Add local server"));
    harness.component.handleInput?.(DOWN);
    harness.component.handleInput?.(ENTER);
    expect(harness.output()).toContain("Add remote server");
    expect(harness.output()).toContain("Where should this server be available?");
  });

  test("sanitizes server-controlled strings across nested MCP manager views", async () => {
    const hostile = "server\u001b]8;;https://attacker.test\u0007link\u001b]8;;\u001b\\";
    const hostileSummary: TuiMcpServerSummary = Object.freeze({
      ...summary,
      name: hostile,
      lastError: hostile,
    });
    const hostileDetail: TuiMcpServerDetail = Object.freeze({
      ...detail,
      ...hostileSummary,
      instructions: hostile,
      negotiatedCapabilities: Object.freeze([hostile]),
      tools: Object.freeze([
        Object.freeze({
          name: hostile,
          description: hostile,
          inputSchema: Object.freeze({ description: hostile }),
        }),
      ]),
      prompts: Object.freeze([]),
      resources: Object.freeze([]),
      resourceTemplates: Object.freeze([]),
      recentErrors: Object.freeze([
        Object.freeze({ message: hostile, occurredAt: hostile, operation: hostile }),
      ]),
    });
    const harness = createHarness({
      servers: Object.freeze([hostileSummary]),
      detail: hostileDetail,
    });
    const expectSafeOutput = (): void => {
      expect(harness.output()).not.toContain("\u001b]");
      expect(harness.output()).not.toContain("\u0007");
    };

    await vi.waitFor(() => expect(harness.output()).toContain("attacker.test"));
    expectSafeOutput();
    harness.component.handleInput?.(ENTER);
    await vi.waitFor(() => expect(harness.output()).toContain("MCP · server"));
    expectSafeOutput();
    harness.component.handleInput?.(ENTER);
    expectSafeOutput();
    harness.component.handleInput?.(ENTER);
    expect(harness.output()).toContain("Input schema");
    expectSafeOutput();

    harness.component.handleInput?.(ESCAPE);
    harness.component.handleInput?.(ESCAPE);
    for (let index = 0; index < 4; index += 1) harness.component.handleInput?.(DOWN);
    harness.component.handleInput?.(ENTER);
    expectSafeOutput();

    harness.component.handleInput?.(ESCAPE);
    for (let index = 0; index < 6; index += 1) harness.component.handleInput?.(DOWN);
    harness.component.handleInput?.(ENTER);
    expectSafeOutput();
  });

  test("sanitizes server-controlled values before placing them in an editable input", async () => {
    const hostile = "https://example.test/\u001b]8;;https://attacker.test\u0007link";
    const hostileDetail = Object.freeze({
      ...detail,
      config: Object.freeze({ type: "remote" as const, url: hostile, oauth: true }),
    });
    const harness = createHarness({ detail: hostileDetail });
    await vi.waitFor(() => expect(harness.output()).toContain("github  global"));
    harness.component.handleInput?.(ENTER);
    await vi.waitFor(() => expect(harness.output()).toContain("MCP · github"));
    harness.component.handleInput?.("d");

    expect(harness.output()).toContain("attacker.test");
    expect(harness.output()).not.toContain("\u001b]8;;https://attacker.test");
    expect(harness.output()).not.toContain("attacker.test\u0007link");
  });
});
