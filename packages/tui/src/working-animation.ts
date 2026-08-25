const WORKING_ANIMATION_INTERVAL_MS = 120;

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
