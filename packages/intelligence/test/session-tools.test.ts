import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256 } from "@noesis/domain";
import { createWorkspaceStore, type NoesisWorkspaceStore } from "@noesis/workspace";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createHistoryPort,
  createSessionSearchTools,
  type HistoryPort,
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
      maxExcerptChars: 256,
      includePrivate: true,
      updatedAt: later,
    });
    history = createHistoryPort({ workspace });
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

  test("Session B retrieves cited public evidence from Session A without private injection", async () => {
    const sessionTools = tools({
      currentSessionId: "session-b",
      privateSessionIds: ["session-a"],
    });
    const search = await sessionTools.searchSessions({
      query: "preserve voice exact citations release research",
      maxResults: 8,
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
  });

  test("searches only prior session-linked evidence by default", async () => {
    await workspace.operational.toolCalls.put({
      toolCallId: "tool-call-current-evidence",
      sessionId: "session-b",
      toolName: "shell.run",
      request: Object.freeze({ command: "inspect release artifact" }),
      response: Object.freeze({ stderr: "obsidian linker failure sentinel" }),
      status: "failed",
      sensitivity: "normal",
      createdAt: later,
      completedAt: later,
    });
    const automatic = await tools().searchSessions({ query: "marigold continuity note" });
    expect(automatic.ok).toBe(true);
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
      scope: "current",
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

    const currentToolEvidence = await tools().searchSessions({
      query: "obsidian linker failure sentinel",
      scope: "current",
    });
    expect(currentToolEvidence.ok).toBe(true);
    if (!currentToolEvidence.ok) return;
    expect(
      currentToolEvidence.value.fragments.some(
        (fragment) =>
          fragment.citation.identity.kind === "tool_call" &&
          fragment.citation.identity.toolCallId === "tool-call-current-evidence",
      ),
    ).toBe(true);

    const ambiguousScope = await tools().searchSessions({
      query: "marigold continuity note",
      sessionId: "session-b",
      scope: "current",
    });
    expect(ambiguousScope).toMatchObject({ ok: false, error: { code: "invalid_input" } });
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

  test("authorizes opening a whole session under the search rules", async () => {
    const sessionTools = tools({ currentSessionId: "session-b" });
    await expect(
      sessionTools.authorizeOpenSession({ sessionId: "session-b", includePrivate: true }),
    ).resolves.toEqual({
      ok: true,
      value: { sessionId: "session-b", includePrivate: true },
    });
    await expect(sessionTools.authorizeOpenSession({ sessionId: "session-a" })).resolves.toEqual({
      ok: true,
      value: { sessionId: "session-a", includePrivate: false },
    });
    await expect(
      sessionTools.authorizeOpenSession({ sessionId: "session-a", includePrivate: true }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unauthorized" } });
    await expect(sessionTools.authorizeOpenSession({ sessionId: "missing" })).resolves.toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    await expect(sessionTools.authorizeOpenSession({ sessionId: "" })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    await workspace.operational.sessions.delete("session-a", "2026-11-02T00:00:00.000Z");
    await expect(sessionTools.authorizeOpenSession({ sessionId: "session-a" })).resolves.toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
  test("requires explicit session authorization for private search and never returns secret evidence", async () => {
    const denied = await tools().searchSessions({
      query: "acquisition zephyr",
      sessionId: "session-private",
      includePrivate: true,
    });
    expect(denied).toMatchObject({ ok: false, error: { code: "unauthorized" } });

    const allowed = await tools({
      currentSessionId: "session-b",
      privateSessionIds: ["session-private"],
    }).searchSessions({
      query: "acquisition zephyr",
      sessionId: "session-private",
      includePrivate: true,
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
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fragments.every((fragment) => fragment.content.length <= 40)).toBe(true);
    expect(
      result.value.fragments.reduce((sum, fragment) => sum + fragment.content.length, 0),
    ).toBeLessThanOrEqual(70);
    expect(result.value.telemetry.contextCharacters).toBeLessThanOrEqual(70);
  });

  test("reserves context for opening evidence after search snippets consume their allowance", async () => {
    const sessionTools = tools(
      { currentSessionId: "session-b" },
      { maxFragmentChars: 40, maxTotalContextChars: 40, maxOpenChars: 40, maxResults: 8 },
    );
    const search = await sessionTools.searchSessions({
      query: "release research citations preserve voice",
      maxResults: 8,
    });
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    expect(search.value.fragments.reduce((sum, fragment) => sum + fragment.content.length, 0)).toBe(20);
    const citation = search.value.fragments[0]?.citation;
    if (!citation) throw new Error("Expected one bounded search citation");

    const opened = await sessionTools.openSessionEvidence({
      citation,
      beforeChars: 100,
      afterChars: 100,
      maxChars: 40,
    });
    expect(opened).toMatchObject({ ok: true });
    if (!opened.ok) return;
    expect(opened.value.fragment.content.length).toBeGreaterThan(0);
    expect(opened.value.fragment.content.length).toBeLessThanOrEqual(20);
  });

  test("keeps generic private-by-provenance evidence out of results", async () => {
    await Promise.all([
      workspace.operational.messages.put({
        messageId: "message-violet-public-one",
        sessionId: "session-a",
        role: "user",
        content: "Violet continuity public alternative one.",
        sensitivity: "normal",
        createdAt,
        metadata: {},
      }),
      workspace.operational.messages.put({
        messageId: "message-violet-public-two",
        sessionId: "session-a",
        role: "user",
        content: "Violet continuity public alternative two.",
        sensitivity: "normal",
        createdAt,
        metadata: {},
      }),
    ]);
    await workspace.evidence.appendEvidence({
      workingPath: "session-private/violet-private-evidence.txt",
      bytes: Buffer.from("Violet continuity private late provenance payload."),
      actor: { actorId: "test", kind: "system" },
      evidenceKind: "output",
      sensitivity: "normal",
      provenanceRefs: [{ kind: "database_row", table: "messages", rowId: "message-private" }],
    });

    const result = await tools(
      { currentSessionId: "session-b" },
      { maxResults: 4, maxCandidates: 16 },
    ).searchSessions({
      query: "violet continuity provenance",
      maxResults: 4,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fragments.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.value)).not.toContain("private late provenance payload");
  });

  test("filters similar tasks by authoritative type", async () => {
    const similar = await tools().findSimilarTasks({
      description: "source grounded release research",
    });
    expect(similar.ok).toBe(true);
    if (similar.ok)
      expect(
        similar.value.fragments.every(
          (fragment) =>
            fragment.citation.identity.kind === "session" || fragment.citation.identity.kind === "outcome",
        ),
      ).toBe(true);
  });

  test("filters similar tasks before the result bound", async () => {
    const similar = await tools(
      { currentSessionId: "session-b" },
      { maxResults: 1, maxCandidates: 8 },
    ).findSimilarTasks({
      description: "release research exact citations",
      maxResults: 1,
    });
    expect(similar.ok).toBe(true);
    if (!similar.ok) return;
    expect(similar.value.fragments).toHaveLength(1);
    expect(["session", "outcome"]).toContain(similar.value.fragments[0]?.citation.identity.kind);
  });

  test("retains outcome-linked file revisions in exact and previous-session scopes", async () => {
    await workspace.operational.outcomes.put({
      outcomeId: "outcome-cobalt",
      sessionId: "session-a",
      status: "accepted",
      summary: "The cobalt decision artifact was accepted.",
      sensitivity: "normal",
      createdAt: later,
      metadata: {},
    });
    const evidence = await workspace.evidence.appendEvidence({
      workingPath: "session-a/cobalt-decision.txt",
      bytes: Buffer.from("Cobalt decision artifact retained through outcome provenance only."),
      actor: { actorId: "test", kind: "system" },
      evidenceKind: "output",
      sensitivity: "normal",
      provenanceRefs: [{ kind: "database_row", table: "outcomes", rowId: "outcome-cobalt" }],
    });
    const includesEvidence = (result: Awaited<ReturnType<SessionSearchTools["searchSessions"]>>) =>
      result.ok &&
      result.value.fragments.some(
        (fragment) =>
          fragment.citation.identity.kind === "evidence_revision" &&
          fragment.citation.identity.evidenceRevisionId === evidence.revisionId,
      );

    const exact = await tools().searchSessions({
      query: "cobalt decision artifact outcome provenance",
      sessionId: "session-a",
      maxResults: 8,
    });
    expect(includesEvidence(exact)).toBe(true);

    const previous = await tools().searchSessions({
      query: "cobalt decision artifact outcome provenance",
      maxResults: 8,
    });
    expect(includesEvidence(previous)).toBe(true);
  });

  test("searches and exactly reopens bounded citations for more than 64 provenance references", async () => {
    const provenanceRefs: Array<{
      readonly kind: "database_row";
      readonly table: "messages";
      readonly rowId: string;
    }> = [];
    for (let index = 0; index < 65; index += 1) {
      const messageId = `message-large-provenance-${index}`;
      await workspace.operational.messages.put({
        messageId,
        sessionId: "session-a",
        role: "user",
        content: `Large provenance anchor ${index}.`,
        sensitivity: index === 64 ? "private" : "normal",
        createdAt,
        metadata: {},
      });
      provenanceRefs.push({ kind: "database_row", table: "messages", rowId: messageId });
    }
    const evidence = await workspace.evidence.appendEvidence({
      workingPath: "session-a/large-provenance-evidence.txt",
      bytes: Buffer.from("Topaz provenance projection remains exactly reopenable."),
      actor: { actorId: "test", kind: "system" },
      evidenceKind: "output",
      sensitivity: "normal",
      provenanceRefs,
    });
    const sessionTools = tools({
      currentSessionId: "session-b",
      privateSessionIds: ["session-a"],
    });
    const search = await sessionTools.searchSessions({
      query: "Topaz provenance projection exactly reopenable",
      sessionId: "session-a",
      maxResults: 4,
      includePrivate: true,
    });
    if (!search.ok) throw new Error(JSON.stringify(search.error));
    expect(search).toMatchObject({ ok: true });
    const fragment = search.value.fragments.find(
      (candidate) =>
        candidate.citation.identity.kind === "evidence_revision" &&
        candidate.citation.identity.evidenceRevisionId === evidence.revisionId,
    );
    expect(fragment?.citation.provenanceRefs).toHaveLength(64);
    expect(fragment?.citation.provenanceProjection).toEqual({
      truncated: true,
      totalCount: 65,
      fullDigest: sha256(canonicalJson(provenanceRefs)),
    });
    expect(fragment?.citation.messageIds).toHaveLength(32);
    expect(fragment?.citation.messageIdsProjection).toEqual({
      truncated: true,
      totalCount: 65,
      fullDigest: sha256(canonicalJson(provenanceRefs.map((ref) => ref.rowId).sort())),
    });
    expect(fragment?.citation.sensitivity).toBe("private");
    if (!fragment) throw new Error("Expected large-provenance evidence citation");
    await expect(sessionTools.openSessionEvidence({ citation: fragment.citation })).resolves.toMatchObject({
      ok: true,
      value: { fragment: { content: "Topaz provenance projection remains exactly reopenable." } },
    });

    const { citationDigest: _citationDigest, ...unsigned } = fragment.citation;
    const projection = fragment.citation.provenanceProjection;
    if (!projection) throw new Error("Expected a bounded provenance projection");
    const tamperedUnsigned = {
      ...unsigned,
      provenanceProjection: { ...projection, totalCount: projection.totalCount + 1 },
    };
    await expect(
      sessionTools.openSessionEvidence({
        citation: {
          ...tamperedUnsigned,
          citationDigest: sha256(canonicalJson(tamperedUnsigned)),
        },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "stale_citation" } });

    const legacySearch = await sessionTools.searchSessions({
      query: "Public evidence revision canonical citations",
      sessionId: "session-a",
      maxResults: 4,
    });
    expect(legacySearch.ok).toBe(true);
    if (!legacySearch.ok) return;
    const legacy = legacySearch.value.fragments.find(
      (candidate) => candidate.citation.identity.kind === "evidence_revision",
    );
    expect(legacy?.citation.provenanceProjection).toBeUndefined();
    if (!legacy) throw new Error("Expected a legacy bounded provenance citation");
    await expect(sessionTools.openSessionEvidence({ citation: legacy.citation })).resolves.toMatchObject({
      ok: true,
    });

    await writeFile(join(root, evidence.snapshotPath), "Changed authoritative snapshot bytes.");
    await expect(sessionTools.openSessionEvidence({ citation: fragment.citation })).resolves.toMatchObject({
      ok: false,
      error: { code: "stale_citation" },
    });
  });

  describe("plain keyword search", () => {
    const putMessage = async (messageId: string, content: string, at = createdAt) =>
      await workspace.operational.messages.put({
        messageId,
        sessionId: "session-a",
        role: "user",
        content,
        sensitivity: "normal",
        createdAt: at,
        metadata: {},
      });
    const messageIds = (result: Awaited<ReturnType<SessionSearchTools["searchSessions"]>>) =>
      result.ok
        ? result.value.fragments.flatMap((fragment) =>
            fragment.citation.identity.kind === "message" ? [fragment.citation.identity.messageId] : [],
          )
        : [];

    test("matches stemmed words and centers the excerpt on the match", async () => {
      const padding = "unrelated filler sentence ".repeat(100);
      await putMessage("message-stemmed", `${padding}We deployed the quokka gateways yesterday. ${padding}`);

      const result = await tools().searchSessions({ query: "deploying quokka gateway" });

      expect(messageIds(result)).toEqual(["message-stemmed"]);
      if (!result.ok) return;
      expect(result.value.fragments[0]?.content).toContain("deployed the quokka gateways");
    });

    test("treats double-quoted text as one exact phrase", async () => {
      await putMessage("message-phrase", "The ocelot harbor plan is final.");
      await putMessage("message-apart", "The harbor saw an ocelot on the plan.");

      expect(messageIds(await tools().searchSessions({ query: '"ocelot harbor"' }))).toEqual([
        "message-phrase",
      ]);
      expect(messageIds(await tools().searchSessions({ query: "ocelot harbor" })).toSorted()).toEqual([
        "message-apart",
        "message-phrase",
      ]);
    });

    test("ignores query text FTS5 would treat as syntax", async () => {
      await putMessage("message-syntax", "The wombat NEAR the fence ate (carefully).");

      for (const query of ['wombat"', '"wombat', "wombat AND", "wombat* (--- NEAR", 'wombat "---"'])
        expect(messageIds(await tools().searchSessions({ query }))[0]).toBe("message-syntax");
    });

    test("ranks a document matching more of the query above one matching less", async () => {
      await putMessage("message-one-term", "A lone pangolin walked past.");
      await putMessage("message-both-terms", "A pangolin crossed the marsh.");

      const result = await tools().searchSessions({ query: "pangolin marsh" });

      expect(messageIds(result)[0]).toBe("message-both-terms");
      if (!result.ok) return;
      const scores = result.value.hits.map((hit) => hit.score);
      expect(scores[0]).toBeGreaterThan(scores[1] ?? Number.POSITIVE_INFINITY);
    });

    test("filters by date range with an inclusive start and an exclusive end", async () => {
      await putMessage("message-march", "Lemur note from March.", "2026-03-10T12:00:00.000Z");
      await putMessage("message-april", "Lemur note from April.", "2026-04-10T12:00:00.000Z");
      await putMessage("message-may", "Lemur note from May.", "2026-05-01T00:00:00.000Z");

      const ids = async (bounds: { readonly after?: string; readonly before?: string }) =>
        messageIds(await tools().searchSessions({ query: "lemur", ...bounds })).toSorted();

      expect(await ids({ after: "2026-04-01" })).toEqual(["message-april", "message-may"]);
      expect(await ids({ before: "2026-05-01" })).toEqual(["message-april", "message-march"]);
      expect(await ids({ after: "2026-03-10T12:00:00Z", before: "2026-04-01T00:00:00+05:30" })).toEqual([
        "message-march",
      ]);
      expect(
        await tools().searchSessions({ query: "lemur", after: "2026-05-01", before: "2026-04-01" }),
      ).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await tools().searchSessions({ query: "lemur", after: "last week" })).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    });

    test("filters by message or tool output", async () => {
      await putMessage("message-tapir", "The tapir message.");
      await workspace.operational.toolCalls.put({
        toolCallId: "tool-tapir",
        sessionId: "session-a",
        toolName: "shell.run",
        request: Object.freeze({ command: "echo tapir" }),
        response: Object.freeze({ stdout: "tapir" }),
        status: "completed",
        sensitivity: "normal",
        createdAt,
        completedAt: later,
      });
      const kinds = async (source?: "message" | "tool_output") => {
        const result = await tools().searchSessions(
          source === undefined ? { query: "tapir" } : { query: "tapir", source },
        );
        return result.ok ? result.value.fragments.map((fragment) => fragment.citation.identity.kind) : [];
      };

      expect((await kinds()).toSorted()).toEqual(["message", "tool_call"]);
      expect(await kinds("message")).toEqual(["message"]);
      expect(await kinds("tool_output")).toEqual(["tool_call"]);
    });

    test("runs one index rebuild for a fan-out of queries", async () => {
      let rebuilds = 0;
      const counted: HistoryPort = {
        ...history,
        rebuild: async () => {
          rebuilds += 1;
          return await history.rebuild();
        },
      };
      const turn = createSessionSearchTools({
        workspace,
        history: counted,
        authorization: { currentSessionId: "session-b" },
      });

      await Promise.all(["release", "research", "citations"].map((query) => turn.searchSessions({ query })));

      expect(rebuilds).toBe(1);
    });

    test("keeps enough budget for a fan-out and reports when the budget withholds results", async () => {
      await workspace.operational.searchConfiguration.put({
        lexicalLimit: 32,
        maxExcerptChars: 1200,
        includePrivate: true,
        updatedAt: later,
      });
      await Promise.all(
        Array.from({ length: 24 }, async (_, index) => {
          const padding = "budget filler words ".repeat(25);
          await putMessage(`message-gecko-${String(index)}`, `Gecko ${padding}`);
          await putMessage(`message-newt-${String(index)}`, `Newt ${padding}`);
          await putMessage(`message-skink-${String(index)}`, `Skink ${padding}`);
          await putMessage(`message-iguana-${String(index)}`, `Iguana ${padding}`);
          await putMessage(`message-anole-${String(index)}`, `Anole ${padding}`);
        }),
      );
      const turn = tools();

      const results = await Promise.all(
        ["gecko", "newt", "skink", "iguana", "anole"].map(
          async (query) => await turn.searchSessions({ query }),
        ),
      );

      const values = results.flatMap((result) => (result.ok ? [result.value] : []));
      expect(values).toHaveLength(5);
      expect(values.slice(0, 3).map((value) => value.fragments.length)).toEqual([20, 20, 20]);
      expect(values.slice(0, 3).every((value) => value.telemetry.status === "completed")).toBe(true);
      const withheld = values.at(-1);
      expect(withheld?.telemetry.status).toBe("budget_exhausted");
      expect(withheld?.telemetry.omittedResults).toBeGreaterThan(0);
      expect(values.reduce((sum, value) => sum + value.telemetry.contextCharacters, 0)).toBeLessThanOrEqual(
        32768,
      );
    });
  });

  test("returns typed validation, cancellation, and backend errors", async () => {
    const invalid = await tools().searchSessions({ query: "" });
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_input", retryable: false } });

    const preAborted = new AbortController();
    preAborted.abort();
    const cancelled = await tools().searchSessions(
      {
        query: "release research",
      },
      { signal: preAborted.signal },
    );
    expect(cancelled).toMatchObject({ ok: false, error: { code: "cancelled", retryable: true } });

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
    });
    expect(failed).toMatchObject({ ok: false, error: { code: "backend_failure", retryable: true } });
  });
});
