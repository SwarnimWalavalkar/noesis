import { type Component, Input, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  type AuditFilter,
  canExpandEvidence,
  canExpandInputs,
  cycleDetailFocus,
  detailPaneLabel,
  type DetailFocus,
  detailDocument,
  emptyListMessage,
  filterChips,
  formatRelativeTime,
  headlineStats,
  interactableStops,
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
  safeScalar,
  sectionRevealLine,
  toggleAllActivity,
  WIDE_LAYOUT_MIN,
  wrapDocument,
} from "./learning-audit-view.ts";
import type { NoesisTuiRuntime, TuiLearningAuditSnapshot, TuiLearningPrimitive } from "./runtime-port.ts";
import { ANSI, elideText, safeTerminalText, styled } from "./theme.ts";

function overlayEdge(text: string, colorEnabled: boolean): string {
  return styled(colorEnabled, ANSI.dim, text);
}

function normalizedWidth(width: number): number {
  return Math.max(0, Math.floor(width));
}

function overlayRule(outerWidth: number, colorEnabled: boolean, left: string, right: string): string {
  const width = normalizedWidth(outerWidth);
  if (width === 0) return "";
  if (width === 1) return overlayEdge(left, colorEnabled);
  return overlayEdge(`${left}${"─".repeat(width - 2)}${right}`, colorEnabled);
}

function overlayRow(inner: string, outerWidth: number, colorEnabled: boolean): string {
  const width = normalizedWidth(outerWidth);
  if (width === 0) return "";
  if (width === 1) return overlayEdge("│", colorEnabled);
  if (width === 2) return overlayEdge("││", colorEnabled);
  if (width === 3) return overlayEdge("│ │", colorEnabled);
  const innerWidth = width - 4;
  return `${overlayEdge("│", colorEnabled)} ${pad(elideText(inner, innerWidth), innerWidth)} ${overlayEdge("│", colorEnabled)}`;
}

type AuditScreen =
  | { readonly kind: "list" }
  | {
      readonly kind: "detail";
      readonly recordId: string;
      readonly back: AuditScreen;
      readonly raw: boolean;
    }
  | {
      readonly kind: "change";
      readonly gateRequestId: string;
      readonly input: Input;
      readonly back: Extract<AuditScreen, { readonly kind: "detail" }>;
    };

export interface LearningAuditOverlay extends Component {
  readonly dispose: () => void;
  readonly refresh: () => Promise<void>;
  readonly focusRecord: (recordId: string) => void;
}

export interface CreateLearningAuditOverlayOptions {
  readonly runtime: Pick<NoesisTuiRuntime, "inspectLearningAudit" | "manageCapability"> &
    Required<Pick<NoesisTuiRuntime, "inspectLearningAudit">>;
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
  let filter: AuditFilter = "capabilities";
  let currentSessionOnly = false;
  let failedExpanded = false;
  let cursor = 0;
  let scroll = 0;
  let relationCursor = 0;
  let detailFocus: DetailFocus = "document";
  let evidenceExpanded = false;
  let inputsExpanded = false;
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
    filter = record.group;
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
    evidenceExpanded = false;
    inputsExpanded = false;
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

  const mutateCapability = async (
    intent: Parameters<NonNullable<NoesisTuiRuntime["manageCapability"]>>[0],
  ): Promise<void> => {
    if (!options.runtime.manageCapability) {
      notice = "Capability management is unavailable in this runtime.";
      render();
      return;
    }
    busy = "Updating capability…";
    render();
    try {
      const result = await options.runtime.manageCapability(intent);
      await refresh();
      if (result.status === "stale") {
        notice = result.message;
        render();
      }
    } catch (error) {
      busy = "";
      notice = error instanceof Error ? error.message : String(error);
      render();
    }
  };

