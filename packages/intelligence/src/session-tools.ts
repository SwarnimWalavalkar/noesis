import {
  type CompletedExperiment,
  canonicalJson,
  type EvidenceRef,
  EvidenceRefSchema,
  type Experiment,
  type Result,
  sha256,
} from "@noesis/domain";
import type {
  CanonicalSearchSource,
  NoesisWorkspaceStore,
  SearchCandidate,
  Sensitivity,
} from "@noesis/workspace";
import { z } from "zod";
import type { HistoryPort, HistorySearchHit } from "./index.ts";

const identifierSchema = z.string().trim().min(1).max(256);
const querySchema = z.string().trim().min(2).max(500);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const sensitivitySchema = z.enum(["normal", "private", "secret"]);
const evidenceKindSchema = z.enum(["input", "output", "tool_trace", "judgment", "report"]);

const canonicalSearchSourceSchema = z.union([
  z.strictObject({
    kind: z.literal("database_row"),
    table: z.literal("sessions"),
    rowId: identifierSchema,
    field: z.literal("title"),
  }),
  z.strictObject({
    kind: z.literal("database_row"),
    table: z.literal("messages"),
    rowId: identifierSchema,
    field: z.literal("content"),
  }),
  z.strictObject({
    kind: z.literal("database_row"),
    table: z.literal("tool_calls"),
    rowId: identifierSchema,
    field: z.literal("trace"),
  }),
  z.strictObject({
    kind: z.literal("database_row"),
    table: z.literal("outcomes"),
    rowId: identifierSchema,
    field: z.literal("summary"),
  }),
  z.strictObject({
    kind: z.literal("database_row"),
    table: z.literal("experiments"),
    rowId: identifierSchema,
    field: z.literal("data_json"),
  }),
  z.strictObject({
    kind: z.literal("file_revision"),
    revisionId: identifierSchema,
    field: z.literal("bytes"),
  }),
]);
type SessionCanonicalSource = z.infer<typeof canonicalSearchSourceSchema>;
type StrictHistorySource = Exclude<
  SessionCanonicalSource,
  { readonly kind: "database_row"; readonly table: "experiments" }
>;

const citationIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("session"), sessionId: identifierSchema }),
  z.strictObject({
    kind: z.literal("message"),
    sessionId: identifierSchema,
    messageId: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal("tool_call"),
    sessionId: identifierSchema,
    toolCallId: identifierSchema,
    messageId: identifierSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("outcome"),
    sessionId: identifierSchema,
    outcomeId: identifierSchema,
  }),
  z.strictObject({ kind: z.literal("file_revision"), revisionId: identifierSchema }),
  z.strictObject({
    kind: z.literal("evidence_revision"),
    evidenceRevisionId: identifierSchema,
    evidenceKind: evidenceKindSchema,
  }),
  z.strictObject({ kind: z.literal("experiment"), experimentId: identifierSchema }),
]);

const unsignedCitationSchema = z.strictObject({
  documentId: identifierSchema,
  source: canonicalSearchSourceSchema,
  identity: citationIdentitySchema,
  sessionIds: z.array(identifierSchema).max(32),
  messageIds: z.array(identifierSchema).max(32),
  sensitivity: sensitivitySchema,
  provenanceRefs: z.array(EvidenceRefSchema).max(64),
  occurredAt: z.string().min(1).max(64),
  excerptDigest: digestSchema,
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
  contentDigest: digestSchema,
});

export const SessionEvidenceCitationSchema = unsignedCitationSchema.extend({
  citationDigest: digestSchema,
});
export type SessionEvidenceCitation = Readonly<z.infer<typeof SessionEvidenceCitationSchema>>;

export const RetrievalStrategyIdSchema = z.enum([
  "session-search.fts-only.v1",
  "session-search.hybrid.v1",
  "session-search.conservative.v1",
]);
export type RetrievalStrategyId = z.infer<typeof RetrievalStrategyIdSchema>;

export interface RetrievalStrategyVariant {
  readonly strategyId: RetrievalStrategyId;
  readonly mode: "fts_only" | "hybrid" | "no_retrieval";
  readonly description: string;
}

export const SESSION_RETRIEVAL_STRATEGIES = Object.freeze({
  ftsOnly: Object.freeze({
    strategyId: "session-search.fts-only.v1",
    mode: "fts_only",
    description: "Exact lexical retrieval without embeddings or LLM reranking.",
  }),
  hybrid: Object.freeze({
    strategyId: "session-search.hybrid.v1",
    mode: "hybrid",
    description: "Bounded lexical and semantic retrieval with the configured reranker.",
  }),
  conservative: Object.freeze({
    strategyId: "session-search.conservative.v1",
    mode: "no_retrieval",
    description: "Explicit abstention that injects no prior-session context.",
  }),
} as const satisfies Readonly<Record<string, RetrievalStrategyVariant>>);

const requestedStrategySchema = z.union([RetrievalStrategyIdSchema, z.literal("automatic")]);

export const SearchSessionsInputSchema = z.strictObject({
  query: querySchema,
  sessionId: identifierSchema.optional(),
  maxResults: z.number().int().min(1).max(20).optional(),
  strategy: requestedStrategySchema.optional(),
  includePrivate: z.boolean().optional(),
});

export const OpenSessionEvidenceInputSchema = z.strictObject({
  citation: SessionEvidenceCitationSchema,
  beforeChars: z.number().int().min(0).max(2_048).optional(),
  afterChars: z.number().int().min(0).max(2_048).optional(),
  maxChars: z.number().int().min(32).max(4_096).optional(),
});

const focusedSearchInputShape = {
  sessionId: identifierSchema.optional(),
  maxResults: z.number().int().min(1).max(20).optional(),
  strategy: requestedStrategySchema.optional(),
  includePrivate: z.boolean().optional(),
};

export const FindCorrectionsInputSchema = z.strictObject({
  topic: querySchema,
  ...focusedSearchInputShape,
});

