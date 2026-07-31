import { safeTerminalText } from "./theme.ts";

const INSPECTOR_PREVIEW_CHARACTERS = 24_000;

export function boundedInspectorText(text: string): string {
  const safe = safeTerminalText(text);
  if (safe.length <= INSPECTOR_PREVIEW_CHARACTERS) return safe;
  return `${safe.slice(0, INSPECTOR_PREVIEW_CHARACTERS)}\n\n… inspector preview truncated`;
}

export function streamingFrameDelay(activeCharacters: number, pendingCharacters: number): number {
  const total = Math.max(0, activeCharacters) + Math.max(0, pendingCharacters);
  return Math.min(80, 16 + Math.floor(total / 4_000) * 8);
}
