import {
  createMcpHostManager,
  createSecureMcpOAuthCredentialStore,
  loadMcpConfig,
  mcpCredentialPath,
  normalizeMcpLocalServerConfig,
  parseMcpSamplingResult,
  removeMcpServer,
  setMcpServerEnabled,
  validateMcpElicitationResult,
  writeMcpServer,
  type LoadedMcpConfig,
  type McpElicitRequest,
  type McpElicitResult,
  type McpHostManager,
  type McpServerDetail,
  type McpInvocationContext,
} from "@noesis/mcp";
import { adaptMcpSamplingRequest, type PiMcpSamplingPort } from "@noesis/runtime-pi";
import { canonicalJson } from "@noesis/domain";
import type {
  NoesisTuiRuntime,
  TuiMcpFormField,
  TuiMcpInteractionBridge,
  TuiMcpRecentError,
  TuiMcpServerConfig,
  TuiMcpServerDetail,
  TuiMcpServerSummary,
} from "@noesis/tui";

export interface ApplicationMcpIntegration {
  readonly host: McpHostManager;
  readonly start: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly listMcpServers: NonNullable<NoesisTuiRuntime["listMcpServers"]>;
  readonly inspectMcpServer: NonNullable<NoesisTuiRuntime["inspectMcpServer"]>;
  readonly mutateMcp: NonNullable<NoesisTuiRuntime["mutateMcp"]>;
  readonly setSamplingAuthorizer: (authorizer: ApplicationMcpSamplingAuthorizer) => void;
}

export type ApplicationMcpSamplingAuthorizer = (input: {
  readonly serverName: string;
  readonly request: unknown;
  readonly signal: AbortSignal;
  readonly invocation: McpInvocationContext;
  readonly execute: () => Promise<unknown>;
}) => Promise<unknown>;

function hostConfig(config: LoadedMcpConfig, workspaceTrusted: boolean): LoadedMcpConfig {
  if (workspaceTrusted) return config;
  const servers = new Map(
    Object.entries(config.global.servers).map(([name, serverConfig]) => [
      name,
      Object.freeze({
        name,
        scope: "global" as const,
        sourcePath:
          config.installed.find((entry) => entry.scope === "global" && entry.name === name)?.sourcePath ?? "",
        config: serverConfig,
      }),
    ]),
  );
  return Object.freeze({ ...config, servers });
}

function formFields(
  request: Exclude<McpElicitRequest["params"], { mode: "url" }>,
): readonly TuiMcpFormField[] {
  const required = new Set(request.requestedSchema.required ?? []);
  return Object.freeze(
    Object.entries(request.requestedSchema.properties).map(([name, property]): TuiMcpFormField => {
      const common = {
        name,
        label: property.title ?? name,
        ...(property.description ? { description: property.description } : {}),
        ...(required.has(name) ? { required: true } : {}),
      };
      if (property.type === "boolean")
        return Object.freeze({
          ...common,
          type: "boolean",
          ...(property.default === undefined ? {} : { defaultValue: property.default }),
        });
      if (property.type === "number" || property.type === "integer")
        return Object.freeze({
          ...common,
          type: "number",
          ...(property.default === undefined ? {} : { defaultValue: property.default }),
          ...(property.type === "integer" ? { integer: true } : {}),
          ...(property.minimum === undefined ? {} : { minimum: property.minimum }),
          ...(property.maximum === undefined ? {} : { maximum: property.maximum }),
        });
      if (property.type === "array") {
        const choices =
          "enum" in property.items
            ? property.items.enum.map((value) => Object.freeze({ value, label: value }))
            : property.items.anyOf.map((choice) =>
                Object.freeze({ value: choice.const, label: choice.title }),
              );
        return Object.freeze({
          ...common,
          type: "multiselect",
          choices: Object.freeze(choices),
          ...(property.default === undefined ? {} : { defaultValue: Object.freeze(property.default) }),
          ...(property.minItems === undefined ? {} : { minItems: property.minItems }),
          ...(property.maxItems === undefined ? {} : { maxItems: property.maxItems }),
        });
      }
      if ("enum" in property) {
        const names = "enumNames" in property ? property.enumNames : undefined;
        return Object.freeze({
          ...common,
          type: "select",
          choices: Object.freeze(
            property.enum.map((value, index) => Object.freeze({ value, label: names?.[index] ?? value })),
          ),
          ...(property.default === undefined ? {} : { defaultValue: property.default }),
        });
      }
      if ("oneOf" in property) {
        return Object.freeze({
          ...common,
          type: "select",
          choices: Object.freeze(
            property.oneOf.map((choice) => Object.freeze({ value: choice.const, label: choice.title })),
          ),
          ...(property.default === undefined ? {} : { defaultValue: property.default }),
        });
      }
      if (property.type !== "string") throw new Error(`Unsupported MCP form field ${name}`);
      const defaultValue =
        "default" in property && typeof property.default === "string" ? property.default : undefined;
      return Object.freeze({
        ...common,
        type: "text",
        ...(defaultValue === undefined ? {} : { defaultValue }),
        ...(property.minLength === undefined ? {} : { minLength: property.minLength }),
        ...(property.maxLength === undefined ? {} : { maxLength: property.maxLength }),
        ...(property.format === "date" ||
        property.format === "uri" ||
        property.format === "email" ||
        property.format === "date-time"
          ? { format: property.format }
          : {}),
      });
    }),
  );
}

