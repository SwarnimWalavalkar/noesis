import type {
  AgentMessage,
  AgentRole,
  AgentRunRequest,
  AgentTrace,
  StructuredInferencePort,
} from "@noesis/agent-types";
import type { AtomicCapabilityRegistry, CapabilityRevisionConstruction } from "@noesis/capabilities";
import type { UserCriterionReadModel, UserCriterionRepository } from "@noesis/config";
import {
  type Capability,
  type CapabilityRevision,
  type CapabilityRevisionRef,
  canonicalJson,
  createId,
  type DefinitionFilePort,
  type EvidenceRef,
  type Experiment,
  type ExperimentStorePort,
  type FeedbackSignal,
  type FeedbackSignalStorePort,
  type FileRevisionRef,
  sameCapabilityRevisionRef,
  sha256,
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
} from "./schemas.ts";

export interface CapturedConversationalFeedback {
  readonly kind: "correction" | "criterion";
  readonly statement: string;
  readonly scope: string;
  readonly confidence: number;
  readonly explicitlyNormative: boolean;
}

export interface CriterionCaptureResult {
  readonly capture: CapturedConversationalFeedback;
  readonly created: boolean;
  readonly criterion?: UserCriterionReadModel;
}

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
  readonly criterionCapture?: CriterionCaptureResult;
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
  readonly capability: Capability;
  readonly baselineRevision: CapabilityRevisionRef;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly feedbackSignalIds: readonly string[];
  readonly citations: readonly LearningCitation[];
  readonly recurrenceCitations: readonly LearningCitation[];
  readonly sourceCases: readonly LearningSourceCase[];
  readonly recurrenceCount: number;
  readonly reflectionRun?: LearningRoleResearchRun;
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
          throw new Error(`Experiment brief publication collision for ${brief.hypothesisDedupeKey}`);
        return existing;
      }
      briefs.set(brief.hypothesisDedupeKey, brief);
      return brief;
    },
    replace: async (input: { readonly expectedExperimentId: string; readonly brief: ExperimentBrief }) => {
      const { expectedExperimentId, brief } = input;
      const existing = briefs.get(brief.hypothesisDedupeKey);
      if (!existing || existing.experimentId !== expectedExperimentId)
        throw new Error(`Experiment brief replacement lost its expected identity`);
      briefs.set(brief.hypothesisDedupeKey, brief);
      return brief;
    },
  });
}

export interface LearningNotification {
  readonly mode: "quiet" | "detailed";
  readonly kind: "criterion" | "experiment";
  readonly message: string;
}

