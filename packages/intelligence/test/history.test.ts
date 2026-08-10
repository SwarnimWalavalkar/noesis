import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspaceStore, type NoesisWorkspaceStore } from "@noesis/workspace";
import {
  createDeterministicEmbeddingPort,
  createDeterministicRerankPort,
  createHistoryPort,
  type HistoryRerankPort,
} from "../src/index.ts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

describe("longitudinal history", () => {
  let root: string;
  let workspace: NoesisWorkspaceStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "noesis-history-"));
    workspace = await createWorkspaceStore(root);
    await workspace.operational.sessions.put({
      sessionId: "session-a",
      title: "Research session",
      status: "idle",
      provider: "fake",
      model: "fake",
      runtime: "fake",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:03:00.000Z",
      metadata: {},
    });
    await Promise.all([
      workspace.operational.messages.put({
        messageId: "message-normal",
        sessionId: "session-a",
        role: "user",
        content: "I corrected the source grounded research workflow and asked for exact citations.",
        sensitivity: "normal",
        createdAt: "2026-01-01T00:01:00.000Z",
        metadata: {},
      }),
      workspace.operational.messages.put({
        messageId: "message-private",
        sessionId: "session-a",
        role: "user",
        content: "Private recurring workflow about the acquisition project codename zephyr.",
        sensitivity: "private",
        createdAt: "2026-01-01T00:02:00.000Z",
        metadata: {},
      }),
      workspace.operational.messages.put({
        messageId: "message-secret",
        sessionId: "session-a",
        role: "user",
        content: "Secret token ultrasecretvalue must never be retrieved.",
        sensitivity: "secret",
        createdAt: "2026-01-01T00:03:00.000Z",
        metadata: {},
      }),
    ]);
    await workspace.operational.searchConfiguration.put({
      lexicalLimit: 8,
      semanticLimit: 8,
      rerankLimit: 4,
      maxExcerptChars: 80,
      includePrivate: true,
      updatedAt: "2026-01-01T00:04:00.000Z",
    });
  });

  afterEach(async () => {
    workspace.close();
    await rm(root, { recursive: true, force: true });
  });

  test("rebuilds identical canonical refs and resolves exact stable citations", async () => {
    const history = createHistoryPort({
      workspace,
      embeddings: createDeterministicEmbeddingPort(),
      reranker: createDeterministicRerankPort(),
    });
    await history.rebuild();
    const firstRefs = (
      await workspace.search.listDocuments({ includePrivate: true, includeSecret: true })
    ).map((document) => ({ documentId: document.documentId, source: document.source }));
    await workspace.search.clear();
    await history.rebuild();
    const secondRefs = (
      await workspace.search.listDocuments({ includePrivate: true, includeSecret: true })
    ).map((document) => ({ documentId: document.documentId, source: document.source }));
    expect(secondRefs).toEqual(firstRefs);

    const result = await history.search({ query: "exact citations", limit: 2 });
    expect(result.hits[0]?.citation.source).toMatchObject({
      kind: "database_row",
      table: "messages",
      rowId: "message-normal",
    });
    const citation = result.hits[0]?.citation;
    if (!citation) throw new Error("Expected a history citation");
    const opened = await history.open({ citation });
    expect(opened.content.slice(citation.startOffset, citation.endOffset)).toBe(citation.excerpt);
    expect(await history.resolve([citation])).toEqual([citation]);
  });

  test("bounds rerank context and excludes private or secret history unless explicitly allowed", async () => {
    const observed: string[] = [];
    const boundedReranker: HistoryRerankPort = {
      rerank: async (request) => {
        observed.push(...request.candidates.map((candidate) => candidate.excerpt));
        expect(request.candidates.length).toBeLessThanOrEqual(4);
        expect(request.candidates.every((candidate) => candidate.excerpt.length <= 64)).toBe(true);
        return createDeterministicRerankPort().rerank(request);
      },
    };
    const history = createHistoryPort({
      workspace,
      embeddings: createDeterministicEmbeddingPort(),
      reranker: boundedReranker,
    });
    await history.rebuild();

    const normal = await history.search({
      query: "project codename zephyr ultrasecretvalue",
      limit: 1,
      maxExcerptChars: 64,
    });
    expect(
      normal.hits.every(
        (hit) =>
          hit.citation.source.kind !== "database_row" || hit.citation.source.rowId !== "message-private",
      ),
    ).toBe(true);
    expect(observed.join(" ")).not.toContain("ultrasecretvalue");

    const privateResult = await history.search({
      query: "project codename zephyr",
      privacy: "include_private",
      limit: 1,
      maxExcerptChars: 64,
    });
    expect(
      privateResult.hits.some(
        (hit) =>
          hit.citation.source.kind === "database_row" && hit.citation.source.rowId === "message-private",
      ),
    ).toBe(true);
    expect(
      privateResult.hits.every(
        (hit) =>
          hit.citation.source.kind !== "database_row" || hit.citation.source.rowId !== "message-secret",
      ),
    ).toBe(true);
    expect(privateResult.appliedBounds).toMatchObject({
      lexicalLimit: 8,
      semanticLimit: 8,
      rerankLimit: 4,
      resultLimit: 1,
      maxExcerptChars: 64,
    });
    expect(observed.length).toBeGreaterThan(0);
  });

  test("retrieves bounded prior evidence with an immutable file-revision citation", async () => {
    const evidence = await workspace.evidence.appendEvidence({
      workingPath: "barrier/research-output.json",
      bytes: Buffer.from("Controlled longitudinal evidence supports the research hypothesis."),
      actor: { actorId: "barrier-evaluator", kind: "system" },
      evidenceKind: "output",
      sensitivity: "normal",
      provenanceRefs: [{ kind: "database_row", table: "messages", rowId: "message-normal" }],
    });
    const privateEvidence = await workspace.evidence.appendEvidence({
      workingPath: "sessions/session-b/evaluation-output.json",
      bytes: Buffer.from("Private longitudinal evidence supports the research hypothesis."),
      actor: { actorId: "barrier-evaluator", kind: "system" },
      evidenceKind: "output",
      sensitivity: "private",
    });
    const history = createHistoryPort({
      workspace,
      embeddings: createDeterministicEmbeddingPort(),
      reranker: createDeterministicRerankPort(),
    });
    await history.rebuild();
    const result = await history.search({
      query: "longitudinal evidence hypothesis",
      limit: 1,
      lexicalLimit: 3,
      semanticLimit: 3,
      maxExcerptChars: 48,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.citation.source).toEqual({
      kind: "file_revision",
      revisionId: evidence.revisionId,
      field: "bytes",
    });
    expect(
      result.hits.some(
        (hit) =>
          hit.citation.source.kind === "file_revision" &&
          hit.citation.source.revisionId === privateEvidence.revisionId,
      ),
    ).toBe(false);
    expect(result.hits[0]?.citation.excerpt.length).toBeLessThanOrEqual(48);
    const citation = result.hits[0]?.citation;
    if (!citation) throw new Error("Expected the prior evidence citation");
    await expect(history.open({ citation })).resolves.toMatchObject({
      content: "Controlled longitudinal evidence supports the research hypothesis.",
    });
  });
});
