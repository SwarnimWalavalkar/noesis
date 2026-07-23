import { createHash } from "node:crypto";
import type {
  CanonicalSearchSource,
  NoesisWorkspaceStore,
  SearchCandidate,
  SearchDocument,
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
  readonly sessionId?: string;
  readonly limit?: number;
  readonly lexicalLimit?: number;
  readonly semanticLimit?: number;
  readonly maxExcerptChars?: number;
  readonly privacy?: "normal" | "include_private";
}

export interface HistorySearchHit {
  readonly citation: ExactCitation;
  readonly lexicalScore?: number;
  readonly semanticScore?: number;
  readonly combinedScore: number;
  readonly rerankReason?: string;
}

export interface HistorySearchResult {
  readonly query: string;
  readonly hits: readonly HistorySearchHit[];
  readonly candidateCount: number;
  readonly appliedBounds: {
    readonly lexicalLimit: number;
    readonly semanticLimit: number;
    readonly rerankLimit: number;
    readonly resultLimit: number;
    readonly maxExcerptChars: number;
  };
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
  readonly rebuild: () => Promise<{ readonly documents: number; readonly embeddings: number }>;
}

export interface EmbeddingRequest {
  readonly texts: readonly string[];
}

export interface EmbeddingResult {
  readonly modelId: string;
  readonly vectors: readonly (readonly number[])[];
}

export interface EmbeddingPort {
  readonly embed: (request: EmbeddingRequest) => Promise<EmbeddingResult>;
}

export interface RerankCandidate {
  readonly documentId: string;
  readonly excerpt: string;
  readonly lexicalScore?: number;
  readonly semanticScore?: number;
  readonly combinedScore: number;
}

export interface RerankRequest {
  readonly query: string;
  readonly candidates: readonly RerankCandidate[];
  readonly maxResults: number;
}

export interface RerankResultItem {
  readonly documentId: string;
  readonly reason: string;
}

/** A bounded seam for an injected LLM or deterministic test double. It receives excerpts, never full history. */
export interface HistoryRerankPort {
  readonly rerank: (request: RerankRequest) => Promise<readonly RerankResultItem[]>;
}

export interface CreateHistoryPortOptions {
  readonly workspace: NoesisWorkspaceStore;
  readonly embeddings: EmbeddingPort;
  readonly reranker: HistoryRerankPort;
}

