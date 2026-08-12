import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createPiModelServices,
  type NoesisAuthLoginCallbacks,
  type PiAuthOperations,
  type PiAuthStatus,
  preparePiModelSelection,
} from "@noesis/runtime-pi";
import {
  OnboardingCancelledError,
  type OnboardingChoice,
  type OnboardingPrompts,
  runFirstLaunchOnboarding,
  shouldAutoOnboard,
} from "../src/onboarding.ts";

interface ScriptedPrompts extends OnboardingPrompts {
  readonly notes: readonly string[];
}

function createScriptedPrompts(
  choices: string[],
  texts: string[],
  confirmations: boolean[],
): ScriptedPrompts {
  const notes: string[] = [];
  return {
    notes,
    async choose(_message, availableChoices: readonly OnboardingChoice[], _defaultId) {
      const answer = choices.shift();
      if (answer === undefined || !availableChoices.some((choice) => choice.id === answer))
        throw new Error(`Missing or invalid scripted choice ${String(answer)}`);
      return answer;
    },
    async text() {
      const answer = texts.shift();
      if (answer === undefined) throw new Error("Missing scripted text answer");
      return answer;
    },
    async confirm() {
      const answer = confirmations.shift();
      if (answer === undefined) throw new Error("Missing scripted confirmation");
      return answer;
    },
    note(message) {
      notes.push(message);
    },
  };
}

interface FakeAuth extends PiAuthOperations {
  readonly log: readonly string[];
}

function createDefaultPrompts(confirmations: boolean[]): ScriptedPrompts {
  const notes: string[] = [];
  return {
    notes,
    async choose(_message, availableChoices, defaultId) {
      if (!availableChoices.some((choice) => choice.id === defaultId))
        throw new Error(`Default choice ${defaultId} is not available`);
      return defaultId;
    },
    async text(_message, defaultValue) {
      return defaultValue;
    },
    async confirm() {
      const answer = confirmations.shift();
      if (answer === undefined) throw new Error("Missing scripted confirmation");
      return answer;
    },
    note(message) {
      notes.push(message);
    },
  };
}

function createFakeAuth(initial: PiAuthStatus): FakeAuth {
  const log: string[] = [];
  return {
    log,
    async login(providerId: string, _callbacks: NoesisAuthLoginCallbacks): Promise<PiAuthStatus> {
      log.push(`login:${providerId}`);
      return {
        provider: providerId,
        configured: true,
        source: providerId === "openai-codex" || providerId === "anthropic" ? "oauth" : "stored-api-key",
      };
    },
    async status(providerId: string): Promise<PiAuthStatus> {
      log.push(`status:${providerId}`);
      return { ...initial, provider: providerId };
    },
    async logout(providerId: string): Promise<void> {
      log.push(`logout:${providerId}`);
    },
  };
}

const authCallbacks: NoesisAuthLoginCallbacks = {
  prompt: async () => "unused-secret",
  notify: () => undefined,
};

const acceptModelSelection = (): void => undefined;

