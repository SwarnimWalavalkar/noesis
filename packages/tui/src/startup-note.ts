/**
 * One quiet invitation under the wordmark. Picked once per process start so the same launch
 * keeps a stable line while later launches feel different.
 *
 * Keep each note short enough to sit under the ASCII wordmark (~46 columns).
 */
export const NOESIS_STARTUP_NOTES = [
  "What should we work on today?",
  "What should we build?",
  "What's on your mind?",
  "Where should we start?",
  "What are we making next?",
  "What are we building?",
  "What are you thinking about?",
  "Ready when you are.",
  "What problem are we chasing?",
  "What are you curious about?",
  "What should we learn together?",
  "What are you trying to understand?",
] as const;

export type StartupNote = (typeof NOESIS_STARTUP_NOTES)[number];

/** Stable pick for one launch. Pass a seeded random in tests. */
export function pickStartupNote(random: () => number = Math.random): StartupNote {
  const length = NOESIS_STARTUP_NOTES.length;
  const index = Math.min(length - 1, Math.max(0, Math.floor(random() * length)));
  return NOESIS_STARTUP_NOTES[index] ?? NOESIS_STARTUP_NOTES[0];
}
