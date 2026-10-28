import { createConditionalObject } from "@noesis/domain";
import type { TUI } from "@earendil-works/pi-tui";
import {
  createTuiInteractionPresenter,
  type TuiInteractionBridge,
  type TuiInteractionPresenter,
} from "./interaction.ts";

export interface TuiInteractionOrchestration {
  readonly ownsKeyboardFocus: () => boolean;
  readonly dispose: () => void;
}

/** Attaches the mounted TUI to the runtime's elicitation bridge. */
export function createTuiInteractionOrchestration(options: {
  readonly bridge?: TuiInteractionBridge;
  readonly tui: TUI;
  readonly colorEnabled: boolean;
  readonly height: () => number;
  readonly openUrl?: (url: string) => Promise<void>;
  readonly authenticateProvider: TuiInteractionPresenter["presentProviderAuthentication"];
}): TuiInteractionOrchestration {
  let active = false;
  let disposed = false;
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const detach = options.bridge?.attach(
    createTuiInteractionPresenter(
      createConditionalObject({
        tui: options.tui,
        colorEnabled: options.colorEnabled,
        height: options.height,
        authenticateProvider: options.authenticateProvider,
      } as const)
        .addOptional(options.openUrl ? { openUrl: options.openUrl } : undefined)
        .add({
          onActiveChange: (next: boolean) => {
            active = next;
          },
        } as const)
        .finish(),
    ),
  );
  return Object.freeze({
    ownsKeyboardFocus: () => active,
    dispose() {
      if (disposed) return;
      disposed = true;
      detach?.();
      options.bridge?.shutdown();
    },
  });
}
