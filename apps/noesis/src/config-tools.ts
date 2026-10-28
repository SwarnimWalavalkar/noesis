import {
  BUILT_IN_AGENT_DEFAULTS,
  type AgentConfig,
  NoesisConfigPatchSchema,
  ThinkingLevelSchema,
  readNoesisConfig,
  type NoesisConfigPatch,
  type ResolvedNoesisConfig,
} from "@noesis/config";
import { JsonValueSchema, toJsonValue } from "@noesis/domain";
import { DEFAULT_CONTEXT_TOKEN_BUDGET } from "@noesis/runtime";
import { defineTool, type ToolDefinition } from "@noesis/tools";
import type { NoesisTuiRuntime, TuiInteractionBridge, TuiModelRoute } from "@noesis/tui";
import { z } from "zod";

export interface ConfigurationPort {
  readonly current: () => ResolvedNoesisConfig;
  /** Writes the patch, rereads the file, and makes the result the live configuration. */
  readonly update: (patch: NoesisConfigPatch) => Promise<ResolvedNoesisConfig>;
  readonly listModelRoutes?: () => readonly TuiModelRoute[];
  readonly refreshModelRoutes?: (signal?: AbortSignal) => Promise<readonly TuiModelRoute[]>;
  readonly providerAuthStatus?: NonNullable<NoesisTuiRuntime["providerAuthStatus"]>;
  readonly disconnectProvider?: NonNullable<NoesisTuiRuntime["disconnectProvider"]>;
  readonly interactions?: Pick<TuiInteractionBridge["handlers"], "authenticateProvider">;
}

const FOREGROUND_ROUTE_TIMING =
  "Applies when Noesis next starts a session without an explicit route, normally the next launch. Switch the current session with /provider, /model, or /reasoning.";
const NEXT_TURN = "Applies from the next turn.";

/** Static guidance returned by config.inspect so the agent can explain each setting. */
const SETTINGS = Object.freeze([
  {
    key: "agent.provider",
    description: "Foreground model provider. Use providers.list for valid IDs.",
    appliesWhen: FOREGROUND_ROUTE_TIMING,
    overriddenBy: "--provider or NOESIS_PROVIDER",
  },
  {
    key: "agent.model",
    description: "Foreground model ID for the configured provider.",
    appliesWhen: FOREGROUND_ROUTE_TIMING,
    overriddenBy: "--model or NOESIS_MODEL",
  },
  {
    key: "agent.thinkingLevel",
    description: "Foreground reasoning level: off, minimal, low, medium, high, xhigh, or max.",
    appliesWhen: FOREGROUND_ROUTE_TIMING,
    overriddenBy: "--thinking-level or NOESIS_THINKING_LEVEL",
  },
  {
    key: "agents.provider",
    description: "Default provider for new subagents. null inherits the foreground session route.",
    appliesWhen: NEXT_TURN,
  },
  {
    key: "agents.model",
    description: "Default model for new subagents. null inherits the foreground session route.",
    appliesWhen: NEXT_TURN,
  },
  {
    key: "agents.thinkingLevel",
    description: "Default reasoning level for new subagents. null inherits the foreground session.",
    appliesWhen: NEXT_TURN,
  },
  {
    key: "context.tokenBudget",
    description:
      "Positive integer up to 1,000,000 that bounds each model request. Default 160000. Noesis keeps it below the model's context window minus its maximum output.",
    appliesWhen: NEXT_TURN,
  },
  {
    key: "context.autoCompact",
    description:
      "Whether Noesis compacts older history automatically before an over-budget turn. Default true.",
    appliesWhen: NEXT_TURN,
  },
]);

const AGENT_KEYS = ["provider", "model", "thinkingLevel"] as const;

const route = ({ provider, model, thinkingLevel }: ResolvedNoesisConfig["agent"]) => ({
  provider,
  model,
  thinkingLevel,
});
const effective = (config: ResolvedNoesisConfig) => ({
  agent: route(config.agent),
  agents: route(config.agents),
  context: {
    tokenBudget: config.context.tokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET,
    autoCompact: config.context.autoCompact ?? true,
  },
});

