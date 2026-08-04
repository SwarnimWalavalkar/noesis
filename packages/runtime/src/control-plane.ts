import type {
  DurableJobListCursor,
  DurableJobRecord,
  DurableJobStatus,
  Experiment,
  WorkspaceStore,
} from "@noesis/domain";
import type { ActivationAttemptResult, AtomicActivationController } from "./atomic-activation.ts";
import type { CompletedNormalTurn, CoordinatorJobView } from "./coordinator-contracts.ts";
import type { RuntimeCoordinator } from "./coordinator.ts";
import type { ContinuousFeedbackController } from "./continuous-feedback.ts";

export interface RuntimeControlPlaneOptions {
  readonly workspace: Pick<WorkspaceStore, "jobs" | "research">;
  readonly coordinator: RuntimeCoordinator;
  readonly activation: AtomicActivationController;
  readonly feedback: ContinuousFeedbackController;
  readonly now?: () => Date;
  readonly timers?: RuntimeControlPlaneTimers;
  readonly autoStart?: boolean;
}

export interface RuntimeControlPlaneTimerHandle {
  readonly cancel: () => void;
  readonly unref?: () => void;
}

export interface RuntimeControlPlaneTimers {
  readonly setTimeout: (callback: () => void, delayMs: number) => RuntimeControlPlaneTimerHandle;
  readonly clearTimeout: (handle: RuntimeControlPlaneTimerHandle) => void;
}

export interface ActivationReconciliation {
  readonly experimentId: string;
  readonly result: ActivationAttemptResult;
}

export interface RuntimeControlPlane {
  readonly coordinator: RuntimeCoordinator;
  readonly activation: AtomicActivationController;
  readonly feedback: ContinuousFeedbackController;
  readonly observeCompletedTurn: (input: CompletedNormalTurn) => Promise<CoordinatorJobView>;
  readonly runAvailable: () => Promise<readonly ActivationReconciliation[]>;
  readonly idle: () => Promise<readonly ActivationReconciliation[]>;
  readonly reconcileActivations: () => Promise<readonly ActivationReconciliation[]>;
  readonly stop: () => Promise<void>;
}

function isPreflightExperiment(
  experiment: Experiment,
): experiment is Experiment & { readonly status: "preflight" } {
  return experiment.status === "preflight";
}

/**
 * Runtime-owned AC-08 -> AC-09 -> AC-10 composition.
 *
 * SQLite experiment state is the durable activation queue: a restart can rescan preflight
 * experiments, while the protected activation controller recovers or repeats the exact bound
 * operation idempotently. Generated roles receive none of these protected controller handles.
 */
