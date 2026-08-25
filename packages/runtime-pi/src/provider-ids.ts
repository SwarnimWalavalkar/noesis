export const NOESIS_PROVIDER_IDS = Object.freeze([
  "openai-codex",
  "anthropic",
  "openrouter",
  "opencode",
  "opencode-go",
] as const);

export type NoesisProviderId = (typeof NOESIS_PROVIDER_IDS)[number];

export function isNoesisProviderId(providerId: string): providerId is NoesisProviderId {
  return NOESIS_PROVIDER_IDS.some((candidate) => candidate === providerId);
}
