const SUPPRESSED_EXPERIMENTAL_FEATURES = ["SQLite"] as const;

/**
 * Node emits an ExperimentalWarning the first time `node:sqlite` loads. SQLite is a deliberate,
 * documented part of the workspace storage design, so the warning carries no action for a user and
 * would otherwise be the first thing printed on a fresh install.
 */
export function isExpectedExperimentalWarning(warning: Error): boolean {
  return (
    warning.name === "ExperimentalWarning" &&
    SUPPRESSED_EXPERIMENTAL_FEATURES.some((feature) => warning.message.startsWith(`${feature} is`))
  );
}

export function installProcessWarningFilter(): void {
  const previous = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (isExpectedExperimentalWarning(warning)) return;
    if (previous.length === 0) {
      console.error(warning.stack ?? `${warning.name}: ${warning.message}`);
      return;
    }
    for (const listener of previous) listener(warning);
  });
}

installProcessWarningFilter();
