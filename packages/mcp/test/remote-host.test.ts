import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadMcpConfig, writeMcpServer } from "../src/config.ts";
import { createMcpHostManager } from "../src/host.ts";
import type { McpOAuthCredential } from "../src/oauth.ts";

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

async function availableIpv6Port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected IPv6 TCP test listener");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP test listener");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function managerFor(
  url: string,
  transport: "streamable_http" | "auto",
  oauth: false | Readonly<{ redirectUri: string }> = false,
  credentials: Parameters<typeof createMcpHostManager>[0]["credentials"] = {
    read: async () => undefined,
    write: async () => undefined,
    update: async () => undefined,
    delete: async () => undefined,
    deleteIf: async () => undefined,
  },
) {
  const root = await mkdtemp(join(tmpdir(), "noesis-mcp-remote-"));
  const home = join(root, "home");
  await writeMcpServer({
    home,
    projectDirectory: root,
    scope: "project",
    name: "remote",
    config: { type: "remote", url, transport, oauth },
  });
  return createMcpHostManager({
    home,
    projectDirectory: root,
    config: await loadMcpConfig({ home, projectDirectory: root }),
    credentials,
    handlers: {
      sample: async () => ({ role: "assistant", model: "controlled", content: { type: "text", text: "ok" } }),
      elicit: async () => ({ action: "decline" }),
      onOAuthRedirect: () => undefined,
    },
  });
}

async function unauthorizedOAuthManager(callbackPort: number, connect?: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "noesis-mcp-oauth-lifecycle-"));
  const home = join(root, "home");
  await writeMcpServer({
    home,
    projectDirectory: root,
    scope: "project",
    name: "remote",
    config: {
      type: "remote",
      url: "https://example.test/mcp",
      transport: "streamable_http",
      oauth: { redirectUri: `http://127.0.0.1:${String(callbackPort)}/oauth/callback` },
    },
  });
  let credential: McpOAuthCredential | undefined = {
    serverUrl: "https://example.test/mcp",
    state: "controlled-state",
  };
  return createMcpHostManager({
    home,
    projectDirectory: root,
    config: await loadMcpConfig({ home, projectDirectory: root }),
    credentials: {
      read: async () => credential,
      write: async (_key, next) => {
        credential = next;
      },
      update: async (_key, update) => {
        credential = update(credential);
      },
      delete: async () => {
        credential = undefined;
      },
      deleteIf: async (_key, predicate) => {
        if (predicate(credential)) credential = undefined;
      },
    },
    handlers: {
      connect:
        connect ??
        (async () => {
          throw new UnauthorizedError("authentication required");
        }),
      sample: async () => ({
        role: "assistant",
        model: "controlled",
        content: { type: "text", text: "ok" },
      }),
      elicit: async () => ({ action: "decline" }),
      onOAuthRedirect: () => undefined,
    },
  });
}

