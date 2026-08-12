import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createMcpToolDefinitions } from "../src/tool-definitions.ts";
import { createMcpHostManager } from "../src/host.ts";
import { loadMcpConfig, writeMcpServer } from "../src/config.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "server.mjs");

describe("MCP Broker definitions", () => {
  test("freezes native schemas and preserves the complete protocol tool result", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-definitions-"));
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
      credentials: {
        read: async () => undefined,
        write: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
      },
      handlers: {
        sample: async () => ({
          role: "assistant",
          model: "controlled",
          content: { type: "text", text: "ok" },
        }),
        elicit: async () => ({ action: "decline" }),
        onOAuthRedirect: () => undefined,
      },
    });
    try {
      await manager.start();
      const tool = createMcpToolDefinitions(manager).find((entry) =>
        entry.name.startsWith("mcp.controlled.echo_tool_"),
      );
      if (!tool) throw new Error("Expected frozen controlled tool");
      expect(() => tool.parseInput?.({ value: 4 })).toThrow();
      const result = await tool.execute(
        { value: "hello" },
        {
          executionId: "execution",
          logicalExecutionId: "logical",
          callId: "call",
          sessionId: "session",
          signal: new AbortController().signal,
        },
      );
      expect(result).toMatchObject({
        content: [{ type: "text", text: "hello" }],
        structuredContent: { echoed: "hello" },
      });
    } finally {
      await manager.close();
    }
  });

  test("preserves the complete native payload when an MCP tool reports isError", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-definition-failure-"));
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
      credentials: {
        read: async () => undefined,
        write: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
      },
      handlers: {
        sample: async () => ({
          role: "assistant",
          model: "controlled",
          content: { type: "text", text: "ok" },
        }),
        elicit: async () => ({ action: "decline" }),
        onOAuthRedirect: () => undefined,
      },
    });
    try {
      await manager.start();
      const tool = createMcpToolDefinitions(manager).find((entry) => entry.name === "mcp.controlled.failing");
      if (!tool) throw new Error("Expected controlled failing tool");
      const result = await tool.execute(
        {},
        {
          executionId: "execution",
          logicalExecutionId: "logical",
          callId: "call",
          sessionId: "session",
          signal: new AbortController().signal,
        },
      );
      expect(tool.reportedFailure?.(result)).toEqual({
        message: "MCP tool mcp.controlled.failing reported an error",
        details: {
          content: [{ type: "text", text: "controlled failure payload" }],
          structuredContent: { reason: "controlled" },
          isError: true,
        },
      });
    } finally {
      await manager.close();
    }
  });
});
