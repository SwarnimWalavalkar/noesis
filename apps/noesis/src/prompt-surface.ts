import type { NoesisAuthLoginCallbacks, NoesisAuthPrompt } from "@noesis/runtime-pi";
import type { OnboardingSurface } from "@noesis/tui";
import type { BrowserUrlOpener } from "./browser-auth.ts";
import { presentAuthEvent } from "./browser-auth.ts";
import type { OnboardingPrompts } from "./onboarding.ts";

export function defaultAuthOptionId(prompt: NoesisAuthPrompt & { readonly type: "select" }): string {
  const preferred =
    prompt.options.find((option) => option.label.toLowerCase().includes("(default)")) ?? prompt.options[0];
  if (!preferred) throw new Error(`Authentication selection prompt has no options: ${prompt.message}`);
  return preferred.id;
}

/** Adapt the shared prompt surface to the auth login callback port. */
export function createSurfaceAuthCallbacks(
  surface: OnboardingSurface,
  options: { readonly openUrl: BrowserUrlOpener },
): NoesisAuthLoginCallbacks {
  return {
    signal: surface.signal,
    prompt: async (prompt) => {
      const promptOptions = prompt.signal ? { signal: prompt.signal } : {};
      if (prompt.type === "select")
        return await surface.choose(
          prompt.message,
          prompt.options,
          defaultAuthOptionId(prompt),
          promptOptions,
        );
      const message = `${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}`;
      return prompt.type === "secret"
        ? await surface.secret(message, promptOptions)
        : await surface.text(message, "", promptOptions);
    },
    notify: (event) =>
      presentAuthEvent(event, {
        openUrl: options.openUrl,
        note: (message) => surface.note(message),
        reference: (label, value) => surface.reference(label, value),
      }),
  };
}

/** Adapt the shared prompt surface to first-launch onboarding prompts. */
export function promptsFromSurface(surface: OnboardingSurface): OnboardingPrompts {
  return {
    choose: async (message, choices, defaultId) => await surface.choose(message, choices, defaultId),
    text: async (message, defaultValue) => {
      const answer = (await surface.text(message, defaultValue)).trim();
      return answer.length === 0 ? defaultValue : answer;
    },
    confirm: async (message, defaultValue) => await surface.confirm(message, defaultValue),
    note: (message) => surface.note(message),
  };
}
