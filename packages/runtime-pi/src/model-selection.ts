import type { Api, Model, MutableModels, Provider } from "@earendil-works/pi-ai";

export interface PiModelSelection {
  readonly provider: string;
  readonly model: string;
}

function providerWithCustomModel(provider: Provider, modelId: string): Provider {
  const known = provider.getModels();
  const template = known[0];
  if (!template)
    throw new Error(`Provider ${provider.id} has no model metadata for custom model ${modelId}.`);
  const custom: Model<Api> = Object.freeze({ ...template, id: modelId, name: modelId });
  return Object.freeze({
    ...provider,
    getModels: () => Object.freeze([...known, custom]),
  });
}

function supportsCustomModelIds(provider: Provider): boolean {
  return provider.id === "openrouter";
}

export function preparePiModelSelection(models: MutableModels, selection: PiModelSelection): void {
  if (selection.provider.trim() !== selection.provider || selection.provider.length === 0)
    throw new Error("Pi provider ID must be a non-empty string without leading or trailing whitespace.");
  if (selection.model.trim() !== selection.model || selection.model.length === 0)
    throw new Error("Pi model ID must be a non-empty string without leading or trailing whitespace.");
  const provider = models.getProvider(selection.provider);
  if (!provider) {
    const supported = models
      .getProviders()
      .map((candidate) => candidate.id)
      .sort((left, right) => left.localeCompare(right));
    throw new Error(
      `Unknown Pi provider ${selection.provider}. Supported providers: ${supported.join(", ")}.`,
    );
  }
  if (models.getModel(selection.provider, selection.model)) return;

  const otherProviders = models
    .getModels()
    .filter((model) => model.id === selection.model && model.provider !== selection.provider)
    .map((model) => model.provider)
    .filter((candidate, index, all) => all.indexOf(candidate) === index)
    .sort((left, right) => left.localeCompare(right));
  if (otherProviders.length === 0 && supportsCustomModelIds(provider)) {
    models.setProvider(providerWithCustomModel(provider, selection.model));
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
