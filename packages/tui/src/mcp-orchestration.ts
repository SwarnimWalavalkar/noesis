import { createConditionalObject } from "@noesis/domain";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { createMcpManagerOverlay, type McpManagerOverlay } from "./mcp-manager.ts";
import { createTuiMcpInteractionPresenter, type TuiMcpInteractionBridge } from "./mcp-interaction.ts";
import type { NoesisTuiRuntime } from "./runtime-port.ts";
export interface TuiMcpOrchestration {
  readonly openManager: () => void;
  readonly ownsKeyboardFocus: () => boolean;
  readonly dispose: () => Promise<void>;
}
export function createTuiMcpOrchestration(options: {
  readonly runtime: NoesisTuiRuntime;
  readonly tui: TUI;
  readonly colorEnabled: boolean;
  readonly height: () => number;
  readonly interactionBridge?: TuiMcpInteractionBridge;
  readonly openUrl?: (url: string) => Promise<void>;
  readonly mutationsEnabled: () => boolean;
  readonly reportUnavailable: (message: string) => void;
}): TuiMcpOrchestration {
  let managerHandle: OverlayHandle | undefined;
  let managerOverlay: McpManagerOverlay | undefined;
  let interactionActive = false;
  let disposePromise: Promise<void> | undefined;
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const detachInteraction = options.interactionBridge?.attach(
    createTuiMcpInteractionPresenter(
      createConditionalObject({
        tui: options.tui,
        colorEnabled: options.colorEnabled,
        height: options.height,
      } as const)
        .addOptional(options.openUrl ? { openUrl: options.openUrl } : undefined)
        .add({
          onActiveChange: (active: boolean) => {
            interactionActive = active;
          },
        } as const)
        .finish(),
    ),
  );
  const closeManager = async (): Promise<void> => {
    const overlay = managerOverlay;
    managerOverlay = undefined;
    managerHandle?.hide();
    managerHandle = undefined;
    options.tui.requestRender();
    await overlay?.dispose();
  };
  return Object.freeze({
    openManager() {
      if (managerHandle) {
        managerHandle.focus();
        return;
      }
      const { listMcpServers, inspectMcpServer, mutateMcp } = options.runtime;
      if (!listMcpServers || !inspectMcpServer || !mutateMcp) {
        options.reportUnavailable("MCP management is unavailable in this runtime.");
        options.tui.requestRender();
        return;
      }
      managerOverlay = createMcpManagerOverlay({
        runtime: { listMcpServers, inspectMcpServer, mutateMcp },
        colorEnabled: options.colorEnabled,
        height: options.height,
        mutationsEnabled: options.mutationsEnabled,
        requestRender: () => options.tui.requestRender(),
        close: () => void closeManager(),
      });
      managerHandle = options.tui.showOverlay(managerOverlay, {
        anchor: "center",
        width: "92%",
        maxHeight: "90%",
        margin: 1,
      });
    },
    ownsKeyboardFocus: () => Boolean(managerHandle?.isFocused() || interactionActive),
    dispose() {
      disposePromise ??= (async () => {
        await closeManager();
        detachInteraction?.();
        options.interactionBridge?.shutdown();
      })();
      return disposePromise;
    },
  });
}
