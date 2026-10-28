import {
  Input,
  matchesKey,
  type Component,
  type OverlayHandle,
  type TUI,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { createConditionalObject } from "@noesis/domain";
import {
  validateMultiselectField,
  validateNumberField,
  validateTextField,
} from "./elicitation-validation.ts";
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

export type TuiElicitationValue = string | number | boolean | readonly string[];

export type TuiFormField =
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

/** `source` names who is asking, such as an MCP server or Noesis itself. */
export interface TuiFormElicitationRequest {
  readonly source: string;
  readonly title: string;
  readonly message: string;
  readonly fields: readonly TuiFormField[];
}

export interface TuiUrlElicitationRequest {
  readonly source: string;
  readonly elicitationId: string;
  readonly title: string;
  readonly message: string;
  readonly url: string;
}

/** Runs the same provider sign-in flow as `/provider`. Entered values stay inside that flow. */
export interface TuiProviderAuthenticationRequest {
  readonly providerId: string;
  readonly providerName: string;
  readonly reason: string;
}

export type TuiFormElicitationResult =
  | {
      readonly action: "accept";
      readonly values: Readonly<Record<string, TuiElicitationValue>>;
    }
  | { readonly action: "decline" | "cancel" };

export type TuiUrlElicitationResult = {
  readonly action: "accept" | "decline" | "cancel";
};

export type TuiProviderAuthenticationResult =
  | { readonly action: "accept" | "cancel" }
  | { readonly action: "error"; readonly message: string };

export interface PresentedInteraction<T> {
  readonly result: Promise<T>;
  readonly cancel: () => void;
}

export interface TuiInteractionPresenter {
  readonly presentForm: (
    request: TuiFormElicitationRequest,
  ) => PresentedInteraction<TuiFormElicitationResult>;
  readonly presentUrl: (request: TuiUrlElicitationRequest) => PresentedInteraction<TuiUrlElicitationResult>;
  readonly presentProviderAuthentication: (
    request: TuiProviderAuthenticationRequest,
  ) => PresentedInteraction<TuiProviderAuthenticationResult>;
}

/**
 * Runtime code asks the user to complete sensitive or interactive steps through this bridge.
 * Requests wait in order until the TUI attaches and settle as cancelled on abort or shutdown.
 */
export interface TuiInteractionBridge {
  readonly handlers: {
    readonly elicitForm: (
      request: TuiFormElicitationRequest,
      signal?: AbortSignal,
    ) => Promise<TuiFormElicitationResult>;
    readonly elicitUrl: (
      request: TuiUrlElicitationRequest,
      signal?: AbortSignal,
    ) => Promise<TuiUrlElicitationResult>;
    readonly authenticateProvider: (
      request: TuiProviderAuthenticationRequest,
      signal?: AbortSignal,
    ) => Promise<TuiProviderAuthenticationResult>;
  };
  /** Settles the exact URL request named by a completion notification from its source. */
  readonly completeUrl: (source: string, elicitationId: string) => boolean;
  /** Attaches the mounted TUI. The returned detach function cancels all unresolved requests. */
  readonly attach: (presenter: TuiInteractionPresenter) => () => void;
  /** Permanently closes the bridge and settles every current or future request as cancelled. */
  readonly shutdown: () => void;
  readonly pendingCount: () => number;
}

interface PendingInteraction {
  readonly present: (presenter: TuiInteractionPresenter) => {
    readonly done: Promise<void>;
    readonly cancel: () => void;
  };
  readonly settleCancelled: () => void;
  readonly urlCompletion?: {
    readonly source: string;
    readonly elicitationId: string;
    readonly accept: () => void;
  };
}

export function createTuiInteractionBridge(): TuiInteractionBridge {
  let presenter: TuiInteractionPresenter | undefined;
  let active: { readonly pending: PendingInteraction; readonly cancel: () => void } | undefined;
  let closed = false;
  const queue: PendingInteraction[] = [];

  const drain = (): void => {
    if (closed || active || !presenter) return;
    const pending = queue.shift();
    if (!pending) return;
    const presented = pending.present(presenter);
    const current = { pending, cancel: presented.cancel };
    active = current;
    void presented.done.then(() => {
      if (active !== current) return;
      active = undefined;
      drain();
    });
  };

  const cancelPending = (pending: PendingInteraction): void => {
    if (active?.pending === pending) {
      const current = active;
      active = undefined;
      current.cancel();
      pending.settleCancelled();
      drain();
      return;
    }
    const index = queue.indexOf(pending);
    if (index < 0) return;
    queue.splice(index, 1);
    pending.settleCancelled();
  };

  const cancelAll = (): void => {
    const current = active;
    active = undefined;
    current?.cancel();
    current?.pending.settleCancelled();
    for (const pending of queue.splice(0)) pending.settleCancelled();
  };

  const enqueue = <T>(
    present: (presenter: TuiInteractionPresenter) => PresentedInteraction<T>,
    cancelled: T,
    signal?: AbortSignal,
    url?: { readonly source: string; readonly elicitationId: string; readonly accepted: T },
  ): Promise<T> => {
    if (closed || signal?.aborted) return Promise.resolve(cancelled);
    return new Promise<T>((resolve) => {
      let settled = false;
      const abort = (): void => cancelPending(pending);
      const finish = (result: T): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const pending: PendingInteraction = createConditionalObject({
        present: (current: TuiInteractionPresenter) => {
          const presented = present(current);
          return {
            done: presented.result.then(finish, () => finish(cancelled)),
            cancel: presented.cancel,
          };
        },
        settleCancelled: () => finish(cancelled),
      } as const)
        .addOptional(
          url
            ? {
                urlCompletion: {
                  source: url.source,
                  elicitationId: url.elicitationId,
                  accept: () => finish(url.accepted),
                },
              }
            : undefined,
        )
        .finish();
      queue.push(pending);
      signal?.addEventListener("abort", abort, { once: true });
      drain();
    });
  };

  return Object.freeze({
    handlers: Object.freeze({
      elicitForm: (request: TuiFormElicitationRequest, signal?: AbortSignal) =>
        enqueue<TuiFormElicitationResult>(
          (current) => current.presentForm(request),
          { action: "cancel" },
          signal,
        ),
      elicitUrl: (request: TuiUrlElicitationRequest, signal?: AbortSignal) =>
        enqueue<TuiUrlElicitationResult>(
          (current) => current.presentUrl(request),
          { action: "cancel" },
          signal,
          { source: request.source, elicitationId: request.elicitationId, accepted: { action: "accept" } },
        ),
      authenticateProvider: (request: TuiProviderAuthenticationRequest, signal?: AbortSignal) =>
        enqueue<TuiProviderAuthenticationResult>(
          (current) => current.presentProviderAuthentication(request),
          { action: "cancel" },
          signal,
        ),
    }),
    completeUrl(source: string, elicitationId: string) {
      const pending = [active?.pending, ...queue].find(
        (candidate) =>
          candidate?.urlCompletion?.source === source &&
          candidate.urlCompletion.elicitationId === elicitationId,
      );
      if (!pending?.urlCompletion) return false;
      if (active?.pending === pending) {
        const current = active;
        active = undefined;
        current.cancel();
      } else {
        const index = queue.indexOf(pending);
        if (index >= 0) queue.splice(index, 1);
      }
      pending.urlCompletion.accept();
      drain();
      return true;
    },
    attach(nextPresenter: TuiInteractionPresenter) {
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
  request: TuiFormElicitationRequest,
  options: {
    readonly colorEnabled: boolean;
    readonly height: () => number;
    readonly requestRender: () => void;
    readonly settle: (result: TuiFormElicitationResult) => void;
  },
): ElicitationOverlay {
  const values: Record<string, TuiElicitationValue> = {};
  let fieldIndex = 0;
  let choiceIndex = 0;
  let multiSelected = new Set<string>();
  let input: Input | undefined;
  let error: string | undefined;
  let settled = false;

  const field = (): TuiFormField | undefined => request.fields[fieldIndex];
  const resetFieldSelection = (): void => {
    const current = field();
    choiceIndex =
      current?.type === "boolean"
        ? current.defaultValue === false
          ? 1
          : 0
        : current?.type === "select" && current.defaultValue !== undefined
          ? current.choices.findIndex((choice) => choice.value === current.defaultValue)
          : current?.type === "select" && !current.required
            ? -1
            : 0;
    const choices = new Set(current?.type === "multiselect" ? current.choices.map(({ value }) => value) : []);
    multiSelected = new Set(
      current?.type === "multiselect" ? current.defaultValue?.filter((value) => choices.has(value)) : [],
    );
  };
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
    next.setValue(safeInteractionScalar(initial));
    if (initial) next.handleInput("\u0005");
    next.onSubmit = (value) => acceptValue(value);
    input = next;
  };

  const finish = (result: TuiFormElicitationResult): void => {
    if (settled) return;
    settled = true;
    options.settle(result);
  };

  const advance = (): void => {
    fieldIndex += 1;
    resetFieldSelection();
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
      if (choiceIndex < 0 && !current.required) {
        advance();
        return;
      }
      const selected = current.choices[choiceIndex];
      if (!selected) {
        if (!current.required) {
          advance();
          return;
        }
        error = "This field has no available choices.";
        options.requestRender();
        return;
      }
      values[current.name] = selected.value;
      advance();
      return;
    }
    if (current.type === "multiselect") {
      const validationError = validateMultiselectField(current, multiSelected.size);
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
      const validationError = validateNumberField(current, number);
      if (validationError) {
        error = validationError;
        options.requestRender();
        return;
      }
      values[current.name] = number;
    } else if (value || current.required) {
      const validationError = validateTextField(current, value);
      if (validationError) {
        error = validationError;
        options.requestRender();
        return;
      }
      values[current.name] = value;
    }
    advance();
  };

  resetFieldSelection();
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
        const first = current.type === "select" && !current.required ? -1 : 0;
        const last = current.type === "boolean" ? 1 : Math.max(first, current.choices.length - 1);
        if (matchesKey(data, "up")) choiceIndex = Math.max(first, choiceIndex - 1);
        else if (matchesKey(data, "down")) choiceIndex = Math.min(last, choiceIndex + 1);
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
      const title = `${safeInteractionScalar(request.source)} · ${safeInteractionScalar(request.title)}`;
      const message = wrapTextWithAnsi(safeTerminalText(request.message), width);
      const description = current?.description
        ? wrapTextWithAnsi(safeTerminalText(current.description), width)
        : [];
      const choices =
        current?.type === "boolean"
          ? ["Yes", "No"]
          : current?.type === "select"
            ? [
                ...(!current.required ? ["Skip"] : []),
                ...current.choices.map((choice) => safeInteractionScalar(choice.label)),
              ]
            : current?.type === "multiselect"
              ? current.choices.map((choice) => safeInteractionScalar(choice.label))
              : [];
      const control =
        choices.length > 0
          ? choices.map(
              (choice, index) =>
                `${styled(options.colorEnabled, index === choiceIndex + (current?.type === "select" && !current.required ? 1 : 0) ? `${ANSI.bold}${ANSI.cyan}` : ANSI.dim, index === choiceIndex + (current?.type === "select" && !current.required ? 1 : 0) ? "›" : " ")} ${
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
              ? "↑/↓ move · space toggle · enter continue · ctrl+d decline · esc cancel"
              : choices.length > 0
                ? "↑/↓ move · enter continue · ctrl+d decline · esc cancel"
                : "enter continue · ctrl+d decline · esc cancel",
          )}`,
          outerWidth,
        ),
        styled(options.colorEnabled, ANSI.dim, `╰─ ${"─".repeat(Math.max(0, outerWidth - 4))}╯`),
      ];
    },
  };
}

