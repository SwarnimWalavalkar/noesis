import type { ExecutionState } from "./state.ts";

export const WORKING_ANIMATION_INTERVAL_MS = 120;

/** States in which the animation clock ticks and working affordances animate. */
export function isWorkingExecution(execution: ExecutionState): boolean {
  return (
    execution === "thinking" ||
    execution === "streaming" ||
    execution === "tool" ||
    execution === "compacting" ||
    execution === "aborting"
  );
}

const PULSE_PERIOD_FRAMES = 4;

/** A slow breath for live glyphs: several clock ticks per phase so the pulse reads as calm. */
export function isPulseDimFrame(frame: number): boolean {
  return Math.floor(frame / PULSE_PERIOD_FRAMES) % 2 === 1;
}

/** View-local animation clock. It never owns or persists execution state. */
export function startWorkingAnimation(
  isWorking: () => boolean,
  tick: () => void,
  intervalMs = WORKING_ANIMATION_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    if (isWorking()) tick();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
