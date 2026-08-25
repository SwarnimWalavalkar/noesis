import { truncateToWidth, type MarkdownTheme } from "@earendil-works/pi-tui";

// SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
export const NOESIS_WORDMARK = [
  "███╗   ██╗ ██████╗ ███████╗███████╗██╗███████╗",
  "████╗  ██║██╔═══██╗██╔════╝██╔════╝██║██╔════╝",
  "██╔██╗ ██║██║   ██║█████╗  ███████╗██║███████╗",
  "██║╚██╗██║██║   ██║██╔══╝  ╚════██║██║╚════██║",
  "██║ ╚████║╚██████╔╝███████╗███████║██║███████║",
  "╚═╝  ╚═══╝ ╚═════╝ ╚══════╝╚══════╝╚═╝╚══════╝",
] as const;

// SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
export const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  italic: "\u001b[3m",
  underline: "\u001b[4m",
  strikethrough: "\u001b[9m",
  reverse: "\u001b[7m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  magenta: "\u001b[35m",
} as const;

export const styled = (enabled: boolean, codes: string, text: string): string =>
  enabled ? `${codes}${text}${ANSI.reset}` : text;

export function shouldUseColor(env: Readonly<Record<string, string | undefined>>): boolean {
  return !("NO_COLOR" in env) && env["TERM"] !== "dumb";
}

export function detectTrueColor(env: Readonly<Record<string, string | undefined>>): boolean {
  const colorterm = env["COLORTERM"] ?? "";
  return colorterm.includes("truecolor") || colorterm.includes("24bit");
}

interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Brand gradient endpoints: interface cyan flowing into the "mind" violet. */
const BRAND_GRADIENT_FROM: RgbColor = { r: 34, g: 211, b: 238 };
const BRAND_GRADIENT_TO: RgbColor = { r: 167, g: 139, b: 250 };
const GRADIENT_STOPS = 8;

const trueColorSequence = (color: RgbColor): string =>
  `\u001b[38;2;${String(color.r)};${String(color.g)};${String(color.b)}m`;

const mixChannel = (from: number, to: number, ratio: number): number =>
  Math.round(from + (to - from) * ratio);

/**
 * Styles text with a horizontal cyan-to-violet sweep on truecolor terminals, quantized to a few
 * stops so runs of characters share one escape sequence. Falls back to the plain codes elsewhere.
 */
export function brandGradient(
  text: string,
  colorEnabled: boolean,
  trueColorEnabled: boolean,
  fallbackCodes: string = `${ANSI.bold}${ANSI.cyan}`,
): string {
  if (!colorEnabled) return text;
  const characters = [...text];
  if (!trueColorEnabled || characters.length === 0) return styled(colorEnabled, fallbackCodes, text);
  const segments: string[] = [ANSI.bold];
  let previousStop = -1;
  for (const [index, character] of characters.entries()) {
    const stop = Math.min(GRADIENT_STOPS - 1, Math.floor((index / characters.length) * GRADIENT_STOPS));
    if (stop !== previousStop) {
      const ratio = stop / (GRADIENT_STOPS - 1);
      segments.push(
        trueColorSequence({
          r: mixChannel(BRAND_GRADIENT_FROM.r, BRAND_GRADIENT_TO.r, ratio),
          g: mixChannel(BRAND_GRADIENT_FROM.g, BRAND_GRADIENT_TO.g, ratio),
          b: mixChannel(BRAND_GRADIENT_FROM.b, BRAND_GRADIENT_TO.b, ratio),
        }),
      );
      previousStop = stop;
    }
    segments.push(character);
  }
  segments.push(ANSI.reset);
  return segments.join("");
}

export function elideText(text: string, width: number): string {
  const truncated = truncateToWidth(text, Math.max(0, width), "…");
  // pi-tui defensively appends resets while truncating. Do not introduce ANSI into plain text,
  // especially under NO_COLOR; preserve the helper's ANSI-safe behavior for styled input.
  return text.includes("\u001b[") ? truncated : truncated.replaceAll("\u001b[0m", "");
}

export function safeTerminalText(text: string): string {
  return [...text]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || (code >= 32 && !(code >= 127 && code <= 159)) ? character : " ";
    })
    .join("")
    .replaceAll("\u001b", "");
}

const identity = (text: string): string => text;

export function createMarkdownTheme(colorEnabled: boolean): MarkdownTheme {
  return {
    heading: (text) => styled(colorEnabled, ANSI.cyan, text),
    link: (text) => styled(colorEnabled, ANSI.cyan, text),
    linkUrl: (text) => styled(colorEnabled, ANSI.dim, text),
    code: (text) => styled(colorEnabled, ANSI.yellow, text),
    codeBlock: (text) => styled(colorEnabled, ANSI.green, text),
    codeBlockBorder: (text) => styled(colorEnabled, ANSI.dim, text),
    quote: (text) => styled(colorEnabled, ANSI.dim, text),
    quoteBorder: (text) => styled(colorEnabled, ANSI.cyan, text),
    hr: (text) => styled(colorEnabled, ANSI.dim, text),
    listBullet: (text) => styled(colorEnabled, ANSI.cyan, text),
    bold: colorEnabled ? (text) => `${ANSI.bold}${text}${ANSI.reset}` : identity,
    italic: colorEnabled ? (text) => `${ANSI.italic}${text}${ANSI.reset}` : identity,
    strikethrough: colorEnabled ? (text) => `${ANSI.strikethrough}${text}${ANSI.reset}` : identity,
    underline: colorEnabled ? (text) => `${ANSI.underline}${text}${ANSI.reset}` : identity,
  };
}
