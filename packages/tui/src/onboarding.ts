import { createConditionalObject } from "@noesis/domain";
import {
  Container,
  Input,
  Loader,
  matchesKey,
  ProcessTerminal,
  SelectList,
  type Component,
  type SelectListTheme,
  type Terminal,
  TUI,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  ANSI,
  brandGradient,
  detectTrueColor,
  elideText,
  NOESIS_WORDMARK,
  safeTerminalText,
  shouldUseColor,
  styled,
} from "./theme.ts";
import { NOESIS_STARTUP_NOTES, pickStartupNote } from "./startup-note.ts";
import { createSelectTheme } from "./safe-editor.ts";
export interface OnboardingSurfaceChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}
export interface OnboardingPromptOptions {
  readonly signal?: AbortSignal;
}
/**
 * Presentation port for first-launch setup. Callers own the decision flow; this surface only
 * asks questions and reports progress, so the same flow runs against scripted prompts in tests.
 */
export interface OnboardingSurface {
  readonly signal: AbortSignal;
  choose(
    message: string,
    choices: readonly OnboardingSurfaceChoice[],
    defaultId: string,
    options?: OnboardingPromptOptions,
  ): Promise<string>;
  text(message: string, defaultValue: string, options?: OnboardingPromptOptions): Promise<string>;
  secret(message: string, options?: OnboardingPromptOptions): Promise<string>;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  note(message: string): void;
  reference(label: string, value: string): void;
}
export class OnboardingInterruptedError extends Error {
  constructor() {
    super("Setup was interrupted before it finished.");
    this.name = "OnboardingInterruptedError";
  }
}
const CHOICE_HINT = "↑/↓ navigate · 1-9 jump · Enter select · Ctrl+C cancel";
const TEXT_HINT = "Enter accept · Ctrl+C cancel";
const SECRET_HINT = "Input hidden · Enter accept · Ctrl+C cancel";
const WAITING_HINT = "Ctrl+C cancel";
const WAITING_DELAY_MS = 200;
const ELAPSED_INTERVAL_MS = 1000;
const MAX_CHOICE_ROWS = 9;
type TranscriptEntry =
  | {
      readonly kind: "note";
      readonly text: string;
    }
  | {
      readonly kind: "answer";
      readonly question: string;
      readonly value: string;
    }
  | {
      readonly kind: "reference";
      readonly label: string;
      readonly value: string;
    };
