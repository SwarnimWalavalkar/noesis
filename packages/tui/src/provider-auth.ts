import {
  Input,
  matchesKey,
  SelectList,
  type Component,
  type Focusable,
  type OverlayHandle,
  type SelectListTheme,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { createConditionalObject } from "@noesis/domain";
import type {
  NoesisTuiRuntime,
  TuiProviderAuthCallbacks,
  TuiProviderAuthEvent,
  TuiProviderAuthPrompt,
} from "./runtime-port.ts";
import { ANSI, elideText, safeTerminalText, styled } from "./theme.ts";

interface AuthPromptBody extends Component {
  readonly handleInput: (data: string) => void;
  readonly clear: () => void;
}

interface AuthOverlay extends Component, Focusable {
  readonly prompt: (prompt: TuiProviderAuthPrompt) => Promise<string>;
  readonly notify: (event: TuiProviderAuthEvent) => void;
  readonly cancel: () => void;
  readonly secrets: ReadonlySet<string>;
  readonly clearSecrets: () => void;
}

export interface TuiProviderAuthOrchestration {
  readonly ensure: (providerId: string, providerName: string) => Promise<boolean>;
  readonly ownsKeyboardFocus: () => boolean;
  readonly dispose: () => void;
}

const SECRET_HINT = "Input hidden · Enter continue · Esc cancel";
const TEXT_HINT = "Enter continue · Esc cancel";
const SELECT_HINT = "↑/↓ navigate · Enter select · Esc cancel";

const padded = (text: string, width: number): string => {
  const bounded = elideText(text, Math.max(0, width));
  return `${bounded}${" ".repeat(Math.max(0, width - visibleWidth(bounded)))}`;
};

const row = (text: string, width: number, colorEnabled: boolean): string => {
  const boundedWidth = Math.max(12, Math.floor(width));
  const innerWidth = Math.max(0, boundedWidth - 4);
  return `${styled(colorEnabled, ANSI.dim, "│")} ${padded(text, innerWidth)} ${styled(colorEnabled, ANSI.dim, "│")}`;
};

const rule = (width: number, colorEnabled: boolean, top: boolean): string => {
  const boundedWidth = Math.max(12, Math.floor(width));
  return styled(
    colorEnabled,
    ANSI.dim,
    `${top ? "╭" : "╰"}${"─".repeat(Math.max(0, boundedWidth - 2))}${top ? "╮" : "╯"}`,
  );
};

function createMaskedInput(input: Input, colorEnabled: boolean): Component {
  return {
    invalidate: () => input.invalidate(),
    render(width) {
      const mask = "•".repeat([...input.getValue()].length);
      return [elideText(`${styled(colorEnabled, ANSI.dim, "> ")}${mask}`, Math.max(0, width))];
    },
  };
}

function redactSecrets(value: string, secrets: ReadonlySet<string>): string {
  let redacted = value;
  for (const secret of secrets) if (secret.length > 0) redacted = redacted.replaceAll(secret, "[redacted]");
  return redacted;
}

function createAuthOverlay(options: {
  readonly providerName: string;
  readonly theme: SelectListTheme;
  readonly colorEnabled: boolean;
  readonly requestRender: () => void;
  readonly openUrl?: (url: string) => Promise<void>;
  readonly abort: () => void;
}): AuthOverlay {
  const notes: string[] = [`${options.providerName} needs authentication before the new session starts.`];
  const secrets = new Set<string>();
  let focused = false;
  let question: string | undefined;
  let hint = "Preparing authentication · Esc cancel";
  let body: AuthPromptBody | undefined;
  let rejectPrompt: ((cause: Error) => void) | undefined;

  const clearBody = (): void => {
    body?.clear();
    body = undefined;
    rejectPrompt = undefined;
    question = undefined;
    hint = "Finishing authentication · Esc cancel";
    options.requestRender();
  };

  const cancel = (): void => {
    const reject = rejectPrompt;
    clearBody();
    reject?.(new Error("Provider authentication was cancelled."));
    options.abort();
  };

  const prompt = (next: TuiProviderAuthPrompt): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      clearBody();
      const placeholder = "placeholder" in next ? next.placeholder : undefined;
      question = `${redactSecrets(next.message, secrets)}${placeholder ? ` (${redactSecrets(placeholder, secrets)})` : ""}`;
      rejectPrompt = reject;
      let settled = false;
      const settle = (value: string): void => {
        if (settled) return;
        settled = true;
        next.signal?.removeEventListener("abort", abort);
        if (next.type === "secret" && value.length > 0) secrets.add(value);
        clearBody();
        resolve(value);
      };
      const abort = (): void => {
        if (settled) return;
        settled = true;
        clearBody();
        reject(new Error("Provider authentication was cancelled."));
      };
      if (next.signal?.aborted) {
        abort();
        return;
      }
      next.signal?.addEventListener("abort", abort, { once: true });
      if (next.type === "select") {
        const list = new SelectList(
          next.options.map((option) =>
            createConditionalObject({
              value: option.id,
              label: redactSecrets(option.label, secrets),
            } as const)
              .addOptional(
                option.description ? { description: redactSecrets(option.description, secrets) } : undefined,
              )
              .finish(),
          ),
          Math.max(1, Math.min(8, next.options.length)),
          options.theme,
          { minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 48 },
        );
        const preferred = next.options.findIndex((option) =>
          option.label.toLowerCase().includes("(default)"),
        );
        if (preferred >= 0) list.setSelectedIndex(preferred);
        list.onSelect = (selected) => settle(selected.value);
        hint = SELECT_HINT;
        body = {
          render: (width) => list.render(width),
          invalidate: () => list.invalidate(),
          handleInput: (data) => list.handleInput(data),
          clear: () => undefined,
        };
      } else {
        const input = new Input();
        input.onSubmit = settle;
        const masked = next.type === "secret";
        hint = masked ? SECRET_HINT : TEXT_HINT;
        body = {
          render: (width) =>
            masked ? createMaskedInput(input, options.colorEnabled).render(width) : input.render(width),
          invalidate: () => input.invalidate(),
          handleInput: (data) => input.handleInput(data),
          clear: () => input.setValue(""),
        };
        input.focused = focused;
      }
      options.requestRender();
    });

  const notify = (event: TuiProviderAuthEvent): void => {
    if (event.type === "auth_url") {
      notes.push(
        options.openUrl ? "Opening your browser to finish sign-in." : "Finish sign-in in your browser.",
      );
      notes.push(`Sign-in URL: ${redactSecrets(event.url, secrets)}`);
      if (event.instructions) notes.push(redactSecrets(event.instructions, secrets));
      if (options.openUrl) void options.openUrl(event.url).catch(() => undefined);
    } else if (event.type === "device_code") {
      notes.push(`Verification URL: ${redactSecrets(event.verificationUri, secrets)}`);
      notes.push(`Device code: ${redactSecrets(event.userCode, secrets)}`);
    } else {
      notes.push(redactSecrets(event.message, secrets));
      if (event.type === "info")
        for (const link of event.links ?? [])
          notes.push(
            `${redactSecrets(link.label ?? "More information", secrets)}: ${redactSecrets(link.url, secrets)}`,
          );
    }
    options.requestRender();
  };

  return {
    get focused() {
      return focused;
    },
    set focused(value: boolean) {
      focused = value;
    },
    get secrets() {
      return secrets;
    },
    prompt,
    notify,
    cancel,
    clearSecrets: () => secrets.clear(),
    handleInput(data) {
      if (matchesKey(data, "escape")) {
        cancel();
        return;
      }
      body?.handleInput(data);
    },
    invalidate: () => body?.invalidate(),
    render(width) {
      const boundedWidth = Math.max(12, Math.floor(width));
      const innerWidth = Math.max(1, boundedWidth - 4);
      const lines = [
        rule(boundedWidth, options.colorEnabled, true),
        row(
          styled(
            options.colorEnabled,
            `${ANSI.bold}${ANSI.cyan}`,
            `AUTHENTICATE · ${safeTerminalText(options.providerName)}`,
          ),
          boundedWidth,
          options.colorEnabled,
        ),
        row("", boundedWidth, options.colorEnabled),
      ];
      for (const note of notes.slice(-5))
        for (const line of wrapTextWithAnsi(safeTerminalText(note), innerWidth))
          lines.push(row(styled(options.colorEnabled, ANSI.dim, line), boundedWidth, options.colorEnabled));
      if (question) {
        lines.push(row("", boundedWidth, options.colorEnabled));
        for (const [index, line] of wrapTextWithAnsi(safeTerminalText(question), innerWidth).entries())
          lines.push(
            row(
              styled(options.colorEnabled, ANSI.bold, `${index === 0 ? "› " : "  "}${line}`),
              boundedWidth,
              options.colorEnabled,
            ),
          );
      }
      if (body)
        for (const line of body.render(innerWidth)) lines.push(row(line, boundedWidth, options.colorEnabled));
      lines.push(row("", boundedWidth, options.colorEnabled));
      lines.push(row(styled(options.colorEnabled, ANSI.dim, hint), boundedWidth, options.colorEnabled));
      lines.push(rule(boundedWidth, options.colorEnabled, false));
      return lines;
    },
  };
}

