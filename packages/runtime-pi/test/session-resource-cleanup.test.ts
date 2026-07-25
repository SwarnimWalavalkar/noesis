import { createConnection, createServer, type Server, type Socket } from "node:net";
import { AgentHarness, Session } from "@earendil-works/pi-agent-core";
import {
  cleanupSessionResources,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  registerSessionResourceCleanup,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createDefaultRoleContextPolicy,
  createPiAgentRoleRunner,
  createPiRoleModelBackend,
  createPiAgentRuntime,
} from "../src/index.ts";

interface SessionNetworkResource {
  readonly server: Server;
  readonly client: Socket;
  readonly accepted: Socket;
  readonly expiry: NodeJS.Timeout;
}

interface ProcessDiagnostics {
  readonly _getActiveHandles: () => readonly unknown[];
  readonly _getActiveRequests: () => readonly unknown[];
}

const resources = new Map<string, SessionNetworkResource>();
const unregisterCleanups: (() => void)[] = [];

function diagnostics(): {
  readonly handles: readonly unknown[];
  readonly requests: readonly unknown[];
} {
  const processDiagnostics = process as typeof process & ProcessDiagnostics;
  return Object.freeze({
    handles: Object.freeze([...processDiagnostics._getActiveHandles()]),
    requests: Object.freeze([...processDiagnostics._getActiveRequests()]),
  });
}

