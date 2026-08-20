import { capabilityEffectKinds, capabilityEffects } from "@noesis/capabilities";
import type { UserCriterionRepository } from "@noesis/config";
import {
  type CapabilityDefinition,
  type CapabilityLifecycleRevision,
  type CapabilityRevision,
  type CapabilityRevisionRef,
  type CapabilityScope,
  canonicalJson,
  type DurableJobRecord,
  type EvidenceRef,
  EvidenceRefSchema,
  type Experiment,
  type FileRevisionRef,
  type ProjectRef,
  sha256,
  toJsonValue,
  type WorkingAdjustment,
} from "@noesis/domain";
import { CAPABILITY_REFLECTION_JOB_KIND, type ContinuousFeedbackController } from "@noesis/runtime";
import type {
  TuiCapabilityFacet,
  TuiLearningAuditSnapshot,
  TuiLearningDetailSection,
  TuiLearningEvidencePreview,
  TuiLearningPrimitive,
  TuiLearningPrimitiveGroup,
  TuiLearningPrimitiveKind,
  TuiLearningRelation,
} from "@noesis/tui";
import type { NoesisWorkspaceStore } from "@noesis/workspace";
import type { ProtectedWorkspaceRuntime } from "../../../packages/workspace/src/protected-runtime.ts";

const AUDIT_LIMIT = 1_000;
const RAW_JSON_LIMIT = 64_000;
const EVIDENCE_PREVIEW_LIMIT = 8;
const CONSIDERED_PREVIEW_LIMIT = 8;
const EVIDENCE_EXCERPT_LIMIT = 480;
const MATERIAL_PREVIEW_LIMIT = 2_400;
const LEGACY_REFLECTION_JOB_KIND = "runtime.reflect_turn";

function isReflectionJob(job: DurableJobRecord): boolean {
  return job.kind === CAPABILITY_REFLECTION_JOB_KIND || job.kind === LEGACY_REFLECTION_JOB_KIND;
}

interface LearningAuditSource {
  readonly workspace: NoesisWorkspaceStore;
  readonly criteria: Pick<UserCriterionRepository, "list">;
  readonly activations: Pick<
    ProtectedWorkspaceRuntime["activations"],
    "current" | "listOperations" | "getApproval"
  >;
  readonly feedback: Pick<
    ProtectedWorkspaceRuntime["feedback"],
    "listObservations" | "listResearchRuns" | "getOutcome" | "getSuccessorInput"
  >;
  readonly continuousFeedback?: Pick<ContinuousFeedbackController, "experimentComparison">;
  readonly resolveRevision: (reference: CapabilityRevisionRef) => Promise<CapabilityRevision | undefined>;
  readonly resolveCapability: (capabilityId: string) =>
    | Readonly<{
        readonly capabilityId: string;
        readonly name: string;
        readonly scope: string;
        readonly intent: string;
      }>
    | undefined;
  readonly project: ProjectRef;
  readonly now?: () => Date;
}

interface PrimitiveInput
  extends Omit<
    TuiLearningPrimitive,
    | "evidence"
    | "evidencePreviews"
    | "consideredEvidenceCount"
    | "consideredEvidencePreviews"
    | "relations"
    | "detailSections"
    | "rawJson"
    | "tone"
  > {
  readonly evidence?: readonly EvidenceRef[];
  readonly evidencePreviews?: readonly TuiLearningEvidencePreview[];
  readonly consideredEvidenceCount?: number;
  readonly consideredEvidencePreviews?: readonly TuiLearningEvidencePreview[];
  readonly relations?: readonly TuiLearningRelation[];
  readonly detailSections?: readonly TuiLearningDetailSection[];
  readonly raw: unknown;
  readonly sensitivity?: "normal" | "private" | "secret";
  readonly tone?: TuiLearningPrimitive["tone"];
}

function nativeId(kind: TuiLearningPrimitiveKind, id: string): string {
  return `${kind}:${id}`;
}

function relation(label: string, kind: TuiLearningPrimitiveKind, id: string | undefined) {
  return id ? Object.freeze({ label, targetId: nativeId(kind, id) }) : undefined;
}

function defined<Value>(value: Value | undefined): value is Value {
  return value !== undefined;
}

function evidenceIdentity(reference: EvidenceRef): string {
  if (reference.kind === "database_row") return `${reference.table}:${reference.rowId}`;
  if (reference.kind === "artifact_file") return `artifact:${reference.artifactId}`;
  return `${reference.kind}:${reference.revisionId}`;
}

function boundedRawJson(value: unknown, sensitivity: "normal" | "private" | "secret" = "normal"): string {
  if (sensitivity !== "normal")
    return canonicalJson({
      redacted: true,
      sensitivity,
      reason: "This runtime has no admitted TUI grant for sensitive learning payloads.",
    });
  const encoded = canonicalJson(toJsonValue(value));
  if (encoded.length <= RAW_JSON_LIMIT) return encoded;
  return canonicalJson({
    truncated: true,
    characterCount: encoded.length,
    digest: sha256(encoded),
    preview: encoded.slice(0, RAW_JSON_LIMIT - 1),
  });
}

function boundedExcerpt(value: string): string {
  const normalized = value.replaceAll("\t", " ").replaceAll(/\s+/g, " ").trim();
  return normalized.length <= EVIDENCE_EXCERPT_LIMIT
    ? normalized
    : `${normalized.slice(0, EVIDENCE_EXCERPT_LIMIT - 1)}…`;
}

function unknownExcerpt(value: unknown): string {
  if (typeof value === "string") return boundedExcerpt(value);
  if (value === undefined) return "No content was recorded.";
  try {
    return boundedExcerpt(canonicalJson(toJsonValue(value)));
  } catch {
    return "The recorded content is not available as bounded JSON.";
  }
}

function redactedEvidence(identity: string, label: string): TuiLearningEvidencePreview {
  return Object.freeze({
    identity,
    label,
    excerpt: "Sensitive evidence is hidden because this TUI has no admitted grant for it.",
    redacted: true,
  });
}

