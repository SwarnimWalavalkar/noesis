import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type CredentialStore } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { describe, expect, test } from "vitest";
import {
  credentialFileMode,
  createPiAgentRuntime,
  createPiAuthManager,
  createSecurePiCredentialStore,
  piAuthPath,
} from "../src/index.ts";

const emptyAuthContext = {
  env: async (_name: string): Promise<string | undefined> => undefined,
  fileExists: async (_path: string): Promise<boolean> => false,
};

describe("Pi authentication", () => {
  test("persists mocked OAuth login and refresh through Pi's credential-store contract", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-auth-oauth-"));
    const credentials = createSecurePiCredentialStore(piAuthPath(home));
    const models = createModels({ credentials, authContext: emptyAuthContext });
    const base = openaiCodexProvider();
    let refreshes = 0;
    models.setProvider({
      ...base,
      auth: {
        oauth: {
          name: "mock Codex OAuth",
          login: async () => ({
            type: "oauth",
            access: "access-secret",
            refresh: "refresh-secret",
            expires: 0,
          }),
          refresh: async () => {
            refreshes += 1;
            return {
              type: "oauth",
              access: "rotated-access-secret",
              refresh: "rotated-refresh-secret",
              expires: Date.now() + 60_000,
            };
          },
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
    });
    const auth = createPiAuthManager(models, credentials);
    const status = await auth.login("openai-codex", {
      prompt: async () => "unused",
      notify: () => undefined,
    });
    expect(status).toMatchObject({ provider: "openai-codex", configured: true, source: "oauth" });

    const model = models.getModels("openai-codex")[0];
    expect(model).toBeDefined();
    if (!model) return;
    expect((await models.getAuth(model))?.source).toBe("OAuth");
    expect(refreshes).toBe(1);
    expect((await credentials.read("openai-codex"))?.type).toBe("oauth");
    expect(await credentialFileMode(home)).toBe(0o600);

    await auth.logout("openai-codex");
    expect(await auth.status("openai-codex")).toEqual({
      provider: "openai-codex",
      configured: false,
      source: "none",
    });
  });

  test("stores an OpenRouter key only in auth.json and never reveals it through status", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-auth-key-"));
    const configPath = join(home, "config.json");
    const config = '{"schemaVersion":1,"agent":{"provider":"openrouter"}}\n';
    await writeFile(configPath, config);
    const credentials = createSecurePiCredentialStore(piAuthPath(home));
    const models = createModels({ credentials, authContext: emptyAuthContext });
    models.setProvider(openrouterProvider());
    const auth = createPiAuthManager(models, credentials);
    const secret = "openrouter-test-secret";
    const status = await auth.login("openrouter", {
      prompt: async () => secret,
      notify: () => undefined,
    });

    expect(JSON.stringify(status)).not.toContain(secret);
    expect(await readFile(configPath, "utf8")).toBe(config);
    expect(await readFile(piAuthPath(home), "utf8")).toContain(secret);
  });

  test("fails before execution with an actionable error when OpenRouter credentials are missing", async () => {
    const models = createModels({ authContext: emptyAuthContext });
    models.setProvider(openrouterProvider());
    const runtime = createPiAgentRuntime(process.cwd(), models);
    const request = {
      trailId: "trail-missing-auth",
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      thinkingLevel: "off" as const,
      systemPrompt: "test",
      prompt: "must not reach the network",
      activeCapabilities: [],
    };
    await expect(runtime.run(request, () => undefined)).rejects.toThrow("OPENROUTER_API_KEY");
  });

  test("rejects duplicate Pi executions while auth resolution is pending without network access", async () => {
    let releaseRead: (() => void) | undefined;
    const blockedRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let markReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let reads = 0;
    const credentials: CredentialStore = {
      async read() {
        reads += 1;
        markReadStarted?.();
        if (reads === 1) await blockedRead;
        return undefined;
      },
      async modify(_providerId, update) {
        return await update(undefined);
      },
      async delete() {},
    };
    const models = createModels({ credentials, authContext: emptyAuthContext });
    models.setProvider(openrouterProvider());
    const runtime = createPiAgentRuntime(process.cwd(), models);
    const request = {
      trailId: "trail-concurrent-pi",
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      thinkingLevel: "off" as const,
      systemPrompt: "test",
      prompt: "must not reach the network",
      activeCapabilities: [],
    };

    const first = runtime.run(request, () => undefined);
    await readStarted;
    await expect(runtime.run(request, () => undefined)).rejects.toThrow("already active");
    releaseRead?.();
    await expect(first).rejects.toThrow("OPENROUTER_API_KEY");
    await expect(runtime.run(request, () => undefined)).rejects.toThrow("OPENROUTER_API_KEY");
    expect(reads).toBe(2);
  });

  test("serializes concurrent credential modifications", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-auth-lock-"));
    const store: CredentialStore = createSecurePiCredentialStore(piAuthPath(home));
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.modify(`provider-${index}`, async () => ({ type: "api_key", key: `secret-${index}` })),
      ),
    );
    const persisted = JSON.parse(await readFile(piAuthPath(home), "utf8")) as Record<string, unknown>;
    expect(Object.keys(persisted)).toHaveLength(8);
  });

  test("repairs an owned 0644 credential file before reading it", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-auth-mode-"));
    const secret = "mode-repair-secret";
    await chmod(home, 0o755);
    await writeFile(
      piAuthPath(home),
      `${JSON.stringify({ openrouter: { type: "api_key", key: secret } })}\n`,
    );
    await chmod(piAuthPath(home), 0o644);

    const credential = await createSecurePiCredentialStore(piAuthPath(home)).read("openrouter");

    expect(credential).toEqual({ type: "api_key", key: secret });
    expect((await lstat(home)).mode & 0o777).toBe(0o700);
    expect((await lstat(piAuthPath(home))).mode & 0o777).toBe(0o600);
  });

  test("fails closed on a symlinked credential file without exposing its contents", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-auth-symlink-file-"));
    const target = join(home, "outside-auth.json");
    const secret = "symlink-target-secret";
    await writeFile(target, `${JSON.stringify({ openrouter: { type: "api_key", key: secret } })}\n`, {
      mode: 0o600,
    });
    await symlink(target, piAuthPath(home));

    let failure: unknown;
    try {
      await createSecurePiCredentialStore(piAuthPath(home)).read("openrouter");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/symbolic link/);
    expect(String(failure)).not.toContain(secret);
    expect(await readFile(target, "utf8")).toContain(secret);
  });

  test("rejects a symlinked Noesis home before creating or reading credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-auth-symlink-home-"));
    const actualHome = join(root, "actual-home");
    const linkedHome = join(root, "linked-home");
    await mkdir(actualHome, { mode: 0o700 });
    await symlink(actualHome, linkedHome, "dir");

    await expect(createSecurePiCredentialStore(piAuthPath(linkedHome)).read("openrouter")).rejects.toThrow(
      /symbolic link.*credential directory/,
    );
    await expect(lstat(piAuthPath(actualHome))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
