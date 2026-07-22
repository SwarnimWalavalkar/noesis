import { createId, toJsonValue, type TrailStatus } from "@noesis/domain";
import {
  compileContext,
  decodeContextSnapshot,
  renderContext,
  type ContextFragment,
  type ContextSnapshot,
} from "@noesis/context";
import { createCapabilityRegistry, type CapabilityRegistry } from "@noesis/capabilities";
import { createEvaluationLab, PROTECTED_PROMOTION_POLICY, type EvaluationReport } from "@noesis/evals";
import {
  createArtifactStore,
  createExperienceLedger,
  LedgerConflictError,
  TRAIL_PICKER_LIMIT,
  type ArtifactStore,
  type ExperienceLedger,
} from "@noesis/ledger";
import { createMemoryRepository, type MemoryRepository } from "@noesis/memory";
import { createAuthorityBoundary, type AuthorityBoundary } from "@noesis/policy";
import type {
  AgentContextUsage,
  AgentRuntimeEvent,
  AgentThinkingLevel,
  NoesisAgentRuntime,
} from "@noesis/agent-types";

export { compareTrailRecency } from "@noesis/ledger";
export * from "./coordinator-contracts.ts";
export * from "./coordinator.ts";
export * from "./coordinator-composition.ts";
export * from "./preflight-policy.ts";
export * from "./atomic-activation.ts";
export * from "./protected-activation.ts";

export interface TrailState {
  readonly trailId: string;
  readonly parentTrailId?: string;
  readonly title: string;
  readonly status: TrailStatus;
  readonly provider: string;
  readonly model: string;
  readonly runtime: string;
  readonly contextSnapshotId?: string;
  readonly context?: ContextSnapshot;
  readonly capabilityVersions: Readonly<Record<string, number>>;
  readonly turns: readonly { readonly input: string; readonly output: string }[];
}

export interface TrailSummary {
  readonly trailId: string;
  readonly parentTrailId?: string;
  readonly title: string;
  readonly status: TrailStatus;
  readonly provider: string;
  readonly model: string;
  readonly runtime: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turnCount: number;
  readonly messageCount: number;
  readonly preview: string;
}

/** Maximum number of recent sessions returned for interactive selection. */
export const SESSION_PICKER_LIMIT = TRAIL_PICKER_LIMIT;

export interface StartTrailInput {
  readonly title: string;
  readonly provider?: string;
  readonly model?: string;
}

export interface RunTurnOptions {
  readonly onEvent?: (event: AgentRuntimeEvent) => void;
  readonly thinkingLevel?: AgentThinkingLevel;
}

export interface RuntimeAgentDefaults {
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: AgentThinkingLevel;
}

const DEFAULT_AGENT_SETTINGS: RuntimeAgentDefaults = {
  provider: "fake",
  model: "noesis-fake-1",
  thinkingLevel: "off",
};

const RESUME_ATTEMPTS = 3;

const runningTrailResumeError = (trailId: string): Error =>
  new Error(
    `Session ${trailId} is still marked running. Wait for its in-flight turn to finish. If its executor was interrupted, automatic recovery is unavailable until explicit execution ownership recovery is implemented.`,
  );

const isTrailStatus = (value: string): value is TrailStatus =>
  value === "idle" ||
  value === "running" ||
  value === "aborted" ||
  value === "failed" ||
  value === "completed";

export interface TurnResult {
  readonly outcome: "completed" | "aborted";
  readonly output: string;
  readonly context: ContextSnapshot;
  readonly usedCapabilities: Readonly<Record<string, number>>;
  readonly contextUsage?: AgentContextUsage;
}