async function presentElicitation(
  serverName: string,
  request: McpElicitRequest,
  bridge: TuiMcpInteractionBridge,
  signal: AbortSignal,
): Promise<McpElicitResult> {
  if (request.params.mode === "url") {
    const result = await bridge.handlers.elicitUrl(
      {
        serverName,
        title: "Open MCP interaction",
        message: request.params.message,
        url: request.params.url,
        elicitationId: request.params.elicitationId,
      },
      signal,
    );
    return { action: result.action };
  }
  const result = await bridge.handlers.elicitForm(
    {
      serverName,
      title: "MCP request",
      message: request.params.message,
      fields: formFields(request.params),
    },
    signal,
  );
  const response: McpElicitResult =
    result.action === "accept"
      ? {
          action: "accept",
          content: Object.fromEntries(
            Object.entries(result.values).map(([name, value]) => [
              name,
              typeof value === "object" ? Array.from(value) : value,
            ]),
          ),
        }
      : { action: result.action };
  return validateMcpElicitationResult(request, response);
}

function tuiConfig(
  detail: McpServerDetail | undefined,
  config: LoadedMcpConfig["installed"][number]["config"],
): TuiMcpServerConfig {
  void detail;
  return config.type === "local"
    ? {
        type: "local",
        command: Object.freeze([config.command, ...(config.args ?? [])]),
        ...(config.cwd ? { cwd: config.cwd } : {}),
        ...(config.environment ? { environmentReferences: config.environment } : {}),
      }
    : {
        type: "remote",
        url: config.url,
        oauth: config.oauth !== false,
        ...(config.headers ? { headers: config.headers } : {}),
      };
}

function validatedRemoteUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("MCP remote server URL must use http:// or https://");
  return url.href;
}