describe("first-launch onboarding", () => {
  test("authenticates Codex and atomically writes the complete schema-v1 config", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-onboarding-codex-"));
    const prompts = createDefaultPrompts([true]);
    const auth = createFakeAuth({ provider: "openai-codex", configured: false, source: "none" });

    const result = await runFirstLaunchOnboarding({
      home,
      prompts,
      auth,
      authCallbacks,
      validateModelSelection: acceptModelSelection,
    });

    expect(result.config).toEqual({
      schemaVersion: 1,
      agent: {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        thinkingLevel: "high",
      },
    });
    expect(auth.log).toEqual(["status:openai-codex", "login:openai-codex"]);
    const persisted = await readFile(join(home, "config.json"), "utf8");
    expect(JSON.parse(persisted)).toEqual(result.config);
    expect(persisted).not.toContain("unused-secret");
  });

  test("uses existing OpenRouter environment auth without requesting or persisting a key", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-onboarding-openrouter-"));
    const prompts = createScriptedPrompts(["openrouter", "low"], ["research-lab/future-model"], [true]);
    const auth = createFakeAuth({ provider: "openrouter", configured: true, source: "environment" });
    const models = createPiModelServices(home).models;

    const result = await runFirstLaunchOnboarding({
      home,
      prompts,
      auth,
      authCallbacks,
      validateModelSelection: (selection) => preparePiModelSelection(models, selection),
    });

    expect(result.config.agent).toEqual({
      provider: "openrouter",
      model: "research-lab/future-model",
      thinkingLevel: "low",
    });
    expect(auth.log).toEqual(["status:openrouter"]);
  });

  test("configures Claude with its recommended model and OAuth", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-onboarding-anthropic-"));
    const prompts = createScriptedPrompts(["anthropic", "claude-opus-4-8", "high"], [], [true]);
    const auth = createFakeAuth({ provider: "anthropic", configured: false, source: "none" });

    const result = await runFirstLaunchOnboarding({
      home,
      prompts,
      auth,
      authCallbacks,
      validateModelSelection: acceptModelSelection,
    });

    expect(result.config.agent).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
      thinkingLevel: "high",
    });
    expect(auth.log).toEqual(["status:anthropic", "login:anthropic"]);
    expect(prompts.notes.join("\n")).toContain("Claude Pro/Max OAuth");
  });

  test("configures OpenCode Zen with its recommended model and stored API key", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-onboarding-opencode-"));
    const prompts = createScriptedPrompts(["opencode", "kimi-k2.6", "high"], [], [true]);
    const auth = createFakeAuth({ provider: "opencode", configured: false, source: "none" });

    const result = await runFirstLaunchOnboarding({
      home,
      prompts,
      auth,
      authCallbacks,
      validateModelSelection: acceptModelSelection,
    });

    expect(result.config.agent).toEqual({
      provider: "opencode",
      model: "kimi-k2.6",
      thinkingLevel: "high",
    });
    expect(auth.log).toEqual(["status:opencode", "login:opencode"]);
  });

  test("rejects an unavailable model before confirmation, authentication, or config persistence", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-onboarding-invalid-model-"));
    const prompts = createScriptedPrompts(["anthropic", "custom"], ["stale-claude-model"], []);
    const auth = createFakeAuth({ provider: "anthropic", configured: false, source: "none" });
    const selections: Array<{ readonly provider: string; readonly model: string }> = [];

    await expect(
      runFirstLaunchOnboarding({
        home,
        prompts,
        auth,
        authCallbacks,
        validateModelSelection: (selection) => {
          selections.push(selection);
          throw new Error(`Unavailable model ${selection.provider}/${selection.model}`);
        },
      }),
    ).rejects.toThrow("Unavailable model anthropic/stale-claude-model");

    expect(selections).toEqual([{ provider: "anthropic", model: "stale-claude-model" }]);
    expect(auth.log).toEqual([]);
    expect(prompts.notes).toHaveLength(1);
    await expect(readFile(join(home, "config.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("cancellation happens before authentication and leaves config absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-onboarding-cancel-"));
    const prompts = createScriptedPrompts(["openai-codex", "gpt-5.6-sol", "high"], [], [false]);
    const auth = createFakeAuth({ provider: "openai-codex", configured: false, source: "none" });

    await expect(
      runFirstLaunchOnboarding({
        home,
        prompts,
        auth,
        authCallbacks,
        validateModelSelection: acceptModelSelection,
      }),
    ).rejects.toBeInstanceOf(OnboardingCancelledError);
    expect(auth.log).toEqual([]);
    await expect(readFile(join(home, "config.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("auto-runs only for an interactive, unconfigured TUI without explicit settings", () => {
    expect(
      shouldAutoOnboard({
        command: "tui",
        configExists: false,
        interactive: true,
        hasExplicitAgentSettings: false,
      }),
    ).toBe(true);
    for (const change of [
      { command: "inspect" },
      { configExists: true },
      { interactive: false },
      { hasExplicitAgentSettings: true },
    ])
      expect(
        shouldAutoOnboard({
          command: "tui",
          configExists: false,
          interactive: true,
          hasExplicitAgentSettings: false,
          ...change,
        }),
      ).toBe(false);
  });
});
