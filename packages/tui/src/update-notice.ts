import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { ANSI, elideText, safeTerminalText, styled } from "./theme.ts";

/** Shared startup decoration for setup and the conversation header. */
export function renderUpdateNotice(
  notice: string | undefined,
  width: number,
  height: number,
  colorEnabled: boolean,
): string[] {
  if (!notice || width < 1) return [];
  const text = safeTerminalText(notice);
  if (height < 16 || width < 12) return [styled(colorEnabled, ANSI.yellow, elideText(text, width))];
  const contentWidth = Math.max(1, Math.min(visibleWidth(text), width - 4));
  const border = (value: string): string => styled(colorEnabled, `${ANSI.dim}${ANSI.yellow}`, value);
  const lines = wrapTextWithAnsi(text, contentWidth);
  return [
    "",
    border(`╭${"─".repeat(contentWidth + 2)}╮`),
    ...lines.map(
      (line) =>
        `${border("│")} ${styled(colorEnabled, ANSI.yellow, line)}${" ".repeat(Math.max(0, contentWidth - visibleWidth(line)))} ${border("│")}`,
    ),
    border(`╰${"─".repeat(contentWidth + 2)}╯`),
    "",
  ];
}
