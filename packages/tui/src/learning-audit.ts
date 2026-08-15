import { type Component, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type {
  NoesisTuiRuntime,
  TuiLearningAuditSnapshot,
  TuiLearningEvidencePreview,
  TuiLearningPrimitive,
  TuiLearningPrimitiveGroup,
} from "./runtime-port.ts";
import { highlightCode } from "./syntax.ts";
import { ANSI, elideText, safeTerminalText, styled } from "./theme.ts";

type AuditFilter = "noteworthy" | "all" | TuiLearningPrimitiveGroup;

const FILTERS: readonly AuditFilter[] = Object.freeze([
  "noteworthy",
  "all",
  "memory",
  "reflection",
  "changes",
  "evaluation",
  "activation",
  "feedback",
  "operations",
]);
const PAGE_STEP = 8;
const WIDE_LAYOUT_MIN = 110;

type AuditScreen =
  | { readonly kind: "list" }
  | {
      readonly kind: "detail";
      readonly recordId: string;
      readonly back: AuditScreen;
      readonly raw: boolean;
    };

export interface LearningAuditOverlay extends Component {
  readonly dispose: () => void;
  readonly refresh: () => Promise<void>;
}

export interface CreateLearningAuditOverlayOptions {
  readonly runtime: Required<Pick<NoesisTuiRuntime, "inspectLearningAudit">>;
  readonly sessionId: string;
  readonly colorEnabled: boolean;
  readonly height: () => number;
  readonly requestRender: () => void;
  readonly close: () => void;
}

const safeScalar = (value: string): string =>
  safeTerminalText(value).replaceAll("\t", " ").replaceAll("\n", " ");

const TONE_PRESENTATION = Object.freeze({
  neutral: Object.freeze({ glyph: "—", color: ANSI.dim }),
  positive: Object.freeze({ glyph: "✓", color: ANSI.green }),
  active: Object.freeze({ glyph: "◆", color: ANSI.cyan }),
  pending: Object.freeze({ glyph: "●", color: ANSI.yellow }),
  negative: Object.freeze({ glyph: "×", color: ANSI.red }),
});

function pad(line: string, width: number): string {
  return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}

function isRoutine(record: TuiLearningPrimitive): boolean {
  return record.kind === "reflection" && record.status === "no_change";
}

function isNoteworthy(record: TuiLearningPrimitive): boolean {
  if (isRoutine(record)) return false;
  if (record.group === "operations") return record.tone === "pending" || record.tone === "negative";
  return true;
}

function headlineStats(records: readonly TuiLearningPrimitive[]): string {
  const active = records.filter((record) => record.tone === "active").length;
  const evaluating = records.filter(
    (record) => record.tone === "pending" && record.group !== "operations",
  ).length;
  const attention = records.filter((record) => record.tone === "negative").length;
  const routine = records.filter(isRoutine).length;
  return `active ${String(active)} · evaluating ${String(evaluating)} · needs attention ${String(attention)} · routine reflections ${String(routine)}`;
}

function filterLabel(filter: AuditFilter): string {
  return filter === "all" ? "all activity" : filter;
}

function timestamp(value: string | undefined): string {
  if (!value) return "time unavailable";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? safeScalar(value)
    : parsed.toISOString().replace("T", " ").slice(0, 19);
}

function listViewport(
  records: readonly TuiLearningPrimitive[],
  cursor: number,
  width: number,
  maxRows: number,
  colorEnabled: boolean,
): readonly string[] {
  if (records.length === 0)
    return [styled(colorEnabled, ANSI.dim, "No learning primitives match this view.")];
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
    const context = [
      safeScalar(record.status).replaceAll("_", " "),
      record.kind.replaceAll("_", " "),
      timestamp(record.occurredAt),
    ]
      .filter((value): value is string => value !== undefined)
      .join(" · ");
    return [
      elideText(`${marker} ${glyph} ${title}`, width),
      elideText(`    ${styled(colorEnabled, ANSI.dim, context)} · ${safeScalar(record.summary)}`, width),
    ];
  });
}

function rule(label: string, width: number, colorEnabled: boolean): string {
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
      `${styled(colorEnabled, ANSI.bold, safeScalar(preview.label))}${preview.occurredAt ? styled(colorEnabled, ANSI.dim, ` · ${timestamp(preview.occurredAt)}`) : ""}`,
      `  ${styled(colorEnabled, preview.redacted ? ANSI.dim : "", safeTerminalText(preview.excerpt))}`,
      "",
    ]),
    ...(total > previews.length
      ? [styled(colorEnabled, ANSI.dim, `+ ${String(total - previews.length)} more exact references in raw`)]
      : []),
  ];
}

