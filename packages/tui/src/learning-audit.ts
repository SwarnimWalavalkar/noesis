import { type Component, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type {
  NoesisTuiRuntime,
  TuiLearningAuditSnapshot,
  TuiLearningPrimitive,
  TuiLearningPrimitiveGroup,
} from "./runtime-port.ts";
import { highlightCode } from "./syntax.ts";
import { ANSI, elideText, safeTerminalText, styled } from "./theme.ts";

type AuditFilter = "all" | TuiLearningPrimitiveGroup;

const FILTERS: readonly AuditFilter[] = Object.freeze([
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

function shortIdentity(value: string): string {
  const safe = safeScalar(value);
  return safe.length <= 42 ? safe : `${safe.slice(0, 19)}…${safe.slice(-18)}`;
}

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

function groupCounts(snapshot: TuiLearningAuditSnapshot): string {
  const counts = new Map<TuiLearningPrimitiveGroup, number>();
  for (const item of snapshot.primitives) counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
  const groups: readonly TuiLearningPrimitiveGroup[] = [
    "changes",
    "evaluation",
    "feedback",
    "reflection",
    "activation",
    "memory",
    "operations",
  ];
  return groups.map((group) => `${group} ${String(counts.get(group) ?? 0)}`).join(" · ");
}

function filterLabel(filter: AuditFilter): string {
  return filter === "all" ? "everything" : filter;
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
    const identity = styled(colorEnabled, ANSI.dim, `${record.kind} · ${shortIdentity(record.id)}`);
    const context = [
      safeScalar(record.status).replaceAll("_", " "),
      record.projectId ? `project ${shortIdentity(record.projectId)}` : undefined,
      record.experimentId ? `experiment ${shortIdentity(record.experimentId)}` : undefined,
      timestamp(record.occurredAt),
    ]
      .filter((value): value is string => value !== undefined)
      .join(" · ");
    return [
      elideText(`${marker} ${glyph} ${title}  ${identity}`, width),
      elideText(`    ${styled(colorEnabled, ANSI.dim, context)} · ${safeScalar(record.summary)}`, width),
    ];
  });
}

function fieldLines(record: TuiLearningPrimitive, colorEnabled: boolean): readonly string[] {
  const fields: readonly (readonly [string, string | undefined])[] = [
    ["identity", record.id],
    ["primitive", record.kind],
    ["group", record.group],
    ["status", record.status.replaceAll("_", " ")],
    ["updated", record.occurredAt],
    ["session", record.sessionId],
    ["project", record.projectId],
    ["experiment", record.experimentId],
    ["capability", record.capabilityId],
  ];
  const present = fields.filter((entry): entry is readonly [string, string] => entry[1] !== undefined);
  const keyWidth = Math.max(0, ...present.map(([key]) => key.length));
  return present.map(
    ([key, value]) => `${styled(colorEnabled, ANSI.dim, key.padEnd(keyWidth))}  ${safeTerminalText(value)}`,
  );
}

function rule(label: string, width: number, colorEnabled: boolean): string {
  const safe = safeScalar(label).toUpperCase();
  return `${styled(colorEnabled, ANSI.dim, "──")} ${styled(colorEnabled, ANSI.bold, safe)} ${styled(
    colorEnabled,
    ANSI.dim,
    "─".repeat(Math.max(0, width - safe.length - 4)),
  )}`;
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
    "",
    rule("identity", width, colorEnabled),
    ...fieldLines(record, colorEnabled),
    "",
    rule(`lineage · ${String(record.relations.length)}`, width, colorEnabled),
    ...(record.relations.length === 0
      ? [styled(colorEnabled, ANSI.dim, "No typed relationships are recorded.")]
      : record.relations.map((item, index) => {
          const selected = index === relationCursor;
          return `${styled(colorEnabled, selected ? `${ANSI.bold}${ANSI.cyan}` : ANSI.dim, selected ? "›" : " ")} ${safeScalar(item.label)} → ${safeTerminalText(item.targetId)}`;
        })),
    "",
    rule(`evidence · ${String(record.evidence.length)}`, width, colorEnabled),
    ...(record.evidence.length === 0
      ? [styled(colorEnabled, ANSI.dim, "No evidence references are recorded on this primitive.")]
      : record.evidence.map((reference) => `• ${safeTerminalText(reference)}`)),
  ];
}

function wrapDocument(lines: readonly string[], width: number): readonly string[] {
  return lines.flatMap((line) => {
    const wrapped = line ? wrapTextWithAnsi(line, width) : [""];
    return wrapped.length > 0 ? wrapped : [""];
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

  const render = (): void => {
    if (!disposed) options.requestRender();
  };

  const visibleRecords = (): readonly TuiLearningPrimitive[] => {
    const filter = FILTERS[filterIndex] ?? "all";
    const current = snapshot;
    return (
      current?.primitives.filter(
        (record) =>
          (filter === "all" || record.group === filter) &&
          (!currentSessionOnly || record.sessionId === current.sessionId),
      ) ?? []
    );
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
    if (data === "f" || matchesKey(data, "tab")) {
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
    if (!matchesKey(data, "enter")) return;
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
      const noticeRows = notice ? wrapTextWithAnsi(safeTerminalText(notice), width).slice(0, 3) : [];
      const bodyRows = Math.max(1, height - 6 - noticeRows.length);
      let body: readonly string[];
      if (busy) body = [styled(options.colorEnabled, ANSI.cyan, busy)];
      else if (!snapshot)
        body = [styled(options.colorEnabled, ANSI.red, "The learning ledger is unavailable.")];
      else if (screen.kind === "list") {
        const filter = FILTERS[filterIndex] ?? "all";
        const records = visibleRecords();
        body = [
          styled(options.colorEnabled, ANSI.dim, groupCounts(snapshot)),
          styled(
            options.colorEnabled,
            ANSI.dim,
            `view ${filterLabel(filter)} · ${currentSessionOnly ? "current session" : "all sessions"} · ${String(records.length)} records`,
          ),
          "",
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
      const title =
        screen.kind === "list"
          ? "LEARNING · audit ledger"
          : `LEARNING · ${detailRecord()?.kind.replaceAll("_", " ") ?? "record"}`;
      const hint =
        screen.kind === "list"
          ? "↑/↓ select · enter inspect · f/tab filter · s session · r refresh · esc close"
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
