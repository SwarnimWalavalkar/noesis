import {
  Input,
  matchesKey,
  type Component,
  type OverlayHandle,
  type TUI,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  validateMcpMultiselectField,
  validateMcpNumberField,
  validateMcpTextField,
} from "./mcp-elicitation-validation.ts";
import { ANSI, elideText, safeTerminalText, styled } from "./theme.ts";

const safeInteractionScalar = (text: string): string =>
  safeTerminalText(text).replaceAll("\t", " ").replaceAll("\n", " ");

const urlDomain = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
};

export type TuiMcpElicitationValue = string | number | boolean | readonly string[];

export type TuiMcpFormField =
  | {
      readonly type: "text" | "secret";
      readonly name: string;
      readonly label: string;
      readonly description?: string;
      readonly required?: boolean;
      readonly defaultValue?: string;
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly format?: "date" | "uri" | "email" | "date-time";
    }
  | {
      readonly type: "number";
      readonly name: string;
      readonly label: string;
      readonly description?: string;
      readonly required?: boolean;
      readonly defaultValue?: number;
      readonly integer?: boolean;
      readonly minimum?: number;
      readonly maximum?: number;
    }
  | {
      readonly type: "boolean";
      readonly name: string;
      readonly label: string;
      readonly description?: string;
      readonly defaultValue?: boolean;
    }
  | {
      readonly type: "select";
      readonly name: string;
      readonly label: string;
      readonly description?: string;
      readonly required?: boolean;
      readonly choices: readonly { readonly value: string; readonly label: string }[];
      readonly defaultValue?: string;
    }
  | {
      readonly type: "multiselect";
      readonly name: string;
      readonly label: string;
      readonly description?: string;
      readonly required?: boolean;
      readonly choices: readonly { readonly value: string; readonly label: string }[];
      readonly defaultValue?: readonly string[];
      readonly minItems?: number;
      readonly maxItems?: number;
    };

export interface TuiMcpFormElicitationRequest {
  readonly serverName: string;
  readonly title: string;
  readonly message: string;
  readonly fields: readonly TuiMcpFormField[];
}

export interface TuiMcpUrlElicitationRequest {
  readonly serverName: string;
  readonly elicitationId: string;
  readonly title: string;
  readonly message: string;
  readonly url: string;
}

export type TuiMcpFormElicitationResult =
  | {
      readonly action: "accept";
      readonly values: Readonly<Record<string, TuiMcpElicitationValue>>;
    }
  | { readonly action: "decline" | "cancel" };

export type TuiMcpUrlElicitationResult = {
  readonly action: "accept" | "decline" | "cancel";
};

interface PresentedInteraction<T> {
  readonly result: Promise<T>;
  readonly cancel: () => void;
}

export interface TuiMcpInteractionPresenter {
  readonly presentForm: (
    request: TuiMcpFormElicitationRequest,
  ) => PresentedInteraction<TuiMcpFormElicitationResult>;
  readonly presentUrl: (
    request: TuiMcpUrlElicitationRequest,
  ) => PresentedInteraction<TuiMcpUrlElicitationResult>;
}

export interface TuiMcpInteractionBridge {
  readonly handlers: {
    readonly elicitForm: (
      request: TuiMcpFormElicitationRequest,
      signal?: AbortSignal,
    ) => Promise<TuiMcpFormElicitationResult>;
    readonly elicitUrl: (
      request: TuiMcpUrlElicitationRequest,
      signal?: AbortSignal,
    ) => Promise<TuiMcpUrlElicitationResult>;
  };
  /** Settles the exact URL request named by an MCP elicitation completion notification. */
  readonly completeUrl: (serverName: string, elicitationId: string) => boolean;
  /** Attaches the mounted TUI. The returned detach function cancels all unresolved requests. */
  readonly attach: (presenter: TuiMcpInteractionPresenter) => () => void;
  /** Permanently closes the bridge and settles every current or future request as cancelled. */
  readonly shutdown: () => void;
  readonly pendingCount: () => number;
}

type PendingInteraction =
  | {
      readonly kind: "form";
      readonly request: TuiMcpFormElicitationRequest;
      readonly resolve: (result: TuiMcpFormElicitationResult) => void;
    }
  | {
      readonly kind: "url";
      readonly request: TuiMcpUrlElicitationRequest;
      readonly resolve: (result: TuiMcpUrlElicitationResult) => void;
    };

