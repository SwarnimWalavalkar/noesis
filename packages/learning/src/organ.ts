import type {
  AgentMessage,
  AgentRole,
  AgentRunRequest,
  AgentTrace,
  StructuredInferencePort,
} from "@noesis/agent-types";
import type { AtomicCapabilityRegistry, CapabilityRevisionConstruction } from "@noesis/capabilities";
import {
  type Capability,
  type CapabilityRevision,
  type CapabilityRevisionRef,
  canonicalJson,
  createId,
  type DefinitionFilePort,
  durableJobFailureError,
  durableJobFailureFromError,
  type EvidenceRef,
  type Experiment,
  type ExperimentStorePort,
  type FeedbackSignal,
  type FeedbackSignalStorePort,
  type FileRevisionRef,
  sameCapabilityRevisionRef,
  sha256,
  type WorkingAdjustment,
  WORKING_ADJUSTMENT_LIMITS,
} from "@noesis/domain";
import type { ExactCitation, HistoryPort } from "@noesis/intelligence";
import {
  type AutomaticLearningConfig,
  AutomaticLearningConfigSchema,
  type LearningCitation,
  type LearningRoleConfiguration,
  type LearningSourceCase,
  type LearningTurnInput,
  LearningTurnInputSchema,
  normalizeRevisionAuthorOutput,
  type ReflectorOutput,
  ReflectorOutputSchema,
  RevisionAuthorInferenceOutputSchema,
  type RevisionAuthorOutput,
  type RoleResearchMetadata,
  type ScopeRelationshipVerification,
  ScopeRelationshipVerificationSchema,
  type SemanticTurnObservation,
} from "./schemas.ts";

export interface HarvestedLearningSignal {
  readonly signal: FeedbackSignal;
  readonly rowRef: EvidenceRef;
}

