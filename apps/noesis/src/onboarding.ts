import {
  BUILT_IN_AGENT_DEFAULTS,
  initializeNoesisConfig,
  type NoesisConfig,
  type ThinkingLevel,
} from "@noesis/config";
import type {
  NoesisAuthLoginCallbacks,
  PiAuthOperations,
  PiAuthStatus,
  PiModelRoute,
} from "@noesis/runtime-pi";

export interface OnboardingChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface OnboardingPrompts {
  choose(message: string, choices: readonly OnboardingChoice[], defaultId: string): Promise<string>;
  text(message: string, defaultValue: string): Promise<string>;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  note(message: string): void;
}

export interface OnboardingResult {
  readonly config: NoesisConfig;
  readonly configPath: string;
  readonly authentication: PiAuthStatus;
}

export interface OnboardingModelSelection {
  readonly provider: string;
  readonly model: string;
}

export interface AutoOnboardingDecision {
  readonly command: string;
  readonly configExists: boolean;
  readonly interactive: boolean;
  readonly hasExplicitAgentSettings: boolean;
}

export class OnboardingCancelledError extends Error {
  constructor() {
    super("Onboarding cancelled; no configuration was written.");
    this.name = "OnboardingCancelledError";
  }
}

// SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
const ONBOARDING_PROVIDERS = Object.freeze({
  "openai-codex": Object.freeze({
    label: "OpenAI Codex OAuth",
    description: "Sign in with your ChatGPT account",
    modelPrompt: "Choose a Codex model",
    defaultModel: BUILT_IN_AGENT_DEFAULTS.model,
    models: Object.freeze([
      Object.freeze({
        id: BUILT_IN_AGENT_DEFAULTS.model,
        label: "GPT-5.6 Sol",
        description: "Recommended default",
      }),
      Object.freeze({ id: "gpt-5.5", label: "GPT-5.5" }),
      Object.freeze({ id: "gpt-5.4", label: "GPT-5.4" }),
    ]),
    missingAuth: "Starting Codex OAuth…",
  }),
  openrouter: Object.freeze({
    label: "OpenRouter",
    description: "Use OPENROUTER_API_KEY or securely store an API key",
    modelPrompt: "OpenRouter model ID",
    defaultModel: "openai/gpt-5.5",
    models: Object.freeze([]),
    missingAuth: "No OpenRouter credential was found. Enter an API key to store it securely.",
  }),
  anthropic: Object.freeze({
    label: "Claude (Anthropic)",
    description: "Claude Pro/Max OAuth or ANTHROPIC_API_KEY",
    modelPrompt: "Choose a Claude model",
    defaultModel: "claude-opus-4-8",
    models: Object.freeze([
      Object.freeze({ id: "claude-opus-4-8", label: "Claude Opus 4.8", description: "Recommended default" }),
      Object.freeze({ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }),
    ]),
    missingAuth: "Starting Claude Pro/Max OAuth. You can also set ANTHROPIC_API_KEY.",
  }),
  opencode: Object.freeze({
    label: "OpenCode Zen",
    description: "Use OPENCODE_API_KEY or securely store an API key",
    modelPrompt: "Choose an OpenCode Zen model",
    defaultModel: "kimi-k2.6",
    models: Object.freeze([
      Object.freeze({ id: "kimi-k2.6", label: "Kimi K2.6", description: "Recommended default" }),
      Object.freeze({ id: "kimi-k2.7-code", label: "Kimi K2.7 Code" }),
    ]),
    missingAuth: "No OpenCode Zen credential was found. Enter an API key to store it securely.",
  }),
  "opencode-go": Object.freeze({
    label: "OpenCode Go",
    description: "Use OPENCODE_GO_API_KEY or securely store a separate API key",
    modelPrompt: "Choose an OpenCode Go model",
    defaultModel: "kimi-k2.6",
    models: Object.freeze([
      Object.freeze({ id: "kimi-k2.6", label: "Kimi K2.6", description: "Recommended default" }),
      Object.freeze({ id: "kimi-k2.7-code", label: "Kimi K2.7 Code" }),
    ]),
    missingAuth: "No OpenCode Go credential was found. Enter an API key to store it securely.",
  }),
} as const);

type OnboardingProvider = keyof typeof ONBOARDING_PROVIDERS;

function isOnboardingProvider(value: string): value is OnboardingProvider {
  return Object.hasOwn(ONBOARDING_PROVIDERS, value);
}

export function shouldAutoOnboard(input: AutoOnboardingDecision): boolean {
  return (
    input.command === "tui" && !input.configExists && input.interactive && !input.hasExplicitAgentSettings
  );
}

