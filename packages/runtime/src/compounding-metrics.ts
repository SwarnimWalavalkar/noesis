import {
  canonicalJson,
  JsonValueSchema,
  type CapabilityRevisionRef,
  type CompoundingReplayRecord,
  type CorrectionExposure,
} from "@noesis/domain";
import type { ForegroundReplayPersistencePort } from "@noesis/evals";
import type { NoesisWorkspaceStore } from "@noesis/workspace";
import { createWorkspaceRuntimeInternals } from "../../workspace/src/protected-runtime.ts";

export interface CompoundingMetricsWindow {
  readonly from: string;
  readonly to: string;
}

export interface CompoundingMetricsQuery {
  readonly window: CompoundingMetricsWindow;
  readonly scope?: string;
  readonly modelCohort?: string;
}

export interface ReplayCoverage {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number | null;
}

export interface CompoundingMetricResult {
  readonly metric: string;
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number | null;
  readonly unit: "ratio" | "tokens" | "bytes";
  readonly exclusions: Readonly<Record<string, number>>;
  readonly coverage: ReplayCoverage;
  readonly scope: string;
  readonly modelCohort: string;
  readonly window: CompoundingMetricsWindow;
}

export interface CorrectionRecurrenceMetric {
  readonly signature: string;
  readonly overall: CompoundingMetricResult;
  readonly preActivation: CompoundingMetricResult;
  readonly postActivation: CompoundingMetricResult;
  readonly servedRevisions: readonly CapabilityRevisionRef[];
}

export interface CompoundingMetricsReadModel {
  readonly consideredTurns: number;
  readonly pairedTurns: number;
  readonly coverage: ReplayCoverage;
  readonly exclusions: Readonly<Record<string, number>>;
  readonly servedRevisionWinRate: CompoundingMetricResult;
  readonly scopeLeakageRate: CompoundingMetricResult;
  readonly contextTax: {
    readonly injectedContextTokens: CompoundingMetricResult;
    readonly promptLayerBytes: CompoundingMetricResult;
    readonly marginalInputTokens: CompoundingMetricResult;
  };
  readonly correctionRecurrence: readonly CorrectionRecurrenceMetric[];
  readonly scope: string;
  readonly modelCohort: string;
  readonly window: CompoundingMetricsWindow;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function countBy(values: readonly string[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.freeze(Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right))));
}

function mergeCounts(
  ...sources: readonly Readonly<Record<string, number>>[]
): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const source of sources)
    for (const [key, value] of Object.entries(source)) counts.set(key, (counts.get(key) ?? 0) + value);
  return Object.freeze(Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right))));
}

function uniqueRevisions(values: readonly CapabilityRevisionRef[]): readonly CapabilityRevisionRef[] {
  return Object.freeze(
    [
      ...new Map(
        values.map((value) => [
          `${value.capabilityId}\u0000${value.capabilityRevisionId}\u0000${value.bundleDigest}`,
          value,
        ]),
      ).values(),
    ].sort(
      (left, right) =>
        left.capabilityId.localeCompare(right.capabilityId) ||
        left.capabilityRevisionId.localeCompare(right.capabilityRevisionId),
    ),
  );
}

