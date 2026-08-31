import {
  SelectList,
  type Component,
  type Focusable,
  type OverlayHandle,
  type SelectListTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import type { TuiProviderPickerIntent, TuiProviderPickerSelection } from "./commands.ts";
import type { NoesisTuiRuntime, TuiModelRoute, TuiProviderAuthStatus } from "./runtime-port.ts";
import { ANSI, elideText, safeTerminalText, styled } from "./theme.ts";

interface ProviderPickerItem {
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly name: string;
}

const sourceLabel = (status: TuiProviderAuthStatus | undefined, failed: boolean): string => {
  if (!status) return failed ? "connection status unavailable" : "checking connection";
  if (!status.configured) return "not connected";
  const source =
    status.source === "oauth"
      ? "OAuth"
      : status.source === "stored-api-key"
        ? "API key"
        : status.source === "environment"
          ? "environment"
          : "connected";
  return `connected · ${source}${status.expired ? " · expired" : ""}`;
};

const providerRoutes = (
  routes: readonly TuiModelRoute[],
  currentProvider: string,
): readonly Readonly<{ id: string; name: string; routes: readonly TuiModelRoute[] }>[] => {
  const ids = [...new Set([...routes.map((route) => route.provider), currentProvider])];
  return ids
    .map((id) => {
      const matching = routes.filter((route) => route.provider === id);
      return Object.freeze({ id, name: matching[0]?.providerName ?? id, routes: Object.freeze(matching) });
    })
    .sort((left, right) => {
      if (left.id === currentProvider) return -1;
      if (right.id === currentProvider) return 1;
      return left.name.localeCompare(right.name);
    });
};

const pickerItems = (
  routes: readonly TuiModelRoute[],
  currentProvider: string,
  statuses: ReadonlyMap<string, TuiProviderAuthStatus>,
  statusFailures: ReadonlySet<string>,
): readonly ProviderPickerItem[] =>
  providerRoutes(routes, currentProvider).map((provider) => {
    const defaultModel = provider.routes.find((route) => route.default)?.model;
    const identity = provider.name === provider.id ? provider.name : `${provider.name} (${provider.id})`;
    return Object.freeze({
      value: provider.id,
      name: provider.name,
      label: `${identity}${provider.id === currentProvider ? "  ✓ current" : ""}`,
      description: [
        sourceLabel(statuses.get(provider.id), statusFailures.has(provider.id)),
        `${String(provider.routes.length)} models`,
        defaultModel ? `default ${defaultModel}` : undefined,
      ]
        .filter((part): part is string => part !== undefined)
        .join(" · "),
    });
  });

export interface TuiProviderPickerOrchestration {
  readonly select: (intent: TuiProviderPickerIntent) => Promise<TuiProviderPickerSelection | undefined>;
  readonly ownsKeyboardFocus: () => boolean;
  readonly dispose: () => void;
}

export function createTuiProviderPickerOrchestration(options: {
  readonly runtime: NoesisTuiRuntime;
  readonly routes: () => readonly TuiModelRoute[];
  readonly tui: TUI;
  readonly theme: SelectListTheme;
  readonly colorEnabled: boolean;
  readonly height: () => number;
}): TuiProviderPickerOrchestration {
  let handle: OverlayHandle | undefined;
  let finish: ((selection: TuiProviderPickerSelection | undefined) => void) | undefined;
  let active: Promise<TuiProviderPickerSelection | undefined> | undefined;
  const settle = (selection: TuiProviderPickerSelection | undefined): void => {
    const resolve = finish;
    finish = undefined;
    active = undefined;
    handle?.hide();
    handle = undefined;
    options.tui.requestRender();
    resolve?.(selection);
  };
  return Object.freeze({
    select(intent: TuiProviderPickerIntent) {
      if (active) {
        handle?.focus();
        return active;
      }
      active = new Promise<TuiProviderPickerSelection | undefined>((resolve) => {
        finish = resolve;
      });
      const statuses = new Map<string, TuiProviderAuthStatus>();
      const statusFailures = new Set<string>();
      let notice: string | undefined;
      let confirmationProvider: string | undefined;
      let disconnecting = false;
      let items = pickerItems(options.routes(), intent.currentProvider, statuses, statusFailures);
      const createPicker = (): SelectList => {
        const next = new SelectList(
          [...items],
          Math.max(1, Math.min(10, options.height() - 5)),
          options.theme,
        );
        next.onSelect = (item) => {
          const selected = items.find((candidate) => candidate.value === item.value);
          if (selected) settle({ provider: selected.value, providerName: selected.name });
        };
        next.onCancel = () => settle(undefined);
        return next;
      };
      let picker = createPicker();
      const rebuild = (): void => {
        const selected = picker.getSelectedItem()?.value;
        items = pickerItems(options.routes(), intent.currentProvider, statuses, statusFailures);
        picker = createPicker();
        if (selected) {
          const index = items.findIndex((item) => item.value === selected);
          for (let position = 0; position < index; position += 1) picker.handleInput("\u001b[B");
        }
      };
      const selectedItem = (): ProviderPickerItem | undefined => {
        const selected = picker.getSelectedItem();
        return selected ? items.find((item) => item.value === selected.value) : undefined;
      };
      const requestDisconnect = (): void => {
        const selected = selectedItem();
        if (!selected) return;
        if (statusFailures.has(selected.value)) {
          notice = `${selected.name} connection status is unavailable; no credentials were changed.`;
          options.tui.requestRender();
          return;
        }
        const status = statuses.get(selected.value);
        if (!status) {
          notice = "Connection status is still loading.";
          options.tui.requestRender();
          return;
        }
        if (!status.configured) {
          notice = `${selected.name} is already disconnected.`;
          options.tui.requestRender();
          return;
        }
        if (status.source === "environment") {
          notice = `${selected.name} is configured by the environment and cannot be disconnected here.`;
          options.tui.requestRender();
          return;
        }
        if (!options.runtime.disconnectProvider) {
          notice = "Provider disconnection is unavailable in this runtime.";
          options.tui.requestRender();
          return;
        }
        notice = undefined;
        confirmationProvider = selected.value;
        options.tui.requestRender();
      };
      const confirmDisconnect = (): void => {
        const providerId = confirmationProvider;
        if (!providerId || disconnecting || !options.runtime.disconnectProvider) return;
        disconnecting = true;
        options.tui.requestRender();
        void options.runtime.disconnectProvider(providerId).then(
          (status) => {
            statuses.set(providerId, status);
            statusFailures.delete(providerId);
            disconnecting = false;
            confirmationProvider = undefined;
            const name = items.find((item) => item.value === providerId)?.name ?? providerId;
            notice = status.configured
              ? `Stored credentials removed; ${name} remains connected through the environment.`
              : `${name} disconnected.`;
            rebuild();
            options.tui.requestRender();
          },
          (cause: unknown) => {
            disconnecting = false;
            confirmationProvider = undefined;
            notice = safeTerminalText(cause instanceof Error ? cause.message : String(cause));
            options.tui.requestRender();
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
          const confirmation = confirmationProvider
            ? [
                `Disconnect ${items.find((item) => item.value === confirmationProvider)?.name ?? confirmationProvider}?`,
                disconnecting ? "Disconnecting…" : "d again to disconnect · Esc keep",
              ]
            : ["↑/↓ navigate · Enter use provider · d disconnect · Esc cancel"];
          return [
            `${styled(options.colorEnabled, `${ANSI.bold}${ANSI.cyan}`, "NOESIS")}  ${styled(options.colorEnabled, ANSI.dim, "manage providers")}`,
            ...confirmation.map((line) => styled(options.colorEnabled, ANSI.dim, elideText(line, width))),
            ...(notice ? [styled(options.colorEnabled, ANSI.dim, elideText(notice, width))] : []),
            ...picker.render(width),
          ];
        },
        handleInput(data) {
          if (confirmationProvider) {
            if (data === "\u001b") {
              confirmationProvider = undefined;
              options.tui.requestRender();
            } else if (data === "d" || data === "D") confirmDisconnect();
            return;
          }
          if (data === "d" || data === "D") {
            requestDisconnect();
            return;
          }
          notice = undefined;
          picker.handleInput(data);
          options.tui.requestRender();
        },
        invalidate() {
          picker.invalidate();
        },
      };
      handle = options.tui.showOverlay(overlay, {
        anchor: "center",
        width: "88%",
        maxHeight: "90%",
        margin: 1,
      });
      handle.focus();
      const status = options.runtime.providerAuthStatus;
      const selection = active;
      if (status) {
        void Promise.all(
          items.map(async (item) => {
            try {
              statuses.set(item.value, await status(item.value));
              statusFailures.delete(item.value);
            } catch {
              statusFailures.add(item.value);
            }
          }),
        ).then(() => {
          if (!handle || active !== selection) return;
          rebuild();
          options.tui.requestRender();
        });
      } else {
        for (const item of items) statusFailures.add(item.value);
        rebuild();
      }
      return active;
    },
    ownsKeyboardFocus: () => Boolean(handle?.isFocused()),
    dispose: () => settle(undefined),
  });
}