export const FindSimilarTasksInputSchema = z.strictObject({
  description: querySchema,
  ...focusedSearchInputShape,
});

export const PriorExperimentOutcomesInputSchema = z.strictObject({
  task: querySchema,
  maxResults: z.number().int().min(1).max(20).optional(),
});

export interface SessionSearchAuthorization {
  readonly currentSessionId: string;
  readonly privateSessionIds?: readonly string[];
  readonly privateRevisionIds?: readonly string[];
}

export interface SessionToolLimits {
  readonly maxResults: number;
  readonly maxCandidates: number;
  readonly maxFragmentChars: number;
  readonly maxTotalContextChars: number;
  readonly maxOpenChars: number;
  readonly maxExperimentScan: number;
}

export interface SessionContextFragment {
  readonly id: string;
  readonly kind: "trail";
  readonly content: string;
  readonly provenance: readonly string[];
  readonly citation: SessionEvidenceCitation;
  readonly priority: number;
  readonly untrusted: true;
  readonly sensitive: boolean;
}

export interface RetrievalTelemetry {
  readonly strategyId: RetrievalStrategyId | "session-search.experiment-outcomes.v1";
  readonly routeReason: string;
  readonly candidateCount: number;
  readonly resultCount: number;
  readonly contextCharacters: number;
  readonly maxFragmentCharacters: number;
  readonly maxTotalContextCharacters: number;
  readonly latencyMs: number;
  readonly refreshedDocuments: number;
  readonly status: "completed" | "abstained" | "cancelled" | "failed";
}

export interface SessionSearchHit {
  readonly fragmentId: string;
  readonly score: number;
  readonly lexicalScore?: number;
  readonly semanticScore?: number;
  readonly rerankReason?: string;
}

export interface SessionSearchOutput {
  readonly query: string;
  readonly hits: readonly SessionSearchHit[];
  readonly fragments: readonly SessionContextFragment[];
  readonly telemetry: RetrievalTelemetry;
}

export interface OpenSessionEvidenceOutput {
  readonly fragment: SessionContextFragment;
  readonly telemetry: RetrievalTelemetry;
}

export interface PriorExperimentOutcomeHit extends SessionSearchHit {
  readonly experimentId: string;
  readonly outcome: CompletedExperiment["outcome"];
}

export interface PriorExperimentOutcomesOutput extends Omit<SessionSearchOutput, "hits"> {
  readonly hits: readonly PriorExperimentOutcomeHit[];
}

export type SessionToolErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "not_found"
  | "invalid_citation"
  | "stale_citation"
  | "bounds_exhausted"
  | "cancelled"
  | "backend_failure";

