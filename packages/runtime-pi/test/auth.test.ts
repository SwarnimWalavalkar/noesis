import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type CredentialStore,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { isJsonObject, JsonValueSchema } from "@noesis/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  credentialFileMode,
  createPiAgentRuntime,
  createPiAgentRoleRunner,
  createPiAuthManager,
  createPiModelServices,
  createDefaultRoleContextPolicy,
  createSecurePiCredentialStore,
  listPiModelRoutes,
  piAuthPath,
  preparePiModelSelection,
} from "../src/index.ts";

const emptyAuthContext = {
  env: async (_name: string): Promise<string | undefined> => undefined,
  fileExists: async (_path: string): Promise<boolean> => false,
};

describe("Pi authentication", () => {
  beforeEach(() => {
    for (const name of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "OPENCODE_API_KEY",
      "OPENCODE_GO_API_KEY",
    ])
      vi.stubEnv(name, "");
  });

  afterEach(() => vi.unstubAllEnvs());

  test("registers every provider supported by Noesis", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-provider-registration-"));
    const services = await createPiModelServices(home);

    expect(
      ["openai-codex", "anthropic", "openrouter", "opencode", "opencode-go"].map(
        (id) => services.models.getProvider(id)?.id,
      ),
    ).toEqual(["openai-codex", "anthropic", "openrouter", "opencode", "opencode-go"]);
    expect(services.models.getModel("anthropic", "claude-opus-4-8")?.id).toBe("claude-opus-4-8");
    expect(services.models.getModel("opencode", "kimi-k2.6")?.id).toBe("kimi-k2.6");
    expect(services.models.getModel("opencode-go", "kimi-k2.6")?.id).toBe("kimi-k2.6");
    expect(
      listPiModelRoutes(services.models).find((route) => route.provider === "opencode-go")?.providerName,
    ).toBe("OpenCode Go");
  });

  test("restores Pi's persisted remote model compatibility overlay", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-provider-refresh-"));
    const credentials = createSecurePiCredentialStore(piAuthPath(home));
    await credentials.modify("openrouter", async () => ({ type: "api_key", key: "test-key" }));
    const baseline = openrouterProvider().getModels()[0];
    if (!baseline) throw new Error("Expected Pi's bundled OpenRouter catalog");
    await writeFile(
      join(home, "models-store.json"),
      JSON.stringify({
        openrouter: {
          models: [
            {
              ...baseline,
              id: "research/live-model",
              name: "Research Live Model",
              reasoning: true,
              thinkingLevelMap: { low: "low", high: "high" },
            },
          ],
          checkedAt: Date.now(),
          lastModified: Date.parse("2099-01-01T00:00:00Z"),
          etag: '"noesis-test-catalog"',
        },
      }),
    );

    const services = await createPiModelServices(home, { credentials });
    expect(
      listPiModelRoutes(services.models).find((route) => route.model === "research/live-model"),
    ).toMatchObject({
      provider: "openrouter",
      name: "Research Live Model",
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
    });
  });

  test("validates provider and model as one selection through Pi's registered catalog", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-provider-selection-"));
    const services = await createPiModelServices(home);

    expect(() =>
      preparePiModelSelection(services.models, { provider: "opencode", model: "kimi-k2.6" }),
    ).not.toThrow();
    expect(() =>
      preparePiModelSelection(services.models, { provider: "opencode-go", model: "kimi-k2.6" }),
    ).not.toThrow();
    const codexOnly = services.models
      .getModels("openai-codex")
      .find((model) => !services.models.getModel("opencode", model.id));
    if (!codexOnly) throw new Error("Expected a model unique to the OpenAI Codex provider");
    expect(() =>
      preparePiModelSelection(services.models, { provider: "opencode", model: codexOnly.id }),
    ).toThrow(`openai-codex, not provider opencode`);
    expect(() =>
      preparePiModelSelection(services.models, { provider: "missing", model: "anything" }),
    ).toThrow("Supported providers: anthropic, openai-codex, opencode, opencode-go, openrouter");
  });

  test("resolves OpenCode Zen and Go from separate environment keys", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-provider-opencode-environment-"));
    vi.stubEnv("OPENCODE_API_KEY", "zen-environment-secret");
    vi.stubEnv("OPENCODE_GO_API_KEY", "go-environment-secret");
    const services = await createPiModelServices(home);
    const zen = services.models.getModel("opencode", "kimi-k2.6");
    const go = services.models.getModel("opencode-go", "kimi-k2.6");
    if (!zen || !go) throw new Error("Expected both OpenCode model routes");

    await expect(services.models.getAuth(zen)).resolves.toMatchObject({
      auth: { apiKey: "zen-environment-secret" },
      source: "OPENCODE_API_KEY",
    });
    await expect(services.models.getAuth(go)).resolves.toMatchObject({
      auth: { apiKey: "go-environment-secret" },
      source: "OPENCODE_GO_API_KEY",
    });
  });

  test("stores OpenCode Zen and Go credentials under separate provider keys", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-provider-opencode-stored-"));
    const services = await createPiModelServices(home);
    await services.auth.login("opencode", {
      prompt: async () => "zen-stored-secret",
      notify: () => undefined,
    });
    await services.auth.login("opencode-go", {
      prompt: async () => "go-stored-secret",
      notify: () => undefined,
    });

    const stored = JsonValueSchema.parse(JSON.parse(await readFile(piAuthPath(home), "utf8")));
    if (!isJsonObject(stored)) throw new Error("Expected the credential file to contain an object");
    expect(stored["opencode"]).toMatchObject({
      type: "api_key",
      key: "zen-stored-secret",
    });
    expect(stored["opencode-go"]).toMatchObject({
      type: "api_key",
      key: "go-stored-secret",
    });
  });

  test("prepares a custom model from its selected provider's Pi metadata", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-provider-custom-model-"));
    const services = await createPiModelServices(home);

    preparePiModelSelection(services.models, {
      provider: "openrouter",
      model: "research-lab/future-model",
    });

    const custom = services.models.getModel("openrouter", "research-lab/future-model");
    expect(custom).toMatchObject({
      provider: "openrouter",
      id: "research-lab/future-model",
      name: "research-lab/future-model",
    });
  });

  test("rejects unknown OpenCode models instead of guessing across its mixed API transports", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-provider-opencode-unknown-"));
    const services = await createPiModelServices(home);

    expect(() =>
      preparePiModelSelection(services.models, {
        provider: "opencode",
        model: "future-unknown-model",
      }),
    ).toThrow("Model future-unknown-model is not available from provider opencode");
    expect(services.models.getModel("opencode", "future-unknown-model")).toBeUndefined();
  });

  test("persists mocked OAuth login and refresh through Pi's credential-store contract", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-auth-oauth-"));
    const credentials = createSecurePiCredentialStore(piAuthPath(home));
    const models = createModels({ credentials, authContext: emptyAuthContext });
    const base = openaiCodexProvider();
    let refreshes = 0;
    let callbackPage = "";
    models.setProvider({
      ...base,
      auth: {
        oauth: {
          name: "mock Codex OAuth",
          login: async (callbacks) => {
            callbackPage =
              callbacks.renderOAuthCallbackPage?.({
                provider: "openai-codex",
                status: "success",
              }) ?? "";
            return {
              type: "oauth",
              access: "access-secret",
              refresh: "refresh-secret",
              expires: 0,
            };
          },
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
      renderOAuthCallbackPage: (page) => `${page.provider}:${page.status}:Noesis`,
    });
    expect(status).toMatchObject({ provider: "openai-codex", configured: true, source: "oauth" });
    expect(callbackPage).toBe("openai-codex:success:Noesis");

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
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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

  test.each([
    {
      provider: "anthropic",
      model: "claude-opus-4-8",
      providerFactory: anthropicProvider,
      expected: "ANTHROPIC_API_KEY",
    },
    {
      provider: "opencode",
      model: "kimi-k2.6",
      providerFactory: opencodeProvider,
      expected: "OPENCODE_API_KEY",
    },
  ])(
    "fails before $provider execution with actionable authentication guidance",
    async ({ provider, model, providerFactory, expected }) => {
      const models = createModels({ authContext: emptyAuthContext });
      models.setProvider(providerFactory());
      const runtime = createPiAgentRuntime(process.cwd(), models);

      await expect(
        runtime.run(
          {
            trailId: `trail-missing-${provider}`,
            provider,
            model,
            thinkingLevel: "off",
            systemPrompt: "test",
            prompt: "must not reach the network",
            activeCapabilities: [],
          },
          () => undefined,
        ),
      ).rejects.toThrow(expected);
    },
  );

  test("fails before OpenCode Go execution with its distinct authentication guidance", async () => {
    const services = await createPiModelServices(await mkdtemp(join(tmpdir(), "noesis-auth-go-missing-")));
    const runtime = createPiAgentRuntime(process.cwd(), services.models);

    await expect(
      runtime.run(
        {
          trailId: "trail-missing-opencode-go",
          provider: "opencode-go",
          model: "kimi-k2.6",
          thinkingLevel: "off",
          systemPrompt: "test",
          prompt: "must not reach the network",
          activeCapabilities: [],
        },
        () => undefined,
      ),
    ).rejects.toThrow("OPENCODE_GO_API_KEY");
  });

  test("reuses the Pi provider and auth lifecycle for isolated roles without reaching the network", async () => {
    const models = createModels({ authContext: emptyAuthContext });
    models.setProvider(openrouterProvider());
    const runner = createPiAgentRoleRunner(process.cwd(), models, [
      {
        variant: { variantId: "reflect-openrouter", axis: "role", configurationRefs: [] },
        role: "reflector",
        provider: "openrouter",
        model: "openai/gpt-4o-mini",
        reasoning: "off",
        systemPrompt: "Reflect on bounded evidence only.",
        contextPolicy: createDefaultRoleContextPolicy("reflector"),
      },
    ]);

    await expect(
      runner.run({
        runId: "role-missing-auth",
        role: "reflector",
        variant: { variantId: "reflect-openrouter", axis: "role", configurationRefs: [] },
        messages: [{ role: "user", name: "signals", content: "must not reach the network" }],
        evidenceRefs: [],
        availableTools: [],
      }),
    ).rejects.toThrow("OPENROUTER_API_KEY");
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
      async list() {
        return [];
      },
    };
    const models = createModels({ credentials, authContext: emptyAuthContext });
    models.setProvider(openrouterProvider());
    const runtime = createPiAgentRuntime(process.cwd(), models);
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
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

  test("latches foreground abort while delayed auth resolves before AgentHarness exists", async () => {
    let releaseAuth: (() => void) | undefined;
    const authGate = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });
    let markAuthStarted: (() => void) | undefined;
    const authStarted = new Promise<void>((resolve) => {
      markAuthStarted = resolve;
    });
    const credentials: CredentialStore = {
      async read() {
        markAuthStarted?.();
        await authGate;
        return { type: "api_key", key: "controlled-delayed-auth" };
      },
      async modify(_providerId, update) {
        return await update(undefined);
      },
      async delete() {},
      async list() {
        return [];
      },
    };
    const models = createModels({ credentials, authContext: emptyAuthContext });
    const provider = fauxProvider({
      provider: "delayed-auth-provider",
      models: [{ id: "delayed-auth-model", contextWindow: 8_000, maxTokens: 1_000 }],
    });
    let providerPrompts = 0;
    provider.setResponses([
      () => {
        providerPrompts += 1;
        return fauxAssistantMessage("must not complete");
      },
    ]);
    models.setProvider(provider.provider);
    const runtime = createPiAgentRuntime(process.cwd(), models);
    const events: string[] = [];
    const running = runtime.run(
      {
        trailId: "trail-delayed-auth-abort",
        provider: "delayed-auth-provider",
        model: "delayed-auth-model",
        thinkingLevel: "off",
        systemPrompt: "test",
        prompt: "must not reach AgentHarness",
        activeCapabilities: [],
      },
      (event) => {
        if (event.type === "status") events.push(event.status);
      },
    );

    await authStarted;
    await runtime.abort("trail-delayed-auth-abort");
    await runtime.abort("trail-delayed-auth-abort");
    releaseAuth?.();

    await expect(running).resolves.toMatchObject({
      outcome: "aborted",
      stopReason: "aborted",
      text: "",
    });
    expect(events).toEqual(["aborted"]);
    expect(providerPrompts).toBe(0);
  });

  test("serializes concurrent credential modifications", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-auth-lock-"));
    const store: CredentialStore = createSecurePiCredentialStore(piAuthPath(home));
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.modify(`provider-${index}`, async () => ({ type: "api_key", key: `secret-${index}` })),
      ),
    );
    const persisted = JsonValueSchema.parse(JSON.parse(await readFile(piAuthPath(home), "utf8")));
    if (!isJsonObject(persisted)) throw new Error("Expected credential file to contain a JSON object");
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