export type ObserveLearningResult =
  | {
      readonly status: "no_change";
      readonly reason: "disabled" | "irrelevant" | "sensitive" | "reflector_no_change";
      readonly harvest: SignalHarvestResult;
      readonly reflectionRun?: LearningRoleResearchRun;
      readonly notification: LearningNotification | null;
      readonly interruption: null;
    }
  | {
      readonly status: "deduped";
      readonly harvest: SignalHarvestResult;
      readonly brief: ExperimentBrief;
      readonly reflectionRun: LearningRoleResearchRun;
      readonly notification: LearningNotification | null;
      readonly interruption: null;
    }
  | {
      readonly status: "experiment";
      readonly harvest: SignalHarvestResult;
      readonly brief: ExperimentBrief;
      readonly reflectionRun: LearningRoleResearchRun;
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
  readonly criteria: Pick<UserCriterionRepository, "create" | "inspect">;
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

const NORMATIVE_PATTERN =
  /(?:^|\b)(?:always|never|must|every time|do not|don't|should always|should never)(?:\b|$)/iu;
const CORRECTION_PATTERN = /(?:^|\b)(?:no[,;:]?|instead|actually|correction|not that)(?:\b|$)/iu;
const DIRECT_LEARNING_PATTERN = /(?:^|\b)(?:learn from|remember this|improve this)(?:\b|$)/iu;

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
  if (
    citation.source.kind === "database_row" &&
    ["sessions", "messages", "tool_calls", "outcomes"].includes(citation.source.table)
  ) {
    const table = citation.source.table;
    if (table !== "sessions" && table !== "messages" && table !== "tool_calls" && table !== "outcomes")
      return undefined;
    return Object.freeze({
      kind: "database_row",
      table,
      rowId: citation.source.rowId,
    });
  }
  return undefined;
}

function cloneCitation(citation: ExactCitation): LearningCitation {
  return Object.freeze({
    ...citation,
    source: Object.freeze({ ...citation.source }),
  });
}

function captureConversationalFeedback(turn: LearningTurnInput): CapturedConversationalFeedback | undefined {
  const statement = (turn.correction ?? turn.userMessage).trim();
  const explicitlyNormative = NORMATIVE_PATTERN.test(statement);
  const correction =
    turn.outcome === "corrected" || turn.correction !== undefined || CORRECTION_PATTERN.test(statement);
  if (!explicitlyNormative && !correction) return undefined;
  return Object.freeze({
    kind: explicitlyNormative ? "criterion" : "correction",
    statement,
    scope: turn.scope,
    confidence: explicitlyNormative ? 0.99 : 0.9,
    explicitlyNormative,
  });
}

function signalKind(turn: LearningTurnInput, capture?: CapturedConversationalFeedback) {
  if (capture?.kind === "correction" || turn.outcome === "corrected") return "explicit_correction" as const;
  if (capture?.kind === "criterion") return "preference_expression" as const;
  if (turn.outcome === "failed" || turn.telemetry.toolFailureCount > 0) return "repeated_failure" as const;
  if (turn.telemetry.retryCount > 0 || turn.telemetry.aborted) return "friction" as const;
  if (
    turn.telemetry.latencyMs !== undefined &&
    turn.telemetry.expectedLatencyMs !== undefined &&
    turn.telemetry.latencyMs > turn.telemetry.expectedLatencyMs
  )
    return "cost_or_latency" as const;
  if (DIRECT_LEARNING_PATTERN.test(turn.userMessage)) return "user_request" as const;
  return undefined;
}

function signalStrength(kind: NonNullable<ReturnType<typeof signalKind>>): number {
  switch (kind) {
    case "explicit_correction":
      return 0.95;
    case "preference_expression":
      return 0.9;
    case "repeated_failure":
      return 0.8;
    case "friction":
      return 0.7;
    case "cost_or_latency":
      return 0.65;
    case "user_request":
      return 1;
  }
}

function stableSignalId(turn: LearningTurnInput, kind: NonNullable<ReturnType<typeof signalKind>>): string {
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

function currentEvidenceKeys(turn: LearningTurnInput): ReadonlySet<string> {
  return new Set(turn.evidenceRefs.map(evidenceKey));
}

function distinctHistoricalCitations(
  turn: LearningTurnInput,
  citations: readonly ExactCitation[],
): readonly LearningCitation[] {
  const current = currentEvidenceKeys(turn);
  const distinct = new Map<string, LearningCitation>();
  for (const citation of citations) {
    const reference = toEvidenceRef(citation);
    if (reference && current.has(evidenceKey(reference))) continue;
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

function citationKey(citation: LearningCitation): string {
  return canonicalJson({ source: citation.source, contentDigest: citation.contentDigest });
}

function uniqueCitations(citations: readonly LearningCitation[]): readonly LearningCitation[] {
  const unique = new Map<string, LearningCitation>();
  for (const citation of citations) unique.set(citationKey(citation), cloneCitation(citation));
  return Object.freeze([...unique.values()]);
}

function criterionIdFor(capture: CapturedConversationalFeedback): string {
  return `criterion_${sha256(canonicalJson({ scope: capture.scope, statement: capture.statement })).slice(0, 24)}`;
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

function normalizedHypothesisKey(scope: string, hypothesis: string): string {
  return sha256(
    canonicalJson({
      scope: scope.trim().toLocaleLowerCase(),
      hypothesis: hypothesis.trim().toLocaleLowerCase().replaceAll(/\s+/gu, " "),
    }),
  );
}

function experimentIdForHypothesis(dedupeKey: string): string {
  return `experiment_${sha256(`learning-hypothesis:${dedupeKey}`).slice(0, 32)}`;
}

function followUpExperimentId(input: {
  readonly dedupeKey: string;
  readonly predecessorExperimentId: string;
  readonly feedbackSignalIds: readonly string[];
}): string {
  return `experiment_${sha256(
    canonicalJson({
      kind: "learning-follow-up",
      dedupeKey: input.dedupeKey,
      predecessorExperimentId: input.predecessorExperimentId,
      feedbackSignalIds: [...input.feedbackSignalIds].sort(),
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

  const recordCriterion = async (
    turn: LearningTurnInput,
    capture: CapturedConversationalFeedback | undefined,
  ): Promise<CriterionCaptureResult | undefined> => {
    if (!capture?.explicitlyNormative) return undefined;
    const criterionId = criterionIdFor(capture);
    const created = await options.criteria.create({
      criterionId,
      source: turn.outcome === "corrected" ? "correction" : "explicit_statement",
      scope: capture.scope,
      evaluatorInstruction: capture.statement,
      evidenceRefs: turn.evidenceRefs,
      actor: { actorId: `user:${turn.sessionId}`, kind: "user" },
      reason: "Explicitly normative conversational feedback",
    });
    if (created.ok) return Object.freeze({ capture, created: true, criterion: created.value });
    if (created.error.code !== "already_exists") {
      throw new Error(`Could not capture explicit criterion: ${created.error.message}`);
    }
    const existing = await options.criteria.inspect(criterionId);
    if (!existing.ok) throw new Error(`Could not inspect deduplicated criterion: ${existing.error.message}`);
    return Object.freeze({ capture, created: false, criterion: existing.value });
  };

  const harvestTurn = async (value: unknown): Promise<SignalHarvestResult> => {
    const turn = LearningTurnInputSchema.parse(value);
    const capture = captureConversationalFeedback(turn);
    const kind = signalKind(turn, capture);
    if (!config.enabled || turn.sensitivity === "secret" || !kind) {
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
    const criterionCapture = await recordCriterion(turn, capture);
    return Object.freeze({
      turn,
      signals: Object.freeze([Object.freeze({ signal, rowRef })]),
      evidenceRefs,
      citations,
      recurrenceCount: 0,
      ...(criterionCapture ? { criterionCapture } : {}),
    });
  };

  const observeTurn = async (request: ObserveLearningTurnRequest): Promise<ObserveLearningResult> => {
    const harvest = await harvestTurn(request.turn);
    const criterionNotification = (): LearningNotification | null => {
      const capture = harvest.criterionCapture;
      if (config.notifications === "off" || !capture?.created) return null;
      return Object.freeze({
        mode: config.notifications,
        kind: "criterion",
        message: `Learned criterion for ${capture.capture.scope}: ${capture.capture.statement}`,
      });
    };
    if (!config.enabled) {
      return Object.freeze({
        status: "no_change",
        reason: "disabled",
        harvest,
        notification: null,
        interruption: null,
      });
    }
    if (harvest.turn.sensitivity === "secret") {
      return Object.freeze({
        status: "no_change",
        reason: "sensitive",
        harvest,
        notification: null,
        interruption: null,
      });
    }
    if (harvest.signals.length === 0) {
      return Object.freeze({
        status: "no_change",
        reason: "irrelevant",
        harvest,
        notification: null,
        interruption: null,
      });
    }

    const runId = nextId("reflect");
    const messages: readonly AgentMessage[] = [
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
    if (reflected.value.decision === "no_change") {
      return Object.freeze({
        status: "no_change",
        reason: "reflector_no_change",
        harvest,
        reflectionRun,
        notification: criterionNotification(),
        interruption: null,
      });
    }

    const reflection = reflected.value;
    const selectedRecurrence = recurrenceCitations(reflection, harvest.citations);
    const dedupeKey = normalizedHypothesisKey(reflection.scope, reflection.hypothesis);
    const capability = capabilityFromReflection(request.capability, reflection);
    const makeBrief = (
      experimentId: string,
      evidenceRefs: readonly EvidenceRef[] = harvest.evidenceRefs,
    ): ExperimentBrief =>
      freezeBrief({
        experimentId,
        title: reflection.title,
        hypothesis: reflection.hypothesis,
        hypothesisDedupeKey: dedupeKey,
        scope: reflection.scope,
        capability,
        baselineRevision: request.baselineRevision,
        evidenceRefs,
        feedbackSignalIds: harvest.signals.map(({ signal }) => signal.signalId),
        citations: harvest.citations,
        recurrenceCitations: selectedRecurrence,
        sourceCases: sourceCasesFrom({
          experimentId,
          scope: reflection.scope,
          cases: reflection.sourceCases,
          evidenceRefs,
          citations: harvest.citations,
        }),
        recurrenceCount: selectedRecurrence.length,
        reflectionRun,
      });

    const observed = await serializeHypothesis(dedupeKey, async () => {
      const existing = await options.briefs.findByDedupeKey(dedupeKey);
      if (!existing) {
        const brief = makeBrief(experimentIdForHypothesis(dedupeKey));
        await persistHypothesisExperiment(brief);
        return Object.freeze({ status: "experiment" as const, brief: await options.briefs.put(brief) });
      }

      const experiment = await options.experiments.getExperiment(existing.experimentId);
      if (experiment?.status === "completed") {
        const feedbackSignalIds = harvest.signals.map(({ signal }) => signal.signalId);
        const experimentId = followUpExperimentId({
          dedupeKey,
          predecessorExperimentId: experiment.experimentId,
          feedbackSignalIds,
        });
        const predecessorRef: EvidenceRef = Object.freeze({
          kind: "database_row",
          table: "experiments",
          rowId: experiment.experimentId,
        });
        const brief = makeBrief(experimentId, uniqueEvidenceRefs([predecessorRef, ...harvest.evidenceRefs]));
        await persistHypothesisExperiment(brief);
        return Object.freeze({
          status: "experiment" as const,
          brief: await options.briefs.replace({
            expectedExperimentId: existing.experimentId,
            brief,
          }),
        });
      }

      await attachHarvestToExperiment(existing, harvest);
      const merged = mergeBriefObservation(existing, harvest, selectedRecurrence);
      return Object.freeze({
        status: "deduped" as const,
        brief:
          canonicalJson(existing) === canonicalJson(merged)
            ? existing
            : await options.briefs.replace({ expectedExperimentId: existing.experimentId, brief: merged }),
      });
    });

    if (observed.status === "deduped") {
      return Object.freeze({
        status: "deduped",
        harvest: Object.freeze({ ...harvest, recurrenceCount: selectedRecurrence.length }),
        brief: observed.brief,
        reflectionRun,
        notification: criterionNotification(),
        interruption: null,
      });
    }
    return Object.freeze({
      status: "experiment",
      harvest: Object.freeze({ ...harvest, recurrenceCount: selectedRecurrence.length }),
      brief: observed.brief,
      reflectionRun,
      notification:
        criterionNotification() ??
        (config.notifications === "off"
          ? null
          : Object.freeze({
              mode: config.notifications,
              kind: "experiment",
              message: `Learning experiment ready: ${observed.brief.title}`,
            })),
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
    });
    const existing = await options.experiments.getExperiment(brief.experimentId);
    if (existing) {
      if (
        existing.hypothesis !== experiment.hypothesis ||
        existing.scope !== experiment.scope ||
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