export function createHistoryPort(options: CreateHistoryPortOptions): HistoryPort {
  const rebuild = async (): Promise<{ readonly documents: number; readonly embeddings: number }> => {
    const documents = await options.workspace.search.rebuildDocuments();
    const indexable = documents.filter((document) => document.sensitivity !== "secret");
    if (indexable.length === 0) return { documents: documents.length, embeddings: 0 };
    const result = await options.embeddings.embed({ texts: indexable.map((document) => document.body) });
    if (result.vectors.length !== indexable.length)
      throw new Error(
        `Embedding port returned ${result.vectors.length} vectors for ${indexable.length} documents`,
      );
    await options.workspace.search.putEmbeddings(
      result.modelId,
      new Map(
        indexable.map((document, index) => {
          const vector = result.vectors[index];
          if (!vector) throw new Error(`Embedding port omitted document ${document.documentId}`);
          return [document.documentId, vector] as const;
        }),
      ),
    );
    return { documents: documents.length, embeddings: indexable.length };
  };

  const search = async (request: HistorySearchRequest): Promise<HistorySearchResult> => {
    const query = request.query.trim();
    if (query.length === 0) throw new Error("History search query must not be empty");
    const configuration = await options.workspace.operational.searchConfiguration.get();
    const resultLimit = boundedInteger(request.limit ?? 10, 1, Math.min(50, configuration.rerankLimit || 50));
    const lexicalLimit = boundedInteger(
      request.lexicalLimit ?? configuration.lexicalLimit,
      0,
      configuration.lexicalLimit,
    );
    const semanticLimit = boundedInteger(
      request.semanticLimit ?? configuration.semanticLimit,
      0,
      configuration.semanticLimit,
    );
    const rerankLimit =
      configuration.rerankLimit === 0
        ? 0
        : Math.min(Math.max(resultLimit, configuration.rerankLimit), lexicalLimit + semanticLimit, 100);
    const candidateLimit = rerankLimit === 0 ? Math.min(lexicalLimit + semanticLimit, 100) : rerankLimit;
    const maxExcerptChars = boundedInteger(
      request.maxExcerptChars ?? configuration.maxExcerptChars,
      32,
      configuration.maxExcerptChars,
    );
    const includePrivate = request.privacy === "include_private" && configuration.includePrivate;
    if ((await options.workspace.search.listDocuments({ includePrivate: true })).length === 0)
      await rebuild();

    const lexical = await options.workspace.search.lexicalCandidates({
      query,
      limit: lexicalLimit,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      includePrivate,
    });
    let semantic: readonly SearchCandidate[] = [];
    if (semanticLimit > 0) {
      const embedded = await options.embeddings.embed({ texts: [query] });
      const vector = embedded.vectors[0];
      if (!vector) throw new Error("Embedding port returned no query vector");
      semantic = await options.workspace.search.semanticCandidates({
        modelId: embedded.modelId,
        vector,
        limit: semanticLimit,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        includePrivate,
      });
    }

    const merged = mergeCandidates(lexical, semantic)
      .filter((candidate) => candidate.sensitivity === "normal" || includePrivate)
      .sort(
        (left, right) =>
          right.combinedScore - left.combinedScore || left.documentId.localeCompare(right.documentId),
      )
      .slice(0, candidateLimit);
    const excerpts = new Map(
      merged.map((candidate) => [
        candidate.documentId,
        createExcerpt(candidate.body, query, maxExcerptChars),
      ]),
    );
    const reranked =
      rerankLimit === 0
        ? []
        : await options.reranker.rerank({
            query,
            candidates: merged.map((candidate) => ({
              documentId: candidate.documentId,
              excerpt: excerpts.get(candidate.documentId)?.excerpt ?? "",
              ...(candidate.lexicalScore === undefined ? {} : { lexicalScore: candidate.lexicalScore }),
              ...(candidate.semanticScore === undefined ? {} : { semanticScore: candidate.semanticScore }),
              combinedScore: candidate.combinedScore,
            })),
            maxResults: resultLimit,
          });
    const candidateById = new Map(merged.map((candidate) => [candidate.documentId, candidate]));
    const selected: Array<{ readonly candidate: MergedCandidate; readonly reason?: string }> = [];
    const seen = new Set<string>();
    for (const item of reranked) {
      const candidate = candidateById.get(item.documentId);
      if (!candidate || seen.has(item.documentId)) continue;
      selected.push({ candidate, reason: item.reason });
      seen.add(item.documentId);
      if (selected.length === resultLimit) break;
    }
    for (const candidate of merged) {
      if (selected.length === resultLimit) break;
      if (!seen.has(candidate.documentId)) selected.push({ candidate });
    }

    const hits = selected.map(({ candidate, reason }): HistorySearchHit => {
      const excerpt = excerpts.get(candidate.documentId);
      if (!excerpt) throw new Error(`Missing bounded excerpt for ${candidate.documentId}`);
      return {
        citation: {
          source: candidate.source,
          occurredAt: candidate.occurredAt,
          excerpt: excerpt.excerpt,
          startOffset: excerpt.startOffset,
          endOffset: excerpt.endOffset,
          contentDigest: digestText(candidate.body),
        },
        ...(candidate.lexicalScore === undefined ? {} : { lexicalScore: candidate.lexicalScore }),
        ...(candidate.semanticScore === undefined ? {} : { semanticScore: candidate.semanticScore }),
        combinedScore: candidate.combinedScore,
        ...(reason === undefined ? {} : { rerankReason: reason }),
      };
    });
    return {
      query,
      hits,
      candidateCount: merged.length,
      appliedBounds: { lexicalLimit, semanticLimit, rerankLimit, resultLimit, maxExcerptChars },
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

interface MergedCandidate extends SearchDocument {
  readonly lexicalScore?: number;
  readonly semanticScore?: number;
  readonly combinedScore: number;
}

function mergeCandidates(
  lexical: readonly SearchCandidate[],
  semantic: readonly SearchCandidate[],
): readonly MergedCandidate[] {
  const merged = new Map<string, MergedCandidate>();
  for (const candidate of [...lexical, ...semantic]) {
    const existing = merged.get(candidate.documentId);
    const lexicalScore = candidate.lexicalScore ?? existing?.lexicalScore;
    const semanticScore = candidate.semanticScore ?? existing?.semanticScore;
    merged.set(candidate.documentId, {
      ...candidate,
      ...(lexicalScore === undefined ? {} : { lexicalScore }),
      ...(semanticScore === undefined ? {} : { semanticScore }),
      combinedScore: (lexicalScore ?? 0) * 0.55 + Math.max(0, semanticScore ?? 0) * 0.45,
    });
  }
  return [...merged.values()];
}

function createExcerpt(
  content: string,
  query: string,
  maxChars: number,
): { readonly excerpt: string; readonly startOffset: number; readonly endOffset: number } {
  if (content.length <= maxChars) return { excerpt: content, startOffset: 0, endOffset: content.length };
  const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
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

export function createDeterministicEmbeddingPort(
  dimensions = 32,
  modelId = `fake-hash-${dimensions}`,
): EmbeddingPort {
  if (!Number.isInteger(dimensions) || dimensions <= 0)
    throw new Error("Embedding dimensions must be positive");
  return Object.freeze({
    embed: async ({ texts }: EmbeddingRequest): Promise<EmbeddingResult> => ({
      modelId,
      vectors: texts.map((text) => deterministicVector(text, dimensions)),
    }),
  });
}

function deterministicVector(text: string, dimensions: number): readonly number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const token of text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest.readUInt32BE(0) % dimensions;
    const sign = digest[4] !== undefined && digest[4] % 2 === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
}

export function createDeterministicRerankPort(): HistoryRerankPort {
  return Object.freeze({
    rerank: async (request: RerankRequest): Promise<readonly RerankResultItem[]> => {
      const terms = new Set(request.query.toLocaleLowerCase().split(/\s+/u).filter(Boolean));
      return request.candidates
        .map((candidate) => {
          const lower = candidate.excerpt.toLocaleLowerCase();
          const overlap = [...terms].filter((term) => lower.includes(term)).length;
          return { candidate, overlap };
        })
        .sort(
          (left, right) =>
            right.overlap - left.overlap ||
            right.candidate.combinedScore - left.candidate.combinedScore ||
            left.candidate.documentId.localeCompare(right.candidate.documentId),
        )
        .slice(0, request.maxResults)
        .map(({ candidate, overlap }) => ({
          documentId: candidate.documentId,
          reason: `deterministic token overlap ${overlap}`,
        }));
    },
  });
}

export * from "./session-tools.ts";
