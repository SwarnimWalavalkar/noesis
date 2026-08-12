import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { loadMcpConfig, writeMcpServer } from "../src/config.ts";
import { createMcpHostManager } from "../src/host.ts";
import type { McpOAuthCredentialStore } from "../src/oauth.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "server.mjs");

const emptyCredentials = (): McpOAuthCredentialStore => ({
  read: async () => undefined,
  write: async () => undefined,
  update: async () => undefined,
  delete: async () => undefined,
});

describe("MCP host", () => {
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
      expect(manager.inspectServer("broken")?.status).toBe("failed");
      expect(manager.listTools("healthy").length).toBeGreaterThan(0);
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
      await writeFile(delayedFixture, `await import(${JSON.stringify(pathToFileURL(fixture).href)});\n`);
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
