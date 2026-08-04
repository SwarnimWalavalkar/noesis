import { safeTerminalText } from "./theme.ts";

export const INSPECTOR_PREVIEW_CHARACTERS = 24_000;
const INSPECTOR_PAGE_HEADER_RESERVE = 160;

export function boundedInspectorText(text: string): string {
  const safe = safeTerminalText(text);
  if (safe.length <= INSPECTOR_PREVIEW_CHARACTERS) return safe;
  return `${safe.slice(0, INSPECTOR_PREVIEW_CHARACTERS)}\n\n… inspector preview truncated`;
}

function pageBreak(text: string, start: number, maxCharacters: number): number {
  let end = Math.min(text.length, start + maxCharacters);
  if (end >= text.length) return text.length;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  const newline = text.lastIndexOf("\n", end - 1);
  return newline > start + Math.floor(maxCharacters / 2) ? newline + 1 : end;
}

/** Split a long inspector read model into bounded transcript pages without discarding any text. */
export function paginateInspectorText(heading: string, text: string): readonly string[] {
  const safeHeading = safeTerminalText(heading).replaceAll("\n", " ").slice(0, 120);
  const safeText = safeTerminalText(text);
  const contentLimit = INSPECTOR_PREVIEW_CHARACTERS - INSPECTOR_PAGE_HEADER_RESERVE;
  const chunks: string[] = [];
  for (let start = 0; start < safeText.length; ) {
    const end = pageBreak(safeText, start, contentLimit);
    chunks.push(safeText.slice(start, end));
    start = end;
  }
  if (chunks.length === 0) chunks.push("");
  const total = chunks.length;
  return Object.freeze(
    chunks.map((chunk, index) =>
      total === 1
        ? `${safeHeading}\n\n${chunk}`
        : `${safeHeading} · page ${String(index + 1)}/${String(total)}\n\n${chunk}`,
    ),
  );
}

export function streamingFrameDelay(activeCharacters: number, pendingCharacters: number): number {
  const total = Math.max(0, activeCharacters) + Math.max(0, pendingCharacters);
  return Math.min(80, 16 + Math.floor(total / 4_000) * 8);
}
