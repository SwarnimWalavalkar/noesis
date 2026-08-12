import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { loadMcpConfig, writeMcpServer } from "../src/config.ts";
import { createMcpConnectionLifecycleFailure, createMcpHostManager } from "../src/host.ts";
import type { McpOAuthCredentialStore } from "../src/oauth.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "server.mjs");

const emptyCredentials = (): McpOAuthCredentialStore => ({
  read: async () => undefined,
  write: async () => undefined,
  update: async () => undefined,
  delete: async () => undefined,
  deleteIf: async () => undefined,
});

describe("MCP host", () => {
  test("keeps connection identity stable across transports, retries, and host restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-connect-identity-"));
    const home = join(root, "home");
    await writeMcpServer({
      home,
      projectDirectory: root,
      scope: "project",
      name: "controlled",
      config: { type: "remote", url: "https://example.test/mcp" },
    });
    const config = await loadMcpConfig({ home, projectDirectory: root });
    const identities: string[] = [];
    const transports: string[] = [];
    const createManager = () =>
      createMcpHostManager({
        home,
        projectDirectory: root,
        config,
        credentials: emptyCredentials(),
        handlers: {
          connect: async ({ connectionIdentity, transport }) => {
            identities.push(connectionIdentity);
            transports.push(transport);
            throw new Error("controlled retryable connection failure");
          },
          sample: async () => {
            throw new Error("sampling is not expected");
          },
          elicit: async () => ({ action: "decline" }),
          onOAuthRedirect: () => undefined,
        },
      });

    const first = createManager();
    await first.start();
    await vi.waitFor(() => expect(identities.length).toBeGreaterThanOrEqual(4), { timeout: 5_000 });
    await first.close();
    const beforeRestart = identities.length;

    const second = createManager();
    await second.start();
    await vi.waitFor(() => expect(identities.length).toBeGreaterThan(beforeRestart));
    await second.close();

    expect(new Set(transports)).toEqual(new Set(["streamable_http", "sse"]));
    expect(new Set(identities)).toHaveLength(1);
    expect(identities[0]).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("bounds reconnect attempts when connection failure events are rejected", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-event-failure-"));
    const home = join(root, "home");
    await writeMcpServer({
      home,
      projectDirectory: root,
      scope: "project",
      name: "broken",
      config: { type: "local", command: "/definitely/missing/noesis-mcp" },
    });
    let attempts = 0;
    const manager = createMcpHostManager({
      home,
      projectDirectory: root,
      config: await loadMcpConfig({ home, projectDirectory: root }),
      credentials: emptyCredentials(),
      handlers: {
        connect: async ({ execute }) => {
          attempts += 1;
          await execute();
        },
        sample: async () => {
          throw new Error("sampling is not expected");
        },
        elicit: async () => ({ action: "decline" }),
        onOAuthRedirect: () => undefined,
        onEvent: async () => {
          throw new Error("controlled event sink failure");
        },
      },
    });

    await manager.start();
    await vi.waitFor(() => expect(attempts).toBe(4), { timeout: 5_000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    expect(attempts).toBe(4);
    expect(manager.inspectServer("broken")?.status).toBe("failed");
    await manager.close();
  });

  test("does not retry a connection attempt rejected before its lifecycle effect begins", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-denied-connect-"));
    const home = join(root, "home");
    await writeMcpServer({
      home,
      projectDirectory: root,
      scope: "project",
      name: "controlled",
      config: { type: "local", command: process.execPath, args: [fixture] },
    });
    let attempts = 0;
    const manager = createMcpHostManager({
      home,
      projectDirectory: root,
      config: await loadMcpConfig({ home, projectDirectory: root }),
      credentials: emptyCredentials(),
      handlers: {
        connect: async () => {
          attempts += 1;
          throw createMcpConnectionLifecycleFailure("denied", false);
        },
        sample: async () => {
          throw new Error("sampling is not expected");
        },
        elicit: async () => ({ action: "decline" }),
        onOAuthRedirect: () => undefined,
      },
    });

    await manager.start();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(attempts).toBe(1);
    expect(manager.inspectServer("controlled")).toMatchObject({ status: "failed", lastError: "denied" });
    await manager.close();
  });

  test("only the latest overlapping start attempt can publish a connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-overlapping-connect-"));
    const home = join(root, "home");
    const marker = join(root, "started.pids");
    await writeMcpServer({
      home,
      projectDirectory: root,
      scope: "project",
      name: "controlled",
      config: {
        type: "local",
        command: process.execPath,
        args: [fixture],
        timeout: 5_000,
        environment: {
          CONTROLLED_STARTUP_DELAY: "NOESIS_MCP_STARTUP_DELAY",
          CONTROLLED_STARTUP_MARKER: "NOESIS_MCP_STARTUP_MARKER",
        },
      },
    });
    const statuses: string[] = [];
    const manager = createMcpHostManager({
      home,
      projectDirectory: root,
      config: await loadMcpConfig({ home, projectDirectory: root }),
      credentials: emptyCredentials(),
      environment: {
        NOESIS_MCP_STARTUP_DELAY: "250",
        NOESIS_MCP_STARTUP_MARKER: marker,
      },
      handlers: {
        sample: async () => ({
          role: "assistant",
          model: "controlled",
          stopReason: "endTurn",
          content: { type: "text", text: "ok" },
        }),
        elicit: async () => ({ action: "decline" }),
        onOAuthRedirect: () => undefined,
        onEvent: (event) => {
          const status =
            typeof event.payload === "object" && event.payload !== null
              ? Reflect.get(event.payload, "status")
              : undefined;
          if (event.type === "connection" && typeof status === "string") statuses.push(status);
        },
      },
    });

    const first = manager.start();
    await vi.waitFor(async () => expect((await readFile(marker, "utf8")).trim()).toMatch(/^\d+$/u));
    const second = manager.start();
    await Promise.all([first, second]);
    const childPids = (await readFile(marker, "utf8")).trim().split("\n").map(Number);
    expect(childPids).toHaveLength(2);
    expect(statuses.filter((status) => status === "connected")).toHaveLength(1);
    expect(manager.inspectServer("controlled")?.status).toBe("connected");
    expect((await manager.callTool("mcp.controlled.environment", {})).content[0]).toMatchObject({
      type: "text",
      text: "missing",
    });
    await vi.waitFor(() => expect(() => process.kill(childPids[0] ?? 0, 0)).toThrow());
    expect(() => process.kill(childPids[1] ?? 0, 0)).not.toThrow();
    await manager.close();
  });

  test("does not publish a discovery refresh from a replaced connection generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-stale-discovery-"));
    const home = join(root, "home");
    const catalogMarker = join(root, "catalog-v2");
    const blockMarker = join(root, "block-discovery");
    await writeMcpServer({
      home,
      projectDirectory: root,
      scope: "project",
      name: "controlled",
      config: {
        type: "local",
        command: process.execPath,
        args: [fixture],
        timeout: 5_000,
        environment: {
          CONTROLLED_DYNAMIC_CATALOG_MARKER: "NOESIS_MCP_DYNAMIC_CATALOG_MARKER",
          CONTROLLED_DISCOVERY_BLOCK_MARKER: "NOESIS_MCP_DISCOVERY_BLOCK_MARKER",
        },
      },
    });
    let dirtyEvents = 0;
    const manager = createMcpHostManager({
      home,
      projectDirectory: root,
      config: await loadMcpConfig({ home, projectDirectory: root }),
      credentials: emptyCredentials(),
      environment: {
        NOESIS_MCP_DYNAMIC_CATALOG_MARKER: catalogMarker,
        NOESIS_MCP_DISCOVERY_BLOCK_MARKER: blockMarker,
      },
      handlers: {
        sample: async () => ({
          role: "assistant",
          model: "controlled",
          stopReason: "endTurn",
          content: { type: "text", text: "ok" },
        }),
        elicit: async () => ({ action: "decline" }),
        onOAuthRedirect: () => undefined,
        onEvent: (event) => {
          if (
            event.type === "catalog_changed" &&
            typeof event.payload === "object" &&
            event.payload !== null &&
            Reflect.get(event.payload, "dirty") === true
          )
            dirtyEvents += 1;
        },
      },
    });
    try {
      await writeFile(catalogMarker, "1");
      await manager.start();
      expect(manager.inspectServer("controlled")?.tools.map((tool) => tool.name)).toContain("catalog-v1");
      await writeFile(blockMarker, "block\n");
      await manager.callTool("mcp.controlled.mark-catalog-dirty", {});
      await vi.waitFor(() => expect(dirtyEvents).toBe(1));

      const staleRefresh = manager.refreshDiscovery();
      await vi.waitFor(async () => {
        const claimed = await readFile(`${blockMarker}.claimed`, "utf8").catch(() => "");
        expect(claimed).toMatch(/^\d+\n$/u);
      });
      await writeFile(catalogMarker, "3");
      await manager.start();
      await unlink(blockMarker);
      await staleRefresh;

      const tools = manager.inspectServer("controlled")?.tools.map((tool) => tool.name);
      expect(tools).toContain("catalog-v3");
      expect(tools).not.toContain("catalog-v2");
      expect(manager.inspectServer("controlled")?.status).toBe("connected");
    } finally {
      await unlink(blockMarker).catch(() => undefined);
      await manager.close();
    }
  });

  test("rejects an already-aborted OAuth request before opening a callback listener", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-auth-aborted-"));
    const home = join(root, "home");
    await writeMcpServer({
      home,
      projectDirectory: root,
      scope: "project",
      name: "remote",
      config: { type: "remote", url: "https://example.test/mcp", oauth: true },
    });
    const manager = createMcpHostManager({
      home,
      projectDirectory: root,
      config: await loadMcpConfig({ home, projectDirectory: root }),
      credentials: emptyCredentials(),
      handlers: {
        sample: async () => ({
          role: "assistant",
          model: "controlled",
          stopReason: "endTurn",
          content: { type: "text", text: "ok" },
        }),
        elicit: async () => ({ action: "decline" }),
        onOAuthRedirect: () => undefined,
      },
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled before authentication"));
    await expect(manager.authenticate("remote", { signal: controller.signal })).rejects.toThrow(
      "cancelled before authentication",
    );
    await manager.close();
  });

  test("closing during an in-flight connection leaves no installed client or stdio child", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-close-race-"));
    const home = join(root, "home");
    const marker = join(root, "started.pid");
    await writeMcpServer({
      home,
      projectDirectory: root,
      scope: "project",
      name: "controlled",
      config: {
        type: "local",
        command: process.execPath,
        args: [fixture],
        timeout: 5_000,
        environment: {
          CONTROLLED_STARTUP_DELAY: "NOESIS_MCP_STARTUP_DELAY",
          CONTROLLED_STARTUP_MARKER: "NOESIS_MCP_STARTUP_MARKER",
        },
      },
    });
    const connections: string[] = [];
    const manager = createMcpHostManager({
      home,
      projectDirectory: root,
      config: await loadMcpConfig({ home, projectDirectory: root }),
      credentials: emptyCredentials(),
      environment: {
        NOESIS_MCP_STARTUP_DELAY: "1000",
        NOESIS_MCP_STARTUP_MARKER: marker,
      },
      handlers: {
        sample: async () => ({
          role: "assistant",
          model: "controlled",
          stopReason: "endTurn",
          content: { type: "text", text: "ok" },
        }),
        elicit: async () => ({ action: "decline" }),
        onOAuthRedirect: () => undefined,
        onEvent: (event) => {
          if (event.type === "connection") connections.push(JSON.stringify(event.payload));
        },
      },
    });

    const start = manager.start();
    await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toMatch(/^\d+\n$/u), {
      timeout: 5_000,
    });
    const childPid = Number((await readFile(marker, "utf8")).trim());
    await manager.close();
    await start;

    expect(manager.listServers()).toEqual([]);
    expect(manager.listTools()).toEqual([]);
    expect(connections.some((payload) => payload.includes('"connected"'))).toBe(false);
    await manager.reconnect("controlled");
    expect(manager.listServers()).toEqual([]);
    await vi.waitFor(() => {
      expect(() => process.kill(childPid, 0)).toThrow();
    });
  });

  test("discovers and invokes the complete ordinary capability surface through stdio", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-host-"));
    await writeMcpServer({
      home: join(root, "home"),
      projectDirectory: root,
      scope: "project",
      name: "controlled",
      config: {
        type: "local",
        command: process.execPath,
        args: [fixture],
        environment: { CONTROLLED_SECRET: "NOESIS_MCP_TEST_SECRET" },
      },
    });
    const events: string[] = [];
    const manager = createMcpHostManager({
      home: join(root, "home"),
      projectDirectory: root,
      config: await loadMcpConfig({ home: join(root, "home"), projectDirectory: root }),
      credentials: emptyCredentials(),
      environment: { NOESIS_MCP_TEST_SECRET: "secret-from-process-environment" },
      handlers: {
        sample: async () => ({
          role: "assistant",
          model: "controlled",
          stopReason: "endTurn",
          content: { type: "text", text: "sampled" },
        }),
        elicit: async () => ({ action: "accept", content: { name: "Noesis" } }),
        onOAuthRedirect: () => undefined,
        onEvent: (event) => {
          events.push(event.type);
        },
      },
    });
    try {
      await manager.start();
      const discoveryController = new AbortController();
      discoveryController.abort(new Error("cancelled discovery"));
      await expect(manager.refreshDiscovery(discoveryController.signal)).rejects.toThrow(
        "cancelled discovery",
      );
      const detail = manager.inspectServer("controlled");
      expect(detail?.status).toBe("connected");
      expect(detail?.tools.map((tool) => tool.name)).toEqual([
        "echo/tool",
        "failing",
        "environment",
        "sample",
        "roots",
        "elicit",
        "elicit-url",
        "slow",
        "subscriptions",
        "disconnect-once",
        "task-tool",
      ]);
      expect(detail?.prompts[0]?.name).toBe("greet");
      expect(detail?.resources[0]?.uri).toBe("test://readme");
      expect(detail?.resourceTemplates[0]?.uriTemplate).toBe("test://item/{id}");

      const tool = manager.listTools().find((entry) => entry.definition.name === "echo/tool");
      expect(tool?.canonicalName).toMatch(/^mcp\.controlled\.echo_tool_[a-f0-9]{12}$/u);
      expect(tool?.identityDigest).toMatch(/^[a-f0-9]{64}$/u);
      const progress: number[] = [];
      const result = await manager.callTool(
        tool?.canonicalName ?? "",
        { value: "hello" },
        {
          onProgress: (event) => {
            progress.push(event.progress);
          },
        },
      );
      expect(result.structuredContent).toEqual({ echoed: "hello" });
      expect(progress).toEqual([1]);
      expect(events).toContain("log");
      expect((await manager.callTool("mcp.controlled.environment", {})).content[0]).toMatchObject({
        type: "text",
        text: "secret-from-process-environment",
      });

      expect(
        (await manager.getPrompt("controlled", "greet", { name: "Ada" })).messages[0]?.content,
      ).toMatchObject({ type: "text", text: "Hello Ada" });
      expect((await manager.readResource("controlled", "test://readme")).contents[0]).toMatchObject({
        text: "resource body",
      });
      expect((await manager.callTool("mcp.controlled.sample", {})).content[0]).toMatchObject({
        type: "text",
        text: "sampled",
      });
      expect((await manager.callTool("mcp.controlled.elicit", {})).content[0]).toMatchObject({
        type: "text",
        text: "Noesis",
      });
      expect((await manager.callTool("mcp.controlled.elicit-url", {})).content[0]).toMatchObject({
        type: "text",
        text: "accept",
      });
      const rootResult = await manager.callTool("mcp.controlled.roots", {});
      expect(rootResult.content[0]).toMatchObject({ type: "text" });
      await manager.subscribeResource("controlled", "test://readme");
      await manager.unsubscribeResource("controlled", "test://readme");
      await manager.setLoggingLevel("controlled", "debug");

      const controller = new AbortController();
      const slow = manager.callTool("mcp.controlled.slow", {}, { signal: controller.signal });
      controller.abort();
      await expect(slow).rejects.toThrow();
      const startedTask = await manager.startToolTask("mcp.controlled.task-tool", {}, {});
      expect(startedTask).toMatchObject({ status: "completed" });
      expect((await manager.callTool("mcp.controlled.task-tool", {})).content[0]).toMatchObject({
        type: "text",
        text: "task complete",
      });
      expect((await manager.listTasks("controlled")).tasks.length).toBeGreaterThanOrEqual(2);
      const task = (await manager.listTasks("controlled")).tasks[0];
      if (!task) throw new Error("Expected controlled task");
      expect(await manager.getTask("controlled", task.taskId)).toMatchObject({ taskId: task.taskId });
      expect((await manager.getTaskResult("controlled", task.taskId)).content[0]).toMatchObject({
        type: "text",
        text: "task complete",
      });
    } finally {
      await manager.close();
    }
  });

  test("retains task invocation authority when result polling or cancellation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-task-retry-"));
    const home = join(root, "home");
    await writeMcpServer({
      home,
      projectDirectory: root,
      scope: "project",
      name: "controlled",
      config: {
        type: "local",
        command: process.execPath,
        args: [fixture],
      },
    });
    const manager = createMcpHostManager({
      home,
      projectDirectory: root,
      config: await loadMcpConfig({ home, projectDirectory: root }),
      credentials: emptyCredentials(),
      handlers: {
        sample: async () => ({
          role: "assistant",
          model: "controlled",
          stopReason: "endTurn",
          content: { type: "text", text: "sampled task result" },
        }),
        elicit: async () => ({ action: "decline" }),
        onOAuthRedirect: () => undefined,
      },
    });
    const invocation = Object.freeze({
      route: Object.freeze({ provider: "controlled", model: "test", reasoning: "high" as const }),
      sessionId: "session-1",
      turnId: "turn-1",
      executionId: "execution-1",
      logicalExecutionId: "logical-1",
      callId: "call-1",
    });
    try {
      await manager.start();

      const first = await manager.startToolTask("mcp.controlled.task-tool", {}, { invocation });
      const firstTaskId =
        typeof first === "object" && first !== null ? Reflect.get(first, "taskId") : undefined;
      if (typeof firstTaskId !== "string") throw new Error("Expected controlled task id");
      const controller = new AbortController();
      controller.abort(new Error("cancelled result poll"));
      await expect(manager.getTaskResult("controlled", firstTaskId, controller.signal)).rejects.toThrow(
        "cancelled result poll",
      );
      expect((await manager.getTaskResult("controlled", firstTaskId)).content[0]).toMatchObject({
        type: "text",
        text: "task complete",
      });

      const second = await manager.startToolTask("mcp.controlled.task-tool", {}, { invocation });
      const secondTaskId =
        typeof second === "object" && second !== null ? Reflect.get(second, "taskId") : undefined;
      if (typeof secondTaskId !== "string") throw new Error("Expected controlled task id");
      const cancelController = new AbortController();
      cancelController.abort(new Error("cancelled task cancellation"));
      await expect(manager.cancelTask("controlled", secondTaskId, cancelController.signal)).rejects.toThrow(
        "cancelled task cancellation",
      );
      expect((await manager.getTaskResult("controlled", secondTaskId)).content[0]).toMatchObject({
        type: "text",
        text: "task complete",
      });
    } finally {
      await manager.close();
    }
  });

  test("starts tasks only for tools that explicitly allow task execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-task-support-"));
    const home = join(root, "home");
    await writeMcpServer({
      home,
      projectDirectory: root,
      scope: "project",
      name: "controlled",
      config: {
        type: "local",
        command: process.execPath,
        args: [fixture],
        environment: { CONTROLLED_TASK_SUPPORT: "NOESIS_MCP_TASK_SUPPORT" },
      },
    });
    const manager = createMcpHostManager({
      home,
      projectDirectory: root,
      config: await loadMcpConfig({ home, projectDirectory: root }),
      credentials: emptyCredentials(),
      environment: { NOESIS_MCP_TASK_SUPPORT: "true" },
      handlers: {
        sample: async () => ({
          role: "assistant",
          model: "controlled",
          stopReason: "endTurn",
          content: { type: "text", text: "ok" },
        }),
        elicit: async () => ({ action: "decline" }),
        onOAuthRedirect: () => undefined,
      },
    });
    try {
      await manager.start();

      await expect(manager.startToolTask("mcp.controlled.environment", {}, {})).rejects.toThrow(
        "does not support task execution (forbidden)",
      );
      await expect(manager.startToolTask("mcp.controlled.forbidden-task-tool", {}, {})).rejects.toThrow(
        "does not support task execution (forbidden)",
      );
      await expect(manager.startToolTask("mcp.controlled.optional-task-tool", {}, {})).resolves.toMatchObject(
        {
          status: "completed",
        },
      );
      await expect(manager.startToolTask("mcp.controlled.task-tool", {}, {})).resolves.toMatchObject({
        status: "completed",
      });
    } finally {
      await manager.close();
    }
  });

  test("isolates one failed server while healthy servers remain usable", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-isolation-"));
    const home = join(root, "home");
    await writeMcpServer({
      home,
      projectDirectory: root,
      scope: "project",
      name: "healthy",
      config: { type: "local", command: process.execPath, args: [fixture] },
    });
    await writeMcpServer({
      home,
      projectDirectory: root,
      scope: "project",
      name: "broken",
      config: { type: "local", command: "/definitely/missing/noesis-mcp" },
    });
    const manager = createMcpHostManager({
      home,
      projectDirectory: root,
      config: await loadMcpConfig({ home, projectDirectory: root }),
      credentials: emptyCredentials(),
      handlers: {
        sample: async () => ({
          role: "assistant",
          model: "controlled",
          stopReason: "endTurn",
          content: { type: "text", text: "ok" },
        }),
        elicit: async () => ({ action: "decline" }),
        onOAuthRedirect: () => undefined,
      },
    });
    try {
      await manager.start();
      expect(manager.inspectServer("healthy")?.status).toBe("connected");
      await vi.waitFor(() => expect(manager.inspectServer("broken")?.status).toBe("failed"));
      expect(manager.listTools("healthy").length).toBeGreaterThan(0);
    } finally {
      await manager.close();
    }
  });

  test("revalidates a frozen tool after waiting in the invocation queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-queued-identity-"));
    const home = join(root, "home");
    await writeMcpServer({
      home,
      projectDirectory: root,
      scope: "project",
      name: "controlled",
      config: { type: "local", command: process.execPath, args: [fixture] },
    });
    const manager = createMcpHostManager({
      home,
      projectDirectory: root,
      config: await loadMcpConfig({ home, projectDirectory: root }),
      credentials: emptyCredentials(),
      handlers: {
        sample: async () => ({
          role: "assistant",
          model: "controlled",
          stopReason: "endTurn",
          content: { type: "text", text: "ok" },
        }),
        elicit: async () => ({ action: "decline" }),
        onOAuthRedirect: () => undefined,
      },
    });
    try {
      await manager.start();
      const frozen = manager.listTools().find((tool) => tool.definition.name === "echo/tool");
      if (!frozen) throw new Error("Expected controlled echo tool");
      const slow = manager.callTool("mcp.controlled.slow", {}).catch(() => undefined);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      const queued = manager.callTool(
        frozen.canonicalName,
        { value: "queued" },
        {
          expectedIdentityDigest: frozen.identityDigest,
        },
      );
      const queuedRejection = expect(queued).rejects.toThrow(
        /changed after this turn|connection changed while its call was queued/u,
      );
      await manager.reconnect("controlled");

      await queuedRejection;
      await slow;
    } finally {
      await manager.close();
    }
  });

  test("retries enabled startup failures until the server becomes available", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-start-retry-"));
    const home = join(root, "home");
    const delayedFixture = join(root, "delayed-server.mjs");
    await writeMcpServer({
      home,
      projectDirectory: root,
      scope: "project",
      name: "delayed",
      config: { type: "local", command: process.execPath, args: [delayedFixture], timeout: 1_000 },
    });
    const manager = createMcpHostManager({
      home,
      projectDirectory: root,
      config: await loadMcpConfig({ home, projectDirectory: root }),
      credentials: emptyCredentials(),
      handlers: {
        sample: async () => ({
          role: "assistant",
          model: "controlled",
          stopReason: "endTurn",
          content: { type: "text", text: "ok" },
        }),
        elicit: async () => ({ action: "decline" }),
        onOAuthRedirect: () => undefined,
      },
    });
    try {
      await manager.start();
      expect(manager.inspectServer("delayed")?.status).toBe("failed");
      await expect(manager.reconnect("delayed")).rejects.toThrow('MCP server "delayed" failed to connect');
      await writeFile(delayedFixture, `await import(${JSON.stringify(pathToFileURL(fixture).href)});\n`);
      await manager.reconnect("delayed");
      await vi.waitFor(() => expect(manager.inspectServer("delayed")?.status).toBe("connected"), {
        timeout: 10_000,
      });
    } finally {
      await manager.close();
    }
  }, 15_000);

  test("retries enabled reload failures until the server becomes available", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-reload-retry-"));
    const home = join(root, "home");
    const delayedFixture = join(root, "delayed-server.mjs");
    const manager = createMcpHostManager({
      home,
      projectDirectory: root,
      config: await loadMcpConfig({ home, projectDirectory: root }),
      credentials: emptyCredentials(),
      handlers: {
        sample: async () => ({
          role: "assistant",
          model: "controlled",
          stopReason: "endTurn",
          content: { type: "text", text: "ok" },
        }),
        elicit: async () => ({ action: "decline" }),
        onOAuthRedirect: () => undefined,
      },
    });
    try {
      await manager.start();
      await writeMcpServer({
        home,
        projectDirectory: root,
        scope: "project",
        name: "delayed",
        config: { type: "local", command: process.execPath, args: [delayedFixture], timeout: 1_000 },
      });
      await manager.reload(await loadMcpConfig({ home, projectDirectory: root }));
      expect(manager.inspectServer("delayed")?.status).toBe("failed");
      await writeFile(delayedFixture, `await import(${JSON.stringify(pathToFileURL(fixture).href)});\n`);
      await manager.reconnect("delayed");
      await vi.waitFor(() => expect(manager.inspectServer("delayed")?.status).toBe("connected"), {
        timeout: 10_000,
      });
    } finally {
      await manager.close();
    }
  }, 15_000);

  test("quarantines malformed tool schemas and gives every rewritten canonical name a digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-tool-catalog-"));
    const home = join(root, "home");
    const catalog = async (mode: "malformed" | "canonical-names") => {
      await writeMcpServer({
        home,
        projectDirectory: root,
        scope: "project",
        name: "controlled",
        config: {
          type: "local",
          command: process.execPath,
          args: [fixture],
          environment: { CONTROLLED_TOOL_CATALOG: "NOESIS_MCP_TOOL_CATALOG" },
        },
      });
      const manager = createMcpHostManager({
        home,
        projectDirectory: root,
        config: await loadMcpConfig({ home, projectDirectory: root }),
        credentials: emptyCredentials(),
        environment: { NOESIS_MCP_TOOL_CATALOG: mode },
        handlers: {
          sample: async () => ({
            role: "assistant",
            model: "controlled",
            stopReason: "endTurn",
            content: { type: "text", text: "ok" },
          }),
          elicit: async () => ({ action: "decline" }),
          onOAuthRedirect: () => undefined,
        },
      });
      await manager.start();
      return manager;
    };

    const malformed = await catalog("malformed");
    try {
      expect(malformed.listTools().map((tool) => tool.definition.name)).toEqual(["environment"]);
      expect(malformed.inspectServer("controlled")?.diagnostics).toMatchObject([
        { code: "invalid_tool_schema", toolName: "malformed" },
      ]);
    } finally {
      await malformed.close();
    }

    const canonical = await catalog("canonical-names");
    try {
      const first = canonical.listTools().map((tool) => tool.canonicalName);
      expect(first).toContain("mcp.controlled.plain");
      expect(first.filter((name) => name.includes("a_b_"))).toHaveLength(2);
      expect(first.every((name) => name.length <= 128)).toBe(true);
      expect(first.find((name) => name.length === 128)).toMatch(/_[a-f0-9]{12}$/u);
      await canonical.reconnect("controlled");
      expect(canonical.listTools().map((tool) => tool.canonicalName)).toEqual(first);
    } finally {
      await canonical.close();
    }
  });

  test("recovers an unexpectedly closed server and restores resource subscriptions", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-reconnect-"));
    const home = join(root, "home");
    const marker = join(root, "disconnected-once");
    await writeMcpServer({
      home,
      projectDirectory: root,
      scope: "project",
      name: "controlled",
      config: {
        type: "local",
        command: process.execPath,
        args: [fixture],
        environment: { CONTROLLED_DISCONNECT_MARKER: "NOESIS_MCP_DISCONNECT_MARKER" },
      },
    });
    const statuses: string[] = [];
    const manager = createMcpHostManager({
      home,
      projectDirectory: root,
      config: await loadMcpConfig({ home, projectDirectory: root }),
      credentials: emptyCredentials(),
      environment: { NOESIS_MCP_DISCONNECT_MARKER: marker },
      handlers: {
        sample: async () => ({
          role: "assistant",
          model: "controlled",
          stopReason: "endTurn",
          content: { type: "text", text: "ok" },
        }),
        elicit: async () => ({ action: "decline" }),
        onOAuthRedirect: () => undefined,
        onEvent: (event) => {
          const status =
            typeof event.payload === "object" && event.payload !== null
              ? Reflect.get(event.payload, "status")
              : undefined;
          if (event.type === "connection" && typeof status === "string") statuses.push(status);
        },
      },
    });
    try {
      await manager.start();
      await manager.subscribeResource("controlled", "test://readme");
      await manager.callTool("mcp.controlled.disconnect-once", {});

      await vi.waitFor(
        () => {
          expect(statuses).toContain("failed");
          expect(statuses.filter((status) => status === "connected")).toHaveLength(2);
          expect(manager.inspectServer("controlled")?.status).toBe("connected");
        },
        { timeout: 10_000 },
      );

      const restored = await manager.callTool("mcp.controlled.subscriptions", {});
      expect(restored.content[0]).toMatchObject({ type: "text", text: '["test://readme"]' });
    } finally {
      await manager.close();
    }
  });

  test("does not restore resource subscriptions across an incompatible discovery identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-subscription-identity-"));
    const home = join(root, "home");
    const catalogMarker = join(root, "catalog-v2");
    await writeMcpServer({
      home,
      projectDirectory: root,
      scope: "project",
      name: "controlled",
      config: {
        type: "local",
        command: process.execPath,
        args: [fixture],
        environment: { CONTROLLED_CATALOG_MARKER: "NOESIS_MCP_CATALOG_MARKER" },
      },
    });
    const manager = createMcpHostManager({
      home,
      projectDirectory: root,
      config: await loadMcpConfig({ home, projectDirectory: root }),
      credentials: emptyCredentials(),
      environment: { NOESIS_MCP_CATALOG_MARKER: catalogMarker },
      handlers: {
        sample: async () => ({
          role: "assistant",
          model: "controlled",
          stopReason: "endTurn",
          content: { type: "text", text: "ok" },
        }),
        elicit: async () => ({ action: "decline" }),
        onOAuthRedirect: () => undefined,
      },
    });
    try {
      await manager.start();
      await manager.subscribeResource("controlled", "test://readme");
      const oldIdentity = manager.inspectServer("controlled")?.identityDigest;
      await writeFile(catalogMarker, "v2\n");
      await manager.reconnect("controlled");
      expect(manager.inspectServer("controlled")?.identityDigest).not.toBe(oldIdentity);
      expect(manager.inspectServer("controlled")?.diagnostics).toContainEqual({
        code: "subscriptions_dropped",
        message: "Resource subscriptions were not restored because the server identity changed.",
      });
      const subscriptions = await manager.callTool("mcp.controlled.subscriptions", {});
      expect(subscriptions.content[0]).toMatchObject({ type: "text", text: "[]" });
    } finally {
      await manager.close();
    }
  });
});
