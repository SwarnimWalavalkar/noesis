import { createConditionalObject } from "@noesis/domain";
import { createHash } from "node:crypto";
import type {
  CanonicalSearchSource,
  NoesisWorkspaceStore,
  SearchSessionScope,
  SearchSourceScope,
} from "@noesis/workspace";
export interface ExactCitation {
  readonly source: CanonicalSearchSource;
  readonly occurredAt: string;
  readonly excerpt: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly contentDigest: string;
}
export interface HistorySearchRequest {
  readonly query: string;
  readonly signal?: AbortSignal;
  /** Defense-in-depth canonical eligibility applied after store retrieval and before the result bound. */
  readonly candidateFilter?: (source: CanonicalSearchSource) => boolean | Promise<boolean>;
  readonly sessionId?: string;
  readonly sessionScope?: SearchSessionScope;
  /** Typed structural filtering applied by the store before the candidate bound. */
  readonly sourceScope?: SearchSourceScope;
  /** Inclusive lower bound on when the source occurred, as an ISO-8601 UTC timestamp. */
  readonly occurredAfter?: string;
  /** Exclusive upper bound on when the source occurred, as an ISO-8601 UTC timestamp. */
  readonly occurredBefore?: string;
  readonly limit?: number;
  readonly candidateLimit?: number;
  readonly maxExcerptChars?: number;
  readonly privacy?: "normal" | "include_private";
}
export interface HistorySearchHit {
  readonly citation: ExactCitation;
  readonly score: number;
}
export interface HistorySearchResult {
  readonly query: string;
  readonly hits: readonly HistorySearchHit[];
  readonly candidateCount: number;
}
export interface HistoryOpenRequest {
  readonly citation: ExactCitation;
}
export interface HistoryOpenResult {
  readonly citation: ExactCitation;
  readonly content: string;
}
export interface HistoryPort {
  readonly search: (request: HistorySearchRequest) => Promise<HistorySearchResult>;
  readonly open: (request: HistoryOpenRequest) => Promise<HistoryOpenResult>;
  readonly resolve: (citations: readonly ExactCitation[]) => Promise<readonly ExactCitation[]>;
  readonly rebuild: () => Promise<{ readonly documents: number }>;
}
export interface CreateHistoryPortOptions {
  readonly workspace: NoesisWorkspaceStore;
}
export function createHistoryPort(options: CreateHistoryPortOptions): HistoryPort {
  const rebuild = async (): Promise<{ readonly documents: number }> => {
    const documents = await options.workspace.search.rebuildDocuments();
    return { documents: documents.length };
  };
  const search = async (request: HistorySearchRequest): Promise<HistorySearchResult> => {
    request.signal?.throwIfAborted();
    const query = request.query.trim();
    if (query.length === 0) throw new Error("History search query must not be empty");
    const configuration = await options.workspace.operational.searchConfiguration.get();
    const candidateLimit = boundedInteger(
      request.candidateLimit ?? configuration.lexicalLimit,
      0,
      configuration.lexicalLimit,
    );
    const resultLimit = boundedInteger(request.limit ?? 20, 1, 50);
    const maxExcerptChars = boundedInteger(
      request.maxExcerptChars ?? configuration.maxExcerptChars,
      32,
      configuration.maxExcerptChars,
    );
    const includePrivate = request.privacy === "include_private" && configuration.includePrivate;
    if (request.sessionId !== undefined && request.sessionScope !== undefined)
      throw new Error("History search accepts either sessionId or sessionScope, not both");
    const sessionScope: SearchSessionScope | undefined =
      request.sessionId === undefined
        ? request.sessionScope
        : { kind: "exact", sessionId: request.sessionId };
    if ((await options.workspace.search.listDocuments({ includePrivate: true })).length === 0)
      await rebuild();
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const candidates = await options.workspace.search.lexicalCandidates(
      createConditionalObject({
        query,
        limit: candidateLimit,
        includePrivate,
      } as const)
        .addOptional(sessionScope === undefined ? undefined : { sessionScope })
        .addOptional(request.sourceScope === undefined ? undefined : { sourceScope: request.sourceScope })
        .addOptional(
          request.occurredAfter === undefined ? undefined : { occurredAfter: request.occurredAfter },
        )
        .addOptional(
          request.occurredBefore === undefined ? undefined : { occurredBefore: request.occurredBefore },
        )
        .finish(),
    );
    const visible = candidates.filter((candidate) => candidate.sensitivity === "normal" || includePrivate);
    const accepted = await Promise.all(
      visible.map(async (candidate) => (await request.candidateFilter?.(candidate.source)) ?? true),
    );
    const eligible = visible.filter((_, index) => accepted[index] === true);
    const hits = eligible.slice(0, resultLimit).map((candidate): HistorySearchHit => {
      const excerpt = createExcerpt(candidate.body, candidate.matchOffset, maxExcerptChars);
      return {
        citation: {
          source: candidate.source,
          occurredAt: candidate.occurredAt,
          excerpt: excerpt.excerpt,
          startOffset: excerpt.startOffset,
          endOffset: excerpt.endOffset,
          contentDigest: digestText(candidate.body),
        },
        score: candidate.score,
      };
    });
    return {
      query,
      hits,
      candidateCount: eligible.length,
    };
  };
  const open = async (request: HistoryOpenRequest): Promise<HistoryOpenResult> => {
    const content = await options.workspace.search.openCanonicalSource(request.citation.source);
    if (content === undefined) throw new Error("History citation source is missing");
    verifyCitation(content, request.citation);
    return { citation: request.citation, content };
  };
  const resolve = async (citations: readonly ExactCitation[]): Promise<readonly ExactCitation[]> => {
    for (const citation of citations) await open({ citation });
    return citations.slice();
  };
  return Object.freeze({ search, open, resolve, rebuild });
}
function createExcerpt(
  content: string,
  matchOffset: number,
  maxChars: number,
): {
  readonly excerpt: string;
  readonly startOffset: number;
  readonly endOffset: number;
} {
  if (content.length <= maxChars) return { excerpt: content, startOffset: 0, endOffset: content.length };
  const startOffset = Math.max(
    0,
    Math.min(content.length - maxChars, matchOffset - Math.floor(maxChars / 3)),
  );
  const endOffset = Math.min(content.length, startOffset + maxChars);
  return { excerpt: content.slice(startOffset, endOffset), startOffset, endOffset };
}
function verifyCitation(content: string, citation: ExactCitation): void {
  if (digestText(content) !== citation.contentDigest)
    throw new Error("History citation is stale: canonical content digest changed");
  if (
    citation.startOffset < 0 ||
    citation.endOffset < citation.startOffset ||
    citation.endOffset > content.length ||
    content.slice(citation.startOffset, citation.endOffset) !== citation.excerpt
  )
    throw new Error("History citation offsets do not resolve to the recorded excerpt");
}
function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value)) throw new Error(`Expected an integer bound, received ${value}`);
  return Math.max(minimum, Math.min(maximum, value));
}
export * from "./session-tools.ts";
