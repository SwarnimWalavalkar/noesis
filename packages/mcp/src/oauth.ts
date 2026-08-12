import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpOAuthConfig } from "./config.ts";

export interface McpOAuthCredential {
  readonly serverUrl: string;
  readonly authIdentityDigest?: string;
  readonly clientInformation?: OAuthClientInformationMixed | undefined;
  readonly tokens?: OAuthTokens | undefined;
  readonly codeVerifier?: string | undefined;
  readonly state?: string | undefined;
  readonly discovery?: OAuthDiscoveryState | undefined;
}

/**
 * Protected storage port. Runtime composition supplies the same filesystem-hardening
 * guarantees as the rest of Noesis credentials; mcp.json never contains tokens.
 */
export interface McpOAuthCredentialStore {
  readonly read: (key: string) => Promise<McpOAuthCredential | undefined>;
  readonly write: (key: string, credential: McpOAuthCredential) => Promise<void>;
  readonly update: (
    key: string,
    update: (current: McpOAuthCredential | undefined) => McpOAuthCredential,
  ) => Promise<void>;
  readonly delete: (key: string) => Promise<void>;
}

export interface McpOAuthRedirect {
  readonly serverName: string;
  readonly authorizationUrl: URL;
}

export interface CreateMcpOAuthProviderInput {
  readonly key: string;
  readonly serverName: string;
  readonly serverUrl: string;
  readonly authIdentityDigest: string;
  readonly redirectUrl: string;
  readonly config?: Exclude<McpOAuthConfig, boolean>;
  readonly credentialStore: McpOAuthCredentialStore;
  readonly onRedirect: (redirect: McpOAuthRedirect) => void | Promise<void>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

async function updateCredential(
  store: McpOAuthCredentialStore,
  key: string,
  serverUrl: string,
  authIdentityDigest: string,
  update: (current: McpOAuthCredential) => McpOAuthCredential,
): Promise<void> {
  await store.update(key, (stored) =>
    update(
      stored?.serverUrl === serverUrl && stored.authIdentityDigest === authIdentityDigest
        ? stored
        : { serverUrl, authIdentityDigest },
    ),
  );
}

export function createMcpOAuthProvider(input: CreateMcpOAuthProviderInput): OAuthClientProvider {
  const loadCredential = async (): Promise<McpOAuthCredential | undefined> => {
    const credential = await input.credentialStore.read(input.key);
    return credential?.serverUrl === input.serverUrl &&
      credential.authIdentityDigest === input.authIdentityDigest
      ? credential
      : undefined;
  };
  const metadata: OAuthClientMetadata = {
    redirect_uris: [input.redirectUrl],
    client_name: "Noesis",
    software_id: "noesis",
    software_version: "0.1.0",
    ...(input.config?.scope ? { scope: input.config.scope } : {}),
  };
  const configuredClient = input.config?.clientId
    ? {
        client_id: input.config.clientId,
        ...(input.config.clientSecretEnvironment && input.environment?.[input.config.clientSecretEnvironment]
          ? { client_secret: input.environment[input.config.clientSecretEnvironment] }
          : {}),
      }
    : undefined;

  return {
    redirectUrl: input.redirectUrl,
    clientMetadata: metadata,
    state: async () => {
      const existing = (await loadCredential())?.state;
      if (existing) return existing;
      const state = crypto.randomUUID();
      await updateCredential(
        input.credentialStore,
        input.key,
        input.serverUrl,
        input.authIdentityDigest,
        (current) => ({
          ...current,
          state,
        }),
      );
      return state;
    },
    clientInformation: async () => configuredClient ?? (await loadCredential())?.clientInformation,
    saveClientInformation: async (clientInformation) => {
      await updateCredential(
        input.credentialStore,
        input.key,
        input.serverUrl,
        input.authIdentityDigest,
        (current) => ({
          ...current,
          clientInformation,
        }),
      );
    },
    tokens: async () => (await loadCredential())?.tokens,
    saveTokens: async (tokens) => {
      await updateCredential(
        input.credentialStore,
        input.key,
        input.serverUrl,
        input.authIdentityDigest,
        (current) => ({
          ...current,
          tokens,
        }),
      );
    },
    redirectToAuthorization: async (authorizationUrl) => {
      await input.onRedirect({ serverName: input.serverName, authorizationUrl });
    },
    saveCodeVerifier: async (codeVerifier) => {
      await updateCredential(
        input.credentialStore,
        input.key,
        input.serverUrl,
        input.authIdentityDigest,
        (current) => ({
          ...current,
          codeVerifier,
        }),
      );
    },
    codeVerifier: async () => {
      const verifier = (await loadCredential())?.codeVerifier;
      if (!verifier) throw new Error(`No OAuth code verifier is stored for MCP server ${input.serverName}`);
      return verifier;
    },
    saveDiscoveryState: async (discovery) => {
      await updateCredential(
        input.credentialStore,
        input.key,
        input.serverUrl,
        input.authIdentityDigest,
        (current) => ({
          ...current,
          discovery,
        }),
      );
    },
    discoveryState: async () => (await loadCredential())?.discovery,
    invalidateCredentials: async (scope) => {
      if (scope === "all") {
        await input.credentialStore.delete(input.key);
        return;
      }
      await updateCredential(
        input.credentialStore,
        input.key,
        input.serverUrl,
        input.authIdentityDigest,
        (current) => {
          if (scope === "client")
            return {
              serverUrl: current.serverUrl,
              ...(current.authIdentityDigest ? { authIdentityDigest: current.authIdentityDigest } : {}),
              ...(current.tokens ? { tokens: current.tokens } : {}),
            };
          if (scope === "tokens") {
            const { tokens: _tokens, ...next } = current;
            return next;
          }
          if (scope === "verifier") {
            const { codeVerifier: _verifier, ...next } = current;
            return next;
          }
          const { discovery: _discovery, ...next } = current;
          return next;
        },
      );
    },
  };
}
