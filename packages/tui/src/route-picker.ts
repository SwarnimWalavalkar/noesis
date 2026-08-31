import {
  fuzzyFilter,
  Input,
  matchesKey,
  type Component,
  type Focusable,
  type OverlayHandle,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentThinkingLevel } from "@noesis/agent-types";
import type { TuiRoutePickerIntent, TuiRoutePickerSelection } from "./commands.ts";
import type { TuiModelRoute } from "./runtime-port.ts";
import { ANSI, elideText, safeTerminalText, styled } from "./theme.ts";

interface ModelPickerScreen {
  readonly kind: "models";
  readonly provider: string;
}

type PickerScreen =
  | ModelPickerScreen
  | {
      readonly kind: "reasoning";
      readonly route: TuiModelRoute;
      readonly previous?: {
        readonly screen: ModelPickerScreen;
        readonly query: string;
        readonly cursor: number;
      };
    };

export interface TuiRoutePickerOverlay extends Component, Focusable {
  readonly handleInput: (data: string) => void;
  readonly updateRoutes: (routes: readonly TuiModelRoute[]) => void;
  readonly cancel: () => void;
}

const boundedWidth = (width: number): number => Math.max(12, Math.floor(width));

const padded = (text: string, width: number): string => {
  const bounded = elideText(text, width);
  return `${bounded}${" ".repeat(Math.max(0, width - visibleWidth(bounded)))}`;
};

const pickerRow = (text: string, width: number, colorEnabled: boolean): string => {
  const innerWidth = Math.max(0, boundedWidth(width) - 4);
  const edge = styled(colorEnabled, ANSI.dim, "│");
  return `${edge} ${padded(text, innerWidth)} ${edge}`;
};

const pickerRule = (width: number, colorEnabled: boolean, top: boolean): string => {
  const bounded = boundedWidth(width);
  const rule = `${top ? "╭" : "╰"}${"─".repeat(Math.max(0, bounded - 2))}${top ? "╮" : "╯"}`;
  return styled(colorEnabled, ANSI.dim, rule);
};

const providerName = (routes: readonly TuiModelRoute[], provider: string): string =>
  routes.find((route) => route.provider === provider)?.providerName ?? provider;

const routesForProvider = (
  routes: readonly TuiModelRoute[],
  provider: string,
  currentProvider: string,
  currentModel: string,
): readonly TuiModelRoute[] =>
  routes
    .filter((route) => route.provider === provider)
    .sort((left, right) => {
      const leftCurrent = left.provider === currentProvider && left.model === currentModel;
      const rightCurrent = right.provider === currentProvider && right.model === currentModel;
      if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
      if (left.default !== right.default) return left.default ? -1 : 1;
      return left.model.localeCompare(right.model);
    });

