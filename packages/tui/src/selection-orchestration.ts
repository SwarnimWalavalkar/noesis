import type { SelectListTheme, TUI } from "@earendil-works/pi-tui";
import { createTuiProviderAuthOrchestration } from "./provider-auth.ts";
import { createTuiProviderPickerOrchestration } from "./provider-picker.ts";
import { createTuiRoutePickerOrchestration } from "./route-picker.ts";
import type { NoesisTuiRuntime, TuiProviderAuthCallbacks } from "./runtime-port.ts";
import { createTuiSessionPickerOrchestration } from "./session-picker.ts";

export function createTuiSelectionOrchestration(options: {
  readonly runtime: NoesisTuiRuntime;
  readonly tui: TUI;
  readonly theme: SelectListTheme;
  readonly colorEnabled: boolean;
  readonly height: () => number;
  readonly currentTrailId: () => string | undefined;
  readonly openUrl?: ((url: string) => Promise<void>) | undefined;
  readonly renderOAuthCallbackPage?:
    | NonNullable<TuiProviderAuthCallbacks["renderOAuthCallbackPage"]>
    | undefined;
}) {
  const routeOptions = {
    routes: () => options.runtime.listModelRoutes?.() ?? [],
    tui: options.tui,
    colorEnabled: options.colorEnabled,
    height: options.height,
  } as const;
  const refreshModelRoutes = options.runtime.refreshModelRoutes;
  const route = createTuiRoutePickerOrchestration(
    refreshModelRoutes ? { ...routeOptions, refreshRoutes: () => refreshModelRoutes() } : routeOptions,
  );
  const auth = createTuiProviderAuthOrchestration({
    runtime: options.runtime,
    tui: options.tui,
    theme: options.theme,
    colorEnabled: options.colorEnabled,
    openUrl: options.openUrl,
    renderOAuthCallbackPage: options.renderOAuthCallbackPage,
  });
  const provider = createTuiProviderPickerOrchestration({
    runtime: options.runtime,
    routes: routeOptions.routes,
    tui: options.tui,
    theme: options.theme,
    colorEnabled: options.colorEnabled,
    height: options.height,
  });
  const session = createTuiSessionPickerOrchestration({
    runtime: options.runtime,
    tui: options.tui,
    theme: options.theme,
    colorEnabled: options.colorEnabled,
    height: options.height,
    currentTrailId: options.currentTrailId,
  });
  return Object.freeze({
    selectRoute: route.select,
    selectProvider: provider.select,
    ensureProviderAuthenticated: auth.ensure,
    selectSession: session.select,
    ownsKeyboardFocus: () =>
      route.ownsKeyboardFocus() ||
      provider.ownsKeyboardFocus() ||
      auth.ownsKeyboardFocus() ||
      session.ownsKeyboardFocus(),
    dispose() {
      route.dispose();
      provider.dispose();
      auth.dispose();
      session.dispose();
    },
  });
}
