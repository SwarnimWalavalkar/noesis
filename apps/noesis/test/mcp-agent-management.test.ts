import { createServer, type IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type JsonValue } from "@noesis/domain";
import { resolveNoesisConfig } from "@noesis/config";
import { createPiAgentRuntime, createPiAgentRoleRunner } from "@noesis/runtime-pi";
import { createTuiMcpInteractionBridge, type TuiMcpFormElicitationResult } from "@noesis/tui";
import { afterEach, expect, test } from "vitest";
import { createApplicationMcpIntegration } from "../src/mcp-integration.ts";
import { createApplicationRuntimeComposition } from "../src/runtime-composition.ts";
import { createMcpManagementTools } from "../src/mcp-management-tools.ts";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  controlledToolCallResponse,
  createControlledPiModels,
} from "../../../packages/runtime-pi/test/support/controlled-pi-models.ts";
import { researchLoopControlledResponse } from "./support/research-loop-controlled-response.ts";

const roots: string[] = [];
const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/mcp/test/fixtures/server.mjs",
);
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const signal = () => new AbortController().signal;
const sampling = {
  sample: async () => {
    throw new Error("Unexpected sampling");
  },
};
async function setup(trusted = true, openUrl: (url: string) => Promise<void> = async () => undefined) {
  const root = await mkdtemp(join(tmpdir(), "noesis-mcp-agent-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const interactions = createTuiMcpInteractionBridge();
  const integration = createApplicationMcpIntegration({
    home,
    projectDirectory: root,
    sampling,
    interactions,
    openUrl,
    workspaceTrusted: trusted,
  });
  return { root, home, interactions, integration };
}

test("Pi codemode configures, awaits private credentials, and calls a new MCP tool in one turn", async () => {
  const { home, root, interactions, integration } = await setup();
  let forms = 0;
  interactions.attach({
    presentForm: (request) => {
      forms += 1;
      expect(request.fields).toEqual([
        {
          name: "NOESIS_AGENT_TEST_CREDENTIAL",
          label: "NOESIS_AGENT_TEST_CREDENTIAL",
          type: "secret",
          required: true,
        },
      ]);
      return {
        result: Promise.resolve({
          action: "accept",
          values: { NOESIS_AGENT_TEST_CREDENTIAL: "private-test-value" },
        }),
        cancel: () => undefined,
      };
    },
    presentUrl: () => {
      throw new Error("Unexpected URL");
    },
  });
  const source = `
    const before = await noesis.describe("mcp.call_tool");
    const configured = await tools.mcp.configure({ scope: "global", name: "controlled", config: {
      type: "local", command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(fixture)}],
      environment: { CONTROLLED_SECRET: "NOESIS_AGENT_TEST_CREDENTIAL" }
    }});
    if (configured.ready) throw new Error("Server must require credentials first");
    const authenticated = await tools.mcp.authenticate({ scope: "global", name: "controlled" });
    if (!authenticated.ready) throw new Error("Authentication did not connect");
    const tool = authenticated.tools.find(t => t.definition.name === "echo/tool");
    const result = await tools.mcp.call_tool({ tool: tool.canonicalName, identityDigest: tool.identityDigest, arguments: { value: "same-turn-success" } });
    if (result.structuredContent.echoed !== "same-turn-success") throw new Error("Wrong result");
    return result;
  `;
  const controlled = createControlledPiModels({
    respond: (input) => {
      if (input.systemPrompt.includes("role:")) return researchLoopControlledResponse(input);
      if (!input.context.messages.some((message) => message.role === "toolResult"))
        return controlledToolCallResponse("execute", { source }, "manage-mcp");
      return "MCP setup completed.";
    },
  });
  const config = await resolveNoesisConfig({
    home,
    env: {},
    cli: { provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL },
  });
  const runtime = await createApplicationRuntimeComposition({
    config,
    mcp: integration,
    createAgent: (_, codeExecution) => createPiAgentRuntime(root, controlled.models, { codeExecution }),
    createRoleRunner: (configurations) => createPiAgentRoleRunner(root, controlled.models, configurations),
  });
  try {
    const trail = await runtime.startTrail({ title: "MCP setup" });
    await runtime.debug.runTurn(
      trail.trailId,
      "Add and authenticate the controlled MCP server and use its echo tool.",
    );
    const calls = await runtime.debug.workspace.operational.toolCalls.listForSession(trail.trailId);
    expect(
      calls
        .filter((call) => ["mcp.configure", "mcp.authenticate", "mcp.call_tool"].includes(call.toolName))
        .map((call) => [call.toolName, call.status]),
    ).toEqual([
      ["mcp.configure", "completed"],
      ["mcp.authenticate", "completed"],
      ["mcp.call_tool", "completed"],
    ]);
    expect(JSON.stringify(calls)).toContain("same-turn-success");
    expect(JSON.stringify(calls)).not.toContain("private-test-value");
    expect(await readFile(join(home, "mcp.json"), "utf8")).not.toContain("private-test-value");
    expect(forms).toBe(1);
  } finally {
    await runtime.shutdown();
  }
}, 30000);

test("configuration preserves transport/auth options and blocks untrusted project setup", async () => {
  const { integration, home } = await setup(false);
  integration.setLifecycleAuthorizer(async ({ execute }) => execute());
  try {
    await integration.start();
    const config = {
      type: "remote" as const,
      url: "http://127.0.0.1:1/mcp",
      transport: "streamable_http" as const,
      enabled: false,
      oauth: { clientId: "registered", scope: "profile.read" },
    };
    await expect(integration.configureMcp("project", "remote", config, signal())).rejects.toThrow("trusted");
    await integration.configureMcp("global", "remote", config, signal());
    expect(JSON.parse(await readFile(join(home, "mcp.json"), "utf8"))).toEqual({
      servers: { remote: config },
    });
  } finally {
    await integration.close();
  }
});

test("cancelled credential collection cannot report readiness or persist values", async () => {
  const { integration, interactions } = await setup();
  integration.setLifecycleAuthorizer(async ({ execute }) => execute());
  interactions.attach({
    presentForm: () => ({ result: Promise.resolve({ action: "cancel" }), cancel: () => undefined }),
    presentUrl: () => {
      throw new Error("Unexpected URL");
    },
  });
  try {
    await integration.start();
    await integration.configureMcp(
      "global",
      "controlled",
      {
        type: "local",
        command: process.execPath,
        args: [fixture],
        environment: { CONTROLLED_SECRET: "NOESIS_CANCELLED_CREDENTIAL" },
      },
      signal(),
    );
    await expect(integration.authenticateMcp("global", "controlled", signal())).rejects.toThrow("cancelled");
    expect(integration.host.inspectServer("controlled")?.status).not.toBe("connected");
  } finally {
    await integration.close();
  }
});

test("same-turn adapter rejects stale identities and invalid native MCP input", async () => {
  const { integration } = await setup();
  integration.setLifecycleAuthorizer(async ({ execute }) => execute());
  try {
    await integration.start();
    const definitions = createMcpManagementTools(integration, {
      provider: "controlled",
      model: "controlled",
      reasoning: "medium",
    });
    const invoke = definitions.find((tool) => tool.name === "mcp.call_tool");
    if (!invoke) throw new Error("Missing adapter");
    await integration.configureMcp(
      "global",
      "controlled",
      { type: "local", command: process.execPath, args: [fixture] },
      signal(),
    );
    const tool = integration.host.listTools().find((tool) => tool.definition.name === "echo/tool");
    if (!tool) throw new Error("Missing echo");
    const context = {
      executionId: "test",
      logicalExecutionId: "test",
      callId: "test",
      sessionId: "test",
      signal: signal(),
    };
    const input = {
      tool: tool.canonicalName,
      identityDigest: tool.identityDigest,
      arguments: { value: "ok" },
    };
    expect(invoke.effect(input, context)).toMatchObject({
      effect: "execute",
      resource: "mcp:global:controlled:tool:echo/tool",
    });
    await expect(invoke.execute({ ...input, arguments: { value: 42 } }, context)).rejects.toThrow();
    await integration.configureMcp(
      "global",
      "controlled",
      { type: "local", command: process.execPath, args: [fixture], description: "changed" },
      signal(),
    );
    expect(() => invoke.effect(input, context)).toThrow("identity changed");
    await expect(invoke.execute(input, context)).rejects.toThrow("identity changed");
  } finally {
    await integration.close();
  }
});

test("editing a server while its credential form is open rejects the old credentials", async () => {
  const { integration, interactions } = await setup();
  integration.setLifecycleAuthorizer(async ({ execute }) => execute());
  let resolveForm: ((result: TuiMcpFormElicitationResult) => void) | undefined;
  let opened: (() => void) | undefined;
  const formOpened = new Promise<void>((resolve) => {
    opened = resolve;
  });
  interactions.attach({
    presentForm: () => {
      opened?.();
      return {
        result: new Promise((resolve) => {
          resolveForm = resolve;
        }),
        cancel: () => undefined,
      };
    },
    presentUrl: () => {
      throw new Error("Unexpected URL");
    },
  });
  try {
    await integration.start();
    const config = {
      type: "local" as const,
      command: process.execPath,
      args: [fixture],
      environment: { CONTROLLED_SECRET: "NOESIS_CHANGED_CREDENTIAL" },
    };
    await integration.configureMcp("global", "controlled", config, signal());
    const authenticating = integration.authenticateMcp("global", "controlled", signal());
    await formOpened;
    await integration.configureMcp(
      "global",
      "controlled",
      { ...config, description: "new destination" },
      signal(),
    );
    resolveForm?.({ action: "accept", values: { NOESIS_CHANGED_CREDENTIAL: "do-not-use" } });
    await expect(authenticating).rejects.toThrow("configuration changed");
  } finally {
    await integration.close();
  }
});

test.each([false, true])(
  "OAuth preserves sign-in through post-login connection failure=%s",
  async (failConnection) => {
    const callbackReservation = createServer();
    await new Promise<void>((resolve) => callbackReservation.listen(0, "127.0.0.1", resolve));
    const address = callbackReservation.address();
    if (!address || typeof address === "string") throw new Error("Missing callback port");
    const callbackPort = address.port;
    await new Promise<void>((resolve) => callbackReservation.close(() => resolve()));
    let opened: ((url: string) => void) | undefined;
    const browserOpened = new Promise<string>((resolve) => {
      opened = resolve;
    });
    let browserOpens = 0;
    const { integration } = await setup(true, async (url) => {
      browserOpens += 1;
      opened?.(url);
    });
    integration.setLifecycleAuthorizer(async ({ execute }) => execute());
    const protocol = new McpServer({ name: "oauth-controlled", version: "1.0.0" });
    protocol.registerTool("ping", { description: "Return pong" }, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
    // SAFETY: The SDK server and transport implement the same protocol across their generic boundary.
    await protocol.connect(transport as never);
    const requestBody = async (request: IncomingMessage): Promise<string> => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    };
    let origin = "";
    let tokensRequested = 0;
    let connectionFails = failConnection;
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", origin).pathname;
      const json = (value: JsonValue) =>
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (path.startsWith("/.well-known/oauth-protected-resource")) {
        json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      } else if (path === "/.well-known/oauth-authorization-server") {
        json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      } else if (path === "/token") {
        tokensRequested += 1;
        json({ access_token: "controlled-oauth-token", token_type: "Bearer", expires_in: 3600 });
      } else if (path === "/mcp") {
        if (request.headers.authorization !== "Bearer controlled-oauth-token") {
          response
            .writeHead(401, {
              "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
            })
            .end();
          return;
        }
        if (connectionFails) {
          response.writeHead(500, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32603, message: "Internal server error" },
            }),
          );
          return;
        }
        if (request.method === "POST")
          void requestBody(request).then((body) =>
            transport.handleRequest(request, response, JSON.parse(body)),
          );
        else void transport.handleRequest(request, response);
      } else response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const serverAddress = server.address();
    if (!serverAddress || typeof serverAddress === "string") throw new Error("Missing HTTP port");
    origin = `http://127.0.0.1:${serverAddress.port}`;
    try {
      await integration.start();
      await integration.configureMcp(
        "global",
        "remote",
        {
          type: "remote",
          url: `${origin}/mcp`,
          transport: "streamable_http",
          oauth: { clientId: "controlled-client", callbackPort },
        },
        signal(),
      );
      expect(browserOpens).toBe(0);
      expect(integration.host.inspectServer("remote")?.status).toBe("auth_required");
      let completed = false;
      const authentication = integration.authenticateMcp("global", "remote", signal()).then(() => {
        completed = true;
      });
      void authentication.catch(() => undefined);
      const authorizationUrl = new URL(await browserOpened);
      expect(completed).toBe(false);
      expect(tokensRequested).toBe(0);
      const callback = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? "");
      callback.searchParams.set("code", "controlled-code");
      callback.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
      const callbackResponse = await fetch(callback);
      expect(callbackResponse.status).toBe(200);
      if (failConnection) {
        expect(await callbackResponse.text()).toContain("Sign-in completed; server connection failed");
        await expect(authentication).rejects.toThrow("Credentials were saved. Use mcp.reconnect");
        expect(integration.host.inspectServer("remote")?.status).not.toBe("connected");
        connectionFails = false;
        await integration.mutateMcp({ type: "reconnect", scope: "global", name: "remote" });
        expect(browserOpens).toBe(1);
      } else {
        expect(await callbackResponse.text()).toContain("Authentication successful");
        await authentication;
      }
      expect(tokensRequested).toBe(1);
      expect(integration.host.inspectServer("remote")?.status).toBe("connected");
      const ping = integration.host.listTools("remote")[0];
      if (!ping) throw new Error("Missing authenticated tool");
      expect(
        await integration.host.callTool(
          ping.canonicalName,
          {},
          { expectedIdentityDigest: ping.identityDigest },
        ),
      ).toMatchObject({ content: [{ text: "pong" }] });
    } finally {
      await integration.close();
      await protocol.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  15000,
);

