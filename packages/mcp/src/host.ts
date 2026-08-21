import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type CallToolResult,
  CallToolResultSchema,
  type CancelTaskResult,
  type CompleteRequest,
  type CompleteResult,
  type CreateMessageRequest,
  CreateMessageRequestSchema,
  type CreateMessageResult,
  CreateMessageResultSchema,
  type CreateMessageResultWithTools,
  CreateMessageResultWithToolsSchema,
  ElicitationCompleteNotificationSchema,
  type ElicitRequest,
  ElicitRequestSchema,
  type ElicitResult,
  type GetPromptResult,
  type GetTaskResult,
  ListRootsRequestSchema,
  type ListTasksResult,
  type LoggingLevel,
  LoggingMessageNotificationSchema,
  type Prompt,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  ResourceUpdatedNotificationSchema,
  type ServerCapabilities,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { canonicalJson, type JsonValue, sha256, toJsonValue } from "@noesis/domain";
import type { LoadedMcpConfig, McpRemoteServerConfig, ScopedMcpServer } from "./config.ts";
import { createMcpOAuthProvider, type McpOAuthCredentialStore, type McpOAuthRedirect } from "./oauth.ts";

export type McpServerStatus = "disabled" | "connecting" | "connected" | "auth_required" | "failed";

export interface McpCapabilityCounts {
  readonly tools: number;
  readonly prompts: number;
  readonly resources: number;
  readonly resourceTemplates: number;
}

export interface McpServerSummary {
  readonly name: string;
  readonly scope: "global" | "project";
  readonly sourcePath: string;
  readonly type: "local" | "remote";
  readonly enabled: boolean;
  readonly status: McpServerStatus;
  readonly description?: string;
  readonly capabilityCounts: McpCapabilityCounts;
  readonly lastError?: string;
  readonly identityDigest: string;
}

export interface McpServerDetail extends McpServerSummary {
  readonly instructions?: string;
  readonly negotiatedCapabilities?: ServerCapabilities;
  readonly diagnostics: readonly McpDiagnostic[];
  readonly tools: readonly Tool[];
  readonly prompts: readonly Prompt[];
  readonly resources: readonly Resource[];
  readonly resourceTemplates: readonly ResourceTemplate[];
}

export interface McpDiagnostic {
  readonly code: "invalid_tool_schema" | "duplicate_tool_name" | "subscriptions_dropped";
  readonly message: string;
  readonly toolName?: string;
}

export interface McpProgressEvent {
  readonly serverName: string;
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
}

export interface McpHostEvent {
  readonly serverName: string;
  readonly type:
    | "catalog_changed"
    | "resource_updated"
    | "elicitation_complete"
    | "log"
    | "progress"
    | "connection";
  readonly payload: JsonValue;
  readonly invocation?: McpInvocationContext;
}

/** The exact foreground model route and execution identity responsible for an MCP request. */
export interface McpInvocationContext {
  readonly route: {
    readonly provider: string;
    readonly model: string;
    readonly reasoning: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  };
  readonly sessionId: string;
  readonly turnId?: string;
  readonly executionId: string;
  readonly logicalExecutionId: string;
  readonly callId: string;
}

export interface McpHostHandlers {
  readonly connect?: (input: {
    readonly connectionIdentity: string;
    readonly serverName: string;
    readonly scope: "global" | "project";
    readonly transport: "stdio" | "streamable_http" | "sse";
    readonly execute: () => Promise<void>;
  }) => Promise<void>;
  readonly sample: (
    serverName: string,
    request: CreateMessageRequest,
    signal: AbortSignal,
    invocation?: McpInvocationContext,
  ) => Promise<CreateMessageResult | CreateMessageResultWithTools>;
  readonly elicit: (
    serverName: string,
    request: ElicitRequest,
    signal: AbortSignal,
    invocation?: McpInvocationContext,
  ) => Promise<ElicitResult>;
  readonly onOAuthRedirect: (redirect: McpOAuthRedirect) => void | Promise<void>;
  readonly onEvent?: (event: McpHostEvent) => void | Promise<void>;
}

const connectionLifecycleFailureBrand = Symbol("noesis.mcp.connection-lifecycle-failure");

interface McpConnectionLifecycleFailure extends Error {
  readonly [connectionLifecycleFailureBrand]: boolean;
}

/** Prevents an authority denial from being mistaken for a retryable transport failure. */
export function createMcpConnectionLifecycleFailure(message: string, retryable: boolean): Error {
  const error = new Error(message) as McpConnectionLifecycleFailure;
  Object.defineProperty(error, connectionLifecycleFailureBrand, {
    configurable: false,
    enumerable: false,
    value: retryable,
    writable: false,
  });
  return error;
}

function connectionLifecycleFailureRetryable(error: unknown): boolean | undefined {
  return error instanceof Error
    ? (error as Partial<McpConnectionLifecycleFailure>)[connectionLifecycleFailureBrand]
    : undefined;
}

export interface CreateMcpHostManagerInput {
  readonly home: string;
  readonly projectDirectory: string;
  readonly config: LoadedMcpConfig;
  readonly credentials: McpOAuthCredentialStore;
  readonly handlers: McpHostHandlers;
  readonly oauthRedirectUrl?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly clientVersion?: string;
}

interface Catalog {
  readonly tools: readonly Tool[];
  readonly prompts: readonly Prompt[];
  readonly resources: readonly Resource[];
  readonly resourceTemplates: readonly ResourceTemplate[];
}

interface Connection {
  readonly server: ScopedMcpServer;
  status: McpServerStatus;
  lastError: string | undefined;
  client: Client | undefined;
  transport: Transport | RemoteTransport | undefined;
  catalog: Catalog;
  discoveryCatalog: JsonValue;
  dirty: boolean;
  taskStore: InMemoryTaskStore | undefined;
  activeInvocation: McpInvocationContext | undefined;
  readonly taskInvocations: Map<string, McpInvocationContext>;
  requestQueue: Promise<void>;
  reconnectAttempts: number;
  reconnectTimer: NodeJS.Timeout | undefined;
  intentionalClose: boolean;
  diagnostics: McpDiagnostic[];
}

interface ConnectionAttempt {
  readonly connection: Connection;
  readonly client: Client;
  readonly transport: Transport | RemoteTransport;
  readonly taskStore: InMemoryTaskStore;
}

interface ResourceSubscriptions {
  readonly serverIdentityDigest: string;
  readonly uris: Set<string>;
}

