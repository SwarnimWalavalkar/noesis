import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type {
  TuiLearningEvidencePreview,
  TuiLearningPrimitive,
  TuiLearningPrimitiveGroup,
  TuiLearningPrimitiveKind,
} from "./runtime-port.ts";
import { highlightCode } from "./syntax.ts";
import { ANSI, elideText, safeTerminalText, styled } from "./theme.ts";

export type AuditFilter = "noteworthy" | "all" | TuiLearningPrimitiveGroup;
export type DetailFocus = "document" | "related";

export const PAGE_STEP = 8;
export const WIDE_LAYOUT_MIN = 110;
export const GROUP_FILTERS: readonly TuiLearningPrimitiveGroup[] = Object.freeze([
  "memory",
  "reflection",
  "changes",
  "evaluation",
  "activation",
  "feedback",
  "operations",
]);

const SUPPORTING_KINDS: ReadonlySet<TuiLearningPrimitiveKind> = new Set([
  "trial",
  "preflight_plan",
  "feedback_signal",
  "capability_revision",
  "successor_lineage",
  "outcome_research",
]);

const CHIP_ORDER: readonly AuditFilter[] = Object.freeze(["noteworthy", "all", ...GROUP_FILTERS]);

const TONE_PRESENTATION = Object.freeze({
  neutral: Object.freeze({ glyph: "—", color: ANSI.dim }),
  positive: Object.freeze({ glyph: "✓", color: ANSI.green }),
  active: Object.freeze({ glyph: "◆", color: ANSI.cyan }),
  pending: Object.freeze({ glyph: "●", color: ANSI.yellow }),
  negative: Object.freeze({ glyph: "×", color: ANSI.red }),
});

export const safeScalar = (value: string): string =>
  safeTerminalText(value).replaceAll("\t", " ").replaceAll("\n", " ");

export function pad(line: string, width: number): string {
  return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}

export function isRoutine(record: TuiLearningPrimitive): boolean {
  return record.kind === "reflection" && record.status === "no_change";
}

export function isNoteworthy(record: TuiLearningPrimitive): boolean {
  if (isRoutine(record)) return false;
  if (record.group === "operations") return record.tone === "pending" || record.tone === "negative";
  if (record.kind === "working_adjustment") return record.tone === "active";
  if (record.kind === "observation") return record.tone === "positive" || record.tone === "negative";
  if (record.kind === "capability_revision") return record.tone === "active";
  if (SUPPORTING_KINDS.has(record.kind)) return record.tone === "pending" || record.tone === "negative";
  return true;
}

export function nextGroupFilter(current: AuditFilter): TuiLearningPrimitiveGroup {
  const index = GROUP_FILTERS.indexOf(current as TuiLearningPrimitiveGroup);
  return GROUP_FILTERS[(index + 1) % GROUP_FILTERS.length] ?? "memory";
}

export function toggleAllActivity(current: AuditFilter): AuditFilter {
  return current === "all" ? "noteworthy" : current === "noteworthy" ? "all" : "noteworthy";
}

export function headlineStats(records: readonly TuiLearningPrimitive[]): string {
  const active = records.filter((record) => record.tone === "active").length;
  const evaluating = records.filter(
    (record) => record.tone === "pending" && record.group !== "operations",
  ).length;
  const attention = records.filter((record) => record.tone === "negative").length;
  const routine = records.filter(isRoutine).length;
  return `active ${String(active)} · evaluating ${String(evaluating)} · needs attention ${String(attention)} · routine reflections ${String(routine)}`;
}

export function filterChips(filter: AuditFilter, colorEnabled: boolean): string {
  return CHIP_ORDER.map((item) => {
    const label = item === "all" ? "all" : item;
    return item === filter
      ? styled(colorEnabled, `${ANSI.bold}${ANSI.cyan}`, label)
      : styled(colorEnabled, ANSI.dim, label);
  }).join(" · ");
}

export function formatRelativeTime(value: string | undefined, now: Date): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return safeScalar(value);
  const deltaSeconds = Math.round((now.valueOf() - parsed.valueOf()) / 1000);
  const abs = Math.abs(deltaSeconds);
  const suffix = deltaSeconds < 0 ? "from now" : "ago";
  if (abs < 5) return "just now";
  if (abs < 60) return `${String(abs)}s ${suffix}`;
  if (abs < 3_600) return `${String(Math.round(abs / 60))}m ${suffix}`;
  if (abs < 86_400) return `${String(Math.round(abs / 3_600))}h ${suffix}`;
  if (abs < 86_400 * 7) return `${String(Math.round(abs / 86_400))}d ${suffix}`;
  return parsed.toISOString().slice(0, 10);
}