describe("remote MCP transports", () => {
  test("aborts callback listener startup during host shutdown", async () => {
    const callbackPort = await availablePort();
    const manager = await unauthorizedOAuthManager(callbackPort);

    const authentication = manager.authenticate("remote", { timeout: 30_000 });
    void authentication.catch(() => undefined);
    await manager.close();
    await expect(authentication).rejects.toThrow("MCP host closed during OAuth authentication");

    const rebound = createServer((_request, response) => response.end());
    listeners.push(rebound);
    await expect(
      new Promise<void>((resolve, reject) => {
        rebound.once("error", reject);
        rebound.listen(callbackPort, "127.0.0.1", resolve);
      }),
    ).resolves.toBeUndefined();
  });

  test("keeps the replacement OAuth flow active when the older flow cleans up", async () => {
    const callbackPort = await availablePort();
    const manager = await unauthorizedOAuthManager(callbackPort);
    const finishAuth = vi
      .spyOn(StreamableHTTPClientTransport.prototype, "finishAuth")
      .mockResolvedValue(undefined);
    const first = manager.authenticate("remote", { timeout: 30_000 });
    void first.catch(() => undefined);
    await vi.waitFor(async () => {
      expect((await fetch(`http://127.0.0.1:${String(callbackPort)}/not-the-callback`)).status).toBe(404);
    });

    const second = manager.authenticate("remote", { timeout: 30_000 });
    void second.catch(() => undefined);
    await expect(first).rejects.toThrow("was replaced");
    await vi.waitFor(async () => {
      expect((await fetch(`http://127.0.0.1:${String(callbackPort)}/not-the-callback`)).status).toBe(404);
      expect(manager.inspectServer("remote")?.status).toBe("auth_required");
    });

    try {
      await expect(manager.finishAuthentication("remote", "controlled-code")).resolves.toBeUndefined();
      expect(finishAuth).toHaveBeenCalledWith("controlled-code");
    } finally {
      finishAuth.mockRestore();
    }

    await manager.close();
    await expect(second).rejects.toThrow("MCP host closed during OAuth authentication");
  });

  test("reports callback success only after the token exchange succeeds", async () => {
    const callbackPort = await availablePort();
    const manager = await unauthorizedOAuthManager(callbackPort);
    const finishAuth = vi
      .spyOn(StreamableHTTPClientTransport.prototype, "finishAuth")
      .mockRejectedValue(new Error("controlled token exchange failure"));
    const authentication = manager.authenticate("remote", { timeout: 30_000 });
    void authentication.catch(() => undefined);
    try {
      await vi.waitFor(async () => {
        expect((await fetch(`http://127.0.0.1:${String(callbackPort)}/not-the-callback`)).status).toBe(404);
      });
      const callback = await fetch(
        `http://127.0.0.1:${String(callbackPort)}/oauth/callback?code=controlled-code&state=controlled-state`,
      );
      expect(callback.status).toBe(400);
      expect(await callback.text()).toContain("Authentication failed");
      await expect(authentication).rejects.toThrow("controlled token exchange failure");
    } finally {
      finishAuth.mockRestore();
      await manager.close();
    }
  });

  test("fails an accepted callback when authentication is cancelled during token exchange", async () => {
    const callbackPort = await availablePort();
    let connectionAttempts = 0;
    const manager = await unauthorizedOAuthManager(callbackPort, async () => {
      connectionAttempts += 1;
      if (connectionAttempts === 1) throw new UnauthorizedError("authentication required");
    });
    const finish = Promise.withResolvers<void>();
    const finishAuth = vi
      .spyOn(StreamableHTTPClientTransport.prototype, "finishAuth")
      .mockReturnValue(finish.promise);
    const controller = new AbortController();
    const authentication = manager.authenticate("remote", {
      timeout: 30_000,
      signal: controller.signal,
    });
    void authentication.catch(() => undefined);
    try {
      await vi.waitFor(async () => {
        expect((await fetch(`http://127.0.0.1:${String(callbackPort)}/not-the-callback`)).status).toBe(404);
      });
      const callback = fetch(
        `http://127.0.0.1:${String(callbackPort)}/oauth/callback?code=controlled-code&state=controlled-state`,
      );
      await vi.waitFor(() => expect(finishAuth).toHaveBeenCalledWith("controlled-code"));

      controller.abort(new Error("controlled cancellation"));

      const response = await callback;
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Authentication failed");
      finish.resolve();
      await expect(authentication).rejects.toThrow("controlled cancellation");
      expect(connectionAttempts).toBe(1);
      expect(manager.inspectServer("remote")?.status).not.toBe("connected");
    } finally {
      finish.resolve();
      finishAuth.mockRestore();
      await manager.close();
    }
  });

  test("serves an accepted OAuth callback over IPv6 loopback", async () => {
    const protocol = controlledServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await protocol.connect(transport as never);
    const serverPort = await listen((request, response) => {
      if (request.url !== "/mcp") return void response.writeHead(404).end();
      if (request.method === "POST")
        void body(request).then(async (parsed) => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          await transport.handleRequest(request, response, parsed);
        });
      else void transport.handleRequest(request, response);
    });
    const callbackPort = await availableIpv6Port();
    let credential: McpOAuthCredential | undefined = {
      serverUrl: `http://127.0.0.1:${String(serverPort)}/mcp`,
      state: "controlled-state",
    };
    const manager = await managerFor(
      `http://127.0.0.1:${String(serverPort)}/mcp`,
      "streamable_http",
      {
        redirectUri: `http://[::1]:${String(callbackPort)}/oauth/callback`,
      },
      {
        read: async () => credential,
        write: async (_key, next) => {
          credential = next;
        },
        update: async (_key, update) => {
          credential = update(credential);
        },
        delete: async () => {
          credential = undefined;
        },
        deleteIf: async (_key, predicate) => {
          if (predicate(credential)) credential = undefined;
        },
      },
    );
    try {
      const authentication = manager.authenticate("remote");
      let callback: Response | undefined;
      await vi.waitFor(async () => {
        callback = await fetch(
          `http://[::1]:${String(callbackPort)}/oauth/callback?code=controlled-code&state=controlled-state`,
        );
        expect(callback.status).toBe(200);
      });
      expect(await callback?.text()).toContain("Authentication successful");
      await expect(authentication).resolves.toBeUndefined();
    } finally {
      await manager.close();
      await protocol.close();
    }
  });

  test("observes callback rejection when the OAuth listener cannot bind", async () => {
    const protocol = controlledServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await protocol.connect(transport as never);
    const serverPort = await listen((request, response) => {
      if (request.url !== "/mcp") return void response.writeHead(404).end();
      if (request.method === "POST")
        void body(request).then(async (parsed) => await transport.handleRequest(request, response, parsed));
      else void transport.handleRequest(request, response);
    });
    const occupiedPort = await listen((_request, response) => response.end());
    const manager = await managerFor(`http://127.0.0.1:${String(serverPort)}/mcp`, "streamable_http", {
      redirectUri: `http://127.0.0.1:${String(occupiedPort)}/oauth/callback`,
    });
    try {
      await manager.start();
      await expect(manager.authenticate("remote")).rejects.toMatchObject({ code: "EADDRINUSE" });
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      await manager.close();
      await protocol.close();
    }
  });

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
