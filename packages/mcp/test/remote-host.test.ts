import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, test } from "vitest";
import { createMcpHostManager } from "../src/host.ts";
import { loadMcpConfig, writeMcpServer } from "../src/config.ts";

const listeners: ReturnType<typeof createServer>[] = [];
afterEach(
  async () =>
    await Promise.all(
      listeners
        .splice(0)
        .map(async (server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    ),
);

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function controlledServer(): McpServer {
  const server = new McpServer({ name: "remote-controlled", version: "1.0.0" });
  server.registerTool("ping", { description: "Return pong" }, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));
  return server;
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<number> {
  const server = createServer(handler);
  listeners.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP test listener");
  return address.port;
}

async function managerFor(url: string, transport: "streamable_http" | "auto") {
  const root = await mkdtemp(join(tmpdir(), "noesis-mcp-remote-"));
  const home = join(root, "home");
  await writeMcpServer({
    home,
    projectDirectory: root,
    scope: "project",
    name: "remote",
    config: { type: "remote", url, transport, oauth: false },
  });
  return createMcpHostManager({
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
      sample: async () => ({ role: "assistant", model: "controlled", content: { type: "text", text: "ok" } }),
      elicit: async () => ({ action: "decline" }),
      onOAuthRedirect: () => undefined,
    },
  });
}

describe("remote MCP transports", () => {
  test("connects and invokes through Streamable HTTP", async () => {
    const protocol = controlledServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await protocol.connect(transport as never);
    const port = await listen((request, response) => {
      if (request.url !== "/mcp") return void response.writeHead(404).end();
      if (request.method === "POST")
        void body(request).then(async (parsed) => await transport.handleRequest(request, response, parsed));
      else void transport.handleRequest(request, response);
    });
    const manager = await managerFor(`http://127.0.0.1:${String(port)}/mcp`, "streamable_http");
    try {
      await manager.start();
      expect(manager.inspectServer("remote")).toMatchObject({ status: "connected" });
      expect((await manager.callTool("mcp.remote.ping", {})).content[0]).toMatchObject({ text: "pong" });
    } finally {
      await manager.close();
      await protocol.close();
    }
  });

  test("falls back from Streamable HTTP to legacy SSE", async () => {
    const transports = new Map<string, SSEServerTransport>();
    const protocols: McpServer[] = [];
    const port = await listen((request, response) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (request.method === "GET" && url.pathname === "/sse") {
        const transport = new SSEServerTransport("/messages", response);
        transports.set(transport.sessionId, transport);
        const protocol = controlledServer();
        protocols.push(protocol);
        void protocol.connect(transport);
        return;
      }
      if (request.method === "POST" && url.pathname === "/messages") {
        const transport = transports.get(url.searchParams.get("sessionId") ?? "");
        if (!transport) return void response.writeHead(404).end();
        void body(request).then(
          async (parsed) => await transport.handlePostMessage(request, response, parsed),
        );
        return;
      }
      response.writeHead(404).end();
    });
    const manager = await managerFor(`http://127.0.0.1:${String(port)}/sse`, "auto");
    try {
      await manager.start();
      expect(manager.inspectServer("remote")?.status).toBe("connected");
      expect((await manager.callTool("mcp.remote.ping", {})).content[0]).toMatchObject({ text: "pong" });
    } finally {
      await manager.close();
      await Promise.all(protocols.map(async (protocol) => await protocol.close()));
    }
  });
});