export function computeCompoundingMetrics(
  records: readonly CompoundingReplayRecord[],
  query: CompoundingMetricsQuery,
): CompoundingMetricsReadModel {
  const selected = records.filter(
    (record) =>
      record.occurredAt >= query.window.from &&
      record.occurredAt <= query.window.to &&
      (query.scope === undefined || record.scope === query.scope) &&
      (query.modelCohort === undefined || record.modelCohort === query.modelCohort),
  );
  const paired = selected.filter((record) => record.status === "paired");
  const exclusions = countBy(
    selected.flatMap((record) => (record.status === "excluded" ? [record.exclusionReason] : [])),
  );
  const coverage = Object.freeze({
    numerator: paired.length,
    denominator: selected.length,
    value: ratio(paired.length, selected.length),
  });
  const scope = query.scope ?? "all";
  const modelCohort = query.modelCohort ?? "all";
  const metric = (
    name: string,
    numerator: number,
    denominator: number,
    unit: CompoundingMetricResult["unit"],
    metricExclusions: Readonly<Record<string, number>> = exclusions,
  ): CompoundingMetricResult =>
    Object.freeze({
      metric: name,
      numerator,
      denominator,
      value: ratio(numerator, denominator),
      unit,
      exclusions: metricExclusions,
      coverage,
      scope,
      modelCohort,
      window: query.window,
    });

  const decisivePairs = paired.filter(
    (record) => record.railsPassed && (record.winner === "served" || record.winner === "baseline"),
  );
  const servedWins = decisivePairs.filter((record) => record.winner === "served").length;
  const winExclusions = mergeCounts(
    exclusions,
    countBy(
      paired.flatMap((record) => {
        if (!record.railsPassed) return ["rail_failure"];
        if (record.winner === "tie") return ["tie"];
        if (record.winner === "inconclusive") return ["inconclusive"];
        return [];
      }),
    ),
  );

  const scopedServing = selected.filter((record) => record.servedRevisions.length > 0);
  const leaked = scopedServing.filter((record) => !record.scopeRelated).length;
  const injectedTokens = paired.reduce((sum, record) => sum + record.injectedContextTokens, 0);
  const promptBytes = paired.reduce((sum, record) => sum + record.servedPromptLayerBytes, 0);
  const marginalTokens = paired.reduce(
    (sum, record) => sum + (record.servedInputTokens - record.baselineInputTokens),
    0,
  );

  const exposuresBySignature = new Map<
    string,
    {
      readonly all: readonly CorrectionExposure[];
      readonly revisions: CapabilityRevisionRef[];
    }
  >();
  for (const record of selected) {
    for (const exposure of record.correctionExposures) {
      const existing = exposuresBySignature.get(exposure.signature) ?? {
        all: [],
        revisions: [],
      };
      exposuresBySignature.set(exposure.signature, {
        all: Object.freeze([...existing.all, exposure]),
        revisions: [...existing.revisions, ...exposure.servedRevisions],
      });
    }
  }
  const correctionRecurrence = Object.freeze(
    [...exposuresBySignature.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([signature, grouped]) => {
        const relevant = grouped.all.filter((exposure) => exposure.related);
        const pre = relevant.filter((exposure) => exposure.phase === "pre_activation");
        const post = relevant.filter((exposure) => exposure.phase === "post_activation");
        return Object.freeze({
          signature,
          overall: metric(
            `correction_recurrence:${signature}`,
            relevant.filter((exposure) => exposure.correctionOccurred).length,
            relevant.length,
            "ratio",
          ),
          preActivation: metric(
            `correction_recurrence_pre_activation:${signature}`,
            pre.filter((exposure) => exposure.correctionOccurred).length,
            pre.length,
            "ratio",
          ),
          postActivation: metric(
            `correction_recurrence_post_activation:${signature}`,
            post.filter((exposure) => exposure.correctionOccurred).length,
            post.length,
            "ratio",
          ),
          servedRevisions: uniqueRevisions(grouped.revisions),
        });
      }),
  );

  return Object.freeze({
    consideredTurns: selected.length,
    pairedTurns: paired.length,
    coverage,
    exclusions,
    servedRevisionWinRate: metric(
      "served_revision_win_rate",
      servedWins,
      decisivePairs.length,
      "ratio",
      winExclusions,
    ),
    scopeLeakageRate: metric("scope_leakage_rate", leaked, scopedServing.length, "ratio"),
    contextTax: Object.freeze({
      injectedContextTokens: metric(
        "injected_context_tokens_per_paired_turn",
        injectedTokens,
        paired.length,
        "tokens",
      ),
      promptLayerBytes: metric(
        "served_prompt_layer_bytes_per_paired_turn",
        promptBytes,
        paired.length,
        "bytes",
      ),
      marginalInputTokens: metric(
        "marginal_served_minus_baseline_input_tokens",
        marginalTokens,
        paired.length,
        "tokens",
      ),
    }),
    correctionRecurrence,
    scope,
    modelCohort,
    window: query.window,
  });
}

// BOUNDARY: Evidence records cross into byte storage through canonical JSON serialization.
function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value), "utf8");
}

export function createWorkspaceForegroundReplayPersistence(
  store: NoesisWorkspaceStore,
): ForegroundReplayPersistencePort {
  const measurements = createWorkspaceRuntimeInternals(store).protectedRuntime.measurements;
  const persistence: ForegroundReplayPersistencePort = {
    putBudget: async (request) => {
      await measurements.putBudget(request);
    },
    beginReplay: measurements.beginReplay,
    reserveRole: measurements.reserveRole,
    completeRole: measurements.completeRole,
    failRole: measurements.failRole,
    appendOutputEvidence: async (request) =>
      await store.evidence.appendEvidence({
        workingPath: `compounding-replays/${request.replayId}/${request.role}.json`,
        bytes: jsonBytes(request.value),
        evidenceKind: "output",
        actor: { actorId: "compounding-replay", kind: "system" },
        reason: "Effect-free foreground replay output",
        sensitivity: "private",
        provenanceRefs: request.provenanceRefs,
      }),
    appendJudgmentEvidence: async (request) =>
      await store.evidence.appendEvidence({
        workingPath: `compounding-replays/${request.replayId}/judgment.json`,
        bytes: jsonBytes(request.value),
        evidenceKind: "judgment",
        actor: { actorId: "compounding-replay", kind: "system" },
        reason: "Blind foreground replay judgment",
        sensitivity: "private",
        provenanceRefs: request.provenanceRefs,
      }),
    readEvidence: async (ref) =>
      JsonValueSchema.parse(JSON.parse(Buffer.from(await store.reads.readEvidence(ref)).toString("utf8"))),
    record: measurements.record,
  };
  return Object.freeze(persistence);
}

export function createCompoundingMetricsReader(store: NoesisWorkspaceStore): {
  readonly read: (query: CompoundingMetricsQuery) => Promise<CompoundingMetricsReadModel>;
} {
  const measurements = createWorkspaceRuntimeInternals(store).protectedRuntime.measurements;
  return Object.freeze({
    read: async (query) => computeCompoundingMetrics(await measurements.list(), query),
  });
}