export interface NoesisRuntime {
  readonly ledger: ExperienceLedger;
  readonly artifacts: ArtifactStore;
  readonly memory: MemoryRepository;
  readonly capabilities: CapabilityRegistry;
  readonly agent: NoesisAgentRuntime;
  readonly agentDefaults: RuntimeAgentDefaults;
  readonly startTrail: (input: StartTrailInput) => Promise<TrailState>;
  readonly listTrails: () => readonly TrailState[];
  /** Returns at most SESSION_PICKER_LIMIT sessions, newest activity first. */
  readonly listTrailSummaries: () => readonly TrailSummary[];
  readonly getTrail: (trailId: string) => TrailState;
  readonly resumeTrail: (trailId: string) => Promise<TrailState>;
  readonly forkTrail: (trailId: string, title?: string) => Promise<TrailState>;
  readonly runTurn: (trailId: string, input: string, options?: RunTurnOptions) => Promise<TurnResult>;
  readonly steer: (trailId: string, text: string) => Promise<void>;
  readonly followUp: (trailId: string, text: string) => Promise<void>;
  readonly abort: (trailId: string) => Promise<void>;
  readonly compact: (trailId: string) => Promise<void>;
  readonly evaluateCandidate: (capabilityId: string, version: number) => Promise<EvaluationReport>;
  readonly promoteCandidate: (capabilityId: string, version: number) => Promise<void>;
  readonly rollbackCapability: (capabilityId: string, version: number, reason: string) => Promise<void>;
  readonly commitScheduledJob: (job: ScheduledJob) => Promise<void>;
  readonly runScheduledEffect: (
    jobId: string,
    runNumber: number,
    leaseToken: string,
    prompt: string,
  ) => Promise<string>;
}

