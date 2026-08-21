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
export type DetailFocus = "document" | "evidence" | "inputs" | "related";
export type DetailStop = Exclude<DetailFocus, "document">;

export const PAGE_STEP = 8;
export const WIDE_LAYOUT_MIN = 110;
export const COLLAPSED_PREVIEW = 2;
export const GROUP_FILTERS: readonly TuiLearningPrimitiveGroup[] = Object.freeze([
  "capabilities",
  "feedback",
  "activation",
  "reflection",
  "history",
  "evaluation",
  "memory",
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

const CHIP_ORDER: readonly AuditFilter[] = Object.freeze([
  "capabilities",
  "all",
  ...GROUP_FILTERS.filter((group) => group !== "capabilities"),
]);

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

const GROUP_GLYPH: Readonly<Record<TuiLearningPrimitiveGroup, string>> = Object.freeze({
  capabilities: "◆",
  memory: "○",
  reflection: "◇",
  history: "◌",
  evaluation: "□",
  activation: "▹",
  feedback: "↻",
  operations: "·",
});

export function isRoutine(record: TuiLearningPrimitive): boolean {
  return record.kind === "reflection" && record.status === "no_change";
}

export function isQuietFailure(record: TuiLearningPrimitive): boolean {
  return record.kind === "reflection" && record.tone === "negative";
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

export function sortByGroup(records: readonly TuiLearningPrimitive[]): readonly TuiLearningPrimitive[] {
  return [...records].sort((left, right) => {
    const groupDelta = GROUP_FILTERS.indexOf(left.group) - GROUP_FILTERS.indexOf(right.group);
    if (groupDelta !== 0) return groupDelta;
    return (right.occurredAt ?? "").localeCompare(left.occurredAt ?? "");
  });
}

export function navigableRecords(
  records: readonly TuiLearningPrimitive[],
  failedExpanded: boolean,
): readonly TuiLearningPrimitive[] {
  const failed = sortByGroup(records.filter(isQuietFailure));
  const primary = sortByGroup(records.filter((record) => !isQuietFailure(record)));
  return failedExpanded ? [...primary, ...failed] : primary;
}

function sectionOf(record: TuiLearningPrimitive): string {
  return isQuietFailure(record) ? "failed" : record.group;
}

function recordGlyph(record: TuiLearningPrimitive, colorEnabled: boolean): string {
  const glyph = isQuietFailure(record) ? "×" : GROUP_GLYPH[record.group];
  const color = isQuietFailure(record) ? ANSI.dim : TONE_PRESENTATION[record.tone].color;
  return styled(colorEnabled, color, glyph);
}

function groupHeader(section: string, colorEnabled: boolean): string {
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const glyph = section === "failed" ? "×" : GROUP_GLYPH[section as TuiLearningPrimitiveGroup];
  return styled(colorEnabled, ANSI.dim, `${glyph} ${section}`);
}

export function nextGroupFilter(current: AuditFilter): TuiLearningPrimitiveGroup {
  const currentGroup = GROUP_FILTERS.find((group) => group === current);
  const index = currentGroup ? GROUP_FILTERS.indexOf(currentGroup) : -1;
  return GROUP_FILTERS[(index + 1) % GROUP_FILTERS.length] ?? "memory";
}

export function toggleAllActivity(current: AuditFilter): AuditFilter {
  return current === "all" ? "capabilities" : "all";
}

export function headlineStats(records: readonly TuiLearningPrimitive[], colorEnabled: boolean): string {
  const active = records.filter(
    (record) => record.kind === "capability" && record.capabilityState === "active",
  ).length;
  const evaluating = records.filter(
    (record) => record.tone === "pending" && record.group !== "operations",
  ).length;
  const attention = records.filter((record) => record.tone === "negative" && !isQuietFailure(record)).length;
  const routine = records.filter(isRoutine).length;
  const item = (tone: keyof typeof TONE_PRESENTATION, count: number, label: string): string =>
    count === 0
      ? ""
      : `${styled(colorEnabled, TONE_PRESENTATION[tone].color, TONE_PRESENTATION[tone].glyph)} ${String(count)} ${label}`;
  return [
    item("active", active, "active"),
    item("pending", evaluating, "evaluating"),
    item("negative", attention, "attention"),
    item("neutral", routine, "routine"),
  ]
    .filter((part) => part.length > 0)
    .join("   ");
}

export function filterChips(filter: AuditFilter, colorEnabled: boolean): string {
  return CHIP_ORDER.map((item) => {
    const label = item === "all" ? "all" : item;
    return item === filter
      ? styled(colorEnabled, `${ANSI.bold}${ANSI.cyan}`, `[${label}]`)
      : styled(colorEnabled, ANSI.dim, label);
  }).join("  ");
}

function titleCase(value: string): string {
  const normalized = value.replaceAll("_", " ");
  return `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`;
}

function capabilityFacetLabel(record: TuiLearningPrimitive): string | undefined {
  if (record.capabilityFacets && record.capabilityFacets.length > 0)
    return record.capabilityFacets.map(titleCase).join(" + ");
  return record.capabilityKind ? `Legacy ${titleCase(record.capabilityKind)}` : undefined;
}

export function detailPaneLabel(record: TuiLearningPrimitive | undefined): string {
  if (!record) return "details";
  if (record.kind === "capability") return "capability";
  if (record.kind === "capability_revision") return "revision";
  if (record.kind === "reflection") return "reflection";
  if (record.kind === "capability_gate") return "approval";
  return "record";
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
  return `${reviewed}; ${citedPart}.`;
}

export function canExpandEvidence(record: TuiLearningPrimitive): boolean {
  return record.evidencePreviews.length > COLLAPSED_PREVIEW;
}

export function canExpandInputs(record: TuiLearningPrimitive): boolean {
  return record.consideredEvidencePreviews.length > COLLAPSED_PREVIEW;
}

export function interactableStops(record: TuiLearningPrimitive): readonly DetailStop[] {
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return [
    ...(canExpandEvidence(record) ? (["evidence"] as const) : []),
    ...(canExpandInputs(record) ? (["inputs"] as const) : []),
    ...(record.relations.length > 0 ? (["related"] as const) : []),
  ];
}

export function cycleDetailFocus(
  record: TuiLearningPrimitive,
  current: DetailFocus,
  reverse = false,
): DetailFocus {
  const stops = interactableStops(record);
  if (stops.length === 0) return current;
  const idx = current === "document" ? -1 : stops.indexOf(current);
  if (idx < 0) return (reverse ? stops[stops.length - 1] : stops[0]) ?? current;
  const nextIndex = reverse ? (idx - 1 + stops.length) % stops.length : (idx + 1) % stops.length;
  return stops[nextIndex] ?? current;
}

function boundedPreviews(
  previews: readonly TuiLearningEvidencePreview[],
  total: number,
  expanded: boolean,
): {
  readonly previews: readonly TuiLearningEvidencePreview[];
  readonly total: number;
} {
  const shown = previews.slice(0, expanded ? previews.length : COLLAPSED_PREVIEW);
  return {
    previews: shown,
    total: expanded || shown.length === 0 ? total : shown.length,
  };
}

function expandRuleOptions(
  focus: DetailFocus,
  section: "evidence" | "inputs",
  expanded: boolean,
): { readonly accent: boolean; readonly caption: string } {
  return {
    accent: focus === section,
    caption: focus === section ? (expanded ? "Enter hides" : "Enter expands") : "Tab to choose",
  };
}

export function emptyListMessage(
  filter: AuditFilter,
  visibleCount: number,
  scopedCount: number,
  routineCount: number,
  failedCount = 0,
): string | undefined {
  if (visibleCount > 0 || failedCount > 0) return undefined;
  if (scopedCount === 0) return "No learning activity recorded for this project yet.";
  if (filter === "capabilities" && routineCount > 0)
    return "No Capabilities yet. Ambient reflection is still running.";
  if (filter === "noteworthy" && routineCount > 0)
    return "No lasting changes yet. Ambient reflection is running.";
  return "Nothing in this view.";
}

interface ListLine {
  readonly kind: "header" | "row";
  readonly text: string;
  readonly anchor?: number;
}

function buildListLines(
  records: readonly TuiLearningPrimitive[],
  cursor: number,
  width: number,
  colorEnabled: boolean,
  now: Date,
  grouped: boolean,
): readonly ListLine[] {
  const lines: ListLine[] = [];
  let previous: string | undefined;
  for (const [index, record] of records.entries()) {
    const section = sectionOf(record);
    if (section !== previous && (grouped || section === "failed")) {
      lines.push({
        kind: "header",
        text: elideText(groupHeader(section, colorEnabled), width),
      });
      previous = section;
    }
    const selected = index === cursor;
    const marker = styled(
      colorEnabled,
      selected ? `${ANSI.bold}${ANSI.cyan}` : ANSI.dim,
      selected ? "›" : " ",
    );
    const type = record.kind === "capability" ? capabilityFacetLabel(record) : undefined;
    const title = styled(
      colorEnabled,
      selected ? ANSI.bold : "",
      `${type ? `[${type}] ` : ""}${safeScalar(record.title)}`,
    );
    const relative = formatRelativeTime(record.occurredAt, now);
    const summary = safeScalar(record.summary);
    const context = (grouped ? [relative] : [safeScalar(record.kind).replaceAll("_", " "), relative])
      .filter((value): value is string => value !== undefined)
      .join(" · ");
    const detail = summary && summary !== safeScalar(record.title) ? `${context} · ${summary}` : context;
    lines.push({
      kind: "row",
      text: elideText(`${marker} ${recordGlyph(record, colorEnabled)} ${title}`, width),
      anchor: index,
    });
    lines.push({
      kind: "row",
      text: elideText(`    ${styled(colorEnabled, ANSI.dim, detail)}`, width),
      anchor: index,
    });
  }
  return lines;
}

function windowListLines(
  lines: readonly ListLine[],
  records: readonly TuiLearningPrimitive[],
  cursor: number,
  itemRows: number,
  width: number,
  colorEnabled: boolean,
  grouped: boolean,
): readonly string[] {
  const selectedAt = lines.findIndex((line) => line.anchor === cursor);
  if (selectedAt < 0) return lines.slice(0, itemRows).map((line) => line.text);
  let selectedEnd = selectedAt;
  while (selectedEnd + 1 < lines.length && lines[selectedEnd + 1]?.anchor === cursor) selectedEnd += 1;
  if (itemRows === 1) return [lines[selectedAt]?.text ?? ""];
  const stickyNeeded = (start: number): boolean =>
    grouped && itemRows >= 3 && lines[start]?.kind !== "header" && lines[start]?.anchor !== undefined;
  const budgetFor = (start: number): number => (stickyNeeded(start) ? itemRows - 1 : itemRows);
  let start = Math.max(0, Math.min(selectedAt, Math.max(0, lines.length - itemRows)));
  if (selectedEnd >= start + budgetFor(start)) start = Math.max(0, selectedEnd - budgetFor(start) + 1);
  if (selectedAt < start) start = selectedAt;
  const budget = budgetFor(start);
  if (selectedEnd >= start + budget) start = Math.max(0, selectedEnd - budget + 1);
  const slice = lines.slice(start, start + budget);
  if (!stickyNeeded(start) || slice.length === 0) return slice.map((line) => line.text);
  const anchor = slice.find((line) => line.anchor !== undefined)?.anchor;
  const record = anchor === undefined ? undefined : records[anchor];
  return record
    ? [elideText(groupHeader(sectionOf(record), colorEnabled), width), ...slice.map((line) => line.text)]
    : slice.map((line) => line.text);
}

export function listViewport(
  records: readonly TuiLearningPrimitive[],
  cursor: number,
  width: number,
  maxRows: number,
  colorEnabled: boolean,
  now: Date,
  emptyMessage: string | undefined,
  options: {
    readonly grouped: boolean;
    readonly failedCount: number;
    readonly failedExpanded: boolean;
  },
): readonly string[] {
  const footer =
    options.failedCount > 0 && !options.failedExpanded
      ? elideText(styled(colorEnabled, ANSI.dim, `${String(options.failedCount)} failed · x shows`), width)
      : undefined;
  const itemRows = footer ? Math.max(1, maxRows - 1) : maxRows;
  if (records.length === 0) {
    const message = emptyMessage ? [elideText(styled(colorEnabled, ANSI.dim, emptyMessage), width)] : [];
    if (!footer)
      return message.length > 0 ? message : [styled(colorEnabled, ANSI.dim, "Nothing in this view.")];
    return [...message, ...Array.from({ length: Math.max(0, itemRows - message.length) }, () => ""), footer];
  }
  const texts = windowListLines(
    buildListLines(records, cursor, width, colorEnabled, now, options.grouped),
    records,
    cursor,
    itemRows,
    width,
    colorEnabled,
    options.grouped,
  );
  if (!footer) return texts;
  return [...texts, ...Array.from({ length: Math.max(0, itemRows - texts.length) }, () => ""), footer].slice(
    0,
    itemRows + 1,
  );
}

export function rule(
  label: string,
  width: number,
  colorEnabled: boolean,
  options: { readonly accent?: boolean; readonly caption?: string } = {},
): string {
  const safe = safeScalar(label).toUpperCase();
  const caption = options.caption ? styled(colorEnabled, ANSI.dim, `  ${options.caption}`) : "";
  const heading = `${styled(
    colorEnabled,
    options.accent ? `${ANSI.bold}${ANSI.cyan}` : ANSI.bold,
    safe,
  )}${caption}`;
  const prefix = `${styled(colorEnabled, options.accent ? ANSI.cyan : ANSI.dim, "──")} ${heading} `;
  return `${prefix}${styled(colorEnabled, ANSI.dim, "─".repeat(Math.max(0, width - visibleWidth(prefix))))}`;
}

export function paneRule(label: string, focused: boolean, width: number, colorEnabled: boolean): string {
  const mark = focused ? styled(colorEnabled, `${ANSI.bold}${ANSI.cyan}`, "▸") : " ";
  const heading = styled(
    colorEnabled,
    focused ? `${ANSI.bold}${ANSI.cyan}` : ANSI.dim,
    safeScalar(label).toUpperCase(),
  );
  const prefix = `${mark} ${heading} `;
  return `${prefix}${styled(colorEnabled, ANSI.dim, "─".repeat(Math.max(0, width - visibleWidth(prefix))))}`;
}

function labeledEntries(
  entries: readonly { readonly label?: string; readonly value: string }[],
  colorEnabled: boolean,
): readonly string[] {
  const width = Math.min(
    18,
    Math.max(0, ...entries.map((entry) => (entry.label ? visibleWidth(entry.label) : 0))),
  );
  return entries.map((entry) => {
    if (!entry.label) return safeTerminalText(entry.value);
    const label = `${entry.label}${" ".repeat(Math.max(0, width - visibleWidth(entry.label)))}`;
    return `${styled(colorEnabled, ANSI.dim, label)}  ${safeTerminalText(entry.value)}`;
  });
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
        total === 0 ? "No evidence was cited." : "Exact references remain available in the raw audit view.",
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
  const summary = safeTerminalText(record.summary);
  const title = safeTerminalText(record.title);
  const type = capabilityFacetLabel(record);
  const kind =
    record.kind === "capability" && type
      ? `${type} capability`
      : safeScalar(record.kind).replaceAll("_", " ");
  return [
    `${recordGlyph(record, colorEnabled)} ${styled(colorEnabled, ANSI.bold, title)}`,
    styled(
      colorEnabled,
      ANSI.dim,
      [kind, safeScalar(record.status).replaceAll("_", " "), time]
        .filter((value): value is string => value !== undefined)
        .join(" · "),
    ),
    ...(summary && summary !== title ? [summary] : []),
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
          ...labeledEntries(whatChanged.entries, colorEnabled),
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
    styled(colorEnabled, ANSI.dim, "Enter opens"),
  ];
}

function formatRawJson(rawJson: string): string {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    return JSON.stringify(parsed, undefined, 2) ?? rawJson;
  } catch {
    return rawJson;
  }
}

export function detailDocument(
  record: TuiLearningPrimitive,
  raw: boolean,
  relationCursor: number,
  width: number,
  colorEnabled: boolean,
  now: Date,
  focus: DetailFocus,
  evidenceExpanded: boolean,
  inputsExpanded: boolean,
): readonly string[] {
  if (raw)
    return [
      styled(colorEnabled, ANSI.dim, "Raw record · Space returns"),
      "",
      ...highlightCode(safeTerminalText(formatRawJson(record.rawJson)), "json", colorEnabled),
    ];
  const cited = boundedPreviews(record.evidencePreviews, record.evidence.length, evidenceExpanded);
  const considered = boundedPreviews(
    record.consideredEvidencePreviews,
    record.consideredEvidenceCount,
    inputsExpanded,
  );
  const supportingSections = record.detailSections.filter((section) =>
    ["provenance", "history"].includes(section.title.toLowerCase()),
  );
  const primarySections = record.detailSections.filter((section) => !supportingSections.includes(section));
  return [
    ...recordHeading(record, colorEnabled, now, true),
    "",
    ...primarySections.flatMap((section) => [
      rule(section.title, width, colorEnabled),
      ...labeledEntries(section.entries, colorEnabled),
      "",
    ]),
    rule(
      `evidence cited · ${String(record.evidence.length)}`,
      width,
      colorEnabled,
      canExpandEvidence(record) ? expandRuleOptions(focus, "evidence", evidenceExpanded) : {},
    ),
    ...evidenceLines(cited.previews, cited.total, colorEnabled),
    ...(record.consideredEvidenceCount > 0
      ? [
          "",
          rule(
            `inputs considered · ${String(record.consideredEvidenceCount)}`,
            width,
            colorEnabled,
            canExpandInputs(record) ? expandRuleOptions(focus, "inputs", inputsExpanded) : {},
          ),
          ...(record.evidence.length > 0
            ? [
                styled(
                  colorEnabled,
                  ANSI.dim,
                  citedCountSentence(record.consideredEvidenceCount, record.evidence.length),
                ),
              ]
            : []),
          ...evidenceLines(considered.previews, considered.total, colorEnabled),
        ]
      : []),
    ...supportingSections.flatMap((section) => [
      "",
      rule(section.title, width, colorEnabled),
      ...labeledEntries(section.entries, colorEnabled),
    ]),
    ...(record.relations.length > 0
      ? [
          "",
          rule(`related · ${String(record.relations.length)}`, width, colorEnabled, {
            accent: focus === "related",
            caption: focus === "related" ? "Enter opens" : "Tab to choose",
          }),
          ...record.relations.map((item, index) => {
            const selected = focus === "related" && index === relationCursor;
            const target = item.targetTitle ?? item.targetId;
            const marker = styled(
              colorEnabled,
              selected ? `${ANSI.bold}${ANSI.cyan}` : ANSI.dim,
              selected ? "›" : " ",
            );
            const body = `${safeScalar(item.label)} · ${safeScalar(target)}`;
            return `${marker} ${selected ? styled(colorEnabled, ANSI.bold, body) : styled(colorEnabled, ANSI.dim, body)}`;
          }),
        ]
      : []),
  ];
}

function sectionIndex(document: readonly string[], prefix: string): number {
  const heading = `── ${prefix}`.trimEnd();
  return document.findIndex((line) => {
    const plain = Object.values(ANSI).reduce((text, code) => text.replaceAll(code, ""), line);
    return plain.startsWith(heading);
  });
}

export function relatedSectionIndex(document: readonly string[]): number {
  return sectionIndex(document, "RELATED · ");
}

export function sectionRevealLine(document: readonly string[], prefix: string, expanded: boolean): number {
  const start = sectionIndex(document, prefix);
  if (start < 0 || !expanded) return start;
  let end = document.length;
  for (let index = start + 1; index < document.length; index += 1) {
    const plain = Object.values(ANSI).reduce(
      (text, code) => text.replaceAll(code, ""),
      document[index] ?? "",
    );
    if (plain.startsWith("── ")) {
      end = index;
      break;
    }
  }
  for (let index = end - 1; index > start; index -= 1) {
    if ((document[index] ?? "").includes("more exact references in raw")) return index;
  }
  for (let index = end - 1; index > start; index -= 1) {
    const plain = Object.values(ANSI).reduce(
      (text, code) => text.replaceAll(code, ""),
      document[index] ?? "",
    );
    if (plain.trim().length > 0) return index;
  }
  return start;
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
