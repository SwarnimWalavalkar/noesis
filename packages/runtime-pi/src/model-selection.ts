import type { Models } from "@earendil-works/pi-ai";

export interface PiModelSelection {
  readonly provider: string;
  readonly model: string;
}

export function assertPiModelSelection(models: Models, selection: PiModelSelection): void {
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

  const examples = models
    .getModels(provider.id)
    .slice(0, 5)
    .map((model) => model.id);
  const suffix = examples.length > 0 ? ` Available models include: ${examples.join(", ")}.` : "";
  throw new Error(
    `Model ${selection.model} is not available from provider ${selection.provider}. Choose a matching model with --model. To persist the pair, run \`noesis config set --provider ${selection.provider} --model MODEL\`.${suffix}`,
  );
}
