import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { NoesisAuthLoginCallbacks, PiAuthOperations, PiAuthStatus } from "@noesis/runtime-pi";
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

function createFakeAuth(initial: PiAuthStatus): FakeAuth {
  const log: string[] = [];
  return {
    log,
    async login(providerId: string, _callbacks: NoesisAuthLoginCallbacks): Promise<PiAuthStatus> {
      log.push(`login:${providerId}`);
      return {
        provider: providerId,
        configured: true,
        source: providerId === "openai-codex" ? "oauth" : "stored-api-key",
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

describe("first-launch onboarding", () => {
  test("authenticates Codex and atomically writes the complete schema-v1 config", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-onboarding-codex-"));
    const prompts = createScriptedPrompts(["openai-codex", "gpt-5.5", "medium"], [], [true]);
    const auth = createFakeAuth({ provider: "openai-codex", configured: false, source: "none" });

    const result = await runFirstLaunchOnboarding({ home, prompts, auth, authCallbacks });

    expect(result.config).toEqual({
      schemaVersion: 1,
      agent: {
        provider: "openai-codex",
        model: "gpt-5.5",
        thinkingLevel: "medium",
      },
    });
    expect(auth.log).toEqual(["status:openai-codex", "login:openai-codex"]);
    const persisted = await readFile(join(home, "config.json"), "utf8");
    expect(JSON.parse(persisted)).toEqual(result.config);
    expect(persisted).not.toContain("unused-secret");
  });

  test("uses existing OpenRouter environment auth without requesting or persisting a key", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-onboarding-openrouter-"));
    const prompts = createScriptedPrompts(["openrouter", "low"], ["anthropic/claude-sonnet-4"], [true]);
    const auth = createFakeAuth({ provider: "openrouter", configured: true, source: "environment" });

    const result = await runFirstLaunchOnboarding({ home, prompts, auth, authCallbacks });

    expect(result.config.agent).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      thinkingLevel: "low",
    });
    expect(auth.log).toEqual(["status:openrouter"]);
  });

  test("cancellation happens before authentication and leaves config absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-onboarding-cancel-"));
    const prompts = createScriptedPrompts(["openai-codex", "gpt-5.5", "medium"], [], [false]);
    const auth = createFakeAuth({ provider: "openai-codex", configured: false, source: "none" });

    await expect(runFirstLaunchOnboarding({ home, prompts, auth, authCallbacks })).rejects.toBeInstanceOf(
      OnboardingCancelledError,
    );
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