function redactedAuthenticationError(
  cause: unknown,
  providerName: string,
  secrets: ReadonlySet<string>,
): Error {
  const message = redactSecrets(cause instanceof Error ? cause.message : String(cause), secrets);
  return new Error(`${providerName} authentication failed: ${safeTerminalText(message)}`);
}

export function createTuiProviderAuthOrchestration(options: {
  readonly runtime: NoesisTuiRuntime;
  readonly tui: TUI;
  readonly theme: SelectListTheme;
  readonly colorEnabled: boolean;
  readonly openUrl?: ((url: string) => Promise<void>) | undefined;
}): TuiProviderAuthOrchestration {
  let handle: OverlayHandle | undefined;
  let overlay: AuthOverlay | undefined;
  let active:
    | {
        readonly providerId: string;
        readonly promise: Promise<boolean>;
        readonly settle: (result: boolean, error?: Error) => void;
      }
    | undefined;

  const ensure = async (providerId: string, providerName: string): Promise<boolean> => {
    if (!options.runtime.providerAuthStatus || !options.runtime.authenticateProvider) return true;
    const status = await options.runtime.providerAuthStatus(providerId);
    if (status.configured) return true;
    if (active) {
      handle?.focus();
      return await active.promise;
    }
    const controller = new AbortController();
    let resolve: ((value: boolean) => void) | undefined;
    let reject: ((cause: Error) => void) | undefined;
    const promise = new Promise<boolean>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    let settled = false;
    const settle = (result: boolean, error?: Error): void => {
      if (settled) return;
      settled = true;
      const secrets = overlay?.secrets ?? new Set<string>();
      const safeError = error ? redactedAuthenticationError(error, providerName, secrets) : undefined;
      overlay?.clearSecrets();
      overlay = undefined;
      handle?.hide();
      handle = undefined;
      active = undefined;
      options.tui.requestRender();
      if (safeError) reject?.(safeError);
      else resolve?.(result);
    };
    overlay = createAuthOverlay(
      createConditionalObject({
        providerName,
        theme: options.theme,
        colorEnabled: options.colorEnabled,
        requestRender: () => options.tui.requestRender(),
        abort: () => {
          controller.abort();
          settle(false);
        },
      } as const)
        .addOptional(options.openUrl ? { openUrl: options.openUrl } : undefined)
        .finish(),
    );
    handle = options.tui.showOverlay(overlay, {
      anchor: "center",
      width: "88%",
      maxHeight: "90%",
      margin: 1,
    });
    handle.focus();
    active = { providerId, promise, settle };
    const callbacks: TuiProviderAuthCallbacks = {
      signal: controller.signal,
      prompt: overlay.prompt,
      notify: overlay.notify,
    };
    void options.runtime.authenticateProvider(providerId, callbacks).then(
      (authenticated) => {
        if (!authenticated.configured)
          settle(false, new Error(`Authentication completed without configuring ${providerId}.`));
        else settle(true);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) settle(false);
        else settle(false, cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
    return await promise;
  };

  return Object.freeze({
    ensure,
    ownsKeyboardFocus: () => Boolean(handle?.isFocused()),
    dispose: () => overlay?.cancel(),
  });
}
