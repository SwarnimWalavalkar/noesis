import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent, AgentRuntimeRequest, NoesisAgentRuntime } from "@noesis/agent-types";
import { resolveNoesisConfig } from "@noesis/config";
import { eventChecksum, type LedgerEvent } from "@noesis/domain";
import { createPiAgentRoleRunner, createPiAgentRuntime } from "@noesis/runtime-pi";
import { createWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkspaceRuntimeInternals } from "../../../packages/workspace/src/protected-runtime.ts";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  createControlledPiModels,
} from "../../../packages/runtime-pi/test/support/controlled-pi-models.ts";
import { createScriptedAgentRoleRunner } from "../../../packages/runtime-pi/test/support/scripted-role-runner.ts";
import { createApplicationRuntimeComposition } from "../src/runtime-composition.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function writeLegacyCompletedTurn(home: string): Promise<{
  readonly trailId: string;
  readonly input: string;
  readonly output: string;
}> {
  const trailId = "trail-legacy-import";
  const input = "Preserve this legitimate history";
  const output = "Imported legacy completion";
  const unsignedStart: Omit<LedgerEvent, "checksum"> = {
    schemaVersion: 1,
    eventId: "event-legacy-start",
    sequence: 1,
    occurredAt: "2026-01-01T00:00:00.000Z",
    principal: "foreground",
    type: "trail.started",
    trailId,
    payload: {
      title: "Legacy import",
      provider: CONTROLLED_PI_PROVIDER,
      model: CONTROLLED_PI_MODEL,
      runtime: "pi-agent-harness-0.80.6",
    },
    previousChecksum: null,
  };
  const start: LedgerEvent = { ...unsignedStart, checksum: eventChecksum(unsignedStart) };
  const unsignedTurn: Omit<LedgerEvent, "checksum"> = {
    schemaVersion: 1,
    eventId: "event-legacy-turn",
    sequence: 2,
    occurredAt: "2026-01-01T00:01:00.000Z",
    principal: "foreground",
    type: "turn.completed",
    trailId,
    payload: { input, output },
    previousChecksum: start.checksum,
  };
  const turn: LedgerEvent = { ...unsignedTurn, checksum: eventChecksum(unsignedTurn) };
  await mkdir(join(home, "ledger"), { recursive: true });
  await writeFile(
    join(home, "ledger", "events.jsonl"),
    `${[start, turn].map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  return Object.freeze({ trailId, input, output });
}

describe("apps/noesis production control-plane composition", () => {
  test("starts from marked SQLite authority without parsing corrupted abandoned JSONL", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-marked-corrupt-legacy-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const first = await createApplicationRuntimeComposition({
      config,
      createAgent: (sessionTools) => createPiAgentRuntime(process.cwd(), controlled.models, { sessionTools }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    const trail = await first.startTrail({ title: "SQLite-authoritative session" });
    await first.shutdown();

    await mkdir(join(home, "ledger"), { recursive: true });
    await writeFile(join(home, "ledger", "events.jsonl"), "{ definitely not valid JSONL\n");

    const reopened = await createApplicationRuntimeComposition({
      config,
      createAgent: (sessionTools) => createPiAgentRuntime(process.cwd(), controlled.models, { sessionTools }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    expect(reopened.getTrail(trail.trailId)).toMatchObject({
      trailId: trail.trailId,
      title: "SQLite-authoritative session",
    });
    await reopened.shutdown();
  });

  test("imports completed pre-marker legacy turns once and retains them for resume", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-pre-marker-import-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const legacy = await writeLegacyCompletedTurn(home);

    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (sessionTools) => createPiAgentRuntime(process.cwd(), controlled.models, { sessionTools }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    expect(runtime.getTrail(legacy.trailId).turns).toEqual([
      {
        input: legacy.input,
        output: legacy.output,
      },
    ]);
    await runtime.shutdown();
  });

  test("retains an aborted partial pair for inspection but excludes it after restart and resume", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-aborted-replay-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const noOp = async (): Promise<void> => undefined;
    const abortedAgent: NoesisAgentRuntime = Object.freeze({
      name: "pi-agent-harness-0.80.6",
      run: async (request: AgentRuntimeRequest) =>
        Object.freeze({
          outcome: "aborted" as const,
          stopReason: "aborted" as const,
          text: "partial answer that must not resume",
          provider: request.provider,
          model: request.model,
        }),
      steer: noOp,
      followUp: noOp,
      abort: noOp,
    });
    const first = await createApplicationRuntimeComposition({
      config,
      agent: abortedAgent,
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    const trail = await first.startTrail({ title: "Aborted partial replay" });
    const aborted = await first.runTurn(trail.trailId, "input attached to an aborted answer");
    expect(aborted).toMatchObject({
      outcome: "aborted",
      output: "partial answer that must not resume",
    });
    expect(await first.debug.workspace.operational.messages.listForSession(trail.trailId)).toMatchObject([
      { role: "user", content: "input attached to an aborted answer" },
      { role: "assistant", content: "partial answer that must not resume" },
    ]);
    expect(await first.debug.workspace.operational.outcomes.listForSession(trail.trailId)).toMatchObject([
      {
        status: "failed",
        metadata: { aborted: true, replayEligible: false },
      },
    ]);
    await first.shutdown();

    const requests: AgentRuntimeRequest[] = [];
    const resumedAgent: NoesisAgentRuntime = Object.freeze({
      name: abortedAgent.name,
      run: async (request: AgentRuntimeRequest) => {
        requests.push(request);
        return Object.freeze({
          outcome: "completed" as const,
          stopReason: "stop" as const,
          text: "clean resumed completion",
          provider: request.provider,
          model: request.model,
        });
      },
      steer: noOp,
      followUp: noOp,
      abort: noOp,
    });
    const reopened = await createApplicationRuntimeComposition({
      config,
      agent: resumedAgent,
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });
    expect(reopened.getTrail(trail.trailId).turns).toEqual([]);
    await reopened.resumeTrail(trail.trailId);
    await reopened.runTurn(trail.trailId, "continue with clean context");
    expect(requests[0]?.systemPrompt).not.toContain("partial answer that must not resume");
    expect(requests[0]?.systemPrompt).not.toContain("input attached to an aborted answer");
    expect(await reopened.debug.workspace.operational.messages.listForSession(trail.trailId)).toHaveLength(4);
    await reopened.shutdown();
  });

  test("a real app turn pins admission and records exact durable operational work", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-control-plane-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    const requests: AgentRuntimeRequest[] = [];
    const seenConfigurations: unknown[] = [];
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (sessionTools) => {
        const pi = createPiAgentRuntime(process.cwd(), controlled.models, { sessionTools });
        const capturingAgent: NoesisAgentRuntime = Object.freeze({
          ...pi,
          run: async (request: AgentRuntimeRequest, emit: (event: AgentRuntimeEvent) => void) => {
            requests.push(request);
            return await pi.run(request, emit);
          },
        });
        return capturingAgent;
      },
      createRoleRunner: (configurations) => {
        seenConfigurations.push(...configurations);
        return createPiAgentRoleRunner(process.cwd(), controlled.models, configurations);
      },
    });

    const trail = await runtime.startTrail({ title: "Composition acceptance" });
    const result = await runtime.runTurn(trail.trailId, "Record this ordinary turn");
    expect(result.outcome).toBe("completed");
    expect(config.schemaVersion).toBe(1);
    expect(await runtime.debug.workspace.operational.sessions.get(trail.trailId)).toMatchObject({
      sessionId: trail.trailId,
      runtime: "pi-agent-harness-0.80.6",
    });
    const messages = await runtime.debug.workspace.operational.messages.listForSession(trail.trailId);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    const outcomes = await runtime.debug.workspace.operational.outcomes.listForSession(trail.trailId);
    expect(outcomes).toMatchObject([{ status: "accepted", summary: result.output }]);
    const turnId = String(messages[0]?.metadata["turnId"]);
    expect(await runtime.debug.workspace.operational.foregroundTurns.get(turnId)).toMatchObject({
      sessionId: trail.trailId,
      status: "completed",
      outcomeId: `${turnId}:outcome`,
    });
    const pin = await runtime.debug.adaptations.activations.getTurnPin(trail.trailId, turnId);
    const storedPlan = await runtime.debug.adaptations.activations.getTurnPlan(trail.trailId, turnId);
    const deliveredPlan = requests[0]?.frozenTurnPlan;
    expect(pin).toMatchObject({
      activationId: "activation_genesis",
      activeCapabilityRevisions: {
        "general-collaboration": { capabilityRevisionId: "general-collaboration-genesis-v1" },
      },
    });
    expect(deliveredPlan).toEqual(storedPlan);
    expect(result.frozenTurnPlan).toEqual(storedPlan);
    expect(requests[0]?.systemPrompt).toBe(storedPlan?.renderedSystemPrompt);
    expect(storedPlan).toMatchObject({
      schemaVersion: 1,
      sessionId: trail.trailId,
      turnId,
      selectedCapabilities: [
        {
          capabilityId: "general-collaboration",
          baseline: { kind: "genesis" },
          promptModules: [
            {
              content: expect.stringContaining("thinking-and-creation partner"),
            },
          ],
          tools: [],
        },
      ],
    });
    expect(await runtime.debug.workspace.definitionMetadata.listCurrent("runtime_role")).toHaveLength(7);
    expect(JSON.stringify(seenConfigurations)).not.toMatch(
      /protectedActivations|protectedFeedback|authorityBoundary|restorationHandle/iu,
    );
    expect("promoteCandidate" in runtime).toBe(false);

    await runtime.shutdown();
    const reopened = await createWorkspaceStore(home);
    const reopenedProtected = createWorkspaceRuntimeInternals(reopened).protectedRuntime;
    expect(await reopened.operational.messages.listForSession(trail.trailId)).toHaveLength(2);
    expect(await reopened.operational.outcomes.listForSession(trail.trailId)).toHaveLength(1);
    expect(await reopenedProtected.activations.getTurnPin(trail.trailId, turnId)).toBeDefined();
    expect(await reopenedProtected.activations.getTurnPlan(trail.trailId, turnId)).toEqual(storedPlan);
    reopened.close();
  });

  test("a first-turn correction on a fresh home reflects against the immutable genesis baseline", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-genesis-correction-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    let reflectorRuns = 0;
    const controlled = createControlledPiModels({
      respond: ({ systemPrompt, lastUserText }) => {
        if (!systemPrompt.includes("role: reflector")) return `Controlled completion for: ${lastUserText}`;
        reflectorRuns += 1;
        return JSON.stringify({
          decision: "no_change",
          reason: "The single correction is useful evidence but not yet a durable adaptation.",
        });
      },
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (sessionTools) => createPiAgentRuntime(process.cwd(), controlled.models, { sessionTools }),
      createRoleRunner: (configurations) =>
        createPiAgentRoleRunner(process.cwd(), controlled.models, configurations),
    });

    const trail = await runtime.startTrail({ title: "First correction" });
    const result = await runtime.runTurn(trail.trailId, "Actually, keep this research brief concise.");
    expect(result.frozenTurnPlan?.selectedCapabilities).toMatchObject([
      {
        capabilityId: "general-collaboration",
        baseline: { kind: "genesis" },
      },
    ]);
    await runtime.controlPlane.idle();
    expect(reflectorRuns).toBe(1);
    const outcomes = await runtime.debug.workspace.operational.outcomes.listForSession(trail.trailId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: "corrected" });
    await runtime.shutdown();
  });

  test("bounds shutdown when ambient reflection ignores abort and leaves recovery to its durable lease", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-bounded-shutdown-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    let markReflectionStarted: (() => void) | undefined;
    const reflectionStarted = new Promise<void>((resolve) => {
      markReflectionStarted = resolve;
    });
    let releaseReflection: (() => void) | undefined;
    const blockedReflection = new Promise<void>((resolve) => {
      releaseReflection = resolve;
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (sessionTools) => createPiAgentRuntime(process.cwd(), controlled.models, { sessionTools }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: async (request) => {
            if (!request.systemPrompt.includes("role: reflector"))
              throw new Error("Only reflection should run in the bounded-shutdown fixture");
            markReflectionStarted?.();
            await blockedReflection;
            return Object.freeze({
              text: JSON.stringify({
                decision: "no_change",
                reason: "The fixture releases only after bounded shutdown returns.",
              }),
            });
          },
        }),
    });

    const trail = await runtime.startTrail({ title: "Bounded ambient shutdown" });
    await runtime.runTurn(trail.trailId, "Actually, keep this research brief concise.");
    await reflectionStarted;

    let timeout: NodeJS.Timeout | undefined;
    try {
      const shutdown = runtime.shutdown();
      expect(runtime.shutdown()).toBe(shutdown);
      const outcome = await Promise.race([
        shutdown.then(() => "settled" as const),
        new Promise<"timed-out">((resolve) => {
          timeout = setTimeout(() => resolve("timed-out"), 1_000);
        }),
      ]);
      expect(outcome).toBe("settled");
      const jobs = await runtime.debug.workspace.jobs.list({ limit: 10 });
      expect(jobs).toMatchObject([
        {
          kind: "runtime.reflect_turn",
          status: "running",
          leaseToken: expect.any(String),
          leaseUntil: expect.any(String),
        },
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      releaseReflection?.();
      await runtime.controlPlane.stop();
    }
  });

  test("propagates shutdown cancellation through learning into an active ambient role run", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-app-cooperative-reflection-shutdown-"));
    roots.push(home);
    const config = await resolveNoesisConfig({
      home,
      env: Object.freeze({}),
      cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
    });
    const controlled = createControlledPiModels();
    let markReflectionStarted: (() => void) | undefined;
    const reflectionStarted = new Promise<void>((resolve) => {
      markReflectionStarted = resolve;
    });
    let markReflectionAborted: (() => void) | undefined;
    const reflectionAborted = new Promise<void>((resolve) => {
      markReflectionAborted = resolve;
    });
    let releaseReflection: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseReflection = resolve;
    });
    const runtime = await createApplicationRuntimeComposition({
      config,
      createAgent: (sessionTools) => createPiAgentRuntime(process.cwd(), controlled.models, { sessionTools }),
      createRoleRunner: (configurations) =>
        createScriptedAgentRoleRunner({
          variants: configurations,
          respond: async (request) => {
            if (!request.systemPrompt.includes("role: reflector"))
              throw new Error("Only reflection should run in the cooperative-shutdown fixture");
            markReflectionStarted?.();
            await Promise.race([
              release,
              new Promise<void>((resolve) => {
                const onAbort = () => {
                  markReflectionAborted?.();
                  resolve();
                };
                if (request.signal.aborted) onAbort();
                else request.signal.addEventListener("abort", onAbort, { once: true });
              }),
            ]);
            return Object.freeze({
              text: JSON.stringify({
                decision: "no_change",
                reason: "The role run settled after receiving shutdown cancellation.",
              }),
            });
          },
        }),
    });

    try {
      const trail = await runtime.startTrail({ title: "Cooperative ambient shutdown" });
      await runtime.runTurn(trail.trailId, "Actually, keep this research brief concise.");
      await reflectionStarted;

      await runtime.shutdown();
      const cancellation = await Promise.race([
        reflectionAborted.then(() => "aborted" as const),
        new Promise<"timed-out">((resolve) => {
          const timeout = setTimeout(() => resolve("timed-out"), 1_000);
          timeout.unref();
        }),
      ]);

      expect(cancellation).toBe("aborted");
    } finally {
      releaseReflection?.();
      await runtime.controlPlane.stop();
    }
  });
});