async function chooseModel(
  prompts: OnboardingPrompts,
  provider: OnboardingProvider,
  routes: readonly PiModelRoute[],
): Promise<string> {
  const presentation = ONBOARDING_PROVIDERS[provider];
  const catalogModels = routes
    .filter((route) => route.provider === provider)
    .map((route): OnboardingChoice =>
      route.default
        ? { id: route.model, label: route.name, description: "Provider default" }
        : { id: route.model, label: route.name },
    );
  const catalogDefaultModel = routes.find((route) => route.provider === provider && route.default)?.model;
  const models = catalogModels.length > 0 ? catalogModels : presentation.models;
  if (models.length > 0) {
    const defaultModel = models.some((choice) => choice.id === presentation.defaultModel)
      ? presentation.defaultModel
      : catalogDefaultModel && models.some((choice) => choice.id === catalogDefaultModel)
        ? catalogDefaultModel
        : (models[0]?.id ?? presentation.defaultModel);
    const selection = await prompts.choose(
      presentation.modelPrompt,
      [...models, { id: "custom", label: "Enter another model ID" }],
      defaultModel,
    );
    if (selection !== "custom") return selection;
    return await prompts.text(`${presentation.label} model ID`, presentation.defaultModel);
  }
  return await prompts.text(presentation.modelPrompt, presentation.defaultModel);
}

const THINKING_CHOICES = Object.freeze([
  { id: "off", label: "Off" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High", description: "Recommended default" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Maximum" },
] as const satisfies readonly OnboardingChoice[]);

function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_CHOICES.some((choice) => choice.id === value);
}

export async function runFirstLaunchOnboarding(input: {
  readonly home: string;
  readonly prompts: OnboardingPrompts;
  readonly auth: PiAuthOperations;
  readonly authCallbacks: NoesisAuthLoginCallbacks;
  readonly validateModelSelection: (selection: OnboardingModelSelection) => void;
  readonly modelRoutes?: readonly PiModelRoute[];
}): Promise<OnboardingResult> {
  const { prompts } = input;
  prompts.note("Welcome to Noesis. Let's configure your agent and authentication.");
  const provider = await prompts.choose(
    "Choose an AI provider",
    Object.entries(ONBOARDING_PROVIDERS).map(([id, presentation]) => ({
      id,
      label: presentation.label,
      description: presentation.description,
    })),
    "openai-codex",
  );
  if (!isOnboardingProvider(provider)) throw new Error(`Unsupported onboarding provider ${provider}`);

  const model = (await chooseModel(prompts, provider, input.modelRoutes ?? [])).trim();
  if (model.length === 0) throw new Error("Model ID cannot be empty");
  input.validateModelSelection({ provider, model });
  const selectedRoute = input.modelRoutes?.find(
    (route) => route.provider === provider && route.model === model,
  );
  const thinkingChoices = selectedRoute
    ? THINKING_CHOICES.filter((choice) => selectedRoute.thinkingLevels.includes(choice.id))
    : THINKING_CHOICES;
  const defaultThinkingLevel = thinkingChoices.some(
    (choice) => choice.id === BUILT_IN_AGENT_DEFAULTS.thinkingLevel,
  )
    ? BUILT_IN_AGENT_DEFAULTS.thinkingLevel
    : (thinkingChoices.at(-1)?.id ?? "off");
  const thinkingLevel = await prompts.choose(
    "Choose a reasoning level",
    thinkingChoices,
    defaultThinkingLevel,
  );
  if (!isThinkingLevel(thinkingLevel)) throw new Error(`Unsupported reasoning level ${thinkingLevel}`);

  prompts.note(
    [
      "Configuration summary:",
      `  Provider: ${ONBOARDING_PROVIDERS[provider].label}`,
      `  Model: ${model}`,
      `  Reasoning: ${thinkingLevel}`,
      "  Runtime: Pi AgentHarness",
    ].join("\n"),
  );
  if (!(await prompts.confirm("Authenticate and create this configuration?", true)))
    throw new OnboardingCancelledError();

  let authentication = await input.auth.status(provider);
  if (!authentication.configured) {
    prompts.note(ONBOARDING_PROVIDERS[provider].missingAuth);
    authentication = await input.auth.login(provider, input.authCallbacks);
  } else {
    prompts.note(`Using existing ${authentication.source} authentication for ${provider}.`);
  }

  const config: NoesisConfig = {
    schemaVersion: 1,
    agent: {
      provider,
      model,
      thinkingLevel,
    },
  };
  const configPath = await initializeNoesisConfig(input.home, config);
  prompts.note(`Noesis is ready. Configuration written to ${configPath}.`);
  return { config, configPath, authentication };
}
