import { createConditionalObject } from "@noesis/domain";
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
  readonly clientInformation?: McpOAuthClientInformation | undefined;
  readonly tokens?: OAuthTokens | undefined;
  readonly codeVerifier?: string | undefined;
  readonly state?: string | undefined;
  readonly discovery?: OAuthDiscoveryState | undefined;
}
export type McpOAuthClientInformation = OAuthClientInformationMixed &
  Readonly<{
    token_endpoint_auth_method?: string | undefined;
  }>;
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
  readonly deleteIf: (
    key: string,
    predicate: (current: McpOAuthCredential | undefined) => boolean,
  ) => Promise<void>;
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
  if (input.config?.clientSecretEnvironment) {
    const secret = input.environment?.[input.config.clientSecretEnvironment];
    if (!secret) {
      throw new Error(
        `MCP server ${input.serverName} requires environment variable ${input.config.clientSecretEnvironment} for its OAuth client secret`,
      );
    }
  }
  const defaultClientAuthMethod = input.config?.clientSecretEnvironment ? "client_secret_basic" : "none";
  const loadCredential = async (): Promise<McpOAuthCredential | undefined> => {
    const credential = await input.credentialStore.read(input.key);
    if (
      credential?.serverUrl !== input.serverUrl ||
      credential.authIdentityDigest !== input.authIdentityDigest
    )
      return undefined;
    const clientInformation = credential.clientInformation;
    if (
      !clientInformation ||
      ("token_endpoint_auth_method" in clientInformation &&
        typeof clientInformation.token_endpoint_auth_method === "string")
    )
      return credential;
    const legacyClientAuthMethod = clientInformation.client_secret ? "client_secret_basic" : "none";
    return {
      ...credential,
      clientInformation: {
        ...clientInformation,
        token_endpoint_auth_method: legacyClientAuthMethod,
      },
    };
  };
  const metadata: OAuthClientMetadata = createConditionalObject({
    redirect_uris: [input.redirectUrl],
    token_endpoint_auth_method: defaultClientAuthMethod,
    client_name: "Noesis",
    software_id: "noesis",
    software_version: "0.1.0",
  })
    .addOptional(input.config?.scope ? { scope: input.config.scope } : undefined)
    .finish();
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const configuredClient = input.config?.clientId
    ? createConditionalObject({
        client_id: input.config.clientId,
        token_endpoint_auth_method: defaultClientAuthMethod,
      } as const)
        .addOptional(
          input.config.clientSecretEnvironment
            ? {
                client_secret: input.environment?.[input.config.clientSecretEnvironment],
              }
            : undefined,
        )
        .finish()
    : undefined;
  return {
    redirectUrl: input.redirectUrl,
    clientMetadata: metadata,
    state: async () => {
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
      const tokenEndpointAuthMethod =
        "token_endpoint_auth_method" in clientInformation &&
        typeof clientInformation.token_endpoint_auth_method === "string"
          ? clientInformation.token_endpoint_auth_method
          : metadata.token_endpoint_auth_method;
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      await updateCredential(
        input.credentialStore,
        input.key,
        input.serverUrl,
        input.authIdentityDigest,
        (current) => ({
          ...current,
          clientInformation: createConditionalObject({
            ...clientInformation,
          } as const)
            .addOptional(
              tokenEndpointAuthMethod ? { token_endpoint_auth_method: tokenEndpointAuthMethod } : undefined,
            )
            .finish(),
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
        await input.credentialStore.deleteIf(
          input.key,
          (current) =>
            current?.serverUrl === input.serverUrl && current.authIdentityDigest === input.authIdentityDigest,
        );
        return;
      }
      await input.credentialStore.update(input.key, (stored) => {
        if (stored?.serverUrl !== input.serverUrl || stored.authIdentityDigest !== input.authIdentityDigest) {
          return (
            stored ?? {
              serverUrl: input.serverUrl,
              authIdentityDigest: input.authIdentityDigest,
            }
          );
        }
        const current = stored;
        if (scope === "client")
          // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
          return createConditionalObject({
            serverUrl: current.serverUrl,
          } as const)
            .addOptional(
              current.authIdentityDigest ? { authIdentityDigest: current.authIdentityDigest } : undefined,
            )
            .addOptional(current.tokens ? { tokens: current.tokens } : undefined)
            .finish();
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
      });
    },
  };
}
