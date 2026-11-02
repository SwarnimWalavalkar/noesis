import {
  createConditionalObject,
  canonicalJson,
  type EvidenceRef,
  EvidenceRefSchema,
  type Result,
  sha256,
} from "@noesis/domain";
import type {
  CanonicalSearchSource,
  NoesisWorkspaceStore,
  SearchSessionScope,
  SearchSourceScope,
  Sensitivity,
} from "@noesis/workspace";
import { z } from "zod";
import type { HistoryPort, HistorySearchHit } from "./index.ts";
const identifierSchema = z.string().trim().min(1).max(256);
const querySchema = z.string().trim().min(2).max(500);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const sensitivitySchema = z.enum(["normal", "private", "secret"]);
const evidenceKindSchema = z.enum(["input", "output", "tool_trace", "judgment", "report"]);
const MAX_CITATION_PROVENANCE_REFS = 64;
const MAX_CITATION_SESSION_IDS = 32;
const MAX_CITATION_MESSAGE_IDS = 32;
const boundedProjectionSchema = z.strictObject({
  truncated: z.literal(true),
  totalCount: z.number().int().positive(),
  fullDigest: digestSchema,
});
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
    kind: z.literal("file_revision"),
    revisionId: identifierSchema,
    field: z.literal("bytes"),
  }),
]);
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
]);
const unsignedCitationSchema = z.strictObject({
  documentId: identifierSchema,
  source: canonicalSearchSourceSchema,
  identity: citationIdentitySchema,
  sessionIds: z.array(identifierSchema).max(MAX_CITATION_SESSION_IDS),
  sessionIdsProjection: boundedProjectionSchema.optional(),
  messageIds: z.array(identifierSchema).max(MAX_CITATION_MESSAGE_IDS),
  messageIdsProjection: boundedProjectionSchema.optional(),
  sensitivity: sensitivitySchema,
  provenanceRefs: z.array(EvidenceRefSchema).max(MAX_CITATION_PROVENANCE_REFS),
  provenanceProjection: boundedProjectionSchema.optional(),
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
function citationProvenanceProjection(refs: readonly EvidenceRef[]): {
  readonly provenanceRefs: readonly EvidenceRef[];
  readonly provenanceProjection?: {
    readonly truncated: true;
    readonly totalCount: number;
    readonly fullDigest: string;
  };
} {
  const provenanceRefs = refs.slice(0, MAX_CITATION_PROVENANCE_REFS);
  if (refs.length <= MAX_CITATION_PROVENANCE_REFS) return { provenanceRefs };
  return {
    provenanceRefs,
    provenanceProjection: {
      truncated: true,
      totalCount: refs.length,
      fullDigest: sha256(canonicalJson(refs)),
    },
  };
}
function citationStringProjection(
  values: readonly string[],
  limit: number,
): {
  readonly values: readonly string[];
  readonly projection?: {
    readonly truncated: true;
    readonly totalCount: number;
    readonly fullDigest: string;
  };
} {
  const bounded = values.slice(0, limit);
  if (values.length <= limit) return { values: bounded };
  return {
    values: bounded,
    projection: {
      truncated: true,
      totalCount: values.length,
      fullDigest: sha256(canonicalJson(values)),
    },
  };
}
const dateBoundSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
export const SearchSessionsInputSchema = z
  .strictObject({
    query: querySchema,
    sessionId: identifierSchema.optional(),
    scope: z.enum(["current", "previous", "all"]).optional(),
    after: dateBoundSchema
      .optional()
      .describe("Only evidence from this ISO-8601 date or datetime onward (inclusive)."),
    before: dateBoundSchema.optional().describe("Only evidence from before this ISO-8601 date or datetime."),
    source: z
      .enum(["message", "tool_output"])
      .optional()
      .describe("Only conversation messages, or only tool calls and their output."),
    maxResults: z.number().int().min(1).max(20).optional(),
    includePrivate: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (
      value.after !== undefined &&
      value.before !== undefined &&
      !(Date.parse(value.after) < Date.parse(value.before))
    )
      context.addIssue({ code: "custom", message: "after must be earlier than before" });
    if (value.sessionId !== undefined && value.scope !== undefined)
      context.addIssue({
        code: "custom",
        message: "Choose either an exact sessionId or a session scope, not both",
      });
  });
export const OpenSessionEvidenceInputSchema = z.strictObject({
  citation: SessionEvidenceCitationSchema,
  beforeChars: z.number().int().min(0).max(2048).optional(),
  afterChars: z.number().int().min(0).max(2048).optional(),
  maxChars: z.number().int().min(32).max(4096).optional(),
});
export const OpenSessionInputSchema = z.strictObject({
  sessionId: identifierSchema,
  includePrivate: z.boolean().optional(),
});
export interface AuthorizedSessionView {
  readonly sessionId: string;
  readonly includePrivate: boolean;
}
const focusedSearchInputFields = {
  sessionId: identifierSchema.optional(),
  maxResults: z.number().int().min(1).max(20).optional(),
  includePrivate: z.boolean().optional(),
};
export const FindSimilarTasksInputSchema = z.strictObject({
  description: querySchema,
  ...focusedSearchInputFields,
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
  readonly candidateCount: number;
  readonly resultCount: number;
  /** Matching results withheld because the turn's search context budget ran out. */
  readonly omittedResults: number;
  readonly contextCharacters: number;
  readonly maxFragmentCharacters: number;
  readonly maxTotalContextCharacters: number;
  readonly latencyMs: number;
  readonly refreshedDocuments: number;
  /** budget_exhausted means results were withheld, not that the search found nothing. */
  readonly status: "completed" | "budget_exhausted";
}
export interface SessionSearchHit {
  readonly fragmentId: string;
  readonly score: number;
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
type SessionToolName = "search_sessions" | "open_session_evidence" | "find_similar_tasks";
/** BOUNDARY: The tool broker parses each session-tool input with its adjacent inputSchema. */
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
/** BOUNDARY: Public session-tool methods preserve the broker's schema-first invocation contract. */
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
  readonly findSimilarTasks: (
    input: unknown,
    options?: SessionToolExecutionOptions,
  ) => Promise<SessionToolResult<SessionSearchOutput>>;
  /** Applies search's session and private-content rules to reading one whole session. */
  readonly authorizeOpenSession: (input: unknown) => Promise<SessionToolResult<AuthorizedSessionView>>;
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
  maxResults: 20,
  maxCandidates: 32,
  maxFragmentChars: 400,
  // One turn can fan out three full searches and most of a fourth, and still open one citation.
  maxTotalContextChars: 32768,
  maxOpenChars: 1600,
});
interface SourceMetadata {
  readonly identity: z.infer<typeof citationIdentitySchema>;
  readonly sessionIds: readonly string[];
  readonly messageIds: readonly string[];
  readonly sensitivity: Sensitivity;
  readonly provenanceRefs: readonly EvidenceRef[];
  readonly occurredAt: string;
}
interface ProvenanceResolution {
  readonly sessionIds: readonly string[];
  readonly messageIds: readonly string[];
  readonly sensitivity: Sensitivity;
}
const MAX_PROVENANCE_RESOLUTION_NODES = 10000;
interface RankedCitation {
  readonly citation: SessionEvidenceCitation;
  readonly excerpt: string;
  readonly score: number;
}
const fileRevisionRowSchema = z.looseObject({
  revision_id: identifierSchema,
  revision_kind: z.enum(["definition", "candidate", "active", "evidence"]),
  evidence_kind: evidenceKindSchema.nullable(),
  sensitivity: sensitivitySchema,
  provenance_refs_json: z.string(),
  recorded_at: z.string().min(1),
});
function maxSensitivity(left: Sensitivity, right: Sensitivity): Sensitivity {
  if (left === "secret" || right === "secret") return "secret";
  if (left === "private" || right === "private") return "private";
  return "normal";
}
function parseEvidenceRefs(encoded: string): readonly EvidenceRef[] | undefined {
  try {
    const parsed = z.array(EvidenceRefSchema).safeParse(JSON.parse(encoded));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
function provenanceResolutionKey(ref: EvidenceRef): string {
  if (ref.kind === "file_revision" || ref.kind === "evidence_revision")
    return `file_revision:${ref.revisionId}`;
  if (ref.kind === "artifact_file") return `artifact_file:${ref.artifactId}`;
  if (ref.table === "file_revisions") return `file_revision:${ref.rowId}`;
  return `database_row:${ref.table}:${ref.rowId}`;
}
export function createSessionSearchTools(options: CreateSessionSearchToolsOptions): SessionSearchTools {
  const limits = normalizeLimits(options.limits);
  const now = options.now ?? Date.now;
  const allowedPrivateSessions = new Set(options.authorization.privateSessionIds ?? []);
  const allowedPrivateRevisions = new Set(options.authorization.privateRevisionIds ?? []);
  const openContextCharacters =
    limits.maxTotalContextChars <= 1
      ? 0
      : Math.min(limits.maxOpenChars, Math.floor(limits.maxTotalContextChars / 2));
  let remainingSearchContextCharacters = limits.maxTotalContextChars - openContextCharacters;
  let remainingOpenContextCharacters = openContextCharacters;
  let refresh: Promise<number> | undefined;
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
  // Queries fanned out with Promise.all share one rebuild, and only the first reports its count.
  const ensureFresh = async (signal?: AbortSignal): Promise<number> => {
    if (options.refreshBeforeSearch === false) return 0;
    ensureNotCancelled(signal);
    if (refresh !== undefined) {
      await refresh;
      ensureNotCancelled(signal);
      return 0;
    }
    refresh = options.history.rebuild().then(
      (report) => report.documents,
      (cause: unknown) => {
        refresh = undefined;
        throw cause;
      },
    );
    const documents = await refresh;
    ensureNotCancelled(signal);
    return documents;
  };
  const resolveTransitiveProvenance = async (
    refs: readonly EvidenceRef[],
    signal?: AbortSignal,
  ): Promise<ProvenanceResolution> => {
    const failClosed: ProvenanceResolution = Object.freeze({
      sessionIds: [],
      messageIds: [],
      sensitivity: "secret",
    });
    const memo = new Map<string, ProvenanceResolution>();
    const resolving = new Set<string>();
    let remainingNodes = MAX_PROVENANCE_RESOLUTION_NODES;
    const merge = (
      baseSensitivity: Sensitivity,
      resolutions: readonly ProvenanceResolution[],
    ): ProvenanceResolution => {
      let sensitivity = baseSensitivity;
      const sessionIds = new Set<string>();
      const messageIds = new Set<string>();
      for (const resolution of resolutions) {
        sensitivity = maxSensitivity(sensitivity, resolution.sensitivity);
        for (const sessionId of resolution.sessionIds) sessionIds.add(sessionId);
        for (const messageId of resolution.messageIds) messageIds.add(messageId);
      }
      return Object.freeze({
        sessionIds: [...sessionIds].sort(),
        messageIds: [...messageIds].sort(),
        sensitivity,
      });
    };
    const resolveRefs = async (nestedRefs: readonly EvidenceRef[]): Promise<ProvenanceResolution> => {
      const resolutions: ProvenanceResolution[] = [];
      for (const ref of nestedRefs) {
        ensureNotCancelled(signal);
        resolutions.push(await resolveRef(ref));
      }
      return merge("normal", resolutions);
    };
    const resolveFileRevision = async (revisionId: string): Promise<ProvenanceResolution> => {
      const raw = await options.workspace.reads.readDatabaseRow({
        kind: "database_row",
        table: "file_revisions",
        rowId: revisionId,
      });
      if (!raw) return failClosed;
      const parsed = fileRevisionRowSchema.safeParse(raw);
      if (!parsed.success) return failClosed;
      const provenanceRefs = parseEvidenceRefs(parsed.data.provenance_refs_json);
      return provenanceRefs
        ? merge(parsed.data.sensitivity, [await resolveRefs(provenanceRefs)])
        : failClosed;
    };
    const resolveDatabaseRow = async (
      ref: Extract<
        EvidenceRef,
        {
          readonly kind: "database_row";
        }
      >,
    ): Promise<ProvenanceResolution> => {
      if (ref.table === "sessions") {
        const session = await options.workspace.operational.sessions.get(ref.rowId);
        const sensitivity = await options.workspace.operational.sessions.sensitivity(ref.rowId);
        return session && sensitivity
          ? Object.freeze({ sessionIds: [session.sessionId], messageIds: [], sensitivity })
          : failClosed;
      }
      if (ref.table === "messages") {
        const message = await options.workspace.operational.messages.get(ref.rowId);
        return message
          ? Object.freeze({
              sessionIds: [message.sessionId],
              messageIds: [message.messageId],
              sensitivity: message.sensitivity,
            })
          : failClosed;
      }
      if (ref.table === "tool_calls") {
        const toolCall = await options.workspace.operational.toolCalls.get(ref.rowId);
        return toolCall
          ? Object.freeze({
              sessionIds: [toolCall.sessionId],
              messageIds: toolCall.messageId ? [toolCall.messageId] : [],
              sensitivity: toolCall.sensitivity,
            })
          : failClosed;
      }
      if (ref.table === "outcomes") {
        const outcome = await options.workspace.operational.outcomes.get(ref.rowId);
        return outcome
          ? Object.freeze({
              sessionIds: [outcome.sessionId],
              messageIds: [],
              sensitivity: outcome.sensitivity,
            })
          : failClosed;
      }
      if (ref.table === "file_revisions") return await resolveFileRevision(ref.rowId);
      return failClosed;
    };
    async function resolveRef(ref: EvidenceRef): Promise<ProvenanceResolution> {
      const key = provenanceResolutionKey(ref);
      const memoized = memo.get(key);
      if (memoized) return memoized;
      if (remainingNodes <= 0 || resolving.has(key)) return failClosed;
      remainingNodes -= 1;
      resolving.add(key);
      let resolution: ProvenanceResolution;
      try {
        if (ref.kind === "file_revision" || ref.kind === "evidence_revision")
          resolution = await resolveFileRevision(ref.revisionId);
        else if (ref.kind === "artifact_file") {
          // Artifact relationship refs are not exposed by WorkspaceStore. Treating the artifact as
          // secret prevents a search index's richer provenance from being reopened under weaker scope.
          resolution = failClosed;
        } else resolution = await resolveDatabaseRow(ref);
      } catch (error) {
        if (errorMessage(error) === "SESSION_SEARCH_CANCELLED") throw error;
        resolution = failClosed;
      } finally {
        resolving.delete(key);
      }
      memo.set(key, resolution);
      return resolution;
    }
    return await resolveRefs(refs);
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
    const provenanceRefs = z.array(EvidenceRefSchema).parse(JSON.parse(row.provenance_refs_json));
    const provenance = await resolveTransitiveProvenance(provenanceRefs, signal);
    return {
      identity:
        row.revision_kind === "evidence" && row.evidence_kind
          ? {
              kind: "evidence_revision",
              evidenceRevisionId: revisionId,
              evidenceKind: row.evidence_kind,
            }
          : { kind: "file_revision", revisionId },
      sessionIds: provenance.sessionIds,
      messageIds: provenance.messageIds,
      sensitivity: maxSensitivity(row.sensitivity, provenance.sensitivity),
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
    if (source.table === "sessions") {
      const session = await options.workspace.operational.sessions.get(source.rowId);
      const sensitivity = await options.workspace.operational.sessions.sensitivity(source.rowId);
      return session
        ? {
            identity: { kind: "session", sessionId: session.sessionId },
            sessionIds: [session.sessionId],
            messageIds: [],
            sensitivity: sensitivity ?? "private",
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
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      return toolCall
        ? {
            identity: createConditionalObject({
              kind: "tool_call",
              sessionId: toolCall.sessionId,
              toolCallId: toolCall.toolCallId,
            } as const)
              .addOptional(toolCall.messageId ? { messageId: toolCall.messageId } : undefined)
              .finish(),
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
    const sessionIds = citationStringProjection(metadata.sessionIds, MAX_CITATION_SESSION_IDS);
    const messageIds = citationStringProjection(metadata.messageIds, MAX_CITATION_MESSAGE_IDS);
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const unsigned = unsignedCitationSchema.parse(
      createConditionalObject({
        documentId,
        source,
        identity: metadata.identity,
        sessionIds: sessionIds.values,
      } as const)
        .addOptional(sessionIds.projection ? { sessionIdsProjection: sessionIds.projection } : undefined)
        .add({
          messageIds: messageIds.values,
        } as const)
        .addOptional(messageIds.projection ? { messageIdsProjection: messageIds.projection } : undefined)
        .add({
          sensitivity: metadata.sensitivity,
          ...citationProvenanceProjection(metadata.provenanceRefs),
          occurredAt: metadata.occurredAt,
          excerptDigest: sha256(excerpt),
          startOffset,
          endOffset,
          contentDigest,
        } as const)
        .finish(),
    );
    return SessionEvidenceCitationSchema.parse({
      ...unsigned,
      citationDigest: sha256(canonicalJson(unsigned)),
    });
  };
  const resizeCitationExcerpt = (
    citation: SessionEvidenceCitation,
    excerpt: string,
    startOffset: number,
    endOffset: number,
  ): SessionEvidenceCitation => {
    const { citationDigest: _citationDigest, ...current } = citation;
    const unsigned = unsignedCitationSchema.parse({
      ...current,
      excerptDigest: sha256(excerpt),
      startOffset,
      endOffset,
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
    purpose: "search" | "open",
  ):
    | {
        readonly citation: SessionEvidenceCitation;
        readonly fragment: SessionContextFragment;
      }
    | undefined => {
    const remaining =
      purpose === "search" ? remainingSearchContextCharacters : remainingOpenContextCharacters;
    if (remaining <= 0) return undefined;
    const allowed = Math.min(
      excerpt.length,
      purpose === "search" ? limits.maxFragmentChars : limits.maxOpenChars,
      remaining,
    );
    if (allowed <= 0) return undefined;
    const boundedCitation =
      allowed === excerpt.length
        ? citation
        : resizeCitationExcerpt(
            citation,
            excerpt.slice(0, allowed),
            citation.startOffset,
            citation.startOffset + allowed,
          );
    const boundedExcerpt = excerpt.slice(0, allowed);
    if (purpose === "search") remainingSearchContextCharacters -= boundedExcerpt.length;
    else remainingOpenContextCharacters -= boundedExcerpt.length;
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
      score: hit.score,
    };
  };
  const runSearch = async (request: {
    readonly query: string;
    readonly sessionId?: string;
    readonly scope?: "current" | "previous" | "all";
    readonly maxResults: number;
    readonly includePrivate: boolean;
    readonly sourceScope?: SearchSourceScope;
    readonly after?: string;
    readonly before?: string;
    readonly accept: (metadata: SourceMetadata) => boolean | Promise<boolean>;
    readonly signal?: AbortSignal;
  }): Promise<SessionToolResult<SessionSearchOutput>> => {
    const startedAt = now();
    if (request.signal?.aborted) return fail("cancelled", "Session retrieval was cancelled.", true);
    try {
      ensureNotCancelled(request.signal);
      const refreshedDocuments = await ensureFresh(request.signal);
      const exactSessionId =
        request.sessionId ??
        (request.scope === "current" ? options.authorization.currentSessionId : undefined);
      const privateResult = authorizePrivateSearch(request.includePrivate, exactSessionId);
      if (!privateResult.ok) return privateResult;
      const sessionScope: SearchSessionScope | undefined =
        request.sessionId !== undefined
          ? { kind: "exact", sessionId: request.sessionId }
          : request.scope === "current"
            ? { kind: "exact", sessionId: options.authorization.currentSessionId }
            : request.scope === "all"
              ? undefined
              : { kind: "previous", currentSessionId: options.authorization.currentSessionId };
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      const result = await options.history.search(
        createConditionalObject({
          query: request.query,
          limit: limits.maxCandidates,
          candidateLimit: limits.maxCandidates,
          maxExcerptChars: limits.maxFragmentChars,
          candidateFilter: async (source: CanonicalSearchSource) => {
            const metadata = await resolveSourceMetadata(
              canonicalSearchSourceSchema.parse(source),
              request.signal,
            );
            return metadata !== undefined && isAuthorized(metadata) && (await request.accept(metadata));
          },
        } as const)
          .addOptional(sessionScope === undefined ? undefined : { sessionScope })
          .addOptional(request.sourceScope === undefined ? undefined : { sourceScope: request.sourceScope })
          .addOptional(
            request.after === undefined
              ? undefined
              : { occurredAfter: new Date(request.after).toISOString() },
          )
          .addOptional(
            request.before === undefined
              ? undefined
              : { occurredBefore: new Date(request.before).toISOString() },
          )
          .addOptional(privateResult.value ? ({ privacy: "include_private" } as const) : undefined)
          .addOptional(request.signal ? { signal: request.signal } : undefined)
          .finish(),
      );
      ensureNotCancelled(request.signal);
      const ranked = await Promise.all(result.hits.map((hit) => rankedFromHistory(hit, request.signal)));
      const accepted: RankedCitation[] = [];
      for (const item of ranked) {
        ensureNotCancelled(request.signal);
        if (!item) continue;
        const metadata = await resolveSourceMetadata(item.citation.source, request.signal);
        const matchesSessionScope =
          metadata !== undefined &&
          (request.sessionId !== undefined
            ? metadata.sessionIds.includes(request.sessionId)
            : request.scope === "current"
              ? metadata.sessionIds.includes(options.authorization.currentSessionId)
              : request.scope === "all"
                ? metadata.sessionIds.length > 0
                : metadata.sessionIds.length > 0 &&
                  !metadata.sessionIds.includes(options.authorization.currentSessionId));
        if (metadata && matchesSessionScope && (await request.accept(metadata))) accepted.push(item);
        if (accepted.length >= request.maxResults) break;
      }
      const hits: SessionSearchHit[] = [];
      const fragments: SessionContextFragment[] = [];
      for (const item of accepted) {
        const reserved = reserveCitation(item.citation, item.excerpt, item.score, "search");
        if (!reserved) break;
        fragments.push(reserved.fragment);
        hits.push({ fragmentId: reserved.fragment.id, score: item.score });
      }
      const omittedResults = accepted.length - fragments.length;
      ensureNotCancelled(request.signal);
      return {
        ok: true,
        value: {
          query: request.query,
          hits,
          fragments,
          telemetry: telemetry({
            candidateCount: result.candidateCount,
            omittedResults,
            fragments,
            limits,
            latencyMs: Math.max(0, now() - startedAt),
            refreshedDocuments,
            status: omittedResults > 0 ? "budget_exhausted" : "completed",
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
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return await runSearch(
      createConditionalObject({
        query: parsed.data.query,
      } as const)
        .addOptional(
          !(parsed.data.sessionId === undefined) ? { sessionId: parsed.data.sessionId } : undefined,
        )
        .addOptional(!(parsed.data.scope === undefined) ? { scope: parsed.data.scope } : undefined)
        .addOptional(!(parsed.data.source === undefined) ? { sourceScope: parsed.data.source } : undefined)
        .addOptional(!(parsed.data.after === undefined) ? { after: parsed.data.after } : undefined)
        .addOptional(!(parsed.data.before === undefined) ? { before: parsed.data.before } : undefined)
        .add({
          maxResults: Math.min(parsed.data.maxResults ?? limits.maxResults, limits.maxResults),
          includePrivate: parsed.data.includePrivate ?? false,
          accept: () => true,
        } as const)
        .addOptional(execution.signal ? { signal: execution.signal } : undefined)
        .finish(),
    );
  };
  const findSimilarTasks = async (
    input: unknown,
    execution: SessionToolExecutionOptions = {},
  ): Promise<SessionToolResult<SessionSearchOutput>> => {
    const parsed = FindSimilarTasksInputSchema.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return await runSearch(
      createConditionalObject({
        query: parsed.data.description,
      } as const)
        .addOptional(
          !(parsed.data.sessionId === undefined) ? { sessionId: parsed.data.sessionId } : undefined,
        )
        .add({
          maxResults: Math.min(parsed.data.maxResults ?? limits.maxResults, limits.maxResults),
          includePrivate: parsed.data.includePrivate ?? false,
          sourceScope: "session_or_outcome",
          accept: (metadata: SourceMetadata) =>
            metadata.identity.kind === "session" || metadata.identity.kind === "outcome",
        } as const)
        .addOptional(execution.signal ? { signal: execution.signal } : undefined)
        .finish(),
    );
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
      const expectedDocumentId = documentIdForSource(supplied.source);
      if (supplied.documentId !== expectedDocumentId)
        return fail("invalid_citation", "Session evidence citation source identity is invalid.");
      const metadata = await resolveSourceMetadata(supplied.source, execution.signal);
      if (!metadata) return fail("not_found", "Session evidence source no longer exists.");
      if (!isAuthorized(metadata))
        return fail("unauthorized", "Session evidence is outside the authorized sensitivity scope.");
      const authoritativeSessionIds = citationStringProjection(metadata.sessionIds, MAX_CITATION_SESSION_IDS);
      const authoritativeMessageIds = citationStringProjection(metadata.messageIds, MAX_CITATION_MESSAGE_IDS);
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      const authoritativeEnvelope = canonicalJson(
        createConditionalObject({
          identity: metadata.identity,
          sessionIds: authoritativeSessionIds.values,
        } as const)
          .addOptional(
            authoritativeSessionIds.projection
              ? {
                  sessionIdsProjection: authoritativeSessionIds.projection,
                }
              : undefined,
          )
          .add({
            messageIds: authoritativeMessageIds.values,
          } as const)
          .addOptional(
            authoritativeMessageIds.projection
              ? {
                  messageIdsProjection: authoritativeMessageIds.projection,
                }
              : undefined,
          )
          .add({
            sensitivity: metadata.sensitivity,
            ...citationProvenanceProjection(metadata.provenanceRefs),
            occurredAt: metadata.occurredAt,
          } as const)
          .finish(),
      );
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      const suppliedEnvelope = canonicalJson(
        createConditionalObject({
          identity: supplied.identity,
          sessionIds: supplied.sessionIds,
        } as const)
          .addOptional(
            supplied.sessionIdsProjection
              ? {
                  sessionIdsProjection: supplied.sessionIdsProjection,
                }
              : undefined,
          )
          .add({
            messageIds: supplied.messageIds,
          } as const)
          .addOptional(
            supplied.messageIdsProjection
              ? {
                  messageIdsProjection: supplied.messageIdsProjection,
                }
              : undefined,
          )
          .add({
            sensitivity: supplied.sensitivity,
            provenanceRefs: supplied.provenanceRefs,
          } as const)
          .addOptional(
            supplied.provenanceProjection
              ? {
                  provenanceProjection: supplied.provenanceProjection,
                }
              : undefined,
          )
          .add({
            occurredAt: supplied.occurredAt,
          } as const)
          .finish(),
      );
      if (authoritativeEnvelope !== suppliedEnvelope)
        return fail("stale_citation", "Session evidence citation metadata is stale or was altered.");
      const content = (await options.workspace.search.openCanonicalSource(supplied.source)) ?? "";
      if (content.length === 0) return fail("not_found", "Session evidence source no longer exists.");
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
      const reserved = reserveCitation(openedCitation, openedExcerpt, 1, "open");
      if (!reserved)
        return fail("bounds_exhausted", "The turn's session-evidence opening allowance is exhausted.");
      const output: OpenSessionEvidenceOutput = {
        fragment: reserved.fragment,
        telemetry: telemetry({
          candidateCount: 1,
          omittedResults: 0,
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
  const authorizeOpenSession = async (input: unknown): Promise<SessionToolResult<AuthorizedSessionView>> => {
    const parsed = OpenSessionInputSchema.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { sessionId } = parsed.data;
    const session = await options.workspace.operational.sessions.get(sessionId);
    if (!session || session.metadata["deletedAt"] !== undefined)
      return fail("not_found", `Session ${sessionId} does not exist or was deleted.`);
    const privateResult = authorizePrivateSearch(parsed.data.includePrivate ?? false, sessionId);
    if (!privateResult.ok) return privateResult;
    return { ok: true, value: Object.freeze({ sessionId, includePrivate: privateResult.value }) };
  };
  const definitions: readonly SessionToolDefinition[] = Object.freeze([
    Object.freeze({
      name: "search_sessions",
      label: "Search sessions",
      description:
        "Keyword search with BM25 ranking and stemming over the current compacted session, previous sessions, all sessions, or one exact sessionId. Returns bounded evidence with exact citations. Any term may match, and documents matching more terms rank higher; double quotes require an exact phrase. It does not match by meaning, so search for the words the evidence would contain and run several reformulated queries together with Promise.all. The default scope is previous sessions; use scope=current when older context from this session may have been compacted. An empty result means only that these words did not match; status budget_exhausted means the turn's search budget withheld results, and is already spent, so choose a smaller maxResults (about 8) before fanning out. Normal cross-session search needs no private flag; private retrieval accepts either one exact authorized sessionId or scope=current for the current authorized session.",
      inputSchema: SearchSessionsInputSchema,
      execute: searchSessions,
    }),
    Object.freeze({
      name: "open_session_evidence",
      label: "Open session evidence",
      description:
        "Open a bounded window around the one strongest exact session citation after reauthorization using the turn's reserved evidence-opening allowance.",
      inputSchema: OpenSessionEvidenceInputSchema,
      execute: openSessionEvidence,
    }),
    Object.freeze({
      name: "find_similar_tasks",
      label: "Find similar tasks",
      description: "Find related session titles and outcomes without exposing unrelated private history.",
      inputSchema: FindSimilarTasksInputSchema,
      execute: findSimilarTasks,
    }),
  ]);
  return Object.freeze({
    definitions,
    searchSessions,
    openSessionEvidence,
    findSimilarTasks,
    authorizeOpenSession,
  });
}
function normalizeLimits(overrides: Partial<SessionToolLimits> | undefined): SessionToolLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits))
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return Object.freeze({
    maxResults: Math.min(limits.maxResults, 20),
    maxCandidates: Math.min(limits.maxCandidates, 50),
    maxFragmentChars: Math.min(limits.maxFragmentChars, 8192),
    maxTotalContextChars: Math.min(limits.maxTotalContextChars, 32768),
    maxOpenChars: Math.min(limits.maxOpenChars, 4096),
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
function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
function telemetry(input: {
  readonly candidateCount: number;
  readonly omittedResults: number;
  readonly fragments: readonly SessionContextFragment[];
  readonly limits: SessionToolLimits;
  readonly latencyMs: number;
  readonly refreshedDocuments: number;
  readonly status: RetrievalTelemetry["status"];
}): RetrievalTelemetry {
  return {
    candidateCount: input.candidateCount,
    resultCount: input.fragments.length,
    omittedResults: input.omittedResults,
    contextCharacters: input.fragments.reduce((sum, fragment) => sum + fragment.content.length, 0),
    maxFragmentCharacters: input.limits.maxFragmentChars,
    maxTotalContextCharacters: input.limits.maxTotalContextChars,
    latencyMs: input.latencyMs,
    refreshedDocuments: input.refreshedDocuments,
    status: input.status,
  };
}