export function createTuiMcpInteractionBridge(): TuiMcpInteractionBridge {
  let presenter: TuiMcpInteractionPresenter | undefined;
  let active: { readonly pending: PendingInteraction; readonly cancel: () => void } | undefined;
  let closed = false;
  const queue: PendingInteraction[] = [];
  const abortCleanups = new Map<PendingInteraction, () => void>();

  const removeAbortListener = (pending: PendingInteraction): void => {
    abortCleanups.get(pending)?.();
    abortCleanups.delete(pending);
  };

  const cancelled = (pending: PendingInteraction): void => {
    removeAbortListener(pending);
    if (pending.kind === "form") pending.resolve({ action: "cancel" });
    else pending.resolve({ action: "cancel" });
  };

  const cancelPending = (pending: PendingInteraction): boolean => {
    if (active?.pending === pending) {
      const current = active;
      active = undefined;
      current.cancel();
      cancelled(pending);
      drain();
      return true;
    }
    const index = queue.indexOf(pending);
    if (index < 0) return false;
    queue.splice(index, 1);
    cancelled(pending);
    return true;
  };

  const drain = (): void => {
    if (closed || active || !presenter) return;
    const pending = queue.shift();
    if (!pending) return;
    if (pending.kind === "form") {
      const presented = presenter.presentForm(pending.request);
      active = { pending, cancel: presented.cancel };
      void presented.result.then(
        (result) => {
          if (active?.pending !== pending) return;
          active = undefined;
          removeAbortListener(pending);
          pending.resolve(result);
          drain();
        },
        () => {
          if (active?.pending !== pending) return;
          active = undefined;
          cancelled(pending);
          drain();
        },
      );
      return;
    }
    const presented = presenter.presentUrl(pending.request);
    active = { pending, cancel: presented.cancel };
    void presented.result.then(
      (result) => {
        if (active?.pending !== pending) return;
        active = undefined;
        removeAbortListener(pending);
        pending.resolve(result);
        drain();
      },
      () => {
        if (active?.pending !== pending) return;
        active = undefined;
        cancelled(pending);
        drain();
      },
    );
  };

  const cancelAll = (): void => {
    const current = active;
    active = undefined;
    current?.cancel();
    if (current) cancelled(current.pending);
    for (const pending of queue.splice(0)) cancelled(pending);
  };

  const enqueue = <T>(
    pending: (resolve: (result: T) => void) => PendingInteraction,
    fallback: T,
    signal?: AbortSignal,
  ): Promise<T> => {
    if (closed || signal?.aborted) return Promise.resolve(fallback);
    return new Promise<T>((resolve) => {
      const queued = pending(resolve);
      queue.push(queued);
      if (signal) {
        const abort = (): void => {
          cancelPending(queued);
        };
        signal.addEventListener("abort", abort, { once: true });
        abortCleanups.set(queued, () => signal.removeEventListener("abort", abort));
        if (signal.aborted) {
          cancelPending(queued);
          return;
        }
      }
      drain();
    });
  };

  return Object.freeze({
    handlers: Object.freeze({
      elicitForm: (request: TuiMcpFormElicitationRequest, signal?: AbortSignal) =>
        enqueue<TuiMcpFormElicitationResult>(
          (resolve) => ({ kind: "form", request, resolve }),
          {
            action: "cancel",
          },
          signal,
        ),
      elicitUrl: (request: TuiMcpUrlElicitationRequest, signal?: AbortSignal) =>
        enqueue<TuiMcpUrlElicitationResult>(
          (resolve) => ({ kind: "url", request, resolve }),
          {
            action: "cancel",
          },
          signal,
        ),
    }),
    completeUrl(serverName: string, elicitationId: string) {
      const pending = [active?.pending, ...queue].find(
        (candidate): candidate is Extract<PendingInteraction, { readonly kind: "url" }> =>
          candidate?.kind === "url" &&
          candidate.request.serverName === serverName &&
          candidate.request.elicitationId === elicitationId,
      );
      if (!pending) return false;
      if (active?.pending === pending) {
        const current = active;
        active = undefined;
        current.cancel();
      } else {
        const index = queue.indexOf(pending);
        if (index >= 0) queue.splice(index, 1);
      }
      removeAbortListener(pending);
      pending.resolve({ action: "accept" });
      drain();
      return true;
    },
    attach(nextPresenter: TuiMcpInteractionPresenter) {
      if (closed) return () => undefined;
      if (presenter && presenter !== nextPresenter) cancelAll();
      presenter = nextPresenter;
      drain();
      let attached = true;
      return () => {
        if (!attached) return;
        attached = false;
        if (presenter !== nextPresenter) return;
        presenter = undefined;
        cancelAll();
      };
    },
    shutdown() {
      if (closed) return;
      closed = true;
      presenter = undefined;
      cancelAll();
    },
    pendingCount: () => queue.length + (active ? 1 : 0),
  });
}

