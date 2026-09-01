import {
  createModels,
  type CredentialStore,
  type ModelsStore,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
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