export function createTuiRoutePickerOverlay(options: {
  readonly routes: readonly TuiModelRoute[];
  readonly intent: TuiRoutePickerIntent;
  readonly colorEnabled: boolean;
  readonly height: () => number;
  readonly requestRender: () => void;
  readonly select: (selection: TuiRoutePickerSelection) => void;
  readonly cancel: () => void;
}): TuiRoutePickerOverlay {
  const search = new Input();
  let focused = false;
  let cursor = 0;
  let query = "";
  let routes = options.routes;
  const currentRoute = routes.find(
    (route) =>
      route.provider === options.intent.currentProvider && route.model === options.intent.currentModel,
  );
  let screen: PickerScreen =
    options.intent.kind === "reasoning" && currentRoute
      ? { kind: "reasoning", route: currentRoute }
      : { kind: "models", provider: options.intent.currentProvider };
  if (screen.kind === "reasoning") {
    const levels: readonly AgentThinkingLevel[] =
      screen.route.thinkingLevels.length > 0 ? screen.route.thinkingLevels : ["off"];
    const preferred = levels.indexOf(options.intent.currentThinkingLevel);
    cursor = preferred >= 0 ? preferred : Math.max(0, levels.length - 1);
  }

  const unfilteredModels = (): readonly TuiModelRoute[] =>
    screen.kind === "models"
      ? routesForProvider(
          routes,
          screen.provider,
          options.intent.currentProvider,
          options.intent.currentModel,
        )
      : [];
  const models = (): readonly TuiModelRoute[] =>
    fuzzyFilter([...unfilteredModels()], query, (route) => `${route.provider} ${route.model} ${route.name}`);
  const reasoningLevels = (): readonly AgentThinkingLevel[] =>
    screen.kind === "reasoning"
      ? screen.route.thinkingLevels.length > 0
        ? screen.route.thinkingLevels
        : ["off"]
      : [];
  const itemCount = (): number => (screen.kind === "models" ? models().length : reasoningLevels().length);
  const selectedModel = (): TuiModelRoute | undefined =>
    screen.kind === "models" ? models()[cursor] : undefined;
  const render = (): void => options.requestRender();
  const resetCursor = (preferred = 0): void => {
    cursor = Math.max(0, Math.min(preferred, Math.max(0, itemCount() - 1)));
  };
  const navigate = (delta: number): void => {
    const count = itemCount();
    if (count === 0) return;
    cursor = (cursor + delta + count) % count;
    render();
  };
  const openReasoning = (route: TuiModelRoute): void => {
    if (screen.kind !== "models") return;
    const previous = { screen, query, cursor } as const;
    screen = { kind: "reasoning", route, previous };
    query = "";
    search.setValue("");
    const levels = reasoningLevels();
    const preferred = levels.indexOf(options.intent.currentThinkingLevel);
    resetCursor(preferred >= 0 ? preferred : Math.max(0, levels.length - 1));
    search.focused = false;
    render();
  };
  const accept = (): void => {
    if (screen.kind === "models") {
      const route = selectedModel();
      if (route) openReasoning(route);
      return;
    }
    const thinkingLevel = reasoningLevels()[cursor];
    if (thinkingLevel) options.select({ route: screen.route, thinkingLevel });
  };
  const cancel = (): void => {
    if (screen.kind === "reasoning") {
      const previous = screen.previous;
      if (!previous) {
        options.cancel();
        return;
      }
      screen = previous.screen;
      query = previous.query;
      cursor = previous.cursor;
      search.setValue(query);
      search.focused = focused;
      render();
      return;
    }
    options.cancel();
  };
  const visibleRange = (count: number): readonly [number, number] => {
    const reserved = screen.kind === "models" ? 11 : 10;
    const available = Math.max(1, Math.min(10, options.height() - reserved));
    const start = Math.max(0, Math.min(cursor - Math.floor(available / 2), count - available));
    return [start, Math.min(count, start + available)];
  };
  const renderLines = (width: number): string[] => {
    const bounded = boundedWidth(width);
    const lines = [pickerRule(bounded, options.colorEnabled, true)];
    const title =
      screen.kind === "models"
        ? `SELECT MODEL · ${safeTerminalText(providerName(routes, screen.provider))}`
        : `SELECT REASONING · ${safeTerminalText(screen.route.model)}`;
    lines.push(
      pickerRow(
        styled(options.colorEnabled, `${ANSI.bold}${ANSI.cyan}`, title),
        bounded,
        options.colorEnabled,
      ),
    );
    lines.push(pickerRow("", bounded, options.colorEnabled));
    if (screen.kind === "models") {
      const input = search.render(Math.max(1, bounded - 14))[0] ?? "";
      lines.push(
        pickerRow(
          `${styled(options.colorEnabled, ANSI.dim, "Search")}  ${input}`,
          bounded,
          options.colorEnabled,
        ),
      );
      lines.push(pickerRow("", bounded, options.colorEnabled));
    }
    const count = itemCount();
    const [start, end] = visibleRange(count);
    for (let index = start; index < end; index += 1) {
      const selected = index === cursor;
      if (screen.kind === "models") {
        const route = models()[index];
        if (!route) continue;
        const current =
          route.provider === options.intent.currentProvider && route.model === options.intent.currentModel;
        const label = `${selected ? "→" : " "} ${safeTerminalText(route.model)}${current ? styled(options.colorEnabled, ANSI.green, "  ✓ current") : ""}`;
        lines.push(
          pickerRow(
            selected ? styled(options.colorEnabled, `${ANSI.bold}${ANSI.cyan}`, label) : label,
            bounded,
            options.colorEnabled,
          ),
        );
      } else {
        const level = reasoningLevels()[index];
        if (!level) continue;
        const current =
          screen.route.provider === options.intent.currentProvider &&
          screen.route.model === options.intent.currentModel &&
          level === options.intent.currentThinkingLevel;
        const label = `${selected ? "→" : " "} ${level}${current ? styled(options.colorEnabled, ANSI.green, "  ✓ current") : ""}`;
        lines.push(
          pickerRow(
            selected ? styled(options.colorEnabled, `${ANSI.bold}${ANSI.cyan}`, label) : label,
            bounded,
            options.colorEnabled,
          ),
        );
      }
    }
    if (count === 0)
      lines.push(
        pickerRow(
          styled(
            options.colorEnabled,
            ANSI.dim,
            screen.kind === "reasoning" ? "  Reasoning unavailable" : "  No matching models",
          ),
          bounded,
          options.colorEnabled,
        ),
      );
    else if (start > 0 || end < count)
      lines.push(
        pickerRow(
          styled(options.colorEnabled, ANSI.dim, `  ${String(cursor + 1)}/${String(count)}`),
          bounded,
          options.colorEnabled,
        ),
      );
    const selected = selectedModel();
    if (selected) {
      lines.push(pickerRow("", bounded, options.colorEnabled));
      lines.push(
        pickerRow(
          styled(options.colorEnabled, ANSI.dim, safeTerminalText(selected.name)),
          bounded,
          options.colorEnabled,
        ),
      );
      lines.push(
        pickerRow(
          styled(options.colorEnabled, ANSI.dim, `reasoning ${selected.thinkingLevels.join(", ") || "off"}`),
          bounded,
          options.colorEnabled,
        ),
      );
    }
    lines.push(pickerRow("", bounded, options.colorEnabled));
    lines.push(
      pickerRow(
        styled(
          options.colorEnabled,
          ANSI.dim,
          screen.kind === "models"
            ? "Type to search · ↑/↓ navigate · Enter choose model · Esc cancel"
            : `↑/↓ navigate · Enter select · Esc ${screen.previous ? "back" : "cancel"}`,
        ),
        bounded,
        options.colorEnabled,
      ),
    );
    lines.push(
      pickerRow(
        styled(
          options.colorEnabled,
          ANSI.dim,
          screen.kind === "reasoning" &&
            screen.route.provider === options.intent.currentProvider &&
            screen.route.model === options.intent.currentModel
            ? "Reasoning updates current session · provider and model unchanged"
            : "New empty session · previous preserved · history not replayed",
        ),
        bounded,
        options.colorEnabled,
      ),
    );
    lines.push(pickerRule(bounded, options.colorEnabled, false));
    return lines;
  };

  const overlay: TuiRoutePickerOverlay = {
    get focused() {
      return focused;
    },
    set focused(value: boolean) {
      focused = value;
      search.focused = value && screen.kind === "models";
    },
    render: renderLines,
    handleInput(data: string) {
      if (matchesKey(data, "escape")) {
        cancel();
        return;
      }
      if (matchesKey(data, "up")) {
        navigate(-1);
        return;
      }
      if (matchesKey(data, "down")) {
        navigate(1);
        return;
      }
      if (matchesKey(data, "enter")) {
        accept();
        return;
      }
      if (screen.kind !== "models") return;
      search.handleInput(data);
      query = search.getValue();
      resetCursor();
      render();
    },
    invalidate() {
      search.invalidate();
    },
    updateRoutes(nextRoutes) {
      routes = nextRoutes;
      if (screen.kind === "reasoning") {
        const selectedRoute = screen.route;
        const refreshed = routes.find(
          (route) => route.provider === selectedRoute.provider && route.model === selectedRoute.model,
        );
        if (refreshed) screen = { ...screen, route: refreshed };
      }
      resetCursor(cursor);
      render();
    },
    cancel: options.cancel,
  };
  return overlay;
}

