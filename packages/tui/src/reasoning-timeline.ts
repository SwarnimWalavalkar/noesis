import type { TuiTimelineEntry } from "./state.ts";

export function appendReasoningDelta(
  timeline: readonly TuiTimelineEntry[],
  text: string,
): readonly TuiTimelineEntry[] {
  const next = [...timeline];
  const last = next.at(-1);
  if (last?.kind === "reasoning") next[next.length - 1] = { ...last, text: last.text + text };
  else next.push({ kind: "reasoning", text });
  return next;
}

export function reconcileReasoning(
  timeline: readonly TuiTimelineEntry[],
  text: string,
): readonly TuiTimelineEntry[] {
  const next = [...timeline];
  const index = next.findLastIndex((entry) => entry.kind === "reasoning");
  const entry = next[index];
  if (index >= 0 && entry?.kind === "reasoning") next[index] = { ...entry, text };
  else next.push({ kind: "reasoning", text });
  return next;
}
