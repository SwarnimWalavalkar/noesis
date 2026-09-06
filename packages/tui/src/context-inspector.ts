import {
  type Component,
  type OverlayHandle,
  type TUI,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentContextInspection } from "@noesis/agent-types";
import type { NoesisTuiRuntime } from "./runtime-port.ts";
import { ANSI, elideText, safeTerminalText, styled } from "./theme.ts";

const number = (value: number): string => Math.round(value).toLocaleString("en-US");
const compact = (value: number): string =>
  value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : number(value);

function sections(snapshot: AgentContextInspection, expanded: boolean) {
  return snapshot.components.filter((part) => expanded || part.tokens > 0);
}

function aligned(left: string, right: string, width: number): string {
  if (width <= visibleWidth(right) + 3) return elideText(`${left} ${right}`, width);
  const label = elideText(safeTerminalText(left), width - visibleWidth(right) - 2);
  return label + " ".repeat(Math.max(2, width - visibleWidth(label) - visibleWidth(right))) + right;
}

/** One cell is one equal share; tiny values are not inflated. */
export function contextMap(values: readonly number[], cells: number): readonly number[] {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (!total || cells <= 0) return [];
  let boundary = 0;
  const ends = values.map((value) => {
    boundary += Math.max(0, value) / total;
    return boundary;
  });
  return Array.from({ length: cells }, (_, index) => ends.findIndex((end) => (index + 0.5) / cells < end));
}

export function renderContextOverview(
  snapshot: AgentContextInspection,
  width: number,
  color: boolean,
  cursor = 0,
  expanded = false,
): string[] {
  const used = snapshot.components.reduce((sum, component) => sum + component.tokens, 0);
  const percentage = snapshot.inputBudget > 0 ? Math.round((used / snapshot.inputBudget) * 100) : 0;
  const cache = snapshot.cache
    ? `${Math.round((snapshot.cache.readTokens / snapshot.cache.inputTokens) * 100)}%`
    : "—";
  const map = contextMap([used, Math.max(0, snapshot.inputBudget - used)], width)
    .map((part) => styled(color, part === 0 ? ANSI.cyan : ANSI.dim, part === 0 ? "█" : "░"))
    .join("");
  const visible = sections(snapshot, expanded);
  const empty = snapshot.components.filter((part) => part.tokens === 0).length;
  return [
    styled(
      color,
      ANSI.bold + ANSI.cyan,
      aligned("CONTEXT", snapshot.source === "request" ? "Last request" : "Startup / resume preview", width),
    ),
    "",
    ...wrapTextWithAnsi(
      `~${compact(used)} / ${compact(snapshot.inputBudget)} tokens · ${percentage}% used · ${cache} cache hit rate`,
      width,
    ),
    map || styled(color, ANSI.dim, "░".repeat(width)),
    ...(used > snapshot.inputBudget
      ? wrapTextWithAnsi(styled(color, ANSI.red, "Estimated input exceeds the input budget."), width)
      : []),
    "",
    ...visible.map(
      (part, index) =>
        `${index === cursor ? "›" : " "} ${styled(color, index === cursor ? ANSI.bold + ANSI.cyan : "", aligned(part.label, number(part.tokens), Math.max(1, width - 2)))}`,
    ),
    ...(empty > 0
      ? [
          elideText(
            `${cursor === visible.length ? "›" : " "} ${expanded ? "▾" : "▸"} ${empty} empty section${empty === 1 ? "" : "s"}`,
            width,
          ),
        ]
      : []),
    "",
    styled(color, ANSI.dim, elideText("Estimated tokens · ? Budget & estimates", width)),
  ];
}

export function renderContextDetails(snapshot: AgentContextInspection, width: number): string[] {
  const used = snapshot.components.reduce((sum, part) => sum + part.tokens, 0);
  const cache = snapshot.cache;
  return [
    "CONTEXT / Budget & estimates",
    "",
    `${snapshot.provider}/${snapshot.model}`,
    `Model window      ${number(snapshot.contextWindow)} tokens`,
    `Input budget      ${number(snapshot.inputBudget)} tokens`,
    `Estimated input   ${number(used)} tokens`,
    `Available input   ${number(Math.max(0, snapshot.inputBudget - used))} tokens`,
    `Output reserve    ${number(snapshot.outputReserve)} tokens`,
    "",
    "LAST REQUEST CACHE",
    ...(cache
      ? [
          `Cache hit rate    ${Math.round((cache.readTokens / cache.inputTokens) * 100)}%`,
          `Cache reads       ${number(cache.readTokens)} tokens`,
          `Cache writes      ${number(cache.writeTokens)} tokens`,
          `Uncached input    ${number(cache.inputTokens - cache.readTokens - cache.writeTokens)} tokens`,
          `Total input       ${number(cache.inputTokens)} tokens`,
          "Cache hit rate is cache reads divided by total input tokens. Cache writes and output tokens are not hits.",
        ]
      : ["Cache — · No usable input-token accounting for this request yet."]),
    "",
    snapshot.note,
    "",
    `Captured ${snapshot.capturedAt}`,
  ].flatMap((line) => wrapTextWithAnsi(safeTerminalText(line), Math.max(1, width)));
}

