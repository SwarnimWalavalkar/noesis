import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { createMcpManagerOverlay, type McpManagerOverlay } from "./mcp-manager.ts";
import { createTuiMcpInteractionPresenter, type TuiMcpInteractionBridge } from "./mcp-interaction.ts";
import type { NoesisTuiRuntime } from "./runtime-port.ts";

export interface TuiMcpOrchestration {
  readonly openManager: () => void;
  readonly ownsKeyboardFocus: () => boolean;
  readonly dispose: () => void;
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

  const detachInteraction = options.interactionBridge?.attach(
    createTuiMcpInteractionPresenter({
      tui: options.tui,
      colorEnabled: options.colorEnabled,
      height: options.height,
      ...(options.openUrl ? { openUrl: options.openUrl } : {}),
      onActiveChange: (active) => {
        interactionActive = active;
      },
    }),
  );

  const closeManager = (): void => {
    managerOverlay?.dispose();
    managerOverlay = undefined;
    managerHandle?.hide();
    managerHandle = undefined;
    options.tui.requestRender();
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
        close: closeManager,
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
      closeManager();
      detachInteraction?.();
      options.interactionBridge?.shutdown();
    },
  });
}