function createEvidencePreviewResolver(workspace: NoesisWorkspaceStore) {
  const cache = new Map<string, Promise<TuiLearningEvidencePreview>>();

  const resolve = async (reference: EvidenceRef): Promise<TuiLearningEvidencePreview> => {
    const identity = evidenceIdentity(reference);
    if (reference.kind === "artifact_file")
      return Object.freeze({
        identity,
        label: `ARTIFACT · ${reference.mediaType}`,
        excerpt: "Artifact content remains available through its authoritative artifact record.",
        redacted: true,
      });
    if (reference.kind === "file_revision" || reference.kind === "evidence_revision") {
      const label =
        reference.kind === "evidence_revision"
          ? `EVIDENCE · ${reference.evidenceKind.replaceAll("_", " ")}`
          : `REVISION · ${reference.workingPath}`;
      return Object.freeze({
        identity,
        label,
        excerpt: "Revision content is hidden because its transitive sensitivity is not admitted by this TUI.",
        redacted: true,
      });
    }
    if (reference.table === "messages") {
      const message = await workspace.operational.messages.get(reference.rowId);
      if (!message)
        return Object.freeze({
          identity,
          label: "MESSAGE",
          excerpt: "The referenced message is unavailable.",
          redacted: true,
        });
      if (message.sensitivity !== "normal") return redactedEvidence(identity, message.role.toUpperCase());
      return Object.freeze({
        identity,
        label: message.role.toUpperCase(),
        excerpt: boundedExcerpt(message.content),
        occurredAt: message.createdAt,
        redacted: false,
      });
    }
    if (reference.table === "tool_calls") {
      const call = await workspace.operational.toolCalls.get(reference.rowId);
      if (!call)
        return Object.freeze({
          identity,
          label: "TOOL",
          excerpt: "The referenced tool call is unavailable.",
          redacted: true,
        });
      if (call.sensitivity !== "normal") return redactedEvidence(identity, `TOOL · ${call.toolName}`);
      return Object.freeze({
        identity,
        label: `TOOL · ${call.toolName} · ${call.status}`,
        excerpt: unknownExcerpt(call.response ?? call.update ?? call.request),
        occurredAt: call.completedAt ?? call.createdAt,
        redacted: false,
      });
    }
    if (reference.table === "outcomes") {
      const outcome = await workspace.operational.outcomes.get(reference.rowId);
      if (!outcome)
        return Object.freeze({
          identity,
          label: "OUTCOME",
          excerpt: "The referenced outcome is unavailable.",
          redacted: true,
        });
      if (outcome.sensitivity !== "normal") return redactedEvidence(identity, `OUTCOME · ${outcome.status}`);
      return Object.freeze({
        identity,
        label: `OUTCOME · ${outcome.status}`,
        excerpt: boundedExcerpt(outcome.summary),
        occurredAt: outcome.createdAt,
        redacted: false,
      });
    }
    if (reference.table === "sessions") {
      const session = await workspace.operational.sessions.get(reference.rowId);
      const sensitivity = await workspace.operational.sessions.sensitivity(reference.rowId);
      if (!session || sensitivity !== "normal") return redactedEvidence(identity, "SESSION");
      return Object.freeze({
        identity,
        label: "SESSION",
        excerpt: boundedExcerpt(session.title),
        occurredAt: session.updatedAt,
        redacted: false,
      });
    }
    if (reference.table === "feedback_signals") {
      const signal = await workspace.research.feedbackSignals.getFeedbackSignal(reference.rowId);
      if (!signal || signal.sensitivity !== "normal") return redactedEvidence(identity, "FEEDBACK");
      return Object.freeze({
        identity,
        label: `FEEDBACK · ${signal.kind.replaceAll("_", " ")}`,
        excerpt: `${signal.scope} scope · strength ${String(signal.strength)} · novelty ${String(signal.novelty)}`,
        redacted: false,
      });
    }
    if (reference.table === "experiments") {
      return Object.freeze({
        identity,
        label: "EXPERIMENT",
        excerpt: "Open the related experiment primitive to inspect its authorized projection.",
        redacted: true,
      });
    }
    return Object.freeze({
      identity,
      label: reference.table.replaceAll("_", " ").toUpperCase(),
      excerpt: "The exact authoritative reference is available in the raw audit view.",
      redacted: true,
    });
  };

  return async (
    references: readonly EvidenceRef[],
    limit: number = EVIDENCE_PREVIEW_LIMIT,
  ): Promise<readonly TuiLearningEvidencePreview[]> =>
    await Promise.all(
      references.slice(0, limit).map((reference) => {
        const identity = evidenceIdentity(reference);
        const existing = cache.get(identity);
        if (existing) return existing;
        const pending = resolve(reference);
        cache.set(identity, pending);
        return pending;
      }),
    );
}

function primitive(input: PrimitiveInput): TuiLearningPrimitive {
  const { raw, sensitivity, ...record } = input;
  return Object.freeze({
    ...record,
    tone: input.tone ?? "neutral",
    evidence: Object.freeze((input.evidence ?? []).map(evidenceIdentity)),
    evidencePreviews: Object.freeze(input.evidencePreviews ?? []),
    consideredEvidenceCount: input.consideredEvidenceCount ?? 0,
    consideredEvidencePreviews: Object.freeze(input.consideredEvidencePreviews ?? []),
    relations: Object.freeze((input.relations ?? []).filter(defined)),
    detailSections: Object.freeze(input.detailSections ?? []),
    rawJson: boundedRawJson(raw, sensitivity),
  });
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const field = Reflect.get(value, key);
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function objectField(value: unknown, key: string): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const field = Reflect.get(value, key);
  return typeof field === "object" && field !== null && !Array.isArray(field)
    ? Object.freeze({ ...field })
    : undefined;
}

function evidenceRefsField(value: unknown, key: string): readonly EvidenceRef[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return Object.freeze([]);
  const parsed = EvidenceRefSchema.array().safeParse(Reflect.get(value, key));
  return parsed.success
    ? Object.freeze(parsed.data.map((reference) => Object.freeze({ ...reference })))
    : Object.freeze([]);
}

function detailEntry(label: string, value: string | undefined) {
  return value ? Object.freeze({ label, value }) : undefined;
}

function detailSection(
  title: string,
  entries: readonly (ReturnType<typeof detailEntry> | undefined)[],
): TuiLearningDetailSection | undefined {
  const present = entries.filter(defined);
  return present.length > 0 ? Object.freeze({ title, entries: Object.freeze(present) }) : undefined;
}

function capabilityScopeLabel(scope: CapabilityScope): string {
  if (scope.kind === "global") return "Global";
  if (scope.kind === "project") return `Project · ${scope.project.root}`;
  return `Session · ${scope.sessionId}`;
}

function capabilitySelectionLabel(mode: "relevant" | "always"): string {
  return mode === "always" ? "Always active" : "Selected when semantically relevant";
}

function legacyMaterialCounts(revision: CapabilityRevision): string {
  return [
    `${String(revision.promptModules.length)} prompt${revision.promptModules.length === 1 ? "" : "s"}`,
    `${String(revision.skills.length)} skill${revision.skills.length === 1 ? "" : "s"}`,
    `${String(revision.tools.length)} tool${revision.tools.length === 1 ? "" : "s"}`,
    "1 router",
  ].join(" · ");
}

function capabilityFacets(revision: CapabilityRevision | undefined): readonly TuiCapabilityFacet[] {
  return revision ? capabilityEffectKinds(revision) : Object.freeze([]);
}

function facetCountLabel(revision: CapabilityRevision): string {
  const effects = capabilityEffects(revision);
  if (effects.length === 0) return `Legacy bundle · ${legacyMaterialCounts(revision)}`;
  const counts = new Map<TuiCapabilityFacet, number>();
  for (const effect of effects) counts.set(effect.kind, (counts.get(effect.kind) ?? 0) + 1);
  return [...counts.entries()]
    .map(([kind, count]) => `${String(count)} ${kind}${count === 1 ? "" : "s"}`)
    .join(" · ");
}

function boundedMaterial(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= MATERIAL_PREVIEW_LIMIT
    ? trimmed
    : `${trimmed.slice(0, MATERIAL_PREVIEW_LIMIT - 1)}…`;
}