interface ElicitationOverlay extends Component {
  readonly cancel: () => void;
}

function createFormOverlay(
  request: TuiMcpFormElicitationRequest,
  options: {
    readonly colorEnabled: boolean;
    readonly height: () => number;
    readonly requestRender: () => void;
    readonly settle: (result: TuiMcpFormElicitationResult) => void;
  },
): ElicitationOverlay {
  const values: Record<string, TuiMcpElicitationValue> = {};
  let fieldIndex = 0;
  let choiceIndex = 0;
  let multiSelected = new Set<string>();
  let input: Input | undefined;
  let error: string | undefined;
  let settled = false;

  const field = (): TuiMcpFormField | undefined => request.fields[fieldIndex];
  const createInput = (): void => {
    const current = field();
    if (
      !current ||
      current.type === "boolean" ||
      current.type === "select" ||
      current.type === "multiselect"
    ) {
      input = undefined;
      return;
    }
    const next = new Input();
    next.focused = true;
    const initial = current.defaultValue === undefined ? "" : String(current.defaultValue);
    next.setValue(safeTerminalText(initial));
    if (initial) next.handleInput("\u0005");
    next.onSubmit = (value) => acceptValue(value);
    input = next;
  };

  const finish = (result: TuiMcpFormElicitationResult): void => {
    if (settled) return;
    settled = true;
    options.settle(result);
  };

  const advance = (): void => {
    fieldIndex += 1;
    choiceIndex = 0;
    const next = field();
    multiSelected = new Set(next?.type === "multiselect" ? next.defaultValue : []);
    error = undefined;
    if (fieldIndex >= request.fields.length) {
      finish({ action: "accept", values: Object.freeze({ ...values }) });
      return;
    }
    createInput();
    options.requestRender();
  };

  const acceptValue = (raw?: string): void => {
    const current = field();
    if (!current) {
      finish({ action: "accept", values: Object.freeze({ ...values }) });
      return;
    }
    if (current.type === "boolean") {
      values[current.name] = choiceIndex === 0;
      advance();
      return;
    }
    if (current.type === "select") {
      const selected = current.choices[choiceIndex];
      if (!selected) {
        error = "This field has no available choices.";
        options.requestRender();
        return;
      }
      values[current.name] = selected.value;
      advance();
      return;
    }
    if (current.type === "multiselect") {
      const validationError = validateMcpMultiselectField(current, multiSelected.size);
      if (validationError) {
        error = validationError;
        options.requestRender();
        return;
      }
      values[current.name] = Object.freeze(
        current.choices.filter((choice) => multiSelected.has(choice.value)).map((choice) => choice.value),
      );
      advance();
      return;
    }
    const value = (raw ?? input?.getValue() ?? "").trim();
    if (current.required && !value) {
      error = `${current.label} is required.`;
      options.requestRender();
      return;
    }
    if (current.type === "number") {
      const number = Number(value);
      if (!value || !Number.isFinite(number)) {
        if (!value && !current.required) {
          advance();
          return;
        }
        error = `${current.label} must be a number.`;
        options.requestRender();
        return;
      }
      const validationError = validateMcpNumberField(current, number);
      if (validationError) {
        error = validationError;
        options.requestRender();
        return;
      }
      values[current.name] = number;
    } else if (value || current.required) {
      const validationError = validateMcpTextField(current, value);
      if (validationError) {
        error = validationError;
        options.requestRender();
        return;
      }
      values[current.name] = value;
    }
    advance();
  };

  const initial = field();
  if (initial?.type === "multiselect") multiSelected = new Set(initial.defaultValue);
  createInput();

  return {
    cancel: () => finish({ action: "cancel" }),
    invalidate() {},
    handleInput(data) {
      if (matchesKey(data, "escape")) return finish({ action: "cancel" });
      if (matchesKey(data, "ctrl+d")) return finish({ action: "decline" });
      const current = field();
      if (!current) return acceptValue();
      if (current.type === "boolean" || current.type === "select" || current.type === "multiselect") {
        const count = current.type === "boolean" ? 2 : current.choices.length;
        if (matchesKey(data, "up")) choiceIndex = Math.max(0, choiceIndex - 1);
        else if (matchesKey(data, "down")) choiceIndex = Math.min(Math.max(0, count - 1), choiceIndex + 1);
        else if (current.type === "multiselect" && matchesKey(data, "space")) {
          const selected = current.choices[choiceIndex];
          if (!selected) return;
          if (multiSelected.has(selected.value)) multiSelected.delete(selected.value);
          else multiSelected.add(selected.value);
          error = undefined;
        } else if (matchesKey(data, "enter")) return acceptValue();
        else return;
        options.requestRender();
        return;
      }
      input?.handleInput(data);
    },
    render(outerWidth) {
      const width = Math.max(16, outerWidth - 4);
      const current = field();
      const title = `${safeInteractionScalar(request.serverName)} · ${safeInteractionScalar(request.title)}`;
      const message = wrapTextWithAnsi(safeTerminalText(request.message), width);
      const description = current?.description
        ? wrapTextWithAnsi(safeTerminalText(current.description), width)
        : [];
      const choices =
        current?.type === "boolean"
          ? ["Yes", "No"]
          : current?.type === "select" || current?.type === "multiselect"
            ? current.choices.map((choice) => safeInteractionScalar(choice.label))
            : [];
      const control =
        choices.length > 0
          ? choices.map(
              (choice, index) =>
                `${styled(options.colorEnabled, index === choiceIndex ? `${ANSI.bold}${ANSI.cyan}` : ANSI.dim, index === choiceIndex ? "›" : " ")} ${
                  current?.type === "multiselect"
                    ? `${multiSelected.has(current.choices[index]?.value ?? "") ? "[x]" : "[ ]"} ${choice}`
                    : choice
                }`,
            )
          : input
            ? current?.type === "secret"
              ? [`> ${"•".repeat([...input.getValue()].length)}`]
              : input.render(width)
            : [];
      const body = [
        ...message,
        "",
        ...(current
          ? [
              `${String(fieldIndex + 1)}/${String(request.fields.length)} · ${safeInteractionScalar(current.label)}${"required" in current && current.required ? " *" : ""}`,
              ...description,
              "",
              ...control,
            ]
          : ["No information requested."]),
        ...(error ? ["", styled(options.colorEnabled, ANSI.red, safeTerminalText(error))] : []),
      ];
      const maxBody = Math.max(1, options.height() - 7);
      return [
        styled(options.colorEnabled, ANSI.dim, `╭─ ${"─".repeat(Math.max(0, outerWidth - 4))}╮`),
        elideText(`│ ${styled(options.colorEnabled, `${ANSI.bold}${ANSI.cyan}`, title)}`, outerWidth),
        ...body.slice(-maxBody).map((line) => elideText(`│ ${line}`, outerWidth)),
        elideText(
          `│ ${styled(
            options.colorEnabled,
            ANSI.dim,
            current?.type === "multiselect"
              ? "↑/↓ move · Space toggle · Enter continue · Ctrl+D decline · Esc cancel"
              : choices.length > 0
                ? "↑/↓ select · Enter continue · Ctrl+D decline · Esc cancel"
                : "Enter continue · Ctrl+D decline · Esc cancel",
          )}`,
          outerWidth,
        ),
        styled(options.colorEnabled, ANSI.dim, `╰─ ${"─".repeat(Math.max(0, outerWidth - 4))}╯`),
      ];
    },
  };
}