function createUrlOverlay(
  request: TuiUrlElicitationRequest,
  options: {
    readonly colorEnabled: boolean;
    readonly height: () => number;
    readonly settle: (result: TuiUrlElicitationResult) => void;
  },
): ElicitationOverlay {
  let settled = false;
  const finish = (result: TuiUrlElicitationResult): void => {
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
        "Press enter to open it in your browser.",
      ];
      return [
        styled(options.colorEnabled, ANSI.dim, `╭─ ${"─".repeat(Math.max(0, outerWidth - 4))}╮`),
        elideText(
          `│ ${styled(options.colorEnabled, `${ANSI.bold}${ANSI.cyan}`, `${safeInteractionScalar(request.source)} · ${safeInteractionScalar(request.title)}`)}`,
          outerWidth,
        ),
        ...body.slice(0, Math.max(1, options.height() - 6)).map((line) => elideText(`│ ${line}`, outerWidth)),
        elideText(
          `│ ${styled(options.colorEnabled, ANSI.dim, "enter accept · ctrl+d decline · esc cancel")}`,
          outerWidth,
        ),
        styled(options.colorEnabled, ANSI.dim, `╰─ ${"─".repeat(Math.max(0, outerWidth - 4))}╯`),
      ];
    },
  };
}

export function createTuiInteractionPresenter(options: {
  readonly tui: TUI;
  readonly colorEnabled: boolean;
  readonly height: () => number;
  readonly openUrl?: (url: string) => Promise<void>;
  readonly onActiveChange?: (active: boolean) => void;
  /** Presents provider sign-in through the `/provider` authentication overlay. */
  readonly authenticateProvider?: TuiInteractionPresenter["presentProviderAuthentication"];
}): TuiInteractionPresenter {
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
    presentForm: (request: TuiFormElicitationRequest) =>
      present<TuiFormElicitationResult>((settle) =>
        createFormOverlay(request, {
          colorEnabled: options.colorEnabled,
          height: options.height,
          requestRender: () => options.tui.requestRender(),
          settle,
        }),
      ),
    presentUrl: (request: TuiUrlElicitationRequest) =>
      present<TuiUrlElicitationResult>((settle) =>
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
    presentProviderAuthentication: (request: TuiProviderAuthenticationRequest) =>
      options.authenticateProvider?.(request) ?? {
        result: Promise.resolve({ action: "error", message: "Provider sign-in isn't available here." }),
        cancel: () => undefined,
      },
  });
}