export interface SessionToolError {
  readonly code: SessionToolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export type SessionToolResult<T> = Result<T, SessionToolError>;

export interface SessionToolExecutionOptions {
  readonly signal?: AbortSignal;
}

export type SessionToolName =
  | "search_sessions"
  | "open_session_evidence"
  | "find_corrections"
  | "find_similar_tasks"
  | "prior_experiment_outcomes";

export interface SessionToolDefinition {
  readonly name: SessionToolName;
  readonly label: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly execute: (
    input: unknown,
    options?: SessionToolExecutionOptions,
  ) => Promise<SessionToolResult<unknown>>;
}

export interface SessionSearchTools {
  readonly definitions: readonly SessionToolDefinition[];
  readonly searchSessions: (
    input: unknown,
    options?: SessionToolExecutionOptions,
  ) => Promise<SessionToolResult<SessionSearchOutput>>;
  readonly openSessionEvidence: (
    input: unknown,
    options?: SessionToolExecutionOptions,
  ) => Promise<SessionToolResult<OpenSessionEvidenceOutput>>;
  readonly findCorrections: (
    input: unknown,
    options?: SessionToolExecutionOptions,
  ) => Promise<SessionToolResult<SessionSearchOutput>>;
  readonly findSimilarTasks: (
    input: unknown,
    options?: SessionToolExecutionOptions,
  ) => Promise<SessionToolResult<SessionSearchOutput>>;
  readonly priorExperimentOutcomes: (
    input: unknown,
    options?: SessionToolExecutionOptions,
  ) => Promise<SessionToolResult<PriorExperimentOutcomesOutput>>;
}

export interface CreateSessionSearchToolsOptions {
  readonly workspace: NoesisWorkspaceStore;
  readonly history: HistoryPort;
  readonly authorization: SessionSearchAuthorization;
  readonly limits?: Partial<SessionToolLimits>;
  readonly refreshBeforeSearch?: boolean;
  readonly now?: () => number;
}

const DEFAULT_LIMITS: SessionToolLimits = Object.freeze({
  maxResults: 8,
  maxCandidates: 32,
  maxFragmentChars: 800,
  maxTotalContextChars: 3_200,
  maxOpenChars: 1_600,
  maxExperimentScan: 200,
});

interface SourceMetadata {
  readonly identity: z.infer<typeof citationIdentitySchema>;
  readonly sessionIds: readonly string[];
  readonly messageIds: readonly string[];
  readonly sensitivity: Sensitivity;
  readonly provenanceRefs: readonly EvidenceRef[];
  readonly occurredAt: string;
}

interface RankedCitation {
  readonly citation: SessionEvidenceCitation;
  readonly excerpt: string;
  readonly score: number;
  readonly lexicalScore?: number;
  readonly semanticScore?: number;
  readonly rerankReason?: string;
}

const fileRevisionRowSchema = z.looseObject({
  revision_id: identifierSchema,
  revision_kind: z.enum(["definition", "candidate", "active", "evidence"]),
  evidence_kind: evidenceKindSchema.nullable(),
  sensitivity: sensitivitySchema,
  provenance_refs_json: z.string(),
  recorded_at: z.string().min(1),
});

const experimentRowSchema = z.looseObject({
  experiment_id: identifierSchema,
  updated_at: z.string().min(1),
});

export function selectSessionRetrievalStrategy(request: {
  readonly query: string;
  readonly requested?: z.infer<typeof requestedStrategySchema>;
}): { readonly strategy: RetrievalStrategyVariant; readonly reason: string } {
  if (request.requested && request.requested !== "automatic") {
    const strategy = Object.values(SESSION_RETRIEVAL_STRATEGIES).find(
      (candidate) => candidate.strategyId === request.requested,
    );
    if (!strategy) return { strategy: SESSION_RETRIEVAL_STRATEGIES.conservative, reason: "unknown strategy" };
    return { strategy, reason: "explicit strategy" };
  }
  const normalized = request.query.trim();
  if (/\b(?:password|secret|token|credential|private key)\b/iu.test(normalized))
    return {
      strategy: SESSION_RETRIEVAL_STRATEGIES.conservative,
      reason: "sensitive query abstention",
    };
  if (/['"`]|\b(?:session|message|revision|evidence)[-_][\p{L}\p{N}_-]+/iu.test(normalized))
    return { strategy: SESSION_RETRIEVAL_STRATEGIES.ftsOnly, reason: "exact-reference query" };
  return { strategy: SESSION_RETRIEVAL_STRATEGIES.hybrid, reason: "semantic task query" };
}

export function createSessionSearchTools(options: CreateSessionSearchToolsOptions): SessionSearchTools {
  const limits = normalizeLimits(options.limits);
  const now = options.now ?? Date.now;
  const allowedPrivateSessions = new Set(options.authorization.privateSessionIds ?? []);
  const allowedPrivateRevisions = new Set(options.authorization.privateRevisionIds ?? []);
  let remainingContextCharacters = limits.maxTotalContextChars;
  let refreshed = false;

  const fail = (
    code: SessionToolErrorCode,
    message: string,
    retryable = false,
  ): SessionToolResult<never> => ({
    ok: false,
    error: { code, message, retryable },
  });

  const ensureNotCancelled = (signal?: AbortSignal): void => {
    if (signal?.aborted) throw new Error("SESSION_SEARCH_CANCELLED");
  };

  const ensureFresh = async (signal?: AbortSignal): Promise<number> => {
    if (options.refreshBeforeSearch === false || refreshed) return 0;
    ensureNotCancelled(signal);
    const report = await options.history.rebuild();
    ensureNotCancelled(signal);
    refreshed = true;
    return report.documents;
  };

  const resolveSessionsFromRefs = async (
    refs: readonly EvidenceRef[],
    signal?: AbortSignal,
  ): Promise<{ readonly sessionIds: readonly string[]; readonly messageIds: readonly string[] }> => {
    const sessionIds = new Set<string>();
    const messageIds = new Set<string>();
    for (const ref of refs.slice(0, 64)) {
      ensureNotCancelled(signal);
      if (ref.kind !== "database_row") continue;
      if (ref.table === "sessions") sessionIds.add(ref.rowId);
      if (ref.table === "messages") {
        const message = await options.workspace.operational.messages.get(ref.rowId);
        if (message) {
          messageIds.add(message.messageId);
          sessionIds.add(message.sessionId);
        }
      }
      if (ref.table === "tool_calls") {
        const toolCall = await options.workspace.operational.toolCalls.get(ref.rowId);
        if (toolCall) {
          sessionIds.add(toolCall.sessionId);
          if (toolCall.messageId) messageIds.add(toolCall.messageId);
        }
      }
    }
    return { sessionIds: [...sessionIds].sort(), messageIds: [...messageIds].sort() };
  };

  const resolveFileRevisionMetadata = async (
    revisionId: string,
    signal?: AbortSignal,
  ): Promise<SourceMetadata | undefined> => {
    ensureNotCancelled(signal);
    const raw = await options.workspace.reads.readDatabaseRow({
      kind: "database_row",
      table: "file_revisions",
      rowId: revisionId,
    });
    if (!raw) return undefined;
    const row = fileRevisionRowSchema.parse(raw);
    const provenanceRefs = z.array(EvidenceRefSchema).max(64).parse(JSON.parse(row.provenance_refs_json));
    const related = await resolveSessionsFromRefs(provenanceRefs, signal);
    return {
      identity:
        row.revision_kind === "evidence" && row.evidence_kind
          ? {
              kind: "evidence_revision",
              evidenceRevisionId: revisionId,
              evidenceKind: row.evidence_kind,
            }
          : { kind: "file_revision", revisionId },
      sessionIds: related.sessionIds,
      messageIds: related.messageIds,
      sensitivity: row.sensitivity,
      provenanceRefs,
      occurredAt: row.recorded_at,
    };
  };

  const resolveSourceMetadata = async (
    source: z.infer<typeof canonicalSearchSourceSchema>,
    signal?: AbortSignal,
  ): Promise<SourceMetadata | undefined> => {
    ensureNotCancelled(signal);
    if (source.kind === "file_revision") return await resolveFileRevisionMetadata(source.revisionId, signal);
    if (source.table === "experiments") {
      const experiment = await options.workspace.research.experiments.getExperiment(source.rowId);
      if (!experiment) return undefined;
      const raw = await options.workspace.reads.readDatabaseRow({
        kind: "database_row",
        table: "experiments",
        rowId: source.rowId,
      });
      if (!raw) return undefined;
      const row = experimentRowSchema.parse(raw);
      const related = await resolveSessionsFromRefs(experiment.evidenceRefs, signal);
      return {
        identity: { kind: "experiment", experimentId: experiment.experimentId },
        sessionIds: related.sessionIds,
        messageIds: related.messageIds,
        sensitivity: await sensitivityForRefs(experiment.evidenceRefs, signal),
        provenanceRefs: experiment.evidenceRefs,
        occurredAt: row.updated_at,
      };
    }
    if (source.table === "sessions") {
      const session = await options.workspace.operational.sessions.get(source.rowId);
      return session
        ? {
            identity: { kind: "session", sessionId: session.sessionId },
            sessionIds: [session.sessionId],
            messageIds: [],
            sensitivity: "normal",
            provenanceRefs: [],
            occurredAt: session.updatedAt,
          }
        : undefined;
    }
    if (source.table === "messages") {
      const message = await options.workspace.operational.messages.get(source.rowId);
      return message
        ? {
            identity: { kind: "message", sessionId: message.sessionId, messageId: message.messageId },
            sessionIds: [message.sessionId],
            messageIds: [message.messageId],
            sensitivity: message.sensitivity,
            provenanceRefs: [{ kind: "database_row", table: "messages", rowId: message.messageId }],
            occurredAt: message.createdAt,
          }
        : undefined;
    }
    if (source.table === "tool_calls") {
      const toolCall = await options.workspace.operational.toolCalls.get(source.rowId);
      return toolCall
        ? {
            identity: {
              kind: "tool_call",
              sessionId: toolCall.sessionId,
              toolCallId: toolCall.toolCallId,
              ...(toolCall.messageId ? { messageId: toolCall.messageId } : {}),
            },
            sessionIds: [toolCall.sessionId],
            messageIds: toolCall.messageId ? [toolCall.messageId] : [],
            sensitivity: toolCall.sensitivity,
            provenanceRefs: [{ kind: "database_row", table: "tool_calls", rowId: toolCall.toolCallId }],
            occurredAt: toolCall.createdAt,
          }
        : undefined;
    }
    const outcome = await options.workspace.operational.outcomes.get(source.rowId);
    return outcome
      ? {
          identity: { kind: "outcome", sessionId: outcome.sessionId, outcomeId: outcome.outcomeId },
          sessionIds: [outcome.sessionId],
          messageIds: [],
          sensitivity: outcome.sensitivity,
          provenanceRefs: [],
          occurredAt: outcome.createdAt,
        }
      : undefined;
  };

  const sensitivityForRefs = async (
    refs: readonly EvidenceRef[],
    signal?: AbortSignal,
  ): Promise<Sensitivity> => {
    let sensitivity: Sensitivity = "normal";
    for (const ref of refs.slice(0, 64)) {
      ensureNotCancelled(signal);
      if (ref.kind === "artifact_file") return "private";
      if (ref.kind === "file_revision" || ref.kind === "evidence_revision") {
        const metadata = await resolveFileRevisionMetadata(ref.revisionId, signal);
        if (!metadata) return "private";
        if (metadata.sensitivity === "secret") return "secret";
        if (metadata.sensitivity === "private") sensitivity = "private";
        continue;
      }
      if (ref.table === "messages") {
        const record = await options.workspace.operational.messages.get(ref.rowId);
        if (!record) return "private";
        if (record.sensitivity === "secret") return "secret";
        if (record.sensitivity === "private") sensitivity = "private";
      } else if (ref.table === "tool_calls") {
        const record = await options.workspace.operational.toolCalls.get(ref.rowId);
        if (!record) return "private";
        if (record.sensitivity === "secret") return "secret";
        if (record.sensitivity === "private") sensitivity = "private";
      } else if (ref.table === "feedback_signals") {
        const record = await options.workspace.research.feedbackSignals.getFeedbackSignal(ref.rowId);
        if (!record) return "private";
        if (record.sensitivity === "secret") return "secret";
        if (record.sensitivity === "private") sensitivity = "private";
      } else if (ref.table !== "sessions") {
        // Other operational rows can transitively point at sensitive evidence but expose no
        // sensitivity-bearing public read model here. Unknown provenance therefore fails closed.
        return "private";
      }
    }
    return sensitivity;
  };

  const isAuthorized = (metadata: SourceMetadata): boolean => {
    if (metadata.sensitivity === "secret") return false;
    if (metadata.sensitivity === "normal") return true;
    if (metadata.sessionIds.length > 0)
      return metadata.sessionIds.every(
        (sessionId) =>
          sessionId === options.authorization.currentSessionId || allowedPrivateSessions.has(sessionId),
      );
    const revisionId =
      metadata.identity.kind === "file_revision"
        ? metadata.identity.revisionId
        : metadata.identity.kind === "evidence_revision"
          ? metadata.identity.evidenceRevisionId
          : undefined;
    return revisionId !== undefined && allowedPrivateRevisions.has(revisionId);
  };

  const makeCitation = (
    source: z.infer<typeof canonicalSearchSourceSchema>,
    documentId: string,
    metadata: SourceMetadata,
    excerpt: string,
    startOffset: number,
    endOffset: number,
    contentDigest: string,
  ): SessionEvidenceCitation => {
    const unsigned = unsignedCitationSchema.parse({
      documentId,
      source,
      identity: metadata.identity,
      sessionIds: [...metadata.sessionIds],
      messageIds: [...metadata.messageIds],
      sensitivity: metadata.sensitivity,
      provenanceRefs: [...metadata.provenanceRefs],
      occurredAt: metadata.occurredAt,
      excerptDigest: sha256(excerpt),
      startOffset,
      endOffset,
      contentDigest,
    });
    return SessionEvidenceCitationSchema.parse({
      ...unsigned,
      citationDigest: sha256(canonicalJson(unsigned)),
    });
  };

  const authorizePrivateSearch = (
    requested: boolean,
    sessionId: string | undefined,
  ): SessionToolResult<boolean> => {
    if (!requested) return { ok: true, value: false };
    if (!sessionId)
      return fail(
        "unauthorized",
        "Private retrieval requires one explicitly scoped session; cross-session private search is denied.",
      );
    if (sessionId !== options.authorization.currentSessionId && !allowedPrivateSessions.has(sessionId))
      return fail("unauthorized", `Private retrieval is not authorized for session ${sessionId}.`);
    return { ok: true, value: true };
  };

  const reserveCitation = (
    citation: SessionEvidenceCitation,
    excerpt: string,
    score: number,
  ):
    | { readonly citation: SessionEvidenceCitation; readonly fragment: SessionContextFragment }
    | undefined => {
    if (remainingContextCharacters <= 0) return undefined;
    const allowed = Math.min(excerpt.length, limits.maxFragmentChars, remainingContextCharacters);
    if (allowed <= 0) return undefined;
    const boundedCitation =
      allowed === excerpt.length
        ? citation
        : makeCitation(
            citation.source,
            citation.documentId,
            {
              identity: citation.identity,
              sessionIds: citation.sessionIds,
              messageIds: citation.messageIds,
              sensitivity: citation.sensitivity,
              provenanceRefs: citation.provenanceRefs,
              occurredAt: citation.occurredAt,
            },
            excerpt.slice(0, allowed),
            citation.startOffset,
            citation.startOffset + allowed,
            citation.contentDigest,
          );
    const boundedExcerpt = excerpt.slice(0, allowed);
    remainingContextCharacters -= boundedExcerpt.length;
    const provenance = [
      canonicalSourceKey(boundedCitation.source),
      ...boundedCitation.provenanceRefs.map(evidenceRefKey),
    ];
    return {
      citation: boundedCitation,
      fragment: {
        id: `history_${boundedCitation.citationDigest.slice(0, 24)}`,
        kind: "trail",
        content: boundedExcerpt,
        provenance: [...new Set(provenance)],
        citation: boundedCitation,
        priority: score,
        untrusted: true,
        sensitive: boundedCitation.sensitivity !== "normal",
      },
    };
  };

  const rankedFromHistory = async (
    hit: HistorySearchHit,
    signal?: AbortSignal,
  ): Promise<RankedCitation | undefined> => {
    const source = canonicalSearchSourceSchema.parse(hit.citation.source);
    const metadata = await resolveSourceMetadata(source, signal);
    if (!metadata || !isAuthorized(metadata)) return undefined;
    return {
      citation: makeCitation(
        source,
        documentIdForSource(hit.citation.source),
        metadata,
        hit.citation.excerpt,
        hit.citation.startOffset,
        hit.citation.endOffset,
        hit.citation.contentDigest,
      ),
      excerpt: hit.citation.excerpt,
      score: hit.combinedScore,
      ...(hit.lexicalScore === undefined ? {} : { lexicalScore: hit.lexicalScore }),
      ...(hit.semanticScore === undefined ? {} : { semanticScore: hit.semanticScore }),
      ...(hit.rerankReason === undefined ? {} : { rerankReason: hit.rerankReason }),
    };
  };

  const rankedFromCandidate = async (
    candidate: SearchCandidate,
    query: string,
    signal?: AbortSignal,
  ): Promise<RankedCitation | undefined> => {
    const source = canonicalSearchSourceSchema.parse(candidate.source);
    const metadata = await resolveSourceMetadata(source, signal);
    if (!metadata || !isAuthorized(metadata)) return undefined;
    const excerpt = createExcerpt(candidate.body, query, limits.maxFragmentChars);
    return {
      citation: makeCitation(
        source,
        candidate.documentId,
        metadata,
        excerpt.excerpt,
        excerpt.startOffset,
        excerpt.endOffset,
        sha256(candidate.body),
      ),
      excerpt: excerpt.excerpt,
      score: candidate.lexicalScore ?? 0,
      ...(candidate.lexicalScore === undefined ? {} : { lexicalScore: candidate.lexicalScore }),
    };
  };

  const runSearch = async (request: {
    readonly query: string;
    readonly sessionId?: string;
    readonly maxResults: number;
    readonly requestedStrategy?: z.infer<typeof requestedStrategySchema>;
    readonly includePrivate: boolean;
    readonly accept: (metadata: SourceMetadata) => boolean | Promise<boolean>;
    readonly signal?: AbortSignal;
  }): Promise<SessionToolResult<SessionSearchOutput>> => {
    const startedAt = now();
    const routed = selectSessionRetrievalStrategy({
      query: request.query,
      ...(request.requestedStrategy === undefined ? {} : { requested: request.requestedStrategy }),
    });
    if (request.signal?.aborted) return fail("cancelled", "Session retrieval was cancelled.", true);
    if (routed.strategy.mode === "no_retrieval")
      return {
        ok: true,
        value: {
          query: request.query,
          hits: [],
          fragments: [],
          telemetry: telemetry({
            strategyId: routed.strategy.strategyId,
            routeReason: routed.reason,
            candidateCount: 0,
            fragments: [],
            limits,
            latencyMs: Math.max(0, now() - startedAt),
            refreshedDocuments: 0,
            status: "abstained",
          }),
        },
      };
    try {
      ensureNotCancelled(request.signal);
      const refreshedDocuments = await ensureFresh(request.signal);
      const privateResult = authorizePrivateSearch(request.includePrivate, request.sessionId);
      if (!privateResult.ok) return privateResult;
      let candidateCount = 0;
      let ranked: readonly (RankedCitation | undefined)[];
      if (routed.strategy.mode === "fts_only") {
        const configuration = await options.workspace.operational.searchConfiguration.get();
        ensureNotCancelled(request.signal);
        const candidates = await options.workspace.search.lexicalCandidates({
          query: request.query,
          limit: Math.min(limits.maxCandidates, configuration.lexicalLimit),
          ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
          includePrivate: privateResult.value,
        });
        ensureNotCancelled(request.signal);
        candidateCount = candidates.length;
        ranked = await Promise.all(
          candidates.map((candidate) => rankedFromCandidate(candidate, request.query, request.signal)),
        );
      } else {
        const result = await options.history.search({
          query: request.query,
          ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
          limit: Math.min(limits.maxCandidates, 50),
          lexicalLimit: limits.maxCandidates,
          semanticLimit: limits.maxCandidates,
          maxExcerptChars: limits.maxFragmentChars,
          ...(privateResult.value ? { privacy: "include_private" } : {}),
        });
        ensureNotCancelled(request.signal);
        candidateCount = result.candidateCount;
        ranked = await Promise.all(result.hits.map((hit) => rankedFromHistory(hit, request.signal)));
      }
      const accepted: RankedCitation[] = [];
      for (const item of ranked) {
        ensureNotCancelled(request.signal);
        if (!item) continue;
        const metadata = await resolveSourceMetadata(item.citation.source, request.signal);
        if (metadata && (await request.accept(metadata))) accepted.push(item);
        if (accepted.length >= request.maxResults) break;
      }
      const hits: SessionSearchHit[] = [];
      const fragments: SessionContextFragment[] = [];
      for (const item of accepted) {
        const reserved = reserveCitation(item.citation, item.excerpt, item.score);
        if (!reserved) break;
        fragments.push(reserved.fragment);
        hits.push({
          fragmentId: reserved.fragment.id,
          score: item.score,
          ...(item.lexicalScore === undefined ? {} : { lexicalScore: item.lexicalScore }),
          ...(item.semanticScore === undefined ? {} : { semanticScore: item.semanticScore }),
          ...(item.rerankReason === undefined ? {} : { rerankReason: item.rerankReason }),
        });
      }
      ensureNotCancelled(request.signal);
      return {
        ok: true,
        value: {
          query: request.query,
          hits,
          fragments,
          telemetry: telemetry({
            strategyId: routed.strategy.strategyId,
            routeReason: routed.reason,
            candidateCount,
            fragments,
            limits,
            latencyMs: Math.max(0, now() - startedAt),
            refreshedDocuments,
            status: "completed",
          }),
        },
      };
    } catch (error) {
      if (request.signal?.aborted || errorMessage(error) === "SESSION_SEARCH_CANCELLED")
        return fail("cancelled", "Session retrieval was cancelled.", true);
      return fail("backend_failure", `Session retrieval failed: ${errorMessage(error)}`, true);
    }
  };

  const searchSessions = async (
    input: unknown,
    execution: SessionToolExecutionOptions = {},
  ): Promise<SessionToolResult<SessionSearchOutput>> => {
    const parsed = SearchSessionsInputSchema.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    return await runSearch({
      query: parsed.data.query,
      ...(parsed.data.sessionId === undefined ? {} : { sessionId: parsed.data.sessionId }),
      maxResults: Math.min(parsed.data.maxResults ?? limits.maxResults, limits.maxResults),
      ...(parsed.data.strategy === undefined ? {} : { requestedStrategy: parsed.data.strategy }),
      includePrivate: parsed.data.includePrivate ?? false,
      accept: () => true,
      ...(execution.signal ? { signal: execution.signal } : {}),
    });
  };

  const findCorrections = async (
    input: unknown,
    execution: SessionToolExecutionOptions = {},
  ): Promise<SessionToolResult<SessionSearchOutput>> => {
    const parsed = FindCorrectionsInputSchema.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    return await runSearch({
      query: parsed.data.topic,
      ...(parsed.data.sessionId === undefined ? {} : { sessionId: parsed.data.sessionId }),
      maxResults: Math.min(parsed.data.maxResults ?? limits.maxResults, limits.maxResults),
      ...(parsed.data.strategy === undefined ? {} : { requestedStrategy: parsed.data.strategy }),
      includePrivate: parsed.data.includePrivate ?? false,
      accept: async (metadata) => {
        if (metadata.identity.kind !== "outcome") return false;
        const outcome = await options.workspace.operational.outcomes.get(metadata.identity.outcomeId);
        return outcome?.status === "corrected";
      },
      ...(execution.signal ? { signal: execution.signal } : {}),
    });
  };

  const findSimilarTasks = async (
    input: unknown,
    execution: SessionToolExecutionOptions = {},
  ): Promise<SessionToolResult<SessionSearchOutput>> => {
    const parsed = FindSimilarTasksInputSchema.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    return await runSearch({
      query: parsed.data.description,
      ...(parsed.data.sessionId === undefined ? {} : { sessionId: parsed.data.sessionId }),
      maxResults: Math.min(parsed.data.maxResults ?? limits.maxResults, limits.maxResults),
      ...(parsed.data.strategy === undefined ? {} : { requestedStrategy: parsed.data.strategy }),
      includePrivate: parsed.data.includePrivate ?? false,
      accept: (metadata) => metadata.identity.kind === "session" || metadata.identity.kind === "outcome",
      ...(execution.signal ? { signal: execution.signal } : {}),
    });
  };

  const openSessionEvidence = async (
    input: unknown,
    execution: SessionToolExecutionOptions = {},
  ): Promise<SessionToolResult<OpenSessionEvidenceOutput>> => {
    const parsed = OpenSessionEvidenceInputSchema.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const startedAt = now();
    const supplied = parsed.data.citation;
    try {
      ensureNotCancelled(execution.signal);
      const { citationDigest: suppliedDigest, ...unsigned } = supplied;
      if (sha256(canonicalJson(unsigned)) !== suppliedDigest)
        return fail("invalid_citation", "Session evidence citation integrity check failed.");
      const expectedDocumentId =
        supplied.source.kind === "database_row" && supplied.source.table === "experiments"
          ? `experiment_${sha256(canonicalJson(supplied.source)).slice(0, 32)}`
          : isHistorySource(supplied.source)
            ? documentIdForSource(supplied.source)
            : undefined;
      if (!expectedDocumentId)
        return fail("invalid_citation", "Session evidence citation source is invalid.");
      if (supplied.documentId !== expectedDocumentId)
        return fail("invalid_citation", "Session evidence citation source identity is invalid.");
      const metadata = await resolveSourceMetadata(supplied.source, execution.signal);
      if (!metadata) return fail("not_found", "Session evidence source no longer exists.");
      if (!isAuthorized(metadata))
        return fail("unauthorized", "Session evidence is outside the authorized sensitivity scope.");
      const authoritativeEnvelope = canonicalJson({
        identity: metadata.identity,
        sessionIds: metadata.sessionIds,
        messageIds: metadata.messageIds,
        sensitivity: metadata.sensitivity,
        provenanceRefs: metadata.provenanceRefs,
        occurredAt: metadata.occurredAt,
      });
      const suppliedEnvelope = canonicalJson({
        identity: supplied.identity,
        sessionIds: supplied.sessionIds,
        messageIds: supplied.messageIds,
        sensitivity: supplied.sensitivity,
        provenanceRefs: supplied.provenanceRefs,
        occurredAt: supplied.occurredAt,
      });
      if (authoritativeEnvelope !== suppliedEnvelope)
        return fail("stale_citation", "Session evidence citation metadata is stale or was altered.");
      let content: string;
      if (supplied.source.kind === "database_row" && supplied.source.table === "experiments") {
        const experiment = await options.workspace.research.experiments.getExperiment(supplied.source.rowId);
        if (!experiment) return fail("not_found", "Experiment evidence no longer exists.");
        content = canonicalJson(experiment);
      } else {
        content = (await options.workspace.search.openCanonicalSource(supplied.source)) ?? "";
        if (content.length === 0) return fail("not_found", "Session evidence source no longer exists.");
      }
      verifyExactExcerpt(content, supplied);
      ensureNotCancelled(execution.signal);
      if (sha256(content) !== supplied.contentDigest)
        return fail("stale_citation", "Session evidence content changed after citation.");
      const maxChars = Math.min(parsed.data.maxChars ?? limits.maxOpenChars, limits.maxOpenChars);
      const before = parsed.data.beforeChars ?? 0;
      const after = parsed.data.afterChars ?? 0;
      let startOffset = Math.max(0, supplied.startOffset - before);
      let endOffset = Math.min(content.length, supplied.endOffset + after);
      if (endOffset - startOffset > maxChars) {
        startOffset = Math.max(0, Math.min(supplied.startOffset, content.length - maxChars));
        endOffset = Math.min(content.length, startOffset + maxChars);
      }
      const openedExcerpt = content.slice(startOffset, endOffset);
      const openedCitation = makeCitation(
        supplied.source,
        supplied.documentId,
        metadata,
        openedExcerpt,
        startOffset,
        endOffset,
        supplied.contentDigest,
      );
      const reserved = reserveCitation(openedCitation, openedExcerpt, 1);
      if (!reserved) return fail("bounds_exhausted", "The turn retrieval context budget is exhausted.");
      const output: OpenSessionEvidenceOutput = {
        fragment: reserved.fragment,
        telemetry: telemetry({
          strategyId: "session-search.fts-only.v1",
          routeReason: "exact citation open",
          candidateCount: 1,
          fragments: [reserved.fragment],
          limits,
          latencyMs: Math.max(0, now() - startedAt),
          refreshedDocuments: 0,
          status: "completed",
        }),
      };
      return { ok: true, value: output };
    } catch (error) {
      if (execution.signal?.aborted || errorMessage(error) === "SESSION_SEARCH_CANCELLED")
        return fail("cancelled", "Opening session evidence was cancelled.", true);
      const message = errorMessage(error);
      if (/stale|digest changed|offsets do not resolve|failed digest verification/iu.test(message))
        return fail("stale_citation", "Session evidence citation no longer resolves exactly.");
      return fail("backend_failure", `Opening session evidence failed: ${message}`, true);
    }
  };

  const priorExperimentOutcomes = async (
    input: unknown,
    execution: SessionToolExecutionOptions = {},
  ): Promise<SessionToolResult<PriorExperimentOutcomesOutput>> => {
    const parsed = PriorExperimentOutcomesInputSchema.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const startedAt = now();
    try {
      ensureNotCancelled(execution.signal);
      const experiments = await options.workspace.research.experiments.listExperiments({
        status: "completed",
        limit: limits.maxExperimentScan,
      });
      ensureNotCancelled(execution.signal);
      const ranked = experiments
        .filter(isCompletedExperiment)
        .map((experiment) => ({
          experiment,
          score: tokenOverlap(parsed.data.task, experimentText(experiment)),
        }))
        .filter((item) => item.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.experiment.experimentId.localeCompare(right.experiment.experimentId),
        );
      const hits: PriorExperimentOutcomeHit[] = [];
      const fragments: SessionContextFragment[] = [];
      for (const item of ranked) {
        ensureNotCancelled(execution.signal);
        if (hits.length >= Math.min(parsed.data.maxResults ?? limits.maxResults, limits.maxResults)) break;
        const source: z.infer<typeof canonicalSearchSourceSchema> = {
          kind: "database_row",
          table: "experiments",
          rowId: item.experiment.experimentId,
          field: "data_json",
        };
        const metadata = await resolveSourceMetadata(source, execution.signal);
        if (!metadata || !isAuthorized(metadata)) continue;
        const body = canonicalJson(item.experiment);
        const excerpt = createExcerpt(body, parsed.data.task, limits.maxFragmentChars);
        const citation = makeCitation(
          source,
          `experiment_${sha256(canonicalJson(source)).slice(0, 32)}`,
          metadata,
          excerpt.excerpt,
          excerpt.startOffset,
          excerpt.endOffset,
          sha256(body),
        );
        const reserved = reserveCitation(citation, excerpt.excerpt, item.score);
        if (!reserved) break;
        fragments.push(reserved.fragment);
        hits.push({
          experimentId: item.experiment.experimentId,
          outcome: item.experiment.outcome,
          fragmentId: reserved.fragment.id,
          score: item.score,
        });
      }
      return {
        ok: true,
        value: {
          query: parsed.data.task,
          hits,
          fragments,
          telemetry: telemetry({
            strategyId: "session-search.experiment-outcomes.v1",
            routeReason: "completed experiment outcome filter",
            candidateCount: experiments.length,
            fragments,
            limits,
            latencyMs: Math.max(0, now() - startedAt),
            refreshedDocuments: 0,
            status: "completed",
          }),
        },
      };
    } catch (error) {
      if (execution.signal?.aborted || errorMessage(error) === "SESSION_SEARCH_CANCELLED")
        return fail("cancelled", "Prior experiment outcome retrieval was cancelled.", true);
      return fail(
        "backend_failure",
        `Prior experiment outcome retrieval failed: ${errorMessage(error)}`,
        true,
      );
    }
  };

  const definitions: readonly SessionToolDefinition[] = Object.freeze([
    Object.freeze({
      name: "search_sessions",
      label: "Search sessions",
      description: "Search bounded, authorized prior-session evidence with exact citations.",
      inputSchema: SearchSessionsInputSchema,
      execute: searchSessions,
    }),
    Object.freeze({
      name: "open_session_evidence",
      label: "Open session evidence",
      description: "Open a bounded window around an exact session citation after reauthorization.",
      inputSchema: OpenSessionEvidenceInputSchema,
      execute: openSessionEvidence,
    }),
    Object.freeze({
      name: "find_corrections",
      label: "Find corrections",
      description: "Find prior corrected outcomes for a topic with exact citations.",
      inputSchema: FindCorrectionsInputSchema,
      execute: findCorrections,
    }),
    Object.freeze({
      name: "find_similar_tasks",
      label: "Find similar tasks",
      description: "Find related session titles and outcomes without exposing unrelated private history.",
      inputSchema: FindSimilarTasksInputSchema,
      execute: findSimilarTasks,
    }),
    Object.freeze({
      name: "prior_experiment_outcomes",
      label: "Prior experiment outcomes",
      description: "Find bounded completed keep, revise, or revert experiment outcomes.",
      inputSchema: PriorExperimentOutcomesInputSchema,
      execute: priorExperimentOutcomes,
    }),
  ]);

  return Object.freeze({
    definitions,
    searchSessions,
    openSessionEvidence,
    findCorrections,
    findSimilarTasks,
    priorExperimentOutcomes,
  });
}

function normalizeLimits(overrides: Partial<SessionToolLimits> | undefined): SessionToolLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits))
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return Object.freeze({
    maxResults: Math.min(limits.maxResults, 20),
    maxCandidates: Math.min(limits.maxCandidates, 50),
    maxFragmentChars: Math.min(limits.maxFragmentChars, 8_192),
    maxTotalContextChars: Math.min(limits.maxTotalContextChars, 32_768),
    maxOpenChars: Math.min(limits.maxOpenChars, 4_096),
    maxExperimentScan: Math.min(limits.maxExperimentScan, 1_000),
  });
}