function createUrlOverlay(
  request: TuiMcpUrlElicitationRequest,
  options: {
    readonly colorEnabled: boolean;
    readonly height: () => number;
    readonly settle: (result: TuiMcpUrlElicitationResult) => void;
  },
): ElicitationOverlay {
  let settled = false;
  const finish = (result: TuiMcpUrlElicitationResult): void => {
    if (settled) return;
    settled = true;
    options.settle(result);
  };
  return {
    cancel: () => finish({ action: "cancel" }),
    invalidate() {},
    handleInput(data) {
      if (matchesKey(data, "escape")) finish({ action: "cancel" });
      else if (matchesKey(data, "ctrl+d")) finish({ action: "decline" });
      else if (matchesKey(data, "enter")) finish({ action: "accept" });
    },
    render(outerWidth) {
      const width = Math.max(16, outerWidth - 4);
      const body = [
        ...wrapTextWithAnsi(safeTerminalText(request.message), width),
        "",
        ...wrapTextWithAnsi(`Domain · ${safeInteractionScalar(urlDomain(request.url))}`, width),
        ...wrapTextWithAnsi(`URL · ${safeTerminalText(request.url)}`, width),
        "",
        "Press Enter to open this URL in your browser.",
      ];
      return [
        styled(options.colorEnabled, ANSI.dim, `╭─ ${"─".repeat(Math.max(0, outerWidth - 4))}╮`),
        elideText(
          `│ ${styled(options.colorEnabled, `${ANSI.bold}${ANSI.cyan}`, `${safeInteractionScalar(request.serverName)} · ${safeInteractionScalar(request.title)}`)}`,
          outerWidth,
        ),
        ...body.slice(0, Math.max(1, options.height() - 6)).map((line) => elideText(`│ ${line}`, outerWidth)),
        elideText(
          `│ ${styled(options.colorEnabled, ANSI.dim, "Enter accept · Ctrl+D decline · Esc cancel")}`,
          outerWidth,
        ),
        styled(options.colorEnabled, ANSI.dim, `╰─ ${"─".repeat(Math.max(0, outerWidth - 4))}╯`),
      ];
    },
  };
}