function detailDocument(
  record: TuiLearningPrimitive,
  raw: boolean,
  relationCursor: number,
  width: number,
  colorEnabled: boolean,
): readonly string[] {
  if (raw)
    return [
      styled(colorEnabled, ANSI.dim, "Authoritative bounded projection · Space returns to the audit view"),
      "",
      ...highlightCode(safeTerminalText(record.rawJson), "json", colorEnabled),
    ];
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
      `${record.status.replaceAll("_", " ")} · ${record.kind.replaceAll("_", " ")} · ${timestamp(record.occurredAt)}`,
    ),
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
                  `${String(record.consideredEvidenceCount)} inputs were reviewed; ${String(record.evidence.length)} were cited for the decision.`,
                ),
              ]
            : evidenceLines(record.consideredEvidencePreviews, record.consideredEvidenceCount, colorEnabled)),
        ]
      : []),
    ...(record.relations.length > 0
      ? [
          "",
          rule(`what followed · ${String(record.relations.length)}`, width, colorEnabled),
          ...record.relations.map((item, index) => {
            const selected = index === relationCursor;
            const target = item.targetTitle ?? item.targetId;
            return `${styled(colorEnabled, selected ? `${ANSI.bold}${ANSI.cyan}` : ANSI.dim, selected ? "›" : " ")} ${safeScalar(item.label)} → ${safeTerminalText(target)}`;
          }),
        ]
      : []),
  ];
}

function wrapDocument(lines: readonly string[], width: number): readonly string[] {
  return lines.flatMap((line) => {
    const wrapped = line ? wrapTextWithAnsi(line, width) : [""];
    return wrapped.length > 0 ? wrapped : [""];
  });
}