export interface SignalHarvestResult {
  readonly turn: LearningTurnInput;
  readonly signals: readonly HarvestedLearningSignal[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly citations: readonly LearningCitation[];
  readonly recurrenceCount: number;
}

export interface LearningRoleResearchRun {
  readonly runId: string;
  readonly role: AgentRole;
  readonly research: RoleResearchMetadata;
  readonly trace: AgentTrace;
}

export interface ExperimentBrief {
  readonly experimentId: string;
  readonly title: string;
  readonly hypothesis: string;
  readonly hypothesisDedupeKey: string;
  readonly scope: string;
  readonly anticipatedFutureUse: string;
  readonly scopeRelationship: "same" | "narrower" | "broader";
  readonly scopeRationale: string;
  readonly staleOrContradictionConditions: readonly string[];
  readonly verifiedScopeRelationship: "same" | "narrower" | "broader";
  readonly scopeVerificationReason: string;
  readonly scopeVerificationRun?: LearningRoleResearchRun;
  readonly capability: Capability;
  readonly baselineRevision: CapabilityRevisionRef;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly feedbackSignalIds: readonly string[];
  readonly citations: readonly LearningCitation[];
  readonly recurrenceCitations: readonly LearningCitation[];
  readonly sourceCases: readonly LearningSourceCase[];
  readonly recurrenceCount: number;
  readonly reflectionRun?: LearningRoleResearchRun;
  readonly sourceAdjustmentId?: string;
}

export interface ExperimentBriefStore {
  readonly findByDedupeKey: (key: string) => Promise<ExperimentBrief | undefined>;
  /** Create-only. A publication collision must be byte-identical. */
  readonly put: (brief: ExperimentBrief) => Promise<ExperimentBrief>;
  /** Deliberate revision of the current brief under an exact experiment identity CAS. */
  readonly replace: (input: {
    readonly expectedExperimentId: string;
    readonly brief: ExperimentBrief;
  }) => Promise<ExperimentBrief>;
}

export const EXPERIMENT_BRIEF_PUBLICATION_COLLISION_CODE = "experiment_brief_publication_collision" as const;
const MAX_BRIEF_RECONCILIATION_ATTEMPTS = 3;

export function experimentBriefPublicationCollisionError(key: string, cause?: unknown): Error {
  return durableJobFailureError(`Experiment brief publication collision for ${key}`, {
    code: EXPERIMENT_BRIEF_PUBLICATION_COLLISION_CODE,
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

function isExperimentBriefPublicationCollision(error: unknown): boolean {
  return durableJobFailureFromError(error)?.code === EXPERIMENT_BRIEF_PUBLICATION_COLLISION_CODE;
}

/**
 * Durable semantic-hypothesis material used by the revision author. SQLite owns the matching
 * operational Experiment from hypothesis onward; the brief remains inspectable authored evidence.
 */
export function createInMemoryExperimentBriefStore(): ExperimentBriefStore {
  const briefs = new Map<string, ExperimentBrief>();
  return Object.freeze({
    findByDedupeKey: async (key: string) => briefs.get(key),
    put: async (brief: ExperimentBrief) => {
      const existing = briefs.get(brief.hypothesisDedupeKey);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(brief))
          throw experimentBriefPublicationCollisionError(brief.hypothesisDedupeKey);
        return existing;
      }
      briefs.set(brief.hypothesisDedupeKey, brief);
      return brief;
    },
    replace: async (input: { readonly expectedExperimentId: string; readonly brief: ExperimentBrief }) => {
      const { expectedExperimentId, brief } = input;
      const existing = briefs.get(brief.hypothesisDedupeKey);
      if (!existing || existing.experimentId !== expectedExperimentId)
        throw experimentBriefPublicationCollisionError(brief.hypothesisDedupeKey);
      briefs.set(brief.hypothesisDedupeKey, brief);
      return brief;
    },
  });
}

export interface LearningNotification {
  readonly mode: "quiet" | "detailed";
  readonly kind: "criterion" | "experiment" | "working_adjustment";
  readonly message: string;
}

export type ObserveLearningResult =
  | {
      readonly status: "no_change";
      readonly reason: "disabled" | "sensitive" | "reflector_no_change";
      readonly harvest: SignalHarvestResult;
      readonly reflectionRun?: LearningRoleResearchRun;
      readonly observation: SemanticTurnObservation | null;
      readonly notification: LearningNotification | null;
      readonly interruption: null;
    }
  | {
      readonly status: "apply_working_adjustment";
      readonly harvest: SignalHarvestResult;
      readonly project: NonNullable<LearningTurnInput["project"]>;
      readonly expectedActiveAdjustmentId: string | null;
      readonly rationale: string;
      readonly strategy: string;
      readonly successSignal: string;
      readonly evidenceRefs: readonly EvidenceRef[];
      readonly reflectionRun: LearningRoleResearchRun;
      readonly observation: SemanticTurnObservation;
      readonly notification: LearningNotification | null;
      readonly interruption: null;
    }
  | {
      readonly status: "unapply_working_adjustment";
      readonly harvest: SignalHarvestResult;
      readonly project: NonNullable<LearningTurnInput["project"]>;
      readonly expectedActiveAdjustmentId: string;
      readonly reason: string;
      readonly evidenceRefs: readonly EvidenceRef[];
      readonly reflectionRun: LearningRoleResearchRun;
      readonly observation: SemanticTurnObservation;
      readonly notification: LearningNotification | null;
      readonly interruption: null;
    }
  | {
      readonly status: "deduped";
      readonly harvest: SignalHarvestResult;
      readonly brief: ExperimentBrief;
      readonly reflectionRun: LearningRoleResearchRun;
      readonly observation: SemanticTurnObservation;
      readonly notification: LearningNotification | null;
      readonly interruption: null;
    }
  | {
      readonly status: "experiment";
      readonly harvest: SignalHarvestResult;
      readonly brief: ExperimentBrief;
      readonly reflectionRun: LearningRoleResearchRun;
      readonly observation: SemanticTurnObservation;
      readonly notification: LearningNotification | null;
      readonly interruption: null;
    };

export interface AuthorRevisionResult {
  readonly brief: ExperimentBrief;
  readonly revision: CapabilityRevision;
  readonly revisionRef: CapabilityRevisionRef;
  readonly authorRun: LearningRoleResearchRun;
  readonly experiment: Experiment;
}

export interface AutomaticLearningOrganOptions {
  readonly config: AutomaticLearningConfig;
  readonly history: Pick<HistoryPort, "search" | "resolve">;
  readonly feedbackSignals: FeedbackSignalStorePort;
  readonly inference: StructuredInferencePort;
  readonly briefs: ExperimentBriefStore;
  readonly capabilities: AtomicCapabilityRegistry;
  readonly candidateDefinitions: Pick<DefinitionFilePort, "recordCandidateDefinition">;
  readonly experiments: ExperimentStorePort;
  readonly candidateManifests?: LearningCandidateManifestStore;
  readonly nextId?: (prefix: string) => string;
}

export interface LearningCandidateManifestStore {
  readonly persist: (input: {
    readonly brief: ExperimentBrief;
    readonly revision: CapabilityRevision;
    readonly revisionRef: CapabilityRevisionRef;
  }) => Promise<FileRevisionRef>;
}

export interface ObserveLearningTurnRequest {
  readonly turn: unknown;
  readonly baselineRevision: CapabilityRevisionRef;
  readonly capability: Capability;
  readonly signal?: AbortSignal;
  readonly activeCapabilities?: readonly Capability[];
  readonly activeWorkingAdjustment?: WorkingAdjustment;
  readonly userPreferences?: readonly {
    readonly criterionId: string;
    readonly revision: number;
    readonly scope: string;
    readonly evaluatorInstruction: string;
  }[];
}

export interface AuthorExperimentRevisionRequest {
  readonly brief: ExperimentBrief;
  readonly predecessorRevision?: CapabilityRevisionRef;
  readonly signal?: AbortSignal;
}

export interface AuthorFollowUpRevisionRequest {
  readonly parentExperiment: Experiment;
  readonly capability: Capability;
  readonly failureSummary: string;
  readonly judgmentEvidenceRefs: readonly EvidenceRef[];
  readonly citations?: readonly LearningCitation[];
  readonly signal?: AbortSignal;
}

export interface AutomaticLearningOrgan {
  readonly observeTurn: (request: ObserveLearningTurnRequest) => Promise<ObserveLearningResult>;
  readonly authorExperimentRevision: (
    request: AuthorExperimentRevisionRequest,
  ) => Promise<AuthorRevisionResult>;
  readonly authorFollowUpRevision: (request: AuthorFollowUpRevisionRequest) => Promise<AuthorRevisionResult>;
}

function sameFileRevision(left: FileRevisionRef, right: FileRevisionRef): boolean {
  return (
    left.revisionId === right.revisionId &&
    left.workingPath === right.workingPath &&
    left.snapshotPath === right.snapshotPath &&
    left.contentDigest === right.contentDigest
  );
}

function validateRoleConfiguration(name: string, configuration: LearningRoleConfiguration): void {
  if (
    !configuration.variant.configurationRefs.some((reference) =>
      sameFileRevision(reference, configuration.promptRevision),
    )
  ) {
    throw new Error(`${name} role variant must pin its prompt revision`);
  }
}

function cloneEvidenceRefs(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  return Object.freeze(refs.map((reference) => Object.freeze({ ...reference })));
}

function evidenceKey(reference: EvidenceRef): string {
  switch (reference.kind) {
    case "database_row":
      return `${reference.kind}:${reference.table}:${reference.rowId}`;
    case "file_revision":
    case "evidence_revision":
      return `${reference.kind}:${reference.revisionId}`;
    case "artifact_file":
      return `${reference.kind}:${reference.artifactId}`;
  }
}

function uniqueEvidenceRefs(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  const unique = new Map<string, EvidenceRef>();
  for (const reference of refs) unique.set(evidenceKey(reference), Object.freeze({ ...reference }));
  return Object.freeze([...unique.values()]);
}

function toEvidenceRef(citation: ExactCitation): EvidenceRef | undefined {
  const source = citation.source;
  if (source.kind !== "database_row") return undefined;
  switch (source.table) {
    case "sessions":
    case "messages":
    case "tool_calls":
    case "outcomes":
      return Object.freeze({
        kind: "database_row",
        table: source.table,
        rowId: source.rowId,
      });
    default:
      return undefined;
  }
}

function cloneCitation(citation: ExactCitation): LearningCitation {
  return Object.freeze({
    ...citation,
    source: Object.freeze({ ...citation.source }),
  });
}

function signalKind(turn: LearningTurnInput) {
  if (turn.outcome === "failed" || turn.telemetry.toolFailureCount > 0) return "repeated_failure" as const;
  if (turn.telemetry.retryCount > 0 || turn.telemetry.aborted) return "friction" as const;
  if (
    turn.telemetry.latencyMs !== undefined &&
    turn.telemetry.expectedLatencyMs !== undefined &&
    turn.telemetry.latencyMs > turn.telemetry.expectedLatencyMs
  )
    return "cost_or_latency" as const;
  return undefined;
}

function signalStrength(kind: NonNullable<ReturnType<typeof signalKind>>): number {
  switch (kind) {
    case "repeated_failure":
      return 0.8;
    case "friction":
      return 0.7;
    case "cost_or_latency":
      return 0.65;
  }
}

function stableSignalId(turn: LearningTurnInput, kind: FeedbackSignal["kind"]): string {
  return `signal_${sha256(
    canonicalJson({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      kind,
      scope: turn.scope,
      statement: (turn.correction ?? turn.userMessage).trim(),
    }),
  ).slice(0, 32)}`;
}

function citationSourceKey(citation: ExactCitation): string {
  switch (citation.source.kind) {
    case "database_row":
      return `database_row:${citation.source.table}:${citation.source.rowId}`;
    case "file_revision":
      return `revision:${citation.source.revisionId}`;
  }
}

function evidenceCitationSourceKey(reference: EvidenceRef): string {
  switch (reference.kind) {
    case "database_row":
      return `database_row:${reference.table}:${reference.rowId}`;
    case "file_revision":
    case "evidence_revision":
      return `revision:${reference.revisionId}`;
    case "artifact_file":
      return `artifact:${reference.artifactId}`;
  }
}

function currentCitationSourceKeys(turn: LearningTurnInput): ReadonlySet<string> {
  return new Set(turn.evidenceRefs.map(evidenceCitationSourceKey));
}

function distinctHistoricalCitations(
  turn: LearningTurnInput,
  citations: readonly ExactCitation[],
): readonly LearningCitation[] {
  const current = currentCitationSourceKeys(turn);
  const distinct = new Map<string, LearningCitation>();
  for (const citation of citations) {
    if (current.has(citationSourceKey(citation))) continue;
    const key = canonicalJson({ source: citation.source, contentDigest: citation.contentDigest });
    // Distinct authoritative sources remain distinct even when they contain the same text.
    if (!distinct.has(key)) distinct.set(key, cloneCitation(citation));
  }
  return Object.freeze([...distinct.values()]);
}

function recurrenceCitations(
  reflected: Extract<ReflectorOutput, { readonly decision: "experiment" }>,
  citations: readonly LearningCitation[],
): readonly LearningCitation[] {
  const selected = new Map<string, LearningCitation>();
  for (const index of reflected.recurrenceEvidenceCitationIndexes) {
    const citation = citations[index];
    if (!citation) throw new Error(`Reflector cited missing recurrence evidence index ${String(index)}`);
    selected.set(canonicalJson({ source: citation.source, contentDigest: citation.contentDigest }), citation);
  }
  return Object.freeze([...selected.values()]);
}

function validateScopeContract(input: {
  readonly currentScope: string;
  readonly reflection: Extract<ReflectorOutput, { readonly decision: "experiment" }>;
  readonly verification: ScopeRelationshipVerification;
}): void {
  const sameScope =
    normalizedCapabilityScope(input.currentScope) === normalizedCapabilityScope(input.reflection.scope);
  if (sameScope !== (input.verification.relationship === "same"))
    throw new Error("Scope verifier's same-scope classification disagrees with canonical scope identity");
  if (input.reflection.scopeRelationship !== input.verification.relationship) {
    throw new Error(
      `Reflector scope relationship ${input.reflection.scopeRelationship} disagrees with independent verification ${input.verification.relationship}`,
    );
  }
}

function validateBroadeningEvidence(input: {
  readonly verifiedRelationship: ScopeRelationshipVerification["relationship"];
  readonly recurrenceCitations: readonly LearningCitation[];
  readonly recurrenceThreshold: number;
}): void {
  if (
    input.verifiedRelationship === "broader" &&
    input.recurrenceCitations.length < input.recurrenceThreshold
  ) {
    throw new Error(
      `Broader learning scope requires at least ${String(input.recurrenceThreshold)} distinct recurrence citations`,
    );
  }
}

function citationKey(citation: LearningCitation): string {
  return canonicalJson({ source: citation.source, contentDigest: citation.contentDigest });
}

function uniqueCitations(citations: readonly LearningCitation[]): readonly LearningCitation[] {
  const unique = new Map<string, LearningCitation>();
  for (const citation of citations) unique.set(citationKey(citation), cloneCitation(citation));
  return Object.freeze([...unique.values()]);
}

function roleRequest(input: {
  readonly runId: string;
  readonly role: AgentRole;
  readonly configuration: LearningRoleConfiguration;
  readonly messages: readonly AgentMessage[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly signal?: AbortSignal;
}): AgentRunRequest {
  return Object.freeze({
    runId: input.runId,
    role: input.role,
    variant: input.configuration.variant,
    messages: Object.freeze(input.messages.map((message) => Object.freeze({ ...message }))),
    evidenceRefs: cloneEvidenceRefs(input.evidenceRefs),
    availableTools: Object.freeze([]),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

function researchRun(
  runId: string,
  role: AgentRole,
  configuration: LearningRoleConfiguration,
  trace: AgentTrace,
): LearningRoleResearchRun {
  if (trace.role !== role)
    throw new Error(`Role trace ${trace.traceId} belongs to ${trace.role}, not ${role}`);
  return Object.freeze({
    runId,
    role,
    research: Object.freeze({
      promptRevision: Object.freeze({ ...configuration.promptRevision }),
      model: configuration.model,
      reasoning: configuration.reasoning,
    }),
    trace: Object.freeze({
      traceId: trace.traceId,
      role: trace.role,
      variant: Object.freeze({
        ...trace.variant,
        configurationRefs: Object.freeze(
          trace.variant.configurationRefs.map((reference) => Object.freeze({ ...reference })),
        ),
      }),
      startedAt: trace.startedAt,
      completedAt: trace.completedAt,
      usage: Object.freeze({ ...trace.usage }),
      evidenceRefs: Object.freeze(trace.evidenceRefs.map((reference) => Object.freeze({ ...reference }))),
      artifactRefs: Object.freeze(trace.artifactRefs.map((reference) => Object.freeze({ ...reference }))),
    }),
  });
}

function normalizedHypothesisKey(scope: string, hypothesis: string, sourceAdjustmentId?: string): string {
  return sha256(
    canonicalJson({
      scope: scope.trim().toLocaleLowerCase(),
      hypothesis: hypothesis.trim().toLocaleLowerCase().replaceAll(/\s+/gu, " "),
      ...(sourceAdjustmentId === undefined ? {} : { sourceAdjustmentId }),
    }),
  );
}

function experimentIdForHypothesis(dedupeKey: string): string {
  return `experiment_${sha256(`learning-hypothesis:${dedupeKey}`).slice(0, 32)}`;
}

function followUpExperimentId(input: {
  readonly dedupeKey: string;
  readonly predecessorExperimentId: string;
}): string {
  return `experiment_${sha256(
    canonicalJson({
      kind: "learning-follow-up",
      dedupeKey: input.dedupeKey,
      predecessorExperimentId: input.predecessorExperimentId,
    }),
  ).slice(0, 32)}`;
}

function normalizedCapabilityScope(scope: string): string {
  return scope.trim().toLocaleLowerCase().replaceAll(/\s+/gu, " ");
}

function learnedCapabilityId(input: {
  readonly name: string;
  readonly scope: string;
  readonly intent: string;
}): string {
  const slug =
    input.name
      .trim()
      .toLocaleLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-+|-+$/gu, "")
      .slice(0, 48) || "capability";
  return `learned-${slug}-${sha256(
    canonicalJson({
      name: input.name.trim(),
      scope: normalizedCapabilityScope(input.scope),
      intent: input.intent.trim(),
    }),
  ).slice(0, 12)}`;
}

function capabilityFromReflection(
  current: Capability,
  reflection: Extract<ReflectorOutput, { readonly decision: "experiment" }>,
): Capability {
  if (normalizedCapabilityScope(reflection.scope) === normalizedCapabilityScope(current.scope)) {
    return Object.freeze({ ...current });
  }
  const authored = Object.freeze({
    name: reflection.capabilityName.trim(),
    scope: reflection.scope.trim(),
    intent: reflection.capabilityIntent.trim(),
  });
  return Object.freeze({
    capabilityId: learnedCapabilityId(authored),
    ...authored,
  });
}

function safeComponentPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    normalized.length === 0 ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Candidate component path is not a safe relative path: ${path}`);
  }
  return normalized;
}

function freezeBrief(brief: ExperimentBrief): ExperimentBrief {
  return Object.freeze({
    ...brief,
    staleOrContradictionConditions: Object.freeze([...brief.staleOrContradictionConditions]),
    capability: Object.freeze({ ...brief.capability }),
    baselineRevision: Object.freeze({ ...brief.baselineRevision }),
    evidenceRefs: cloneEvidenceRefs(brief.evidenceRefs),
    feedbackSignalIds: Object.freeze([...brief.feedbackSignalIds]),
    citations: Object.freeze(brief.citations.map((citation) => cloneCitation(citation))),
    recurrenceCitations: Object.freeze(brief.recurrenceCitations.map((citation) => cloneCitation(citation))),
    sourceCases: Object.freeze(
      brief.sourceCases.map((sourceCase) =>
        Object.freeze({
          ...sourceCase,
          evidenceRefs: cloneEvidenceRefs(sourceCase.evidenceRefs),
          citations: Object.freeze(sourceCase.citations.map((citation) => cloneCitation(citation))),
        }),
      ),
    ),
  });
}

function sourceCasesFrom(input: {
  readonly experimentId: string;
  readonly scope: string;
  readonly cases: readonly {
    readonly title: string;
    readonly input: string;
    readonly expectedBehavior: string;
  }[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly citations: readonly LearningCitation[];
}): readonly LearningSourceCase[] {
  return Object.freeze(
    input.cases.map((item, index) =>
      Object.freeze({
        caseId: `${input.experimentId}:source:${index + 1}`,
        title: item.title,
        scope: input.scope,
        input: item.input,
        expectedBehavior: item.expectedBehavior,
        evidenceRefs: cloneEvidenceRefs(input.evidenceRefs),
        citations: Object.freeze(input.citations.map((citation) => cloneCitation(citation))),
      }),
    ),
  );
}

function mergeBriefObservation(
  existing: ExperimentBrief,
  harvest: SignalHarvestResult,
  selectedRecurrence: readonly LearningCitation[],
): ExperimentBrief {
  const citations = uniqueCitations([...existing.citations, ...harvest.citations]);
  const recurrence = uniqueCitations([...existing.recurrenceCitations, ...selectedRecurrence]);
  const evidenceRefs = uniqueEvidenceRefs([...existing.evidenceRefs, ...harvest.evidenceRefs]);
  return freezeBrief({
    ...existing,
    evidenceRefs,
    feedbackSignalIds: Object.freeze([
      ...new Set([...existing.feedbackSignalIds, ...harvest.signals.map(({ signal }) => signal.signalId)]),
    ]),
    citations,
    recurrenceCitations: recurrence,
    sourceCases: Object.freeze(
      existing.sourceCases.map((sourceCase) =>
        Object.freeze({
          ...sourceCase,
          evidenceRefs,
          citations,
        }),
      ),
    ),
    recurrenceCount: recurrence.length,
  });
}

interface WorkingAdjustmentEvidenceCandidate {
  readonly kind: "current_turn" | "served_turn";
  readonly adjustmentId: string | null;
  readonly planId?: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly outcomeId?: string;
  readonly outcome: LearningTurnInput["outcome"];
  readonly summary?: string;
  readonly settledAt: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

const WORKING_ADJUSTMENT_CONTEXT_MAX_CHARACTERS = 11_999;
const WORKING_ADJUSTMENT_PROMPT_IDENTITY_LIMIT = 256;
interface WorkingAdjustmentPromptStringLimits {
  readonly projectId: number;
  readonly projectRoot: number;
  readonly observation: number;
  readonly strategy: number;
  readonly successSignal: number;
  readonly createdFromTurnId: number;
  readonly evidenceTurnId: number;
  readonly evidenceSummary: number;
  readonly evidenceSettledAt: number;
}

const WORKING_ADJUSTMENT_PROMPT_STRING_LIMITS: WorkingAdjustmentPromptStringLimits = Object.freeze({
  projectId: 256,
  projectRoot: 512,
  observation: 1_024,
  strategy: 3_072,
  successSignal: 768,
  createdFromTurnId: 128,
  evidenceTurnId: 128,
  evidenceSummary: 256,
  evidenceSettledAt: 64,
});

const COMPACT_WORKING_ADJUSTMENT_PROMPT_STRING_LIMITS: WorkingAdjustmentPromptStringLimits = Object.freeze({
  projectId: 17,
  projectRoot: 17,
  observation: 17,
  strategy: 17,
  successSignal: 17,
  createdFromTurnId: 17,
  evidenceTurnId: 17,
  evidenceSummary: 17,
  evidenceSettledAt: 17,
});

function jsonStringContentLength(value: string): number {
  return JSON.stringify(value).length - 2;
}

function boundedPromptString(value: string, maxEscapedCharacters: number): string {
  if (jsonStringContentLength(value) <= maxEscapedCharacters) return value;
  const digest = sha256(value).slice(0, 16);
  const suffix = `…${digest}`;
  const suffixLength = jsonStringContentLength(suffix);
  if (suffixLength > maxEscapedCharacters) return digest.slice(0, maxEscapedCharacters);

  let prefix = "";
  let prefixLength = 0;
  const availablePrefixCharacters = maxEscapedCharacters - suffixLength;
  // Iterating strings yields complete Unicode code points, so the prompt boundary can never split
  // a valid UTF-16 surrogate pair while accounting for JSON escape expansion.
  for (const character of value) {
    const characterLength = jsonStringContentLength(character);
    if (prefixLength + characterLength > availablePrefixCharacters) break;
    prefix += character;
    prefixLength += characterLength;
  }
  return `${prefix}${suffix}`;
}

function workingAdjustmentPromptIdentity(adjustmentId: string | null | undefined): string | null {
  if (adjustmentId === null || adjustmentId === undefined) return null;
  return boundedPromptString(adjustmentId, WORKING_ADJUSTMENT_PROMPT_IDENTITY_LIMIT);
}

function serializeWorkingAdjustmentContext(input: {
  readonly turn: LearningTurnInput;
  readonly activeAdjustment?: WorkingAdjustment;
  readonly evidence: readonly WorkingAdjustmentEvidenceCandidate[];
}): Readonly<{ content: string; expectedActiveAdjustmentId: string | null }> {
  const expectedActiveAdjustmentId = workingAdjustmentPromptIdentity(input.turn.expectedActiveAdjustmentId);
  const projectContext = (
    limits: WorkingAdjustmentPromptStringLimits,
    includeEvidenceSummaries: boolean,
  ) => ({
    project:
      input.turn.project === undefined
        ? null
        : {
            projectId: boundedPromptString(input.turn.project.projectId, limits.projectId),
            root: boundedPromptString(input.turn.project.root, limits.projectRoot),
          },
    expectedActiveAdjustmentId,
    activeAdjustment:
      input.activeAdjustment === undefined
        ? null
        : {
            observation: boundedPromptString(input.activeAdjustment.observation, limits.observation),
            strategy: boundedPromptString(input.activeAdjustment.strategy, limits.strategy),
            successSignal: boundedPromptString(input.activeAdjustment.successSignal, limits.successSignal),
            createdFromTurnId: boundedPromptString(
              input.activeAdjustment.createdFromTurnId,
              limits.createdFromTurnId,
            ),
          },
    evidence: input.evidence.map((candidate, citationIndex) => ({
      citationIndex,
      kind: candidate.kind,
      turnId: boundedPromptString(candidate.turnId, limits.evidenceTurnId),
      outcome: candidate.outcome,
      ...(candidate.summary === undefined || !includeEvidenceSummaries
        ? {}
        : {
            summary: boundedPromptString(candidate.summary, limits.evidenceSummary),
          }),
      settledAt: boundedPromptString(candidate.settledAt, limits.evidenceSettledAt),
    })),
  });

  const content = JSON.stringify(projectContext(WORKING_ADJUSTMENT_PROMPT_STRING_LIMITS, true));
  if (content.length <= WORKING_ADJUSTMENT_CONTEXT_MAX_CHARACTERS)
    return Object.freeze({ content, expectedActiveAdjustmentId });

  // This compact projection preserves the ordered citation index mapping and digest identity while
  // ensuring future structural growth cannot turn prompt shaping into a failed reflection job.
  const compactContent = JSON.stringify(
    projectContext(COMPACT_WORKING_ADJUSTMENT_PROMPT_STRING_LIMITS, false),
  );
  if (compactContent.length <= WORKING_ADJUSTMENT_CONTEXT_MAX_CHARACTERS)
    return Object.freeze({ content: compactContent, expectedActiveAdjustmentId });

  // Parsed learning turns contain at most one current and eight served evidence candidates. This
  // final projection is therefore structurally bounded while retaining the exact private citation
  // indexes and the same expected-adjustment token used by decision validation.
  return Object.freeze({
    content: JSON.stringify({
      project: null,
      expectedActiveAdjustmentId,
      activeAdjustment: null,
      evidence: input.evidence.map((_, citationIndex) => ({ citationIndex })),
    }),
    expectedActiveAdjustmentId,
  });
}

function workingAdjustmentEvidence(turn: LearningTurnInput): readonly WorkingAdjustmentEvidenceCandidate[] {
  const current: WorkingAdjustmentEvidenceCandidate = Object.freeze({
    kind: "current_turn",
    adjustmentId: turn.expectedActiveAdjustmentId ?? null,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    ...(turn.outcomeId === undefined ? {} : { outcomeId: turn.outcomeId }),
    outcome: turn.outcome,
    settledAt: turn.occurredAt,
    evidenceRefs: cloneEvidenceRefs(turn.evidenceRefs),
  });
  return Object.freeze([
    current,
    ...turn.servedWorkingAdjustmentOutcomes.map((served) =>
      Object.freeze({
        kind: "served_turn" as const,
        adjustmentId: served.adjustmentId,
        planId: served.planId,
        sessionId: served.sessionId,
        turnId: served.turnId,
        outcomeId: served.outcomeId,
        outcome: served.outcome,
        summary: served.summary,
        settledAt: served.settledAt,
        evidenceRefs: cloneEvidenceRefs(served.evidenceRefs),
      }),
    ),
  ]);
}

function citedWorkingAdjustmentEvidence(
  indexes: readonly number[],
  candidates: readonly WorkingAdjustmentEvidenceCandidate[],
): readonly EvidenceRef[] {
  const selected = [...new Set(indexes)].map((index) => {
    const candidate = candidates[index];
    if (!candidate) throw new Error(`Working-adjustment evidence citation ${index} is out of bounds`);
    return candidate;
  });
  return Object.freeze(
    uniqueEvidenceRefs(
      selected.flatMap((candidate) => [
        ...(candidate.adjustmentId === null
          ? []
          : [
              Object.freeze({
                kind: "database_row" as const,
                table: "working_adjustments" as const,
                rowId: candidate.adjustmentId,
              }),
            ]),
        ...candidate.evidenceRefs,
      ]),
    ).slice(0, WORKING_ADJUSTMENT_LIMITS.evidenceRefs),
  );
}

export function createAutomaticLearningOrgan(options: AutomaticLearningOrganOptions): AutomaticLearningOrgan {
  const config = AutomaticLearningConfigSchema.parse(options.config);
  validateRoleConfiguration("reflector", config.roles.reflector);
  validateRoleConfiguration("revisionAuthor", config.roles.revisionAuthor);
  validateRoleConfiguration("revisionAgent", config.roles.revisionAgent);
  const nextId = options.nextId ?? createId;
  const hypothesisOperations = new Map<string, Promise<void>>();

  const serializeHypothesis = async <Value>(key: string, operation: () => Promise<Value>): Promise<Value> => {
    const predecessor = hypothesisOperations.get(key) ?? Promise.resolve();
    const running = predecessor.catch(() => undefined).then(operation);
    const marker = running.then(
      () => undefined,
      () => undefined,
    );
    hypothesisOperations.set(key, marker);
    try {
      return await running;
    } finally {
      if (hypothesisOperations.get(key) === marker) hypothesisOperations.delete(key);
    }
  };

  const harvestTurn = async (value: unknown): Promise<SignalHarvestResult> => {
    const turn = LearningTurnInputSchema.parse(value);
    const kind = signalKind(turn);
    if (!config.enabled || turn.sensitivity === "secret") {
      return Object.freeze({
        turn,
        signals: Object.freeze([]),
        evidenceRefs: cloneEvidenceRefs(turn.evidenceRefs),
        citations: Object.freeze([]),
        recurrenceCount: 0,
      });
    }

    const query = (turn.correction ?? turn.userMessage).trim();
    const searched = await options.history.search({
      query,
      limit: config.retrieval.maxResults,
      lexicalLimit: config.retrieval.lexicalLimit,
      semanticLimit: config.retrieval.semanticLimit,
      maxExcerptChars: config.retrieval.maxExcerptChars,
      privacy: "normal",
    });
    const resolved = await options.history.resolve(
      searched.hits.slice(0, config.retrieval.maxResults).map((hit) => hit.citation),
    );
    const citations = distinctHistoricalCitations(turn, resolved);
    const historicalEvidence = citations.flatMap((citation) => {
      const reference = toEvidenceRef(citation);
      return reference ? [reference] : [];
    });
    const evidenceRefs = uniqueEvidenceRefs([...turn.evidenceRefs, ...historicalEvidence]);
    if (kind === undefined)
      return Object.freeze({
        turn,
        signals: Object.freeze([]),
        evidenceRefs,
        citations,
        recurrenceCount: 0,
      });
    const signal: FeedbackSignal = Object.freeze({
      signalId: stableSignalId(turn, kind),
      kind,
      scope: turn.scope,
      // The feedback signal cites the observation that created it. Retrieved history belongs to
      // the reflection brief and must not make a retry mutate the signal's immutable identity.
      evidenceRefs: cloneEvidenceRefs(turn.evidenceRefs),
      strength: signalStrength(kind),
      // Novelty is deliberately left neutral here. Semantic recurrence is selected by the LLM
      // reflector from exact citations instead of inferred from raw search hit count.
      novelty: 0.5,
      sensitivity: turn.sensitivity,
    });
    const rowRef = await options.feedbackSignals.recordFeedbackSignal(signal);
    return Object.freeze({
      turn,
      signals: Object.freeze([Object.freeze({ signal, rowRef })]),
      evidenceRefs,
      citations,
      recurrenceCount: 0,
    });
  };

  const observeTurn = async (request: ObserveLearningTurnRequest): Promise<ObserveLearningResult> => {
    const harvest = await harvestTurn(request.turn);
    if (!config.enabled) {
      return Object.freeze({
        status: "no_change",
        reason: "disabled",
        harvest,
        observation: null,
        notification: null,
        interruption: null,
      });
    }
    if (harvest.turn.sensitivity === "secret") {
      return Object.freeze({
        status: "no_change",
        reason: "sensitive",
        harvest,
        observation: null,
        notification: null,
        interruption: null,
      });
    }
    const expectedAdjustmentId = harvest.turn.expectedActiveAdjustmentId;
    if (
      expectedAdjustmentId !== undefined &&
      expectedAdjustmentId !== null &&
      request.activeWorkingAdjustment?.adjustmentId !== expectedAdjustmentId
    ) {
      throw new Error(`Pinned working adjustment ${expectedAdjustmentId} could not be rehydrated exactly`);
    }
    if (
      request.activeWorkingAdjustment &&
      (expectedAdjustmentId !== request.activeWorkingAdjustment.adjustmentId ||
        harvest.turn.project?.projectId !== request.activeWorkingAdjustment.scope.projectId ||
        harvest.turn.project.root !== request.activeWorkingAdjustment.scope.root)
    ) {
      throw new Error("Working adjustment does not match the pinned project turn context");
    }
    if (
      harvest.turn.servedWorkingAdjustmentOutcomes.some(
        (served) => served.adjustmentId !== expectedAdjustmentId,
      )
    ) {
      throw new Error("Served working-adjustment evidence does not match the pinned adjustment");
    }
    const adjustmentEvidence = workingAdjustmentEvidence(harvest.turn);
    const workingAdjustmentContext = serializeWorkingAdjustmentContext({
      turn: harvest.turn,
      ...(request.activeWorkingAdjustment === undefined
        ? {}
        : { activeAdjustment: request.activeWorkingAdjustment }),
      evidence: adjustmentEvidence,
    });
    const promptExpectedAdjustmentId = workingAdjustmentContext.expectedActiveAdjustmentId;
    const runId = nextId("reflect");
    const messages: readonly AgentMessage[] = [
      {
        role: "user",
        name: "current_turn",
        content: JSON.stringify(harvest.turn),
      },
      {
        role: "user",
        name: "signals",
        content: JSON.stringify(harvest.signals.map(({ signal }) => signal)),
      },
      {
        role: "user",
        name: "evidence",
        content: JSON.stringify(harvest.citations),
      },
      {
        role: "user",
        name: "active_capabilities",
        content: JSON.stringify({
          baselineRevision: request.baselineRevision,
          capabilities: request.activeCapabilities ?? [request.capability],
        }),
      },
      {
        role: "user",
        name: "user_preferences",
        content: JSON.stringify(request.userPreferences ?? []),
      },
      {
        role: "user",
        name: "working_adjustment_context",
        content: workingAdjustmentContext.content,
      },
    ];
    const reflected = await options.inference.run(
      roleRequest({
        runId,
        role: "reflector",
        configuration: config.roles.reflector,
        messages,
        evidenceRefs: harvest.evidenceRefs,
        ...(request.signal ? { signal: request.signal } : {}),
      }),
      ReflectorOutputSchema,
    );
    const reflectionRun = researchRun(runId, "reflector", config.roles.reflector, reflected.trace);
    const observation = Object.freeze({ ...reflected.value.observation });
    const semanticKind =
      observation.kind === "correction"
        ? ("explicit_correction" as const)
        : observation.kind === "preference"
          ? ("preference_expression" as const)
          : undefined;
    const classifiedHarvest =
      semanticKind === undefined
        ? harvest
        : await (async (): Promise<SignalHarvestResult> => {
            const signal: FeedbackSignal = Object.freeze({
              signalId: stableSignalId(harvest.turn, semanticKind),
              kind: semanticKind,
              scope: harvest.turn.scope,
              evidenceRefs: cloneEvidenceRefs(harvest.turn.evidenceRefs),
              strength: semanticKind === "explicit_correction" ? 0.95 : 0.8,
              novelty: 0.5,
              sensitivity: harvest.turn.sensitivity,
            });
            const rowRef = await options.feedbackSignals.recordFeedbackSignal(signal);
            return Object.freeze({
              ...harvest,
              signals: Object.freeze([...harvest.signals, Object.freeze({ signal, rowRef })]),
            });
          })();
    if (reflected.value.decision === "no_change") {
      return Object.freeze({
        status: "no_change",
        reason: "reflector_no_change",
        harvest: classifiedHarvest,
        reflectionRun,
        observation,
        notification: null,
        interruption: null,
      });
    }

    if (
      reflected.value.decision === "apply_working_adjustment" ||
      reflected.value.decision === "unapply_working_adjustment"
    ) {
      const project = harvest.turn.project;
      if (!project || expectedAdjustmentId === undefined)
        throw new Error("Legacy reflection jobs cannot change project working adjustments");
      if (reflected.value.expectedActiveAdjustmentId !== promptExpectedAdjustmentId)
        throw new Error("Reflector working-adjustment decision changed the expected active identity");
      const evidenceRefs = citedWorkingAdjustmentEvidence(
        reflected.value.evidenceCitationIndexes,
        adjustmentEvidence,
      );
      if (reflected.value.decision === "apply_working_adjustment")
        return Object.freeze({
          status: "apply_working_adjustment" as const,
          harvest: classifiedHarvest,
          project: Object.freeze({ ...project }),
          expectedActiveAdjustmentId: expectedAdjustmentId,
          rationale: reflected.value.rationale,
          strategy: reflected.value.strategy,
          successSignal: reflected.value.successSignal,
          evidenceRefs,
          reflectionRun,
          observation,
          notification:
            config.notifications === "off"
              ? null
              : Object.freeze({
                  mode: config.notifications,
                  kind: "working_adjustment" as const,
                  message: `Adjusted this project: ${reflected.value.rationale}`,
                }),
          interruption: null,
        });
      if (expectedAdjustmentId === null)
        throw new Error("Reflector cannot unapply a project with no pinned working adjustment");
      return Object.freeze({
        status: "unapply_working_adjustment" as const,
        harvest: classifiedHarvest,
        project: Object.freeze({ ...project }),
        expectedActiveAdjustmentId: expectedAdjustmentId,
        reason: reflected.value.reason,
        evidenceRefs,
        reflectionRun,
        observation,
        notification:
          config.notifications === "off"
            ? null
            : Object.freeze({
                mode: config.notifications,
                kind: "working_adjustment" as const,
                message: `Unapplied this project: ${reflected.value.reason}`,
              }),
        interruption: null,
      });
    }

    const reflection = reflected.value;
    const selectedRecurrence = recurrenceCitations(reflection, classifiedHarvest.citations);
    const selectedAdjustmentEvidence = citedWorkingAdjustmentEvidence(
      reflection.workingAdjustmentEvidenceCitationIndexes,
      adjustmentEvidence,
    );
    if (
      reflection.workingAdjustmentEvidenceCitationIndexes.length > 0 &&
      request.activeWorkingAdjustment === undefined
    )
      throw new Error("Reflector linked an experiment to a missing working adjustment");
    const sourceAdjustmentId =
      reflection.workingAdjustmentEvidenceCitationIndexes.length === 0
        ? undefined
        : request.activeWorkingAdjustment?.adjustmentId;
    const scopeRunId = nextId("scope_verify");
    const verifiedScope = await options.inference.run(
      roleRequest({
        runId: scopeRunId,
        role: "reflector",
        configuration: config.roles.reflector,
        messages: Object.freeze([
          Object.freeze({
            role: "user",
            name: "evidence",
            content: JSON.stringify({
              currentScope: request.capability.scope,
              proposedScope: reflection.scope,
              scopeRationale: reflection.scopeRationale,
            }),
          }),
        ]),
        evidenceRefs: Object.freeze([]),
        ...(request.signal ? { signal: request.signal } : {}),
      }),
      ScopeRelationshipVerificationSchema,
    );
    const scopeVerificationRun = researchRun(
      scopeRunId,
      "reflector",
      config.roles.reflector,
      verifiedScope.trace,
    );
    validateScopeContract({
      currentScope: request.capability.scope,
      reflection,
      verification: verifiedScope.value,
    });
    const dedupeKey = normalizedHypothesisKey(reflection.scope, reflection.hypothesis, sourceAdjustmentId);
    const capability = capabilityFromReflection(request.capability, reflection);
    const makeBrief = (
      experimentId: string,
      evidenceRefs: readonly EvidenceRef[] = classifiedHarvest.evidenceRefs,
    ): ExperimentBrief => {
      const mergedEvidenceRefs = uniqueEvidenceRefs([...selectedAdjustmentEvidence, ...evidenceRefs]);
      return freezeBrief({
        experimentId,
        title: reflection.title,
        hypothesis: reflection.hypothesis,
        hypothesisDedupeKey: dedupeKey,
        scope: reflection.scope,
        anticipatedFutureUse: reflection.anticipatedFutureUse,
        scopeRelationship: reflection.scopeRelationship,
        scopeRationale: reflection.scopeRationale,
        staleOrContradictionConditions: reflection.staleOrContradictionConditions,
        verifiedScopeRelationship: verifiedScope.value.relationship,
        scopeVerificationReason: verifiedScope.value.reason,
        scopeVerificationRun,
        capability,
        baselineRevision: request.baselineRevision,
        evidenceRefs: mergedEvidenceRefs,
        feedbackSignalIds: classifiedHarvest.signals.map(({ signal }) => signal.signalId),
        citations: classifiedHarvest.citations,
        recurrenceCitations: selectedRecurrence,
        sourceCases: sourceCasesFrom({
          experimentId,
          scope: reflection.scope,
          cases: reflection.sourceCases,
          evidenceRefs: mergedEvidenceRefs,
          citations: classifiedHarvest.citations,
        }),
        recurrenceCount: selectedRecurrence.length,
        reflectionRun,
        ...(sourceAdjustmentId === undefined ? {} : { sourceAdjustmentId }),
      });
    };

    const reconcileObservation = async (
      current: ExperimentBrief,
      attemptsRemaining = MAX_BRIEF_RECONCILIATION_ATTEMPTS,
    ): Promise<Readonly<{ status: "experiment" | "deduped"; brief: ExperimentBrief }>> => {
      const experiment = await options.experiments.getExperiment(current.experimentId);
      let status: "experiment" | "deduped";
      let proposed: ExperimentBrief;
      if (experiment?.status === "completed") {
        const experimentId = followUpExperimentId({
          dedupeKey,
          predecessorExperimentId: experiment.experimentId,
        });
        const predecessorRef: EvidenceRef = Object.freeze({
          kind: "database_row",
          table: "experiments",
          rowId: experiment.experimentId,
        });
        proposed = makeBrief(
          experimentId,
          uniqueEvidenceRefs([predecessorRef, ...classifiedHarvest.evidenceRefs]),
        );
        await persistHypothesisExperiment(proposed);
        status = "experiment";
      } else {
        await attachHarvestToExperiment(current, classifiedHarvest);
        proposed = mergeBriefObservation(current, classifiedHarvest, selectedRecurrence);
        status = "deduped";
      }
      if (canonicalJson(current) === canonicalJson(proposed)) {
        return Object.freeze({ status, brief: current });
      }
      try {
        return Object.freeze({
          status,
          brief: await options.briefs.replace({
            expectedExperimentId: current.experimentId,
            brief: proposed,
          }),
        });
      } catch (error) {
        if (!isExperimentBriefPublicationCollision(error) || attemptsRemaining <= 1) throw error;
        const winner = await options.briefs.findByDedupeKey(dedupeKey);
        if (!winner) throw error;
        return await reconcileObservation(winner, attemptsRemaining - 1);
      }
    };

    const observed = await serializeHypothesis(dedupeKey, async () => {
      const existing = await options.briefs.findByDedupeKey(dedupeKey);
      if (!existing) {
        validateBroadeningEvidence({
          verifiedRelationship: verifiedScope.value.relationship,
          recurrenceCitations: selectedRecurrence,
          recurrenceThreshold: config.retrieval.recurrenceThreshold,
        });
        const brief = makeBrief(experimentIdForHypothesis(dedupeKey));
        await persistHypothesisExperiment(brief);
        try {
          return Object.freeze({ status: "experiment" as const, brief: await options.briefs.put(brief) });
        } catch (error) {
          if (!isExperimentBriefPublicationCollision(error)) throw error;
          const winner = await options.briefs.findByDedupeKey(dedupeKey);
          if (!winner) throw error;
          return await reconcileObservation(winner);
        }
      }

      validateBroadeningEvidence({
        verifiedRelationship: verifiedScope.value.relationship,
        recurrenceCitations: uniqueCitations([...existing.recurrenceCitations, ...selectedRecurrence]),
        recurrenceThreshold: config.retrieval.recurrenceThreshold,
      });
      return await reconcileObservation(existing);
    });

    if (observed.status === "deduped") {
      return Object.freeze({
        status: "deduped",
        harvest: Object.freeze({ ...classifiedHarvest, recurrenceCount: selectedRecurrence.length }),
        brief: observed.brief,
        reflectionRun,
        observation,
        notification: null,
        interruption: null,
      });
    }
    return Object.freeze({
      status: "experiment",
      harvest: Object.freeze({ ...classifiedHarvest, recurrenceCount: selectedRecurrence.length }),
      brief: observed.brief,
      reflectionRun,
      observation,
      notification:
        config.notifications === "off"
          ? null
          : Object.freeze({
              mode: config.notifications,
              kind: "experiment",
              message: `Learning experiment ready: ${observed.brief.title}`,
            }),
      interruption: null,
    });
  };

  async function persistHypothesisExperiment(brief: ExperimentBrief): Promise<Experiment> {
    const experiment: Experiment = Object.freeze({
      experimentId: brief.experimentId,
      hypothesis: brief.hypothesis,
      scope: brief.scope,
      evidenceRefs: cloneEvidenceRefs(brief.evidenceRefs),
      baselineRevision: Object.freeze({ ...brief.baselineRevision }),
      candidateRevisions: Object.freeze([]),
      feedbackSignalIds: Object.freeze([...brief.feedbackSignalIds]),
      status: "hypothesis",
      ...(brief.sourceAdjustmentId === undefined ? {} : { sourceAdjustmentId: brief.sourceAdjustmentId }),
    });
    const existing = await options.experiments.getExperiment(brief.experimentId);
    if (existing) {
      if (
        existing.hypothesis !== experiment.hypothesis ||
        existing.scope !== experiment.scope ||
        existing.sourceAdjustmentId !== experiment.sourceAdjustmentId ||
        !sameCapabilityRevisionRef(existing.baselineRevision, experiment.baselineRevision)
      )
        throw new Error(`Hypothesis experiment ${brief.experimentId} conflicts with its durable identity`);
      if (existing.status !== "hypothesis") return existing;
      const merged = Object.freeze({
        ...existing,
        evidenceRefs: uniqueEvidenceRefs([...existing.evidenceRefs, ...experiment.evidenceRefs]),
        feedbackSignalIds: Object.freeze([
          ...new Set([...existing.feedbackSignalIds, ...experiment.feedbackSignalIds]),
        ]),
      });
      await options.experiments.putExperiment(merged);
      return merged;
    }
    await options.experiments.putExperiment(experiment);
    return experiment;
  }

  async function attachHarvestToExperiment(
    brief: ExperimentBrief,
    harvest: SignalHarvestResult,
  ): Promise<Experiment> {
    const existing = await persistHypothesisExperiment(brief);
    if (existing.status === "completed") return existing;
    const feedbackSignalIds = Object.freeze([
      ...new Set([...existing.feedbackSignalIds, ...harvest.signals.map(({ signal }) => signal.signalId)]),
    ]);
    const evidenceRefs = uniqueEvidenceRefs([...existing.evidenceRefs, ...harvest.evidenceRefs]);
    if (
      canonicalJson(feedbackSignalIds) === canonicalJson(existing.feedbackSignalIds) &&
      canonicalJson(evidenceRefs) === canonicalJson(existing.evidenceRefs)
    )
      return existing;
    const updated = Object.freeze({ ...existing, feedbackSignalIds, evidenceRefs });
    await options.experiments.putExperiment(updated);
    return updated;
  }

  const recordCandidateFile = async (input: {
    readonly capabilityId: string;
    readonly capabilityRevisionId: string;
    readonly area: "prompts" | "skills" | "tools" | "router" | "evals" | "dependencies";
    readonly path: string;
    readonly content: string;
    readonly evidenceRefs: readonly EvidenceRef[];
    readonly predecessorRevisionId?: string;
  }): Promise<FileRevisionRef> =>
    await options.candidateDefinitions.recordCandidateDefinition({
      workingPath: `${input.capabilityId}/${input.capabilityRevisionId}/${input.area}/${safeComponentPath(input.path)}`,
      bytes: new TextEncoder().encode(input.content),
      actor: { actorId: "automatic-learning-organ", kind: "noesis" },
      reason: `Capability revision ${input.capabilityRevisionId} authors ${input.area}`,
      provenanceRefs: input.evidenceRefs,
      ...(input.predecessorRevisionId ? { predecessorRevisionId: input.predecessorRevisionId } : {}),
    });

  const materializeList = async (input: {
    readonly capabilityId: string;
    readonly capabilityRevisionId: string;
    readonly area: "prompts" | "skills" | "tools" | "evals";
    readonly files: RevisionAuthorOutput["promptModules"];
    readonly evidenceRefs: readonly EvidenceRef[];
    readonly predecessors: readonly FileRevisionRef[];
  }): Promise<readonly FileRevisionRef[]> => {
    const paths = new Set<string>();
    return await Promise.all(
      input.files.map(async (file, index) => {
        const path = safeComponentPath(file.path);
        if (paths.has(path)) throw new Error(`Duplicate candidate ${input.area} path ${path}`);
        paths.add(path);
        const predecessor = input.predecessors[index];
        return await recordCandidateFile({
          ...input,
          path,
          content: file.content,
          ...(predecessor ? { predecessorRevisionId: predecessor.revisionId } : {}),
        });
      }),
    );
  };

  const persistCandidateExperiment = async (
    brief: ExperimentBrief,
    revision: CapabilityRevision,
    revisionRef: CapabilityRevisionRef,
  ): Promise<Experiment> => {
    const manifestRevision = await options.candidateManifests?.persist({ brief, revision, revisionRef });
    const current = await options.experiments.getExperiment(brief.experimentId);
    const experiment: Experiment = Object.freeze({
      experimentId: brief.experimentId,
      hypothesis: brief.hypothesis,
      scope: brief.scope,
      evidenceRefs: uniqueEvidenceRefs([
        ...(current?.evidenceRefs ?? []),
        ...brief.evidenceRefs,
        ...(manifestRevision ? [manifestRevision] : []),
      ]),
      baselineRevision: Object.freeze({ ...brief.baselineRevision }),
      candidateRevisions: Object.freeze([Object.freeze({ ...revisionRef })]),
      feedbackSignalIds: Object.freeze([
        ...new Set([...(current?.feedbackSignalIds ?? []), ...brief.feedbackSignalIds]),
      ]),
      status: "authoring",
      ...(brief.sourceAdjustmentId === undefined ? {} : { sourceAdjustmentId: brief.sourceAdjustmentId }),
    });
    await options.experiments.putExperiment(experiment);
    return experiment;
  };

  const authorBundle = async (input: {
    readonly brief: ExperimentBrief;
    readonly predecessorRevision: CapabilityRevisionRef;
    readonly role: "revision_author" | "revision_agent";
    readonly configuration: LearningRoleConfiguration;
    readonly messages: readonly AgentMessage[];
    readonly signal?: AbortSignal;
  }): Promise<AuthorRevisionResult> => {
    const predecessor = options.capabilities.getRevision(input.predecessorRevision);
    if (!predecessor) throw new Error("Capability revision predecessor is unknown or digest-mismatched");
    const revisesExistingCapability =
      input.predecessorRevision.capabilityId === input.brief.capability.capabilityId;
    options.capabilities.registerCapability(input.brief.capability);
    const runId = nextId(input.role === "revision_author" ? "author" : "revise");
    const inferred = await options.inference.run(
      roleRequest({
        runId,
        role: input.role,
        configuration: input.configuration,
        messages: input.messages,
        evidenceRefs: input.brief.evidenceRefs,
        ...(input.signal ? { signal: input.signal } : {}),
      }),
      RevisionAuthorInferenceOutputSchema,
    );
    const authored = Object.freeze({
      ...inferred,
      value: normalizeRevisionAuthorOutput(inferred.value),
    });
    const authorRun = researchRun(runId, input.role, input.configuration, authored.trace);
    const capabilityRevisionId = nextId("capability_revision");
    const promptModules = await materializeList({
      capabilityId: input.brief.capability.capabilityId,
      capabilityRevisionId,
      area: "prompts",
      files: authored.value.promptModules,
      evidenceRefs: input.brief.evidenceRefs,
      predecessors: revisesExistingCapability ? predecessor.promptModules : Object.freeze([]),
    });
    const skills = await materializeList({
      capabilityId: input.brief.capability.capabilityId,
      capabilityRevisionId,
      area: "skills",
      files: authored.value.skills,
      evidenceRefs: input.brief.evidenceRefs,
      predecessors: revisesExistingCapability ? predecessor.skills : Object.freeze([]),
    });
    const tools = await materializeList({
      capabilityId: input.brief.capability.capabilityId,
      capabilityRevisionId,
      area: "tools",
      files: authored.value.tools,
      evidenceRefs: input.brief.evidenceRefs,
      predecessors: revisesExistingCapability ? predecessor.tools : Object.freeze([]),
    });
    const routerRevision = await recordCandidateFile({
      capabilityId: input.brief.capability.capabilityId,
      capabilityRevisionId,
      area: "router",
      path: authored.value.router.path,
      content: authored.value.router.content,
      evidenceRefs: input.brief.evidenceRefs,
      ...(revisesExistingCapability
        ? { predecessorRevisionId: predecessor.toolset.routerRevision.revisionId }
        : {}),
    });
    const sourceEvaluationDefinitions = await materializeList({
      capabilityId: input.brief.capability.capabilityId,
      capabilityRevisionId,
      area: "evals",
      files: authored.value.sourceEvaluationDefinitions,
      evidenceRefs: input.brief.evidenceRefs,
      predecessors: revisesExistingCapability ? predecessor.sourceEvaluationDefinitions : Object.freeze([]),
    });
    const dependencyLock = authored.value.dependencyLock
      ? await recordCandidateFile({
          capabilityId: input.brief.capability.capabilityId,
          capabilityRevisionId,
          area: "dependencies",
          path: authored.value.dependencyLock.path,
          content: authored.value.dependencyLock.content,
          evidenceRefs: input.brief.evidenceRefs,
          ...(revisesExistingCapability && predecessor.dependencyLock
            ? { predecessorRevisionId: predecessor.dependencyLock.revisionId }
            : {}),
        })
      : undefined;
    const construction: CapabilityRevisionConstruction = {
      definitionState: "candidate",
      capabilityRevisionId,
      capabilityId: input.brief.capability.capabilityId,
      ...(revisesExistingCapability ? { predecessorRevisionId: predecessor.capabilityRevisionId } : {}),
      promptModules,
      skills,
      tools,
      routerRevision,
      routerStrategyId: authored.value.router.strategyId,
      activationPolicy: authored.value.activationPolicy,
      ...(dependencyLock ? { dependencyLock } : {}),
      permissionManifest: authored.value.permissionManifest,
      evidenceRefs: input.brief.evidenceRefs,
      sourceEvaluationDefinitions,
      requestedPermissionDelta: authored.value.requestedPermissionDelta,
    };
    const revisionRef = options.capabilities.constructRevision(construction);
    const revision = options.capabilities.getRevision(revisionRef);
    if (!revision) throw new Error("AC-03 did not retain the complete authored capability revision");
    const experiment = await persistCandidateExperiment(input.brief, revision, revisionRef);
    return Object.freeze({
      brief: input.brief,
      revision,
      revisionRef,
      authorRun,
      experiment,
    });
  };

  const authorExperimentRevision = async (
    request: AuthorExperimentRevisionRequest,
  ): Promise<AuthorRevisionResult> => {
    const predecessorRevision = request.predecessorRevision ?? request.brief.baselineRevision;
    return await authorBundle({
      brief: request.brief,
      predecessorRevision,
      role: "revision_author",
      configuration: config.roles.revisionAuthor,
      ...(request.signal ? { signal: request.signal } : {}),
      messages: [
        {
          role: "user",
          name: "hypothesis",
          content: JSON.stringify({
            experimentId: request.brief.experimentId,
            hypothesis: request.brief.hypothesis,
            scope: request.brief.scope,
            anticipatedFutureUse: request.brief.anticipatedFutureUse,
            scopeRelationship: request.brief.scopeRelationship,
            scopeRationale: request.brief.scopeRationale,
            staleOrContradictionConditions: request.brief.staleOrContradictionConditions,
            verifiedScopeRelationship: request.brief.verifiedScopeRelationship,
            scopeVerificationReason: request.brief.scopeVerificationReason,
            capability: request.brief.capability,
          }),
        },
        {
          role: "user",
          name: "source_cases",
          content: JSON.stringify(request.brief.sourceCases),
        },
      ],
    });
  };

  const authorFollowUpRevision = async (
    request: AuthorFollowUpRevisionRequest,
  ): Promise<AuthorRevisionResult> => {
    if (
      request.parentExperiment.status !== "completed" ||
      request.parentExperiment.outcome !== "revise" ||
      !request.parentExperiment.followUpExperimentId
    ) {
      throw new Error("A follow-up revision requires a completed revise outcome with a linked experiment ID");
    }
    const predecessorRevision =
      request.parentExperiment.activatedRevision ?? request.parentExperiment.candidateRevisions.at(-1);
    if (!predecessorRevision) throw new Error("A revise outcome has no candidate revision lineage");
    const evidenceRefs = uniqueEvidenceRefs([
      ...request.parentExperiment.evidenceRefs,
      ...request.judgmentEvidenceRefs,
    ]);
    const citations = Object.freeze((request.citations ?? []).map(cloneCitation));
    const sourceCases = sourceCasesFrom({
      experimentId: request.parentExperiment.followUpExperimentId,
      scope: request.parentExperiment.scope,
      cases: [
        {
          title: "Observed revision failure",
          input: request.failureSummary,
          expectedBehavior: `Avoid the observed failure while preserving the prior hypothesis: ${request.parentExperiment.hypothesis}`,
        },
      ],
      evidenceRefs,
      citations,
    });
    const brief = freezeBrief({
      experimentId: request.parentExperiment.followUpExperimentId,
      title: `Revise ${request.capability.name}`,
      hypothesis: `A successor revision can address: ${request.failureSummary}`,
      hypothesisDedupeKey: normalizedHypothesisKey(request.parentExperiment.scope, request.failureSummary),
      scope: request.parentExperiment.scope,
      anticipatedFutureUse: `When revising ${request.capability.name} after this observed failure recurs.`,
      scopeRelationship: "same",
      scopeRationale: "The follow-up revises the same capability scope implicated by the evaluated failure.",
      staleOrContradictionConditions: Object.freeze([
        "The observed failure no longer reproduces against the current capability revision.",
        "The successor weakens behavior that the prior evaluation established as useful.",
      ]),
      verifiedScopeRelationship: "same",
      scopeVerificationReason: "The follow-up retains the parent experiment's capability scope.",
      capability: request.capability,
      baselineRevision: predecessorRevision,
      evidenceRefs,
      feedbackSignalIds: request.parentExperiment.feedbackSignalIds,
      citations,
      recurrenceCitations: citations,
      sourceCases,
      recurrenceCount: citations.length,
    });
    await options.briefs.put(brief);
    return await authorBundle({
      brief,
      predecessorRevision,
      role: "revision_agent",
      configuration: config.roles.revisionAgent,
      ...(request.signal ? { signal: request.signal } : {}),
      messages: [
        {
          role: "user",
          name: "failures",
          content: JSON.stringify({
            parentExperimentId: request.parentExperiment.experimentId,
            failureSummary: request.failureSummary,
            predecessorRevision,
          }),
        },
        {
          role: "user",
          name: "judgment_evidence",
          content: JSON.stringify(request.judgmentEvidenceRefs),
        },
      ],
    });
  };

  return Object.freeze({ observeTurn, authorExperimentRevision, authorFollowUpRevision });
}