interface ActiveAuthentication {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

interface PendingOAuthTransport {
  readonly transport: RemoteTransport;
  readonly owner: ActiveAuthentication | undefined;
}

type RemoteTransport = StreamableHTTPClientTransport | SSEClientTransport;

const EMPTY_CATALOG: Catalog = Object.freeze({
  tools: Object.freeze([]),
  prompts: Object.freeze([]),
  resources: Object.freeze([]),
  resourceTemplates: Object.freeze([]),
});

const DEFAULT_TIMEOUT = 30_000;
const AUTO_RECONNECT_DELAYS = Object.freeze([100, 500, 2_000]);
const MAX_DIAGNOSTICS = 50;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 2_000;
const elicitationValidator = new AjvJsonSchemaValidator();
const toolSchemaValidator = new AjvJsonSchemaValidator();

export function parseMcpSamplingResult(value: unknown): CreateMessageResult | CreateMessageResultWithTools {
  const ordinary = CreateMessageResultSchema.safeParse(value);
  return ordinary.success ? ordinary.data : CreateMessageResultWithToolsSchema.parse(value);
}

export function validateMcpElicitationResult(request: ElicitRequest, result: ElicitResult): ElicitResult {
  if (result.action !== "accept" || request.params.mode === "url") return result;
  const validation = elicitationValidator.getValidator(
    structuredClone(request.params.requestedSchema) as never,
  )(result.content);
  if (!validation.valid) throw new Error(`MCP elicitation response is invalid: ${validation.errorMessage}`);
  return result;
}

function requestOptions(
  signal?: AbortSignal,
  timeout = DEFAULT_TIMEOUT,
  onProgress?: (event: McpProgressEvent) => void,
  serverName = "",
): RequestOptions {
  return {
    timeout,
    resetTimeoutOnProgress: true,
    ...(signal ? { signal } : {}),
    ...(onProgress
      ? {
          onprogress: (progress) =>
            onProgress({
              serverName,
              progress: progress.progress,
              ...(progress.total === undefined ? {} : { total: progress.total }),
              ...(progress.message === undefined ? {} : { message: progress.message }),
            }),
        }
      : {}),
  };
}

async function paginated<Item>(
  fetchPage: (cursor?: string) => Promise<{ readonly items: readonly Item[]; readonly nextCursor?: string }>,
): Promise<readonly Item[]> {
  const items: Item[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    if (cursor && cursors.has(cursor))
      throw new Error(`MCP pagination repeated cursor ${JSON.stringify(cursor)}`);
    if (cursor) cursors.add(cursor);
    if (cursors.size > 1_000) throw new Error("MCP pagination exceeded 1000 pages");
    const page = await fetchPage(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return Object.freeze(items);
}

function canonicalDiscoveryCatalog(catalog: Catalog): JsonValue {
  const byName = <Value extends { readonly name: string }>(values: readonly Value[]): readonly Value[] =>
    [...values].sort((left, right) => left.name.localeCompare(right.name));
  const byUri = <Value extends { readonly uri: string }>(values: readonly Value[]): readonly Value[] =>
    [...values].sort((left, right) => left.uri.localeCompare(right.uri));
  return toJsonValue({
    tools: byName(catalog.tools),
    prompts: byName(catalog.prompts),
    resources: byUri(catalog.resources),
    resourceTemplates: [...catalog.resourceTemplates].sort((left, right) =>
      left.uriTemplate.localeCompare(right.uriTemplate),
    ),
  });
}

function connectionIdentityDigest(connection: Connection): string {
  return sha256(
    canonicalJson({
      name: connection.server.name,
      scope: connection.server.scope,
      config: connection.server.config,
      serverVersion: connection.client?.getServerVersion() ?? null,
      negotiatedCapabilities: connection.client?.getServerCapabilities() ?? null,
      discoveryCatalog: connection.discoveryCatalog,
    }),
  );
}

function connectionSummary(connection: Connection): McpServerSummary {
  return Object.freeze({
    name: connection.server.name,
    scope: connection.server.scope,
    sourcePath: connection.server.sourcePath,
    type: connection.server.config.type,
    enabled: connection.server.config.enabled !== false,
    status: connection.status,
    ...(connection.server.config.description ? { description: connection.server.config.description } : {}),
    capabilityCounts: Object.freeze({
      tools: connection.catalog.tools.length,
      prompts: connection.catalog.prompts.length,
      resources: connection.catalog.resources.length,
      resourceTemplates: connection.catalog.resourceTemplates.length,
    }),
    ...(connection.lastError ? { lastError: connection.lastError } : {}),
    identityDigest: connectionIdentityDigest(connection),
  });
}

export interface McpHostManager {
  readonly start: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly listServers: () => readonly McpServerSummary[];
  readonly inspectServer: (name: string) => McpServerDetail | undefined;
  readonly reconnect: (name: string) => Promise<void>;
  readonly authenticate: (
    name: string,
    options?: Readonly<{ signal?: AbortSignal; timeout?: number }>,
  ) => Promise<void>;
  readonly reload: (config: LoadedMcpConfig) => Promise<void>;
  readonly refreshDiscovery: (signal?: AbortSignal) => Promise<void>;
  readonly finishAuthentication: (name: string, authorizationCode: string) => Promise<void>;
  readonly logout: (name: string) => Promise<void>;
  readonly listTools: (serverName?: string) => readonly Readonly<{
    serverName: string;
    canonicalName: string;
    identityDigest: string;
    definition: Tool;
  }>[];
  readonly callTool: (
    canonicalName: string,
    args: Readonly<Record<string, unknown>>,
    options?: Readonly<{
      signal?: AbortSignal;
      onProgress?: (event: McpProgressEvent) => void;
      task?: RequestOptions["task"];
      expectedIdentityDigest?: string;
      invocation?: McpInvocationContext;
    }>,
  ) => Promise<CallToolResult>;
  readonly startToolTask: (
    canonicalName: string,
    args: Readonly<Record<string, unknown>>,
    options: Readonly<{
      ttl?: number | null;
      signal?: AbortSignal;
      expectedIdentityDigest?: string;
      invocation?: McpInvocationContext;
    }>,
  ) => Promise<JsonValue>;
  readonly getPrompt: (
    serverName: string,
    name: string,
    args?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
    invocation?: McpInvocationContext,
  ) => Promise<GetPromptResult>;
  readonly readResource: (
    serverName: string,
    uri: string,
    signal?: AbortSignal,
    invocation?: McpInvocationContext,
  ) => Promise<ReadResourceResult>;
  readonly complete: (
    serverName: string,
    params: CompleteRequest["params"],
    signal?: AbortSignal,
    invocation?: McpInvocationContext,
  ) => Promise<CompleteResult>;
  readonly subscribeResource: (
    serverName: string,
    uri: string,
    signal?: AbortSignal,
    invocation?: McpInvocationContext,
  ) => Promise<void>;
  readonly unsubscribeResource: (
    serverName: string,
    uri: string,
    signal?: AbortSignal,
    invocation?: McpInvocationContext,
  ) => Promise<void>;
  readonly setLoggingLevel: (
    serverName: string,
    level: LoggingLevel,
    signal?: AbortSignal,
    invocation?: McpInvocationContext,
  ) => Promise<void>;
  readonly listTasks: (
    serverName: string,
    cursor?: string,
    signal?: AbortSignal,
    invocation?: McpInvocationContext,
  ) => Promise<ListTasksResult>;
  readonly getTask: (
    serverName: string,
    taskId: string,
    signal?: AbortSignal,
    invocation?: McpInvocationContext,
  ) => Promise<GetTaskResult>;
  readonly getTaskResult: (
    serverName: string,
    taskId: string,
    signal?: AbortSignal,
    invocation?: McpInvocationContext,
  ) => Promise<CallToolResult>;
  readonly cancelTask: (
    serverName: string,
    taskId: string,
    signal?: AbortSignal,
    invocation?: McpInvocationContext,
  ) => Promise<CancelTaskResult>;
}

export function createMcpHostManager(input: CreateMcpHostManagerInput): McpHostManager {
  let activeConfig = input.config;
  let closing = false;
  const connections = new Map<string, Connection>();
  const connectionGenerations = new Map<string, number>();
  const connectionAttempts = new Set<ConnectionAttempt>();
  const inFlightConnects = new Set<Promise<void>>();
  const pendingOAuthTransports = new Map<string, PendingOAuthTransport>();
  const resourceSubscriptions = new Map<string, ResourceSubscriptions>();
  const activeAuthentications = new Set<ActiveAuthentication>();
  const latestAuthenticationByServer = new Map<string, ActiveAuthentication>();
  const credentialKey = (server: ScopedMcpServer): string =>
    server.scope === "global"
      ? `global:${server.name}`
      : `project:${sha256(input.projectDirectory)}:${server.name}`;
  const authIdentityDigest = (config: McpRemoteServerConfig): string =>
    sha256(
      canonicalJson({
        url: config.url,
        oauth: config.oauth,
        redirectUrl:
          (typeof config.oauth === "object" ? config.oauth.redirectUri : undefined) ??
          input.oauthRedirectUrl ??
          null,
      }),
    );
  const connectionIdentity = (server: ScopedMcpServer): string =>
    sha256(
      canonicalJson({
        scope: server.scope,
        projectDirectory: server.scope === "project" ? input.projectDirectory : null,
        name: server.name,
        config: server.config,
      }),
    );

  const emit = async (serverName: string, type: McpHostEvent["type"], payload: JsonValue): Promise<void> => {
    const invocation = connections.get(serverName)?.activeInvocation;
    await input.handlers.onEvent?.({
      serverName,
      type,
      payload,
      ...(invocation ? { invocation } : {}),
    });
  };

  const closePendingOAuthTransport = async (name: string, owner?: ActiveAuthentication): Promise<void> => {
    const pending = pendingOAuthTransports.get(name);
    if (!pending || (owner && pending.owner !== owner)) return;
    pendingOAuthTransports.delete(name);
    await pending.transport.close().catch(() => undefined);
  };

  const replacePendingOAuthTransport = async (name: string, transport: RemoteTransport): Promise<void> => {
    const previous = pendingOAuthTransports.get(name);
    if (previous?.transport === transport) return;
    pendingOAuthTransports.set(name, {
      transport,
      owner: latestAuthenticationByServer.get(name),
    });
    await previous?.transport.close().catch(() => undefined);
  };

  const withInvocation = async <Result>(
    connection: Connection,
    invocation: McpInvocationContext | undefined,
    signal: AbortSignal | undefined,
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = connection.requestQueue;
    connection.requestQueue = previous.then(() => gate);
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        previous,
        signal
          ? new Promise<never>((_resolve, reject) => {
              abort = () => reject(signal.reason ?? new Error("MCP request cancelled"));
              if (signal.aborted) abort();
              else signal.addEventListener("abort", abort, { once: true });
            })
          : new Promise<never>(() => undefined),
      ]);
    } catch (error) {
      release?.();
      throw error;
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
    }
    connection.activeInvocation = invocation;
    try {
      return await operation();
    } finally {
      connection.activeInvocation = undefined;
      release?.();
    }
  };

