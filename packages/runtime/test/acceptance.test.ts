import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { renderContext } from "@noesis/context";
import { createLearningEngine } from "@noesis/learning";
import type {
  AgentRuntimeEvent,
  AgentRuntimeRequest,
  AgentRuntimeResult,
  NoesisAgentRuntime,
} from "@noesis/agent-types";
import { createDurableScheduler, createNoesisRuntime, SESSION_PICKER_LIMIT } from "../src/index.ts";
import { createFakeAgentRuntime } from "./fake-runtime.ts";

describe("integrated compounding loop", () => {
  test("isolates state across independent runtime factories", async () => {
    const first = await createNoesisRuntime(
      await mkdtemp(join(tmpdir(), "noesis-runtime-isolated-a-")),
      createFakeAgentRuntime(),
    );
    const second = await createNoesisRuntime(
      await mkdtemp(join(tmpdir(), "noesis-runtime-isolated-b-")),
      createFakeAgentRuntime(),
    );

    await first.startTrail({ title: "first only" });

    expect(first.listTrails()).toHaveLength(1);
    expect(second.listTrails()).toHaveLength(0);
  });

  test("later work uses evaluated and authority-promoted learning", async () => {
    const runtime = await createNoesisRuntime(
      await mkdtemp(join(tmpdir(), "noesis-runtime-")),
      createFakeAgentRuntime(),
    );
    const first = await runtime.startTrail({ title: "source" });
    await runtime.runTurn(first.trailId, "Create an evidence brief");
    const learning = createLearningEngine(runtime.ledger);
    const workflow = (await learning.reflect(first.trailId)).find((proposal) => proposal.kind === "workflow");
    expect(workflow).toBeDefined();
    if (!workflow) return;
    const candidate = await runtime.capabilities.createCandidate(
      learning.candidateFromWorkflow(workflow, [
        {
          caseId: "source",
          source: "source",
          input: "brief",
          expectedIncludes: ["evidenced", "pattern"],
          baselineScore: 0,
        },
      ]),
    );
    expect((await runtime.evaluateCandidate(candidate.capabilityId, candidate.version)).passed).toBe(true);
    await runtime.promoteCandidate(candidate.capabilityId, candidate.version);
    const later = await runtime.startTrail({ title: "later" });
    const result = await runtime.runTurn(later.trailId, "Create the next brief");

    expect(result.usedCapabilities).toEqual({ [candidate.name]: candidate.version });
    expect(result.output).toContain(`${candidate.name}@${candidate.version}`);
    expect(runtime.ledger.findByType("capability.used")).toHaveLength(1);
  });

  test("restores the last frozen context and pinned capability versions after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-runtime-hydrate-"));
    const runtime = await createNoesisRuntime(root, createFakeAgentRuntime());
    const trail = await runtime.startTrail({ title: "hydrate" });
    const turn = await runtime.runTurn(trail.trailId, "remember this context");
    const recovered = await createNoesisRuntime(root, createFakeAgentRuntime());
    expect(recovered.getTrail(trail.trailId).context).toEqual(turn.context);
    expect(recovered.getTrail(trail.trailId).capabilityVersions).toEqual(turn.usedCapabilities);
  });

  test("keeps existing single-trail data resumable with deterministic summary metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-runtime-single-resume-"));
    const original = await createNoesisRuntime(root, createFakeAgentRuntime());
    const trail = await original.startTrail({ title: "historical trail" });
    await original.runTurn(trail.trailId, "first durable user message");

    const reopened = await createNoesisRuntime(root, createFakeAgentRuntime());
    expect(reopened.listTrailSummaries()).toEqual([
      expect.objectContaining({
        trailId: trail.trailId,
        title: "historical trail",
        preview: "first durable user message",
        turnCount: 1,
        messageCount: 2,
      }),
    ]);
    const resumed = await reopened.resumeTrail(trail.trailId);
    expect(resumed.turns).toEqual([expect.objectContaining({ input: "first durable user message" })]);
    expect(resumed.status).toBe("idle");
  });

  test("resumes an older exact trail even when it is outside the picker cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-runtime-resume-outside-cap-"));
    const runtime = await createNoesisRuntime(root, createFakeAgentRuntime());
    const oldest = await runtime.startTrail({ title: "oldest exact session" });
    for (let index = 0; index < SESSION_PICKER_LIMIT; index += 1)
      await runtime.startTrail({ title: `newer session ${index}` });

    const summaries = runtime.listTrailSummaries();
    expect(summaries).toHaveLength(SESSION_PICKER_LIMIT);
    expect(summaries.some((summary) => summary.trailId === oldest.trailId)).toBe(false);
    await expect(runtime.resumeTrail(oldest.trailId)).resolves.toMatchObject({
      trailId: oldest.trailId,
      title: "oldest exact session",
    });
  }, 20_000);

  test("direct resume preserves its provider, model, and history without other-trail leakage", async () => {
    const requests: AgentRuntimeRequest[] = [];
    const agent: NoesisAgentRuntime = {
      name: "resume-capture",
      async run(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
        requests.push(request);
        return {
          text: `captured:${request.prompt}`,
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer(): Promise<void> {},
      async followUp(): Promise<void> {},
      async abort(): Promise<void> {},
    };
    const root = await mkdtemp(join(tmpdir(), "noesis-runtime-direct-resume-"));
    const original = await createNoesisRuntime(root, agent);
    const selected = await original.startTrail({
      title: "selected",
      provider: "preserved-provider",
      model: "preserved-model",
    });
    await original.runTurn(selected.trailId, "selected durable history");
    const other = await original.startTrail({
      title: "other",
      provider: "other-provider",
      model: "other-model",
    });
    await original.runTurn(other.trailId, "other trail secret");

    const reopened = await createNoesisRuntime(root, agent, {
      provider: "new-default-provider",
      model: "new-default-model",
      thinkingLevel: "off",
    });
    const resumed = await reopened.resumeTrail(selected.trailId);
    expect(resumed).toMatchObject({
      trailId: selected.trailId,
      provider: "preserved-provider",
      model: "preserved-model",
      turns: [
        {
          input: "selected durable history",
          output: "captured:selected durable history",
        },
      ],
    });
    await reopened.runTurn(selected.trailId, "continued selected session");
    const request = requests.at(-1);
    expect(request).toMatchObject({
      trailId: selected.trailId,
      provider: "preserved-provider",
      model: "preserved-model",
      prompt: "continued selected session",
    });
    expect(request?.systemPrompt).toContain("selected durable history");
    expect(request?.systemPrompt).not.toContain("other trail secret");
  });

  test("rejects a reopened trail pinned to another runtime before recording a turn", async () => {
    const alternateRuntime: NoesisAgentRuntime = {
      name: "alternate",
      async run(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
        return {
          text: "alternate",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer(): Promise<void> {},
      async followUp(): Promise<void> {},
      async abort(): Promise<void> {},
    };

    const home = await mkdtemp(join(tmpdir(), "noesis-runtime-switch-"));
    const original = await createNoesisRuntime(home, createFakeAgentRuntime());
    const fakeTrail = await original.startTrail({ title: "fake trail" });
    const reopened = await createNoesisRuntime(home, alternateRuntime);

    await expect(reopened.runTurn(fakeTrail.trailId, "wrong adapter")).rejects.toThrow(
      /pinned to runtime fake; active runtime is alternate/,
    );
    expect(reopened.ledger.findByType("turn.started")).toHaveLength(0);

    const alternateTrail = await reopened.startTrail({ title: "alternate trail" });
    await expect(reopened.runTurn(alternateTrail.trailId, "right adapter")).resolves.toMatchObject({
      output: "alternate",
    });
  });

  test("admits only one concurrent turn for a trail", async () => {
    let releaseExecution: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let executions = 0;
    const agent: NoesisAgentRuntime = {
      name: "blocking",
      async run(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
        executions += 1;
        markStarted?.();
        await blocked;
        return {
          text: "done",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer(): Promise<void> {},
      async followUp(): Promise<void> {},
      async abort(): Promise<void> {},
    };
    const runtime = await createNoesisRuntime(await mkdtemp(join(tmpdir(), "noesis-turn-admission-")), agent);
    const trail = await runtime.startTrail({ title: "one active turn" });

    const first = runtime.runTurn(trail.trailId, "first");
    const second = runtime.runTurn(trail.trailId, "second");
    const rejected = expect(second).rejects.toThrow("already running");
    await started;
    await rejected;
    expect(executions).toBe(1);
    expect(runtime.ledger.findByType("turn.started")).toHaveLength(1);

    releaseExecution?.();
    await expect(first).resolves.toMatchObject({ output: "done" });
    expect(runtime.ledger.findByType("turn.completed")).toHaveLength(1);
  });

  test("opening a second runtime leaves an ambiguous running trail unchanged", async () => {
    let releaseExecution: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const agent: NoesisAgentRuntime = {
      name: "shared-blocking",
      async run(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
        markStarted?.();
        await blocked;
        return {
          text: "done",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer(): Promise<void> {},
      async followUp(): Promise<void> {},
      async abort(): Promise<void> {},
    };
    const home = await mkdtemp(join(tmpdir(), "noesis-running-replay-"));
    const executor = await createNoesisRuntime(home, agent);
    const trail = await executor.startTrail({ title: "live executor" });
    const activeTurn = executor.runTurn(trail.trailId, "stay blocked");
    await started;

    try {
      const observer = await createNoesisRuntime(home, agent);
      expect(observer.getTrail(trail.trailId).status).toBe("running");
      expect(observer.ledger.findByType("trail.recovered")).toHaveLength(0);
      expect(observer.ledger.findByType("trail.resumed")).toHaveLength(0);
      await expect(observer.resumeTrail(trail.trailId)).rejects.toThrow(
        /still marked running.*automatic recovery is unavailable/,
      );
      await expect(observer.runTurn(trail.trailId, "must not execute")).rejects.toThrow("already running");
      expect(observer.ledger.findByType("turn.started")).toHaveLength(1);

      const independent = await observer.startTrail({ title: "independent plain start" });
      expect(independent.trailId).not.toBe(trail.trailId);
      expect(observer.getTrail(trail.trailId).status).toBe("running");
      expect(observer.ledger.findByType("trail.recovered")).toHaveLength(0);
      expect(observer.ledger.findByType("trail.resumed")).toHaveLength(0);
    } finally {
      releaseExecution?.();
      await activeTurn;
    }
  });

  test("resume CAS refreshes a stale idle observation and rejects a concurrent turn", async () => {
    let releaseExecution: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const agent: NoesisAgentRuntime = {
      name: "resume-race",
      async run(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
        markStarted?.();
        await blocked;
        return {
          text: "done",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer(): Promise<void> {},
      async followUp(): Promise<void> {},
      async abort(): Promise<void> {},
    };
    const home = await mkdtemp(join(tmpdir(), "noesis-resume-cas-race-"));
    const executor = await createNoesisRuntime(home, agent);
    const trail = await executor.startTrail({ title: "CAS race" });
    const staleObserver = await createNoesisRuntime(home, agent);
    expect(staleObserver.getTrail(trail.trailId).status).toBe("idle");

    const activeTurn = executor.runTurn(trail.trailId, "land after stale replay");
    await started;
    try {
      await expect(staleObserver.resumeTrail(trail.trailId)).rejects.toThrow(/still marked running/);
      expect(staleObserver.getTrail(trail.trailId).status).toBe("running");
      expect(staleObserver.ledger.findByType("trail.resumed")).toHaveLength(0);
      expect(staleObserver.ledger.findByType("trail.recovered")).toHaveLength(0);
      expect(staleObserver.ledger.findByType("turn.started")).toHaveLength(1);
    } finally {
      releaseExecution?.();
      await activeTurn;
    }

    await expect(staleObserver.resumeTrail(trail.trailId)).resolves.toMatchObject({
      trailId: trail.trailId,
      status: "idle",
      turns: [{ input: "land after stale replay", output: "done" }],
    });
    expect(staleObserver.ledger.findByType("trail.resumed")).toHaveLength(1);
  });

  test("uses exactly the bounded durable context as the agent system prompt", async () => {
    let capturedRequest: AgentRuntimeRequest | undefined;
    const agent: NoesisAgentRuntime = {
      name: "capture",
      async run(
        request: AgentRuntimeRequest,
        _emit: (event: AgentRuntimeEvent) => void,
      ): Promise<AgentRuntimeResult> {
        capturedRequest = request;
        return {
          text: "captured",
          provider: "fake",
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer(): Promise<void> {},
      async followUp(): Promise<void> {},
      async abort(): Promise<void> {},
    };
    const runtime = await createNoesisRuntime(await mkdtemp(join(tmpdir(), "noesis-prompt-")), agent);
    const oversized = await runtime.capabilities.createCandidate({
      name: "large-skill",
      description: "oversized",
      instructions: `apply an evidenced completion pattern ${"secret-tail ".repeat(2_000)}`,
      evidenceEventIds: ["evt-source"],
      manifest: { effects: ["read"], resourcePrefixes: ["workspace:"], maxCostPerRun: 1 },
      cases: [
        { caseId: "source", source: "source", input: "x", expectedIncludes: ["evidenced"], baselineScore: 0 },
      ],
    });
    await runtime.evaluateCandidate(oversized.capabilityId, oversized.version);
    await runtime.promoteCandidate(oversized.capabilityId, oversized.version);
    const trail = await runtime.startTrail({ title: "bounded" });
    const result = await runtime.runTurn(trail.trailId, "test prompt bounds");
    expect(capturedRequest?.systemPrompt).toBe(renderContext(result.context));
    expect(capturedRequest?.systemPrompt).not.toContain("secret-tail ".repeat(1_000));
  });

  test("threads the configured thinking level to the agent adapter without collapsing off or low", async () => {
    const requests: AgentRuntimeRequest[] = [];
    const agent: NoesisAgentRuntime = {
      name: "capture-thinking",
      async run(
        request: AgentRuntimeRequest,
        _emit: (event: AgentRuntimeEvent) => void,
      ): Promise<AgentRuntimeResult> {
        requests.push(request);
        return {
          text: "captured",
          provider: request.provider,
          model: request.model,
          outcome: "completed",
          stopReason: "stop",
        };
      },
      async steer(): Promise<void> {},
      async followUp(): Promise<void> {},
      async abort(): Promise<void> {},
    };
    const runtime = await createNoesisRuntime(await mkdtemp(join(tmpdir(), "noesis-thinking-")), agent, {
      provider: "openai-codex",
      model: "gpt-5.5",
      thinkingLevel: "low",
    });
    const trail = await runtime.startTrail({ title: "configured thinking" });
    await runtime.runTurn(trail.trailId, "first");
    await runtime.runTurn(trail.trailId, "second", { thinkingLevel: "off" });

    expect(requests.map((request) => request.thinkingLevel)).toEqual(["low", "off"]);
    expect(runtime.ledger.findByType("turn.started").map((event) => event.payload["thinkingLevel"])).toEqual([
      "low",
      "off",
    ]);
  });

  test("rehydrates terminal jobs and does not spend a budget-one job twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-job-restart-"));
    const runtime = await createNoesisRuntime(root, createFakeAgentRuntime());
    const scheduler = createDurableScheduler(runtime);
    const job = await scheduler.schedule({ prompt: "background", schedule: "every 1h", budget: 1 });
    await scheduler.run(job);
    const recovered = await createNoesisRuntime(root, createFakeAgentRuntime());
    const recoveredScheduler = createDurableScheduler(recovered);
    await expect(recoveredScheduler.run(job.jobId)).rejects.toThrow(/terminal|budget/);
    expect(recovered.ledger.findByType("job.lease_acquired")).toHaveLength(1);
    expect(recovered.ledger.findByType("job.heartbeat")).not.toHaveLength(0);
  });
});
