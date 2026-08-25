import type { TuiTimelineEntry } from "./state.ts";
import { createStreamDeltaBuffer, type StreamDeltaBuffer } from "./stream-delta-buffer.ts";

export function createTuiStreamBuffers<Token>(options: {
  readonly isCurrent: (token: Token) => boolean;
  readonly timeline: () => readonly TuiTimelineEntry[];
  readonly publishAssistant: (text: string) => void;
  readonly publishReasoning: (text: string) => void;
}): Readonly<{
  assistant: StreamDeltaBuffer<Token>;
  reasoning: StreamDeltaBuffer<Token>;
}> {
  return Object.freeze({
    assistant: createStreamDeltaBuffer({
      isCurrent: options.isCurrent,
      activeCharacters: () => {
        const entry = options.timeline().at(-1);
        return entry?.kind === "message" && entry.role === "assistant" ? entry.text.length : 0;
      },
      publish: options.publishAssistant,
    }),
    reasoning: createStreamDeltaBuffer({
      isCurrent: options.isCurrent,
      activeCharacters: () => {
        const entry = [...options.timeline()].reverse().find((candidate) => candidate.kind === "reasoning");
        return entry?.kind === "reasoning" ? entry.text.length : 0;
      },
      publish: options.publishReasoning,
    }),
  });
}
