import {
  SelectList,
  type Component,
  type Focusable,
  type OverlayHandle,
  type SelectListTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  compareTrailRecency,
  type RuntimeAgentDefaults,
  type TrailState,
  type TrailSummary,
} from "@noesis/runtime";
import { ANSI, elideText, safeTerminalText, styled } from "./theme.ts";
import type { TuiMcpInteractionBridge } from "./mcp-interaction.ts";
import type { NoesisTuiRuntime } from "./runtime-port.ts";

export interface TuiStartOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel?: RuntimeAgentDefaults["thinkingLevel"];
  /** One application-owned invitation shared across first-launch setup and the main shell. */
  readonly startupNote?: string;
  /** Overrides $VISUAL/$EDITOR for Ctrl+G composer editing. */
  readonly externalEditorCommand?: string;
  /** Bridge created before runtime composition so MCP server requests can wait for the mounted TUI. */
  readonly mcpInteractionBridge?: TuiMcpInteractionBridge;
  /** Opens URL elicitation in the system browser; the overlay always keeps the URL copyable. */
  readonly openUrl?: (url: string) => Promise<void>;
  readonly session?:
    | { readonly mode: "new" }
    | { readonly mode: "pick" }
    | { readonly mode: "continue" }
    | { readonly mode: "resume"; readonly trailId: string };
}

type TuiSessionRequest = NonNullable<TuiStartOptions["session"]>;
export type ResolvedTuiSessionRequest = Exclude<TuiSessionRequest, { readonly mode: "continue" }>;

export function resolveTuiSessionRequest(
  runtime: NoesisTuiRuntime,
  requested: TuiSessionRequest = { mode: "new" },
): ResolvedTuiSessionRequest {
  if (requested.mode !== "continue") return requested;
  const latest = runtime.listTrailSummaries()[0];
  if (!latest)
    throw new Error(
      `No saved sessions were found in ${runtime.home ?? "the configured Noesis home"}. Start a new session with noesis (without --continue).`,
    );
  return { mode: "resume", trailId: latest.trailId };
}

export interface SessionPickerItem {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

const shortTrailId = (trailId: string): string => {
  const separator = trailId.indexOf("_");
  if (separator < 0) return elideText(trailId, 14);
  return `${trailId.slice(0, separator + 1)}${trailId.slice(separator + 1, separator + 9)}`;
};

const singleLine = (text: string): string => text.replace(/\s+/g, " ").trim();

export function createSessionPickerItems(summaries: readonly TrailSummary[]): readonly SessionPickerItem[] {
  return [...summaries].sort(compareTrailRecency).map((summary) => {
    const timestamp = `${summary.updatedAt.slice(0, 10)} ${summary.updatedAt.slice(11, 16)}Z`;
    const model = `${summary.provider}/${summary.model}`;
    const preview = singleLine(summary.preview || summary.title || "Untitled session");
    return {
      value: summary.trailId,
      label: `${shortTrailId(summary.trailId)}  ${timestamp}  ${summary.status}  ${model}  ${summary.turnCount}t/${summary.messageCount}m`,
      description: elideText(preview, 120),
    };
  });
}

export function sessionPickerVisibleCount(height: number): number {
  // Two heading rows plus a possible SelectList scroll indicator must always fit.
  return Math.max(1, Math.min(10, height - 3));
}

export interface ResponsiveSessionPicker extends Component {
  onSelect?: (item: SessionPickerItem) => void;
  onCancel?: () => void;
  readonly selectedItem: () => SessionPickerItem | undefined;
}

export interface TuiSessionPickerOrchestration {
  readonly select: (options?: { readonly startTui?: boolean }) => Promise<string | undefined>;
  readonly ownsKeyboardFocus: () => boolean;
  readonly dispose: () => void;
}

export function createTuiSessionPickerOrchestration(input: {
  readonly runtime: NoesisTuiRuntime;
  readonly tui: TUI;
  readonly theme: SelectListTheme;
  readonly colorEnabled: boolean;
  readonly height: () => number;
  readonly currentTrailId?: () => string | undefined;
}): TuiSessionPickerOrchestration {
  let handle: OverlayHandle | undefined;
  let finish: ((trailId: string | undefined) => void) | undefined;
  let active: Promise<string | undefined> | undefined;
  const settle = (trailId: string | undefined): void => {
    const resolve = finish;
    finish = undefined;
    active = undefined;
    handle?.hide();
    handle = undefined;
    input.tui.requestRender();
    resolve?.(trailId);
  };
  return Object.freeze({
    select(options: { readonly startTui?: boolean } = {}) {
      if (active) {
        handle?.focus();
        return active;
      }
      let items = createSessionPickerItems(input.runtime.listTrailSummaries());
      if (items.length === 0)
        return Promise.reject(
          new Error(
            `No saved sessions were found in ${input.runtime.home ?? "the configured Noesis home"}. Start a new session with noesis (without --resume).`,
          ),
        );
      active = new Promise<string | undefined>((resolve) => {
        finish = resolve;
      });
      let confirmation: SessionPickerItem | undefined;
      let notice: string | undefined;
      let deleting = false;
      const createPicker = (): ResponsiveSessionPicker => {
        const next = createResponsiveSessionPicker(
          items,
          () => Math.max(1, input.height() - (confirmation || notice ? 5 : 2)),
          input.theme,
        );
        next.onSelect = (item) => settle(item.value);
        next.onCancel = () => settle(undefined);
        return next;
      };
      let picker = createPicker();
      const confirmDeletion = (): void => {
        const selected = picker.selectedItem();
        if (!selected) return;
        if (selected.value === input.currentTrailId?.()) {
          notice = "The current session cannot be deleted. Resume another session first.";
          input.tui.requestRender();
          return;
        }
        notice = undefined;
        confirmation = selected;
        input.tui.requestRender();
      };
      const deleteConfirmed = (): void => {
        const selected = confirmation;
        if (!selected || deleting) return;
        deleting = true;
        input.tui.requestRender();
        void input.runtime.deleteTrail(selected.value).then(
          () => {
            deleting = false;
            confirmation = undefined;
            items = createSessionPickerItems(input.runtime.listTrailSummaries());
            if (items.length === 0) {
              settle(undefined);
              return;
            }
            picker = createPicker();
            notice = "Session deleted from resume and search.";
            input.tui.requestRender();
          },
          (cause: unknown) => {
            deleting = false;
            confirmation = undefined;
            notice = safeTerminalText(cause instanceof Error ? cause.message : String(cause));
            input.tui.requestRender();
          },
        );
      };
      let focused = false;
      const overlay: Component & Focusable = {
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
        },
        render(width) {
          const guidance = confirmation
            ? [
                confirmation.label,
                "Delete from resume and search? Linked learning and audit evidence remains.",
                deleting ? "Deleting…" : "d again to delete · Esc keep",
              ]
            : ["↑/↓ navigate · Enter resume · d delete · Esc cancel", ...(notice ? [notice] : [])];
          return [
            `${styled(input.colorEnabled, `${ANSI.bold}${ANSI.cyan}`, "NOESIS")}  ${styled(input.colorEnabled, ANSI.dim, "resume a session")}`,
            ...guidance.map((line) => styled(input.colorEnabled, ANSI.dim, elideText(line, width))),
            ...picker.render(width),
          ];
        },
        handleInput(data) {
          if (confirmation) {
            if (data === "\u001b") {
              confirmation = undefined;
              input.tui.requestRender();
            } else if (data === "d" || data === "D") deleteConfirmed();
            return;
          }
          if (data === "d" || data === "D") {
            confirmDeletion();
            return;
          }
          notice = undefined;
          picker.handleInput?.(data);
          input.tui.requestRender();
        },
        invalidate() {
          picker.invalidate();
        },
      };
      handle = input.tui.showOverlay(overlay, {
        anchor: "center",
        width: "92%",
        maxHeight: "90%",
        margin: 1,
      });
      handle.focus();
      if (options.startTui) input.tui.start();
      return active;
    },
    ownsKeyboardFocus: () => Boolean(handle?.isFocused()),
    dispose: () => settle(undefined),
  });
}