type Route = ResolvedNoesisConfig["agent"];

/** undefined keeps the current value, null falls back, and anything else replaces it. */
const patched = <T>(next: T | null | undefined, kept: T, cleared: T): T =>
  next === undefined ? kept : next === null ? cleared : next;

/** A model that lists no reasoning levels supports only `off`, as the route picker shows. */
export const supportedThinkingLevels = (
  route: Pick<TuiModelRoute, "thinkingLevels">,
): readonly Route["thinkingLevel"][] => (route.thinkingLevels.length > 0 ? route.thinkingLevels : ["off"]);

const sameRoute = (left: Route, right: Route): boolean => AGENT_KEYS.every((key) => left[key] === right[key]);

/**
 * The routes before and after a patch. `stored` is the foreground route config.json will hold, starting from
 * the file's current `agent` section, with unset or cleared fields falling back to built-in defaults. `agent` is the foreground route that actually runs, where a
 * command-line or environment override still wins. Subagent fields that inherit, or are cleared, take the
 * current session's route, because that is what a subagent spawned from this session runs.
 */
export const routesAfter = (
  before: ResolvedNoesisConfig,
  patch: NoesisConfigPatch,
  session: Route,
  file: AgentConfig,
) => {
  const overridden = (key: (typeof AGENT_KEYS)[number]) =>
    before.sources[key] === "cli" || before.sources[key] === "environment";
  const stored: Route = {
    provider: patched(
      patch.agent?.provider,
      file.provider ?? BUILT_IN_AGENT_DEFAULTS.provider,
      BUILT_IN_AGENT_DEFAULTS.provider,
    ),
    model: patched(
      patch.agent?.model,
      file.model ?? BUILT_IN_AGENT_DEFAULTS.model,
      BUILT_IN_AGENT_DEFAULTS.model,
    ),
    thinkingLevel: patched(
      patch.agent?.thinkingLevel,
      file.thinkingLevel ?? BUILT_IN_AGENT_DEFAULTS.thinkingLevel,
      BUILT_IN_AGENT_DEFAULTS.thinkingLevel,
    ),
  };
  const agent: Route = {
    provider: overridden("provider") ? before.agent.provider : stored.provider,
    model: overridden("model") ? before.agent.model : stored.model,
    thinkingLevel: overridden("thinkingLevel") ? before.agent.thinkingLevel : stored.thinkingLevel,
  };
  const inherits = (key: (typeof AGENT_KEYS)[number]) => before.agentsSources[key] === "foreground";
  const agentsBefore: Route = {
    provider: inherits("provider") ? session.provider : before.agents.provider,
    model: inherits("model") ? session.model : before.agents.model,
    thinkingLevel: inherits("thinkingLevel") ? session.thinkingLevel : before.agents.thinkingLevel,
  };
  const agents: Route = {
    provider: patched(patch.agents?.provider, agentsBefore.provider, session.provider),
    model: patched(patch.agents?.model, agentsBefore.model, session.model),
    thinkingLevel: patched(patch.agents?.thinkingLevel, agentsBefore.thinkingLevel, session.thinkingLevel),
  };
  return { stored, agent, agents, agentsBefore };
};

const providerTarget = z.strictObject({ provider: z.string().min(1) });

const RouteSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
  thinkingLevel: ThinkingLevelSchema,
});
const EffectiveSchema = z.strictObject({
  agent: RouteSchema,
  agents: RouteSchema,
  context: z.strictObject({ tokenBudget: z.number(), autoCompact: z.boolean() }),
});
const ConfigSourceSchema = z.enum(["cli", "environment", "config", "default"]);
const AgentDefaultSourceSchema = z.enum(["configured", "foreground"]);
const AuthenticationSchema = z
  .strictObject({
    provider: z.string(),
    configured: z.boolean(),
    source: z.enum(["oauth", "stored-api-key", "environment", "none"]),
    expired: z.boolean().nullable(),
  })
  .nullable();