function joinColumns(
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

export function createLearningAuditOverlay(options: CreateLearningAuditOverlayOptions): LearningAuditOverlay {
  let disposed = false;
  let generation = 0;
  let snapshot: TuiLearningAuditSnapshot | undefined;
  let busy = "Loading the learning ledger…";
  let notice: string | undefined;
  let screen: AuditScreen = { kind: "list" };
  let filterIndex = 0;
  let currentSessionOnly = false;
  let cursor = 0;
  let scroll = 0;
  let relationCursor = 0;
  let wideLayout = false;

  const render = (): void => {
    if (!disposed) options.requestRender();
  };

  const scopedRecords = (): readonly TuiLearningPrimitive[] => {
    const current = snapshot;
    return (
      current?.primitives.filter((record) => !currentSessionOnly || record.sessionId === current.sessionId) ??
      []
    );
  };

  const visibleRecords = (): readonly TuiLearningPrimitive[] => {
    const filter = FILTERS[filterIndex] ?? "all";
    const scoped = scopedRecords();
    if (filter === "noteworthy") return scoped.filter(isNoteworthy);
    if (filter === "all") return scoped;
    return scoped.filter((record) => record.group === filter);
  };

  const refresh = async (): Promise<void> => {
    const request = ++generation;
    busy = "Refreshing the learning ledger…";
    notice = undefined;
    render();
    try {
      const next = await options.runtime.inspectLearningAudit(options.sessionId);
      if (disposed || generation !== request) return;
      snapshot = next;
      busy = "";
      cursor = Math.min(cursor, Math.max(0, visibleRecords().length - 1));
      render();
    } catch (error) {
      if (disposed || generation !== request) return;
      busy = "";
      notice = error instanceof Error ? error.message : String(error);
      render();
    }
  };

  const moveList = (delta: number): void => {
    cursor = Math.max(0, Math.min(cursor + delta, Math.max(0, visibleRecords().length - 1)));
    render();
  };

  const openRecord = (recordId: string, back: AuditScreen): void => {
    const visibleIndex = visibleRecords().findIndex((record) => record.id === recordId);
    if (visibleIndex >= 0) cursor = visibleIndex;
    screen = { kind: "detail", recordId, back, raw: false };
    scroll = 0;
    relationCursor = 0;
    render();
  };

  const detailRecord = (): TuiLearningPrimitive | undefined => {
    if (screen.kind !== "detail") return undefined;
    const recordId = screen.recordId;
    return snapshot?.primitives.find((record) => record.id === recordId);
  };

  const handleList = (data: string): void => {
    if (matchesKey(data, "escape")) {
      options.close();
      return;
    }
    if (matchesKey(data, "up")) {
      moveList(-1);
      return;
    }
    if (matchesKey(data, "down")) {
      moveList(1);
      return;
    }
    if (matchesKey(data, "pageUp")) {
      moveList(-PAGE_STEP);
      return;
    }
    if (matchesKey(data, "pageDown")) {
      moveList(PAGE_STEP);
      return;
    }
    if (data === "a") {
      const current = FILTERS[filterIndex] ?? "noteworthy";
      filterIndex = current === "all" ? 0 : 1;
      cursor = 0;
      render();
      return;
    }
    if (data === "f") {
      filterIndex = (filterIndex + 1) % FILTERS.length;
      cursor = 0;
      render();
      return;
    }
    if (data === "s") {
      currentSessionOnly = !currentSessionOnly;
      cursor = 0;
      render();
      return;
    }
    if (data === "r") {
      void refresh();
      return;
    }
    if (!matchesKey(data, "enter") && !(wideLayout && matchesKey(data, "tab"))) return;
    const selected = visibleRecords()[cursor];
    if (selected) openRecord(selected.id, screen);
  };

  const handleDetail = (data: string, detail: Extract<AuditScreen, { kind: "detail" }>): void => {
    const record = detailRecord();
    if (matchesKey(data, "escape")) {
      screen = detail.back;
      scroll = 0;
      render();
      return;
    }
    if (wideLayout && matchesKey(data, "tab")) {
      screen = detail.back;
      scroll = 0;
      render();
      return;
    }
    if (data === " ") {
      screen = { ...detail, raw: !detail.raw };
      scroll = 0;
      render();
      return;
    }
    if (matchesKey(data, "up")) scroll = Math.max(0, scroll - 1);
    else if (matchesKey(data, "down")) scroll += 1;
    else if (matchesKey(data, "pageUp")) scroll = Math.max(0, scroll - PAGE_STEP);
    else if (matchesKey(data, "pageDown")) scroll += PAGE_STEP;
    else if (matchesKey(data, "left") && record?.relations.length)
      relationCursor = (relationCursor - 1 + record.relations.length) % record.relations.length;
    else if (matchesKey(data, "right") && record?.relations.length)
      relationCursor = (relationCursor + 1) % record.relations.length;
    else if (matchesKey(data, "enter")) {
      const target = record?.relations[relationCursor];
      if (target && snapshot?.primitives.some((candidate) => candidate.id === target.targetId)) {
        openRecord(target.targetId, detail);
        return;
      }
      notice = target
        ? `The related primitive ${target.targetId} is not available in this bounded snapshot.`
        : undefined;
    } else return;
    render();
  };

  const component: LearningAuditOverlay = {
    dispose() {
      disposed = true;
      generation += 1;
    },
    refresh,
    invalidate() {},
    handleInput(data) {
      notice = undefined;
      if (busy) {
        if (matchesKey(data, "escape")) options.close();
        return;
      }
      if (screen.kind === "list") return handleList(data);
      return handleDetail(data, screen);
    },
    render(outerWidth) {
      const width = Math.max(16, outerWidth - 4);
      const height = Math.max(8, options.height() - 4);
      wideLayout = width >= WIDE_LAYOUT_MIN;
      const noticeRows = notice ? wrapTextWithAnsi(safeTerminalText(notice), width).slice(0, 3) : [];
      const bodyRows = Math.max(1, height - 6 - noticeRows.length);
      let body: readonly string[];
      if (busy) body = [styled(options.colorEnabled, ANSI.cyan, busy)];
      else if (!snapshot)
        body = [styled(options.colorEnabled, ANSI.red, "The learning ledger is unavailable.")];
      else {
        const filter = FILTERS[filterIndex] ?? "all";
        const records = visibleRecords();
        const scoped = scopedRecords();
        const overview = [
          styled(options.colorEnabled, ANSI.bold, headlineStats(scoped)),
          styled(
            options.colorEnabled,
            ANSI.dim,
            `view ${filterLabel(filter)} · ${currentSessionOnly ? "current session" : "all sessions"} · ${String(records.length)} visible`,
          ),
          "",
        ];
        if (wideLayout) {
          const paneRows = Math.max(1, bodyRows - overview.length);
          const leftWidth = Math.min(52, Math.max(36, Math.floor(width * 0.38)));
          const rightWidth = Math.max(24, width - leftWidth - 3);
          const routineCount = scoped.filter(isRoutine).length;
          const leftPrefix = [
            rule(screen.kind === "list" ? "activity · focused" : "activity", leftWidth, options.colorEnabled),
            ...(filter === "noteworthy" && routineCount > 0
              ? [
                  styled(
                    options.colorEnabled,
                    ANSI.dim,
                    `${String(routineCount)} routine no-change reflections hidden · a shows all`,
                  ),
                ]
              : []),
            "",
          ];
          const left = [
            ...leftPrefix,
            ...listViewport(
              records,
              cursor,
              leftWidth,
              Math.max(1, paneRows - leftPrefix.length),
              options.colorEnabled,
            ),
          ];
          const selected = screen.kind === "detail" ? detailRecord() : records[cursor];
          let right: readonly string[];
          if (!selected)
            right = [
              rule("selected decision", rightWidth, options.colorEnabled),
              styled(options.colorEnabled, ANSI.dim, "Select a learning record to inspect it."),
            ];
          else {
            const document = wrapDocument(
              [
                rule(
                  screen.kind === "detail" ? "selected decision · focused" : "selected decision",
                  rightWidth,
                  options.colorEnabled,
                ),
                ...detailDocument(
                  selected,
                  screen.kind === "detail" && screen.raw,
                  relationCursor,
                  rightWidth,
                  options.colorEnabled,
                ),
              ],
              rightWidth,
            );
            const selectedScroll = screen.kind === "detail" ? scroll : 0;
            const maxScroll = Math.max(0, document.length - paneRows);
            if (screen.kind === "detail") scroll = Math.min(scroll, maxScroll);
            right = document.slice(
              Math.min(selectedScroll, maxScroll),
              Math.min(selectedScroll, maxScroll) + paneRows,
            );
          }
          body = [
            ...overview,
            ...joinColumns(left, right, leftWidth, rightWidth, paneRows, options.colorEnabled),
          ];
        } else if (screen.kind === "list") {
          const routineCount = scoped.filter(isRoutine).length;
          body = [
            ...overview,
            ...(filter === "noteworthy" && routineCount > 0
              ? [
                  styled(
                    options.colorEnabled,
                    ANSI.dim,
                    `${String(routineCount)} routine no-change reflections hidden · press a for all activity`,
                  ),
                  "",
                ]
              : []),
            ...listViewport(records, cursor, width, Math.max(1, bodyRows - 3), options.colorEnabled),
          ];
        } else {
          const record = detailRecord();
          if (!record)
            body = [styled(options.colorEnabled, ANSI.red, "This learning primitive is unavailable.")];
          else {
            const document = wrapDocument(
              detailDocument(record, screen.raw, relationCursor, width, options.colorEnabled),
              width,
            );
            const maxScroll = Math.max(0, document.length - bodyRows);
            scroll = Math.min(scroll, maxScroll);
            body = document.slice(scroll, scroll + bodyRows);
          }
        }
      }
      const title =
        screen.kind === "list"
          ? "LEARNING · project evolution"
          : `LEARNING · ${detailRecord()?.kind.replaceAll("_", " ") ?? "record"}`;
      const hint =
        screen.kind === "list"
          ? "↑/↓ select · enter/tab inspect · a all activity · f filter · s session · r refresh · esc close"
          : wideLayout
            ? "↑/↓ scroll · ←/→ lineage · enter follow · space raw · tab/esc activity"
            : "↑/↓ scroll · ←/→ lineage · enter follow · space raw · esc back";
      return [
        styled(options.colorEnabled, ANSI.dim, `╭─${"─".repeat(Math.max(0, outerWidth - 3))}╮`),
        elideText(`│ ${styled(options.colorEnabled, `${ANSI.bold}${ANSI.cyan}`, title)}`, outerWidth),
        ...(noticeRows.length > 0
          ? noticeRows.map((line) =>
              elideText(`│ ${styled(options.colorEnabled, ANSI.yellow, line)}`, outerWidth),
            )
          : []),
        ...body.slice(0, bodyRows).map((line) => elideText(`│ ${pad(line, width)}`, outerWidth)),
        elideText(`│ ${styled(options.colorEnabled, ANSI.dim, hint)}`, outerWidth),
        styled(options.colorEnabled, ANSI.dim, `╰─${"─".repeat(Math.max(0, outerWidth - 3))}╯`),
      ];
    },
  };

  void refresh();
  return component;
}
