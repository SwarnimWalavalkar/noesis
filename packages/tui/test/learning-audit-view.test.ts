import { describe, expect, test } from "vitest";
import {
  citedCountSentence,
  filterChips,
  formatExactTime,
  formatRelativeTime,
  headlineStats,
  isNoteworthy,
  isQuietFailure,
  navigableRecords,
  nextGroupFilter,
  toggleAllActivity,
} from "../src/learning-audit-view.ts";
import type { TuiLearningPrimitive } from "../src/runtime-port.ts";

function record(
  input: Partial<TuiLearningPrimitive> &
    Pick<TuiLearningPrimitive, "id" | "kind" | "group" | "title">,
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
    expect(
      navigableRecords([failed, experiment, lesson], false).map(
        (item) => item.id,
      ),
    ).toEqual(["reflection:1", "experiment:1"]);
    expect(
      navigableRecords([failed, experiment, lesson], true).map(
        (item) => item.id,
      ),
    ).toEqual(["reflection:1", "experiment:1", "reflection:failed"]);
  });

  test("formats relative time and exact UTC timestamps", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    expect(formatRelativeTime("2026-08-14T11:59:58.000Z", now)).toBe(
      "just now",
    );
    expect(formatRelativeTime("2026-08-14T11:59:00.000Z", now)).toBe("1m ago");
    expect(formatRelativeTime("2026-08-14T00:00:02.000Z", now)).toBe("12h ago");
    expect(formatRelativeTime(undefined, now)).toBeUndefined();
    expect(formatExactTime("2026-08-14T00:00:02.000Z")).toBe(
      "2026-08-14 00:00:02 UTC",
    );
    expect(formatExactTime(undefined)).toBeUndefined();
  });

  test("uses singular grammar for a single cited input", () => {
    expect(citedCountSentence(25, 1)).toBe(
      "25 inputs were reviewed; 1 was cited for the decision.",
    );
    expect(citedCountSentence(1, 1)).toBe(
      "1 input was reviewed; 1 was cited for the decision.",
    );
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
});
