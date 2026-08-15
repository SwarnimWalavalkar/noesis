import { type Component, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  type AuditFilter,
  type DetailFocus,
  detailDocument,
  emptyListMessage,
  filterChips,
  formatRelativeTime,
  headlineStats,
  isNoteworthy,
  isQuietFailure,
  isRoutine,
  joinColumns,
  listViewport,
  navigableRecords,
  nextGroupFilter,
  PAGE_STEP,
  pad,
  paneRule,
  previewDocument,
  relatedSectionIndex,
  toggleAllActivity,
  WIDE_LAYOUT_MIN,
  wrapDocument,
} from "./learning-audit-view.ts";
import type { NoesisTuiRuntime, TuiLearningAuditSnapshot, TuiLearningPrimitive } from "./runtime-port.ts";
import { ANSI, elideText, safeTerminalText, styled } from "./theme.ts";

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
  readonly focusRecord: (recordId: string) => void;
}

export interface CreateLearningAuditOverlayOptions {
  readonly runtime: Required<Pick<NoesisTuiRuntime, "inspectLearningAudit">>;
  readonly sessionId: string;
  readonly colorEnabled: boolean;
  readonly height: () => number;
  readonly requestRender: () => void;
  readonly close: () => void;
  readonly focusRecordId?: string;
  readonly now?: () => Date;
}

