import { describe, expect, test, vi } from "vitest";
import {
  OnboardingInterruptedError,
  type OnboardingSurface,
  runNoesisOnboardingTui,
} from "../src/onboarding.ts";
import {
  createTestTerminal,
  type TestTerminal,
} from "./support/test-terminal.ts";

const DOWN = "\u001b[B";
const ENTER = "\r";
const CTRL_C = "\u0003";

const PROVIDERS = [
  {
    id: "openai-codex",
    label: "OpenAI Codex OAuth",
    description: "Sign in with your ChatGPT account",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "Use an OpenRouter API key",
  },
] as const;

async function waitForOutput(
  terminal: TestTerminal,
  text: string,
): Promise<void> {
  await vi.waitFor(() => expect(terminal.output).toContain(text));
}

describe("first-launch onboarding surface", () => {
  test("brands the flow and records each answered question in the transcript", async () => {
    const terminal = createTestTerminal();
    const running = runNoesisOnboardingTui(async (surface) => {
      surface.note("Welcome to Noesis.");
      const provider = await surface.choose(
        "Choose an AI provider",
        PROVIDERS,
        "openai-codex",
      );
      const model = await surface.text("Model ID", "gpt-5.6-sol");
      return { provider, model };
    }, terminal);

    await waitForOutput(terminal, "███╗   ██╗ ██████╗");
    expect(terminal.output).toContain("first-launch setup");
    expect(terminal.output).toContain("Welcome to Noesis.");
    expect(terminal.output).toContain("Choose an AI provider");
    expect(terminal.output).toContain("Sign in with your ChatGPT account");
    expect(terminal.output).toContain(
      "↑/↓ navigate · 1-9 jump · Enter select · Ctrl+C cancel",
    );

    terminal.send(DOWN);
    terminal.send(ENTER);
    await waitForOutput(terminal, "✓ Choose an AI provider · OpenRouter");
    await waitForOutput(terminal, "Enter accept · Ctrl+C cancel");

    terminal.send(ENTER);

    await expect(running).resolves.toEqual({
      provider: "openrouter",
      model: "gpt-5.6-sol",
    });
    expect(terminal.stops).toBe(1);
    expect(terminal.drains).toBe(1);
  });

  test("number keys select a listed choice directly", async () => {
    const terminal = createTestTerminal();
    const running = runNoesisOnboardingTui(
      async (surface) =>
        await surface.choose(
          "Choose an AI provider",
          PROVIDERS,
          "openai-codex",
        ),
      terminal,
    );

    await waitForOutput(terminal, "Choose an AI provider");
    terminal.send("2");

    await expect(running).resolves.toBe("openrouter");
  });

  test("a prefilled default accepts on Enter and extends rather than prefixes when edited", async () => {
    const terminal = createTestTerminal();
    const running = runNoesisOnboardingTui(
      async (surface) => await surface.text("Model ID", "gpt-5.6"),
      terminal,
    );

    await waitForOutput(terminal, "Model ID");
    terminal.type("-sol");
    terminal.send(ENTER);

    await expect(running).resolves.toBe("gpt-5.6-sol");
  });

  test("confirmation offers Yes and No instead of typed letters", async () => {
    const terminal = createTestTerminal();
    const running = runNoesisOnboardingTui(
      async (surface) =>
        await surface.confirm(
          "Authenticate and create this configuration?",
          true,
        ),
      terminal,
    );

    await waitForOutput(
      terminal,
      "Authenticate and create this configuration?",
    );
    expect(terminal.output).toContain("Yes");
    expect(terminal.output).toContain("No");

    terminal.send(DOWN);
    terminal.send(ENTER);

    await expect(running).resolves.toBe(false);
    expect(terminal.output).toContain(
      "✓ Authenticate and create this configuration? · No",
    );
  });

  test("secret entry is masked in the live prompt and in the completed transcript", async () => {
    const terminal = createTestTerminal();
    const running = runNoesisOnboardingTui(async (surface) => {
      const key = await surface.secret("Enter OpenRouter API key");
      surface.note("Stored.");
      return key;
    }, terminal);

    await waitForOutput(terminal, "Enter OpenRouter API key");
    expect(terminal.output).toContain(
      "Input hidden · Enter accept · Ctrl+C cancel",
    );
    terminal.type("sk-secret-value");
    await waitForOutput(terminal, "•••");
    terminal.send(ENTER);

    await expect(running).resolves.toBe("sk-secret-value");
    expect(terminal.output).not.toContain("sk-secret-value");
  });

  test("a reference URL is chunked on column boundaries so no character is dropped", async () => {
    const terminal = createTestTerminal();
    const url = `https://auth.openai.com/oauth/authorize?client_id=${"a".repeat(120)}&state=abc123`;
    const running = runNoesisOnboardingTui(async (surface) => {
      surface.reference("Open this URL:", url);
      return await surface.confirm("Done?", true);
    }, terminal);

    await waitForOutput(terminal, "Open this URL:");
    for (let index = 0; index < url.length; index += terminal.columns)
      expect(terminal.output).toContain(
        url.slice(index, index + terminal.columns),
      );

    terminal.send(ENTER);
    await running;
  });

  test("a slow step raises a spinner labelled by the most recent note", async () => {
    const terminal = createTestTerminal();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = runNoesisOnboardingTui(async (surface) => {
      surface.note("Starting Codex OAuth…");
      await gate;
      return "done";
    }, terminal);

    await waitForOutput(terminal, "⠋");
    expect(terminal.output).toContain("Starting Codex OAuth");

    release?.();
    await expect(running).resolves.toBe("done");
  });

  test("Ctrl+C interrupts the flow, aborts the surface signal, and restores the terminal", async () => {
    const terminal = createTestTerminal();
    let observed: OnboardingSurface | undefined;
    const running = runNoesisOnboardingTui(async (surface) => {
      observed = surface;
      return await surface.choose(
        "Choose an AI provider",
        PROVIDERS,
        "openai-codex",
      );
    }, terminal);

    await waitForOutput(terminal, "Choose an AI provider");
    terminal.send(CTRL_C);

    await expect(running).rejects.toBeInstanceOf(OnboardingInterruptedError);
    expect(observed?.signal.aborted).toBe(true);
    expect(terminal.stops).toBe(1);
  });

  test("an already aborted caller signal rejects the prompt without waiting for input", async () => {
    const terminal = createTestTerminal();
    const running = runNoesisOnboardingTui(
      async (surface) =>
        await surface.text("Paste the authorization code", "", {
          signal: AbortSignal.abort(),
        }),
      terminal,
    );

    await expect(running).rejects.toBeInstanceOf(OnboardingInterruptedError);
    expect(terminal.stops).toBe(1);
  });

  test("collapses the wordmark on the final frame so the app it hands off to owns the banner", async () => {
    const terminal = createTestTerminal();
    const running = runNoesisOnboardingTui(async (surface) => {
      const provider = await surface.choose(
        "Choose an AI provider",
        PROVIDERS,
        "openai-codex",
      );
      surface.note("Noesis is ready.");
      return provider;
    }, terminal);

    await waitForOutput(terminal, "███╗   ██╗ ██████╗");
    const handoff = terminal.output.length;
    terminal.send(ENTER);
    await expect(running).resolves.toBe("openai-codex");

    const finalFrames = terminal.output.slice(handoff);
    expect(finalFrames).toContain("NOESIS  first-launch setup");
    expect(finalFrames).toContain("Noesis is ready.");
    expect(finalFrames).not.toContain("███╗   ██╗ ██████╗");
  });

  test("a compact terminal drops the wordmark but keeps the question and choices", async () => {
    const terminal = createTestTerminal();
    terminal.resize(50, 10);
    const running = runNoesisOnboardingTui(
      async (surface) =>
        await surface.choose(
          "Choose an AI provider",
          PROVIDERS,
          "openai-codex",
        ),
      terminal,
    );

    await waitForOutput(terminal, "NOESIS  first-launch setup");
    expect(terminal.output).not.toContain("███╗   ██╗ ██████╗");
    expect(terminal.output).toContain("OpenRouter");

    terminal.send(ENTER);
    await expect(running).resolves.toBe("openai-codex");
  });
});
