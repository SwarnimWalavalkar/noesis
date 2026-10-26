import { matchesKey } from "@earendil-works/pi-tui";
import type { NoesisView } from "./rendering.ts";

/** A one-line notification stays long enough to read once; longer ones wait for the next key. */
export const NOTIFICATION_TTL_MS = 6000;
const CHECK_INTERVAL_MS = 500;

export interface NotificationExpiry {
  /** Feed every main-phase key press; any key but Escape dismisses the current notification. */
  readonly observeInput: (data: string) => void;
  readonly dispose: () => void;
}

/**
 * Notifications are transient feedback above the composer, not transcript records. They clear on
 * the next key press, and single-line ones also clear after a short time. Escape is left alone so
 * the double-Escape interrupt gesture keeps its own notice.
 */
export function createNotificationExpiry(options: {
  readonly view: NoesisView;
  readonly requestRender: () => void;
  readonly now?: () => number;
  readonly ttlMs?: number;
}): NotificationExpiry {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? NOTIFICATION_TTL_MS;
  let tracked: NoesisView["state"]["notification"];
  let shownAt = 0;
  const clear = (notification: NonNullable<NoesisView["state"]["notification"]>): void => {
    // Only the notification that expired is cleared; a newer one keeps its own lifetime.
    if (options.view.state.notification !== notification) return;
    options.view.dispatch({ type: "notification-cleared" });
    options.requestRender();
  };
  const timer = setInterval(() => {
    const current = options.view.state.notification;
    if (current !== tracked) {
      tracked = current;
      shownAt = now();
      return;
    }
    if (current && !current.text.includes("\n") && now() - shownAt >= ttlMs) clear(current);
  }, CHECK_INTERVAL_MS);
  timer.unref();
  return {
    observeInput: (data) => {
      if (data === "\u001b" || matchesKey(data, "escape")) return;
      const current = options.view.state.notification;
      if (current) clear(current);
    },
    dispose: () => clearInterval(timer),
  };
}
