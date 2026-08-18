import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { createLearningAuditOverlay, type LearningAuditOverlay } from "./learning-audit.ts";
import type { NoesisTuiRuntime } from "./runtime-port.ts";

export interface TuiLearningOrchestration {
  readonly open: (sessionId: string) => void;
  readonly rememberFocus: (recordId: string) => void;
  readonly ownsKeyboardFocus: () => boolean;
  readonly dispose: () => void;
}

export function createTuiLearningOrchestration(options: {
  readonly runtime: NoesisTuiRuntime;
  readonly tui: TUI;
  readonly colorEnabled: boolean;
  readonly height: () => number;
  readonly reportUnavailable: (message: string) => void;
}): TuiLearningOrchestration {
  let handle: OverlayHandle | undefined;
  let overlay: LearningAuditOverlay | undefined;
  let rememberedFocusId: string | undefined;

  const close = (): void => {
    overlay?.dispose();
    overlay = undefined;
    handle?.hide();
    handle = undefined;
    options.tui.requestRender();
  };

  return Object.freeze({
    open(sessionId: string) {
      const focusRecordId = rememberedFocusId;
      rememberedFocusId = undefined;
      if (handle && overlay) {
        if (focusRecordId) overlay.focusRecord(focusRecordId);
        handle.focus();
        return;
      }
      const { inspectLearningAudit } = options.runtime;
      if (!inspectLearningAudit) {
        options.reportUnavailable("The learning audit is unavailable in this runtime.");
        options.tui.requestRender();
        return;
      }
      overlay = createLearningAuditOverlay({
        runtime: {
          inspectLearningAudit,
          ...(options.runtime.manageCapability ? { manageCapability: options.runtime.manageCapability } : {}),
        },
        sessionId,
        colorEnabled: options.colorEnabled,
        height: options.height,
        requestRender: () => options.tui.requestRender(),
        close,
        ...(focusRecordId ? { focusRecordId } : {}),
      });
      handle = options.tui.showOverlay(overlay, {
        anchor: "center",
        width: "94%",
        maxHeight: "92%",
        margin: 1,
      });
    },
    rememberFocus(recordId: string) {
      rememberedFocusId = recordId;
    },
    ownsKeyboardFocus: () => Boolean(handle?.isFocused()),
    dispose: close,
  });
}
