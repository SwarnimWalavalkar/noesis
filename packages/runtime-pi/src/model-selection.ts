import { getSupportedThinkingLevels, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentThinkingLevel } from "@noesis/agent-types";
import { isNoesisProviderId, NOESIS_PROVIDER_IDS } from "./provider-ids.ts";

export interface PiModelSelection {
  readonly provider: string;
  readonly model: string;
}

export interface PiModelRoute {
  readonly provider: string;
  readonly providerName: string;
  readonly model: string;
  readonly name: string;
  readonly thinkingLevels: readonly AgentThinkingLevel[];
  readonly default: boolean;
  readonly allowsCustomModelIds: boolean;
}

/** Converts Pi's mutable catalog into the plain, read-only model surface consumed by the TUI. */
export function listPiModelRoutes(models: ModelRuntime): readonly PiModelRoute[] {
  const defaults = new Map(
    models
      .getProviders()
      .filter((provider) => isNoesisProviderId(provider.id))
      .flatMap((provider) => {
        const first = provider.getModels()[0];
        return first ? [[provider.id, first.id] as const] : [];
      }),
  );
  return Object.freeze(
    models
      .getModels()
      .filter((model) => isNoesisProviderId(model.provider))
      .map((model) =>
        Object.freeze({
          provider: model.provider,
          providerName: models.getProvider(model.provider)?.name ?? model.provider,
          model: model.id,
          name: model.name,
          thinkingLevels: Object.freeze(getSupportedThinkingLevels(model)),
          default: defaults.get(model.provider) === model.id,
          allowsCustomModelIds: model.provider === "openrouter",
        }),
      )
      .sort(
        (left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model),
      ),
  );
}

function providerWithCustomModel(provider: Provider, modelId: string): Provider {
  const template = provider.getModels()[0];
  if (!template)
    throw new Error(`Provider ${provider.id} has no model metadata for custom model ${modelId}.`);
  const custom: Model<Api> = Object.freeze({ ...template, id: modelId, name: modelId });
  return Object.freeze({
    ...provider,
    getModels: () => {
      const known = provider.getModels();
      return known.some((model) => model.id === modelId) ? known : Object.freeze([...known, custom]);
    },
  });
}

function supportsCustomModelIds(provider: Provider): boolean {
  return provider.id === "openrouter";
}

export function preparePiModelSelection(models: ModelRuntime, selection: PiModelSelection): void {
  if (selection.provider.trim() !== selection.provider || selection.provider.length === 0)
    throw new Error("Pi provider ID must be a non-empty string without leading or trailing whitespace.");
  if (selection.model.trim() !== selection.model || selection.model.length === 0)
    throw new Error("Pi model ID must be a non-empty string without leading or trailing whitespace.");
  const provider = isNoesisProviderId(selection.provider)
    ? models.getProvider(selection.provider)
    : undefined;
  if (!provider) {
    const supported = [...NOESIS_PROVIDER_IDS].sort((left, right) => left.localeCompare(right));
    throw new Error(
      `Unknown Pi provider ${selection.provider}. Supported providers: ${supported.join(", ")}.`,
    );
  }
  if (models.getModel(selection.provider, selection.model)) return;

  const otherProviders = models
    .getModels()
    .filter(
      (model) =>
        model.id === selection.model &&
        model.provider !== selection.provider &&
        isNoesisProviderId(model.provider),
    )
    .map((model) => model.provider)
    .filter((candidate, index, all) => all.indexOf(candidate) === index)
    .sort((left, right) => left.localeCompare(right));
  if (otherProviders.length === 0 && supportsCustomModelIds(provider)) {
    models.registerNativeProvider(providerWithCustomModel(provider, selection.model));
    return;
  }

  const examples = provider
    .getModels()
    .slice(0, 5)
    .map((model) => model.id);
  const suffix = examples.length > 0 ? ` Available models include: ${examples.join(", ")}.` : "";
  const mismatch =
    otherProviders.length > 0
      ? `Model ${selection.model} belongs to ${otherProviders.join(", ")}, not provider ${selection.provider}.`
      : `Model ${selection.model} is not available from provider ${selection.provider}.`;
  throw new Error(
    `${mismatch} Choose a matching model with --model. To persist the pair, run \`noesis config set --provider ${selection.provider} --model MODEL\`.${suffix}`,
  );
}