async function materialEntry(
  workspace: NoesisWorkspaceStore,
  label: string,
  reference: FileRevisionRef,
): Promise<ReturnType<typeof detailEntry>> {
  try {
    const content = boundedMaterial(new TextDecoder().decode(await workspace.reads.readRevision(reference)));
    return detailEntry(label, `${reference.workingPath}\n${content || "(empty material)"}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return detailEntry(label, `${reference.workingPath}\nUnavailable: ${boundedExcerpt(reason)}`);
  }
}

async function capabilityMaterialEntries(
  workspace: NoesisWorkspaceStore,
  definition: CapabilityDefinition | undefined,
  lifecycle: CapabilityLifecycleRevision | undefined,
): Promise<readonly (ReturnType<typeof detailEntry> | undefined)[]> {
  if (!lifecycle)
    return Object.freeze([
      detailEntry(
        "effects",
        definition?.kind ? `Legacy ${definition.kind.replaceAll("_", " ")} capability` : undefined,
      ),
    ]);
  const revision = lifecycle.revision;
  const effects = capabilityEffects(revision);
  if (effects.length > 0) {
    const kindCounts = new Map<string, number>();
    const effectTotals = new Map<string, number>();
    for (const effect of effects) effectTotals.set(effect.kind, (effectTotals.get(effect.kind) ?? 0) + 1);
    const effectEntries = await Promise.all(
      effects.map(async (effect) => {
        const count = (kindCounts.get(effect.kind) ?? 0) + 1;
        kindCounts.set(effect.kind, count);
        const suffix = (effectTotals.get(effect.kind) ?? 0) > 1 ? ` ${String(count)}` : "";
        if (effect.kind === "instruction")
          return await materialEntry(workspace, `instruction${suffix}`, effect.material);
        if (effect.kind === "skill") {
          const entry = await materialEntry(workspace, `skill · ${effect.name}`, effect.material);
          return entry ? detailEntry(entry.label, `${effect.description}\n${entry.value}`) : entry;
        }
        return await materialEntry(workspace, `${effect.kind} · ${effect.name}`, effect.definitionRevision);
      }),
    );
    return Object.freeze([
      detailEntry("effects", capabilityEffectKinds(revision).join(" + ")),
      detailEntry("change", lifecycle.summary),
      ...effectEntries,
      detailEntry("materials", facetCountLabel(revision)),
    ]);
  }
  const materialEntries = await Promise.all([
    ...revision.promptModules.map(
      async (reference, index) =>
        await materialEntry(
          workspace,
          definition?.kind === "instruction" && index === 0 ? "instruction" : `prompt ${String(index + 1)}`,
          reference,
        ),
    ),
    ...revision.skills.map(
      async (reference, index) => await materialEntry(workspace, `skill ${String(index + 1)}`, reference),
    ),
    ...revision.tools.map(
      async (reference, index) => await materialEntry(workspace, `tool ${String(index + 1)}`, reference),
    ),
  ]);
  return Object.freeze([
    detailEntry(
      "effects",
      definition?.kind ? `Legacy ${definition.kind.replaceAll("_", " ")} bundle` : "Legacy capability bundle",
    ),
    detailEntry("change", lifecycle.summary),
    ...materialEntries,
    detailEntry("materials", legacyMaterialCounts(revision)),
  ]);
}

function reflectionStatusLabel(status: string): string {
  if (status === "no_change") return "No lasting change";
  if (status === "adjusted") return "Applied project strategy";
  if (status === "replaced") return "Updated project strategy";
  if (status === "unapplied") return "Removed project strategy";
  if (status === "experiment") return "Proposed an experiment";
  if (status === "deduped") return "Matched an existing experiment";
  if (status === "stale") return "Decision became stale before application";
  if (status === "failed" || status === "budget_exhausted" || status === "cancelled")
    return `Reflection ${status.replaceAll("_", " ")}`;
  return status.replaceAll("_", " ");
}

function reflectionReason(job: DurableJobRecord): string {
  const rationale = stringField(job.result, "rationale");
  if (rationale) return rationale;
  const reason = stringField(job.result, "reason");
  if (reason === "reflector_no_change")
    return "The reflector found no durable lesson with a credible future use.";
  if (reason === "disabled") return "Ambient learning was disabled for this turn.";
  if (reason === "sensitive") return "The turn was too sensitive for ambient learning.";
  return reason ?? job.lastError?.message ?? `The reflection is ${job.status.replaceAll("_", " ")}.`;
}

function reflectionDetails(
  job: DurableJobRecord,
  adjustments: ReadonlyMap<string, WorkingAdjustment>,
): readonly TuiLearningDetailSection[] {
  const status = stringField(job.result, "status") ?? job.status;
  if (jobSensitivity(job) !== "normal")
    return Object.freeze(
      [
        detailSection("Decision", [
          detailEntry("Outcome", reflectionStatusLabel(status)),
          detailEntry(
            "Why",
            "Sensitive reflection details are hidden because this TUI has no admitted grant for them.",
          ),
        ]),
      ].filter(defined),
    );
  const observation = objectField(job.result, "observation");
  const adjustmentId = stringField(job.result, "adjustmentId");
  const adjustment = adjustmentId ? adjustments.get(adjustmentId) : undefined;
  const replacedAdjustmentId = stringField(job.result, "replacedAdjustmentId");
  const replaced = replacedAdjustmentId ? adjustments.get(replacedAdjustmentId) : undefined;
  const transition =
    status === "adjusted" || status === "replaced"
      ? adjustment
        ? detailSection("What changed", [
            detailEntry("Before", replaced?.strategy ?? "No project strategy was active."),
            detailEntry("Now", adjustment.strategy),
            detailEntry("Success looks like", adjustment.successSignal),
            detailEntry("Scope", "This project"),
          ])
        : undefined
      : status === "unapplied"
        ? adjustment
          ? detailSection("What changed", [
              detailEntry("Before", adjustment.strategy),
              detailEntry("Now", "No project strategy is active."),
              detailEntry("Scope", "This project"),
            ])
          : undefined
        : status === "stale"
          ? detailSection("What changed", [
              detailEntry("Result", "No strategy changed because the decision was stale."),
            ])
          : undefined;
  return Object.freeze(
    [
      detailSection("Decision", [
        detailEntry("Outcome", reflectionStatusLabel(status)),
        detailEntry("Why", reflectionReason(job)),
      ]),
      transition,
      observation
        ? detailSection("Observation", [
            detailEntry("Classified as", stringField(observation, "kind")?.replaceAll("_", " ")),
            detailEntry("Reason", stringField(observation, "reason")),
          ])
        : undefined,
    ].filter(defined),
  );
}

async function listProjectReflectionJobs(
  workspace: NoesisWorkspaceStore,
  projectId: string,
): Promise<readonly DurableJobRecord[]> {
  const jobs = (
    await Promise.all(
      [CAPABILITY_REFLECTION_JOB_KIND, LEGACY_REFLECTION_JOB_KIND].map((kind) =>
        workspace.jobs.list({
          kind,
          payloadProjectId: projectId,
          order: "newest",
          limit: AUDIT_LIMIT,
        }),
      ),
    )
  ).flat();
  return Object.freeze(
    [...new Map(jobs.map((job) => [job.jobId, job] as const)).values()]
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.jobId.localeCompare(left.jobId),
      )
      .slice(0, AUDIT_LIMIT),
  );
}

async function listExperimentJobs(
  workspace: NoesisWorkspaceStore,
  experimentIds: readonly string[],
): Promise<readonly DurableJobRecord[]> {
  const chunks: string[][] = [];
  for (let index = 0; index < experimentIds.length; index += 250)
    chunks.push(experimentIds.slice(index, index + 250));
  const jobs = (
    await Promise.all(
      chunks.map((payloadExperimentIds) =>
        workspace.jobs.list({
          payloadExperimentIds,
          order: "newest",
          limit: AUDIT_LIMIT,
        }),
      ),
    )
  ).flat();
  return Object.freeze(
    [...new Map(jobs.map((job) => [job.jobId, job] as const)).values()]
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.jobId.localeCompare(left.jobId),
      )
      .slice(0, AUDIT_LIMIT),
  );
}

async function listSourceSessionJobs(
  workspace: NoesisWorkspaceStore,
  sessionIds: readonly string[],
): Promise<readonly DurableJobRecord[]> {
  const chunks: string[][] = [];
  for (let index = 0; index < sessionIds.length; index += 250)
    chunks.push(sessionIds.slice(index, index + 250));
  const jobs = (
    await Promise.all(
      chunks.map((payloadSourceSessionIds) =>
        workspace.jobs.list({
          payloadSourceSessionIds,
          order: "newest",
          limit: AUDIT_LIMIT,
        }),
      ),
    )
  ).flat();
  return Object.freeze([...new Map(jobs.map((job) => [job.jobId, job] as const)).values()]);
}

async function resolveProjectExperiments(
  workspace: NoesisWorkspaceStore,
  originJobs: readonly DurableJobRecord[],
  adjustments: Awaited<ReturnType<NoesisWorkspaceStore["workingAdjustments"]["list"]>>,
): Promise<readonly Experiment[]> {
  const adjustmentIds = adjustments.map((adjustment) => adjustment.adjustmentId);
  const adjustmentExperiments =
    adjustmentIds.length === 0
      ? []
      : await workspace.research.experiments.listExperiments({
          sourceAdjustmentIds: adjustmentIds,
          limit: AUDIT_LIMIT,
        });
  const knownById = new Map(
    adjustmentExperiments.map((experiment) => [experiment.experimentId, experiment] as const),
  );
  const queue = [
    ...new Set([
      ...originJobs.map(jobExperimentId).filter(defined),
      ...adjustmentExperiments.map((experiment) => experiment.experimentId),
    ]),
  ];
  const selected = new Map<string, Experiment>();
  for (let index = 0; index < queue.length && selected.size < AUDIT_LIMIT; index += 1) {
    const experimentId = queue[index];
    if (experimentId === undefined || selected.has(experimentId)) continue;
    const experiment =
      knownById.get(experimentId) ?? (await workspace.research.experiments.getExperiment(experimentId));
    if (experiment === undefined) continue;
    selected.set(experimentId, experiment);
    if (experiment.followUpExperimentId !== undefined) queue.push(experiment.followUpExperimentId);
  }
  return Object.freeze([...selected.values()]);
}

function jobExperimentId(job: DurableJobRecord): string | undefined {
  return stringField(job.payload, "experimentId") ?? stringField(job.result, "experimentId");
}

function jobProjectId(job: DurableJobRecord): string | undefined {
  const direct = stringField(job.result, "projectId");
  if (direct) return direct;
  if (!isReflectionJob(job) || typeof job.payload !== "object" || job.payload === null) return undefined;
  const turn = Reflect.get(job.payload, "turn");
  const project = typeof turn === "object" && turn !== null ? Reflect.get(turn, "project") : undefined;
  return stringField(project, "projectId");
}

function jobSessionId(job: DurableJobRecord): string | undefined {
  if (isReflectionJob(job) && typeof job.payload === "object" && job.payload !== null)
    return stringField(Reflect.get(job.payload, "turn"), "sessionId");
  return stringField(job.payload, "sourceSessionId");
}

function reflectionTurnId(job: DurableJobRecord): string | undefined {
  if (!isReflectionJob(job) || typeof job.payload !== "object" || job.payload === null) return undefined;
  return stringField(Reflect.get(job.payload, "turn"), "turnId");
}

function jobSensitivity(job: DurableJobRecord): "normal" | "private" | "secret" {
  if (!isReflectionJob(job) || typeof job.payload !== "object" || job.payload === null) return "normal";
  const turn = Reflect.get(job.payload, "turn");
  const value = stringField(turn, "sensitivity");
  return value === "private" || value === "secret" ? value : "normal";
}

function jobSummary(job: DurableJobRecord): string {
  if (isReflectionJob(job) && jobSensitivity(job) !== "normal")
    return "Sensitive reflection details are hidden because this TUI has no admitted grant for them.";
  if (job.status === "failed" || job.status === "budget_exhausted" || job.status === "cancelled")
    return job.lastError?.message ?? `Learning job ${job.status.replaceAll("_", " ")}`;
  if (job.status !== "completed") return `${job.kind} is ${job.status}`;
  if (isReflectionJob(job)) return reflectionReason(job);
  const resultStatus = stringField(job.result, "status");
  return (
    stringField(job.result, "rationale") ??
    stringField(job.result, "reason") ??
    (resultStatus
      ? `${job.kind} completed with ${resultStatus.replaceAll("_", " ")}`
      : `${job.kind} completed`)
  );
}

function reflectionTitle(job: DurableJobRecord, adjustment: WorkingAdjustment | undefined): string {
  const status = stringField(job.result, "status") ?? job.status;
  if (jobSensitivity(job) !== "normal") return reflectionStatusLabel(status);
  if ((status === "adjusted" || status === "replaced" || status === "unapplied") && adjustment?.strategy)
    return adjustment.strategy;
  const rationale = stringField(job.result, "rationale");
  if (rationale && status !== "no_change") return rationale;
  return reflectionStatusLabel(status);
}

function originSessionMaps(
  jobs: readonly DurableJobRecord[],
  adjustments: readonly WorkingAdjustment[],
  experiments: readonly Experiment[],
): Readonly<{
  readonly sessionByTurnId: ReadonlyMap<string, string>;
  readonly sessionByAdjustmentId: ReadonlyMap<string, string>;
  readonly sessionByExperimentId: ReadonlyMap<string, string>;
}> {
  const sessionByTurnId = new Map<string, string>();
  const sessionByExperimentId = new Map<string, string>();
  for (const job of jobs) {
    const sessionId = jobSessionId(job);
    if (!sessionId) continue;
    const turnId = reflectionTurnId(job);
    if (turnId) sessionByTurnId.set(turnId, sessionId);
    const experimentId = jobExperimentId(job);
    if (experimentId && !sessionByExperimentId.has(experimentId))
      sessionByExperimentId.set(experimentId, sessionId);
  }
  const sessionByAdjustmentId = new Map<string, string>();
  for (const adjustment of adjustments) {
    const sessionId = sessionByTurnId.get(adjustment.createdFromTurnId);
    if (sessionId) sessionByAdjustmentId.set(adjustment.adjustmentId, sessionId);
  }
  for (const experiment of experiments) {
    if (sessionByExperimentId.has(experiment.experimentId)) continue;
    const fromAdjustment =
      experiment.sourceAdjustmentId === undefined
        ? undefined
        : sessionByAdjustmentId.get(experiment.sourceAdjustmentId);
    if (fromAdjustment) sessionByExperimentId.set(experiment.experimentId, fromAdjustment);
  }
  return Object.freeze({
    sessionByTurnId,
    sessionByAdjustmentId,
    sessionByExperimentId,
  });
}

async function jobPrimitive(
  job: DurableJobRecord,
  adjustments: ReadonlyMap<string, WorkingAdjustment>,
  evidencePreviews: (
    references: readonly EvidenceRef[],
    limit?: number,
  ) => Promise<readonly TuiLearningEvidencePreview[]>,
): Promise<TuiLearningPrimitive> {
  const experimentId = jobExperimentId(job);
  const sessionId = jobSessionId(job);
  const projectId = jobProjectId(job);
  const isReflection = isReflectionJob(job);
  const kind: TuiLearningPrimitiveKind = isReflection ? "reflection" : "job";
  const group: TuiLearningPrimitiveGroup = isReflection ? "reflection" : "operations";
  const adjustmentId = isReflection ? stringField(job.result, "adjustmentId") : undefined;
  const adjustment = adjustmentId ? adjustments.get(adjustmentId) : undefined;
  const reflectionStatus = stringField(job.result, "status") ?? job.status;
  const sensitivity = jobSensitivity(job);
  const citedEvidence =
    isReflection && sensitivity !== "normal"
      ? []
      : isReflection
        ? reflectionStatus === "unapplied"
          ? evidenceRefsField(job.result, "evidenceRefs")
          : reflectionStatus === "adjusted" || reflectionStatus === "replaced"
            ? (adjustment?.evidenceRefs ?? [])
            : []
        : job.payloadRefs;
  const consideredEvidence = isReflection && sensitivity === "normal" ? job.payloadRefs : [];
  const previewConsideredEvidence = new Set([
    "adjusted",
    "replaced",
    "unapplied",
    "experiment",
    "deduped",
    "stale",
  ]).has(reflectionStatus);
  const title = isReflection
    ? reflectionTitle(job, adjustment)
    : job.kind.replace("runtime.", "").replaceAll("_", " ");
  const summary = jobSummary(job);
  return primitive({
    id: nativeId(kind, job.jobId),
    kind,
    group,
    status: stringField(job.result, "status") ?? job.status,
    tone:
      job.status === "failed" || job.status === "budget_exhausted" || job.status === "cancelled"
        ? "negative"
        : job.status === "running" || job.status === "scheduled"
          ? "pending"
          : stringField(job.result, "status") === "no_change"
            ? "neutral"
            : "positive",
    title,
    summary: title === summary ? reflectionStatusLabel(reflectionStatus) : summary,
    occurredAt: job.updatedAt,
    ...(sessionId ? { sessionId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(experimentId ? { experimentId } : {}),
    evidence: citedEvidence,
    evidencePreviews: await evidencePreviews(citedEvidence),
    consideredEvidenceCount: consideredEvidence.length,
    consideredEvidencePreviews: previewConsideredEvidence
      ? await evidencePreviews(consideredEvidence, CONSIDERED_PREVIEW_LIMIT)
      : [],
    detailSections: isReflection ? reflectionDetails(job, adjustments) : [],
    relations: [
      relation("experiment", "experiment", experimentId),
      relation("adjustment", "working_adjustment", stringField(job.result, "adjustmentId")),
      relation(
        "candidate",
        "capability_revision",
        stringField(
          typeof job.result === "object" && job.result !== null
            ? Reflect.get(job.result, "candidateRevision")
            : undefined,
          "capabilityRevisionId",
        ),
      ),
    ].filter(defined),
    raw: job,
    sensitivity,
  });
}

function latestJobTime(jobs: readonly DurableJobRecord[], experimentId: string): string | undefined {
  return jobs
    .filter((job) => jobExperimentId(job) === experimentId)
    .map((job) => job.updatedAt)
    .sort((left, right) => right.localeCompare(left))[0];
}

function sortPrimitives(primitives: readonly TuiLearningPrimitive[]): readonly TuiLearningPrimitive[] {
  return Object.freeze(
    [...primitives].sort(
      (left, right) =>
        (right.occurredAt ?? "").localeCompare(left.occurredAt ?? "") ||
        left.group.localeCompare(right.group) ||
        left.id.localeCompare(right.id),
    ),
  );
}

export async function loadLearningAuditSnapshot(
  source: LearningAuditSource,
  sessionId: string,
): Promise<TuiLearningAuditSnapshot> {
  const [
    reflectionJobs,
    adjustments,
    criteriaResult,
    activation,
    allActivationOperations,
    allFeedbackSignals,
  ] = await Promise.all([
    listProjectReflectionJobs(source.workspace, source.project.projectId),
    source.workspace.workingAdjustments.list({
      projectId: source.project.projectId,
      limit: AUDIT_LIMIT,
    }),
    source.criteria.list(),
    source.activations.current(),
    source.activations.listOperations(AUDIT_LIMIT),
    source.workspace.research.feedbackSignals.listFeedbackSignals({
      limit: AUDIT_LIMIT,
    }),
  ]);
  if (!criteriaResult.ok) throw new Error(criteriaResult.error.message);
  const projectSessionIds = [...new Set(reflectionJobs.map(jobSessionId).filter(defined))];
  const sourceSessionJobs = await listSourceSessionJobs(source.workspace, projectSessionIds);
  const originJobs = [...reflectionJobs, ...sourceSessionJobs];
  const experiments = await resolveProjectExperiments(source.workspace, originJobs, adjustments);
  const experimentIds = new Set(experiments.map((experiment) => experiment.experimentId));
  const experimentJobs = await listExperimentJobs(source.workspace, [...experimentIds]);
  const allJobs = Object.freeze(
    [...new Map([...originJobs, ...experimentJobs].map((job) => [job.jobId, job] as const)).values()].sort(
      (left, right) => right.createdAt.localeCompare(left.createdAt) || right.jobId.localeCompare(left.jobId),
    ),
  );
  const jobs = Object.freeze(allJobs.slice(0, AUDIT_LIMIT));
  const activationOperations = allActivationOperations.filter((operation) =>
    experimentIds.has(operation.binding.experimentId),
  );
  const referencedFeedbackSignalIds = new Set(
    experiments.flatMap((experiment) => experiment.feedbackSignalIds),
  );
  const listedFeedbackSignalsById = new Map(
    allFeedbackSignals.map((signal) => [signal.signalId, signal] as const),
  );
  const referencedFeedbackSignals = (
    await Promise.all(
      [...referencedFeedbackSignalIds]
        .filter((signalId) => !listedFeedbackSignalsById.has(signalId))
        .map((signalId) => source.workspace.research.feedbackSignals.getFeedbackSignal(signalId)),
    )
  ).filter(defined);
  const feedbackSignals = [
    ...new Map(
      [...allFeedbackSignals, ...referencedFeedbackSignals]
        .filter(
          (signal) =>
            (signal.experimentId !== undefined && experimentIds.has(signal.experimentId)) ||
            referencedFeedbackSignalIds.has(signal.signalId),
        )
        .map((signal) => [signal.signalId, signal] as const),
    ).values(),
  ];
  const activeAdjustment = await source.workspace.workingAdjustments.getActive(source.project.projectId);
  const reflectionByTurnId = new Map(
    jobs
      .map((job) => {
        const turnId = reflectionTurnId(job);
        return turnId ? ([turnId, job.jobId] as const) : undefined;
      })
      .filter(defined),
  );
  const reflectionByCapabilityId = new Map<string, DurableJobRecord>();
  for (const job of jobs) {
    const capabilityId = stringField(job.result, "capabilityId");
    if (capabilityId && !reflectionByCapabilityId.has(capabilityId))
      reflectionByCapabilityId.set(capabilityId, job);
  }
  const adjustmentsById = new Map(
    adjustments.map((adjustment) => [adjustment.adjustmentId, adjustment] as const),
  );
  const originSessions = originSessionMaps(allJobs, adjustments, experiments);
  const hypothesisByExperimentId = new Map(
    experiments.map((experiment) => [experiment.experimentId, experiment.hypothesis] as const),
  );
  const resolveEvidencePreviews = createEvidencePreviewResolver(source.workspace);
  const primitives: TuiLearningPrimitive[] = [
    ...(await Promise.all(
      jobs.map(async (job) => await jobPrimitive(job, adjustmentsById, resolveEvidencePreviews)),
    )),
  ];

  for (const criterion of criteriaResult.value) {
    const definition = criterion.definition;
    primitives.push(
      primitive({
        id: nativeId("criterion", definition.criterionId),
        kind: "criterion",
        group: "memory",
        status: `${definition.status}${definition.pinned ? " · pinned" : ""}`,
        tone: definition.status === "active" ? "active" : "neutral",
        title: definition.evaluatorInstruction,
        summary: definition.pinned
          ? "Pinned criterion"
          : definition.status === "active"
            ? "Active criterion"
            : "Inactive criterion",
        evidence: definition.evidenceRefs,
        relations: [],
        raw: criterion,
      }),
    );
  }

  for (const adjustment of adjustments) {
    const active = activeAdjustment?.adjustmentId === adjustment.adjustmentId;
    const sessionId = originSessions.sessionByAdjustmentId.get(adjustment.adjustmentId);
    primitives.push(
      primitive({
        id: nativeId("working_adjustment", adjustment.adjustmentId),
        kind: "working_adjustment",
        group: "history",
        status: active ? "active" : "inactive",
        tone: active ? "active" : "neutral",
        title: adjustment.strategy,
        summary: active ? "Active project strategy" : "Inactive project strategy",
        projectId: adjustment.scope.projectId,
        ...(sessionId ? { sessionId } : {}),
        evidence: adjustment.evidenceRefs,
        evidencePreviews: await resolveEvidencePreviews(adjustment.evidenceRefs),
        detailSections: [
          detailSection("Current behavior", [
            detailEntry("Strategy", adjustment.strategy),
            detailEntry("Success looks like", adjustment.successSignal),
            detailEntry("Scope", "This project"),
          ]),
          detailSection("Origin", [
            detailEntry("Observation", adjustment.observation),
            detailEntry("Created from turn", adjustment.createdFromTurnId),
          ]),
        ].filter(defined),
        relations: [
          relation("source reflection", "reflection", reflectionByTurnId.get(adjustment.createdFromTurnId)),
        ].filter(defined),
        raw: adjustment,
      }),
    );
  }

  const revisionRefs = new Map<string, CapabilityRevisionRef>();
  for (const experiment of experiments) {
    revisionRefs.set(experiment.baselineRevision.capabilityRevisionId, experiment.baselineRevision);
    for (const candidate of experiment.candidateRevisions)
      revisionRefs.set(candidate.capabilityRevisionId, candidate);
    if (experiment.activatedRevision)
      revisionRefs.set(experiment.activatedRevision.capabilityRevisionId, experiment.activatedRevision);
    const occurredAt = latestJobTime(jobs, experiment.experimentId);
    const experimentSession = originSessions.sessionByExperimentId.get(experiment.experimentId);
    primitives.push(
      primitive({
        id: nativeId("experiment", experiment.experimentId),
        kind: "experiment",
        group: "history",
        status: experiment.status === "completed" ? `completed · ${experiment.outcome}` : experiment.status,
        tone:
          experiment.status !== "completed"
            ? "pending"
            : experiment.outcome === "keep"
              ? "positive"
              : experiment.outcome === "revert"
                ? "negative"
                : "neutral",
        title: experiment.hypothesis,
        summary: `Scope: ${experiment.scope}`,
        ...(occurredAt ? { occurredAt } : {}),
        ...(experimentSession ? { sessionId: experimentSession } : {}),
        experimentId: experiment.experimentId,
        capabilityId: experiment.baselineRevision.capabilityId,
        evidence: experiment.evidenceRefs,
        relations: [
          relation("baseline", "capability_revision", experiment.baselineRevision.capabilityRevisionId),
          ...experiment.candidateRevisions.map((candidate) =>
            relation("candidate", "capability_revision", candidate.capabilityRevisionId),
          ),
          relation("adjustment", "working_adjustment", experiment.sourceAdjustmentId),
          relation("follow-up", "experiment", experiment.followUpExperimentId),
        ].filter(defined),
        raw: experiment,
      }),
    );

    const [trials, evaluations, comparison, researchRuns, outcome, successorInput] = await Promise.all([
      source.workspace.research.trials.listTrials(experiment.experimentId),
      source.workspace.research.evaluations.listEvaluations(experiment.experimentId),
      experiment.preflightRef && source.continuousFeedback
        ? source.continuousFeedback.experimentComparison(experiment.experimentId)
        : undefined,
      source.feedback.listResearchRuns(experiment.experimentId),
      source.feedback.getOutcome(experiment.experimentId),
      source.feedback.getSuccessorInput(experiment.experimentId),
    ]);
    const report = experiment.preflightRef
      ? await source.workspace.research.preflights.getPreflightReport(experiment.preflightRef.rowId)
      : undefined;
    const plan = report
      ? await source.workspace.research.preflights.getPreflightPlan(report.planId)
      : undefined;
    if (plan)
      primitives.push(
        primitive({
          id: nativeId("preflight_plan", plan.planId),
          kind: "preflight_plan",
          group: "evaluation",
          status: "recorded",
          title: "Preflight plan",
          summary: experiment.hypothesis,
          experimentId: experiment.experimentId,
          ...(experimentSession ? { sessionId: experimentSession } : {}),
          capabilityId: plan.candidateRevision.capabilityId,
          evidence: plan.caseRefs,
          relations: [
            relation("experiment", "experiment", experiment.experimentId),
            relation("candidate", "capability_revision", plan.candidateRevision.capabilityRevisionId),
          ].filter(defined),
          raw: plan,
        }),
      );
    for (const trial of trials)
      primitives.push(
        primitive({
          id: nativeId("trial", trial.trialId),
          kind: "trial",
          group: "evaluation",
          status: `${trial.status} · ${trial.arm}`,
          tone:
            trial.status === "completed" ? "positive" : trial.status === "failed" ? "negative" : "pending",
          title: `${trial.arm} trial`,
          summary: experiment.hypothesis,
          experimentId: experiment.experimentId,
          ...(experimentSession ? { sessionId: experimentSession } : {}),
          capabilityId: trial.capabilityRevision.capabilityId,
          evidence: [...trial.inputRefs, ...trial.outputEvidenceRefs, ...trial.traceEvidenceRefs],
          relations: [
            relation("experiment", "experiment", experiment.experimentId),
            relation("revision", "capability_revision", trial.capabilityRevision.capabilityRevisionId),
          ].filter(defined),
          raw: trial,
        }),
      );
    for (const evaluation of evaluations)
      primitives.push(
        primitive({
          id: nativeId("evaluation", evaluation.evaluationId),
          kind: "evaluation",
          group: "evaluation",
          status: evaluation.status,
          tone:
            evaluation.status === "completed"
              ? "positive"
              : evaluation.status === "failed"
                ? "negative"
                : "pending",
          title:
            evaluation.status === "completed"
              ? "Evaluation passed"
              : evaluation.status === "failed"
                ? "Evaluation failed"
                : `Evaluation ${evaluation.status.replaceAll("_", " ")}`,
          summary: experiment.hypothesis,
          experimentId: experiment.experimentId,
          ...(experimentSession ? { sessionId: experimentSession } : {}),
          capabilityId: evaluation.candidateRevision.capabilityId,
          evidence: evaluation.evidenceRefs,
          relations: [
            relation("experiment", "experiment", experiment.experimentId),
            relation("report", "preflight_report", evaluation.preflightId),
            ...evaluation.trialIds.map((trialId) => relation("trial", "trial", trialId)),
          ].filter(defined),
          raw: evaluation,
        }),
      );
    if (report)
      primitives.push(
        primitive({
          id: nativeId("preflight_report", report.preflightId),
          kind: "preflight_report",
          group: "evaluation",
          status: report.decision,
          tone: report.decision === "pass" ? "positive" : "negative",
          title:
            report.decision === "pass"
              ? "Preflight passed"
              : `Preflight ${report.decision.replaceAll("_", " ")}`,
          summary: experiment.hypothesis,
          experimentId: experiment.experimentId,
          ...(experimentSession ? { sessionId: experimentSession } : {}),
          capabilityId: report.candidateRevision.capabilityId,
          evidence: [...report.trialEvidence, ...report.judgmentEvidence, report.reportEvidence],
          relations: [
            relation("experiment", "experiment", experiment.experimentId),
            relation("plan", "preflight_plan", report.planId),
            ...report.trialRowRefs.map((trial) => relation("trial", "trial", trial.rowId)),
          ].filter(defined),
          raw: report,
        }),
      );
    for (const observation of comparison?.observations ?? []) {
      const observationSession = observation.sessionId ?? experimentSession;
      primitives.push(
        primitive({
          id: nativeId("observation", observation.observationId),
          kind: "observation",
          group: "feedback",
          status: observation.hardRegression
            ? "hard regression"
            : (observation.userDecision ?? observation.precedence),
          tone: observation.hardRegression
            ? "negative"
            : observation.userDecision === "keep"
              ? "positive"
              : observation.userDecision === "revert"
                ? "negative"
                : "neutral",
          title: observation.hardRegression
            ? "Hard regression"
            : observation.userDecision
              ? `Observation · ${observation.userDecision}`
              : "Live experiment observation",
          summary: experiment.hypothesis,
          occurredAt: observation.createdAt,
          ...(observationSession ? { sessionId: observationSession } : {}),
          experimentId: experiment.experimentId,
          capabilityId: observation.capabilityRevision.capabilityId,
          evidence: observation.evidenceRefs,
          relations: [
            relation("experiment", "experiment", experiment.experimentId),
            relation("signal", "feedback_signal", observation.signalId),
          ].filter(defined),
          raw: observation,
        }),
      );
    }
    for (const run of researchRuns)
      primitives.push(
        primitive({
          id: nativeId("outcome_research", run.runId),
          kind: "outcome_research",
          group: "feedback",
          status: run.proposal ? `${run.status} · ${run.proposal}` : run.status,
          tone: run.status === "completed" ? "positive" : run.status === "failed" ? "negative" : "pending",
          title: "Outcome research",
          summary: experiment.hypothesis,
          occurredAt: run.updatedAt,
          experimentId: experiment.experimentId,
          ...(experimentSession ? { sessionId: experimentSession } : {}),
          evidence: run.evidenceRefs,
          relations: [
            relation("experiment", "experiment", experiment.experimentId),
            ...run.citedObservationIds.map((id) => relation("observation", "observation", id)),
          ].filter(defined),
          raw: run,
        }),
      );
    if (outcome)
      primitives.push(
        primitive({
          id: nativeId("experiment_outcome", outcome.operationId),
          kind: "experiment_outcome",
          group: "feedback",
          status: outcome.decision,
          tone:
            outcome.decision === "keep" ? "positive" : outcome.decision === "revert" ? "negative" : "neutral",
          title: `Experiment ${outcome.decision}`,
          summary: experiment.hypothesis,
          occurredAt: outcome.committedAt,
          experimentId: experiment.experimentId,
          ...(experimentSession ? { sessionId: experimentSession } : {}),
          evidence: outcome.evidenceRefs,
          relations: [
            relation("experiment", "experiment", experiment.experimentId),
            relation("research", "outcome_research", outcome.researchRunId),
            relation("successor", "experiment", outcome.successorExperimentId),
          ].filter(defined),
          raw: outcome,
        }),
      );
    if (successorInput)
      primitives.push(
        primitive({
          id: nativeId("successor_lineage", successorInput.inputId),
          kind: "successor_lineage",
          group: "feedback",
          status: "recorded",
          title: "Successor experiment",
          summary: experiment.hypothesis,
          occurredAt: successorInput.createdAt,
          experimentId: experiment.experimentId,
          ...(experimentSession ? { sessionId: experimentSession } : {}),
          evidence: successorInput.evidenceRefs,
          relations: [
            relation("predecessor", "experiment", successorInput.predecessorExperimentId),
            relation("successor", "experiment", successorInput.successorExperimentId),
          ].filter(defined),
          raw: successorInput,
        }),
      );
  }

  for (const reference of revisionRefs.values()) {
    const [revision, capability] = await Promise.all([
      source.resolveRevision(reference),
      Promise.resolve(source.resolveCapability(reference.capabilityId)),
    ]);
    const currentRevision = activation?.activeCapabilityRevisions[reference.capabilityId];
    const activeRevision =
      currentRevision?.kind === "capability_revision" &&
      currentRevision.capabilityRevisionId === reference.capabilityRevisionId;
    primitives.push(
      primitive({
        id: nativeId("capability_revision", reference.capabilityRevisionId),
        kind: "capability_revision",
        group: "history",
        status: activeRevision ? "active" : "recorded",
        tone: activeRevision ? "active" : "neutral",
        title: capability?.name ?? reference.capabilityId,
        summary: capability?.intent ?? "Recorded capability revision",
        capabilityId: reference.capabilityId,
        evidence: revision?.evidenceRefs ?? [],
        raw: revision ?? reference,
      }),
    );
  }

  for (const operation of activationOperations) {
    const operationSession = originSessions.sessionByExperimentId.get(operation.binding.experimentId);
    primitives.push(
      primitive({
        id: nativeId("activation", operation.operationId),
        kind: "activation",
        group: "activation",
        status: operation.status,
        tone:
          operation.status === "committed" || operation.status === "approved"
            ? "positive"
            : operation.status === "blocked" || operation.status === "rejected"
              ? "negative"
              : "pending",
        title: `Activation · ${operation.decision.replaceAll("_", " ")}`,
        summary:
          hypothesisByExperimentId.get(operation.binding.experimentId) ??
          `${operation.binding.candidateRevision.capabilityId}@${operation.binding.candidateRevision.capabilityRevisionId}`,
        occurredAt: operation.updatedAt,
        experimentId: operation.binding.experimentId,
        ...(operationSession ? { sessionId: operationSession } : {}),
        capabilityId: operation.binding.candidateRevision.capabilityId,
        evidence: [],
        relations: [
          relation("experiment", "experiment", operation.binding.experimentId),
          relation(
            "candidate",
            "capability_revision",
            operation.binding.candidateRevision.capabilityRevisionId,
          ),
          relation("report", "preflight_report", operation.binding.preflightId),
          relation("approval", "approval", operation.approvalId),
        ].filter(defined),
        raw: operation,
      }),
    );
    if (operation.approvalId) {
      const approval = await source.activations.getApproval(operation.approvalId);
      if (approval)
        primitives.push(
          primitive({
            id: nativeId("approval", approval.approvalId),
            kind: "approval",
            group: "activation",
            status: approval.status,
            tone:
              approval.status === "approved"
                ? "positive"
                : approval.status === "rejected"
                  ? "negative"
                  : "pending",
            title: "Activation approval",
            summary:
              hypothesisByExperimentId.get(operation.binding.experimentId) ??
              approval.decisionActor ??
              "Awaiting a protected decision",
            occurredAt: approval.decidedAt ?? approval.requestedAt,
            ...(operationSession ? { sessionId: operationSession } : {}),
            relations: [relation("activation", "activation", approval.operationId)].filter(defined),
            raw: approval,
          }),
        );
    }
  }

  if (activation)
    primitives.push(
      primitive({
        id: nativeId("activation", activation.activationId),
        kind: "activation",
        group: "activation",
        status: "current",
        tone: "active",
        title: `Current activation r${String(activation.revision)}`,
        summary: `${String(Object.keys(activation.activeCapabilityRevisions).length)} active capabilities`,
        occurredAt: activation.createdAt,
        relations: [relation("previous", "activation", activation.previousActivationId ?? undefined)].filter(
          defined,
        ),
        raw: activation,
      }),
    );

  const [capabilityDefinitions, capabilityBindings, pendingGates] = await Promise.all([
    source.workspace.capabilities.listDefinitions(),
    source.workspace.capabilities.listBindings({
      project: source.project,
      sessionId,
      limit: AUDIT_LIMIT,
    }),
    source.workspace.capabilities.listPendingGates({
      project: source.project,
      sessionId,
      limit: AUDIT_LIMIT,
    }),
  ]);
  const capabilityDefinitionById = new Map(
    capabilityDefinitions.map((definition) => [definition.capabilityId, definition] as const),
  );
  const perCapabilityLimit = Math.max(
    1,
    Math.min(50, Math.floor(AUDIT_LIMIT / Math.max(1, capabilityBindings.length))),
  );
  const capabilityHistory = await Promise.all(
    capabilityBindings.map(async (binding) => {
      const [listedRevisions, currentRevision, feedback] = await Promise.all([
        source.workspace.capabilities.listRevisions(binding.capabilityId, {
          limit: perCapabilityLimit,
        }),
        source.workspace.capabilities.getRevision(binding.revision),
        source.workspace.capabilities.listFeedback(binding.capabilityId, {
          limit: perCapabilityLimit,
        }),
      ]);
      const revisions = Object.freeze(
        [
          ...new Map(
            [...(currentRevision ? [currentRevision] : []), ...listedRevisions].map((revision) => [
              revision.reference.capabilityRevisionId,
              revision,
            ]),
          ).values(),
        ].slice(0, perCapabilityLimit),
      );
      return Object.freeze({ binding, currentRevision, revisions, feedback });
    }),
  );
  for (const { binding, currentRevision, revisions, feedback } of capabilityHistory) {
    const definition = capabilityDefinitionById.get(binding.capabilityId);
    const sourceReflection = reflectionByCapabilityId.get(binding.capabilityId);
    const sourceSessionId = sourceReflection ? jobSessionId(sourceReflection) : undefined;
    const consideredEvidence =
      sourceReflection && jobSensitivity(sourceReflection) === "normal" ? sourceReflection.payloadRefs : [];
    const currentMaterialEntries = await capabilityMaterialEntries(
      source.workspace,
      definition,
      currentRevision,
    );
    const currentFacets = capabilityFacets(currentRevision?.revision);
    primitives.push(
      primitive({
        id: nativeId("capability", binding.capabilityId),
        kind: "capability",
        group: "capabilities",
        status: `${binding.state} · ${binding.activationMode}`,
        tone: binding.state === "active" ? "active" : "neutral",
        title: definition?.name ?? binding.capabilityId,
        summary: definition?.description ?? "Durable capability",
        occurredAt: binding.updatedAt,
        ...(sourceSessionId ? { sessionId: sourceSessionId } : {}),
        ...(binding.scope.kind === "project" ? { projectId: binding.scope.project.projectId } : {}),
        capabilityId: binding.capabilityId,
        capabilityRevisionId: binding.revision.capabilityRevisionId,
        capabilityBundleDigest: binding.revision.bundleDigest,
        capabilityBindingRevision: binding.revisionNumber,
        ...(currentFacets.length > 0 ? { capabilityFacets: currentFacets } : {}),
        ...(definition?.kind ? { capabilityKind: definition.kind } : {}),
        capabilityState: binding.state,
        capabilityActivationMode: binding.activationMode,
        capabilityScope: binding.scope.kind,
        relations: [
          relation("authored by reflection", "reflection", sourceReflection?.jobId),
          ...revisions
            .filter(
              (revision) => revision.reference.capabilityRevisionId !== binding.revision.capabilityRevisionId,
            )
            .map((revision) =>
              relation("previous revision", "capability_revision", revision.reference.capabilityRevisionId),
            ),
        ].filter(defined),
        detailSections: [
          detailSection("WHAT CHANGED", currentMaterialEntries),
          detailSection("BEHAVIOR", [
            detailEntry("applies when", definition?.applicability),
            detailEntry("scope", capabilityScopeLabel(binding.scope)),
            detailEntry("selection", capabilitySelectionLabel(binding.activationMode)),
            detailEntry("state", binding.state === "active" ? "Active" : "Paused"),
          ]),
          detailSection("WHY", [
            detailEntry("reason", currentRevision?.rationale),
            detailEntry("expected effect", currentRevision?.anticipatedEffect),
          ]),
          detailSection("PROVENANCE", [
            detailEntry(
              "origin",
              sourceReflection
                ? "Ambient reflection after a settled foreground turn"
                : "Recorded Capability lifecycle",
            ),
            detailEntry("current revision", currentRevision?.summary),
          ]),
          detailSection("HISTORY", [
            detailEntry("revisions", String(revisions.length)),
            detailEntry("feedback", String(feedback.length)),
          ]),
        ].filter(defined),
        evidence: currentRevision?.revision.evidenceRefs ?? [],
        evidencePreviews: await resolveEvidencePreviews(currentRevision?.revision.evidenceRefs ?? []),
        consideredEvidenceCount: consideredEvidence.length,
        consideredEvidencePreviews: await resolveEvidencePreviews(
          consideredEvidence,
          CONSIDERED_PREVIEW_LIMIT,
        ),
        raw: { definition, binding, currentRevision },
      }),
    );
    for (const revision of revisions) {
      const revisionFacets = capabilityFacets(revision.revision);
      const revisionMaterialEntries = await capabilityMaterialEntries(source.workspace, definition, revision);
      primitives.push(
        primitive({
          id: nativeId("capability_revision", revision.reference.capabilityRevisionId),
          kind: "capability_revision",
          group: "history",
          status:
            revision.reference.capabilityRevisionId === binding.revision.capabilityRevisionId
              ? "current"
              : "superseded",
          tone:
            revision.reference.capabilityRevisionId === binding.revision.capabilityRevisionId
              ? "active"
              : "neutral",
          title: revision.summary,
          summary: revision.anticipatedEffect,
          occurredAt: revision.createdAt,
          capabilityId: binding.capabilityId,
          capabilityRevisionId: revision.reference.capabilityRevisionId,
          capabilityBundleDigest: revision.reference.bundleDigest,
          capabilityBindingRevision: binding.revisionNumber,
          ...(revisionFacets.length > 0 ? { capabilityFacets: revisionFacets } : {}),
          ...(definition?.kind ? { capabilityKind: definition.kind } : {}),
          capabilityState: binding.state,
          capabilityActivationMode: binding.activationMode,
          capabilityScope: binding.scope.kind,
          evidence: revision.revision.evidenceRefs,
          evidencePreviews: await resolveEvidencePreviews(revision.revision.evidenceRefs),
          relations: [
            relation("capability", "capability", binding.capabilityId),
            relation("predecessor", "capability_revision", revision.revision.predecessorRevisionId),
          ].filter(defined),
          detailSections: [
            detailSection("WHAT CHANGED", revisionMaterialEntries),
            detailSection("WHY", [
              detailEntry("reason", revision.rationale),
              detailEntry("expected effect", revision.anticipatedEffect),
            ]),
          ].filter(defined),
          raw: revision,
        }),
      );
    }
    for (const item of feedback)
      primitives.push(
        primitive({
          id: nativeId("capability_feedback", item.feedbackId),
          kind: "capability_feedback",
          group: "feedback",
          status: item.disposition,
          tone: item.disposition === "correction" ? "negative" : "neutral",
          title: `Feedback · ${item.disposition}`,
          summary: item.interpretation,
          occurredAt: item.createdAt,
          capabilityId: item.capabilityId,
          evidence: item.evidenceRefs,
          relations: [
            relation("capability", "capability", item.capabilityId),
            relation("revision", "capability_revision", item.revision.capabilityRevisionId),
          ].filter(defined),
          raw: item,
        }),
      );
  }
  for (const gate of pendingGates)
    primitives.push(
      primitive({
        id: nativeId("capability_gate", gate.gateRequestId),
        kind: "capability_gate",
        group: "activation",
        status: gate.status,
        tone: "pending",
        title: "Capability needs a decision",
        summary: gate.consequence,
        occurredAt: gate.createdAt,
        capabilityId: gate.capabilityId,
        capabilityRevisionId: gate.revision.capabilityRevisionId,
        capabilityBindingRevision: gate.expectedBindingRevision,
        gateRequestId: gate.gateRequestId,
        relations: [
          relation("capability", "capability", gate.capabilityId),
          relation("revision", "capability_revision", gate.revision.capabilityRevisionId),
        ].filter(defined),
        detailSections: [
          detailSection("DECISION", [
            detailEntry("consequence", gate.consequence),
            detailEntry("options", "approve · deny · change"),
          ]),
        ].filter(defined),
        raw: gate,
      }),
    );

  for (const signal of feedbackSignals) {
    const signalSession = signal.experimentId
      ? originSessions.sessionByExperimentId.get(signal.experimentId)
      : undefined;
    primitives.push(
      primitive({
        id: nativeId("feedback_signal", signal.signalId),
        kind: "feedback_signal",
        group: "feedback",
        status: signal.kind.replaceAll("_", " "),
        title: signal.kind.replaceAll("_", " "),
        summary: `${signal.scope} · strength ${String(signal.strength)} · novelty ${String(signal.novelty)}`,
        ...(signal.experimentId ? { experimentId: signal.experimentId } : {}),
        ...(signalSession ? { sessionId: signalSession } : {}),
        evidence: signal.evidenceRefs,
        relations: [
          relation("experiment", "experiment", signal.experimentId),
          relation("revision", "capability_revision", signal.capabilityRevisionId),
        ].filter(defined),
        raw: signal,
        sensitivity: signal.sensitivity,
      }),
    );
  }

  const deduplicated = [...new Map(primitives.map((item) => [item.id, item] as const)).values()];
  const isRoutineReflection = (item: TuiLearningPrimitive): boolean =>
    item.kind === "reflection" && new Set(["no_change", "scheduled", "running"]).has(item.status);
  const material = sortPrimitives(deduplicated.filter((item) => !isRoutineReflection(item))).slice(
    0,
    AUDIT_LIMIT,
  );
  const routineCapacity = Math.min(50, Math.max(0, AUDIT_LIMIT - material.length));
  const routine = sortPrimitives(deduplicated.filter(isRoutineReflection)).slice(0, routineCapacity);
  const sorted = sortPrimitives([...material, ...routine]);
  const titles = new Map(sorted.map((item) => [item.id, item.title] as const));
  const presented = Object.freeze(
    sorted.map((item) =>
      Object.freeze({
        ...item,
        relations: Object.freeze(
          item.relations.map((itemRelation) => {
            const targetTitle = titles.get(itemRelation.targetId);
            return Object.freeze({
              ...itemRelation,
              ...(targetTitle ? { targetTitle } : {}),
            });
          }),
        ),
      }),
    ),
  );
  return Object.freeze({
    projectId: source.project.projectId,
    sessionId,
    generatedAt: (source.now ?? (() => new Date()))().toISOString(),
    ...(activeAdjustment ? { activeAdjustmentId: activeAdjustment.adjustmentId } : {}),
    ...(activation ? { activeActivationId: activation.activationId } : {}),
    primitives: presented,
  });
}