function documentIdForSource(source: CanonicalSearchSource): string {
  return sha256(JSON.stringify(source));
}

function canonicalSourceKey(source: z.infer<typeof canonicalSearchSourceSchema>): string {
  return source.kind === "file_revision"
    ? `file_revision:${source.revisionId}:${source.field}`
    : `database_row:${source.table}:${source.rowId}:${source.field}`;
}

function evidenceRefKey(ref: EvidenceRef): string {
  if (ref.kind === "database_row") return `database_row:${ref.table}:${ref.rowId}`;
  if (ref.kind === "artifact_file") return `artifact_file:${ref.artifactId}`;
  return `${ref.kind}:${ref.revisionId}`;
}

function createExcerpt(
  content: string,
  query: string,
  maxChars: number,
): { readonly excerpt: string; readonly startOffset: number; readonly endOffset: number } {
  if (content.length <= maxChars) return { excerpt: content, startOffset: 0, endOffset: content.length };
  const terms = query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const lower = content.toLocaleLowerCase();
  const firstMatch = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const center = firstMatch ?? 0;
  const startOffset = Math.max(0, Math.min(content.length - maxChars, center - Math.floor(maxChars / 3)));
  const endOffset = Math.min(content.length, startOffset + maxChars);
  return { excerpt: content.slice(startOffset, endOffset), startOffset, endOffset };
}

