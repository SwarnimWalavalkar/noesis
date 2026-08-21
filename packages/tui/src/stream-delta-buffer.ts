import { streamingFrameDelay } from "./lifecycle-utils.ts";

export type ActiveTurnToken = Readonly<{
  generation: number;
  trailId: string;
  turnId: string;
}>;

export interface StreamDeltaBuffer<Token> {
  readonly queue: (token: Token, text: string) => void;
  readonly flush: (token: Token) => void;
  readonly clear: () => void;
}

/** Coalesces streaming deltas into bounded-rate terminal renders for one active turn token. */
export function createStreamDeltaBuffer<Token>(options: {
  readonly isCurrent: (token: Token) => boolean;
  readonly activeCharacters: () => number;
  readonly publish: (text: string) => void;
}): StreamDeltaBuffer<Token> {
  let pending: { readonly token: Token; readonly text: string } | undefined;
  let timer: NodeJS.Timeout | undefined;
  let timerToken: Token | undefined;

  const flush = (token: Token): void => {
    if (timer && timerToken !== token) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    timerToken = undefined;
    if (!options.isCurrent(token) || pending?.token !== token || !pending.text) return;
    const text = pending.text;
    pending = undefined;
    options.publish(text);
  };

  return Object.freeze({
    queue: (token: Token, text: string) => {
      if (!options.isCurrent(token) || !text) return;
      const next = { token, text: `${pending?.token === token ? pending.text : ""}${text}` };
      pending = next;
      if (timer) return;
      timer = setTimeout(
        () => flush(token),
        streamingFrameDelay(options.activeCharacters(), next.text.length),
      );
      timerToken = token;
    },
    flush,
    clear: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      timerToken = undefined;
      pending = undefined;
    },
  });
}