  const requireConnection = (name: string): Connection => {
    const connection = connections.get(name);
    if (!connection?.client || connection.status !== "connected") {
      throw new Error(`MCP server ${JSON.stringify(name)} is not connected`);
    }
    return connection;
  };

  const requireClient = (name: string): Readonly<{ connection: Connection; client: Client }> => {
    const connection = requireConnection(name);
    const client = connection.client;
    if (!client) throw new Error(`MCP server ${JSON.stringify(name)} is not connected`);
    return { connection, client };
  };

  const addDiagnostic = (connection: Connection, diagnostic: McpDiagnostic): void => {
    connection.diagnostics.push(
      Object.freeze({
        ...diagnostic,
        message: diagnostic.message.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH),
      }),
    );
    if (connection.diagnostics.length > MAX_DIAGNOSTICS) {
      connection.diagnostics.splice(0, connection.diagnostics.length - MAX_DIAGNOSTICS);
    }
  };

  const admissibleTools = (connection: Connection, tools: readonly Tool[]): readonly Tool[] => {
    const admitted: Tool[] = [];
    const names = new Set<string>();
    for (const tool of tools) {
      if (names.has(tool.name)) {
        addDiagnostic(connection, {
          code: "duplicate_tool_name",
          toolName: tool.name,
          message: `Ignored duplicate MCP tool name ${JSON.stringify(tool.name)}.`,
        });
        continue;
      }
      try {
        toolSchemaValidator.getValidator(structuredClone(tool.inputSchema) as never);
        if (tool.outputSchema) toolSchemaValidator.getValidator(structuredClone(tool.outputSchema) as never);
        names.add(tool.name);
        admitted.push(tool);
      } catch (error) {
        addDiagnostic(connection, {
          code: "invalid_tool_schema",
          toolName: tool.name,
          message: `Ignored MCP tool ${JSON.stringify(tool.name)} because its JSON Schema is invalid: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return Object.freeze(admitted);
  };

  const refreshCatalog = async (
    connection: Connection,
    signal?: AbortSignal,
    canCommit: () => boolean = () => true,
  ): Promise<boolean> => {
    const client: Client | undefined = connection.client;
    if (!client) return false;
    const timeout = connection.server.config.timeout ?? DEFAULT_TIMEOUT;
    const capabilities = client.getServerCapabilities();
    const options = requestOptions(signal, timeout);
    const [tools, prompts, resources, resourceTemplates] = await Promise.all([
      capabilities?.tools
        ? paginated(async (cursor) => {
            const page = await client.listTools(cursor ? { cursor } : undefined, options);
            return { items: page.tools, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
          })
        : [],
      capabilities?.prompts
        ? paginated(async (cursor) => {
            const page = await client.listPrompts(cursor ? { cursor } : undefined, options);
            return { items: page.prompts, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
          })
        : [],
      capabilities?.resources
        ? paginated(async (cursor) => {
            const page = await client.listResources(cursor ? { cursor } : undefined, options);
            return { items: page.resources, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
          })
        : [],
      capabilities?.resources
        ? paginated(async (cursor) => {
            const page = await client.listResourceTemplates(cursor ? { cursor } : undefined, options);
            return {
              items: page.resourceTemplates,
              ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            };
          })
        : [],
    ]);
    if (signal?.aborted) throw signal.reason ?? new Error("MCP discovery refresh was cancelled");
    if (!canCommit()) return false;
    const admittedTools = admissibleTools(connection, tools);
    connection.discoveryCatalog = canonicalDiscoveryCatalog({
      tools,
      prompts,
      resources,
      resourceTemplates,
    });
    connection.catalog = Object.freeze({
      tools: admittedTools,
      prompts,
      resources,
      resourceTemplates,
    });
    connection.dirty = false;
    await emit(connection.server.name, "catalog_changed", {
      tools: admittedTools.length,
      prompts: prompts.length,
      resources: resources.length,
      resourceTemplates: resourceTemplates.length,
    });
    return true;
  };

  const restoreResourceSubscriptions = async (connection: Connection): Promise<void> => {
    const client = connection.client;
    if (!client) return;
    const subscriptions = resourceSubscriptions.get(connection.server.name);
    if (!subscriptions || subscriptions.uris.size === 0) return;
    const currentIdentityDigest = connectionIdentityDigest(connection);
    if (subscriptions.serverIdentityDigest !== currentIdentityDigest) {
      resourceSubscriptions.delete(connection.server.name);
      addDiagnostic(connection, {
        code: "subscriptions_dropped",
        message: "Resource subscriptions were not restored because the server identity changed.",
      });
      return;
    }
    for (const uri of subscriptions.uris) {
      await client.subscribeResource({ uri }, requestOptions(undefined, connection.server.config.timeout));
    }
  };

  const scheduleReconnect = (connection: Connection): void => {
    if (
      closing ||
      connection.intentionalClose ||
      connection.reconnectTimer ||
      connection.server.config.enabled === false ||
      connection.status === "auth_required"
    )
      return;
    const delay = AUTO_RECONNECT_DELAYS[connection.reconnectAttempts];
    if (delay === undefined) return;
    connection.reconnectAttempts += 1;
    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectTimer = undefined;
      if (closing || connections.get(connection.server.name) !== connection) return;
      void connect(connection.server).catch(async (error: unknown) => {
        if (connections.get(connection.server.name) !== connection) return;
        connection.status = "failed";
        connection.lastError = error instanceof Error ? error.message : String(error);
        await emit(connection.server.name, "connection", {
          status: "failed",
          error: connection.lastError,
        }).catch(() => undefined);
        scheduleReconnect(connection);
      });
    }, delay);
    connection.reconnectTimer.unref();
  };

  const transitionAfterUnexpectedClose = (connection: Connection, client: Client, error?: Error): void => {
    if (
      closing ||
      connection.intentionalClose ||
      connection.client !== client ||
      connections.get(connection.server.name) !== connection
    )
      return;
    connection.client = undefined;
    connection.transport = undefined;
    connection.taskStore?.cleanup();
    connection.taskStore = undefined;
    connection.taskInvocations.clear();
    connection.catalog = EMPTY_CATALOG;
    connection.discoveryCatalog = canonicalDiscoveryCatalog(EMPTY_CATALOG);
    connection.dirty = false;
    connection.status = "failed";
    connection.lastError = error?.message ?? "MCP connection closed unexpectedly";
    void emit(connection.server.name, "catalog_changed", {
      tools: 0,
      prompts: 0,
      resources: 0,
      resourceTemplates: 0,
      disconnected: true,
    });
    void emit(connection.server.name, "connection", {
      status: "failed",
      error: connection.lastError,
    });
    scheduleReconnect(connection);
  };

  const createClient = (
    connection: Connection,
    generation: number,
  ): Readonly<{ client: Client; taskStore: InMemoryTaskStore }> => {
    const taskStore = new InMemoryTaskStore();
    const markDirty = (): void => {
      if (
        connectionGenerations.get(connection.server.name) !== generation ||
        connections.get(connection.server.name) !== connection ||
        connection.client !== client
      )
        return;
      connection.dirty = true;
      void emit(connection.server.name, "catalog_changed", { dirty: true });
    };
    const client = new Client(
      { name: "noesis", version: input.clientVersion ?? "0.1.0" },
      {
        taskStore,
        taskMessageQueue: new InMemoryTaskMessageQueue(),
        maxTaskQueueSize: 1_000,
        capabilities: {
          roots: { listChanged: true },
          sampling: { context: {}, tools: {} },
          elicitation: { form: { applyDefaults: true }, url: {} },
          tasks: {
            list: {},
            cancel: {},
            requests: { sampling: { createMessage: {} }, elicitation: { create: {} } },
          },
        },
        listChanged: {
          tools: { autoRefresh: false, onChanged: () => markDirty() },
          prompts: { autoRefresh: false, onChanged: () => markDirty() },
          resources: { autoRefresh: false, onChanged: () => markDirty() },
        },
      },
    );
    let lastTransportError: Error | undefined;
    client.onerror = (error) => {
      if (
        connectionGenerations.get(connection.server.name) !== generation ||
        connections.get(connection.server.name) !== connection ||
        connection.client !== client
      )
        return;
      lastTransportError = error;
      connection.lastError = error.message;
      void emit(connection.server.name, "connection", {
        status: connection.status,
        error: error.message,
      });
    };
    client.onclose = () => {
      transitionAfterUnexpectedClose(connection, client, lastTransportError);
    };
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(input.projectDirectory).href, name: input.projectDirectory }],
    }));
    client.setRequestHandler(CreateMessageRequestSchema, async (request, extra) => {
      if (
        connectionGenerations.get(connection.server.name) !== generation ||
        connections.get(connection.server.name) !== connection ||
        connection.client !== client
      )
        throw new Error(`MCP server ${connection.server.name} connection is no longer active`);
      // Task control deliberately bypasses the foreground request queue so cancel/result polling
      // cannot deadlock behind a long-running task. Reverse requests bind only to the originating
      // task invocation; falling back to an unrelated foreground call would widen authority.
      const invocation = extra.taskId
        ? connection.taskInvocations.get(extra.taskId)
        : connection.activeInvocation;
      if (extra.taskId && !invocation) {
        throw new Error(`MCP task ${extra.taskId} cannot sample without an originating Noesis invocation`);
      }
      const result = await input.handlers.sample(connection.server.name, request, extra.signal, invocation);
      if (request.params.task && extra.taskStore) {
        const task = await extra.taskStore.createTask(
          extra.taskRequestedTtl === undefined ? {} : { ttl: extra.taskRequestedTtl },
        );
        await extra.taskStore.storeTaskResult(task.taskId, "completed", result);
        return { task };
      }
      return result;
    });
    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      if (
        connectionGenerations.get(connection.server.name) !== generation ||
        connections.get(connection.server.name) !== connection ||
        connection.client !== client
      )
        throw new Error(`MCP server ${connection.server.name} connection is no longer active`);
      const invocation = extra.taskId
        ? connection.taskInvocations.get(extra.taskId)
        : connection.activeInvocation;
      if (extra.taskId && !invocation) {
        throw new Error(`MCP task ${extra.taskId} cannot elicit without an originating Noesis invocation`);
      }
      const result = await input.handlers.elicit(connection.server.name, request, extra.signal, invocation);
      if (request.params.task && extra.taskStore) {
        const task = await extra.taskStore.createTask(
          extra.taskRequestedTtl === undefined ? {} : { ttl: extra.taskRequestedTtl },
        );
        await extra.taskStore.storeTaskResult(task.taskId, "completed", result);
        return { task };
      }
      return result;
    });
    client.setNotificationHandler(LoggingMessageNotificationSchema, async (notification) => {
      await emit(connection.server.name, "log", notification.params as JsonValue);
    });
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
      await emit(connection.server.name, "resource_updated", notification.params as JsonValue);
    });
    client.setNotificationHandler(ElicitationCompleteNotificationSchema, async (notification) => {
      await emit(connection.server.name, "elicitation_complete", notification.params as JsonValue);
    });
    return { client, taskStore };
  };

  const remoteTransports = (
    server: ScopedMcpServer,
    config: McpRemoteServerConfig,
  ): readonly RemoteTransport[] => {
    const authentication = latestAuthenticationByServer.get(server.name);
    const oauth = config.oauth === false ? undefined : config.oauth;
    const oauthConfig = typeof oauth === "object" ? oauth : undefined;
    const redirectUrl =
      oauthConfig?.redirectUri ??
      input.oauthRedirectUrl ??
      `http://127.0.0.1:${String(oauthConfig?.callbackPort ?? 1456)}/oauth/callback`;
    const authProvider =
      oauth === undefined && config.oauth === false
        ? undefined
        : createMcpOAuthProvider({
            key: credentialKey(server),
            serverName: server.name,
            serverUrl: config.url,
            authIdentityDigest: authIdentityDigest(config),
            redirectUrl,
            ...(oauthConfig ? { config: oauthConfig } : {}),
            credentialStore: input.credentials,
            onRedirect: async (redirect) => {
              if (authentication && latestAuthenticationByServer.get(server.name) === authentication) {
                await input.handlers.onOAuthRedirect(redirect);
              }
            },
            environment: input.environment ?? process.env,
          });
    const url = new URL(config.url);
    const runtimeEnvironment = input.environment ?? process.env;
    const headers = config.headers
      ? Object.fromEntries(
          Object.entries(config.headers).map(([header, sourceVariable]) => {
            const value = runtimeEnvironment[sourceVariable];
            if (value === undefined)
              throw new Error(
                `MCP server ${server.name} requires environment variable ${sourceVariable} for header ${header}`,
              );
            return [header, value];
          }),
        )
      : undefined;
    const requestInit = headers ? { headers } : undefined;
    const transportOptions = {
      ...(authProvider ? { authProvider } : {}),
      ...(requestInit ? { requestInit } : {}),
    };
    const streamable = new StreamableHTTPClientTransport(url, transportOptions);
    const sse = new SSEClientTransport(url, transportOptions);
    if (config.transport === "streamable_http") return [streamable];
    if (config.transport === "sse") return [sse];
    return [streamable, sse];
  };

  async function connect(server: ScopedMcpServer): Promise<void> {
    if (closing) return;
    const generation = (connectionGenerations.get(server.name) ?? 0) + 1;
    connectionGenerations.set(server.name, generation);
    const operation = performConnect(server, generation).catch(async (error: unknown) => {
      if (closing || connectionGenerations.get(server.name) !== generation) return;
      const connection = connections.get(server.name);
      if (!connection || connection.intentionalClose) return;
      connection.status = "failed";
      connection.lastError = error instanceof Error ? error.message : String(error);
      await emit(server.name, "connection", {
        status: "failed",
        error: connection.lastError,
      }).catch(() => undefined);
      if (connectionLifecycleFailureRetryable(error) !== false) {
        scheduleReconnect(connection);
      }
    });
    inFlightConnects.add(operation);
    try {
      await operation;
    } finally {
      inFlightConnects.delete(operation);
    }
  }

  const closeConnectionAttempt = async (attempt: ConnectionAttempt): Promise<void> => {
    connectionAttempts.delete(attempt);
    if (attempt.connection.client === attempt.client) {
      attempt.connection.client = undefined;
      attempt.connection.transport = undefined;
    }
    if (attempt.connection.taskStore === attempt.taskStore) {
      attempt.connection.taskStore = undefined;
    }
    await attempt.client.close().catch(() => undefined);
    await attempt.transport.close().catch(() => undefined);
    attempt.taskStore.cleanup();
  };

  async function performConnect(server: ScopedMcpServer, generation: number): Promise<void> {
    if (closing) return;
    const connection: Connection = connections.get(server.name) ?? {
      server,
      status: "connecting",
      lastError: undefined,
      client: undefined,
      transport: undefined,
      catalog: EMPTY_CATALOG,
      discoveryCatalog: canonicalDiscoveryCatalog(EMPTY_CATALOG),
      dirty: false,
      taskStore: undefined,
      activeInvocation: undefined,
      taskInvocations: new Map(),
      requestQueue: Promise.resolve(),
      reconnectAttempts: 0,
      reconnectTimer: undefined,
      intentionalClose: false,
      diagnostics: [],
    };
    if (closing) return;
    connections.set(server.name, connection);
    const isCurrent = (): boolean =>
      !closing &&
      !connection.intentionalClose &&
      connectionGenerations.get(server.name) === generation &&
      connections.get(connection.server.name) === connection;
    if (!isCurrent()) return;
    if (server.config.enabled === false) {
      connection.status = "disabled";
      return;
    }
    connection.intentionalClose = false;
    connection.status = "connecting";
    connection.lastError = undefined;
    const runtimeEnvironment = input.environment ?? process.env;
    const configuredEnvironment =
      server.config.type === "local" && server.config.environment
        ? Object.fromEntries(
            Object.entries(server.config.environment).map(([childVariable, sourceVariable]) => {
              const value = runtimeEnvironment[sourceVariable];
              if (value === undefined)
                throw new Error(
                  `MCP server ${server.name} requires environment variable ${sourceVariable} for ${childVariable}`,
                );
              return [childVariable, value];
            }),
          )
        : undefined;
    const definedEnvironment = Object.fromEntries(
      Object.entries({ ...getDefaultEnvironment(), ...configuredEnvironment }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const transports: readonly (Transport | RemoteTransport)[] =
      server.config.type === "local"
        ? [
            new StdioClientTransport({
              command: server.config.command,
              args: server.config.args ? [...server.config.args] : [],
              cwd: server.config.cwd ?? input.projectDirectory,
              env: definedEnvironment,
              stderr: "pipe",
            }),
          ]
        : remoteTransports(server, server.config);
    for (const transport of transports) {
      if (transport instanceof StdioClientTransport)
        transport.stderr?.on("data", (chunk: Buffer | string) => {
          const message = String(chunk).trim();
          if (message) void emit(server.name, "log", { level: "debug", data: message });
        });
    }
    let lastError: unknown;
    for (const transport of transports) {
      if (!isCurrent()) return;
      const { client, taskStore } = createClient(connection, generation);
      const attempt: ConnectionAttempt = { connection, client, transport, taskStore };
      connectionAttempts.add(attempt);
      try {
        const connectTransport = async (): Promise<void> =>
          await client.connect(transport as Transport, {
            timeout: server.config.timeout ?? DEFAULT_TIMEOUT,
          });
        if (input.handlers.connect) {
          await input.handlers.connect({
            connectionIdentity: connectionIdentity(server),
            serverName: server.name,
            scope: server.scope,
            transport:
              transport instanceof StdioClientTransport
                ? "stdio"
                : transport instanceof SSEClientTransport
                  ? "sse"
                  : "streamable_http",
            execute: connectTransport,
          });
        } else await connectTransport();
        if (!isCurrent()) {
          await closeConnectionAttempt(attempt);
          return;
        }
        const previousClient = connection.client;
        const previousTransport = connection.transport;
        const previousTaskStore = connection.taskStore;
        connection.client = client;
        connection.transport = transport;
        connection.taskStore = taskStore;
        previousTaskStore?.cleanup();
        if (previousClient) connection.taskInvocations.clear();
        await previousClient?.close().catch(() => undefined);
        await previousTransport?.close().catch(() => undefined);
        if (!isCurrent() || connection.client !== client) {
          await closeConnectionAttempt(attempt);
          return;
        }
        connection.status = "connected";
        const refreshed = await refreshCatalog(connection, undefined, isCurrent);
        if (!refreshed || !isCurrent() || connection.client !== client) {
          await closeConnectionAttempt(attempt);
          return;
        }
        await restoreResourceSubscriptions(connection);
        if (!isCurrent() || connection.client !== client) {
          await closeConnectionAttempt(attempt);
          return;
        }
        connection.reconnectAttempts = 0;
        if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
        connection.reconnectTimer = undefined;
        await emit(server.name, "connection", { status: "connected" });
        connectionAttempts.delete(attempt);
        return;
      } catch (error) {
        lastError = error;
        if (!isCurrent()) {
          await closeConnectionAttempt(attempt);
          return;
        }
        if (connection.client === client) {
          connection.client = undefined;
          connection.transport = undefined;
        }
        if (connection.taskStore === taskStore) connection.taskStore = undefined;
        if (error instanceof UnauthorizedError && server.config.type === "remote") {
          connectionAttempts.delete(attempt);
          await replacePendingOAuthTransport(server.name, transport as RemoteTransport);
          if (!isCurrent()) {
            if (pendingOAuthTransports.get(server.name)?.transport === transport) {
              pendingOAuthTransports.delete(server.name);
              await transport.close().catch(() => undefined);
            }
            return;
          }
          connection.status = "auth_required";
          connection.lastError = error.message;
          await emit(server.name, "connection", { status: "auth_required" });
          return;
        }
        await closeConnectionAttempt(attempt);
        if (connectionLifecycleFailureRetryable(error) === false) break;
      }
    }
    if (!isCurrent()) return;
    connection.status = "failed";
    connection.lastError =
      lastError instanceof Error ? lastError.message : String(lastError ?? "connection failed");
    await emit(server.name, "connection", {
      status: "failed",
      error: connection.lastError,
    }).catch(() => undefined);
    if (connectionLifecycleFailureRetryable(lastError) !== false) {
      scheduleReconnect(connection);
    }
  }

  const disconnect = async (name: string): Promise<void> => {
    const connection = connections.get(name);
    await closePendingOAuthTransport(name);
    if (!connection) return;
    connection.intentionalClose = true;
    connectionGenerations.set(name, (connectionGenerations.get(name) ?? 0) + 1);
    if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
    connection.reconnectTimer = undefined;
    await Promise.all(
      [...connectionAttempts]
        .filter((attempt) => attempt.connection === connection)
        .map(closeConnectionAttempt),
    );
    await connection.transport?.close().catch(() => undefined);
    connection.client = undefined;
    connection.transport = undefined;
    connection.taskStore?.cleanup();
    connection.taskStore = undefined;
    connection.taskInvocations.clear();
  };

  const start = async (): Promise<void> => {
    await Promise.all(
      [...activeConfig.servers.values()].map(async (server) => {
        await connect(server).catch(async (error: unknown) => {
          const connection = connections.get(server.name);
          if (!connection) return;
          connection.status = "failed";
          connection.lastError = error instanceof Error ? error.message : String(error);
          await emit(server.name, "connection", { status: "failed", error: connection.lastError });
          scheduleReconnect(connection);
        });
      }),
    );
  };

  const close = async (): Promise<void> => {
    closing = true;
    const authentications = [...activeAuthentications];
    for (const authentication of authentications) {
      authentication.controller.abort(new Error("MCP host closed during OAuth authentication"));
    }
    await Promise.all(authentications.map(async (authentication) => await authentication.settled));
    await Promise.all([...connections.keys()].map(disconnect));
    await Promise.all([...connectionAttempts].map(closeConnectionAttempt));
    await Promise.allSettled(inFlightConnects);
    await Promise.all(
      [...pendingOAuthTransports.keys()].map(async (name) => await closePendingOAuthTransport(name)),
    );
    connections.clear();
    resourceSubscriptions.clear();
  };

  const reconnect = async (name: string): Promise<void> => {
    const server = activeConfig.servers.get(name);
    if (!server) throw new Error(`MCP server ${JSON.stringify(name)} is not configured`);
    await disconnect(name);
    connections.delete(name);
    await connect(server);
    if (closing) return;
    const connection = connections.get(name);
    if (connection?.status === "failed") {
      throw new Error(
        `MCP server ${JSON.stringify(name)} failed to connect: ${connection.lastError ?? "unknown error"}`,
      );
    }
  };

  const reload = async (config: LoadedMcpConfig): Promise<void> => {
    const oldNames = new Set(activeConfig.servers.keys());
    activeConfig = config;
    for (const name of oldNames) {
      if (!config.servers.has(name)) {
        await disconnect(name);
        connections.delete(name);
        resourceSubscriptions.delete(name);
      }
    }
    await Promise.all(
      [...config.servers.keys()].map(async (name) => {
        await reconnect(name).catch(async (error: unknown) => {
          const connection = connections.get(name);
          if (!connection) return;
          connection.status = "failed";
          connection.lastError = error instanceof Error ? error.message : String(error);
          await emit(name, "connection", { status: "failed", error: connection.lastError });
          scheduleReconnect(connection);
        });
      }),
    );
  };

  const refreshDiscovery = async (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) throw signal.reason ?? new Error("MCP discovery refresh was cancelled");
    await Promise.all(
      [...connections.values()]
        .filter((connection) => connection.status === "connected" && connection.dirty)
        .map(async (connection) => {
          const generation = connectionGenerations.get(connection.server.name);
          const canCommit = (): boolean =>
            !closing &&
            generation !== undefined &&
            connectionGenerations.get(connection.server.name) === generation &&
            connections.get(connection.server.name) === connection &&
            connection.status === "connected";
          await refreshCatalog(connection, signal, canCommit).catch(async (error: unknown) => {
            if (signal?.aborted) throw signal.reason ?? error;
            if (!canCommit()) return;
            connection.lastError = error instanceof Error ? error.message : String(error);
            connection.dirty = true;
            await emit(connection.server.name, "catalog_changed", {
              dirty: true,
              error: connection.lastError,
            });
          });
        }),
    );
  };

  const exchangeAuthenticationCodeFor = async (
    name: string,
    authorizationCode: string,
    owner?: ActiveAuthentication,
  ): Promise<void> => {
    const pending = pendingOAuthTransports.get(name);
    if (!pending || (owner && pending.owner !== owner)) {
      throw new Error(`MCP server ${JSON.stringify(name)} has no pending OAuth flow`);
    }
    try {
      await pending.transport.finishAuth(authorizationCode);
    } finally {
      await closePendingOAuthTransport(name, owner);
    }
    if (owner && latestAuthenticationByServer.get(name) !== owner) {
      throw new Error(`MCP OAuth authentication for ${name} was replaced`);
    }
    owner?.controller.signal.throwIfAborted();
  };
  const finishAuthenticationFor = async (
    name: string,
    authorizationCode: string,
    owner?: ActiveAuthentication,
  ): Promise<void> => {
    await exchangeAuthenticationCodeFor(name, authorizationCode, owner);
    await reconnect(name);
  };
  const finishAuthentication = async (name: string, authorizationCode: string): Promise<void> =>
    await finishAuthenticationFor(name, authorizationCode);

  const authenticate: McpHostManager["authenticate"] = async (name, options) => {
    if (closing) throw new Error("MCP host is closed");
    if (options?.signal?.aborted) {
      throw options.signal.reason ?? new Error("MCP OAuth was cancelled");
    }
    const server = activeConfig.servers.get(name);
    if (!server || server.config.type !== "remote") {
      throw new Error(`MCP server ${JSON.stringify(name)} is not a configured remote server`);
    }
    const oauth = typeof server.config.oauth === "object" ? server.config.oauth : undefined;
    const redirectUrl = new URL(
      oauth?.redirectUri ??
        input.oauthRedirectUrl ??
        `http://127.0.0.1:${String(oauth?.callbackPort ?? 1456)}/oauth/callback`,
    );
    if (
      redirectUrl.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(redirectUrl.hostname)
    ) {
      throw new Error("Automatic MCP OAuth callbacks require a loopback http redirect URI");
    }
    const callbackHost = redirectUrl.hostname === "[::1]" ? "::1" : redirectUrl.hostname;
    const port = redirectUrl.port ? Number(redirectUrl.port) : 80;
    const timeout = options?.timeout ?? 120_000;
    const authenticationController = new AbortController();
    let settleAuthentication: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      settleAuthentication = resolve;
    });
    const authentication = Object.freeze({
      controller: authenticationController,
      settled,
      settle: (): void => settleAuthentication?.(),
    });
    const cancelAuthentication = (): void => {
      authenticationController.abort(options?.signal?.reason ?? new Error("MCP OAuth was cancelled"));
    };
    options?.signal?.addEventListener("abort", cancelAuthentication, { once: true });
    latestAuthenticationByServer
      .get(name)
      ?.controller.abort(new Error(`MCP OAuth authentication for ${name} was replaced`));
    activeAuthentications.add(authentication);
    latestAuthenticationByServer.set(name, authentication);
    try {
      let callbackTimer: NodeJS.Timeout | undefined;
      let abortCallback: (() => void) | undefined;
      let callbackAuthorization:
        | Readonly<{
            code: string;
            complete: (succeeded: boolean) => void;
          }>
        | undefined;
      const listener = createServer();
      const callback = new Promise<
        Readonly<{
          code: string;
          complete: (succeeded: boolean) => void;
        }>
      >((resolve, reject) => {
        listener.on("request", (request, response) => {
          const requestUrl = new URL(request.url ?? "/", redirectUrl.origin);
          if (requestUrl.pathname !== redirectUrl.pathname) {
            response.writeHead(404).end("Not found");
            return;
          }
          const error = requestUrl.searchParams.get("error");
          const code = requestUrl.searchParams.get("code");
          const state = requestUrl.searchParams.get("state");
          let acceptedState = false;
          void input.credentials
            .update(credentialKey(server), (credential) => {
              if (!state || state !== credential?.state)
                return (
                  credential ?? {
                    serverUrl: server.config.type === "remote" ? server.config.url : "http://invalid.local",
                  }
                );
              acceptedState = true;
              const { state: _consumedState, ...consumedCredential } = credential;
              return consumedCredential;
            })
            .then(() => {
              if (!acceptedState) {
                response
                  .writeHead(400)
                  .end("Authentication state did not match. Try the current OAuth flow.");
                return;
              }
              if (error) throw new Error(`MCP OAuth failed: ${error}`);
              if (!code) throw new Error("MCP OAuth callback did not include an authorization code");
              let completed = false;
              callbackAuthorization = {
                code,
                complete: (succeeded) => {
                  if (completed) return;
                  completed = true;
                  response.writeHead(succeeded ? 200 : 400, {
                    "content-type": "text/html; charset=utf-8",
                  });
                  response.end(
                    succeeded
                      ? "<!doctype html><title>Noesis MCP connected</title><h1>Authentication successful</h1><p>You can close this window and return to Noesis.</p>"
                      : "<!doctype html><title>Noesis MCP authentication failed</title><h1>Authentication failed</h1><p>Return to Noesis for details and try again.</p>",
                  );
                  listener.close();
                },
              };
              resolve(callbackAuthorization);
            })
            .catch((cause: unknown) => {
              response.writeHead(400).end("Authentication failed. Return to Noesis for details.");
              reject(cause);
              listener.close();
            });
        });
        listener.on("error", reject);
        abortCallback = (): void => {
          callbackAuthorization?.complete(false);
          listener.close();
          reject(authenticationController.signal.reason ?? new Error("MCP OAuth was cancelled"));
        };
        if (authenticationController.signal.aborted) {
          abortCallback();
          return;
        }
        authenticationController.signal.addEventListener("abort", abortCallback, { once: true });
        callbackTimer = setTimeout(() => {
          listener.close();
          reject(new Error(`MCP OAuth callback timed out after ${String(timeout)}ms`));
        }, timeout).unref();
      });
      // The callback can outlive the listen attempt or become unnecessary when reconnect succeeds
      // without OAuth. Observe its rejection unconditionally while preserving rejection for awaits.
      void callback.catch(() => undefined);
      if (authenticationController.signal.aborted) await callback;
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          listener.removeListener("listening", onListening);
          listener.removeListener("error", onError);
          authenticationController.signal.removeEventListener("abort", onAbort);
        };
        const onListening = (): void => {
          cleanup();
          resolve();
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        const onAbort = (): void => {
          cleanup();
          listener.close();
          reject(authenticationController.signal.reason ?? new Error("MCP OAuth was cancelled"));
        };
        listener.once("listening", onListening);
        listener.once("error", onError);
        if (authenticationController.signal.aborted) {
          onAbort();
          return;
        }
        authenticationController.signal.addEventListener("abort", onAbort, { once: true });
        listener.listen(port, callbackHost);
      });
      try {
        await reconnect(name);
        const status = connections.get(name)?.status;
        if (status === "connected") {
          callbackAuthorization?.complete(true);
          return;
        }
        if (status !== "auth_required")
          throw new Error(`MCP server ${name} could not start OAuth authentication (${status ?? "missing"})`);
        const authorization = await callback;
        try {
          authenticationController.signal.throwIfAborted();
          await exchangeAuthenticationCodeFor(name, authorization.code, authentication);
          if (callbackTimer) {
            clearTimeout(callbackTimer);
            callbackTimer = undefined;
          }
          if (abortCallback) {
            authenticationController.signal.removeEventListener("abort", abortCallback);
            abortCallback = undefined;
          }
          await reconnect(name);
          if (
            closing ||
            latestAuthenticationByServer.get(name) !== authentication ||
            connections.get(name)?.status !== "connected"
          ) {
            throw new Error(`MCP server ${name} did not complete OAuth reconnect`);
          }
          authorization.complete(true);
        } catch (error) {
          authorization.complete(false);
          throw error;
        }
      } finally {
        if (callbackTimer) clearTimeout(callbackTimer);
        if (abortCallback) authenticationController.signal.removeEventListener("abort", abortCallback);
        listener.close();
      }
    } finally {
      options?.signal?.removeEventListener("abort", cancelAuthentication);
      try {
        if (latestAuthenticationByServer.get(name) === authentication) {
          latestAuthenticationByServer.delete(name);
        }
        await closePendingOAuthTransport(name, authentication);
      } finally {
        activeAuthentications.delete(authentication);
        authentication.settle();
      }
    }
  };

  const logout = async (name: string): Promise<void> => {
    const server = activeConfig.servers.get(name);
    if (!server) throw new Error(`MCP server ${JSON.stringify(name)} is not configured`);
    await closePendingOAuthTransport(name);
    await input.credentials.delete(credentialKey(server));
    await reconnect(name);
  };

  const canonicalToolNames = (): ReadonlyMap<string, Readonly<{ serverName: string; toolName: string }>> => {
    const names = new Map<string, Readonly<{ serverName: string; toolName: string }>>();
    const entries = [...connections.values()]
      .filter((connection) => connection.status === "connected")
      .flatMap((connection) => connection.catalog.tools.map((definition) => ({ connection, definition })))
      .sort((left, right) =>
        `${left.connection.server.name}\u0000${left.definition.name}`.localeCompare(
          `${right.connection.server.name}\u0000${right.definition.name}`,
        ),
      );
    const rawNames = entries.map(({ connection, definition }) => {
      const segment =
        definition.name
          .toLowerCase()
          .replaceAll(/[^a-z0-9_-]+/gu, "_")
          .replaceAll(/^_+|_+$/gu, "") || "tool";
      const normalizedChanged = segment !== definition.name;
      const nameDigest = sha256(definition.name);
      const prefix = `mcp.${connection.server.name}.`;
      const truncated = prefix.length + segment.length > 128;
      const rawReadable = segment.slice(0, Math.max(1, 128 - prefix.length));
      return {
        connection,
        definition,
        segment,
        prefix,
        nameDigest,
        normalizedChanged,
        truncated,
        rawName: `${prefix}${rawReadable}`,
      };
    });
    const collisions = new Map<string, number>();
    for (const entry of rawNames) collisions.set(entry.rawName, (collisions.get(entry.rawName) ?? 0) + 1);
    for (const entry of rawNames) {
      const needsSuffix =
        entry.normalizedChanged || entry.truncated || (collisions.get(entry.rawName) ?? 0) > 1;
      let digestLength = needsSuffix ? 12 : 0;
      const maximumDigestLength = Math.min(entry.nameDigest.length, 128 - entry.prefix.length - 2);
      let canonicalName: string;
      while (true) {
        const suffix = digestLength > 0 ? `_${entry.nameDigest.slice(0, digestLength)}` : "";
        const readableLimit = 128 - entry.prefix.length - suffix.length;
        const readable = entry.segment.slice(0, Math.max(1, readableLimit));
        canonicalName = `${entry.prefix}${readable}${suffix}`;
        if (!names.has(canonicalName)) break;
        if (digestLength >= maximumDigestLength)
          throw new Error(`MCP tools collide at canonical name ${JSON.stringify(canonicalName)}`);
        digestLength = Math.min(maximumDigestLength, Math.max(12, digestLength + 8));
      }
      names.set(canonicalName, {
        serverName: entry.connection.server.name,
        toolName: entry.definition.name,
      });
    }
    return names;
  };

  const listTools = (serverName?: string) => {
    const canonicalNames = canonicalToolNames();
    return Object.freeze(
      [...connections.values()]
        .filter(
          (connection) =>
            connection.status === "connected" && (!serverName || connection.server.name === serverName),
        )
        .flatMap((connection) =>
          connection.catalog.tools.map((definition) =>
            Object.freeze({
              serverName: connection.server.name,
              canonicalName:
                [...canonicalNames].find(
                  ([, target]) =>
                    target.serverName === connection.server.name && target.toolName === definition.name,
                )?.[0] ??
                (() => {
                  throw new Error(`MCP tool ${definition.name} has no canonical name`);
                })(),
              identityDigest: sha256(
                canonicalJson({
                  scope: connection.server.scope,
                  server: connection.server.config,
                  definition,
                  serverVersion: connection.client?.getServerVersion() ?? null,
                  negotiatedCapabilities: connection.client?.getServerCapabilities() ?? null,
                }),
              ),
              definition,
            }),
          ),
        ),
    );
  };

  const callTool: McpHostManager["callTool"] = async (canonicalName, args, options) => {
    const target = canonicalToolNames().get(canonicalName);
    if (!target) throw new Error(`Unknown MCP tool ${JSON.stringify(canonicalName)}`);
    const { connection, client } = requireClient(target.serverName);
    const request = { name: target.toolName, arguments: { ...args } };
    const emitProgress = (event: McpProgressEvent): void => {
      options?.onProgress?.(event);
      void emit(target.serverName, "progress", toJsonValue(event));
    };
    const requestSettings = {
      ...requestOptions(options?.signal, connection.server.config.timeout, emitProgress, target.serverName),
      ...(options?.task ? { task: options.task } : {}),
    };
    const definition = connection.catalog.tools.find((tool) => tool.name === target.toolName);
    return await withInvocation(connection, options?.invocation, options?.signal, async () => {
      if (connection.intentionalClose || connections.get(target.serverName) !== connection)
        throw new Error(`MCP tool ${canonicalName} connection changed while its call was queued`);
      if (options?.expectedIdentityDigest) {
        const current = listTools(target.serverName).find((tool) => tool.canonicalName === canonicalName);
        if (current?.identityDigest !== options.expectedIdentityDigest)
          throw new Error(`MCP tool ${canonicalName} changed after this turn's catalog was frozen`);
      }
      const live = requireClient(target.serverName);
      if (live.connection !== connection || live.client !== client)
        throw new Error(`MCP tool ${canonicalName} connection changed while its call was queued`);
      if (definition?.execution?.taskSupport === "required" || options?.task) {
        for await (const message of client.experimental.tasks.callToolStream(
          request,
          undefined,
          requestSettings,
        )) {
          if (message.type === "error") throw message.error;
          if (message.type === "result") return CallToolResultSchema.parse(message.result);
          await emit(target.serverName, "progress", {
            kind: message.type,
            task: toJsonValue(message.task),
          });
        }
        throw new Error(`MCP task tool ${JSON.stringify(canonicalName)} ended without a result`);
      }
      return (await client.callTool(request, undefined, requestSettings)) as CallToolResult;
    });
  };

  const manager: McpHostManager = {
    start,
    close,
    listServers: () => Object.freeze([...connections.values()].map(connectionSummary)),
    inspectServer: (name: string): McpServerDetail | undefined => {
      const connection = connections.get(name);
      if (!connection) return undefined;
      const instructions = connection.client?.getInstructions();
      const negotiatedCapabilities = connection.client?.getServerCapabilities();
      return Object.freeze({
        ...connectionSummary(connection),
        ...(instructions ? { instructions } : {}),
        ...(negotiatedCapabilities ? { negotiatedCapabilities } : {}),
        diagnostics: Object.freeze([...connection.diagnostics]),
        ...connection.catalog,
      });
    },
    reconnect,
    authenticate,
    reload,
    refreshDiscovery,
    finishAuthentication,
    logout,
    listTools,
    callTool,
    startToolTask: async (canonicalName, args, options) => {
      const target = canonicalToolNames().get(canonicalName);
      if (!target) throw new Error(`Unknown MCP tool ${JSON.stringify(canonicalName)}`);
      const { connection, client } = requireClient(target.serverName);
      return await withInvocation(connection, options.invocation, options.signal, async () => {
        if (connection.intentionalClose || connections.get(target.serverName) !== connection)
          throw new Error(`MCP tool ${canonicalName} connection changed while its call was queued`);
        if (options.expectedIdentityDigest) {
          const current = listTools(target.serverName).find((tool) => tool.canonicalName === canonicalName);
          if (current?.identityDigest !== options.expectedIdentityDigest)
            throw new Error(`MCP tool ${canonicalName} changed after this turn's catalog was frozen`);
        }
        const live = requireClient(target.serverName);
        if (live.connection !== connection || live.client !== client)
          throw new Error(`MCP tool ${canonicalName} connection changed while its call was queued`);
        const definition = connection.catalog.tools.find((tool) => tool.name === target.toolName);
        const taskSupport = definition?.execution?.taskSupport;
        if (taskSupport !== "optional" && taskSupport !== "required") {
          throw new Error(
            `MCP tool ${canonicalName} does not support task execution (${taskSupport ?? "not declared"})`,
          );
        }
        for await (const message of client.experimental.tasks.callToolStream(
          { name: target.toolName, arguments: { ...args } },
          undefined,
          {
            ...requestOptions(options.signal, connection.server.config.timeout),
            task: options.ttl == null ? {} : { ttl: options.ttl },
          },
        )) {
          if (message.type === "error") throw message.error;
          if (message.type === "taskCreated") {
            if (options.invocation) connection.taskInvocations.set(message.task.taskId, options.invocation);
            return toJsonValue(message.task);
          }
          if (message.type === "result")
            throw new Error(`MCP tool ${canonicalName} completed without creating a task`);
        }
        throw new Error(`MCP tool ${canonicalName} ended without creating a task`);
      });
    },
    getPrompt: async (serverName, name, args, signal, invocation) => {
      const { connection, client } = requireClient(serverName);
      return await withInvocation(
        connection,
        invocation,
        signal,
        async () =>
          await client.getPrompt(
            { name, ...(args ? { arguments: { ...args } } : {}) },
            requestOptions(signal, connection.server.config.timeout),
          ),
      );
    },
    readResource: async (serverName, uri, signal, invocation) => {
      const { connection, client } = requireClient(serverName);
      return await withInvocation(
        connection,
        invocation,
        signal,
        async () =>
          await client.readResource({ uri }, requestOptions(signal, connection.server.config.timeout)),
      );
    },
    complete: async (serverName, params, signal, invocation) => {
      const { connection, client } = requireClient(serverName);
      return await withInvocation(
        connection,
        invocation,
        signal,
        async () => await client.complete(params, requestOptions(signal, connection.server.config.timeout)),
      );
    },
    subscribeResource: async (serverName, uri, signal, invocation) => {
      const { connection, client } = requireClient(serverName);
      await withInvocation(
        connection,
        invocation,
        signal,
        async () =>
          await client.subscribeResource({ uri }, requestOptions(signal, connection.server.config.timeout)),
      );
      const current = resourceSubscriptions.get(serverName);
      const identityDigest = connectionIdentityDigest(connection);
      const subscriptions =
        current?.serverIdentityDigest === identityDigest ? current.uris : new Set<string>();
      subscriptions.add(uri);
      resourceSubscriptions.set(serverName, {
        serverIdentityDigest: identityDigest,
        uris: subscriptions,
      });
    },
    unsubscribeResource: async (serverName, uri, signal, invocation) => {
      const { connection, client } = requireClient(serverName);
      await withInvocation(
        connection,
        invocation,
        signal,
        async () =>
          await client.unsubscribeResource({ uri }, requestOptions(signal, connection.server.config.timeout)),
      );
      const subscriptions = resourceSubscriptions.get(serverName);
      subscriptions?.uris.delete(uri);
      if (subscriptions?.uris.size === 0) resourceSubscriptions.delete(serverName);
    },
    setLoggingLevel: async (serverName, level, signal, invocation) => {
      const { connection, client } = requireClient(serverName);
      await withInvocation(
        connection,
        invocation,
        signal,
        async () =>
          await client.setLoggingLevel(level, requestOptions(signal, connection.server.config.timeout)),
      );
    },
    listTasks: async (serverName, cursor, signal, invocation) => {
      // These controls must remain concurrent with a running task. Task-specific reverse requests
      // resolve through taskInvocations in the client handlers instead of the foreground queue.
      void invocation;
      const { client } = requireClient(serverName);
      return await client.experimental.tasks.listTasks(cursor, signal ? { signal } : undefined);
    },
    getTask: async (serverName, taskId, signal, invocation) => {
      void invocation;
      const { client } = requireClient(serverName);
      return await client.experimental.tasks.getTask(taskId, signal ? { signal } : undefined);
    },
    getTaskResult: async (serverName, taskId, signal, invocation) => {
      void invocation;
      const { connection, client } = requireClient(serverName);
      const result = await client.experimental.tasks.getTaskResult(
        taskId,
        CallToolResultSchema,
        signal ? { signal } : undefined,
      );
      connection.taskInvocations.delete(taskId);
      return result;
    },
    cancelTask: async (serverName, taskId, signal, invocation) => {
      void invocation;
      const { connection, client } = requireClient(serverName);
      const result = await client.experimental.tasks.cancelTask(taskId, signal ? { signal } : undefined);
      connection.taskInvocations.delete(taskId);
      return result;
    },
  };
  return Object.freeze(manager);
}