export function createLearningAuditOverlay(options: CreateLearningAuditOverlayOptions): LearningAuditOverlay {
  let disposed = false;
  let generation = 0;
  let snapshot: TuiLearningAuditSnapshot | undefined;
  let busy = "Loading the learning ledger…";
  let notice: string | undefined;
  let screen: AuditScreen = { kind: "list" };
  let filter: AuditFilter = "noteworthy";
  let currentSessionOnly = false;
  let failedExpanded = false;
  let cursor = 0;
  let scroll = 0;
  let relationCursor = 0;
  let detailFocus: DetailFocus = "document";
  let wideLayout = false;
  let pendingFocusId = options.focusRecordId;

  const now = (): Date => options.now?.() ?? new Date();

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

  const collapseFailures = (): boolean => filter === "noteworthy" || filter === "all";

  const filteredRecords = (): readonly TuiLearningPrimitive[] => {
    const scoped = scopedRecords();
    if (filter === "noteworthy") return scoped.filter(isNoteworthy);
    if (filter === "all") return scoped;
    return scoped.filter((record) => record.group === filter);
  };

  const failedCount = (): number =>
    collapseFailures() ? filteredRecords().filter(isQuietFailure).length : 0;

  const visibleRecords = (): readonly TuiLearningPrimitive[] =>
    navigableRecords(filteredRecords(), collapseFailures() ? failedExpanded : true);

  const listOptions = (): {
    readonly grouped: boolean;
    readonly failedCount: number;
    readonly failedExpanded: boolean;
  } =>
    Object.freeze({
      grouped: filter === "noteworthy" || filter === "all",
      failedCount: failedCount(),
      failedExpanded: collapseFailures() ? failedExpanded : true,
    });

  const revealRecord = (record: TuiLearningPrimitive): void => {
    if (currentSessionOnly && record.sessionId !== snapshot?.sessionId) currentSessionOnly = false;
    if (isQuietFailure(record) && collapseFailures()) failedExpanded = true;
    if (visibleRecords().some((candidate) => candidate.id === record.id)) return;
    filter = isNoteworthy(record) ? "noteworthy" : "all";
    if (visibleRecords().some((candidate) => candidate.id === record.id)) return;
    filter = "all";
  };

  const openRecord = (recordId: string, back: AuditScreen): void => {
    const visibleIndex = visibleRecords().findIndex((record) => record.id === recordId);
    if (visibleIndex >= 0) cursor = visibleIndex;
    screen = { kind: "detail", recordId, back, raw: false };
    scroll = 0;
    relationCursor = 0;
    detailFocus = "document";
    render();
  };

  const applyFocus = (recordId: string): boolean => {
    const record = snapshot?.primitives.find((candidate) => candidate.id === recordId);
    if (!record) return false;
    revealRecord(record);
    openRecord(recordId, { kind: "list" });
    return true;
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
      if (pendingFocusId) {
        const focused = applyFocus(pendingFocusId);
        pendingFocusId = undefined;
        if (!focused) render();
      } else render();
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

  const detailRecord = (): TuiLearningPrimitive | undefined => {
    if (screen.kind !== "detail") return undefined;
    const recordId = screen.recordId;
    return snapshot?.primitives.find((record) => record.id === recordId);
  };

  const moveRelated = (record: TuiLearningPrimitive, delta: number): void => {
    if (record.relations.length === 0) return;
    detailFocus = "related";
    relationCursor = Math.max(0, Math.min(relationCursor + delta, record.relations.length - 1));
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
      filter = toggleAllActivity(filter);
      cursor = 0;
      render();
      return;
    }
    if (data === "f") {
      filter = nextGroupFilter(filter);
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
    if (data === "x" && failedCount() > 0) {
      failedExpanded = !failedExpanded;
      cursor = Math.min(cursor, Math.max(0, visibleRecords().length - 1));
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
      detailFocus = "document";
      render();
      return;
    }
    if (matchesKey(data, "tab")) {
      if (detailFocus === "document" && record && record.relations.length > 0) {
        detailFocus = "related";
        render();
        return;
      }
      if (wideLayout || detailFocus === "related") {
        if (wideLayout) {
          screen = detail.back;
          scroll = 0;
        }
        detailFocus = "document";
        render();
        return;
      }
      return;
    }
    if (data === " ") {
      screen = { ...detail, raw: !detail.raw };
      scroll = 0;
      detailFocus = "document";
      render();
      return;
    }
    if (matchesKey(data, "up")) {
      if (detailFocus === "related" && record) moveRelated(record, -1);
      else scroll = Math.max(0, scroll - 1);
    } else if (matchesKey(data, "down")) {
      if (detailFocus === "related" && record) moveRelated(record, 1);
      else scroll += 1;
    } else if (matchesKey(data, "pageUp")) scroll = Math.max(0, scroll - PAGE_STEP);
    else if (matchesKey(data, "pageDown")) scroll += PAGE_STEP;
    else if (matchesKey(data, "left") && record?.relations.length) moveRelated(record, -1);
    else if (matchesKey(data, "right") && record?.relations.length) moveRelated(record, 1);
    else if (matchesKey(data, "enter")) {
      if (detailFocus !== "related") return;
      const target = record?.relations[relationCursor];
      if (target && snapshot?.primitives.some((candidate) => candidate.id === target.targetId)) {
        openRecord(target.targetId, detail);
        return;
      }
      notice = target ? "That related record is outside this view." : undefined;
    } else return;
    render();
  };

  const listHint = (): string => {
    const failed = failedCount() > 0 ? " · x failed" : "";
    return wideLayout
      ? `↑/↓ · Enter open · Tab decision · a all · f group · s session${failed} · r refresh · Esc`
      : `↑/↓ · Enter open · a all · f group · s session${failed} · r refresh · Esc`;
  };

  const detailHint = (record: TuiLearningPrimitive | undefined): string => {
    const related = Boolean(record?.relations.length);
    if (detailFocus === "related")
      return wideLayout
        ? "↑/↓ · Enter open · Tab activity · Space raw · Esc"
        : "↑/↓ · Enter open · Tab back · Space raw · Esc";
    if (related) return "↑/↓ · Tab related · Space raw · Esc";
    return wideLayout ? "↑/↓ · Space raw · Tab activity · Esc" : "↑/↓ · Space raw · Esc";
  };

  const component: LearningAuditOverlay = {
    dispose() {
      disposed = true;
      generation += 1;
    },
    refresh,
    focusRecord(recordId) {
      if (snapshot) {
        if (!applyFocus(recordId)) pendingFocusId = recordId;
        return;
      }
      pendingFocusId = recordId;
    },
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
      const clock = now();
      const noticeRows = notice ? wrapTextWithAnsi(safeTerminalText(notice), width).slice(0, 3) : [];
      const bodyRows = Math.max(1, height - 6 - noticeRows.length);
      let body: readonly string[];
      if (busy) body = [styled(options.colorEnabled, ANSI.cyan, busy)];
      else if (!snapshot)
        body = [styled(options.colorEnabled, ANSI.red, "The learning ledger is unavailable.")];
      else {
        const records = visibleRecords();
        const scoped = scopedRecords();
        const routineCount = scoped.filter(isRoutine).length;
        const updated = formatRelativeTime(snapshot.generatedAt, clock);
        const stats = headlineStats(scoped, options.colorEnabled);
        const overview = wrapDocument(
          [
            ...(stats.length > 0 ? [stats] : []),
            filterChips(filter, options.colorEnabled),
            styled(
              options.colorEnabled,
              ANSI.dim,
              `${currentSessionOnly ? "current session" : "all sessions"} · ${String(records.length)} visible${updated ? ` · updated ${updated}` : ""}`,
            ),
            "",
          ],
          width,
        );
        if (wideLayout) {
          const paneRows = Math.max(1, bodyRows - overview.length);
          const leftWidth = Math.min(52, Math.max(36, Math.floor(width * 0.38)));
          const rightWidth = Math.max(24, width - leftWidth - 3);
          const empty = emptyListMessage(filter, records.length, scoped.length, routineCount, failedCount());
          const leftPrefix = [
            paneRule("activity", screen.kind === "list", leftWidth, options.colorEnabled),
            ...(filter === "noteworthy" && routineCount > 0
              ? [
                  styled(
                    options.colorEnabled,
                    ANSI.dim,
                    `${String(routineCount)} routine hidden · a shows all`,
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
              clock,
              empty,
              listOptions(),
            ),
          ];
          const selected = screen.kind === "detail" ? detailRecord() : records[cursor];
          let right: readonly string[];
          if (!selected)
            right = [
              paneRule("decision", false, rightWidth, options.colorEnabled),
              styled(options.colorEnabled, ANSI.dim, empty ?? "Select a record."),
            ];
          else {
            const focused = screen.kind === "detail";
            const document = wrapDocument(
              [
                paneRule("decision", focused, rightWidth, options.colorEnabled),
                ...(focused && screen.kind === "detail"
                  ? detailDocument(
                      selected,
                      screen.raw,
                      relationCursor,
                      rightWidth,
                      options.colorEnabled,
                      clock,
                      detailFocus === "related",
                    )
                  : previewDocument(selected, rightWidth, options.colorEnabled, clock)),
              ],
              rightWidth,
            );
            const maxScroll = Math.max(0, document.length - paneRows);
            if (focused) {
              scroll = Math.min(scroll, maxScroll);
              if (detailFocus === "related") {
                const relatedAt = relatedSectionIndex(document);
                if (relatedAt >= 0) {
                  const target = relatedAt + 1 + relationCursor;
                  if (target < scroll) scroll = target;
                  if (target >= scroll + paneRows) scroll = Math.max(0, target - paneRows + 1);
                }
              }
            }
            const start = focused ? scroll : 0;
            right = document.slice(start, start + paneRows);
          }
          body = [
            ...overview,
            ...joinColumns(left, right, leftWidth, rightWidth, paneRows, options.colorEnabled),
          ];
        } else if (screen.kind === "list") {
          const empty = emptyListMessage(filter, records.length, scoped.length, routineCount, failedCount());
          body = [
            ...overview,
            ...(filter === "noteworthy" && routineCount > 0
              ? [
                  styled(
                    options.colorEnabled,
                    ANSI.dim,
                    `${String(routineCount)} routine hidden · a shows all`,
                  ),
                  "",
                ]
              : []),
            ...listViewport(
              records,
              cursor,
              width,
              Math.max(1, bodyRows - overview.length - (routineCount > 0 && filter === "noteworthy" ? 2 : 0)),
              options.colorEnabled,
              clock,
              empty,
              listOptions(),
            ),
          ];
        } else {
          const record = detailRecord();
          if (!record)
            body = [styled(options.colorEnabled, ANSI.red, "This learning record is unavailable.")];
          else {
            const document = wrapDocument(
              detailDocument(
                record,
                screen.raw,
                relationCursor,
                width,
                options.colorEnabled,
                clock,
                detailFocus === "related",
              ),
              width,
            );
            const maxScroll = Math.max(0, document.length - bodyRows);
            scroll = Math.min(scroll, maxScroll);
            if (detailFocus === "related") {
              const relatedAt = relatedSectionIndex(document);
              if (relatedAt >= 0) {
                const target = relatedAt + 1 + relationCursor;
                if (target < scroll) scroll = target;
                if (target >= scroll + bodyRows) scroll = Math.max(0, target - bodyRows + 1);
              }
            }
            body = document.slice(scroll, scroll + bodyRows);
          }
        }
      }
      const subtitle =
        screen.kind === "list"
          ? "project evolution"
          : safeTerminalText(detailRecord()?.kind ?? "record")
              .replaceAll("\t", " ")
              .replaceAll("\n", " ")
              .replaceAll("_", " ");
      const hint = screen.kind === "list" ? listHint() : detailHint(detailRecord());
      return [
        styled(options.colorEnabled, ANSI.dim, `╭─ ${"─".repeat(Math.max(0, outerWidth - 4))}╮`),
        elideText(
          `│ ${styled(options.colorEnabled, `${ANSI.bold}${ANSI.cyan}`, "LEARNING")}${styled(options.colorEnabled, ANSI.dim, ` · ${subtitle}`)}`,
          outerWidth,
        ),
        ...(noticeRows.length > 0
          ? noticeRows.map((line) =>
              elideText(`│ ${styled(options.colorEnabled, ANSI.yellow, line)}`, outerWidth),
            )
          : []),
        ...body.slice(0, bodyRows).map((line) => elideText(`│ ${pad(line, width)}`, outerWidth)),
        elideText(`│ ${styled(options.colorEnabled, ANSI.dim, hint)}`, outerWidth),
        styled(options.colorEnabled, ANSI.dim, `╰─ ${"─".repeat(Math.max(0, outerWidth - 4))}╯`),
      ];
    },
  };

  void refresh();
  return component;
}