export function formatExactTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? safeScalar(value)
    : `${parsed.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

export function citedCountSentence(considered: number, cited: number): string {
  const reviewed = considered === 1 ? "1 input was reviewed" : `${String(considered)} inputs were reviewed`;
  const citedPart = cited === 1 ? "1 was cited" : `${String(cited)} were cited`;
  return `${reviewed}; ${citedPart} for the decision.`;
}

export function emptyListMessage(
  filter: AuditFilter,
  visibleCount: number,
  scopedCount: number,
  routineCount: number,
): string | undefined {
  if (visibleCount > 0) return undefined;
  if (scopedCount === 0) return "No learning activity recorded for this project yet.";
  if (filter === "noteworthy" && routineCount > 0)
    return "No lasting changes yet. Ambient reflection is running.";
  return "Nothing in this view.";
}

export function listViewport(
  records: readonly TuiLearningPrimitive[],
  cursor: number,
  width: number,
  maxRows: number,
  colorEnabled: boolean,
  now: Date,
  emptyMessage: string | undefined,
): readonly string[] {
  if (records.length === 0) return [styled(colorEnabled, ANSI.dim, emptyMessage ?? "Nothing in this view.")];
  const rowHeight = 2;
  const visible = Math.max(1, Math.floor(maxRows / rowHeight));
  const start = Math.max(0, Math.min(cursor - visible + 1, Math.max(0, records.length - visible)));
  return records.slice(start, start + visible).flatMap((record, index) => {
    const selected = start + index === cursor;
    const marker = styled(
      colorEnabled,
      selected ? `${ANSI.bold}${ANSI.cyan}` : ANSI.dim,
      selected ? "›" : " ",
    );
    const presentation = TONE_PRESENTATION[record.tone];
    const glyph = styled(colorEnabled, presentation.color, presentation.glyph);
    const title = styled(colorEnabled, selected ? ANSI.bold : "", safeScalar(record.title));
    const relative = formatRelativeTime(record.occurredAt, now);
    const context = [
      safeScalar(record.status).replaceAll("_", " "),
      record.kind.replaceAll("_", " "),
      relative,
    ]
      .filter((value): value is string => value !== undefined)
      .join(" · ");
    return [
      elideText(`${marker} ${glyph} ${title}`, width),
      elideText(`    ${styled(colorEnabled, ANSI.dim, context)} · ${safeScalar(record.summary)}`, width),
    ];
  });
}

export function rule(label: string, width: number, colorEnabled: boolean): string {
  const safe = safeScalar(label).toUpperCase();
  return `${styled(colorEnabled, ANSI.dim, "──")} ${styled(colorEnabled, ANSI.bold, safe)} ${styled(
    colorEnabled,
    ANSI.dim,
    "─".repeat(Math.max(0, width - safe.length - 4)),
  )}`;
}

function evidenceLines(
  previews: readonly TuiLearningEvidencePreview[],
  total: number,
  colorEnabled: boolean,
): readonly string[] {
  if (previews.length === 0)
    return [
      styled(
        colorEnabled,
        ANSI.dim,
        total === 0
          ? "No evidence was cited for this decision."
          : "Exact references remain available in the raw audit view.",
      ),
    ];
  return [
    ...previews.flatMap((preview) => [
      `${styled(colorEnabled, ANSI.bold, safeScalar(preview.label))}${preview.occurredAt ? styled(colorEnabled, ANSI.dim, ` · ${formatExactTime(preview.occurredAt) ?? ""}`) : ""}`,
      `  ${styled(colorEnabled, preview.redacted ? ANSI.dim : "", safeTerminalText(preview.excerpt))}`,
      "",
    ]),
    ...(total > previews.length
      ? [styled(colorEnabled, ANSI.dim, `+ ${String(total - previews.length)} more exact references in raw`)]
      : []),
  ];
}

function recordHeading(
  record: TuiLearningPrimitive,
  colorEnabled: boolean,
  now: Date,
  exactTime: boolean,
): readonly string[] {
  const time = exactTime ? formatExactTime(record.occurredAt) : formatRelativeTime(record.occurredAt, now);
  return [
    `${styled(colorEnabled, TONE_PRESENTATION[record.tone].color, TONE_PRESENTATION[record.tone].glyph)} ${styled(
      colorEnabled,
      ANSI.bold,
      safeTerminalText(record.title),
    )}`,
    safeTerminalText(record.summary),
    styled(
      colorEnabled,
      ANSI.dim,
      [safeScalar(record.status).replaceAll("_", " "), safeScalar(record.kind).replaceAll("_", " "), time]
        .filter((value): value is string => value !== undefined)
        .join(" · "),
    ),
  ];
}

export function previewDocument(
  record: TuiLearningPrimitive,
  width: number,
  colorEnabled: boolean,
  now: Date,
): readonly string[] {
  const whatChanged = record.detailSections.find((section) => section.title.toLowerCase() === "what changed");
  const firstEvidence = record.evidencePreviews[0];
  return [
    ...recordHeading(record, colorEnabled, now, false),
    "",
    ...(whatChanged
      ? [
          rule(whatChanged.title, width, colorEnabled),
          ...whatChanged.entries.map((entry) =>
            entry.label
              ? `${styled(colorEnabled, ANSI.dim, entry.label)}  ${safeTerminalText(entry.value)}`
              : safeTerminalText(entry.value),
          ),
          "",
        ]
      : []),
    ...(firstEvidence
      ? [
          rule("evidence", width, colorEnabled),
          `${styled(colorEnabled, ANSI.bold, safeScalar(firstEvidence.label))}`,
          `  ${styled(colorEnabled, firstEvidence.redacted ? ANSI.dim : "", safeTerminalText(firstEvidence.excerpt))}`,
          "",
        ]
      : []),
    styled(colorEnabled, ANSI.dim, "enter inspects the full decision"),
  ];
}

export function detailDocument(
  record: TuiLearningPrimitive,
  raw: boolean,
  relationCursor: number,
  width: number,
  colorEnabled: boolean,
  now: Date,
): readonly string[] {
  if (raw)
    return [
      styled(colorEnabled, ANSI.dim, "Authoritative bounded projection · Space returns to the audit view"),
      "",
      ...highlightCode(safeTerminalText(record.rawJson), "json", colorEnabled),
    ];
  return [
    ...recordHeading(record, colorEnabled, now, true),
    "",
    ...record.detailSections.flatMap((section) => [
      rule(section.title, width, colorEnabled),
      ...section.entries.map((entry) =>
        entry.label
          ? `${styled(colorEnabled, ANSI.dim, entry.label)}  ${safeTerminalText(entry.value)}`
          : safeTerminalText(entry.value),
      ),
      "",
    ]),
    rule(`evidence cited · ${String(record.evidence.length)}`, width, colorEnabled),
    ...evidenceLines(record.evidencePreviews, record.evidence.length, colorEnabled),
    ...(record.consideredEvidenceCount > 0
      ? [
          "",
          rule(`inputs considered · ${String(record.consideredEvidenceCount)}`, width, colorEnabled),
          ...(record.evidence.length > 0
            ? [
                styled(
                  colorEnabled,
                  ANSI.dim,
                  citedCountSentence(record.consideredEvidenceCount, record.evidence.length),
                ),
              ]
            : evidenceLines(record.consideredEvidencePreviews, record.consideredEvidenceCount, colorEnabled)),
        ]
      : []),
    ...(record.relations.length > 0
      ? [
          "",
          rule(`related · ${String(record.relations.length)}`, width, colorEnabled),
          ...record.relations.map((item, index) => {
            const selected = index === relationCursor;
            const target = item.targetTitle ?? item.targetId;
            return `${styled(colorEnabled, selected ? `${ANSI.bold}${ANSI.cyan}` : ANSI.dim, selected ? "›" : " ")} ${safeScalar(item.label)} → ${safeScalar(target)}`;
          }),
        ]
      : []),
  ];
}

export function relatedSectionIndex(document: readonly string[]): number {
  return document.findIndex((line) => line.includes("RELATED"));
}

export function wrapDocument(lines: readonly string[], width: number): readonly string[] {
  return lines.flatMap((line) => {
    const wrapped = line ? wrapTextWithAnsi(line, width) : [""];
    return wrapped.length > 0 ? wrapped : [""];
  });
}

export function joinColumns(
  left: readonly string[],
  right: readonly string[],
  leftWidth: number,
  rightWidth: number,
  maxRows: number,
  colorEnabled: boolean,
): readonly string[] {
  return Array.from({ length: maxRows }, (_, index) => {
    const leftLine = elideText(left[index] ?? "", leftWidth);
    const rightLine = elideText(right[index] ?? "", rightWidth);
    return `${pad(leftLine, leftWidth)} ${styled(colorEnabled, ANSI.dim, "│")} ${rightLine}`;
  });
}
