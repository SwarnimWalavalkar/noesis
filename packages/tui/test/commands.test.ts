import type { AgentThinkingLevel, NoesisAgentRuntime } from "@noesis/agent-types";
import { describe, expect, test } from "vitest";
import {
  exclusiveSlashCommandScope,
  INSPECTOR_PREVIEW_CHARACTERS,
  isExclusiveSlashCommand,
  isSlashCommandSubmission,
  type NoesisTuiAction,
  runSlashCommand,
  steerFeedback,
} from "../src/index.ts";
import { createInMemoryTestRuntime } from "./support/in-memory-runtime.ts";

const agent: NoesisAgentRuntime = {
  name: "slash-command-test",
  async run(request) {
    return {
      text: request.prompt,
      provider: request.provider,
      model: request.model,
      outcome: "completed",
      stopReason: "stop",
    };
  },
  async steer() {
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    return {
      status: "consumed" as const,
      timelineSequence: 1,
      consumedAt: "2026-07-31T00:00:00.000Z",
    };
  },
  async abort() {},
};

describe("Noesis slash commands", () => {
  test("routes learning only from column zero", () => {
    expect(isSlashCommandSubmission("/learning")).toBe(true);
    expect(isSlashCommandSubmission("  /learning")).toBe(false);
    expect(isSlashCommandSubmission("  /script reusable-research")).toBe(true);
  });

  test("opens learning through the interactive audit surface", async () => {
    let opened = 0;
    const handled = await runSlashCommand("/learning", {
      runtime: createInMemoryTestRuntime(agent),
      trailId: "trail-learning",
      publishInspector: () => undefined,
      dispatch: () => undefined,
      requestRender: () => undefined,
      openLearningAudit: () => {
        opened += 1;
      },
    });

    expect(handled).toBe(true);
    expect(opened).toBe(1);
  });

  test("opens MCP management through the interactive surface and explains unsupported runtimes", async () => {
    let opened = 0;
    const published: string[] = [];
    const runtime = createInMemoryTestRuntime(agent);
    const context = {
      runtime,
      trailId: "trail-mcp",
      publishInspector: (message: string) => published.push(message),
      dispatch: () => undefined,
      requestRender: () => undefined,
    };

    await expect(
      runSlashCommand("/mcp", {
        ...context,
        openMcpManager: () => {
          opened += 1;
        },
      }),
    ).resolves.toBe(true);
    expect(opened).toBe(1);
    expect(published).toEqual([]);

    await expect(runSlashCommand("/mcp", context)).resolves.toBe(true);
    expect(published).toEqual(["MCP management is unavailable in this runtime."]);
  });

  test("documents how to invoke skills whose names collide with built-in commands", async () => {
    const dispatched: NoesisTuiAction[] = [];

    const handled = await runSlashCommand("/help", {
      runtime: createInMemoryTestRuntime(agent),
      trailId: "trail-help",
      publishInspector: () => undefined,
      dispatch: (action) => dispatched.push(action),
      requestRender: () => undefined,
    });

    expect(handled).toBe(true);
    expect(dispatched).toContainEqual(
      expect.objectContaining({
        type: "system-message",
        text: expect.stringContaining("/skill:NAME [instructions] invokes command-name collisions"),
      }),
    );
  });

  test("explains idle and unresolved steering without masking successful delivery", () => {
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const snapshot = { sessionId: "session", phase: "idle" as const, queuePaused: true, pending: [] };
    expect(steerFeedback({ effect: "idle", snapshot }, true)).toContain("No active turn");
    expect(steerFeedback({ effect: "idle", snapshot }, false)).toContain("No queued message");
    expect(steerFeedback({ effect: "unresolved", snapshot }, true)).toContain("will not retry");
    expect(steerFeedback({ effect: "steered", snapshot }, true)).toBeUndefined();
  });

  test("classifies normalized state-mutating commands as exclusive", () => {
    expect(isExclusiveSlashCommand("  /compact \n")).toBe(true);
    expect(isExclusiveSlashCommand("/compact preserve exact errors")).toBe(true);
    expect(isExclusiveSlashCommand("/fork")).toBe(true);
    expect(isExclusiveSlashCommand("/resume")).toBe(true);
    expect(isExclusiveSlashCommand("/model")).toBe(true);
    expect(isExclusiveSlashCommand("\t/model model-2 ")).toBe(true);
    expect(isExclusiveSlashCommand("/provider")).toBe(true);
    expect(isExclusiveSlashCommand("/provider anthropic")).toBe(true);
    expect(isExclusiveSlashCommand("/reasoning")).toBe(true);
    expect(isExclusiveSlashCommand("/reasoning medium")).toBe(true);
    expect(isExclusiveSlashCommand("/runs")).toBe(false);
    expect(isExclusiveSlashCommand("/program script reusable-research")).toBe(false);
    expect(exclusiveSlashCommandScope(" /compact keep decisions ")).toBe("current-session");
    expect(exclusiveSlashCommandScope("/fork")).toBe("resulting-session");
    expect(exclusiveSlashCommandScope("/resume")).toBe("resulting-session");
    expect(exclusiveSlashCommandScope("/model")).toBe("resulting-session");
    expect(exclusiveSlashCommandScope("/model model-2")).toBe("resulting-session");
    expect(exclusiveSlashCommandScope("/provider")).toBe("resulting-session");
    expect(exclusiveSlashCommandScope("/provider anthropic")).toBe("resulting-session");
    expect(exclusiveSlashCommandScope("/reasoning")).toBe("current-session");
    expect(exclusiveSlashCommandScope("/reasoning medium")).toBe("current-session");
    expect(exclusiveSlashCommandScope("/runs")).toBeUndefined();
  });

  test("resumes the session selected by the interactive picker", async () => {
    const runtime = createInMemoryTestRuntime(agent);
    const current = await runtime.startTrail({ title: "current" });
    const selected = await runtime.startTrail({ title: "selected" });
    const dispatched: NoesisTuiAction[] = [];
    const prepared: string[] = [];

    await expect(
      runSlashCommand("/resume", {
        runtime,
        trailId: current.trailId,
        publishInspector: () => undefined,
        dispatch: (action) => dispatched.push(action),
        prepareTrailSelection: (trailId) => {
          prepared.push(trailId);
          return Promise.resolve();
        },
        requestRender: () => undefined,
        selectSession: () => Promise.resolve(selected.trailId),
      }),
    ).resolves.toBe(true);

    expect(prepared).toEqual([selected.trailId]);
    expect(dispatched).toContainEqual({ type: "trail-selected", trail: selected });
  });

  test("explains that model changes preserve the current session and isolate its prompt cache", async () => {
    const base = createInMemoryTestRuntime(agent);
    const current = await base.startTrail({ title: "cached conversation", thinkingLevel: "high" });
    const dispatched: NoesisTuiAction[] = [];
    const runtime = Object.freeze({
      ...base,
      listModelRoutes: () =>
        Object.freeze([
          Object.freeze({
            provider: "test-provider",
            model: "test-model",
            name: "Test model",
            thinkingLevels: Object.freeze(["off", "high"] as const),
            default: true,
            allowsCustomModelIds: false,
          }),
          Object.freeze({
            provider: "test-provider",
            model: "model-2",
            name: "Test model 2",
            thinkingLevels: Object.freeze(["off", "medium", "high"] as const),
            default: false,
            allowsCustomModelIds: false,
          }),
        ]),
    });

    const handled = await runSlashCommand("/model model-2", {
      runtime,
      trailId: current.trailId,
      publishInspector: () => undefined,
      dispatch: (action) => dispatched.push(action),
      requestRender: () => undefined,
    });

    expect(handled).toBe(true);
    expect(base.getTrail(current.trailId)).toMatchObject({
      trailId: current.trailId,
      model: "test-model",
    });
    expect(dispatched).toContainEqual(
      expect.objectContaining({
        type: "system-message",
        text: expect.stringContaining("previous session is preserved"),
      }),
    );
    expect(dispatched).toContainEqual(
      expect.objectContaining({
        type: "system-message",
        text: expect.stringContaining("prompt-cache isolation"),
      }),
    );
    expect(dispatched).toContainEqual({
      type: "notification-shown",
      text: "New empty session · previous preserved · history not replayed",
      tone: "info",
    });
    expect(dispatched).toContainEqual(
      expect.objectContaining({
        type: "trail-selected",
        trail: expect.objectContaining({ model: "model-2", turns: [] }),
      }),
    );
  });

  test("accepts a model published by a successful catalog refresh", async () => {
    const base = createInMemoryTestRuntime(agent);
    const current = await base.startTrail({ title: "live model refresh", thinkingLevel: "high" });
    let refreshes = 0;
    const liveRoute = Object.freeze({
      provider: current.provider,
      model: "model-published-live",
      name: "Published live",
      thinkingLevels: Object.freeze(["off", "medium"] as const),
      default: false,
      allowsCustomModelIds: false,
    });
    const dispatched: NoesisTuiAction[] = [];
    const runtime = Object.freeze({
      ...base,
      listModelRoutes: () => Object.freeze([]),
      refreshModelRoutes: async () => {
        refreshes += 1;
        return Object.freeze([liveRoute]);
      },
    });

    await expect(
      runSlashCommand("/model model-published-live", {
        runtime,
        trailId: current.trailId,
        publishInspector: () => undefined,
        dispatch: (action) => dispatched.push(action),
        requestRender: () => undefined,
      }),
    ).resolves.toBe(true);

    expect(refreshes).toBe(1);
    expect(dispatched).toContainEqual(
      expect.objectContaining({
        type: "trail-selected",
        trail: expect.objectContaining({ model: "model-published-live", thinkingLevel: "medium" }),
      }),
    );
  });

  test("selects a model interactively into a new empty session", async () => {
    const base = createInMemoryTestRuntime(agent);
    const current = await base.startTrail({ title: "interactive model", thinkingLevel: "high" });
    const dispatched: NoesisTuiAction[] = [];
    const selectedRoute = Object.freeze({
      provider: "test-provider",
      model: "model-2",
      name: "Test model 2",
      thinkingLevels: Object.freeze(["off", "medium"] as const),
      default: false,
      allowsCustomModelIds: false,
    });
    let pickerIntent: unknown;
    const runtime = Object.freeze({
      ...base,
      listModelRoutes: () => Object.freeze([selectedRoute]),
    });

    await expect(
      runSlashCommand("/model", {
        runtime,
        trailId: current.trailId,
        publishInspector: () => undefined,
        dispatch: (action) => dispatched.push(action),
        requestRender: () => undefined,
        selectRoute: async (intent) => {
          pickerIntent = intent;
          return { route: selectedRoute, thinkingLevel: "off" };
        },
      }),
    ).resolves.toBe(true);

    expect(pickerIntent).toEqual({
      kind: "model",
      currentProvider: "test-provider",
      currentModel: "test-model",
      currentThinkingLevel: "high",
    });
    expect(dispatched).toContainEqual(
      expect.objectContaining({
        type: "trail-selected",
        trail: expect.objectContaining({
          provider: "test-provider",
          model: "model-2",
          thinkingLevel: "off",
          turns: [],
        }),
      }),
    );
  });

  test("authenticates the selected provider before creating its session", async () => {
    const base = createInMemoryTestRuntime(agent);
    const current = await base.startTrail({ title: "provider authentication" });
    const events: string[] = [];
    const route = Object.freeze({
      provider: "provider-next",
      providerName: "Provider Next",
      model: "next-model",
      name: "Next model",
      thinkingLevels: Object.freeze(["off"] as const),
      default: true,
      allowsCustomModelIds: false,
    });
    const runtime = Object.freeze({
      ...base,
      listModelRoutes: () => Object.freeze([route]),
      startTrail: async (input: Parameters<typeof base.startTrail>[0]) => {
        events.push("start-session");
        return await base.startTrail(input);
      },
    });

    await runSlashCommand("/provider provider-next", {
      runtime,
      trailId: current.trailId,
      publishInspector: () => undefined,
      dispatch: () => undefined,
      requestRender: () => undefined,
      ensureProviderAuthenticated: async (providerId, providerName) => {
        events.push(`authenticate:${providerName}:${providerId}`);
        return true;
      },
    });

    expect(events).toEqual(["authenticate:Provider Next:provider-next", "start-session"]);
    expect(base.listTrails()).toHaveLength(2);
  });

  test("uses the provider picker only, then authenticates before refreshing its default route", async () => {
    const base = createInMemoryTestRuntime(agent);
    const current = await base.startTrail({ title: "interactive provider authentication" });
    const events: string[] = [];
    const route = Object.freeze({
      provider: "provider-next",
      providerName: "Provider Next",
      model: "next-default",
      name: "Next default",
      thinkingLevels: Object.freeze(["off"] as const),
      default: true,
      allowsCustomModelIds: false,
    });
    const runtime = Object.freeze({
      ...base,
      listModelRoutes: () => Object.freeze([route]),
      refreshModelRoutes: async () => {
        events.push("refresh-models");
        return Object.freeze([route]);
      },
      startTrail: async (input: Parameters<typeof base.startTrail>[0]) => {
        events.push("start-session");
        return await base.startTrail(input);
      },
    });

    await runSlashCommand("/provider", {
      runtime,
      trailId: current.trailId,
      publishInspector: () => undefined,
      dispatch: () => undefined,
      requestRender: () => undefined,
      selectProvider: async () => ({ provider: "provider-next", providerName: "Provider Next" }),
      selectRoute: async () => {
        throw new Error("The provider command must not open the model picker");
      },
      ensureProviderAuthenticated: async () => {
        events.push("authenticate");
        return true;
      },
    });

    expect(events).toEqual(["authenticate", "refresh-models", "start-session"]);
    expect(base.listTrails()).toHaveLength(2);
  });

  test("keeps the current session when provider authentication is cancelled", async () => {
    const base = createInMemoryTestRuntime(agent);
    const current = await base.startTrail({ title: "cancelled provider authentication" });
    const dispatched: NoesisTuiAction[] = [];
    const route = Object.freeze({
      provider: "provider-next",
      providerName: "Provider Next",
      model: "next-model",
      name: "Next model",
      thinkingLevels: Object.freeze(["off"] as const),
      default: true,
      allowsCustomModelIds: false,
    });
    const runtime = Object.freeze({ ...base, listModelRoutes: () => Object.freeze([route]) });

    await runSlashCommand("/provider provider-next", {
      runtime,
      trailId: current.trailId,
      publishInspector: () => undefined,
      dispatch: (action) => dispatched.push(action),
      requestRender: () => undefined,
      ensureProviderAuthenticated: async () => false,
    });

    expect(base.listTrails()).toHaveLength(1);
    expect(dispatched).toEqual([
      {
        type: "notification-shown",
        text: "Authentication cancelled · session unchanged",
        tone: "info",
      },
    ]);
  });

  test("cancels route picking and treats the already-selected model as a no-op", async () => {
    const base = createInMemoryTestRuntime(agent);
    const current = await base.startTrail({ title: "interactive cancel", thinkingLevel: "high" });
    const route = Object.freeze({
      provider: current.provider,
      model: current.model,
      name: "Current model",
      thinkingLevels: Object.freeze(["off", "high"] as const),
      default: true,
      allowsCustomModelIds: false,
    });
    const runtime = Object.freeze({ ...base, listModelRoutes: () => Object.freeze([route]) });
    const cancelled: NoesisTuiAction[] = [];
    await runSlashCommand("/provider", {
      runtime,
      trailId: current.trailId,
      publishInspector: () => undefined,
      dispatch: (action) => cancelled.push(action),
      requestRender: () => undefined,
      selectProvider: async () => undefined,
    });
    expect(cancelled).toEqual([]);

    const unchanged: NoesisTuiAction[] = [];
    await runSlashCommand("/model", {
      runtime,
      trailId: current.trailId,
      publishInspector: () => undefined,
      dispatch: (action) => unchanged.push(action),
      requestRender: () => undefined,
      selectRoute: async () => ({ route, thinkingLevel: current.thinkingLevel }),
    });
    expect(unchanged).toEqual([
      {
        type: "notification-shown",
        text: `Already using reasoning ${current.thinkingLevel} · session unchanged`,
        tone: "info",
      },
    ]);
    expect(base.listTrails()).toHaveLength(1);
  });

  test("changes reasoning from the model picker without creating a new session", async () => {
    const base = createInMemoryTestRuntime(agent);
    const current = await base.startTrail({ title: "picker reasoning", thinkingLevel: "high" });
    const route = Object.freeze({
      provider: current.provider,
      model: current.model,
      name: "Current model",
      thinkingLevels: Object.freeze(["off", "medium", "high"] as const),
      default: true,
      allowsCustomModelIds: false,
    });
    let persisted: string | undefined;
    const dispatched: NoesisTuiAction[] = [];
    const runtime = Object.freeze({
      ...base,
      listModelRoutes: () => Object.freeze([route]),
      setTrailThinkingLevel: async (trailId: string, thinkingLevel: AgentThinkingLevel) => {
        persisted = `${trailId}:${thinkingLevel}`;
        return Object.freeze({ ...base.getTrail(trailId), thinkingLevel });
      },
    });

    await runSlashCommand("/model", {
      runtime,
      trailId: current.trailId,
      publishInspector: () => undefined,
      dispatch: (action) => dispatched.push(action),
      requestRender: () => undefined,
      selectRoute: async () => ({ route, thinkingLevel: "medium" }),
    });

    expect(persisted).toBe(`${current.trailId}:medium`);
    expect(base.listTrails()).toHaveLength(1);
    expect(dispatched).toContainEqual({
      type: "reasoning-level-changed",
      reasoningLevel: "medium",
    });
  });

  test("changes reasoning within the current session when the model supports it", async () => {
    const base = createInMemoryTestRuntime(agent);
    const current = await base.startTrail({ title: "reasoning control", thinkingLevel: "high" });
    let persisted: string | undefined;
    const dispatched: NoesisTuiAction[] = [];
    const runtime = Object.freeze({
      ...base,
      listModelRoutes: () =>
        Object.freeze([
          Object.freeze({
            provider: "test-provider",
            model: "test-model",
            name: "Test model",
            thinkingLevels: Object.freeze(["off", "medium", "high"] as const),
            default: true,
            allowsCustomModelIds: false,
          }),
        ]),
      setTrailThinkingLevel: async (trailId: string, thinkingLevel: AgentThinkingLevel) => {
        persisted = `${trailId}:${thinkingLevel}`;
        return Object.freeze({ ...base.getTrail(trailId), thinkingLevel });
      },
    });

    await expect(
      runSlashCommand("/reasoning medium", {
        runtime,
        trailId: current.trailId,
        publishInspector: () => undefined,
        dispatch: (action) => dispatched.push(action),
        requestRender: () => undefined,
      }),
    ).resolves.toBe(true);

    expect(persisted).toBe(`${current.trailId}:medium`);
    expect(dispatched).toContainEqual({
      type: "reasoning-level-changed",
      reasoningLevel: "medium",
    });
  });

  test("opens the reasoning picker and applies its current-session selection", async () => {
    const base = createInMemoryTestRuntime(agent);
    const current = await base.startTrail({ title: "reasoning picker", thinkingLevel: "high" });
    const route = Object.freeze({
      provider: current.provider,
      model: current.model,
      name: "Current model",
      thinkingLevels: Object.freeze(["off", "medium", "high"] as const),
      default: true,
      allowsCustomModelIds: false,
    });
    let pickerIntent: unknown;
    let persisted: string | undefined;
    const runtime = Object.freeze({
      ...base,
      listModelRoutes: () => Object.freeze([route]),
      setTrailThinkingLevel: async (trailId: string, thinkingLevel: AgentThinkingLevel) => {
        persisted = `${trailId}:${thinkingLevel}`;
        return Object.freeze({ ...base.getTrail(trailId), thinkingLevel });
      },
    });

    await runSlashCommand("/reasoning", {
      runtime,
      trailId: current.trailId,
      publishInspector: () => undefined,
      dispatch: () => undefined,
      requestRender: () => undefined,
      selectRoute: async (intent) => {
        pickerIntent = intent;
        return { route, thinkingLevel: "medium" };
      },
    });

    expect(pickerIntent).toEqual({
      kind: "reasoning",
      currentProvider: current.provider,
      currentModel: current.model,
      currentThinkingLevel: "high",
    });
    expect(persisted).toBe(`${current.trailId}:medium`);
    expect(base.listTrails()).toHaveLength(1);
  });

  test("normalizes surrounding whitespace before matching and parsing arguments", async () => {
    const base = createInMemoryTestRuntime(agent);
    let inspected: readonly string[] = [];
    const runtime = Object.freeze({
      ...base,
      inspectProgram: async (mode: "script" | "workflow", name: string) => {
        inspected = [mode, name];
        return undefined;
      },
    });
    const published: string[] = [];

    const handled = await runSlashCommand(" \t/program script reusable-research \n", {
      runtime,
      trailId: "trail_test",
      publishInspector: (message) => published.push(message),
      dispatch: () => undefined,
      requestRender: () => undefined,
    });

    expect(handled).toBe(true);
    expect(inspected).toEqual(["script", "reusable-research"]);
    expect(published).toEqual(["Unknown script Program: reusable-research"]);
  });

  test("renders quiet, inspectable ambient learning outcomes from the session read model", async () => {
    const base = createInMemoryTestRuntime(agent);
    const requestedSessions: string[] = [];
    const runtime = Object.freeze({
      ...base,
      listLearningActivity: async (sessionId: string) => {
        requestedSessions.push(sessionId);
        // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
        return Object.freeze([
          Object.freeze({
            jobId: "job-reflection-running",
            stage: "reflection" as const,
            status: "running" as const,
            summary: "Running reflection on the completed turn",
            updatedAt: "2026-08-01T00:00:01.000Z",
            turnId: "turn-1",
            capabilityId: "general-collaboration",
          }),
          Object.freeze({
            jobId: "job-reflection-no-change",
            stage: "reflection" as const,
            status: "no_change" as const,
            summary: "The turn already worked well",
            updatedAt: "2026-08-01T00:00:02.000Z",
            turnId: "turn-2",
            projectId: "project-1",
            adjustmentId: "adjustment-1",
            evidenceRefs: Object.freeze([
              Object.freeze({
                kind: "database_row" as const,
                table: "messages" as const,
                rowId: "message-learning-decision",
              }),
            ]),
            workingAdjustment: Object.freeze({
              adjustmentId: "adjustment-1",
              projectId: "project-1",
              status: "active" as const,
              strategy: "Start research by identifying the decisive unknown.",
              successSignal: "The answer resolves the user's actual decision.",
              servedEvidence: Object.freeze([
                Object.freeze({
                  planId: "plan-1",
                  sessionId: "trail-learning",
                  turnId: "turn-served",
                  outcomeId: "outcome-1",
                  outcome: "accepted" as const,
                  summary: "The focused research answer was accepted.",
                  settledAt: "2026-08-01T00:00:01.500Z",
                }),
              ]),
            }),
          }),
          Object.freeze({
            jobId: "job-author-failed",
            stage: "authoring" as const,
            status: "failed" as const,
            summary: "Candidate source could not be validated",
            failure: "Candidate source could not be validated",
            updatedAt: "2026-08-01T00:00:03.000Z",
            experimentId: "experiment-1",
          }),
          Object.freeze({
            jobId: "job-preflight-complete",
            stage: "preflight" as const,
            status: "completed" as const,
            summary: "Preflight decision: pass",
            updatedAt: "2026-08-01T00:00:04.000Z",
            experimentId: "experiment-1",
            capabilityId: "research-brief",
            capabilityRevisionId: "research-brief-v2",
          }),
        ]);
      },
    });
    const published: string[] = [];

    const handled = await runSlashCommand("/learning", {
      runtime,
      trailId: "trail-learning",
      publishInspector: (message) => published.push(message),
      dispatch: () => undefined,
      requestRender: () => undefined,
    });

    expect(handled).toBe(true);
    expect(requestedSessions).toEqual(["trail-learning"]);
    expect(published).toHaveLength(1);
    expect(published[0]).toContain("Learning activity · 4");
    expect(published[0]).toContain("● running · reflection");
    expect(published[0]).toContain("— no change · reflection");
    expect(published[0]).toContain("× failed · authoring");
    expect(published[0]).toContain("✓ completed · preflight");
    expect(published[0]).toContain("experiment experiment-1");
    expect(published[0]).toContain("capability research-brief@research-brief-v2");
    expect(published[0]).toContain("working adjustment · active");
    expect(published[0]).toContain("strategy · Start research by identifying the decisive unknown.");
    expect(published[0]).toContain("success signal · The answer resolves the user's actual decision.");
    expect(published[0]).toContain("served evidence · 1");
    expect(published[0]).toContain("decision evidence · 1");
    expect(published[0]).toContain("messages:message-learning-decision");
    expect(published[0]).toContain("accepted · turn turn-served");
    expect(published[0]).toContain("The focused research answer was accepted.");
    expect(published[0]).toContain("No change is a normal outcome");
    expect(published[0]).not.toContain("approve");
  });

  test("inspects the active project adjustment in a fresh session without inventing activity", async () => {
    const base = createInMemoryTestRuntime(agent);
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const runtime = Object.freeze({
      ...base,
      inspectLearning: async () =>
        Object.freeze({
          activity: Object.freeze([]),
          currentWorkingAdjustment: Object.freeze({
            adjustmentId: "adjustment-fresh",
            projectId: "project-1",
            status: "active" as const,
            strategy: "Inspect observable state before making completion claims.",
            successSignal: "Claims cite the observed state.",
            servedEvidence: Object.freeze([]),
          }),
        }),
    });
    const published: string[] = [];

    await runSlashCommand("/learning", {
      runtime,
      trailId: "fresh-session",
      publishInspector: (message) => published.push(message),
      dispatch: () => undefined,
      requestRender: () => undefined,
    });

    expect(published).toHaveLength(1);
    expect(published[0]).toContain("Learning activity · 0");
    expect(published[0]).toContain("Current project working adjustment · active");
    expect(published[0]).toContain("strategy · Inspect observable state");
    expect(published[0]).toContain("success signal · Claims cite the observed state.");
  });

  test("paginates complete learning history instead of truncating later entries", async () => {
    const base = createInMemoryTestRuntime(agent);
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const activity = Object.freeze(
      Array.from({ length: 240 }, (_, index) =>
        Object.freeze({
          jobId: `job-${String(index).padStart(3, "0")}`,
          stage: "reflection" as const,
          status: "no_change" as const,
          summary: `Reflection ${String(index)} ${"evidence ".repeat(20)}`,
          updatedAt: `2026-08-01T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
          turnId: `turn-${String(index)}`,
        }),
      ),
    );
    const published: string[] = [];
    const runtime = Object.freeze({
      ...base,
      listLearningActivity: async () => activity,
    });

    const handled = await runSlashCommand("/learning", {
      runtime,
      trailId: "trail-long-learning",
      publishInspector: (message) => published.push(message),
      dispatch: () => undefined,
      requestRender: () => undefined,
    });

    expect(handled).toBe(true);
    expect(published.length).toBeGreaterThan(1);
    expect(published[0]).toContain("Learning activity · 240 · page 1/");
    expect(published.at(-1)).toContain("job-239");
    const completeOutput = published.join("\n");
    expect(
      activity.every((entry) => completeOutput.includes(entry.jobId)),
      "every learning entry should remain inspectable across pages",
    ).toBe(true);
    expect(completeOutput).toContain("No change is a normal outcome");
    expect(completeOutput).not.toContain("inspector preview truncated");
    expect(published.every((page) => page.length <= INSPECTOR_PREVIEW_CHARACTERS)).toBe(true);
  });

  test("hydrates inherited history when a fork becomes the active trail", async () => {
    const runtime = createInMemoryTestRuntime(agent);
    const parent = await runtime.startTrail({ title: "parent" });
    await runtime.runTurn(parent.trailId, "keep this context");
    const dispatched: NoesisTuiAction[] = [];

    const handled = await runSlashCommand("/fork", {
      runtime,
      trailId: parent.trailId,
      publishInspector: () => undefined,
      dispatch: (action) => dispatched.push(action),
      requestRender: () => undefined,
    });

    expect(handled).toBe(true);
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]).toMatchObject({ type: "trail-selected" });
    expect(dispatched[1]).toMatchObject({
      type: "transcript-hydrated",
      transcript: [
        expect.objectContaining({ role: "user", text: "keep this context" }),
        expect.objectContaining({ role: "assistant", text: "keep this context" }),
      ],
    });
    if (dispatched[0]?.type !== "trail-selected" || dispatched[1]?.type !== "transcript-hydrated")
      throw new Error("expected a selected and hydrated fork");
    expect(dispatched[1].trailId).toBe(dispatched[0].trail.trailId);
  });
});
