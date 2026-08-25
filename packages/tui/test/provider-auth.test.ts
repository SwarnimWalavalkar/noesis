import type { NoesisAgentRuntime } from "@noesis/agent-types";
import { Container, TUI } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import {
  createSelectTheme,
  createTuiProviderAuthOrchestration,
  type NoesisTuiRuntime,
} from "../src/index.ts";
import { createInMemoryTestRuntime } from "./support/in-memory-runtime.ts";
import { createTestTerminal } from "./support/test-terminal.ts";

const agent: NoesisAgentRuntime = {
  name: "provider-auth-test",
  async run(request) {
    return {
      text: request.prompt,
      provider: request.provider,
      model: request.model,
      outcome: "completed",
      stopReason: "stop",
    };
  },
  async steer() {
    return {
      status: "consumed",
      timelineSequence: 1,
      consumedAt: "2026-08-25T00:00:00.000Z",
    };
  },
  async abort() {},
};

function createHarness() {
  const terminal = createTestTerminal();
  const tui = new TUI(terminal);
  tui.addChild(new Container());
  tui.start();
  return { terminal, tui };
}

describe("provider authentication overlay", () => {
  test("masks an API key and keeps it out of the transcript while storing it through the runtime", async () => {
    const base = createInMemoryTestRuntime(agent);
    const trail = await base.startTrail({ title: "secret-safe authentication" });
    const secret = "sk-noesis-never-render-this-value";
    let received: string | undefined;
    const runtime = Object.freeze({
      ...base,
      providerAuthStatus: async (provider: string) => ({
        provider,
        configured: false,
        source: "none" as const,
      }),
      authenticateProvider: async (
        provider: string,
        callbacks: Parameters<NonNullable<NoesisTuiRuntime["authenticateProvider"]>>[1],
      ) => {
        received = await callbacks.prompt({
          type: "secret",
          message: "Paste your OpenRouter API key",
        });
        return { provider, configured: true, source: "stored-api-key" as const };
      },
    });
    const { terminal, tui } = createHarness();
    const auth = createTuiProviderAuthOrchestration({
      runtime,
      tui,
      theme: createSelectTheme(false),
      colorEnabled: false,
    });

    const result = auth.ensure("openrouter", "OpenRouter");
    await vi.waitFor(() => expect(terminal.output).toContain("Paste your OpenRouter API key"));
    terminal.send(`\u001b[200~${secret}\u001b[201~`);
    await vi.waitFor(() => expect(terminal.output).toContain("•".repeat(secret.length)));
    terminal.type("\r");

    await expect(result).resolves.toBe(true);
    expect(received).toBe(secret);
    expect(terminal.output).not.toContain(secret);
    expect(await runtime.getTranscript(trail.trailId)).toEqual([]);
    auth.dispose();
    tui.stop();
  });

  test("continues without opening a modal when the provider is already configured", async () => {
    const base = createInMemoryTestRuntime(agent);
    const authenticateProvider = vi.fn();
    const runtime = Object.freeze({
      ...base,
      providerAuthStatus: async (provider: string) => ({
        provider,
        configured: true,
        source: "environment" as const,
      }),
      authenticateProvider,
    });
    const { terminal, tui } = createHarness();
    const auth = createTuiProviderAuthOrchestration({
      runtime,
      tui,
      theme: createSelectTheme(false),
      colorEnabled: false,
    });

    await expect(auth.ensure("openrouter", "OpenRouter")).resolves.toBe(true);
    expect(authenticateProvider).not.toHaveBeenCalled();
    expect(terminal.output).not.toContain("AUTHENTICATE");
    auth.dispose();
    tui.stop();
  });

  test("cancels the provider login when Escape closes the modal", async () => {
    const base = createInMemoryTestRuntime(agent);
    let loginSignal: AbortSignal | undefined;
    const runtime = Object.freeze({
      ...base,
      providerAuthStatus: async (provider: string) => ({
        provider,
        configured: false,
        source: "none" as const,
      }),
      authenticateProvider: async (
        provider: string,
        callbacks: Parameters<NonNullable<NoesisTuiRuntime["authenticateProvider"]>>[1],
      ) => {
        loginSignal = callbacks.signal;
        if (!callbacks.signal) throw new Error("Expected the authentication signal");
        await callbacks.prompt({
          type: "secret",
          message: "Paste API key",
          signal: callbacks.signal,
        });
        return { provider, configured: true, source: "stored-api-key" as const };
      },
    });
    const { terminal, tui } = createHarness();
    const auth = createTuiProviderAuthOrchestration({
      runtime,
      tui,
      theme: createSelectTheme(false),
      colorEnabled: false,
    });

    const result = auth.ensure("openrouter", "OpenRouter");
    await vi.waitFor(() => expect(terminal.output).toContain("Paste API key"));
    terminal.send("\u001b");

    await expect(result).resolves.toBe(false);
    expect(loginSignal?.aborted).toBe(true);
    auth.dispose();
    tui.stop();
  });

  test("starts an OAuth flow in the modal and keeps its callback receipt provider-neutral", async () => {
    const base = createInMemoryTestRuntime(agent);
    const release = Promise.withResolvers<void>();
    const opened: string[] = [];
    let callbackPage: string | undefined;
    const runtime = Object.freeze({
      ...base,
      providerAuthStatus: async (provider: string) => ({
        provider,
        configured: false,
        source: "none" as const,
      }),
      authenticateProvider: async (
        provider: string,
        callbacks: Parameters<NonNullable<NoesisTuiRuntime["authenticateProvider"]>>[1],
      ) => {
        callbacks.notify({
          type: "auth_url",
          url: "https://auth.example/authorize",
          instructions: "Complete sign-in in the browser.",
        });
        callbackPage = callbacks.renderOAuthCallbackPage?.({
          provider: "openai-codex",
          status: "success",
        });
        await release.promise;
        return { provider, configured: true, source: "oauth" as const };
      },
    });
    const { terminal, tui } = createHarness();
    const auth = createTuiProviderAuthOrchestration({
      runtime,
      tui,
      theme: createSelectTheme(false),
      colorEnabled: false,
      openUrl: async (url) => {
        opened.push(url);
      },
      renderOAuthCallbackPage: () => "oauth callback received",
    });

    const result = auth.ensure("openai-codex", "OpenAI Codex OAuth");
    await vi.waitFor(() => expect(terminal.output).toContain("Sign-in URL"));
    expect(opened).toEqual(["https://auth.example/authorize"]);
    expect(callbackPage).toBe("oauth callback received");
    release.resolve();
    await expect(result).resolves.toBe(true);
    auth.dispose();
    tui.stop();
  });

  test("redacts a submitted secret from authentication failures", async () => {
    const base = createInMemoryTestRuntime(agent);
    const secret = "secret-that-provider-echoed";
    const runtime = Object.freeze({
      ...base,
      providerAuthStatus: async (provider: string) => ({
        provider,
        configured: false,
        source: "none" as const,
      }),
      authenticateProvider: async (
        _provider: string,
        callbacks: Parameters<NonNullable<NoesisTuiRuntime["authenticateProvider"]>>[1],
      ) => {
        const submitted = await callbacks.prompt({ type: "secret", message: "Paste API key" });
        throw new Error(`Provider rejected ${submitted}`);
      },
    });
    const { terminal, tui } = createHarness();
    const auth = createTuiProviderAuthOrchestration({
      runtime,
      tui,
      theme: createSelectTheme(false),
      colorEnabled: false,
    });

    const result = auth.ensure("openrouter", "OpenRouter");
    await vi.waitFor(() => expect(terminal.output).toContain("Paste API key"));
    terminal.type(`${secret}\r`);

    await expect(result).rejects.toThrow("Provider rejected [redacted]");
    expect(terminal.output).not.toContain(secret);
    auth.dispose();
    tui.stop();
  });

  test("redacts a submitted secret from later provider notifications", async () => {
    const base = createInMemoryTestRuntime(agent);
    const secret = "secret-that-provider-reported";
    const release = Promise.withResolvers<void>();
    const runtime = Object.freeze({
      ...base,
      providerAuthStatus: async (provider: string) => ({
        provider,
        configured: false,
        source: "none" as const,
      }),
      authenticateProvider: async (
        provider: string,
        callbacks: Parameters<NonNullable<NoesisTuiRuntime["authenticateProvider"]>>[1],
      ) => {
        const submitted = await callbacks.prompt({ type: "secret", message: "Paste API key" });
        callbacks.notify({ type: "progress", message: `Validating ${submitted}` });
        await release.promise;
        return { provider, configured: true, source: "stored-api-key" as const };
      },
    });
    const { terminal, tui } = createHarness();
    const auth = createTuiProviderAuthOrchestration({
      runtime,
      tui,
      theme: createSelectTheme(false),
      colorEnabled: false,
    });

    const result = auth.ensure("openrouter", "OpenRouter");
    await vi.waitFor(() => expect(terminal.output).toContain("Paste API key"));
    terminal.type(`${secret}\r`);
    await vi.waitFor(() => expect(terminal.output).toContain("Validating [redacted]"));

    expect(terminal.output).not.toContain(secret);
    release.resolve();
    await expect(result).resolves.toBe(true);
    auth.dispose();
    tui.stop();
  });
});