function reopenedIntegration(home: string, root: string) {
  const integration = createApplicationMcpIntegration({
    home,
    projectDirectory: root,
    sampling,
    interactions: createTuiMcpInteractionBridge(),
    openUrl: async () => {
      throw new Error("Restart must not request authentication");
    },
    workspaceTrusted: true,
  });
  integration.setLifecycleAuthorizer(async ({ execute }) => execute());
  return integration;
}

test("stdio credentials survive restart, remain scoped, and are forgotten on logout/removal", async () => {
  const { home, root, integration, interactions } = await setup();
  integration.setLifecycleAuthorizer(async ({ execute }) => execute());
  interactions.attach({
    presentForm: (request) => ({
      result: Promise.resolve({
        action: "accept",
        values: { NOESIS_PERSISTED_SECRET: `${request.serverName}-secret` },
      }),
      cancel: () => undefined,
    }),
    presentUrl: () => {
      throw new Error("Unexpected URL");
    },
  });
  const config = {
    type: "local" as const,
    command: process.execPath,
    args: [fixture],
    environment: { CONTROLLED_SECRET: "NOESIS_PERSISTED_SECRET" },
  };
  try {
    await integration.start();
    for (const name of ["alpha", "beta"]) {
      await integration.configureMcp("global", name, config, signal());
      await integration.authenticateMcp("global", name, signal());
    }
    expect((await stat(join(home, "mcp-secrets.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(home, "mcp.json"), "utf8")).not.toContain("alpha-secret");
  } finally {
    await integration.close();
  }
  const restored = reopenedIntegration(home, root);
  try {
    await restored.start();
    for (const name of ["alpha", "beta"]) {
      expect(restored.host.inspectServer(name)?.status).toBe("connected");
      expect(await restored.host.callTool(`mcp.${name}.environment`, {})).toMatchObject({
        content: [{ text: `${name}-secret` }],
      });
    }
    // Ordinary metadata edits retain authentication.
    await restored.configureMcp(
      "global",
      "alpha",
      { ...config, description: "renamed description" },
      signal(),
    );
    expect(restored.host.inspectServer("alpha")?.status).toBe("connected");
    await restored.mutateMcp({ type: "logout", scope: "global", name: "alpha" });
    expect(restored.host.inspectServer("alpha")?.status).not.toBe("connected");
    await restored.mutateMcp({ type: "remove", scope: "global", name: "beta" });
    expect(JSON.parse(await readFile(join(home, "mcp-secrets.json"), "utf8"))).toEqual({});
  } finally {
    await restored.close();
  }
  const loggedOut = reopenedIntegration(home, root);
  try {
    await loggedOut.start();
    expect(loggedOut.host.inspectServer("alpha")?.status).not.toBe("connected");
    expect(loggedOut.host.inspectServer("beta")).toBeUndefined();
  } finally {
    await loggedOut.close();
  }
});

test("saved HTTP-header credentials reconnect after restart and never follow a changed endpoint", async () => {
  let accepted = 0;
  let misdirected = false;
  const protocols: McpServer[] = [];
  const server = createServer((request, response) => {
    if (request.url !== "/mcp") {
      if (request.headers.authorization) misdirected = true;
      response.writeHead(401).end();
      return;
    }
    if (request.headers.authorization !== "Bearer persisted-header") {
      response.writeHead(401).end();
      return;
    }
    accepted += 1;
    const protocol = new McpServer({ name: "header-controlled", version: "1.0.0" });
    protocols.push(protocol);
    protocol.registerTool("ping", { description: "Return pong" }, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    const transport = new StreamableHTTPServerTransport({});
    void (async () => {
      // SAFETY: The SDK server and transport implement the same protocol across their generic boundary.
      await protocol.connect(transport as never);
      await transport.handleRequest(request, response);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP port");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const { home, root, integration, interactions } = await setup();
  integration.setLifecycleAuthorizer(async ({ execute }) => execute());
  interactions.attach({
    presentForm: () => ({
      result: Promise.resolve({
        action: "accept",
        values: { NOESIS_HEADER_SECRET: "Bearer persisted-header" },
      }),
      cancel: () => undefined,
    }),
    presentUrl: () => {
      throw new Error("Unexpected URL");
    },
  });
  const config = {
    type: "remote" as const,
    url,
    transport: "streamable_http" as const,
    oauth: false,
    headers: { Authorization: "NOESIS_HEADER_SECRET" },
  };
  let restored: ReturnType<typeof reopenedIntegration> | undefined;
  try {
    await integration.start();
    await integration.configureMcp("global", "headers", config, signal());
    await integration.authenticateMcp("global", "headers", signal());
    await integration.close();
    const beforeRestart = accepted;
    restored = reopenedIntegration(home, root);
    await restored.start();
    expect(restored.host.inspectServer("headers")?.status).toBe("connected");
    expect(accepted).toBeGreaterThan(beforeRestart);
    expect(await restored.host.callTool("mcp.headers.ping", {})).toMatchObject({
      content: [{ text: "pong" }],
    });
    await restored.configureMcp("global", "headers", { ...config, url: `${url}-other` }, signal());
    expect(restored.host.inspectServer("headers")?.status).not.toBe("connected");
    expect(misdirected).toBe(false);
  } finally {
    await integration.close();
    await restored?.close();
    await Promise.all(protocols.map((protocol) => protocol.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15000);
