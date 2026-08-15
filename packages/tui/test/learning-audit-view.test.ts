import { describe, expect, test } from "vitest";
import {
  citedCountSentence,
  cycleDetailFocus,
  detailDocument,
  filterChips,
  formatExactTime,
  formatRelativeTime,
  headlineStats,
  interactableStops,
  isNoteworthy,
  isQuietFailure,
  listViewport,
  navigableRecords,
  nextGroupFilter,
  sectionRevealLine,
  toggleAllActivity,
  wrapDocument,
} from "../src/learning-audit-view.ts";
import type { TuiLearningPrimitive } from "../src/runtime-port.ts";

function record(
  input: Partial<TuiLearningPrimitive> & Pick<TuiLearningPrimitive, "id" | "kind" | "group" | "title">,
): TuiLearningPrimitive {
  return Object.freeze({
    status: "recorded",
    tone: "neutral",
    summary: "summary",
    evidence: Object.freeze([]),
    evidencePreviews: Object.freeze([]),
    consideredEvidenceCount: 0,
    consideredEvidencePreviews: Object.freeze([]),
    relations: Object.freeze([]),
    detailSections: Object.freeze([]),
    rawJson: "{}",
    ...input,
  });
}

describe("learning audit view helpers", () => {
  test("keeps the default list to lessons and attention, not supporting audit rows", () => {
    expect(
      isNoteworthy(
        record({
          id: "reflection:1",
          kind: "reflection",
          group: "reflection",
          title: "Applied",
        }),
      ),
    ).toBe(true);
    expect(
      isNoteworthy(
        record({
          id: "reflection:quiet",
          kind: "reflection",
          group: "reflection",
          title: "No lasting change",
          status: "no_change",
        }),
      ),
    ).toBe(false);
    expect(
      isNoteworthy(
        record({
          id: "working_adjustment:active",
          kind: "working_adjustment",
          group: "changes",
          title: "Keep review constraints",
          tone: "active",
        }),
      ),
    ).toBe(true);
    expect(
      isNoteworthy(
        record({
          id: "working_adjustment:old",
          kind: "working_adjustment",
          group: "changes",
          title: "Old strategy",
        }),
      ),
    ).toBe(false);
    expect(
      isNoteworthy(
        record({
          id: "trial:1",
          kind: "trial",
          group: "evaluation",
          title: "baseline trial",
        }),
      ),
    ).toBe(false);
    expect(
      isNoteworthy(
        record({
          id: "trial:failed",
          kind: "trial",
          group: "evaluation",
          title: "candidate trial",
          tone: "negative",
        }),
      ),
    ).toBe(true);
    expect(
      isNoteworthy(
        record({
          id: "feedback_signal:1",
          kind: "feedback_signal",
          group: "feedback",
          title: "correction",
        }),
      ),
    ).toBe(false);
  });

  test("separates all-activity toggle from group cycling", () => {
    expect(toggleAllActivity("noteworthy")).toBe("all");
    expect(toggleAllActivity("all")).toBe("noteworthy");
    expect(toggleAllActivity("memory")).toBe("noteworthy");
    expect(nextGroupFilter("noteworthy")).toBe("memory");
    expect(nextGroupFilter("memory")).toBe("reflection");
    expect(nextGroupFilter("operations")).toBe("memory");
  });

  test("tucks failed reflections behind a quiet expandable section", () => {
    const failed = record({
      id: "reflection:failed",
      kind: "reflection",
      group: "reflection",
      title: "Reflection failed",
      tone: "negative",
      occurredAt: "2026-08-14T00:00:03.000Z",
    });
    const lesson = record({
      id: "reflection:1",
      kind: "reflection",
      group: "reflection",
      title: "Applied",
      tone: "positive",
      occurredAt: "2026-08-14T00:00:02.000Z",
    });
    const experiment = record({
      id: "experiment:1",
      kind: "experiment",
      group: "changes",
      title: "Prefer narrow research",
      occurredAt: "2026-08-14T00:00:01.000Z",
    });
    expect(isQuietFailure(failed)).toBe(true);
    expect(isQuietFailure(lesson)).toBe(false);
    expect(navigableRecords([failed, experiment, lesson], false).map((item) => item.id)).toEqual([
      "reflection:1",
      "experiment:1",
    ]);
    expect(navigableRecords([failed, experiment, lesson], true).map((item) => item.id)).toEqual([
      "reflection:1",
      "experiment:1",
      "reflection:failed",
    ]);
  });

  test("formats relative time and exact UTC timestamps", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    expect(formatRelativeTime("2026-08-14T11:59:58.000Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-08-14T11:59:00.000Z", now)).toBe("1m ago");
    expect(formatRelativeTime("2026-08-14T00:00:02.000Z", now)).toBe("12h ago");
    expect(formatRelativeTime(undefined, now)).toBeUndefined();
    expect(formatExactTime("2026-08-14T00:00:02.000Z")).toBe("2026-08-14 00:00:02 UTC");
    expect(formatExactTime(undefined)).toBeUndefined();
  });

  test("uses singular grammar for a single cited input", () => {
    expect(citedCountSentence(25, 1)).toBe("25 inputs were reviewed; 1 was cited for the decision.");
    expect(citedCountSentence(1, 1)).toBe("1 input was reviewed; 1 was cited for the decision.");
  });

  test("teaches status glyphs and marks the active filter", () => {
    expect(
      headlineStats(
        [
          record({
            id: "working_adjustment:1",
            kind: "working_adjustment",
            group: "changes",
            title: "Keep review constraints",
            tone: "active",
          }),
          record({
            id: "reflection:quiet",
            kind: "reflection",
            group: "reflection",
            title: "No lasting change",
            status: "no_change",
          }),
          record({
            id: "reflection:failed",
            kind: "reflection",
            group: "reflection",
            title: "Reflection failed",
            tone: "negative",
          }),
        ],
        false,
      ),
    ).toBe("◆ 1 active   — 1 routine");
    expect(filterChips("noteworthy", false)).toContain("[noteworthy]");
    expect(filterChips("noteworthy", false)).toContain("all");
    expect(filterChips("all", false)).toContain("[all]");
  });

  test("keeps the selected grouped record visible in one- and two-row viewports", () => {
    const records = [
      record({
        id: "reflection:1",
        kind: "reflection",
        group: "reflection",
        title: "First decision",
      }),
      record({
        id: "experiment:1",
        kind: "experiment",
        group: "changes",
        title: "Selected experiment",
        summary: "Selected experiment detail",
      }),
    ];
    const options = Object.freeze({
      grouped: true,
      failedCount: 0,
      failedExpanded: false,
    });
    const now = new Date("2026-08-14T12:00:00.000Z");

    const oneRow = listViewport(records, 1, 80, 1, false, now, undefined, options);
    expect(oneRow).toHaveLength(1);
    expect(oneRow[0]).toContain("› ◆ Selected experiment");

    const twoRows = listViewport(records, 1, 80, 2, false, now, undefined, options);
    expect(twoRows).toHaveLength(2);
    expect(twoRows[0]).toContain("› ◆ Selected experiment");
    expect(twoRows[1]).toContain("Selected experiment detail");
  });

  test("pretty-prints the raw JSON projection", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    expect(
      detailDocument(
        record({
          id: "experiment:1",
          kind: "experiment",
          group: "changes",
          title: "Prefer narrow research",
          rawJson: '{"hypothesis":"Use narrower research first"}',
        }),
        true,
        0,
        80,
        false,
        now,
        "document",
        false,
        false,
      ).join("\n"),
    ).toContain('  "hypothesis": "Use narrower research first"');
  });

  test("shows a few considered inputs and expands to a bounded remainder", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const subject = record({
      id: "reflection:1",
      kind: "reflection",
      group: "reflection",
      title: "Prefer adapt",
      evidence: Object.freeze(["messages:1"]),
      evidencePreviews: Object.freeze([
        Object.freeze({
          identity: "messages:1",
          label: "USER",
          excerpt: "cited user request",
          redacted: false,
        }),
      ]),
      consideredEvidenceCount: 25,
      consideredEvidencePreviews: Object.freeze([
        Object.freeze({
          identity: "a",
          label: "TOOL",
          excerpt: "first input preview",
          redacted: false,
        }),
        Object.freeze({
          identity: "b",
          label: "USER",
          excerpt: "second input preview",
          redacted: false,
        }),
        Object.freeze({
          identity: "c",
          label: "TOOL",
          excerpt: "third input preview",
          redacted: false,
        }),
      ]),
    });
    expect(interactableStops(subject)).toEqual(["inputs"]);
    const collapsed = detailDocument(subject, false, 0, 80, false, now, "document", false, false).join("\n");
    expect(collapsed).toContain("first input preview");
    expect(collapsed).toContain("second input preview");
    expect(collapsed).not.toContain("third input preview");
    expect(collapsed).not.toContain("more exact references in raw");
    expect(collapsed).toContain("Tab to choose");
    const expanded = detailDocument(subject, false, 0, 80, false, now, "inputs", false, true).join("\n");
    expect(expanded).toContain("third input preview");
    expect(expanded).toContain("+ 22 more exact references in raw");
    expect(expanded).toContain("Enter hides");
    const withEvidence = record({
      ...subject,
      evidence: Object.freeze(["a", "b", "c", "d"]),
      evidencePreviews: Object.freeze([
        Object.freeze({ identity: "a", label: "USER", excerpt: "first cited preview", redacted: false }),
        Object.freeze({ identity: "b", label: "USER", excerpt: "second cited preview", redacted: false }),
        Object.freeze({ identity: "c", label: "USER", excerpt: "third cited preview", redacted: false }),
      ]),
      relations: Object.freeze([{ label: "experiment", targetId: "experiment:1" }]),
    });
    expect(interactableStops(withEvidence)).toEqual(["evidence", "inputs", "related"]);
    expect(cycleDetailFocus(withEvidence, "document")).toBe("evidence");
    expect(cycleDetailFocus(withEvidence, "related")).toBe("evidence");
    expect(cycleDetailFocus(withEvidence, "evidence", true)).toBe("related");
    const citedCollapsed = detailDocument(
      withEvidence,
      false,
      0,
      80,
      false,
      now,
      "document",
      false,
      false,
    ).join("\n");
    expect(citedCollapsed).toContain("first cited preview");
    expect(citedCollapsed).toContain("second cited preview");
    expect(citedCollapsed).not.toContain("third cited preview");
    const citedExpanded = detailDocument(
      withEvidence,
      false,
      0,
      80,
      false,
      now,
      "evidence",
      true,
      false,
    ).join("\n");
    expect(citedExpanded).toContain("third cited preview");
    expect(citedExpanded).toContain("+ 1 more exact references in raw");
    expect(citedExpanded).toContain("Enter hides");
  });

  test("offers expansion only when additional readable previews exist", () => {
    const unavailable = record({
      id: "reflection:unavailable-previews",
      kind: "reflection",
      group: "reflection",
      title: "No readable previews",
      evidence: Object.freeze(["messages:1", "messages:2", "messages:3"]),
      consideredEvidenceCount: 25,
    });

    expect(interactableStops(unavailable)).toEqual([]);
    expect(
      detailDocument(
        unavailable,
        false,
        0,
        80,
        false,
        new Date("2026-08-14T12:00:00.000Z"),
        "document",
        false,
        false,
      ).join("\n"),
    ).not.toContain("Enter expands");
  });

  test("reveals an expanded section tail when its raw-reference marker wraps", () => {
    const subject = record({
      id: "reflection:wrapped-tail",
      kind: "reflection",
      group: "reflection",
      title: "Wrapped expansion tail",
      consideredEvidenceCount: 25,
      consideredEvidencePreviews: Object.freeze([
        Object.freeze({ identity: "a", label: "TOOL", excerpt: "first preview", redacted: false }),
        Object.freeze({ identity: "b", label: "USER", excerpt: "second preview", redacted: false }),
        Object.freeze({ identity: "c", label: "TOOL", excerpt: "third preview", redacted: false }),
      ]),
    });
    const document = wrapDocument(
      detailDocument(
        subject,
        false,
        0,
        24,
        false,
        new Date("2026-08-14T12:00:00.000Z"),
        "inputs",
        false,
        true,
      ),
      24,
    );
    const section = sectionRevealLine(document, "INPUTS CONSIDERED · ", false);
    const revealed = sectionRevealLine(document, "INPUTS CONSIDERED · ", true);

    expect(section).toBeGreaterThanOrEqual(0);
    expect(revealed).toBeGreaterThan(section);
    expect(document[revealed]).toContain("raw");
  });
});
