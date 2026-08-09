import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CapabilityRevisionRef, canonicalJson, type Experiment, sha256 } from "@noesis/domain";
import { createWorkspaceStore, type NoesisWorkspaceStore } from "@noesis/workspace";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createDeterministicEmbeddingPort,
  createDeterministicRerankPort,
  createHistoryPort,
  createSessionSearchTools,
  type HistoryPort,
  selectSessionRetrievalStrategy,
  SESSION_RETRIEVAL_STRATEGIES,
  type SessionSearchAuthorization,
  type SessionSearchTools,
} from "../src/index.ts";

const createdAt = "2026-07-22T10:00:00.000Z";
const later = "2026-07-22T10:05:00.000Z";

describe("AC-07 session search tools", () => {
  let root: string;
  let workspace: NoesisWorkspaceStore;
  let history: HistoryPort;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "noesis-session-tools-"));
    workspace = await createWorkspaceStore(root);
    await Promise.all([
      workspace.operational.sessions.put({
        sessionId: "session-a",
        title: "Source grounded release research",
        status: "completed",
        provider: "fake",
        model: "fake",
        runtime: "fake",
        createdAt,
        updatedAt: createdAt,
        metadata: {},
      }),
      workspace.operational.sessions.put({
        sessionId: "session-private-title",
        title: "Private oriole acquisition title",
        status: "completed",
        provider: "fake",
        model: "fake",
        runtime: "fake",
        createdAt,
        updatedAt: createdAt,
        metadata: {},
      }),
      workspace.operational.sessions.put({
        sessionId: "session-b",
        title: "Current release research",
        status: "idle",
        provider: "fake",
        model: "fake",
        runtime: "fake",
        createdAt: later,
        updatedAt: later,
        metadata: {},
      }),
      workspace.operational.sessions.put({
        sessionId: "session-private",
        title: "Unrelated acquisition work",
        status: "completed",
        provider: "fake",
        model: "fake",
        runtime: "fake",
        createdAt,
        updatedAt: createdAt,
        metadata: {},
      }),
    ]);
    await Promise.all([
      workspace.operational.messages.put({
        messageId: "message-public",
        sessionId: "session-a",
        role: "user",
        content: "Always preserve my voice and cite the exact source in release research.",
        sensitivity: "normal",
        createdAt,
        metadata: {},
      }),
      workspace.operational.messages.put({
        messageId: "message-current",
        sessionId: "session-b",
        role: "user",
        content: "Current marigold continuity note should not be recalled as prior work.",
        sensitivity: "normal",
        createdAt: later,
        metadata: {},
      }),
      workspace.operational.messages.put({
        messageId: "message-private-title",
        sessionId: "session-private-title",
        role: "user",
        content: "Private oriole acquisition context.",
        sensitivity: "private",
        createdAt,
        metadata: {},
      }),
      workspace.operational.messages.put({
        messageId: "message-private",
        sessionId: "session-private",
        role: "user",
        content: "Acquisition zephyr budget is private unrelated evidence.",
        sensitivity: "private",
        createdAt,
        metadata: {},
      }),
      workspace.operational.messages.put({
        messageId: "message-secret",
        sessionId: "session-private",
        role: "user",
        content: "Acquisition zephyr token ultrasecret is secret evidence.",
        sensitivity: "secret",
        createdAt: later,
        metadata: {},
      }),
    ]);
    await Promise.all([
      workspace.operational.outcomes.put({
        outcomeId: "outcome-correction",
        sessionId: "session-a",
        status: "corrected",
        summary: "Release research needed exact citations and preserved voice.",
        sensitivity: "normal",
        createdAt: later,
        metadata: {},
      }),
      workspace.operational.outcomes.put({
        outcomeId: "outcome-accepted",
        sessionId: "session-a",
        status: "accepted",
        summary: "Release research was accepted without correction.",
        sensitivity: "normal",
        createdAt: later,
        metadata: {},
      }),
    ]);
    await workspace.evidence.appendEvidence({
      workingPath: "session-a/release-evidence.txt",
      bytes: Buffer.from("Public evidence revision says preserve voice with canonical citations."),
      actor: { actorId: "test", kind: "system" },
      evidenceKind: "output",
      sensitivity: "normal",
      provenanceRefs: [{ kind: "database_row", table: "messages", rowId: "message-public" }],
    });
    await workspace.evidence.appendEvidence({
      workingPath: "unrelated/orphan-release-evidence.txt",
      bytes: Buffer.from(
        "Orphan preserve voice exact citations release research evidence has no session provenance.",
      ),
      actor: { actorId: "test", kind: "system" },
      evidenceKind: "output",
      sensitivity: "normal",
      provenanceRefs: [],
    });
    await workspace.operational.searchConfiguration.put({
      lexicalLimit: 32,
      semanticLimit: 32,
      rerankLimit: 16,
      maxExcerptChars: 256,
      includePrivate: true,
      updatedAt: later,
    });
    history = createHistoryPort({
      workspace,
      embeddings: createDeterministicEmbeddingPort(),
      reranker: createDeterministicRerankPort(),
    });
  });

  afterEach(async () => {
    workspace.close();
    await rm(root, { recursive: true, force: true });
  });

  const tools = (
    authorization: SessionSearchAuthorization = { currentSessionId: "session-b" },
    overrides: Parameters<typeof createSessionSearchTools>[0]["limits"] = {},
    selectedHistory = history,
  ): SessionSearchTools =>
    createSessionSearchTools({
      workspace,
      history: selectedHistory,
      authorization,
      limits: overrides,
    });

  test("Session B retrieves cited public and correction evidence from Session A without private injection", async () => {
    const sessionTools = tools();
    const search = await sessionTools.searchSessions({
      query: "preserve voice exact citations release research",
      maxResults: 8,
      strategy: SESSION_RETRIEVAL_STRATEGIES.hybrid.strategyId,
    });
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    expect(
      search.value.fragments.some((fragment) => fragment.citation.sessionIds.includes("session-a")),
    ).toBe(true);
    expect(search.value.fragments.every((fragment) => fragment.citation.sessionIds.length > 0)).toBe(true);
    expect(
      search.value.fragments.every((fragment) => !fragment.citation.sessionIds.includes("session-b")),
    ).toBe(true);
    expect(search.value.fragments.every((fragment) => fragment.citation.sensitivity === "normal")).toBe(true);
    expect(search.value.fragments.every((fragment) => fragment.untrusted)).toBe(true);
    expect(JSON.stringify(search.value)).not.toContain("ultrasecret");
    expect(JSON.stringify(search.value)).not.toContain("zephyr budget");
    expect(JSON.stringify(search.value)).not.toContain("Orphan preserve voice");

    const corrections = await tools().findCorrections({
      topic: "release research exact citations",
      strategy: SESSION_RETRIEVAL_STRATEGIES.ftsOnly.strategyId,
    });
    expect(corrections.ok).toBe(true);
    if (!corrections.ok) return;
    expect(corrections.value.hits).toHaveLength(1);
    expect(corrections.value.fragments[0]?.citation.identity).toEqual({
      kind: "outcome",
      sessionId: "session-a",
      outcomeId: "outcome-correction",
    });
  });

  test("defaults automatic retrieval to hybrid and only searches prior session-linked evidence", async () => {
    expect(
      selectSessionRetrievalStrategy({
        query: "secret token message_session-b",
        requested: "automatic",
      }),
    ).toEqual({
      strategy: SESSION_RETRIEVAL_STRATEGIES.hybrid,
      reason: "automatic hybrid default",
    });
    expect(
      selectSessionRetrievalStrategy({
        query: "anything",
        requested: SESSION_RETRIEVAL_STRATEGIES.ftsOnly.strategyId,
      }),
    ).toEqual({
      strategy: SESSION_RETRIEVAL_STRATEGIES.ftsOnly,
      reason: "explicit strategy",
    });

    const automatic = await tools().searchSessions({ query: "marigold continuity note" });
    expect(automatic).toMatchObject({
      ok: true,
      value: {
        telemetry: {
          strategyId: SESSION_RETRIEVAL_STRATEGIES.hybrid.strategyId,
          routeReason: "automatic hybrid default",
        },
      },
    });
    if (!automatic.ok) return;
    expect(
      automatic.value.fragments.every(
        (fragment) =>
          fragment.citation.sessionIds.length > 0 && !fragment.citation.sessionIds.includes("session-b"),
      ),
    ).toBe(true);
    expect(JSON.stringify(automatic.value.fragments)).not.toContain("Current marigold continuity");
    expect(JSON.stringify(automatic.value.fragments)).not.toContain("Orphan preserve voice");

    const explicitCurrent = await tools().searchSessions({
      query: "marigold continuity note",
      sessionId: "session-b",
    });
    expect(explicitCurrent.ok).toBe(true);
    if (!explicitCurrent.ok) return;
    expect(
      explicitCurrent.value.fragments.some(
        (fragment) =>
          fragment.citation.identity.kind === "message" &&
          fragment.citation.identity.messageId === "message-current",
      ),
    ).toBe(true);
    expect(
      explicitCurrent.value.fragments.every((fragment) => fragment.citation.sessionIds.includes("session-b")),
    ).toBe(true);
  });

  test("filters the current session before candidate limits can crowd out prior evidence", async () => {
    const query = "saffron longitudinal recall boundary";
    await workspace.operational.messages.put({
      messageId: "message-prior-crowding",
      sessionId: "session-a",
      role: "user",
      content: `${query} belongs to an earlier session and must remain discoverable.`,
      sensitivity: "normal",
      createdAt,
      metadata: {},
    });
    await Promise.all(
      Array.from({ length: 40 }, async (_, index) => {
        await workspace.operational.messages.put({
          messageId: `message-current-decoy-${index}`,
          sessionId: "session-b",
          role: "user",
          content: `${query} current-session decoy ${index}`,
          sensitivity: "normal",
          createdAt: later,
          metadata: {},
        });
      }),
    );

    const result = await tools().searchSessions({
      query,
      maxResults: 4,
      strategy: SESSION_RETRIEVAL_STRATEGIES.hybrid.strategyId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.fragments.some(
        (fragment) =>
          fragment.citation.identity.kind === "message" &&
          fragment.citation.identity.messageId === "message-prior-crowding",
      ),
    ).toBe(true);
    expect(
      result.value.fragments.every((fragment) => !fragment.citation.sessionIds.includes("session-b")),
    ).toBe(true);
  });

  test("carries exact evidence revision, session, message, and provenance identity", async () => {
    const result = await tools().searchSessions({
      query: "Public evidence revision canonical citations",
      strategy: SESSION_RETRIEVAL_STRATEGIES.ftsOnly.strategyId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const evidence = result.value.fragments.find(
      (fragment) => fragment.citation.identity.kind === "evidence_revision",
    );
    expect(evidence?.citation.identity).toMatchObject({
      kind: "evidence_revision",
      evidenceKind: "output",
    });
    expect(evidence?.citation.sessionIds).toEqual(["session-a"]);
    expect(evidence?.citation.messageIds).toEqual(["message-public"]);
    expect(evidence?.citation.provenanceRefs).toEqual([
      { kind: "database_row", table: "messages", rowId: "message-public" },
    ]);
    expect(evidence?.provenance).toContain("database_row:messages:message-public");
    if (!evidence) throw new Error("Expected evidence fragment");
    expect(JSON.stringify(result.value).split(JSON.stringify(evidence.content))).toHaveLength(2);
  });

  test("requires explicit session authorization for private search and never returns secret evidence", async () => {
    const denied = await tools().searchSessions({
      query: "acquisition zephyr",
      sessionId: "session-private",
      includePrivate: true,
      strategy: SESSION_RETRIEVAL_STRATEGIES.ftsOnly.strategyId,
    });
    expect(denied).toMatchObject({ ok: false, error: { code: "unauthorized" } });

    const allowed = await tools({
      currentSessionId: "session-b",
      privateSessionIds: ["session-private"],
    }).searchSessions({
      query: "acquisition zephyr",
      sessionId: "session-private",
      includePrivate: true,
      strategy: SESSION_RETRIEVAL_STRATEGIES.ftsOnly.strategyId,
    });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.value.fragments.some((fragment) => fragment.citation.sensitivity === "private")).toBe(
      true,
    );
    expect(allowed.value.fragments.every((fragment) => fragment.citation.sensitivity !== "secret")).toBe(
      true,
    );
    expect(JSON.stringify(allowed.value)).not.toContain("ultrasecret");
    const privateCitation = allowed.value.fragments.find(
      (fragment) => fragment.citation.sensitivity === "private",
    )?.citation;
    if (!privateCitation) throw new Error("Expected authorized private citation");
    const reopenedWithoutGrant = await tools().openSessionEvidence({ citation: privateCitation });
    expect(reopenedWithoutGrant).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  test("keeps a title at its session's authoritative private sensitivity", async () => {
    const unauthorized = await tools().searchSessions({
      query: "Private oriole acquisition title",
      strategy: SESSION_RETRIEVAL_STRATEGIES.ftsOnly.strategyId,
    });
    expect(unauthorized.ok).toBe(true);
    if (!unauthorized.ok) return;
    expect(JSON.stringify(unauthorized.value.fragments)).not.toContain("Private oriole acquisition title");

    const authorized = await tools({
      currentSessionId: "session-b",
      privateSessionIds: ["session-private-title"],
    }).searchSessions({
      query: "Private oriole acquisition title",
      sessionId: "session-private-title",
      includePrivate: true,
      strategy: SESSION_RETRIEVAL_STRATEGIES.ftsOnly.strategyId,
    });
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;
    const title = authorized.value.fragments.find(
      (fragment) => fragment.citation.identity.kind === "session",
    );
    expect(title).toMatchObject({
      content: "Private oriole acquisition title",
      citation: { sensitivity: "private", sessionIds: ["session-private-title"] },
    });
    if (!title) return;
    const opened = await tools({
      currentSessionId: "session-b",
      privateSessionIds: ["session-private-title"],
    }).openSessionEvidence({ citation: title.citation });
    expect(opened).toMatchObject({ ok: true, value: { fragment: { content: title.content } } });
  });

  test("opens only bounded authorized windows and rejects tampered or stale citations", async () => {
    const search = await tools().searchSessions({
      query: "Source grounded release research",
      strategy: SESSION_RETRIEVAL_STRATEGIES.ftsOnly.strategyId,
    });
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    const sessionFragment = search.value.fragments.find(
      (fragment) => fragment.citation.identity.kind === "session",
    );
    if (!sessionFragment) throw new Error("Expected session citation");

    const opened = await tools().openSessionEvidence({
      citation: sessionFragment.citation,
      beforeChars: 100,
      afterChars: 100,
      maxChars: 40,
    });
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.value.fragment.content.length).toBeLessThanOrEqual(40);
      expect(opened.value.fragment.citation.excerptDigest).toBe(sha256(opened.value.fragment.content));
    }

    const tampered = await tools().openSessionEvidence({
      citation: { ...sessionFragment.citation, startOffset: sessionFragment.citation.startOffset + 1 },
    });
    expect(tampered).toMatchObject({ ok: false, error: { code: "invalid_citation" } });
    const { citationDigest: _digest, ...unsigned } = sessionFragment.citation;
    const forgedUnsigned = { ...unsigned, documentId: "forged-document" };
    const forged = await tools().openSessionEvidence({
      citation: {
        ...forgedUnsigned,
        citationDigest: sha256(canonicalJson(forgedUnsigned)),
      },
    });
    expect(forged).toMatchObject({ ok: false, error: { code: "invalid_citation" } });

    await workspace.operational.sessions.put({
      sessionId: "session-a",
      title: "Changed authoritative title",
      status: "completed",
      provider: "fake",
      model: "fake",
      runtime: "fake",
      createdAt,
      updatedAt: "2026-07-22T11:00:00.000Z",
      metadata: {},
    });
    const stale = await tools().openSessionEvidence({ citation: sessionFragment.citation });
    expect(stale).toMatchObject({ ok: false, error: { code: "stale_citation" } });
  });

  test("enforces per-fragment and shared total context bounds", async () => {
    const result = await tools(
      { currentSessionId: "session-b" },
      { maxFragmentChars: 40, maxTotalContextChars: 70, maxResults: 8 },
    ).searchSessions({
      query: "release research citations preserve voice",
      maxResults: 8,
      strategy: SESSION_RETRIEVAL_STRATEGIES.hybrid.strategyId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fragments.every((fragment) => fragment.content.length <= 40)).toBe(true);
    expect(
      result.value.fragments.reduce((sum, fragment) => sum + fragment.content.length, 0),
    ).toBeLessThanOrEqual(70);
    expect(result.value.telemetry.contextCharacters).toBeLessThanOrEqual(70);
  });

  test("uses model ranking before a context budget truncates an otherwise fully returned candidate set", async () => {
    let rerankCalls = 0;
    const semanticHistory = createHistoryPort({
      workspace,
      embeddings: createDeterministicEmbeddingPort(),
      reranker: {
        rerank: async (request) => {
          rerankCalls += 1;
          return [...request.candidates]
            .sort((left, right) => {
              const leftPreferred = left.excerpt.includes("Always preserve") ? 1 : 0;
              const rightPreferred = right.excerpt.includes("Always preserve") ? 1 : 0;
              return rightPreferred - leftPreferred;
            })
            .map((candidate) => ({
              documentId: candidate.documentId,
              reason: "Controlled semantic preference.",
            }));
        },
      },
    });
    const result = await tools(
      { currentSessionId: "session-b" },
      { maxFragmentChars: 40, maxTotalContextChars: 40, maxResults: 8 },
      semanticHistory,
    ).searchSessions({
      query: "release research citations preserve voice",
      maxResults: 8,
      strategy: SESSION_RETRIEVAL_STRATEGIES.hybrid.strategyId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.telemetry.candidateCount).toBeGreaterThan(1);
    expect(result.value.telemetry.candidateCount).toBeLessThanOrEqual(8);
    expect(rerankCalls).toBe(1);
    expect(result.value.fragments).toHaveLength(1);
    expect(result.value.fragments[0]?.citation.identity).toEqual({
      kind: "message",
      sessionId: "session-a",
      messageId: "message-public",
    });
  });

  test("filters similar tasks and completed experiment outcomes by authoritative type", async () => {
    const similar = await tools().findSimilarTasks({
      description: "source grounded release research",
      strategy: SESSION_RETRIEVAL_STRATEGIES.ftsOnly.strategyId,
    });
    expect(similar.ok).toBe(true);
    if (similar.ok)
      expect(
        similar.value.fragments.every(
          (fragment) =>
            fragment.citation.identity.kind === "session" || fragment.citation.identity.kind === "outcome",
        ),
      ).toBe(true);

    await putCompletedExperiment({
      experimentId: "experiment-release",
      hypothesis: "Preserving voice improves release research",
      scope: "release research",
      outcome: "keep",
      evidenceRefs: [{ kind: "database_row", table: "messages", rowId: "message-public" }],
    });
    await putCompletedExperiment({
      experimentId: "experiment-private",
      hypothesis: "Acquisition zephyr routing improves",
      scope: "acquisition",
      outcome: "revert",
      evidenceRefs: [{ kind: "database_row", table: "messages", rowId: "message-private" }],
    });
    const privateSignal = await workspace.research.feedbackSignals.recordFeedbackSignal({
      signalId: "feedback-private",
      kind: "explicit_correction",
      scope: "confidential launch",
      evidenceRefs: [{ kind: "database_row", table: "messages", rowId: "message-private" }],
      strength: 1,
      novelty: 1,
      sensitivity: "private",
    });
    await putCompletedExperiment({
      experimentId: "experiment-private-signal",
      hypothesis: "Confidential launch correction should change routing",
      scope: "confidential launch",
      outcome: "revise",
      evidenceRefs: [privateSignal],
    });
    const outcomes = await tools().priorExperimentOutcomes({ task: "release research preserving voice" });
    expect(outcomes.ok).toBe(true);
    if (!outcomes.ok) return;
    expect(outcomes.value.hits).toHaveLength(1);
    expect(outcomes.value.hits[0]).toMatchObject({
      experimentId: "experiment-release",
      outcome: "keep",
    });
    const outcomeFragment = outcomes.value.fragments.find(
      (fragment) => fragment.id === outcomes.value.hits[0]?.fragmentId,
    );
    expect(outcomeFragment?.citation.identity).toEqual({
      kind: "experiment",
      experimentId: "experiment-release",
    });
    expect(JSON.stringify(outcomes.value)).not.toContain("experiment-private");
    const privateSignalOutcomes = await tools().priorExperimentOutcomes({ task: "confidential launch" });
    expect(privateSignalOutcomes).toMatchObject({ ok: true, value: { hits: [] } });
    const opened = await tools().openSessionEvidence({ citation: outcomeFragment?.citation });
    expect(opened.ok).toBe(true);
  });

  test("exposes comparable telemetry for FTS, hybrid, and conservative variants", async () => {
    const variants = await Promise.all([
      tools().searchSessions({
        query: "release research",
        strategy: SESSION_RETRIEVAL_STRATEGIES.ftsOnly.strategyId,
      }),
      tools().searchSessions({
        query: "release research",
        strategy: SESSION_RETRIEVAL_STRATEGIES.hybrid.strategyId,
      }),
      tools().searchSessions({
        query: "release research",
        strategy: SESSION_RETRIEVAL_STRATEGIES.conservative.strategyId,
      }),
    ]);
    expect(variants.every((result) => result.ok)).toBe(true);
    const telemetry = variants.flatMap((result) => (result.ok ? [result.value.telemetry] : []));
    expect(telemetry.map((item) => item.strategyId)).toEqual([
      SESSION_RETRIEVAL_STRATEGIES.ftsOnly.strategyId,
      SESSION_RETRIEVAL_STRATEGIES.hybrid.strategyId,
      SESSION_RETRIEVAL_STRATEGIES.conservative.strategyId,
    ]);
    expect(telemetry.map((item) => Object.keys(item).sort())).toEqual([
      Object.keys(telemetry[0] ?? {}).sort(),
      Object.keys(telemetry[0] ?? {}).sort(),
      Object.keys(telemetry[0] ?? {}).sort(),
    ]);
    if (variants[2]?.ok) {
      expect(variants[2].value.fragments).toEqual([]);
      expect(variants[2].value.telemetry.status).toBe("abstained");
    }
  });

  test("returns typed validation, cancellation, and backend errors", async () => {
    const invalid = await tools().searchSessions({ query: "" });
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_input", retryable: false } });

    const preAborted = new AbortController();
    preAborted.abort();
    const cancelled = await tools().searchSessions(
      {
        query: "release research",
        strategy: SESSION_RETRIEVAL_STRATEGIES.hybrid.strategyId,
      },
      { signal: preAborted.signal },
    );
    expect(cancelled).toMatchObject({ ok: false, error: { code: "cancelled", retryable: true } });
    const conservativeCancelled = await tools().searchSessions(
      {
        query: "release research",
        strategy: SESSION_RETRIEVAL_STRATEGIES.conservative.strategyId,
      },
      { signal: preAborted.signal },
    );
    expect(conservativeCancelled).toMatchObject({
      ok: false,
      error: { code: "cancelled", retryable: true },
    });

    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blockingHistory: HistoryPort = {
      ...history,
      search: async (request) => {
        await blocked;
        return await history.search(request);
      },
    };
    const controller = new AbortController();
    const pending = createSessionSearchTools({
      workspace,
      history: blockingHistory,
      authorization: { currentSessionId: "session-b" },
      refreshBeforeSearch: false,
    }).searchSessions(
      {
        query: "release research",
        strategy: SESSION_RETRIEVAL_STRATEGIES.hybrid.strategyId,
      },
      { signal: controller.signal },
    );
    controller.abort();
    release?.();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "cancelled" } });

    const failingHistory: HistoryPort = {
      ...history,
      search: async () => {
        throw new Error("injected search failure");
      },
    };
    const failed = await createSessionSearchTools({
      workspace,
      history: failingHistory,
      authorization: { currentSessionId: "session-b" },
      refreshBeforeSearch: false,
    }).searchSessions({
      query: "release research",
      strategy: SESSION_RETRIEVAL_STRATEGIES.hybrid.strategyId,
    });
    expect(failed).toMatchObject({ ok: false, error: { code: "backend_failure", retryable: true } });
  });

  async function putCompletedExperiment(input: {
    readonly experimentId: string;
    readonly hypothesis: string;
    readonly scope: string;
    readonly outcome: "keep" | "revise" | "revert";
    readonly evidenceRefs: Experiment["evidenceRefs"];
  }): Promise<void> {
    const baseline = revision(`${input.experimentId}-baseline`);
    const candidate = revision(`${input.experimentId}-candidate`);
    const base = {
      experimentId: input.experimentId,
      hypothesis: input.hypothesis,
      scope: input.scope,
      evidenceRefs: input.evidenceRefs,
      baselineRevision: baseline,
      candidateRevisions: [candidate],
      feedbackSignalIds: [],
    } as const;
    await workspace.research.experiments.putExperiment({ ...base, status: "hypothesis" });
    await workspace.research.experiments.putExperiment({ ...base, status: "authoring" });
    await workspace.research.experiments.putExperiment({ ...base, status: "preflight" });
    await workspace.research.experiments.putExperiment({ ...base, status: "observing" });
    await workspace.research.experiments.putExperiment({
      ...base,
      status: "completed",
      outcome: input.outcome,
    });
  }
});

function revision(id: string): CapabilityRevisionRef {
  return {
    kind: "capability_revision",
    capabilityId: "research",
    capabilityRevisionId: id,
    bundleDigest: sha256(id),
  };
}