export function createRuntimeControlPlane(options: RuntimeControlPlaneOptions): RuntimeControlPlane {
  let running: Promise<readonly ActivationReconciliation[]> | undefined;
  let wakeTimer: RuntimeControlPlaneTimerHandle | undefined;
  let stopped = false;
  const now = options.now ?? (() => new Date());
  const timers =
    options.timers ??
    Object.freeze({
      setTimeout: (callback: () => void, delayMs: number) => {
        const handle = setTimeout(callback, delayMs);
        return Object.freeze({
          cancel: () => clearTimeout(handle),
          unref: () => handle.unref(),
        });
      },
      clearTimeout: (handle: RuntimeControlPlaneTimerHandle) => handle.cancel(),
    });

  const clearWake = (): void => {
    if (wakeTimer) timers.clearTimeout(wakeTimer);
    wakeTimer = undefined;
  };

  const runtimeJobKinds = Object.freeze([
    "runtime.reflect_turn",
    "runtime.author_revision",
    "runtime.preflight",
    "runtime.outcome_judge",
  ]);
  const activeJobStatuses: readonly DurableJobStatus[] = Object.freeze(["scheduled", "running"]);

  const reduceActiveRuntimeJobs = async <Value>(
    initial: Value,
    reduce: (value: Value, job: DurableJobRecord) => Value,
  ): Promise<Value> => {
    let value = initial;
    let after: DurableJobListCursor | undefined;
    for (;;) {
      const page = await options.workspace.jobs.listPage({
        statuses: activeJobStatuses,
        kinds: runtimeJobKinds,
        limit: 1_000,
        ...(after ? { after } : {}),
      });
      for (const job of page.records) value = reduce(value, job);
      if (page.exhausted) return value;
      if (!page.nextCursor)
        throw new Error("Non-exhausted durable job page did not provide an authoritative cursor");
      after = page.nextCursor;
    }
  };

  const nextDurableWake = async (): Promise<number | undefined> =>
    await reduceActiveRuntimeJobs<number | undefined>(undefined, (earliest, job) => {
      const candidate =
        job.status === "scheduled"
          ? new Date(job.notBefore).getTime()
          : job.status === "running" && job.leaseUntil
            ? new Date(job.leaseUntil).getTime()
            : undefined;
      if (candidate === undefined) return earliest;
      return earliest === undefined || candidate < earliest ? candidate : earliest;
    });

  const armNextWake = async (): Promise<void> => {
    clearWake();
    if (stopped) return;
    const wakeAt = await nextDurableWake();
    if (wakeAt === undefined || stopped) return;
    const remaining = wakeAt - now().getTime();
    const delay = remaining <= 0 ? 25 : Math.min(2_147_483_647, remaining);
    wakeTimer = timers.setTimeout(() => {
      wakeTimer = undefined;
      void runAvailable();
    }, delay);
    wakeTimer.unref?.();
  };

  const reconcileActivations = async (): Promise<readonly ActivationReconciliation[]> => {
    if (stopped) return Object.freeze([]);
    const experiments = await options.workspace.research.experiments.listExperiments({
      status: "preflight",
      limit: 1_000,
    });
    if (stopped) return Object.freeze([]);
    const reconciled: ActivationReconciliation[] = [];
    for (const experiment of experiments.filter(isPreflightExperiment)) {
      if (stopped) break;
      const handoff = await options.coordinator.getPreflightActivationHandoff(experiment.experimentId);
      if (!handoff || stopped) continue;
      const result = await options.activation.activateFromPreflight(handoff);
      reconciled.push(Object.freeze({ experimentId: experiment.experimentId, result }));
    }
    return Object.freeze(reconciled);
  };

  function runAvailable(): Promise<readonly ActivationReconciliation[]> {
    if (stopped) return Promise.resolve(Object.freeze([]));
    if (running) return running;
    const next = (async () => {
      await options.coordinator.runAvailable();
      if (stopped) return Object.freeze([]);
      await options.feedback.runAvailable();
      if (stopped) return Object.freeze([]);
      return await reconcileActivations();
    })().finally(() => {
      if (running === next) running = undefined;
      if (!stopped) void armNextWake();
    });
    running = next;
    return next;
  }

  const idle = async (): Promise<readonly ActivationReconciliation[]> => {
    const reconciled: ActivationReconciliation[] = [];
    for (;;) {
      reconciled.push(...(await runAvailable()));
      const timestamp = now().getTime();
      const runnable = await reduceActiveRuntimeJobs(
        false,
        (found, job) =>
          found ||
          (job.status === "scheduled" && new Date(job.notBefore).getTime() <= timestamp) ||
          (job.status === "running" &&
            (job.leaseUntil === undefined || new Date(job.leaseUntil).getTime() <= timestamp)),
      );
      if (!runnable) return Object.freeze(reconciled);
    }
  };

  const observeCompletedTurn = async (input: CompletedNormalTurn): Promise<CoordinatorJobView> => {
    if (stopped) throw new Error("Runtime control plane is stopped");
    const job = await options.coordinator.observeCompletedTurn(input);
    clearWake();
    queueMicrotask(() => void runAvailable());
    return job;
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    clearWake();
    const coordinatorStop = options.coordinator.stop();
    const feedbackStop = options.feedback.stop();
    await Promise.all([coordinatorStop, feedbackStop, running]);
  };

  const controlPlane = Object.freeze({
    coordinator: options.coordinator,
    activation: options.activation,
    feedback: options.feedback,
    observeCompletedTurn,
    runAvailable,
    idle,
    reconcileActivations,
    stop,
  });
  if (options.autoStart !== false) {
    wakeTimer = timers.setTimeout(() => {
      wakeTimer = undefined;
      void runAvailable();
    }, 0);
    wakeTimer.unref?.();
  }
  return controlPlane;
}
