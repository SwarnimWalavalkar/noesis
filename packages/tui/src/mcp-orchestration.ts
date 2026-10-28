import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { createMcpManagerOverlay, type McpManagerOverlay } from "./mcp-manager.ts";
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
  readonly mutationsEnabled: () => boolean;
  readonly reportUnavailable: (message: string) => void;
}): TuiMcpOrchestration {
  let managerHandle: OverlayHandle | undefined;
  let managerOverlay: McpManagerOverlay | undefined;
  let disposePromise: Promise<void> | undefined;
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
        options.reportUnavailable("MCP management isn't available here.");
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
    ownsKeyboardFocus: () => Boolean(managerHandle?.isFocused()),
    dispose() {
      disposePromise ??= closeManager();
      return disposePromise;
    },
  });
}
