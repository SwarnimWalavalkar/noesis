import {
  createModels,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type AuthResult,
  type Context,
  type CredentialStore,
  type Model,
  type Models,
  type ModelsApiStreamOptions,
  type ModelsSimpleStreamOptions,
  type ModelsStore,
  type MutableModels,
  type Provider,
  type ProviderHeaders,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createConditionalObject } from "@noesis/domain";
import { composeNoesisOpenCodeGoProvider } from "./opencode-go-provider.ts";
import { isNoesisProviderId, NOESIS_PROVIDER_IDS } from "./provider-ids.ts";

export interface PiModelCatalog {
  readonly getProviders: () => readonly Provider[];
  readonly getProvider: (providerId: string) => Provider | undefined;
  readonly getModels: (providerId?: string) => ReturnType<MutableModels["getModels"]>;
  readonly getModel: (providerId: string, modelId: string) => ReturnType<MutableModels["getModel"]>;
  readonly registerNativeProvider: (provider: Provider) => void;
}

export interface NoesisPiModelCatalog {
  readonly catalog: PiModelCatalog;
  readonly models: MutableModels;
  readonly synchronize: () => void;
}

type AuthResolutionOverrides = Parameters<Models["getAuth"]>[1];

function mergeHeaders(
  base: ProviderHeaders | undefined,
  override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
  if (!base && !override) return undefined;
  const merged = { ...base };
  for (const [name, value] of Object.entries(override ?? {})) {
    const normalized = name.toLowerCase();
    for (const existing of Object.keys(merged))
      if (existing.toLowerCase() === normalized) delete merged[existing];
    merged[name] = value;
  }
  return merged;
}

/**
 * Keeps the supported-provider projection as the execution boundary while
 * importing Pi's request-time models.json header resolution from ModelRuntime.
 */
export function createConfiguredModelsProjection(projected: Models, source: ModelRuntime): Models {
  function getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
  function getAuth(model: Model<Api>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
  async function getAuth(
    providerOrModel: string | Model<Api>,
    overrides?: AuthResolutionOverrides,
  ): Promise<AuthResult | undefined> {
    if (typeof providerOrModel === "string") return await projected.getAuth(providerOrModel, overrides);
    const effective = await projected.getAuth(providerOrModel, overrides);
    if (!effective) return undefined;
    const effectiveApiKey = overrides?.apiKey ?? effective.auth.apiKey;
    const effectiveEnv =
      effective.env || overrides?.env ? { ...effective.env, ...overrides?.env } : undefined;
    const sourceOverrides = createConditionalObject({ ...overrides })
      .addOptional(effectiveApiKey === undefined ? undefined : { apiKey: effectiveApiKey })
      .addOptional(effectiveEnv === undefined ? undefined : { env: effectiveEnv })
      .finish();
    const configured = await source.getAuth(providerOrModel, sourceOverrides);
    const headers = mergeHeaders(effective.auth.headers, configured?.auth.headers);
    return Object.freeze({
      ...effective,
      auth: Object.freeze(
        createConditionalObject({ ...effective.auth })
          .addOptional(headers === undefined ? undefined : { headers })
          .finish(),
      ),
    });
  }

  const configuredHeaders = async (
    model: Model<Api>,
    apiKey: string | undefined,
    env: Readonly<Record<string, string>> | undefined,
  ): Promise<ProviderHeaders | undefined> => {
    const authOverrides = createConditionalObject({} as const)
      .addOptional(apiKey === undefined ? undefined : { apiKey })
      .addOptional(env === undefined ? undefined : { env })
      .finish();
    return (await getAuth(model, authOverrides))?.auth.headers;
  };

  function stream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ): AssistantMessageEventStream {
    const configured = createConditionalObject({ ...options })
      .add({
        transformHeaders: async (current: ProviderHeaders) => {
          const headers = await configuredHeaders(model, options?.apiKey, options?.env);
          let merged = mergeHeaders(current, headers) ?? {};
          merged = mergeHeaders(merged, options?.headers) ?? {};
          return options?.transformHeaders ? await options.transformHeaders(merged) : merged;
        },
      })
      .finish();
    // SAFETY: configured preserves the caller's exact API-specific options and
    // replaces only the Models-level transformHeaders member shared by every API.
    const requestOptions = configured as ModelsApiStreamOptions<TApi>;
    return projected.stream(model, context, requestOptions);
  }

  async function complete<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ): Promise<AssistantMessage> {
    return await stream(model, context, options).result();
  }

  function streamSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ): AssistantMessageEventStream {
    return projected.streamSimple(model, context, {
      ...options,
      transformHeaders: async (current) => {
        const headers = await configuredHeaders(model, options?.apiKey, options?.env);
        let merged = mergeHeaders(current, headers) ?? {};
        merged = mergeHeaders(merged, options?.headers) ?? {};
        return options?.transformHeaders ? await options.transformHeaders(merged) : merged;
      },
    });
  }

  async function completeSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ): Promise<AssistantMessage> {
    return await streamSimple(model, context, options).result();
  }

  return Object.freeze({
    getProviders: () => projected.getProviders(),
    getProvider: (providerId) => projected.getProvider(providerId),
    getModels: (providerId) => projected.getModels(providerId),
    getModel: (providerId, modelId) => projected.getModel(providerId, modelId),
    refresh: async (options) => await projected.refresh(options),
    checkAuth: async (providerId) => await projected.checkAuth(providerId),
    getAvailable: async (providerId) => await projected.getAvailable(providerId),
    getAuth,
    login: async (providerId, type, interaction) => await projected.login(providerId, type, interaction),
    logout: async (providerId) => await projected.logout(providerId),
    stream,
    complete,
    streamSimple,
    completeSimple,
  } satisfies Models);
}

/**
 * Projects Pi's composed providers into the exact catalog Noesis supports.
 * Provider objects remain Pi-owned; the projection only controls visibility,
 * refresh participation, and session-local native overrides.
 */
export function createNoesisPiModelCatalog(input: {
  readonly source: ModelRuntime;
  readonly credentials: CredentialStore;
  readonly modelsStore: ModelsStore;
}): NoesisPiModelCatalog {
  const models = createModels({ credentials: input.credentials, modelsStore: input.modelsStore });
  const nativeOverrides = new Map<string, Provider>();

  const synchronize = (): void => {
    models.clearProviders();
    for (const providerId of NOESIS_PROVIDER_IDS) {
      const source = input.source.getProvider(providerId);
      if (!source) throw new Error(`Pi does not provide required model provider ${providerId}`);
      const provider =
        nativeOverrides.get(providerId) ??
        (providerId === "opencode-go" ? composeNoesisOpenCodeGoProvider(source) : source);
      models.setProvider(provider);
    }
  };

  const catalog = Object.freeze({
    getProviders: () => models.getProviders(),
    getProvider: (providerId: string) => models.getProvider(providerId),
    getModels: (providerId?: string) => models.getModels(providerId),
    getModel: (providerId: string, modelId: string) => models.getModel(providerId, modelId),
    registerNativeProvider: (provider: Provider) => {
      if (!isNoesisProviderId(provider.id))
        throw new Error(`Noesis does not register unsupported Pi provider ${provider.id}`);
      nativeOverrides.set(provider.id, provider);
      models.setProvider(provider);
    },
  } satisfies PiModelCatalog);

  return Object.freeze({ catalog, models, synchronize });
}