const AppliesWhenSchema = z.strictObject({ agent: z.string(), agents: z.string(), context: z.string() });

const ConfigInspectOutputSchema = z.strictObject({
  home: z.string(),
  path: z.string(),
  /** The config.json contents, or null before the file exists. */
  stored: JsonValueSchema,
  effective: EffectiveSchema,
  sources: z.strictObject({
    agent: z.strictObject({
      provider: ConfigSourceSchema,
      model: ConfigSourceSchema,
      thinkingLevel: ConfigSourceSchema,
    }),
    agents: z.strictObject({
      provider: AgentDefaultSourceSchema,
      model: AgentDefaultSourceSchema,
      thinkingLevel: AgentDefaultSourceSchema,
    }),
  }),
  settings: z.array(
    z.strictObject({
      key: z.string(),
      description: z.string(),
      appliesWhen: z.string(),
      overriddenBy: z.string().nullable(),
    }),
  ),
});
const ConfigUpdateOutputSchema = z.strictObject({
  path: z.string(),
  previous: EffectiveSchema,
  effective: EffectiveSchema,
  overridden: z.array(z.strictObject({ key: z.string(), source: ConfigSourceSchema, value: z.string() })),
  providers: z.array(z.strictObject({ provider: z.string(), authentication: AuthenticationSchema })),
  appliesWhen: AppliesWhenSchema,
});
const ProviderSummarySchema = z.strictObject({
  provider: z.string(),
  name: z.string(),
  authentication: AuthenticationSchema,
  models: z.number(),
  defaultModel: z.string().nullable(),
});
const ProviderDetailSchema = z.strictObject({
  provider: z.string(),
  name: z.string(),
  authentication: AuthenticationSchema,
  allowsCustomModelIds: z.boolean(),
  models: z.array(
    z.strictObject({
      model: z.string(),
      name: z.string(),
      default: z.boolean(),
      thinkingLevels: z.array(ThinkingLevelSchema),
    }),
  ),
});
const ProvidersListOutputSchema = z.union([
  z.strictObject({ providers: z.array(ProviderSummarySchema) }),
  ProviderDetailSchema,
]);
const ProviderAuthenticationOutputSchema = z.strictObject({
  provider: z.string(),
  authentication: AuthenticationSchema,
});

