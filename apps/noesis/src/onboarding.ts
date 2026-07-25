import { initializeNoesisConfig, type NoesisConfig, type ThinkingLevel } from "@noesis/config";
import type { NoesisAuthLoginCallbacks, PiAuthOperations, PiAuthStatus } from "@noesis/runtime-pi";

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

export function shouldAutoOnboard(input: AutoOnboardingDecision): boolean {
  return (
    input.command === "tui" && !input.configExists && input.interactive && !input.hasExplicitAgentSettings
  );
}

function providerLabel(provider: string): string {
  return provider === "openai-codex" ? "OpenAI Codex OAuth" : "OpenRouter";
}

async function chooseModel(prompts: OnboardingPrompts, provider: string): Promise<string> {
  if (provider === "openai-codex") {
    const selection = await prompts.choose(
      "Choose a Codex model",
      [
        { id: "gpt-5.5", label: "GPT-5.5", description: "Recommended default" },
        { id: "gpt-5.4", label: "GPT-5.4" },
        { id: "custom", label: "Enter another model ID" },
      ],
      "gpt-5.5",
    );
    if (selection !== "custom") return selection;
    return await prompts.text("Codex model ID", "gpt-5.5");
  }
  return await prompts.text("OpenRouter model ID", "openai/gpt-5.5");
}

const THINKING_CHOICES: readonly OnboardingChoice[] = [
  { id: "off", label: "Off" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium", description: "Recommended default" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Maximum" },
];

function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_CHOICES.some((choice) => choice.id === value);
}

export async function runFirstLaunchOnboarding(input: {
  readonly home: string;
  readonly prompts: OnboardingPrompts;
  readonly auth: PiAuthOperations;
  readonly authCallbacks: NoesisAuthLoginCallbacks;
}): Promise<OnboardingResult> {
  const { prompts } = input;
  prompts.note("Welcome to Noesis. Let's configure your agent and authentication.");
  const provider = await prompts.choose(
    "Choose an AI provider",
    [
      {
        id: "openai-codex",
        label: "OpenAI Codex OAuth",
        description: "Sign in with your ChatGPT account",
      },
      {
        id: "openrouter",
        label: "OpenRouter",
        description: "Use OPENROUTER_API_KEY or securely store an API key",
      },
    ],
    "openai-codex",
  );
  if (provider !== "openai-codex" && provider !== "openrouter")
    throw new Error(`Unsupported onboarding provider ${provider}`);

  const model = (await chooseModel(prompts, provider)).trim();
  if (model.length === 0) throw new Error("Model ID cannot be empty");
  const thinkingLevel = await prompts.choose("Choose a reasoning level", THINKING_CHOICES, "medium");
  if (!isThinkingLevel(thinkingLevel)) throw new Error(`Unsupported reasoning level ${thinkingLevel}`);

  prompts.note(
    [
      "Configuration summary:",
      `  Provider: ${providerLabel(provider)}`,
      `  Model: ${model}`,
      `  Reasoning: ${thinkingLevel}`,
      "  Runtime: Pi AgentHarness",
    ].join("\n"),
  );
  if (!(await prompts.confirm("Authenticate and create this configuration?", true)))
    throw new OnboardingCancelledError();

  let authentication = await input.auth.status(provider);
  if (!authentication.configured) {
    prompts.note(
      provider === "openai-codex"
        ? "Starting Codex OAuth…"
        : "No OpenRouter credential was found. Enter an API key to store it securely.",
    );
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