export function createApplicationMcpIntegration(input: {
  readonly home: string;
  readonly projectDirectory: string;
  readonly sampling: PiMcpSamplingPort;
  readonly interactions: TuiMcpInteractionBridge;
  readonly openUrl: (url: string) => Promise<void>;
  readonly workspaceTrusted: boolean;
}): ApplicationMcpIntegration {
  let configPromise = loadMcpConfig(input);
  let eventConfig: LoadedMcpConfig | undefined;
  let host: McpHostManager;
  let samplingAuthorizer: ApplicationMcpSamplingAuthorizer | undefined;
  const recentErrors = new Map<
    string,
    { readonly identity: string; readonly entries: readonly TuiMcpRecentError[] }
  >();
  const scopedServerKey = (scope: "global" | "project", name: string): string => `${scope}:${name}`;
  const serverIdentity = (server: LoadedMcpConfig["installed"][number]): string =>
    canonicalJson({
      scope: server.scope,
      name: server.name,
      sourcePath: server.sourcePath,
      config: server.config,
    });
  const rememberEventError = (serverName: string, operation: string, message: string): void => {
    const effective = eventConfig?.servers.get(serverName);
    if (!effective) return;
    const key = scopedServerKey(effective.scope, serverName);
    const identity = canonicalJson({
      scope: effective.scope,
      name: effective.name,
      sourcePath: effective.sourcePath,
      config: effective.config,
    });
    const previous = recentErrors.get(key);
    recentErrors.set(key, {
      identity,
      entries: [
        ...(previous?.identity === identity ? previous.entries : []),
        { message: message.slice(0, 2_000), occurredAt: new Date().toISOString(), operation },
      ].slice(-20),
    });
  };
  const hostPromise = configPromise.then((config) => {
    const activeConfig = hostConfig(config, input.workspaceTrusted);
    eventConfig = activeConfig;
    host = createMcpHostManager({
      home: input.home,
      projectDirectory: input.projectDirectory,
      config: activeConfig,
      credentials: createSecureMcpOAuthCredentialStore(mcpCredentialPath(input.home)),
      handlers: {
        sample: async (serverName, request, signal, invocation) => {
          if (!invocation)
            throw new Error("MCP sampling is allowed only during an admitted foreground invocation");
          if (!samplingAuthorizer) throw new Error("MCP sampling authority is not available");
          return parseMcpSamplingResult(
            await samplingAuthorizer({
              serverName,
              request,
              signal,
              invocation,
              execute: async () =>
                await adaptMcpSamplingRequest(input.sampling, request, signal, invocation.route),
            }),
          );
        },
        elicit: async (serverName, request, signal) =>
          await presentElicitation(serverName, request, input.interactions, signal),
        onOAuthRedirect: async ({ authorizationUrl }) => await input.openUrl(authorizationUrl.href),
        onEvent: (event) => {
          if (typeof event.payload === "object" && event.payload !== null) {
            const error = Reflect.get(event.payload, "error");
            const level = Reflect.get(event.payload, "level");
            if (typeof error === "string") rememberEventError(event.serverName, event.type, error);
            else if (
              event.type === "log" &&
              typeof level === "string" &&
              ["error", "critical", "alert", "emergency"].includes(level)
            ) {
              rememberEventError(event.serverName, `log:${level}`, JSON.stringify(event.payload));
            }
          }
          if (event.type !== "elicitation_complete") return;
          const elicitationId =
            typeof event.payload === "object" &&
            event.payload !== null &&
            !Array.isArray(event.payload) &&
            "elicitationId" in event.payload
              ? Reflect.get(event.payload, "elicitationId")
              : undefined;
          if (typeof elicitationId === "string")
            input.interactions.completeUrl(event.serverName, elicitationId);
        },
      },
    });
    return host;
  });
  const currentHost = async (): Promise<McpHostManager> => await hostPromise;
  const reload = async (): Promise<void> => {
    configPromise = loadMcpConfig(input);
    const config = await configPromise;
    const activeConfig = hostConfig(config, input.workspaceTrusted);
    eventConfig = activeConfig;
    for (const [key, history] of recentErrors) {
      const installed = config.installed.find((server) => scopedServerKey(server.scope, server.name) === key);
      if (!installed || history.identity !== serverIdentity(installed)) recentErrors.delete(key);
    }
    await (await currentHost()).reload(activeConfig);
  };
  const listMcpServers: ApplicationMcpIntegration["listMcpServers"] = async () => {
    const [config, manager] = await Promise.all([configPromise, currentHost()]);
    const live = new Map(manager.listServers().map((server) => [server.name, server]));
    return Object.freeze(
      config.installed.map((installed): TuiMcpServerSummary => {
        const projectBlocked = installed.scope === "project" && !input.workspaceTrusted;
        const shadowed = input.workspaceTrusted && installed.shadowed;
        const summary = shadowed || projectBlocked ? undefined : live.get(installed.name);
        return Object.freeze({
          name: installed.name,
          scope: installed.scope,
          sourcePath: installed.sourcePath,
          enabled: !projectBlocked && installed.config.enabled !== false,
          type: installed.config.type,
          status: projectBlocked
            ? "disabled"
            : shadowed
              ? "overridden"
              : (summary?.status ?? (installed.config.enabled === false ? "disabled" : "failed")),
          capabilityCounts: summary?.capabilityCounts ?? {
            tools: 0,
            prompts: 0,
            resources: 0,
            resourceTemplates: 0,
          },
          ...(shadowed ? { shadowed: true } : {}),
          ...(projectBlocked
            ? { lastError: "Project MCP servers require a trusted workspace." }
            : summary?.lastError
              ? { lastError: summary.lastError }
              : {}),
        });
      }),
    );
  };
  const inspectMcpServer: ApplicationMcpIntegration["inspectMcpServer"] = async (scope, name) => {
    const [config, manager] = await Promise.all([configPromise, currentHost()]);
    const installed = config.installed.find((entry) => entry.scope === scope && entry.name === name);
    if (!installed) return undefined;
    const projectBlocked = installed.scope === "project" && !input.workspaceTrusted;
    const shadowed = input.workspaceTrusted && installed.shadowed;
    const live = projectBlocked || shadowed ? undefined : manager.inspectServer(name);
    const summary = (await listMcpServers()).find((entry) => entry.scope === scope && entry.name === name);
    if (!summary) return undefined;
    const detail: TuiMcpServerDetail = {
      ...summary,
      config: tuiConfig(live, installed.config),
      ...(live?.instructions ? { instructions: live.instructions } : {}),
      negotiatedCapabilities: Object.freeze(Object.keys(live?.negotiatedCapabilities ?? {}).sort()),
      tools: Object.freeze(
        (live?.tools ?? []).map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        })),
      ),
      prompts: Object.freeze(
        (live?.prompts ?? []).map((prompt) => ({
          name: prompt.name,
          ...(prompt.description ? { description: prompt.description } : {}),
          ...(prompt.arguments
            ? {
                arguments: Object.freeze(
                  prompt.arguments.map((argument) => ({
                    name: argument.name,
                    ...(argument.description ? { description: argument.description } : {}),
                    ...(argument.required === undefined ? {} : { required: argument.required }),
                  })),
                ),
              }
            : {}),
        })),
      ),
      resources: Object.freeze(
        (live?.resources ?? []).map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          ...(resource.description ? { description: resource.description } : {}),
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        })),
      ),
      resourceTemplates: Object.freeze(
        (live?.resourceTemplates ?? []).map((template) => ({
          uriTemplate: template.uriTemplate,
          name: template.name,
          ...(template.description ? { description: template.description } : {}),
          ...(template.mimeType ? { mimeType: template.mimeType } : {}),
        })),
      ),
      recentErrors: Object.freeze([
        ...(live?.diagnostics ?? []).map((diagnostic) => ({
          message: diagnostic.message,
          operation: diagnostic.toolName ? `${diagnostic.code}:${diagnostic.toolName}` : diagnostic.code,
        })),
        ...(recentErrors.get(scopedServerKey(scope, name))?.identity === serverIdentity(installed)
          ? (recentErrors.get(scopedServerKey(scope, name))?.entries ?? [])
          : []),
        ...(summary.lastError &&
        !(
          recentErrors.get(scopedServerKey(scope, name))?.identity === serverIdentity(installed)
            ? (recentErrors.get(scopedServerKey(scope, name))?.entries ?? [])
            : []
        ).some((entry) => entry.message === summary.lastError)
          ? [{ message: summary.lastError }]
          : []),
      ]),
    };
    return Object.freeze(detail);
  };
  const mutateMcp: ApplicationMcpIntegration["mutateMcp"] = async (intent, signal) => {
    const manager = await currentHost();
    if (intent.type === "reload") {
      await reload();
      return { message: "Reloaded MCP servers." };
    }
    if (intent.type === "authenticate" || intent.type === "logout" || intent.type === "reconnect") {
      if (intent.scope === "project" && !input.workspaceTrusted)
        throw new Error("Project MCP servers require a trusted workspace");
      const effective = hostConfig(await configPromise, input.workspaceTrusted).servers.get(intent.name);
      if (!effective || effective.scope !== intent.scope)
        throw new Error(`MCP server ${intent.scope}/${intent.name} is shadowed or not installed`);
      if (
        (intent.type === "authenticate" || intent.type === "logout") &&
        (effective.config.type !== "remote" || effective.config.oauth === false)
      )
        throw new Error(`MCP server ${intent.name} does not use OAuth`);
      if (intent.type === "authenticate") {
        signal?.throwIfAborted();
        await manager.authenticate(intent.name, signal ? { signal } : undefined);
      } else if (intent.type === "logout") await manager.logout(intent.name);
      else await manager.reconnect(intent.name);
      return {
        message: `${intent.type === "authenticate" ? "Authenticated" : intent.type === "logout" ? "Logged out of" : "Reconnected"} ${intent.name}.`,
      };
    }
    if (intent.type === "remove") {
      await removeMcpServer({ ...input, scope: intent.scope, name: intent.name });
    } else if (intent.type === "set-enabled") {
      await setMcpServerEnabled({
        ...input,
        scope: intent.scope,
        name: intent.name,
        enabled: intent.enabled,
      });
    } else if (intent.type === "add-local" || intent.type === "edit-local") {
      const existing = (await configPromise).installed.find(
        (entry) => entry.scope === intent.scope && entry.name === intent.name,
      )?.config;
      await writeMcpServer({
        ...input,
        scope: intent.scope,
        name: intent.name,
        config: normalizeMcpLocalServerConfig({
          ...(intent.type === "edit-local" && existing?.type === "local" ? existing : {}),
          type: "local",
          command:
            intent.command[0] ??
            (() => {
              throw new Error("MCP command cannot be empty");
            })(),
          args: intent.command.slice(1),
        }),
      });
    } else if (intent.type === "add-remote" || intent.type === "edit-remote") {
      const url = validatedRemoteUrl(intent.url);
      const existing = (await configPromise).installed.find(
        (entry) => entry.scope === intent.scope && entry.name === intent.name,
      )?.config;
      const oauth =
        intent.oauth &&
        intent.type === "edit-remote" &&
        existing?.type === "remote" &&
        typeof existing.oauth === "object"
          ? existing.oauth
          : intent.oauth;
      await writeMcpServer({
        ...input,
        scope: intent.scope,
        name: intent.name,
        config: {
          ...(intent.type === "edit-remote" && existing?.type === "remote" ? existing : {}),
          type: "remote",
          url,
          oauth,
        },
      });
    } else throw new Error(`Unsupported MCP mutation ${intent.type}`);
    await reload();
    return { message: `${intent.type.replaceAll("-", " ")} ${"name" in intent ? intent.name : "MCP"}.` };
  };
  return Object.freeze({
    get host() {
      if (!host) throw new Error("MCP host has not initialized yet");
      return host;
    },
    start: async () => await (await currentHost()).start(),
    close: async () => {
      input.interactions.shutdown();
      await (await currentHost()).close();
    },
    listMcpServers,
    inspectMcpServer,
    mutateMcp,
    setSamplingAuthorizer: (authorizer: ApplicationMcpSamplingAuthorizer) => {
      if (samplingAuthorizer) throw new Error("MCP sampling authority is already configured");
      samplingAuthorizer = authorizer;
    },
  });
}
