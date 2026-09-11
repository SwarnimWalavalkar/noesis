import { isJsonObject, JsonValueSchema, toJsonValue, type JsonValue } from "@noesis/domain";
import { createMcpToolDefinitions, McpServerConfigSchema, type McpInvocationContext } from "@noesis/mcp";
import { defineTool, type ToolDefinition, type ToolExecutionContext } from "@noesis/tools";
import { z } from "zod";
import type { ApplicationMcpIntegration } from "./mcp-integration.ts";

type ManagementPort = Pick<
  ApplicationMcpIntegration,
  | "readMcpConfiguration"
  | "host"
  | "listMcpServers"
  | "inspectMcpServer"
  | "mutateMcp"
  | "configureMcp"
  | "authenticateMcp"
>;
const target = z.strictObject({
  scope: z.enum(["global", "project"]),
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
});

/** Fixed foreground adapters: configuration never changes the provider or Broker catalog. */
export function createMcpManagementTools(
  port: ManagementPort,
  modelRoute: McpInvocationContext["route"],
): readonly ToolDefinition[] {
  const status = async (scope: "global" | "project", name: string): Promise<JsonValue> => {
    const server = await port.inspectMcpServer(scope, name);
    return toJsonValue({
      server: server ?? null,
      configuration: (await port.readMcpConfiguration(scope, name)) ?? null,
      ready: server?.status === "connected",
      tools: server?.status === "connected" ? port.host.listTools(name) : [],
    });
  };
  const lifecycle = (operation: "remove" | "reconnect" | "logout") =>
    defineTool({
      name: `mcp.${operation}`,
      label: `${operation} MCP server`,
      description:
        operation === "logout"
          ? "Forget saved OAuth and header/stdio credentials for an exact global/project MCP server and disconnect it. Credentials supplied by the launch environment remain environment-owned."
          : `${operation} an exact global or project MCP server. Returns connection state and exact discovered tool identities.`,
      inputSchema: target,
      outputSchema: JsonValueSchema,
      effect: ({ scope, name }) => ({
        effect: "write",
        resource: `mcp:${scope}:${name}:management`,
        estimatedCost: 0,
      }),
      execute: async ({ scope, name }, context) => {
        context.signal.throwIfAborted();
        await port.mutateMcp({ type: operation, scope, name }, context.signal);
        return await status(scope, name);
      },
    });
  const invocation = z.strictObject({
    tool: z.string().min(1),
    identityDigest: z.string().min(1),
    arguments: z.record(z.string(), JsonValueSchema).default({}),
  });
  const resolveTool = (input: z.infer<typeof invocation>) => {
    const tool = createMcpToolDefinitions(port.host, { modelRoute }).find(
      (tool) => tool.implementation.kind === "mcp" && tool.name === input.tool,
    );
    if (!tool || tool.implementationDigest !== input.identityDigest)
      throw new Error("MCP tool identity changed or is unavailable; inspect mcp.status before calling again");
    const parsed = tool.parseInput
      ? tool.parseInput(input.arguments)
      : tool.inputSchema.parse(input.arguments);
    return { tool, parsed };
  };
  return Object.freeze([
    defineTool({
      name: "mcp.status",
      label: "Inspect MCP configuration and readiness",
      description:
        "Inspect a scoped server and its readiness, exact tool identities, and schemas. Use returned canonicalName and identityDigest with mcp.call_tool, including immediately after configuration or authentication.",
      inputSchema: target,
      outputSchema: JsonValueSchema,
      effect: ({ scope, name }) => ({ effect: "read", resource: `mcp:${scope}:${name}`, estimatedCost: 0 }),
      execute: async ({ scope, name }) => await status(scope, name),
    }),
    defineTool({
      name: "mcp.configure",
      label: "Configure MCP server",
      description:
        "Add or replace a global/project MCP definition and connect it now. Local means stdio; remote supports streamable_http, auto, or legacy sse. oauth true/object enables OAuth, false disables it. headers/environment map names to environment variable references, never secret values. Configuration is a complete replacement. Returns readiness and discovered tool identities; use mcp.authenticate when credentials are needed.",
      inputSchema: target.extend({ config: McpServerConfigSchema }),
      outputSchema: JsonValueSchema,
      effect: ({ scope, name }) => ({
        effect: "write",
        resource: `mcp:${scope}:${name}:management`,
        estimatedCost: 0,
      }),
      execute: async ({ scope, name, config }, context) => {
        await port.configureMcp(scope, name, config, context.signal);
        return await status(scope, name);
      },
    }),
    defineTool({
      name: "mcp.authenticate",
      label: "Request MCP authentication",
      description:
        "Open the user authentication flow and await completion. OAuth opens the browser and waits for its verified callback and reconnect. Header/stdio credentials use a masked form and persist in protected storage for automatic reconnection after restart. Cancellation or failed connection fails the call; successful results include readiness and exact tool identities. Never ask the user to put secrets in chat.",
      inputSchema: target,
      outputSchema: JsonValueSchema,
      effect: ({ scope, name }) => ({
        effect: "write",
        resource: `mcp:${scope}:${name}:authentication`,
        estimatedCost: 0,
      }),
      execute: async ({ scope, name }, context) => {
        await port.authenticateMcp(scope, name, context.signal);
        return await status(scope, name);
      },
    }),
    defineTool({
      name: "mcp.set_enabled",
      label: "Enable or disable MCP server",
      description: "Enable or disable a scoped MCP definition and reload connections in this session.",
      inputSchema: target.extend({ enabled: z.boolean() }),
      outputSchema: JsonValueSchema,
      effect: ({ scope, name }) => ({
        effect: "write",
        resource: `mcp:${scope}:${name}:management`,
        estimatedCost: 0,
      }),
      execute: async ({ scope, name, enabled }, context) => {
        context.signal.throwIfAborted();
        await port.mutateMcp({ type: "set-enabled", scope, name, enabled }, context.signal);
        return await status(scope, name);
      },
    }),
    defineTool({
      name: "mcp.reload",
      label: "Reload MCP servers",
      description:
        "Reread global/project MCP configuration and reconnect servers in this session. Inspect mcp.status afterward; existing turn-frozen MCP adapters may become stale.",
      inputSchema: z.strictObject({}),
      outputSchema: JsonValueSchema,
      effect: () => ({ effect: "write", resource: "mcp:configuration:reload", estimatedCost: 0 }),
      execute: async (_, context) => {
        context.signal.throwIfAborted();
        await port.mutateMcp({ type: "reload" }, context.signal);
        return toJsonValue(await port.listMcpServers());
      },
    }),
    ...(["remove", "reconnect", "logout"] as const).map(lifecycle),
    defineTool({
      name: "mcp.call_tool",
      label: "Call an exact discovered MCP tool",
      description:
        "Call a tool using its canonicalName and identityDigest from mcp.status or a management result. Supports immediate same-turn use after connecting/authenticating. Validates the discovered schemas and fails closed if the identity changed. Server-driven forms/URL requests are presented to the user while awaiting the result.",
      inputSchema: invocation,
      outputSchema: JsonValueSchema,
      effect: (input, context) => {
        const { tool, parsed } = resolveTool(input);
        return tool.effect(parsed, context);
      },
      execute: async (input, context: ToolExecutionContext) => {
        const { tool, parsed } = resolveTool(input);
        const output = await tool.execute(parsed, context);
        return tool.parseOutput ? tool.parseOutput(output) : tool.outputSchema.parse(output);
      },
      reportedFailure: (output) => {
        if (isJsonObject(output) && output["isError"] === true)
          return { message: "MCP tool reported an error", details: output };
        return undefined;
      },
    }),
  ]);
}