function isHistorySource(source: SessionCanonicalSource): source is StrictHistorySource {
  return source.kind === "file_revision" || source.table !== "experiments";
}

function verifyExactExcerpt(content: string, citation: SessionEvidenceCitation): void {
  if (
    sha256(content) !== citation.contentDigest ||
    citation.endOffset < citation.startOffset ||
    citation.endOffset > content.length ||
    sha256(content.slice(citation.startOffset, citation.endOffset)) !== citation.excerptDigest
  )
    throw new Error("Session citation is stale or its exact excerpt was altered");
}

function invalidInput(error: z.ZodError): SessionToolResult<never> {
  const issue = error.issues[0];
  const location = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  return {
    ok: false,
    error: {
      code: "invalid_input",
      message: `Invalid session tool input${location}: ${issue?.message ?? "schema mismatch"}`,
      retryable: false,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tokenOverlap(query: string, content: string): number {
  const terms = new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
  const lower = content.toLocaleLowerCase();
  return [...terms].filter((term) => lower.includes(term)).length;
}

function experimentText(experiment: CompletedExperiment): string {
  return `${experiment.hypothesis}\n${experiment.scope}\n${experiment.outcome}`;
}

function isCompletedExperiment(experiment: Experiment): experiment is CompletedExperiment {
  return experiment.status === "completed";
}

function telemetry(input: {
  readonly strategyId: RetrievalTelemetry["strategyId"];
  readonly routeReason: string;
  readonly candidateCount: number;
  readonly fragments: readonly SessionContextFragment[];
  readonly limits: SessionToolLimits;
  readonly latencyMs: number;
  readonly refreshedDocuments: number;
  readonly status: RetrievalTelemetry["status"];
}): RetrievalTelemetry {
  return {
    strategyId: input.strategyId,
    routeReason: input.routeReason,
    candidateCount: input.candidateCount,
    resultCount: input.fragments.length,
    contextCharacters: input.fragments.reduce((sum, fragment) => sum + fragment.content.length, 0),
    maxFragmentCharacters: input.limits.maxFragmentChars,
    maxTotalContextCharacters: input.limits.maxTotalContextChars,
    latencyMs: input.latencyMs,
    refreshedDocuments: input.refreshedDocuments,
    status: input.status,
  };
}