export interface TuiRoutePickerOrchestration {
  readonly select: (intent: TuiRoutePickerIntent) => Promise<TuiRoutePickerSelection | undefined>;
  readonly ownsKeyboardFocus: () => boolean;
  readonly dispose: () => void;
}

export function createTuiRoutePickerOrchestration(options: {
  readonly routes: () => readonly TuiModelRoute[];
  readonly refreshRoutes?: () => Promise<readonly TuiModelRoute[]>;
  readonly tui: TUI;
  readonly colorEnabled: boolean;
  readonly height: () => number;
}): TuiRoutePickerOrchestration {
  let handle: OverlayHandle | undefined;
  let overlay: TuiRoutePickerOverlay | undefined;
  let finish: ((selection: TuiRoutePickerSelection | undefined) => void) | undefined;
  let active: Promise<TuiRoutePickerSelection | undefined> | undefined;
  const settle = (selection: TuiRoutePickerSelection | undefined): void => {
    const resolve = finish;
    finish = undefined;
    active = undefined;
    overlay = undefined;
    handle?.hide();
    handle = undefined;
    options.tui.requestRender();
    resolve?.(selection);
  };
  return Object.freeze({
    select(intent: TuiRoutePickerIntent) {
      if (active) {
        handle?.focus();
        return active;
      }
      active = new Promise<TuiRoutePickerSelection | undefined>((resolve) => {
        finish = resolve;
      });
      const openedOverlay = createTuiRoutePickerOverlay({
        routes: options.routes(),
        intent,
        colorEnabled: options.colorEnabled,
        height: options.height,
        requestRender: () => options.tui.requestRender(),
        select: (selection) => settle(selection),
        cancel: () => settle(undefined),
      });
      overlay = openedOverlay;
      handle = options.tui.showOverlay(overlay, {
        anchor: "center",
        width: "88%",
        maxHeight: "90%",
        margin: 1,
      });
      handle.focus();
      void options
        .refreshRoutes?.()
        .then((routes) => {
          if (overlay === openedOverlay) openedOverlay.updateRoutes(routes);
        })
        .catch(() => undefined);
      return active;
    },
    ownsKeyboardFocus: () => Boolean(handle?.isFocused()),
    dispose: () => overlay?.cancel(),
  });
}
