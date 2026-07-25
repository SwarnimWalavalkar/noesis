import { SelectList, type Component, type SelectListTheme } from "@earendil-works/pi-tui";
import {
  compareTrailRecency,
  type RuntimeAgentDefaults,
  type TrailState,
  type TrailSummary,
} from "@noesis/runtime";
import { elideText } from "./rendering.ts";
import type { NoesisTuiRuntime } from "./runtime-port.ts";

export interface TuiStartOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel?: RuntimeAgentDefaults["thinkingLevel"];
  readonly session?:
    | { readonly mode: "new" }
    | { readonly mode: "pick" }
    | { readonly mode: "continue" }
    | { readonly mode: "resume"; readonly trailId: string };
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