interface ActiveBody {
  readonly component: Component;
  readonly rows: number;
  readonly hint: string;
}
export function onboardingHeaderLines(
  width: number,
  height: number,
  colorEnabled: boolean,
  options: {
    readonly collapsed?: boolean;
    readonly subtitle?: string;
    readonly trueColor?: boolean;
    readonly note?: string;
  } = {},
): string[] {
  const collapsed = options.collapsed ?? false;
  const subtitle = options.subtitle ?? "first-launch setup";
  const trueColor = options.trueColor ?? false;
  const note = options.note ?? NOESIS_STARTUP_NOTES[0];
  const brand = (text: string): string => brandGradient(text, colorEnabled, trueColor);
  const muted = (text: string): string => styled(colorEnabled, ANSI.dim, text);
  if (width < 30 || height < 8) return [];
  if (!collapsed && width >= 60 && height >= 22)
    return [...NOESIS_WORDMARK.map(brand), muted(note), muted(subtitle), muted("─".repeat(width))];
  return [`${brand("NOESIS")}${muted(`  ${subtitle}`)}`, muted("─".repeat(width))];
}
function chunkByWidth(value: string, width: number): string[] {
  if (width <= 0) return [];
  const codePoints = [...value];
  const chunks: string[] = [];
  for (let index = 0; index < codePoints.length; index += width)
    chunks.push(codePoints.slice(index, index + width).join(""));
  return chunks.length > 0 ? chunks : [""];
}
function renderTranscriptEntry(entry: TranscriptEntry, width: number, colorEnabled: boolean): string[] {
  if (entry.kind === "answer")
    return [
      elideText(
        `${styled(colorEnabled, ANSI.green, "✓")} ${styled(colorEnabled, ANSI.dim, `${safeTerminalText(entry.question)} · `)}${styled(colorEnabled, ANSI.bold, safeTerminalText(entry.value))}`,
        width,
      ),
    ];
  if (entry.kind === "reference")
    return [
      elideText(styled(colorEnabled, ANSI.dim, safeTerminalText(entry.label)), width),
      // References are copy targets. Split them on exact column boundaries instead of wrapping on
      // word breaks or eliding, so nothing the user has to retype is silently dropped.
      ...chunkByWidth(safeTerminalText(entry.value), width).map((chunk) =>
        styled(colorEnabled, ANSI.cyan, chunk),
      ),
    ];
  return safeTerminalText(entry.text)
    .split("\n")
    .flatMap((line) => (line ? wrapTextWithAnsi(line, width) : [""]))
    .map((line) => styled(colorEnabled, ANSI.dim, line));
}
function createMaskedInput(
  input: Input,
  colorEnabled: boolean,
): Component & {
  focused: boolean;
} {
  return {
    get focused() {
      return input.focused;
    },
    set focused(focused: boolean) {
      input.focused = focused;
    },
    handleInput: (data) => input.handleInput(data),
    invalidate: () => input.invalidate(),
    render(width) {
      const masked = "•".repeat([...input.getValue()].length);
      return [elideText(`${styled(colorEnabled, ANSI.dim, "> ")}${masked}`, Math.max(0, width))];
    },
  };
}
function createChoiceBody(
  choices: readonly OnboardingSurfaceChoice[],
  defaultId: string,
  theme: SelectListTheme,
  rows: number,
  onSelect: (id: string) => void,
): ActiveBody {
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const list = new SelectList(
    choices.map((choice) =>
      createConditionalObject({
        value: choice.id,
        label: choice.label,
      } as const)
        .addOptional(choice.description ? { description: choice.description } : undefined)
        .finish(),
    ),
    rows,
    theme,
    { minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 48 },
  );
  const defaultIndex = choices.findIndex((choice) => choice.id === defaultId);
  if (defaultIndex >= 0) list.setSelectedIndex(defaultIndex);
  list.onSelect = (item) => onSelect(item.value);
  return {
    rows: Math.min(rows, choices.length) + (choices.length > rows ? 1 : 0),
    hint: CHOICE_HINT,
    component: {
      invalidate: () => list.invalidate(),
      render: (width) => list.render(width),
      handleInput(data) {
        // Preserve the numbered-list muscle memory of the previous prompt-based setup.
        const shortcut = /^[1-9]$/.test(data) ? choices[Number(data) - 1] : undefined;
        if (shortcut) {
          onSelect(shortcut.id);
          return;
        }
        list.handleInput(data);
      },
    },
  };
}
export interface SetupTuiOptions {
  readonly terminal?: Terminal;
  /** Compact header label under the wordmark. Defaults to first-launch setup. */
  readonly subtitle?: string;
  /** One application-owned invitation shared across first-launch setup and the main shell. */
  readonly startupNote?: string;
}
export async function runNoesisOnboardingTui<T>(
  run: (surface: OnboardingSurface) => Promise<T>,
  options: SetupTuiOptions = {},
): Promise<T> {
  const terminal = options.terminal ?? new ProcessTerminal();
  const subtitle = options.subtitle ?? "first-launch setup";
  const colorEnabled =
    terminal instanceof ProcessTerminal && shouldUseColor(process.env) && process.stdout.hasColors();
  const theme = createSelectTheme(colorEnabled);
  const tui = new TUI(terminal);
  const root = new Container();
  const body = new Container();
  const entries: TranscriptEntry[] = [];
  let question: string | undefined;
  let active: ActiveBody | undefined;
  let waitingLabel = "Working";
  let waitingTimer: NodeJS.Timeout | undefined;
  let elapsedTimer: NodeJS.Timeout | undefined;
  let loader: Loader | undefined;
  let stopped = false;
  const abortController = new AbortController();
  let interrupt: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = () => reject(new OnboardingInterruptedError());
  });
  const startupNote = options.startupNote ?? pickStartupNote();
  const chrome: Component = {
    invalidate() {},
    render(width) {
      const inner = Math.max(1, width);
      const height = Math.max(1, terminal.rows);
      // Once setup is done the block becomes a receipt above the running app, which draws its own
      // banner. Collapsing the header keeps exactly one wordmark on the handoff screen.
      const header = onboardingHeaderLines(inner, height, colorEnabled, {
        collapsed: stopped,
        subtitle,
        trueColor: colorEnabled && detectTrueColor(process.env),
        note: startupNote,
      });
      const hintRows = height >= 8 && active ? 1 : 0;
      // Questions wrap rather than elide: an authentication prompt can carry a long placeholder
      // that the reader needs in full to know what to paste.
      const questionLines = question
        ? [
            "",
            ...wrapTextWithAnsi(safeTerminalText(question), Math.max(1, inner - 2)).map((line, index) =>
              index === 0
                ? `${styled(colorEnabled, `${ANSI.bold}${ANSI.cyan}`, "›")} ${styled(colorEnabled, ANSI.bold, line)}`
                : `  ${styled(colorEnabled, ANSI.bold, line)}`,
            ),
          ]
        : [];
      const transcriptRows = Math.max(
        0,
        height - header.length - questionLines.length - hintRows - (active?.rows ?? 0),
      );
      const lines = entries.flatMap((entry) => renderTranscriptEntry(entry, inner, colorEnabled));
      const transcript = transcriptRows > 0 ? lines.slice(-transcriptRows) : [];
      return [...header, ...transcript, ...questionLines];
    },
  };
  const hintView: Component = {
    invalidate() {},
    render: (width) =>
      terminal.rows >= 8 && active
        ? [elideText(styled(colorEnabled, ANSI.dim, active.hint), Math.max(0, width))]
        : [],
  };
  const clearWaiting = (): void => {
    if (waitingTimer) clearTimeout(waitingTimer);
    if (elapsedTimer) clearInterval(elapsedTimer);
    waitingTimer = undefined;
    elapsedTimer = undefined;
    loader?.stop();
    loader = undefined;
  };
  const showWaiting = (): void => {
    if (stopped || active) return;
    const startedAt = Date.now();
    const next = new Loader(
      tui,
      (text) => styled(colorEnabled, ANSI.cyan, text),
      (text) => styled(colorEnabled, ANSI.dim, text),
      waitingLabel,
    );
    loader = next;
    // Loader prefixes its message with a blank spacer row.
    active = { component: next, rows: 2, hint: WAITING_HINT };
    body.clear();
    body.addChild(next);
    next.start();
    elapsedTimer = setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      next.setMessage(seconds >= 3 ? `${waitingLabel} · ${String(seconds)}s` : waitingLabel);
    }, ELAPSED_INTERVAL_MS);
    elapsedTimer.unref();
    tui.requestRender();
  };
  const scheduleWaiting = (): void => {
    clearWaiting();
    if (stopped) return;
    // Most awaits between questions settle immediately. Only surface a spinner once a wait is
    // long enough that an unchanged screen would look frozen.
    waitingTimer = setTimeout(showWaiting, WAITING_DELAY_MS);
    waitingTimer.unref();
  };
  const mount = (prompt: string, next: ActiveBody): void => {
    clearWaiting();
    question = prompt;
    active = next;
    body.clear();
    body.addChild(next.component);
    tui.setFocus(next.component);
    tui.requestRender();
  };
  const settle = (
    answered:
      | {
          readonly question: string;
          readonly value: string;
        }
      | undefined,
  ): void => {
    if (answered) entries.push({ kind: "answer", ...answered });
    question = undefined;
    active = undefined;
    body.clear();
    tui.setFocus(null);
    scheduleWaiting();
    tui.requestRender();
  };
  const ask = <V>(
    build: (resolve: (value: V) => void) => {
      readonly prompt: string;
    } & ActiveBody,
    options: OnboardingPromptOptions | undefined,
    record: (value: V) => string,
  ): Promise<V> =>
    new Promise<V>((resolve, reject) => {
      let settled = false;
      const abort = (): void => {
        if (settled) return;
        settled = true;
        settle(undefined);
        reject(new OnboardingInterruptedError());
      };
      if (options?.signal?.aborted || abortController.signal.aborted) {
        abort();
        return;
      }
      options?.signal?.addEventListener("abort", abort, { once: true });
      abortController.signal.addEventListener("abort", abort, { once: true });
      const built = build((value) => {
        if (settled) return;
        settled = true;
        options?.signal?.removeEventListener("abort", abort);
        abortController.signal.removeEventListener("abort", abort);
        settle({ question: built.prompt, value: record(value) });
        resolve(value);
      });
      mount(built.prompt, built);
    });
  const choiceRows = (count: number): number =>
    Math.max(1, Math.min(count, MAX_CHOICE_ROWS, Math.max(1, terminal.rows - 6)));
  const textBody = (
    initial: string,
    masked: boolean,
    resolve: (value: string) => void,
  ): Omit<ActiveBody, "hint"> & {
    readonly hint: string;
  } => {
    const input = new Input();
    if (initial) {
      input.setValue(initial);
      // Land the caret after a prefilled default so typing extends it instead of prefixing it.
      input.handleInput("\u0005");
    }
    input.onSubmit = (value) => resolve(value);
    return {
      rows: 1,
      hint: masked ? SECRET_HINT : TEXT_HINT,
      component: masked ? createMaskedInput(input, colorEnabled) : input,
    };
  };
  const surface: OnboardingSurface = {
    signal: abortController.signal,
    choose: (message, choices, defaultId, options) =>
      ask<string>(
        (resolve) => ({
          prompt: message,
          ...createChoiceBody(choices, defaultId, theme, choiceRows(choices.length), resolve),
        }),
        options,
        (id) => choices.find((choice) => choice.id === id)?.label ?? id,
      ),
    text: (message, defaultValue, options) =>
      ask<string>(
        (resolve) => ({
          prompt: message,
          ...textBody(defaultValue, false, resolve),
        }),
        options,
        (value) => value,
      ),
    secret: (message, options) =>
      ask<string>(
        (resolve) => ({ prompt: message, ...textBody("", true, resolve) }),
        options,
        (value) => "•".repeat(Math.min(12, [...value].length)),
      ),
    confirm: (message, defaultValue) =>
      ask<boolean>(
        (resolve) => ({
          prompt: message,
          ...createChoiceBody(
            [
              { id: "yes", label: "Yes" },
              { id: "no", label: "No" },
            ],
            defaultValue ? "yes" : "no",
            theme,
            2,
            (id) => resolve(id === "yes"),
          ),
        }),
        undefined,
        (value) => (value ? "Yes" : "No"),
      ),
    note(message) {
      entries.push({ kind: "note", text: message });
      const lastLine = message.split("\n").filter(Boolean).at(-1);
      if (lastLine) waitingLabel = lastLine.replace(/[…:]\s*$/u, "");
      loader?.setMessage(waitingLabel);
      tui.requestRender();
    },
    reference(label, value) {
      entries.push({ kind: "reference", label, value });
      tui.requestRender();
    },
  };
  const removeInputListener = tui.addInputListener((data) => {
    if (!matchesKey(data, "ctrl+c")) return undefined;
    abortController.abort();
    interrupt?.();
    return { consume: true };
  });
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearWaiting();
    question = undefined;
    active = undefined;
    body.clear();
    tui.setFocus(null);
    removeInputListener();
    // The render for the last answered question is throttled and may still be pending when the
    // flow resolves. Force a final frame so the completed transcript is what stays on screen.
    tui.requestRender(true);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    try {
      await terminal.drainInput(250);
    } finally {
      tui.stop();
    }
  };
  root.addChild(chrome);
  root.addChild(body);
  root.addChild(hintView);
  tui.addChild(root);
  tui.start();
  scheduleWaiting();
  const running = run(surface);
  // The race reports whichever settles first; the loser is observed here so an interrupted flow
  // that unwinds later never surfaces as an unhandled rejection.
  running.catch(() => undefined);
  try {
    return await Promise.race([running, interrupted]);
  } finally {
    await stop();
  }
}