export function createTuiMcpInteractionPresenter(options: {
  readonly tui: TUI;
  readonly colorEnabled: boolean;
  readonly height: () => number;
  readonly openUrl?: (url: string) => Promise<void>;
  readonly onActiveChange?: (active: boolean) => void;
}): TuiMcpInteractionPresenter {
  const present = <T>(
    create: (settle: (result: T) => void) => ElicitationOverlay,
    beforeShow?: () => void,
  ): PresentedInteraction<T> => {
    let overlay: ElicitationOverlay | undefined;
    let handle: OverlayHandle | undefined;
    let resolveResult: ((result: T) => void) | undefined;
    let settled = false;
    const result = new Promise<T>((resolve) => {
      resolveResult = resolve;
    });
    const settle = (value: T): void => {
      if (settled) return;
      settled = true;
      handle?.hide();
      handle = undefined;
      options.onActiveChange?.(false);
      resolveResult?.(value);
    };
    overlay = create(settle);
    beforeShow?.();
    options.onActiveChange?.(true);
    handle = options.tui.showOverlay(overlay, {
      anchor: "center",
      width: "88%",
      maxHeight: "88%",
      margin: 1,
    });
    return {
      result,
      cancel: () => overlay?.cancel(),
    };
  };

  return Object.freeze({
    presentForm: (request: TuiMcpFormElicitationRequest) =>
      present<TuiMcpFormElicitationResult>((settle) =>
        createFormOverlay(request, {
          colorEnabled: options.colorEnabled,
          height: options.height,
          requestRender: () => options.tui.requestRender(),
          settle,
        }),
      ),
    presentUrl: (request: TuiMcpUrlElicitationRequest) =>
      present<TuiMcpUrlElicitationResult>((settle) =>
        createUrlOverlay(request, {
          colorEnabled: options.colorEnabled,
          height: options.height,
          settle: (result) => {
            if (result.action === "accept" && options.openUrl)
              void options.openUrl(request.url).catch(() => undefined);
            settle(result);
          },
        }),
      ),
  });
}