/** Foreground adapters for Noesis's configuration and provider credentials, bound to the current session's route. */
export function createConfigurationTools(port: ConfigurationPort, session: Route): readonly ToolDefinition[] {
  const routes = async (signal?: AbortSignal): Promise<readonly TuiModelRoute[]> => {
    if (!port.refreshModelRoutes) return port.listModelRoutes?.() ?? [];
    try {
      return await port.refreshModelRoutes(signal);
    } catch {
      return port.listModelRoutes?.() ?? [];
    }
  };
  const knownRoutes = async (provider: string, model: string | undefined, signal: AbortSignal) => {
    const listed = port.listModelRoutes?.() ?? [];
    const matches = (candidate: readonly TuiModelRoute[]) =>
      candidate.some(
        (route) => route.provider === provider && (model === undefined || route.model === model),
      );
    return matches(listed) ? listed : await routes(signal);
  };
  const providerName = (catalog: readonly TuiModelRoute[], provider: string): string =>
    catalog.find((route) => route.provider === provider)?.providerName ?? provider;

  /** Rejects routes the model catalog does not offer. Skipped when no catalog is available. */
  const validateRoute = async (
    section: "agent" | "agents",
    { provider, model, thinkingLevel }: Route,
    signal: AbortSignal,
  ): Promise<void> => {
    const catalog = await knownRoutes(provider, model, signal);
    if (catalog.length === 0) return;
    const providerRoutes = catalog.filter((route) => route.provider === provider);
    if (providerRoutes.length === 0)
      throw new Error(`${section}.provider ${provider} is not a known provider; inspect providers.list`);
    const route = providerRoutes.find((candidate) => candidate.model === model);
    if (!route && !providerRoutes.some((candidate) => candidate.allowsCustomModelIds))
      throw new Error(
        `${section}.model ${model} is not offered by ${provider}; inspect providers.list({ provider: ${JSON.stringify(provider)} })`,
      );
    const supported = route ? supportedThinkingLevels(route) : undefined;
    if (supported && !supported.includes(thinkingLevel))
      throw new Error(
        `${provider}/${model} does not support reasoning level ${thinkingLevel}. Supported: ${supported.join(", ")}`,
      );
  };

  const authentication = (
    status: Awaited<ReturnType<NonNullable<ConfigurationPort["providerAuthStatus"]>>>,
  ) => ({
    provider: status.provider,
    configured: status.configured,
    source: status.source,
    expired: status.expired ?? null,
  });
  const authenticationStatus = async (provider: string) =>
    port.providerAuthStatus ? authentication(await port.providerAuthStatus(provider)) : null;

  return Object.freeze([
    defineTool({
      name: "config.inspect",
      label: "Inspect Noesis configuration",
      description:
        "Read Noesis's effective configuration, the stored config.json contents, where each foreground value came from, and what every setting does and when it applies. agent.* is only the default for new sessions; session.inspect reports the model the current session is running. Use config.update to change settings.",
      inputSchema: z.strictObject({}),
      outputSchema: ConfigInspectOutputSchema,
      effect: () => ({ effect: "read", resource: "config:noesis", estimatedCost: 0 }),
      execute: async () => {
        const config = port.current();
        const stored = await readNoesisConfig(config.home);
        if (!stored.ok) throw stored.error;
        return {
          home: config.home,
          path: config.configPath,
          stored: toJsonValue(stored.value.config ?? null),
          effective: effective(config),
          sources: { agent: config.sources, agents: config.agentsSources },
          settings: SETTINGS.map((setting) => ({ overriddenBy: null, ...setting })),
        };
      },
    }),
    defineTool({
      name: "config.update",
      label: "Update Noesis configuration",
      description:
        "Change Noesis's configuration with one partial patch of agent, agents, and context fields. null clears a field so its default applies; for agents it inherits the foreground route. Provider and model IDs are checked against providers.list. Returns the previous and new effective values, fields still overridden by command-line or environment settings, and provider sign-in status for routes that need it.",
      inputSchema: NoesisConfigPatchSchema,
      outputSchema: ConfigUpdateOutputSchema,
      effect: () => ({ effect: "write", resource: "config:noesis", estimatedCost: 0 }),
      execute: async (patch, context) => {
        const before = port.current();
        // Validate every route the patch changes, including fields it clears; an unchanged route already runs.
        const stored = await readNoesisConfig(before.home);
        if (!stored.ok) throw stored.error;
        const routes = routesAfter(before, patch, session, stored.value.config?.agent ?? {});
        if (!sameRoute(routes.agent, before.agent))
          await validateRoute("agent", routes.agent, context.signal);
        if (!sameRoute(routes.agents, routes.agentsBefore))
          await validateRoute("agents", routes.agents, context.signal);
        context.signal.throwIfAborted();
        const after = await port.update(patch);
        const overridden = AGENT_KEYS.filter(
          (key) =>
            patch.agent?.[key] !== undefined &&
            (after.sources[key] === "cli" || after.sources[key] === "environment"),
        ).map((key) => ({ key: `agent.${key}`, source: after.sources[key], value: after.agent[key] }));
        const changedProviders = [
          ...new Set(
            [
              patch.agent?.provider !== undefined ? after.agent.provider : undefined,
              patch.agents?.provider !== undefined ? after.agents.provider : undefined,
            ].filter((provider): provider is string => provider !== undefined),
          ),
        ];
        return {
          path: after.configPath,
          previous: effective(before),
          effective: effective(after),
          overridden,
          providers: await Promise.all(
            changedProviders.map(async (provider) => ({
              provider,
              authentication: await authenticationStatus(provider),
            })),
          ),
          appliesWhen: {
            agent: FOREGROUND_ROUTE_TIMING,
            agents: NEXT_TURN,
            context: NEXT_TURN,
          },
        };
      },
    }),
    defineTool({
      name: "providers.list",
      label: "List model providers",
      description:
        "Without a provider, list every model provider with its sign-in status, model count, and default model. With a provider, list its models and supported reasoning levels.",
      inputSchema: z.strictObject({ provider: z.string().min(1).optional() }),
      outputSchema: ProvidersListOutputSchema,
      effect: () => ({ effect: "read", resource: "providers", estimatedCost: 0 }),
      execute: async ({ provider }, context) => {
        const catalog = await routes(context.signal);
        if (provider !== undefined) {
          const models = catalog.filter((route) => route.provider === provider);
          if (models.length === 0) throw new Error(`Unknown provider ${provider}; call providers.list`);
          return {
            provider,
            name: providerName(catalog, provider),
            authentication: await authenticationStatus(provider),
            allowsCustomModelIds: models.some((route) => route.allowsCustomModelIds),
            models: models.map((route) => ({
              model: route.model,
              name: route.name,
              default: route.default,
              thinkingLevels: [...supportedThinkingLevels(route)],
            })),
          };
        }
        const providers = [...new Set(catalog.map((route) => route.provider))];
        return {
          providers: await Promise.all(
            providers.map(async (id) => {
              const models = catalog.filter((route) => route.provider === id);
              return {
                provider: id,
                name: providerName(catalog, id),
                authentication: await authenticationStatus(id),
                models: models.length,
                defaultModel: (models.find((route) => route.default) ?? models[0])?.model ?? null,
              };
            }),
          ),
        };
      },
    }),
    defineTool({
      name: "providers.authenticate",
      label: "Sign in to a model provider",
      description:
        "Open the same sign-in flow as /provider and wait for the user to finish. OAuth opens the browser; API keys use a masked form. Credentials go straight to protected storage and never appear in arguments, results, or chat. Replaces existing credentials on success. Cancellation or failure fails the call.",
      inputSchema: providerTarget,
      outputSchema: ProviderAuthenticationOutputSchema,
      effect: ({ provider }) => ({
        effect: "write",
        resource: `provider:${provider}:credentials`,
        estimatedCost: 0,
      }),
      execute: async ({ provider }, context) => {
        if (!port.interactions) throw new Error("Provider sign-in needs the interactive terminal");
        const catalog = await knownRoutes(provider, undefined, context.signal);
        if (catalog.length > 0 && !catalog.some((route) => route.provider === provider))
          throw new Error(`Unknown provider ${provider}; call providers.list`);
        const name = providerName(catalog, provider);
        const result = await port.interactions.authenticateProvider(
          {
            providerId: provider,
            providerName: name,
            reason: `Noesis asked you to sign in to ${name}. Your credentials go directly to protected storage; the agent never sees them.`,
          },
          context.signal,
        );
        context.signal.throwIfAborted();
        if (result.action === "cancel") throw new Error(`Sign-in to ${name} was cancelled`);
        if (result.action === "error") throw new Error(result.message);
        await routes(context.signal);
        return { provider, authentication: await authenticationStatus(provider) };
      },
    }),
    defineTool({
      name: "providers.logout",
      label: "Sign out of a model provider",
      description:
        "Remove stored credentials for a model provider. Credentials from environment variables remain in effect.",
      inputSchema: providerTarget,
      outputSchema: ProviderAuthenticationOutputSchema,
      effect: ({ provider }) => ({
        effect: "write",
        resource: `provider:${provider}:credentials`,
        estimatedCost: 0,
      }),
      execute: async ({ provider }) => {
        if (!port.disconnectProvider) throw new Error("Provider sign-out is unavailable here");
        return { provider, authentication: authentication(await port.disconnectProvider(provider)) };
      },
    }),
  ]);
}