export function createResponsiveSessionPicker(
  items: readonly SessionPickerItem[],
  height: () => number,
  theme: SelectListTheme,
): ResponsiveSessionPicker {
  let visibleCount = -1;
  let picker: SelectList | undefined;
  let selectedValue = items[0]?.value;
  const responsive: ResponsiveSessionPicker = {
    render(width) {
      ensurePicker();
      const chromeRows = height() >= 3 ? 2 : height() >= 2 ? 1 : 0;
      return (
        picker
          ?.render(width)
          .map((line) => elideText(line, Math.max(0, width)))
          .slice(0, Math.max(1, height() - chromeRows)) ?? []
      );
    },
    handleInput(data) {
      ensurePicker();
      picker?.handleInput(data);
      selectedValue = picker?.getSelectedItem()?.value ?? selectedValue;
    },
    invalidate() {
      picker?.invalidate();
    },
    selectedItem() {
      return items.find((item) => item.value === selectedValue);
    },
  };
  const ensurePicker = (): void => {
    const nextVisibleCount = sessionPickerVisibleCount(height());
    if (picker && visibleCount === nextVisibleCount) return;
    const next = new SelectList([...items], nextVisibleCount, theme, {
      minPrimaryColumnWidth: 28,
      maxPrimaryColumnWidth: 72,
    });
    const selectedIndex = items.findIndex((item) => item.value === selectedValue);
    if (selectedIndex >= 0) next.setSelectedIndex(selectedIndex);
    next.onSelectionChange = (item) => {
      selectedValue = item.value;
    };
    next.onSelect = (item) => {
      const selected = items.find((candidate) => candidate.value === item.value);
      if (selected) responsive.onSelect?.(selected);
    };
    next.onCancel = () => responsive.onCancel?.();
    visibleCount = nextVisibleCount;
    picker = next;
  };
  return responsive;
}

export async function resumableTrail(runtime: NoesisTuiRuntime, trailId: string): Promise<TrailState> {
  try {
    return await runtime.resumeTrail(trailId);
  } catch (error) {
    if (error instanceof Error && error.message === `Trail not found: ${trailId}`)
      throw new Error(
        `Session ${trailId} was not found in ${runtime.home ?? "the configured Noesis home"}. Run noesis --resume to choose an available session.`,
        { cause: error },
      );
    throw error;
  }
}
