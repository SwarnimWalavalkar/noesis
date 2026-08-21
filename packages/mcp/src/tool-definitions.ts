import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import {
  createConditionalObject,
  isJsonObject,
  JsonValueSchema,
  toJsonValue,
  type EffectClass,
  type JsonValue,
} from "@noesis/domain";
import { defineTool, type ToolDefinition, type ToolExecutionContext } from "@noesis/tools";
import { z } from "zod";
import type { McpHostManager, McpInvocationContext, McpProgressEvent } from "./host.ts";
const validator = new AjvJsonSchemaValidator();
const jsonOutput = z.json();
const serverName = z.string().trim().min(1).max(64);
function protocolTool<Input>(input: {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly effect: EffectClass | ((value: Input) => EffectClass);
  readonly resource: (value: Input) => string;
  /** BOUNDARY: Protocol adapters return SDK-owned values which are converted to JSON below. */
  readonly execute: (value: Input, context: ToolExecutionContext) => Promise<unknown>;
}): ToolDefinition {
  return defineTool({
    name: input.name,
    label: input.label,
    description: input.description,
    visibility: "codemode_only",
    identityMaterial: { adapterRevision: "mcp-protocol-tools-v1" },
    inputSchema: input.inputSchema,
    outputSchema: jsonOutput,
    effect: (value) => ({
      effect: typeof input.effect === "function" ? input.effect(value) : input.effect,
      resource: input.resource(value),
      estimatedCost: 0,
    }),
    execute: async (value, context) => toJsonValue(await input.execute(value, context)),
  });
}
/** Freeze the current MCP discovery snapshot into the ordinary Noesis Broker catalog. */
export function createMcpToolDefinitions(
  host: McpHostManager,
  options: Readonly<{
    modelRoute?: McpInvocationContext["route"];
  }> = {},
): readonly ToolDefinition[] {
  const frozenServers = new Map(host.listServers().map((server) => [server.name, server]));
  const requireFrozenServer = (server: string) => {
    const frozen = frozenServers.get(server);
    if (!frozen) throw new Error(`MCP server ${server} was not present when this catalog was frozen`);
    if (host.inspectServer(server)?.identityDigest !== frozen.identityDigest)
      throw new Error(`MCP server ${server} changed after this turn's catalog was frozen`);
    return frozen;
  };
  const serverEffect = (server: string): EffectClass =>
    frozenServers.get(server)?.type === "remote" ? "network" : "execute";
  const serverResource = (server: string, suffix: string): string => {
    const scope = frozenServers.get(server)?.scope ?? "unknown";
    return `mcp:${scope}:${server}:${suffix}`;
  };
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const invocation = (context: ToolExecutionContext): McpInvocationContext | undefined =>
    options.modelRoute
      ? Object.freeze(
          createConditionalObject({
            route: options.modelRoute,
            sessionId: context.sessionId,
          } as const)
            .addOptional(context.turnId ? { turnId: context.turnId } : undefined)
            .add({
              executionId: context.executionId,
              logicalExecutionId: context.logicalExecutionId,
              callId: context.callId,
            } as const)
            .finish(),
        )
      : undefined;
  const discovered = host
    .listTools()
    .map(({ serverName: server, canonicalName, identityDigest, definition }) => {
      const inputSchema = toJsonValue(definition.inputSchema);
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      const inputValidator = validator.getValidator(structuredClone(definition.inputSchema) as never);
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      const outputValidator = definition.outputSchema
        ? validator.getValidator(structuredClone(definition.outputSchema) as never)
        : undefined;
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return Object.freeze({
        name: canonicalName,
        label: definition.title ?? definition.name,
        description: definition.description ?? `Invoke ${definition.name} on MCP server ${server}.`,
        visibility: "codemode_only" as const,
        implementationDigest: identityDigest,
        inputSchema: z.unknown(),
        outputSchema: jsonOutput,
        // BOUNDARY: AJV is the native MCP schema authority for discovered tool inputs.
        parseInput: (value: unknown): unknown => {
          const result = inputValidator(value);
          if (!result.valid) throw new Error(result.errorMessage);
          return result.data;
        },
        // BOUNDARY: AJV is the native MCP schema authority for discovered tool outputs.
        parseOutput: (value: unknown): JsonValue => {
          const protocolResult = toJsonValue(value);
          if (outputValidator && isJsonObject(protocolResult)) {
            if (protocolResult["isError"] !== true && !("structuredContent" in protocolResult)) {
              throw new Error("MCP tool declared an output schema but returned no structuredContent");
            }
            if (!("structuredContent" in protocolResult)) return protocolResult;
            const result = outputValidator(protocolResult["structuredContent"]);
            if (!result.valid) throw new Error(result.errorMessage);
          }
          return protocolResult;
        },
        catalogInputSchema: inputSchema,
        catalogOutputSchema: toJsonValue({
          type: "object",
          properties: {
            content: { type: "array" },
            ...(definition.outputSchema
              ? { structuredContent: structuredClone(definition.outputSchema) }
              : { structuredContent: { type: "object" } }),
            isError: { type: "boolean" },
            _meta: { type: "object" },
          },
          required: ["content"],
          additionalProperties: true,
        }),
        effect: () => ({
          effect: frozenServers.get(server)?.type === "remote" ? ("network" as const) : ("execute" as const),
          resource: `mcp:${frozenServers.get(server)?.scope ?? "unknown"}:${server}:tool:${definition.name}`,
          estimatedCost: 0,
        }),
        execute: async (value: unknown, context: ToolExecutionContext): Promise<JsonValue> => {
          const args = z.record(z.string(), JsonValueSchema).parse(value);
          const invocationContext = invocation(context);
          // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
          const result = await host.callTool(
            canonicalName,
            args,
            createConditionalObject({
              signal: context.signal,
              expectedIdentityDigest: identityDigest,
            } as const)
              .addOptional(invocationContext ? { invocation: invocationContext } : undefined)
              .addOptional(
                context.emitUpdate
                  ? {
                      onProgress: (event: McpProgressEvent) => context.emitUpdate?.(toJsonValue(event)),
                    }
                  : undefined,
              )
              .finish(),
          );
          return toJsonValue(result);
        },
        reportedFailure: (output: JsonValue) => {
          if (!isJsonObject(output) || output["isError"] !== true) return undefined;
          return Object.freeze({
            message: `MCP tool ${canonicalName} reported an error`,
            details: output,
          });
        },
      });
    });
  const frozenTools = new Map(host.listTools().map((tool) => [tool.canonicalName, tool]));
  const generic = Object.freeze([
    protocolTool({
      name: "mcp.servers",
      label: "List MCP servers",
      description: "List installed MCP servers, connection status, and discovered capability counts.",
      inputSchema: z.strictObject({}),
      effect: "read",
      resource: () => "mcp:servers",
      execute: async () => host.listServers(),
    }),
    protocolTool({
      name: "mcp.inspect",
      label: "Inspect MCP server",
      description: "Inspect one MCP server's instructions, tools, prompts, resources, and templates.",
      inputSchema: z.strictObject({ server: serverName }),
      effect: "read",
      resource: ({ server }) => `mcp:${server}`,
      execute: async ({ server }) => host.inspectServer(server) ?? null,
    }),
    protocolTool({
      name: "mcp.get_prompt",
      label: "Get MCP prompt",
      description: "Render a prompt exposed by an MCP server.",
      inputSchema: z.strictObject({
        server: serverName,
        name: z.string().min(1),
        arguments: z.record(z.string(), z.string()).optional(),
      }),
      effect: ({ server }) => serverEffect(server),
      resource: ({ server, name }) => serverResource(server, `prompt:${name}`),
      execute: async ({ server, name, arguments: arguments_ }, context) => {
        requireFrozenServer(server);
        return await host.getPrompt(server, name, arguments_, context.signal, invocation(context));
      },
    }),
    protocolTool({
      name: "mcp.read_resource",
      label: "Read MCP resource",
      description: "Read an exact resource URI through an MCP server.",
      inputSchema: z.strictObject({ server: serverName, uri: z.string().min(1) }),
      effect: ({ server }) => serverEffect(server),
      resource: ({ server, uri }) => serverResource(server, `resource:${uri}`),
      execute: async ({ server, uri }, context) => {
        requireFrozenServer(server);
        return await host.readResource(server, uri, context.signal, invocation(context));
      },
    }),
    protocolTool({
      name: "mcp.complete",
      label: "Complete MCP argument",
      description: "Request argument completion for an MCP prompt or resource template.",
      inputSchema: z.strictObject({
        server: serverName,
        ref: z.union([
          z.strictObject({ type: z.literal("ref/prompt"), name: z.string().min(1) }),
          z.strictObject({ type: z.literal("ref/resource"), uri: z.string().min(1) }),
        ]),
        argument: z.strictObject({ name: z.string().min(1), value: z.string() }),
        context: z.strictObject({ arguments: z.record(z.string(), z.string()).optional() }).optional(),
      }),
      effect: ({ server }) => serverEffect(server),
      resource: ({ server }) => serverResource(server, "completion"),
      execute: async ({ server, ...params }, context) => {
        requireFrozenServer(server);
        return await host.complete(server, params, context.signal, invocation(context));
      },
    }),
    protocolTool({
      name: "mcp.subscribe_resource",
      label: "Subscribe to MCP resource",
      description: "Subscribe to update notifications for an MCP resource URI.",
      inputSchema: z.strictObject({ server: serverName, uri: z.string().min(1) }),
      effect: ({ server }) => serverEffect(server),
      resource: ({ server, uri }) => serverResource(server, `subscription:${uri}`),
      execute: async ({ server, uri }, context) => {
        requireFrozenServer(server);
        await host.subscribeResource(server, uri, context.signal, invocation(context));
        return { subscribed: true };
      },
    }),
    protocolTool({
      name: "mcp.unsubscribe_resource",
      label: "Unsubscribe from MCP resource",
      description: "Stop update notifications for an MCP resource URI.",
      inputSchema: z.strictObject({ server: serverName, uri: z.string().min(1) }),
      effect: ({ server }) => serverEffect(server),
      resource: ({ server, uri }) => serverResource(server, `subscription:${uri}`),
      execute: async ({ server, uri }, context) => {
        requireFrozenServer(server);
        await host.unsubscribeResource(server, uri, context.signal, invocation(context));
        return { subscribed: false };
      },
    }),
    protocolTool({
      name: "mcp.set_logging_level",
      label: "Set MCP logging level",
      description: "Set the logging level requested from an MCP server.",
      inputSchema: z.strictObject({
        server: serverName,
        level: z.enum(["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"]),
      }),
      effect: ({ server }) => serverEffect(server),
      resource: ({ server }) => serverResource(server, "logging"),
      execute: async ({ server, level }, context) => {
        requireFrozenServer(server);
        await host.setLoggingLevel(server, level, context.signal, invocation(context));
        return { level };
      },
    }),
    protocolTool({
      name: "mcp.start_tool_task",
      label: "Start MCP tool task",
      description: "Start an MCP tool as an asynchronous task and return its task identity immediately.",
      inputSchema: z.strictObject({
        tool: z.string().min(1),
        arguments: z.record(z.string(), JsonValueSchema).default({}),
        ttl: z.number().int().positive().nullable().optional(),
      }),
      effect: ({ tool }) => serverEffect(frozenTools.get(tool)?.serverName ?? ""),
      resource: ({ tool }) => {
        const frozen = frozenTools.get(tool);
        return frozen ? serverResource(frozen.serverName, `task:${tool}`) : `mcp:unknown:task:${tool}`;
      },
      execute: async ({ tool, arguments: arguments_, ttl }, context) => {
        const frozen = frozenTools.get(tool);
        if (!frozen) throw new Error(`MCP tool ${tool} was not present when this catalog was frozen`);
        requireFrozenServer(frozen.serverName);
        const invocationContext = invocation(context);
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        return await host.startToolTask(
          tool,
          arguments_,
          createConditionalObject({} as const)
            .addOptional(!(ttl === undefined) ? { ttl } : undefined)
            .add({
              signal: context.signal,
              expectedIdentityDigest: frozen.identityDigest,
            } as const)
            .addOptional(invocationContext ? { invocation: invocationContext } : undefined)
            .finish(),
        );
      },
    }),
    protocolTool({
      name: "mcp.list_tasks",
      label: "List MCP tasks",
      description: "List durable tasks exposed by an MCP server.",
      inputSchema: z.strictObject({ server: serverName, cursor: z.string().optional() }),
      effect: ({ server }) => serverEffect(server),
      resource: ({ server }) => serverResource(server, "tasks"),
      execute: async ({ server, cursor }, context) => {
        requireFrozenServer(server);
        return await host.listTasks(server, cursor, context.signal, invocation(context));
      },
    }),
    protocolTool({
      name: "mcp.get_task",
      label: "Get MCP task",
      description: "Inspect one MCP task.",
      inputSchema: z.strictObject({ server: serverName, taskId: z.string().min(1) }),
      effect: ({ server }) => serverEffect(server),
      resource: ({ server, taskId }) => serverResource(server, `task:${taskId}`),
      execute: async ({ server, taskId }, context) => {
        requireFrozenServer(server);
        return await host.getTask(server, taskId, context.signal, invocation(context));
      },
    }),
    protocolTool({
      name: "mcp.get_task_result",
      label: "Get MCP task result",
      description: "Read the final result for one MCP task.",
      inputSchema: z.strictObject({ server: serverName, taskId: z.string().min(1) }),
      effect: ({ server }) => serverEffect(server),
      resource: ({ server, taskId }) => serverResource(server, `task:${taskId}:result`),
      execute: async ({ server, taskId }, context) => {
        requireFrozenServer(server);
        return await host.getTaskResult(server, taskId, context.signal, invocation(context));
      },
    }),
    protocolTool({
      name: "mcp.cancel_task",
      label: "Cancel MCP task",
      description: "Cancel a cancellable task exposed by an MCP server.",
      inputSchema: z.strictObject({ server: serverName, taskId: z.string().min(1) }),
      effect: ({ server }) => serverEffect(server),
      resource: ({ server, taskId }) => serverResource(server, `task:${taskId}`),
      execute: async ({ server, taskId }, context) => {
        requireFrozenServer(server);
        return await host.cancelTask(server, taskId, context.signal, invocation(context));
      },
    }),
  ]);
  return Object.freeze([...generic, ...discovered]);
}
