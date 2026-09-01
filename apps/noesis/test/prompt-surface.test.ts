import { describe, expect, test, vi } from "vitest";
import type { OnboardingSurface } from "@noesis/tui";
import {
  createSurfaceAuthCallbacks,
  defaultAuthOptionId,
  promptsFromSurface,
} from "../src/prompt-surface.ts";

function createSurface(overrides: Partial<OnboardingSurface> = {}): OnboardingSurface {
  return {
    signal: new AbortController().signal,
    choose: vi.fn(async () => "chosen"),
    text: vi.fn(async () => "typed"),
    secret: vi.fn(async () => "secret"),
    confirm: vi.fn(async () => true),
    note: vi.fn(),
    reference: vi.fn(),
    ...overrides,
  };
}

describe("prompt surface adapters", () => {
  test("defaultAuthOptionId prefers the labeled default option", () => {
    expect(
      defaultAuthOptionId({
        type: "select",
        message: "Login method",
        options: [
          { id: "device", label: "Device code" },
          { id: "browser", label: "Browser login (default)" },
        ],
      }),
    ).toBe("browser");
  });

  test("createSurfaceAuthCallbacks routes prompts and auth events through the surface", async () => {
    const surface = createSurface({
      choose: vi.fn(async () => "browser"),
      secret: vi.fn(async () => "sk-test"),
    });
    const openUrl = vi.fn(() => true);
    const callbacks = createSurfaceAuthCallbacks(surface, {
      openUrl,
    });

    expect(callbacks.signal).toBe(surface.signal);
    await expect(
      callbacks.prompt({
        type: "select",
        message: "Select OpenAI Codex login method:",
        options: [
          { id: "browser", label: "Browser login (default)" },
          { id: "device", label: "Device code" },
        ],
      }),
    ).resolves.toBe("browser");
    expect(surface.choose).toHaveBeenCalledWith(
      "Select OpenAI Codex login method:",
      [
        { id: "browser", label: "Browser login (default)" },
        { id: "device", label: "Device code" },
      ],
      "browser",
      {},
    );

    await expect(
      callbacks.prompt({
        type: "secret",
        message: "Enter OpenRouter API key",
        placeholder: "sk-...",
      }),
    ).resolves.toBe("sk-test");
    expect(surface.secret).toHaveBeenCalledWith("Enter OpenRouter API key (sk-...)", {});

    callbacks.notify({
      type: "auth_url",
      url: "https://auth.example/authorize",
      instructions: "Complete login in your browser.",
    });
    expect(openUrl).toHaveBeenCalledWith("https://auth.example/authorize");
    expect(surface.note).toHaveBeenCalledWith("Opening your browser to finish sign-in.");
    expect(surface.reference).toHaveBeenCalledWith(
      "If nothing opened, use this URL:",
      "https://auth.example/authorize",
    );
    expect(surface.note).toHaveBeenCalledWith("Complete login in your browser.");
  });

  test("promptsFromSurface preserves empty text answers as the default", async () => {
    const surface = createSurface({
      text: vi.fn(async () => "   "),
      confirm: vi.fn(async () => false),
    });
    const prompts = promptsFromSurface(surface);

    await expect(prompts.text("Model ID", "gpt-5.6-sol")).resolves.toBe("gpt-5.6-sol");
    await expect(prompts.confirm("Continue?", true)).resolves.toBe(false);
    prompts.note("hello");
    expect(surface.note).toHaveBeenCalledWith("hello");
  });
});
