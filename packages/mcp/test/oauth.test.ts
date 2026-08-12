import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createSecureMcpOAuthCredentialStore, mcpCredentialPath } from "../src/credential-store.ts";
import { createMcpOAuthProvider } from "../src/oauth.ts";

describe("MCP OAuth", () => {
  test("persists state, dynamic client information, tokens, and verifier in protected storage", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-mcp-oauth-"));
    const path = mcpCredentialPath(home);
    const store = createSecureMcpOAuthCredentialStore(path);
    const redirects: string[] = [];
    const provider = createMcpOAuthProvider({
      key: "project:server",
      serverName: "server",
      serverUrl: "https://server.example/mcp",
      authIdentityDigest: "auth-v1",
      redirectUrl: "http://127.0.0.1:1456/oauth/callback",
      credentialStore: store,
      onRedirect: ({ authorizationUrl }) => {
        redirects.push(authorizationUrl.href);
      },
    });

    const state = await provider.state?.();
    await provider.saveClientInformation?.({ client_id: "client" });
    await provider.saveTokens({ access_token: "access", token_type: "Bearer", refresh_token: "refresh" });
    await provider.saveCodeVerifier("verifier");
    await provider.redirectToAuthorization(new URL("https://auth.example/authorize"));

    expect(state).toBeTruthy();
    expect(await provider.state?.()).toBe(state);
    expect(await provider.clientInformation()).toMatchObject({ client_id: "client" });
    expect(await provider.tokens()).toMatchObject({ access_token: "access", refresh_token: "refresh" });
    expect(await provider.codeVerifier()).toBe("verifier");
    expect(redirects).toEqual(["https://auth.example/authorize"]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  test("never reuses credentials after a server URL changes", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-mcp-oauth-url-"));
    const store = createSecureMcpOAuthCredentialStore(mcpCredentialPath(home));
    const first = createMcpOAuthProvider({
      key: "global:server",
      serverName: "server",
      serverUrl: "https://first.example/mcp",
      authIdentityDigest: "auth-v1",
      redirectUrl: "http://127.0.0.1:1456/oauth/callback",
      credentialStore: store,
      onRedirect: () => undefined,
    });
    await first.saveTokens({ access_token: "secret", token_type: "Bearer" });
    const changed = createMcpOAuthProvider({
      key: "global:server",
      serverName: "server",
      serverUrl: "https://changed.example/mcp",
      authIdentityDigest: "auth-v1",
      redirectUrl: "http://127.0.0.1:1456/oauth/callback",
      credentialStore: store,
      onRedirect: () => undefined,
    });

    expect(await changed.tokens()).toBeUndefined();
  });

  test("preserves concurrent OAuth credential updates atomically", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-mcp-oauth-concurrent-"));
    const store = createSecureMcpOAuthCredentialStore(mcpCredentialPath(home));
    const provider = createMcpOAuthProvider({
      key: "global:server",
      serverName: "server",
      serverUrl: "https://server.example/mcp",
      authIdentityDigest: "auth-v1",
      redirectUrl: "http://127.0.0.1:1456/oauth/callback",
      credentialStore: store,
      onRedirect: () => undefined,
    });

    await Promise.all([
      provider.saveClientInformation?.({ client_id: "client" }),
      provider.saveTokens({ access_token: "access", token_type: "Bearer" }),
      provider.saveCodeVerifier("verifier"),
    ]);

    expect(await provider.clientInformation()).toMatchObject({ client_id: "client" });
    expect(await provider.tokens()).toMatchObject({ access_token: "access" });
    expect(await provider.codeVerifier()).toBe("verifier");
  });

  test("preserves concurrent updates from independent credential-store instances", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-mcp-oauth-process-safe-"));
    const path = mcpCredentialPath(home);
    const firstStore = createSecureMcpOAuthCredentialStore(path);
    const secondStore = createSecureMcpOAuthCredentialStore(path);

    await Promise.all([
      firstStore.write("global:first", {
        serverUrl: "https://first.example/mcp",
        tokens: { access_token: "first", token_type: "Bearer" },
      }),
      secondStore.write("global:second", {
        serverUrl: "https://second.example/mcp",
        tokens: { access_token: "second", token_type: "Bearer" },
      }),
    ]);

    expect(await firstStore.read("global:first")).toMatchObject({
      tokens: { access_token: "first" },
    });
    expect(await secondStore.read("global:second")).toMatchObject({
      tokens: { access_token: "second" },
    });
  });
});