  const openGateChange = (
    gateRequestId: string,
    back: Extract<AuditScreen, { readonly kind: "detail" }>,
  ): void => {
    const input = new Input();
    input.focused = true;
    input.onEscape = () => {
      screen = back;
      render();
    };
    input.onSubmit = (value) => {
      const instruction = value.trim();
      if (!instruction) {
        notice = "Describe what should change before submitting.";
        render();
        return;
      }
      screen = back;
      void mutateCapability({ type: "change", gateRequestId, instruction });
    };
    screen = { kind: "change", gateRequestId, input, back };
    notice = undefined;
    render();
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

  const revealDocumentLine = (
    document: readonly string[],
    line: number,
    paneRows: number,
    pin: "nearest" | "start" = "nearest",
  ): void => {
    const maxScroll = Math.max(0, document.length - paneRows);
    scroll = Math.min(scroll, maxScroll);
    if (line < 0) return;
    if (pin === "start") {
      scroll = Math.min(line, maxScroll);
      return;
    }
    if (line < scroll) scroll = line;
    if (line >= scroll + paneRows) scroll = Math.max(0, line - paneRows + 1);
  };

  const revealFocusedSection = (document: readonly string[], paneRows: number): void => {
    if (detailFocus === "evidence")
      revealDocumentLine(
        document,
        sectionRevealLine(document, "EVIDENCE CITED · ", evidenceExpanded),
        paneRows,
        evidenceExpanded ? "nearest" : "start",
      );
    else if (detailFocus === "inputs")
      revealDocumentLine(
        document,
        sectionRevealLine(document, "INPUTS CONSIDERED · ", inputsExpanded),
        paneRows,
        inputsExpanded ? "nearest" : "start",
      );
    else if (detailFocus === "related") {
      const relatedAt = relatedSectionIndex(document);
      if (relatedAt >= 0) revealDocumentLine(document, relatedAt + 1 + relationCursor, paneRows, "start");
    }
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
    if (!selected) return;
    openRecord(selected.id, screen);
    if (!matchesKey(data, "tab")) return;
    const first = interactableStops(selected)[0];
    if (!first) return;
    detailFocus = first;
    render();
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
    if (record?.kind === "capability" && record.capabilityId && record.capabilityBindingRevision) {
      if (data === "p") {
        void mutateCapability({
          type: record.capabilityState === "paused" ? "resume" : "pause",
          capabilityId: record.capabilityId,
          expectedBindingRevision: record.capabilityBindingRevision,
        });
        return;
      }
      if (data === "m") {
        void mutateCapability({
          type: "set-activation-mode",
          capabilityId: record.capabilityId,
          mode: record.capabilityActivationMode === "always" ? "relevant" : "always",
          expectedBindingRevision: record.capabilityBindingRevision,
        });
        return;
      }
      if (data === "g") {
        const nextScope =
          record.capabilityScope === "global"
            ? "project"
            : record.capabilityScope === "project"
              ? "session"
              : "global";
        const sessionId = snapshot?.sessionId;
        if (nextScope === "session") {
          if (!sessionId) return;
          void mutateCapability({
            type: "set-scope",
            capabilityId: record.capabilityId,
            scope: nextScope,
            sessionId,
            expectedBindingRevision: record.capabilityBindingRevision,
          });
        } else
          void mutateCapability({
            type: "set-scope",
            capabilityId: record.capabilityId,
            scope: nextScope,
            expectedBindingRevision: record.capabilityBindingRevision,
          });
        return;
      }
    }
    if (
      record?.kind === "capability_revision" &&
      record.status === "superseded" &&
      record.capabilityId &&
      record.capabilityRevisionId &&
      record.capabilityBundleDigest &&
      record.capabilityBindingRevision &&
      data === "v"
    ) {
      void mutateCapability({
        type: "restore",
        capabilityId: record.capabilityId,
        target: {
          kind: "capability_revision",
          capabilityId: record.capabilityId,
          capabilityRevisionId: record.capabilityRevisionId,
          bundleDigest: record.capabilityBundleDigest,
        },
        expectedBindingRevision: record.capabilityBindingRevision,
      });
      return;
    }
    if (record?.kind === "capability_gate" && record.gateRequestId) {
      if (data === "y") {
        void mutateCapability({ type: "approve", gateRequestId: record.gateRequestId });
        return;
      }
      if (data === "n") {
        void mutateCapability({ type: "deny", gateRequestId: record.gateRequestId });
        return;
      }
      if (data === "c") {
        openGateChange(record.gateRequestId, detail);
        return;
      }
    }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      if (record && !detail.raw)
        detailFocus = cycleDetailFocus(record, detailFocus, matchesKey(data, "shift+tab"));
      render();
      return;
    }
    if (data === " ") {
      screen = { ...detail, raw: !detail.raw };
      scroll = 0;
      detailFocus = "document";
      render();
      return;
    }
    if (data === "i" && record && canExpandInputs(record) && !detail.raw) {
      detailFocus = "inputs";
      inputsExpanded = !inputsExpanded;
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
      if (detailFocus === "evidence" && record && canExpandEvidence(record) && !detail.raw) {
        evidenceExpanded = !evidenceExpanded;
        render();
        return;
      }
      if (detailFocus === "inputs" && record && canExpandInputs(record) && !detail.raw) {
        inputsExpanded = !inputsExpanded;
        render();
        return;
      }
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
      ? `↑/↓ · Enter open · Tab details · a all · f group · s session${failed} · r refresh · Esc`
      : `↑/↓ · Enter open · a all · f group · s session${failed} · r refresh · Esc`;
  };

  const detailHint = (record: TuiLearningPrimitive | undefined): string => {
    const management =
      record?.kind === "capability"
        ? " · p pause/resume · m relevant/always · g scope"
        : record?.kind === "capability_revision" && record.status === "superseded"
          ? " · v restore"
          : record?.kind === "capability_gate"
            ? " · y approve · n deny · c change"
            : "";
    const stops = record ? interactableStops(record) : [];
    if (detailFocus === "evidence")
      return `↑/↓ · Enter ${evidenceExpanded ? "hides" : "expands"} · Tab next · Space raw${management} · Esc`;
    if (detailFocus === "inputs")
      return `↑/↓ · Enter ${inputsExpanded ? "hides" : "expands"} · Tab next · Space raw${management} · Esc`;
    if (detailFocus === "related") return `↑/↓ · Enter open · Tab next · Space raw${management} · Esc`;
    if (stops.length > 0) return `↑/↓ · Tab next · Space raw${management} · Esc`;
    return `↑/↓ · Space raw${management} · Esc`;
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
      if (screen.kind === "change") return screen.input.handleInput(data);
      if (screen.kind === "list") return handleList(data);
      return handleDetail(data, screen);
    },
    render(outerWidth) {
      const width = Math.max(1, normalizedWidth(outerWidth) - 4);
      const height = Math.max(8, options.height() - 4);
      wideLayout = width >= WIDE_LAYOUT_MIN;
      const clock = now();
      const noticeRows = notice ? wrapTextWithAnsi(safeTerminalText(notice), width).slice(0, 3) : [];
      const bodyRows = Math.max(1, height - 6 - noticeRows.length);
      let body: readonly string[];
      if (busy) body = [styled(options.colorEnabled, ANSI.cyan, busy)];
      else if (!snapshot)
        body = [styled(options.colorEnabled, ANSI.red, "The learning ledger is unavailable.")];
      else if (screen.kind === "change")
        body = [
          styled(options.colorEnabled, ANSI.bold, "How should this Capability change?"),
          styled(
            options.colorEnabled,
            ANSI.dim,
            "Describe the correction in natural language. Noesis will author a new exact revision and keep it pending for review.",
          ),
          "",
          ...screen.input.render(width),
        ];
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
            paneRule(
              filter === "capabilities" ? "capabilities" : "activity",
              screen.kind === "list",
              leftWidth,
              options.colorEnabled,
            ),
            ...((filter === "capabilities" || filter === "noteworthy") && routineCount > 0
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
              paneRule("details", false, rightWidth, options.colorEnabled),
              styled(options.colorEnabled, ANSI.dim, empty ?? "Select a record."),
            ];
          else {
            const focused = screen.kind === "detail";
            const document = wrapDocument(
              [
                paneRule(detailPaneLabel(selected), focused, rightWidth, options.colorEnabled),
                ...(focused && screen.kind === "detail"
                  ? detailDocument(
                      selected,
                      screen.raw,
                      relationCursor,
                      rightWidth,
                      options.colorEnabled,
                      clock,
                      detailFocus,
                      evidenceExpanded,
                      inputsExpanded,
                    )
                  : previewDocument(selected, rightWidth, options.colorEnabled, clock)),
              ],
              rightWidth,
            );
            const maxScroll = Math.max(0, document.length - paneRows);
            if (focused) {
              scroll = Math.min(scroll, maxScroll);
              revealFocusedSection(document, paneRows);
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
            ...((filter === "capabilities" || filter === "noteworthy") && routineCount > 0
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
              Math.max(
                1,
                bodyRows -
                  overview.length -
                  (routineCount > 0 && (filter === "capabilities" || filter === "noteworthy") ? 2 : 0),
              ),
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
                detailFocus,
                evidenceExpanded,
                inputsExpanded,
              ),
              width,
            );
            const maxScroll = Math.max(0, document.length - bodyRows);
            scroll = Math.min(scroll, maxScroll);
            revealFocusedSection(document, bodyRows);
            body = document.slice(scroll, scroll + bodyRows);
          }
        }
      }
      const subtitle =
        screen.kind === "list"
          ? "capabilities"
          : screen.kind === "change"
            ? "change capability"
            : safeScalar(detailRecord()?.kind ?? "record").replaceAll("_", " ");
      const hint =
        screen.kind === "list"
          ? listHint()
          : screen.kind === "change"
            ? "Enter submit · Esc back"
            : detailHint(detailRecord());
      return [
        overlayRule(outerWidth, options.colorEnabled, "╭", "╮"),
        overlayRow(
          `${styled(options.colorEnabled, `${ANSI.bold}${ANSI.cyan}`, "LEARNING")}${styled(options.colorEnabled, ANSI.dim, ` · ${subtitle}`)}`,
          outerWidth,
          options.colorEnabled,
        ),
        ...noticeRows.map((line) =>
          overlayRow(styled(options.colorEnabled, ANSI.yellow, line), outerWidth, options.colorEnabled),
        ),
        ...body.slice(0, bodyRows).map((line) => overlayRow(line, outerWidth, options.colorEnabled)),
        overlayRow(styled(options.colorEnabled, ANSI.dim, hint), outerWidth, options.colorEnabled),
        overlayRule(outerWidth, options.colorEnabled, "╰", "╯"),
      ];
    },
  };

  void refresh();
  return component;
}
