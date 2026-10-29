import {
  createConditionalObject,
  type CapabilityLifecycleRevision,
  type CapabilityRevision,
  type CapabilityScope,
  canonicalJson,
  capabilityEvidenceLabel,
  type DurableJobRecord,
  type EvidenceRef,
  type FileRevisionRef,
  type ProjectRef,
  isJsonObject,
  type JsonObject,
  JsonValueSchema,
  parseCapabilityDocument,
  sha256,
  toJsonValue,
} from "@noesis/domain";
import { capabilityDocumentRevision, capabilityWorkingDocumentPath } from "@noesis/learning";
import { join } from "node:path";
import { CAPABILITY_REFLECTION_JOB_KIND } from "@noesis/runtime";
import type {
  TuiCapabilityFacet,
  TuiLearningAuditSnapshot,
  TuiLearningDetailSection,
  TuiLearningEvidencePreview,
  TuiLearningPrimitive,
  TuiLearningPrimitiveKind,
  TuiLearningRelation,
} from "@noesis/tui";
import type { NoesisWorkspaceStore } from "@noesis/workspace";
const AUDIT_LIMIT = 1000;
const RAW_JSON_LIMIT = 64000;
const EVIDENCE_PREVIEW_LIMIT = 8;
const CONSIDERED_PREVIEW_LIMIT = 8;
const EVIDENCE_EXCERPT_LIMIT = 480;
const MATERIAL_PREVIEW_LIMIT = 2400;
interface LearningAuditSource {
  readonly workspace: NoesisWorkspaceStore;
  /** The Noesis home, used to show where each Capability file lives. */
  readonly home?: string;
  /** Why an edited Capability file could not be applied, by Capability ID. */
  readonly editProblems?: ReadonlyMap<string, string>;
  readonly project: ProjectRef;
  readonly now?: () => Date;
}
interface PrimitiveInput extends Omit<
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
// BOUNDARY: Audit rows combine several immutable historical schemas; conversion is bounded before display.
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
// BOUNDARY: Evidence may come from legacy rows with no shared payload schema; only bounded text escapes.
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
// BOUNDARY: Historical audit payloads are parsed as JSON before a requested scalar is projected.
function stringField(value: unknown, key: string): string | undefined {
  const parsed = JsonValueSchema.safeParse(value);
  if (!parsed.success || !isJsonObject(parsed.data)) return undefined;
  const field = parsed.data[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
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
function capabilityFacets(revision: CapabilityRevision | undefined): readonly TuiCapabilityFacet[] {
  return revision ? Object.freeze(revision.effects.map((effect) => effect.kind)) : Object.freeze([]);
}
function facetCountLabel(revision: CapabilityRevision): string {
  const effects = revision.effects;
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
  lifecycle: CapabilityLifecycleRevision | undefined,
): Promise<readonly (ReturnType<typeof detailEntry> | undefined)[]> {
  if (!lifecycle) return Object.freeze([]);
  const revision = lifecycle.revision;
  const effectEntries = await Promise.all(
    revision.effects.map(async (effect) =>
      effect.kind === "instruction"
        ? await materialEntry(workspace, "instruction", effect.material)
        : await materialEntry(
            workspace,
            `program (${effect.program.mode}) · ${effect.program.name}`,
            effect.program.definitionRevision,
          ),
    ),
  );
  return Object.freeze([
    detailEntry("effects", capabilityFacets(revision).join(" + ")),
    detailEntry("change", lifecycle.summary),
    ...effectEntries,
    detailEntry("materials", facetCountLabel(revision)),
  ]);
}
function reflectionStatusLabel(status: string): string {
  if (status === "no_change") return "No lasting change";
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
function reflectionDetails(job: DurableJobRecord): readonly TuiLearningDetailSection[] {
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
  return Object.freeze(
    [
      detailSection("Decision", [
        detailEntry("Outcome", reflectionStatusLabel(status)),
        detailEntry("Why", reflectionReason(job)),
      ]),
      status === "stale"
        ? detailSection("What changed", [
            detailEntry("Result", "Nothing changed because the decision was stale."),
          ])
        : undefined,
    ].filter(defined),
  );
}
async function listProjectReflectionJobs(
  workspace: NoesisWorkspaceStore,
  projectId: string,
): Promise<readonly DurableJobRecord[]> {
  return await workspace.jobs.list({
    kind: CAPABILITY_REFLECTION_JOB_KIND,
    payloadProjectId: projectId,
    order: "newest",
    limit: AUDIT_LIMIT,
  });
}
// BOUNDARY: Reflection payloads are read loosely so older completed jobs stay listable.
function reflectionTurn(job: DurableJobRecord): JsonObject | undefined {
  const payload = JsonValueSchema.safeParse(job.payload);
  if (!payload.success || !isJsonObject(payload.data)) return undefined;
  const turn = payload.data["turn"];
  return isJsonObject(turn) ? turn : undefined;
}
function jobProjectId(job: DurableJobRecord): string | undefined {
  return stringField(job.result, "projectId") ?? stringField(reflectionTurn(job)?.["project"], "projectId");
}
function jobSessionId(job: DurableJobRecord): string | undefined {
  return stringField(reflectionTurn(job), "sessionId");
}
function jobSensitivity(job: DurableJobRecord): "normal" | "private" | "secret" {
  const value = stringField(reflectionTurn(job), "sensitivity");
  return value === "private" || value === "secret" ? value : "normal";
}
function jobSummary(job: DurableJobRecord): string {
  if (jobSensitivity(job) !== "normal")
    return "Sensitive reflection details are hidden because this TUI has no admitted grant for them.";
  if (job.status === "failed" || job.status === "budget_exhausted" || job.status === "cancelled")
    return job.lastError?.message ?? `Learning job ${job.status.replaceAll("_", " ")}`;
  if (job.status !== "completed") return `${job.kind} is ${job.status}`;
  return reflectionReason(job);
}
function reflectionTitle(job: DurableJobRecord): string {
  const status = stringField(job.result, "status") ?? job.status;
  if (jobSensitivity(job) !== "normal") return reflectionStatusLabel(status);
  const rationale = stringField(job.result, "rationale");
  if (rationale && status !== "no_change") return rationale;
  return reflectionStatusLabel(status);
}
async function reflectionPrimitive(
  job: DurableJobRecord,
  evidencePreviews: (
    references: readonly EvidenceRef[],
    limit?: number,
  ) => Promise<readonly TuiLearningEvidencePreview[]>,
): Promise<TuiLearningPrimitive> {
  const sessionId = jobSessionId(job);
  const projectId = jobProjectId(job);
  const reflectionStatus = stringField(job.result, "status") ?? job.status;
  const sensitivity = jobSensitivity(job);
  const consideredEvidence = sensitivity === "normal" ? job.payloadRefs : [];
  const title = reflectionTitle(job);
  const summary = jobSummary(job);
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return primitive(
    createConditionalObject({
      id: nativeId("reflection", job.jobId),
      kind: "reflection",
      group: "reflection",
      status: reflectionStatus,
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
    } as const)
      .addOptional(sessionId ? { sessionId } : undefined)
      .addOptional(projectId ? { projectId } : undefined)
      .add({
        consideredEvidenceCount: consideredEvidence.length,
        consideredEvidencePreviews:
          job.status === "completed" && reflectionStatus !== "no_change"
            ? await evidencePreviews(consideredEvidence, CONSIDERED_PREVIEW_LIMIT)
            : [],
        detailSections: reflectionDetails(job),
        raw: job,
        sensitivity,
      } as const)
      .finish(),
  );
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
  const jobs = await listProjectReflectionJobs(source.workspace, source.project.projectId);
  const reflectionByCapabilityId = new Map<string, DurableJobRecord>();
  for (const job of jobs) {
    const capabilityId = stringField(job.result, "capabilityId");
    if (capabilityId && !reflectionByCapabilityId.has(capabilityId))
      reflectionByCapabilityId.set(capabilityId, job);
  }
  const resolveEvidencePreviews = createEvidencePreviewResolver(source.workspace);
  const primitives: TuiLearningPrimitive[] = await Promise.all(
    jobs.map(async (job) => await reflectionPrimitive(job, resolveEvidencePreviews)),
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
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const capabilityDefinitionById = new Map(
    capabilityDefinitions.map((definition) => [definition.capabilityId, definition] as const),
  );
  const perCapabilityLimit = Math.max(
    1,
    Math.min(50, Math.floor(AUDIT_LIMIT / Math.max(1, capabilityBindings.length))),
  );
  const capabilityHistory = await Promise.all(
    capabilityBindings.map(async (binding) => {
      const [listedRevisions, currentRevision, feedback, records, outcomes] = await Promise.all([
        source.workspace.capabilities.listRevisions(binding.capabilityId, {
          limit: perCapabilityLimit,
        }),
        source.workspace.capabilities.getRevision(binding.revision),
        source.workspace.capabilities.listFeedback(binding.capabilityId, {
          limit: perCapabilityLimit,
        }),
        source.workspace.capabilities.trackRecords([binding.revision.capabilityRevisionId]),
        source.workspace.capabilities.listOutcomes(binding.capabilityId, 5),
      ]);
      const trackRecord = records.get(binding.revision.capabilityRevisionId);
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
      return Object.freeze({ binding, currentRevision, revisions, feedback, trackRecord, outcomes });
    }),
  );
  for (const { binding, currentRevision, revisions, feedback, trackRecord, outcomes } of capabilityHistory) {
    const used = (trackRecord?.helped ?? 0) + (trackRecord?.hurt ?? 0) + (trackRecord?.unclear ?? 0);
    const trackRecordLabel =
      used === 0
        ? "not judged in use yet"
        : `used ${String(used)}× · helped ${String(trackRecord?.helped ?? 0)} · hurt ${String(trackRecord?.hurt ?? 0)}`;
    const definition = capabilityDefinitionById.get(binding.capabilityId);
    const sourceReflection = reflectionByCapabilityId.get(binding.capabilityId);
    const sourceSessionId = sourceReflection ? jobSessionId(sourceReflection) : undefined;
    const consideredEvidence =
      sourceReflection && jobSensitivity(sourceReflection) === "normal" ? sourceReflection.payloadRefs : [];
    const currentMaterialEntries = await capabilityMaterialEntries(source.workspace, currentRevision);
    const currentFacets = capabilityFacets(currentRevision?.revision);
    const document = currentRevision ? capabilityDocumentRevision(currentRevision) : undefined;
    const workingDocumentPath = document ? capabilityWorkingDocumentPath(document) : undefined;
    const workingDocument = workingDocumentPath
      ? await source.workspace.reads.readWorkingFile(workingDocumentPath)
      : undefined;
    // An edit that differs from the current revision and still exists was not readable.
    const unreadableEdit =
      document && workingDocument && sha256(workingDocument) !== document.contentDigest
        ? parseCapabilityDocument(new TextDecoder().decode(workingDocument))
        : undefined;
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    primitives.push(
      primitive(
        createConditionalObject({
          id: nativeId("capability", binding.capabilityId),
          kind: "capability",
          group: "capabilities",
          status: `${binding.state} · ${binding.activationMode} · ${trackRecordLabel}`,
          tone: binding.state === "active" ? "active" : "neutral",
          title: definition?.name ?? binding.capabilityId,
          summary: definition?.description ?? "Durable capability",
          occurredAt: binding.updatedAt,
        } as const)
          .addOptional(sourceSessionId ? { sessionId: sourceSessionId } : undefined)
          .addOptional(
            binding.scope.kind === "project" ? { projectId: binding.scope.project.projectId } : undefined,
          )
          .add({
            capabilityId: binding.capabilityId,
            capabilityRevisionId: binding.revision.capabilityRevisionId,
            capabilityBundleDigest: binding.revision.bundleDigest,
            capabilityBindingRevision: binding.revisionNumber,
          } as const)
          .addOptional(currentFacets.length > 0 ? { capabilityFacets: currentFacets } : undefined)
          .add({
            capabilityState: binding.state,
            capabilityActivationMode: binding.activationMode,
            capabilityScope: binding.scope.kind,
            relations: [
              relation("authored by reflection", "reflection", sourceReflection?.jobId),
              ...revisions
                .filter(
                  (revision) =>
                    revision.reference.capabilityRevisionId !== binding.revision.capabilityRevisionId,
                )
                .map((revision) =>
                  relation(
                    "previous revision",
                    "capability_revision",
                    revision.reference.capabilityRevisionId,
                  ),
                ),
            ].filter(defined),
            detailSections: [
              detailSection("FILE", [
                detailEntry(
                  "edit here",
                  workingDocumentPath
                    ? source.home
                      ? join(source.home, workingDocumentPath)
                      : workingDocumentPath
                    : "Moves into a file the next time Noesis starts",
                ),
                detailEntry(
                  "your last edit",
                  unreadableEdit && !unreadableEdit.ok
                    ? `Not applied. ${unreadableEdit.error}.`
                    : source.editProblems?.has(binding.capabilityId)
                      ? `Not applied. ${source.editProblems.get(binding.capabilityId) ?? ""}`
                      : undefined,
                ),
              ]),
              detailSection("WHAT CHANGED", currentMaterialEntries),
              detailSection("BEHAVIOR", [
                detailEntry("applies when", definition?.applicability),
                detailEntry("scope", capabilityScopeLabel(binding.scope)),
                detailEntry("selection", capabilitySelectionLabel(binding.activationMode)),
                detailEntry("state", binding.state === "active" ? "Active" : "Paused"),
              ]),
              detailSection("WHY", [
                detailEntry(
                  "evidence",
                  currentRevision?.evidence
                    ? capabilityEvidenceLabel(currentRevision.evidence.kind)
                    : undefined,
                ),
                detailEntry("in their words", currentRevision?.evidence?.quote),
                detailEntry("without it", currentRevision?.evidence?.wouldOtherwise),
                detailEntry("reason", currentRevision?.rationale),
                detailEntry("expected effect", currentRevision?.anticipatedEffect),
              ]),
              detailSection("TRACK RECORD", [
                detailEntry("this revision", trackRecordLabel),
                ...outcomes.map((outcome) =>
                  detailEntry(`${outcome.result} · ${outcome.createdAt.slice(0, 10)}`, outcome.reason),
                ),
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
          } as const)
          .finish(),
      ),
    );
    for (const revision of revisions) {
      const revisionFacets = capabilityFacets(revision.revision);
      const revisionMaterialEntries = await capabilityMaterialEntries(source.workspace, revision);
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      primitives.push(
        primitive(
          createConditionalObject({
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
          } as const)
            .addOptional(revisionFacets.length > 0 ? { capabilityFacets: revisionFacets } : undefined)
            .add({
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
            } as const)
            .finish(),
        ),
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
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
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
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const titles = new Map(sorted.map((item) => [item.id, item.title] as const));
  const presented = Object.freeze(
    sorted.map((item) =>
      Object.freeze({
        ...item,
        relations: Object.freeze(
          item.relations.map((itemRelation) => {
            const targetTitle = titles.get(itemRelation.targetId);
            // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
            return Object.freeze(
              createConditionalObject({
                ...itemRelation,
              } as const)
                .addOptional(targetTitle ? { targetTitle } : undefined)
                .finish(),
            );
          }),
        ),
      }),
    ),
  );
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze(
    createConditionalObject({
      projectId: source.project.projectId,
      sessionId,
      generatedAt: (source.now ?? (() => new Date()))().toISOString(),
    } as const)
      .add({
        primitives: presented,
      } as const)
      .finish(),
  );
}