export function createContextInspector(options: {
  readonly runtime: NoesisTuiRuntime;
  readonly tui: TUI;
  readonly colorEnabled: boolean;
  readonly height: () => number;
}) {
  let handle: OverlayHandle | undefined;
  let generation = 0;
  const close = (): void => {
    generation += 1;
    handle?.hide();
    handle = undefined;
    options.tui.requestRender();
  };
  return {
    dispose: close,
    ownsKeyboardFocus: () => Boolean(handle?.isFocused()),
    open(sessionId: string): void {
      close();
      const token = generation;
      let snapshot: AgentContextInspection | undefined;
      let notice = "Loading context…";
      let cursor = 0;
      let detail = false;
      let budget = false;
      let expanded = false;
      let refreshSequence = 0;
      let scroll = 0;
      let maxScroll = 0;
      let revealSelection = false;
      const refresh = async (): Promise<void> => {
        const sequence = ++refreshSequence;
        try {
          if (!options.runtime.inspectContext)
            throw new Error("Context inspection is unavailable in this runtime.");
          const loaded = await options.runtime.inspectContext(sessionId);
          if (token !== generation || sequence !== refreshSequence) return;
          snapshot = loaded;
          cursor = Math.min(cursor, Math.max(0, sections(loaded, expanded).length - 1));
          notice = "";
        } catch (error) {
          if (token !== generation || sequence !== refreshSequence) return;
          notice = error instanceof Error ? error.message : String(error);
        }
        options.tui.requestRender();
      };
      const component: Component = {
        invalidate() {},
        handleInput(key) {
          if (matchesKey(key, "escape")) {
            if (detail || budget) {
              detail = false;
              budget = false;
              scroll = 0;
            } else close();
          } else if (key === "r") {
            void refresh();
          } else if (key === "?") {
            budget = !budget;
            detail = false;
            scroll = 0;
          } else if (matchesKey(key, "enter")) {
            if (!budget && snapshot && cursor === sections(snapshot, expanded).length) {
              expanded = !expanded;
              cursor = sections(snapshot, expanded).length;
            } else if (!budget) detail = !detail;
            scroll = 0;
          } else if (matchesKey(key, "up")) {
            if (detail || budget) scroll = Math.max(0, scroll - 1);
            else {
              cursor = Math.max(0, cursor - 1);
              revealSelection = true;
            }
          } else if (matchesKey(key, "down")) {
            if (detail || budget) scroll = Math.min(maxScroll, scroll + 1);
            else {
              const count = snapshot
                ? sections(snapshot, expanded).length +
                  (snapshot.components.some((part) => part.tokens === 0) ? 1 : 0)
                : 1;
              cursor = Math.min(Math.max(0, count - 1), cursor + 1);
              revealSelection = true;
            }
          } else if (matchesKey(key, "pageUp")) scroll = Math.max(0, scroll - 8);
          else if (matchesKey(key, "pageDown")) scroll = Math.min(maxScroll, scroll + 8);
          options.tui.requestRender();
        },
        render(width) {
          if (width < 5) return [elideText("Context", width)];
          const inner = width - 4;
          const selected = snapshot ? sections(snapshot, expanded)[cursor] : undefined;
          const document = notice
            ? wrapTextWithAnsi(safeTerminalText(notice), inner)
            : snapshot && budget
              ? renderContextDetails(snapshot, inner)
              : snapshot && detail && selected
                ? [
                    ...wrapTextWithAnsi(safeTerminalText(`CONTEXT / ${selected.label}`), inner),
                    `~${number(selected.tokens)} tokens · estimated`,
                    "",
                    ...wrapTextWithAnsi(
                      safeTerminalText(selected.content || "No material in this component."),
                      inner,
                    ),
                  ]
                : snapshot
                  ? renderContextOverview(snapshot, inner, options.colorEnabled, cursor, expanded)
                  : [];
          const rows = Math.max(1, options.height() - 7);
          maxScroll = Math.max(0, document.length - rows);
          scroll = Math.min(scroll, maxScroll);
          if (!detail && !budget && snapshot && revealSelection) {
            const selectedLine = document.findIndex((line) => line.startsWith("›"));
            if (selectedLine >= scroll + rows) scroll = selectedLine - rows + 1;
            if (selectedLine >= 0 && selectedLine < scroll) scroll = selectedLine;
            revealSelection = false;
          }
          const row = (text: string): string => {
            const clipped = elideText(text, inner);
            return `│ ${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))} │`;
          };
          return [
            "╭" + "─".repeat(width - 2) + "╮",
            ...document.slice(scroll, scroll + rows).map(row),
            row(
              detail || budget
                ? "↑↓ scroll · PgUp/PgDn · Esc back"
                : "↑↓ select · Enter inspect · ? details · r refresh · Esc",
            ),
            "╰" + "─".repeat(width - 2) + "╯",
          ];
        },
      };
      handle = options.tui.showOverlay(component, {
        anchor: "center",
        width: 84,
        margin: 1,
        maxHeight: "95%",
      });
      void refresh();
    },
  };
}
