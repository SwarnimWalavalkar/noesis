import type { Experiment, WorkspaceStore } from "@noesis/domain";
import type { ActivationAttemptResult, AtomicActivationController } from "./atomic-activation.ts";
import type { CompletedNormalTurn, CoordinatorJobView } from "./coordinator-contracts.ts";
import type { RuntimeCoordinator } from "./coordinator.ts";
import type { ContinuousFeedbackController } from "./continuous-feedback.ts";

export interface RuntimeControlPlaneOptions {
  readonly workspace: Pick<WorkspaceStore, "research">;
  readonly coordinator: RuntimeCoordinator;
  readonly activation: AtomicActivationController;
  readonly feedback: ContinuousFeedbackController;
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
  let stopped = false;

  const reconcileActivations = async (): Promise<readonly ActivationReconciliation[]> => {
    const experiments = await options.workspace.research.experiments.listExperiments({
      status: "preflight",
      limit: 1_000,
    });
    const reconciled: ActivationReconciliation[] = [];
    for (const experiment of experiments.filter(isPreflightExperiment)) {
      const handoff = await options.coordinator.getPreflightActivationHandoff(experiment.experimentId);
      if (!handoff) continue;
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
      return await reconcileActivations();
    })().finally(() => {
      if (running === next) running = undefined;
    });
    running = next;
    return next;
  }

  const observeCompletedTurn = async (input: CompletedNormalTurn): Promise<CoordinatorJobView> => {
    if (stopped) throw new Error("Runtime control plane is stopped");
    const job = await options.coordinator.observeCompletedTurn(input);
    queueMicrotask(() => void runAvailable());
    return job;
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    await options.coordinator.stop();
    await running;
  };

  return Object.freeze({
    coordinator: options.coordinator,
    activation: options.activation,
    feedback: options.feedback,
    observeCompletedTurn,
    runAvailable,
    idle: runAvailable,
    reconcileActivations,
    stop,
  });
}