export async function createNoesisRuntime(
  home: string,
  agent: NoesisAgentRuntime,
  agentDefaults: RuntimeAgentDefaults = DEFAULT_AGENT_SETTINGS,
): Promise<NoesisRuntime> {
  const ledger = createExperienceLedger(home);
  await ledger.initialize();
  const artifacts = createArtifactStore(ledger);
  const memory = createMemoryRepository(ledger);
  const authority: AuthorityBoundary = createAuthorityBoundary(ledger);
  const capabilities = createCapabilityRegistry(
    ledger,
    PROTECTED_PROMOTION_POLICY,
    authority.receiptVerifier,
  );

  async function startTrail(input: StartTrailInput): Promise<TrailState> {
    const trailId = createId("trail");
    await ledger.append({
      type: "trail.started",
      principal: "foreground",
      trailId,
      payload: {
        title: input.title,
        provider: input.provider ?? agentDefaults.provider,
        model: input.model ?? agentDefaults.model,
        runtime: agent.name,
      },
    });
    return getTrail(trailId);
  }

  function listTrails(): readonly TrailState[] {
    const ids = new Set(ledger.readAll().flatMap((event) => (event.trailId ? [event.trailId] : [])));
    return [...ids].map((id) => getTrail(id));
  }

  function listTrailSummaries(): readonly TrailSummary[] {
    return ledger.listTrailProjections().flatMap((projection) => {
      if (!isTrailStatus(projection.status)) return [];
      return [
        {
          trailId: projection.trailId,
          ...(projection.parentTrailId ? { parentTrailId: projection.parentTrailId } : {}),
          title: projection.title,
          status: projection.status,
          provider: projection.provider,
          model: projection.model,
          runtime: projection.runtime,
          createdAt: projection.createdAt,
          updatedAt: projection.updatedAt,
          turnCount: projection.turnCount,
          messageCount: projection.turnCount * 2,
          preview: projection.preview,
        },
      ];
    });
  }

  function getTrail(trailId: string): TrailState {
    const events = ledger.eventsForTrail(trailId);
    const start = events.find((event) => event.type === "trail.started" || event.type === "trail.forked");
    if (!start) throw new Error(`Trail not found: ${trailId}`);
    let status: TrailStatus = "idle";
    for (const event of events) {
      if (event.type === "turn.started") status = "running";
      else if (
        event.type === "trail.resumed" ||
        event.type === "turn.completed" ||
        event.type === "trail.recovered" ||
        event.type === "trail.compacted"
      )
        status = "idle";
      else if (event.type === "trail.aborted") status = "aborted";
      else if (event.type === "turn.failed") status = "failed";
    }
    const turns = events
      .filter((event) => event.type === "turn.completed")
      .map((event) => ({ input: String(event.payload["input"]), output: String(event.payload["output"]) }));
    const latestTurn = [...events].reverse().find((event) => event.type === "turn.started");
    const contextValue = latestTurn?.payload["context"];
    const context = decodeContextSnapshot(contextValue);
    const versionsValue = latestTurn?.payload["capabilityVersions"];
    const capabilityVersions =
      versionsValue && typeof versionsValue === "object" && !Array.isArray(versionsValue)
        ? Object.fromEntries(
            Object.entries(versionsValue).flatMap(([name, version]) =>
              typeof version === "number" ? [[name, version] as const] : [],
            ),
          )
        : {};
    return {
      trailId,
      ...(typeof start.payload["parentTrailId"] === "string"
        ? { parentTrailId: start.payload["parentTrailId"] }
        : {}),
      title: String(start.payload["title"]),
      status,
      provider: String(start.payload["provider"]),
      model: String(start.payload["model"]),
      runtime: String(start.payload["runtime"]),
      ...(typeof latestTurn?.payload["contextSnapshotId"] === "string"
        ? { contextSnapshotId: latestTurn.payload["contextSnapshotId"] }
        : {}),
      ...(context ? { context } : {}),
      capabilityVersions,
      turns,
    };
  }

  async function resumeTrail(trailId: string): Promise<TrailState> {
    for (let attempt = 0; attempt < RESUME_ATTEMPTS; attempt += 1) {
      const expectedSequence = ledger.readAll().length;
      const trail = getTrail(trailId);
      if (trail.runtime !== agent.name)
        throw new Error(
          `Session ${trailId} uses runtime ${trail.runtime}, but the active runtime is ${agent.name}. Relaunch with --runtime ${trail.runtime} to resume it.`,
        );
      if (trail.status === "running") {
        await ledger.refresh();
        if (ledger.readAll().length !== expectedSequence) continue;
        throw runningTrailResumeError(trailId);
      }
      try {
        await ledger.append(
          {
            type: "trail.resumed",
            principal: "foreground",
            trailId,
            payload: { previousStatus: trail.status },
          },
          expectedSequence,
        );
        return getTrail(trailId);
      } catch (error) {
        if (error instanceof LedgerConflictError) continue;
        throw error;
      }
    }
    throw new Error(
      `Session ${trailId} changed repeatedly while resume was being validated. Try again after concurrent activity settles.`,
    );
  }

  async function forkTrail(
    trailId: string,
    title = `${getTrail(trailId).title} (fork)`,
  ): Promise<TrailState> {
    const source = getTrail(trailId);
    const forkId = createId("trail");
    await ledger.append({
      type: "trail.forked",
      principal: "foreground",
      trailId: forkId,
      payload: {
        parentTrailId: trailId,
        title,
        provider: source.provider,
        model: source.model,
        runtime: agent.name,
        inheritedTurns: source.turns.length,
      },
    });
    for (const turn of source.turns) {
      await ledger.append({
        type: "turn.completed",
        principal: "system",
        trailId: forkId,
        payload: { ...turn, inherited: true },
      });
    }
    return getTrail(forkId);
  }

  async function runTurn(trailId: string, input: string, options: RunTurnOptions = {}): Promise<TurnResult> {
    const admitTurn = async () => {
      for (;;) {
        const expectedSequence = ledger.readAll().length;
        const trail = getTrail(trailId);
        if (trail.runtime !== agent.name)
          throw new Error(
            `Trail ${trailId} is pinned to runtime ${trail.runtime}; active runtime is ${agent.name}. Start or fork a trail for the active runtime.`,
          );
        if (trail.status === "running") throw new Error("Trail is already running");
        const active = capabilities.listActive();
        const latestCompaction = ledger
          .eventsForTrail(trailId)
          .filter((event) => event.type === "trail.compacted")
          .at(-1);
        const summarizedTurns = Number(latestCompaction?.payload["summarizedTurns"] ?? 0);
        const fragments: ContextFragment[] = [
          {
            id: "system",
            kind: "system",
            content: "You are Noesis. Preserve evidence and distinguish proposals from promoted behavior.",
            provenance: ["protected:noesis"],
            priority: 100,
          },
          ...(typeof latestCompaction?.payload["summary"] === "string" && latestCompaction.payload["summary"]
            ? [
                {
                  id: latestCompaction.eventId,
                  kind: "trail" as const,
                  content: `Compacted trail summary:\n${latestCompaction.payload["summary"]}`,
                  provenance: [latestCompaction.eventId],
                  priority: 75,
                },
              ]
            : []),
          ...trail.turns
            .slice(summarizedTurns)
            .slice(-8)
            .map((turn, index) => ({
              id: `turn-${index}`,
              kind: "trail" as const,
              content: `User: ${turn.input}\nAssistant: ${turn.output}`,
              provenance: [trailId],
              priority: 70,
            })),
          ...memory.listActive().map((record) => ({
            id: record.memoryId,
            kind:
              record.kind === "fact" || record.kind === "model"
                ? ("knowledge" as const)
                : ("memory" as const),
            content: record.content,
            provenance: record.evidence.map((item) => item.eventId),
            priority: 60,
          })),
          ...active.map((capability) => ({
            id: `${capability.capabilityId}@${capability.version}`,
            kind: "capability" as const,
            content: capability.instructions,
            provenance: capability.evidenceEventIds,
            priority: 80,
          })),
          {
            id: createId("input"),
            kind: "user",
            content: input,
            provenance: ["foreground"],
            priority: 90,
          },
        ];
        const versions = capabilities.activeVersions();
        const context = compileContext(fragments, versions, {
          maxTokens: 8_000,
          maxFragmentTokens: 2_000,
        });
        const thinkingLevel = options.thinkingLevel ?? agentDefaults.thinkingLevel;
        try {
          await ledger.append(
            {
              type: "turn.started",
              principal: "foreground",
              trailId,
              payload: {
                input,
                contextSnapshotId: context.snapshotId,
                context: toJsonValue(context),
                capabilityVersions: versions,
                thinkingLevel,
              },
            },
            expectedSequence,
          );
          return { trail, active, versions, context, thinkingLevel };
        } catch (error) {
          if (error instanceof LedgerConflictError) continue;
          throw error;
        }
      }
    };

    const { trail, active, versions, context, thinkingLevel } = await admitTurn();
    try {
      const result = await agent.run(
        {
          trailId,
          provider: trail.provider,
          model: trail.model,
          thinkingLevel,
          systemPrompt: renderContext(context),
          prompt: input,
          activeCapabilities: active.map((item) => ({
            name: item.name,
            version: item.version,
          })),
        },
        options.onEvent ?? (() => undefined),
      );
      if (result.stopReason === "error") throw new Error(result.error);
      if (result.stopReason === "aborted") {
        await ledger.append({
          type: "trail.aborted",
          principal: "foreground",
          trailId,
          payload: { partialOutput: result.text },
        });
        return {
          outcome: "aborted",
          output: result.text,
          context,
          usedCapabilities: versions,
          ...(result.contextUsage ? { contextUsage: result.contextUsage } : {}),
        };
      }
      const completed = await ledger.append({
        type: "turn.completed",
        principal: "foreground",
        trailId,
        payload: {
          input,
          output: result.text,
          provider: result.provider,
          model: result.model,
          contextSnapshotId: context.snapshotId,
          capabilityVersions: versions,
        },
      });
      for (const capability of active)
        await capabilities.recordUse(capability.capabilityId, capability.version, trailId, completed.eventId);
      return {
        outcome: "completed",
        output: result.text,
        context,
        usedCapabilities: versions,
        ...(result.contextUsage ? { contextUsage: result.contextUsage } : {}),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await ledger.append({
        type: "turn.failed",
        principal: "foreground",
        trailId,
        payload: { input, reason },
      });
      throw error;
    }
  }

  async function steer(trailId: string, text: string): Promise<void> {
    await agent.steer(trailId, text);
    await ledger.append({ type: "trail.steered", principal: "foreground", trailId, payload: { text } });
  }

  async function followUp(trailId: string, text: string): Promise<void> {
    await agent.followUp(trailId, text);
    await ledger.append({
      type: "trail.followed_up",
      principal: "foreground",
      trailId,
      payload: { text },
    });
  }

  async function abort(trailId: string): Promise<void> {
    await agent.abort(trailId);
    if (getTrail(trailId).status === "running")
      await ledger.append({
        type: "trail.aborted",
        principal: "foreground",
        trailId,
        payload: { requested: true },
      });
  }

  async function compact(trailId: string): Promise<void> {
    const trail = getTrail(trailId);
    if (trail.status === "running") throw new Error("Cannot compact a running trail");
    const compacted = trail.turns.slice(0, -2);
    await ledger.append({
      type: "trail.compacted",
      principal: "foreground",
      trailId,
      payload: {
        summarizedTurns: compacted.length,
        retainedTurns: Math.min(2, trail.turns.length),
        summary: compacted.map((turn) => `${turn.input} -> ${turn.output}`).join("\n"),
      },
    });
  }

  async function evaluateCandidate(capabilityId: string, version: number): Promise<EvaluationReport> {
    return await createEvaluationLab(ledger, capabilities).evaluate(capabilityId, version);
  }

  async function promoteCandidate(capabilityId: string, version: number): Promise<void> {
    const resource = `capability:${capabilityId}@${version}:promote`;
    const decision = await authority.promote(
      resource,
      `promote:${capabilityId}:${version}`,
      async (receipt) => {
        await capabilities.promote(capabilityId, version, receipt);
        return null;
      },
    );
    if (!decision.ok) throw new Error(decision.reason);
  }

  async function rollbackCapability(capabilityId: string, version: number, reason: string): Promise<void> {
    const resource = `capability:${capabilityId}@${version}:rollback`;
    const decision = await authority.rollback(
      resource,
      `rollback:${capabilityId}:${version}:${reason}`,
      async (receipt) => {
        await capabilities.rollback(capabilityId, version, reason, receipt);
        return null;
      },
    );
    if (!decision.ok) throw new Error(decision.reason);
  }

  async function commitScheduledJob(job: ScheduledJob): Promise<void> {
    const resource = `job:${job.jobId}:schedule`;
    const decision = await authority.schedule(resource, `schedule:${job.jobId}`, async (receipt) => {
      await authority.issueSchedulerGrant(
        job.jobId,
        job.budget,
        new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
        receipt,
      );
      await ledger.append({
        type: "job.scheduled",
        principal: "scheduler",
        payload: {
          jobId: job.jobId,
          prompt: job.prompt,
          schedule: job.schedule,
          budget: job.budget,
          budgetRemaining: job.budget,
          authorityResource: resource,
        },
      });
      return null;
    });
    if (!decision.ok) throw new Error(decision.reason);
  }

  async function runScheduledEffect(
    jobId: string,
    runNumber: number,
    leaseToken: string,
    prompt: string,
  ): Promise<string> {
    const jobEvents = ledger.readAll().filter((event) => event.payload["jobId"] === jobId);
    const latestLease = [...jobEvents].reverse().find((event) => event.type === "job.lease_acquired");
    const latestHeartbeat = [...jobEvents]
      .reverse()
      .find((event) => event.type === "job.heartbeat" && event.payload["leaseToken"] === leaseToken);
    const leaseUntil = String(
      latestHeartbeat?.payload["leaseUntil"] ?? latestLease?.payload["leaseUntil"] ?? "",
    );
    const terminal = jobEvents.some((event) =>
      ["job.completed", "job.failed", "job.budget_exhausted"].includes(event.type),
    );
    if (
      terminal ||
      latestLease?.payload["leaseToken"] !== leaseToken ||
      latestLease.payload["runNumber"] !== runNumber ||
      new Date(leaseUntil) <= new Date()
    )
      throw new Error("Scheduled execution requires the current active fenced lease");
    const decision = await authority.runScheduled(jobId, runNumber, async () => {
      const trail = await startTrail({ title: `Job ${jobId}` });
      return (await runTurn(trail.trailId, prompt)).output;
    });
    if (!decision.ok) throw new Error(decision.reason);
    return decision.value;
  }

  return Object.freeze({
    ledger,
    artifacts,
    memory,
    capabilities,
    agent,
    agentDefaults,
    startTrail,
    listTrails,
    listTrailSummaries,
    getTrail,
    resumeTrail,
    forkTrail,
    runTurn,
    steer,
    followUp,
    abort,
    compact,
    evaluateCandidate,
    promoteCandidate,
    rollbackCapability,
    commitScheduledJob,
    runScheduledEffect,
  });
}

export interface ScheduledJob {
  readonly jobId: string;
  readonly prompt: string;
  readonly schedule: string;
  readonly budget: number;
}

interface DurableJobState extends ScheduledJob {
  readonly status: "scheduled" | "running" | "completed" | "failed" | "budget_exhausted";
  readonly budgetRemaining: number;
  readonly runNumber: number;
  readonly leaseToken?: string;
  readonly leaseUntil?: string;
}

export interface DurableScheduler {
  readonly schedule: (input: Omit<ScheduledJob, "jobId">) => Promise<ScheduledJob>;
  readonly run: (jobOrId: ScheduledJob | string) => Promise<string>;
  readonly getJob: (jobId: string) => DurableJobState;
}

export function createDurableScheduler(runtime: NoesisRuntime): DurableScheduler {
  async function schedule(input: Omit<ScheduledJob, "jobId">): Promise<ScheduledJob> {
    if (!Number.isInteger(input.budget) || input.budget <= 0) throw new Error("Job budget must be positive");
    const job = { ...input, jobId: createId("job") };
    await runtime.commitScheduledJob(job);
    return job;
  }

  async function run(jobOrId: ScheduledJob | string): Promise<string> {
    const jobId = typeof jobOrId === "string" ? jobOrId : jobOrId.jobId;
    const recoveredOutput = await recoverDurableOutcome(jobId);
    if (recoveredOutput !== undefined) return recoveredOutput;
    const lease = await acquireLease(jobId);
    const heartbeat = setInterval(() => {
      void renewLease(jobId, lease.leaseToken).catch(() => undefined);
    }, 5_000);
    try {
      await renewLease(jobId, lease.leaseToken);
      let output: string;
      try {
        output = await runtime.runScheduledEffect(jobId, lease.runNumber, lease.leaseToken, lease.prompt);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await runtime.ledger.append({
          type: "job.failed",
          principal: "scheduler",
          payload: {
            jobId,
            leaseToken: lease.leaseToken,
            reason,
            budgetRemaining: lease.budgetRemaining,
          },
        });
        throw error;
      }
      const artifact = await runtime.artifacts.put(output, "text/plain");
      await runtime.ledger.append({
        type: "job.completed",
        principal: "scheduler",
        payload: {
          jobId,
          leaseToken: lease.leaseToken,
          artifactHash: artifact.hash,
          budgetRemaining: lease.budgetRemaining,
        },
      });
      return output;
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function recoverDurableOutcome(jobId: string): Promise<string | undefined> {
    const state = getJob(jobId);
    if (state.status !== "running") return undefined;
    const key = `job:${jobId}:run:${state.runNumber}`;
    const completed = runtime.ledger
      .findByType("effect.completed")
      .find((event) => event.payload["idempotencyKey"] === key);
    if (completed && typeof completed.payload["result"] === "string") {
      const output = completed.payload["result"];
      const artifact = await runtime.artifacts.put(output, "text/plain");
      await runtime.ledger.append({
        type: "job.completed",
        principal: "scheduler",
        payload: {
          jobId,
          leaseToken: state.leaseToken ?? "recovered",
          artifactHash: artifact.hash,
          budgetRemaining: state.budgetRemaining,
          recovered: true,
        },
      });
      return output;
    }
    const reserved = runtime.ledger
      .findByType("effect.reserved")
      .some((event) => event.payload["idempotencyKey"] === key);
    const failed = runtime.ledger
      .findByType("effect.failed")
      .find((event) => event.payload["idempotencyKey"] === key);
    if (reserved && !failed && (!state.leaseUntil || new Date(state.leaseUntil) <= new Date())) {
      const reason = "The prior scheduled effect is durably reserved with an ambiguous outcome";
      await runtime.ledger.append({
        type: "job.failed",
        principal: "scheduler",
        payload: { jobId, reason, budgetRemaining: state.budgetRemaining, ambiguous: true },
      });
      throw new Error(reason);
    }
    return undefined;
  }

  function getJob(jobId: string): DurableJobState {
    const events = runtime.ledger.readAll().filter((event) => event.payload["jobId"] === jobId);
    const scheduled = events.find((event) => event.type === "job.scheduled");
    if (!scheduled) throw new Error(`Job not found: ${jobId}`);
    let status: DurableJobState["status"] = "scheduled";
    let budgetRemaining = Number(scheduled.payload["budget"]);
    let runNumber = 0;
    let leaseToken: string | undefined;
    let leaseUntil: string | undefined;
    for (const event of events) {
      if (event.type === "job.lease_acquired") {
        status = "running";
        budgetRemaining = Number(event.payload["budgetRemaining"]);
        runNumber = Number(event.payload["runNumber"]);
        leaseToken = String(event.payload["leaseToken"]);
        leaseUntil = String(event.payload["leaseUntil"]);
      } else if (event.type === "job.heartbeat" && event.payload["leaseToken"] === leaseToken) {
        leaseUntil = String(event.payload["leaseUntil"]);
      } else if (event.type === "job.completed") status = "completed";
      else if (event.type === "job.failed") status = "failed";
      else if (event.type === "job.budget_exhausted") status = "budget_exhausted";
    }
    return {
      jobId,
      prompt: String(scheduled.payload["prompt"]),
      schedule: String(scheduled.payload["schedule"]),
      budget: Number(scheduled.payload["budget"]),
      budgetRemaining,
      runNumber,
      status,
      ...(leaseToken ? { leaseToken } : {}),
      ...(leaseUntil ? { leaseUntil } : {}),
    };
  }

  async function acquireLease(jobId: string): Promise<DurableJobState & { leaseToken: string }> {
    for (;;) {
      const state = getJob(jobId);
      if (["completed", "failed", "budget_exhausted"].includes(state.status))
        throw new Error(`Job is terminal: ${state.status}`);
      if (state.status === "running" && state.leaseUntil && new Date(state.leaseUntil) > new Date())
        throw new Error("Job already has an active lease");
      if (state.budgetRemaining <= 0) {
        await runtime.ledger.append({
          type: "job.budget_exhausted",
          principal: "scheduler",
          payload: { jobId, budgetRemaining: 0 },
        });
        throw new Error("Job budget exhausted");
      }
      const expected = runtime.ledger.readAll().length;
      const leaseToken = createId("lease");
      const leaseUntil = new Date(Date.now() + 30_000).toISOString();
      try {
        await runtime.ledger.append(
          {
            type: "job.lease_acquired",
            principal: "scheduler",
            payload: {
              jobId,
              leaseToken,
              leaseUntil,
              runNumber: state.runNumber + 1,
              budgetRemaining: state.budgetRemaining - 1,
            },
          },
          expected,
        );
        return {
          ...state,
          status: "running",
          leaseToken,
          leaseUntil,
          runNumber: state.runNumber + 1,
          budgetRemaining: state.budgetRemaining - 1,
        };
      } catch (error) {
        if (error instanceof Error && error.name === "LedgerConflictError") continue;
        throw error;
      }
    }
  }

  async function renewLease(jobId: string, leaseToken: string): Promise<void> {
    for (;;) {
      const state = getJob(jobId);
      if (state.status !== "running" || state.leaseToken !== leaseToken)
        throw new Error("Cannot renew a stale or inactive lease token");
      const expected = runtime.ledger.readAll().length;
      try {
        await runtime.ledger.append(
          {
            type: "job.heartbeat",
            principal: "scheduler",
            payload: {
              jobId,
              leaseToken,
              leaseUntil: new Date(Date.now() + 30_000).toISOString(),
              budgetRemaining: state.budgetRemaining,
            },
          },
          expected,
        );
        return;
      } catch (error) {
        if (error instanceof Error && error.name === "LedgerConflictError") continue;
        throw error;
      }
    }
  }

  return Object.freeze({ schedule, run, getJob });
}
