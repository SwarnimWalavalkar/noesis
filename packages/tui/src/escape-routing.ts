import { matchesKey } from "@earendil-works/pi-tui";
import type { NoesisView } from "./rendering.ts";

const ESC_ARM_NOTICE = "Press esc again to interrupt";

type StandaloneEscapeHandler = () => boolean;

/**
 * Decides what a standalone Escape means for the current UI mode: close the run inspector, leave
 * transcript inspection, or interrupt the visible turn. Interrupting discards live work, so it
 * takes two consecutive Escapes: the first arms a short window and shows a notice, the second
 * commits. Any other key, an expired window, or a different visible turn disarms the gesture.
 */
export interface EscapeRouting {
  /** Mirrors `SafeEditor.createStandaloneEscapeHandler`: binds Escape's meaning at key arrival. */
  readonly createStandaloneEscapeHandler: () => StandaloneEscapeHandler | undefined;
  /** Feed every raw main-phase input chunk so non-Escape keys break the armed gesture. */
  readonly observeInput: (data: string) => void;
}

export function createEscapeRouting(options: {
  readonly view: NoesisView;
  readonly isMainPhase: () => boolean;
  readonly armWindowMs: number;
  readonly closeRunInspector: () => void;
  readonly interruptActiveTurn: () => void;
  readonly requestRender: () => void;
}): EscapeRouting {
  const { view } = options;
  let arm: { readonly turnId: string; readonly expiresAt: number } | undefined;
  let armTimer: NodeJS.Timeout | undefined;
  let nonEscapeInputGeneration = 0;
  const disarm = (): void => {
    if (armTimer) clearTimeout(armTimer);
    armTimer = undefined;
    if (!arm) return;
    arm = undefined;
    // Only retract our own notice; a newer notification must not be erased by the timer.
    if (view.state.notification?.text === ESC_ARM_NOTICE) {
      view.dispatch({ type: "notification-cleared" });
      options.requestRender();
    }
  };
  const armFor = (turnId: string): void => {
    if (armTimer) clearTimeout(armTimer);
    arm = { turnId, expiresAt: Date.now() + options.armWindowMs };
    armTimer = setTimeout(disarm, options.armWindowMs);
    armTimer.unref();
    view.dispatch({ type: "notification-shown", text: ESC_ARM_NOTICE, tone: "attention" });
    options.requestRender();
  };
  return {
    observeInput: (data) => {
      if (data === "\u001b" || matchesKey(data, "escape")) return;
      nonEscapeInputGeneration += 1;
      if (arm) disarm();
    },
    createStandaloneEscapeHandler: () => {
      if (!options.isMainPhase()) return undefined;
      const inspectedActionId = view.state.inspector?.actionId;
      if (inspectedActionId)
        return () => {
          if (view.state.inspector?.actionId === inspectedActionId) options.closeRunInspector();
          return true;
        };
      const selectedActionId = view.state.actionCursor;
      if (selectedActionId)
        return () => {
          if (view.state.actionCursor === selectedActionId) {
            view.dispatch({ type: "action-cursor-cleared" });
            options.requestRender();
          }
          return true;
        };
      if (view.state.interaction.phase === "idle") return undefined;
      const visibleTurnId = view.state.interaction.active?.turnId;
      if (!visibleTurnId) return () => true;
      // SafeEditor delays a lone legacy Escape while it may still become a fragmented paste
      // marker. Capture the raw-input generation now so a key arriving during that delay makes
      // this Escape ineligible to arm or commit the consecutive-key gesture.
      const capturedInputGeneration = nonEscapeInputGeneration;
      return () => {
        if (nonEscapeInputGeneration !== capturedInputGeneration) return true;
        if (view.state.interaction.active?.turnId !== visibleTurnId) return true;
        if (view.state.interaction.phase === "interrupting" || view.state.execution === "aborting")
          return true;
        if (arm && arm.turnId === visibleTurnId && Date.now() <= arm.expiresAt) {
          disarm();
          options.interruptActiveTurn();
          return true;
        }
        armFor(visibleTurnId);
        return true;
      };
    },
  };
}
