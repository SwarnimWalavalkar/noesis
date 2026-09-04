import { canonicalJson, sha256 } from "@noesis/domain";
import { describe, expect, test } from "vitest";
import {
  type FrozenTurnPlan,
  frozenTurnPlanDigest,
  renderFrozenContextNotebook,
  validateFrozenTurnPlan,
} from "../src/index.ts";

describe("frozen context notebook", () => {
  test("rejects omission metadata on a lone legacy compatibility snapshot", () => {
    expect(() =>
      renderFrozenContextNotebook(
        Object.freeze([
          Object.freeze({
            checkpointId: "legacy-checkpoint",
            summaryKind: "legacy_snapshot" as const,
            summary: "[CONTEXT CHECKPOINT — REFERENCE ONLY]\nLegacy continuity.",
            createdAt: "2026-09-04T11:00:00.000Z",
          }),
        ]),
        1,
      ),
    ).toThrow("A lone legacy context snapshot cannot omit note windows");
  });

  test("rejects aggregate context unrelated to its pinned notes", () => {
    const noteSummary = "[CONTEXT NOTE DELTA — REFERENCE ONLY]\n- [fact] The copper check passed.";
    const notes = Object.freeze([
      Object.freeze({
        checkpointId: "checkpoint-1",
        checkpointRef: Object.freeze({
          kind: "database_row" as const,
          table: "context_checkpoints" as const,
          rowId: "checkpoint-1",
        }),
        summaryKind: "note_delta" as const,
        summary: noteSummary,
        summaryDigest: sha256(noteSummary),
        sourceDigest: sha256("source-1"),
        sensitivity: "normal" as const,
        createdAt: "2026-09-04T12:00:00.000Z",
      }),
    ]);
    const notebook = renderFrozenContextNotebook(notes, 0);
    const sourceDigest = sha256(
      canonicalJson(
        notes.map((note) => ({
          checkpointId: note.checkpointId,
          summaryKind: note.summaryKind,
          summaryDigest: note.summaryDigest,
          sourceDigest: note.sourceDigest,
        })),
      ),
    );
    const contextCheckpoint = Object.freeze({
      checkpointId: "checkpoint-1",
      checkpointRef: Object.freeze({
        kind: "database_row" as const,
        table: "context_checkpoints" as const,
        rowId: "checkpoint-1",
      }),
      summary: notebook,
      summaryDigest: sha256(notebook),
      sourceDigest,
      sensitivity: "normal" as const,
      createdAt: "2026-09-04T12:00:00.000Z",
      notes,
      omittedNoteCount: 0,
    });
    const unsigned: Omit<FrozenTurnPlan, "canonicalDigest"> = Object.freeze({
      schemaVersion: 1,
      planId: "plan-1",
      sessionId: "session-1",
      turnId: "turn-1",
      activationId: "activation-1",
      activationRevision: 1,
      selectedCapabilities: Object.freeze([]),
      contextCheckpoint,
      contextTokenBudget: 10_000,
      requestTokenBudget: 20_000,
      renderedSystemPrompt: "Follow the current user request.",
      provider: "controlled",
      model: "controlled",
      thinkingLevel: "off",
      permissionSnapshot: Object.freeze({
        effects: Object.freeze([]),
        resourcePatterns: Object.freeze([]),
        credentialRefs: Object.freeze([]),
      }),
      retrievalCitations: Object.freeze([]),
      routing: Object.freeze({ strategyId: "baseline", reason: "test fixture" }),
      createdAt: "2026-09-04T12:00:01.000Z",
    });
    const valid = Object.freeze({ ...unsigned, canonicalDigest: frozenTurnPlanDigest(unsigned) });
    expect(validateFrozenTurnPlan(valid).contextCheckpoint?.summary).toBe(notebook);

    const unrelatedSummary = "An unrelated but self-consistent context projection.";
    const tamperedUnsigned: Omit<FrozenTurnPlan, "canonicalDigest"> = Object.freeze({
      ...unsigned,
      contextCheckpoint: Object.freeze({
        ...contextCheckpoint,
        summary: unrelatedSummary,
        summaryDigest: sha256(unrelatedSummary),
      }),
    });
    const tampered = Object.freeze({
      ...tamperedUnsigned,
      canonicalDigest: frozenTurnPlanDigest(tamperedUnsigned),
    });
    expect(() => validateFrozenTurnPlan(tampered)).toThrow("context notebook failed rendering verification");
  });
});
