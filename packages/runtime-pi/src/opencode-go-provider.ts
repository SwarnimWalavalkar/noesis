import { envApiKeyAuth, type Provider } from "@earendil-works/pi-ai";

const OPENCODE_GO_PROVIDER_ID = "opencode-go";

/**
 * Keeps Pi's OpenCode Go catalog and transport intact while applying Noesis's
 * distinct label and credential source.
 */
export function composeNoesisOpenCodeGoProvider(provider: Provider): Provider {
  if (provider.id !== OPENCODE_GO_PROVIDER_ID)
    throw new Error(`Expected Pi provider ${OPENCODE_GO_PROVIDER_ID}, received ${provider.id}.`);

  return Object.freeze({
    ...provider,
    name: "OpenCode Go",
    auth: Object.freeze({
      ...provider.auth,
      apiKey: envApiKeyAuth("OpenCode Go API key", ["OPENCODE_GO_API_KEY"]),
    }),
  });
}