async function openSessionNetworkResource(sessionId: string): Promise<SessionNetworkResource> {
  let accepted: Socket | undefined;
  let markAccepted: (() => void) | undefined;
  const acceptedConnection = new Promise<void>((resolve) => {
    markAccepted = resolve;
  });
  const server = createServer((socket) => {
    accepted = socket;
    markAccepted?.();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local provider server has no TCP address");
  const client = createConnection(address.port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  await acceptedConnection;
  if (!accepted) throw new Error("Local provider server did not accept its client");
  const resource = Object.freeze({
    server,
    client,
    accepted,
    expiry: setTimeout(() => undefined, 300_000),
  });
  resources.set(sessionId, resource);
  return resource;
}

function closeResource(resource: SessionNetworkResource): void {
  clearTimeout(resource.expiry);
  resource.client.destroy();
  resource.accepted.destroy();
  resource.server.close();
}

function registerTrackedSessionCleanup(): void {
  unregisterCleanups.push(
    registerSessionResourceCleanup((sessionId) => {
      const entries =
        sessionId === undefined
          ? [...resources.entries()]
          : [...resources.entries()].filter(([candidate]) => candidate === sessionId);
      for (const [candidate, resource] of entries) {
        closeResource(resource);
        resources.delete(candidate);
      }
    }),
  );
}

function createRealShapedModels() {
  const models = createModels();
  const provider = fauxProvider({
    provider: "local-session-resource",
    models: [{ id: "local-streaming-model", contextWindow: 8_000, maxTokens: 1_000 }],
  });
  provider.setResponses([resourceResponse()]);
  models.setProvider(provider.provider);
  return Object.freeze({ models, provider });
}

function resourceResponse(): FauxResponseFactory {
  return async (_context, options) => {
    if (!options?.sessionId) throw new Error("AgentHarness did not provide a provider session ID");
    await openSessionNetworkResource(options.sessionId);
    return fauxAssistantMessage('{"decision":"no_change","reason":"local provider completed"}');
  };
}

afterEach(async () => {
  cleanupSessionResources();
  for (const unregister of unregisterCleanups.splice(0)) unregister();
  for (const resource of resources.values()) closeResource(resource);
  resources.clear();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

describe("Pi session resource ownership", () => {
  test("a completed foreground AgentHarness turn releases its provider session resources", async () => {
    registerTrackedSessionCleanup();
    const { models } = createRealShapedModels();
    const runtime = createPiAgentRuntime(process.cwd(), models);

    await runtime.run(
      {
        trailId: "foreground-session-resource",
        provider: "local-session-resource",
        model: "local-streaming-model",
        thinkingLevel: "off",
        systemPrompt: "Complete one local streaming turn.",
        prompt: "finish",
        activeCapabilities: [],
      },
      () => undefined,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    const active = [...resources.values()];
    const processState = diagnostics();
    expect({
      sessionResources: resources.size,
      trackedHandles: active.flatMap((resource) =>
        [resource.server, resource.client, resource.accepted].filter((handle) =>
          processState.handles.includes(handle),
        ),
      ),
      activeRequests: processState.requests,
    }).toMatchObject({
      sessionResources: 0,
      trackedHandles: [],
      activeRequests: [],
    });
  });

  test("a completed ambient role AgentHarness run releases its provider session resources", async () => {
    registerTrackedSessionCleanup();
    const { models } = createRealShapedModels();
    const runner = createPiAgentRoleRunner(process.cwd(), models, [
      {
        variant: { variantId: "local-reflector", axis: "role", configurationRefs: [] },
        role: "reflector",
        provider: "local-session-resource",
        model: "local-streaming-model",
        reasoning: "off",
        systemPrompt: "Reflect using the controlled local provider.",
        contextPolicy: createDefaultRoleContextPolicy("reflector"),
      },
    ]);

    await runner.run({
      runId: "ambient-session-resource",
      role: "reflector",
      variant: { variantId: "local-reflector", axis: "role", configurationRefs: [] },
      messages: [{ role: "user", name: "signals", content: "one bounded signal" }],
      evidenceRefs: [],
      availableTools: [],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const active = [...resources.values()];
    const processState = diagnostics();
    expect({
      sessionResources: resources.size,
      trackedHandles: active.flatMap((resource) =>
        [resource.server, resource.client, resource.accepted].filter((handle) =>
          processState.handles.includes(handle),
        ),
      ),
      activeRequests: processState.requests,
    }).toMatchObject({
      sessionResources: 0,
      trackedHandles: [],
      activeRequests: [],
    });
  });

  test("an abort during asynchronous session setup prevents the ambient provider prompt", async () => {
    const { models, provider } = createRealShapedModels();
    let providerPrompts = 0;
    provider.setResponses([
      () => {
        providerPrompts += 1;
        return fauxAssistantMessage('{"decision":"no_change","reason":"should not run"}');
      },
    ]);
    const cleanedSessionIds: string[] = [];
    unregisterCleanups.push(
      registerSessionResourceCleanup((sessionId) => {
        if (sessionId) cleanedSessionIds.push(sessionId);
      }),
    );
    let markSessionSetupStarted: (() => void) | undefined;
    const sessionSetupStarted = new Promise<void>((resolve) => {
      markSessionSetupStarted = resolve;
    });
    let releaseSessionSetup: (() => void) | undefined;
    const sessionSetupGate = new Promise<void>((resolve) => {
      releaseSessionSetup = resolve;
    });
    const originalGetMetadata = Session.prototype.getMetadata;
    const getMetadata = vi.spyOn(Session.prototype, "getMetadata").mockImplementationOnce(async function (
      this: Session,
    ) {
      markSessionSetupStarted?.();
      await sessionSetupGate;
      return originalGetMetadata.call(this);
    });
    const controller = new AbortController();
    const backend = createPiRoleModelBackend(process.cwd(), models);

    try {
      const running = backend.run({
        runId: "abort-during-session-setup",
        provider: "local-session-resource",
        model: "local-streaming-model",
        reasoning: "off",
        systemPrompt: "Reflect using the controlled local provider.",
        prompt: "finish",
        signal: controller.signal,
      });
      await sessionSetupStarted;
      controller.abort();
      releaseSessionSetup?.();

      await expect(running).rejects.toThrow("Pi role run aborted");
      expect(providerPrompts).toBe(0);
      expect(cleanedSessionIds).toHaveLength(1);
    } finally {
      releaseSessionSetup?.();
      getMetadata.mockRestore();
    }
  });

  test("a foreground abort during asynchronous session setup releases the session without prompting", async () => {
    const { models, provider } = createRealShapedModels();
    let providerPrompts = 0;
    provider.setResponses([
      () => {
        providerPrompts += 1;
        return fauxAssistantMessage("should not run");
      },
    ]);
    const cleanedSessionIds: string[] = [];
    unregisterCleanups.push(
      registerSessionResourceCleanup((sessionId) => {
        if (sessionId) cleanedSessionIds.push(sessionId);
      }),
    );
    let markSessionSetupStarted: (() => void) | undefined;
    const sessionSetupStarted = new Promise<void>((resolve) => {
      markSessionSetupStarted = resolve;
    });
    let releaseSessionSetup: (() => void) | undefined;
    const sessionSetupGate = new Promise<void>((resolve) => {
      releaseSessionSetup = resolve;
    });
    const originalGetMetadata = Session.prototype.getMetadata;
    const getMetadata = vi.spyOn(Session.prototype, "getMetadata").mockImplementationOnce(async function (
      this: Session,
    ) {
      markSessionSetupStarted?.();
      await sessionSetupGate;
      return originalGetMetadata.call(this);
    });
    const runtime = createPiAgentRuntime(process.cwd(), models);

    try {
      const running = runtime.run(
        {
          trailId: "foreground-abort-during-session-setup",
          provider: "local-session-resource",
          model: "local-streaming-model",
          thinkingLevel: "off",
          systemPrompt: "Complete one local streaming turn.",
          prompt: "finish",
          activeCapabilities: [],
        },
        () => undefined,
      );
      await sessionSetupStarted;
      await runtime.abort("foreground-abort-during-session-setup");
      await runtime.abort("foreground-abort-during-session-setup");
      releaseSessionSetup?.();

      await expect(running).resolves.toMatchObject({
        outcome: "aborted",
        stopReason: "aborted",
        text: "",
      });
      expect(providerPrompts).toBe(0);
      expect(cleanedSessionIds).toHaveLength(1);
    } finally {
      releaseSessionSetup?.();
      getMetadata.mockRestore();
    }
  });

  test("releases session resources and active ownership even when another cleanup rejects", async () => {
    registerTrackedSessionCleanup();
    const { models, provider } = createRealShapedModels();
    const runtime = createPiAgentRuntime(process.cwd(), models);
    const request = {
      trailId: "exceptional-session-cleanup",
      provider: "local-session-resource",
      model: "local-streaming-model",
      thinkingLevel: "off" as const,
      systemPrompt: "Complete one local streaming turn.",
      prompt: "finish",
      activeCapabilities: [],
    };
    const unregisterThrowingCleanup = registerSessionResourceCleanup(() => {
      throw new Error("injected cleanup failure");
    });

    try {
      await expect(runtime.run(request, () => undefined)).rejects.toThrow(
        "Failed to cleanup session resources",
      );
      expect(resources.size).toBe(0);
    } finally {
      unregisterThrowingCleanup();
    }

    provider.appendResponses([resourceResponse()]);
    await expect(runtime.run(request, () => undefined)).resolves.toMatchObject({
      outcome: "completed",
    });
    expect(resources.size).toBe(0);
  });

  test("releases session resources and active ownership even when waitForIdle rejects", async () => {
    registerTrackedSessionCleanup();
    const { models, provider } = createRealShapedModels();
    const runtime = createPiAgentRuntime(process.cwd(), models);
    const request = {
      trailId: "exceptional-wait-for-idle",
      provider: "local-session-resource",
      model: "local-streaming-model",
      thinkingLevel: "off" as const,
      systemPrompt: "Complete one local streaming turn.",
      prompt: "finish",
      activeCapabilities: [],
    };
    const waitForIdle = vi
      .spyOn(AgentHarness.prototype, "waitForIdle")
      .mockRejectedValueOnce(new Error("injected waitForIdle failure"));

    try {
      await expect(runtime.run(request, () => undefined)).rejects.toThrow("injected waitForIdle failure");
      expect(resources.size).toBe(0);
    } finally {
      waitForIdle.mockRestore();
    }

    provider.appendResponses([resourceResponse()]);
    await expect(runtime.run(request, () => undefined)).resolves.toMatchObject({
      outcome: "completed",
    });
    expect(resources.size).toBe(0);
  });
});
