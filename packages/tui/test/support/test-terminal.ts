import type { Terminal } from "@earendil-works/pi-tui";

export interface TestTerminal extends Terminal {
  readonly starts: number;
  readonly stops: number;
  readonly drains: number;
  readonly output: string;
  readonly type: (text: string) => void;
  readonly send: (data: string) => void;
  readonly resize: (columns: number, rows: number) => void;
}

export function createTestTerminal(): TestTerminal {
  let starts = 0;
  let stops = 0;
  let drains = 0;
  let output = "";
  let input: ((data: string) => void) | undefined;
  let resizeHandler: (() => void) | undefined;
  let columns = 80;
  let rows = 24;
  return {
    kittyProtocolActive: false,
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
    get drains() {
      return drains;
    },
    get output() {
      return output;
    },
    start(onInput, onResize) {
      starts += 1;
      input = onInput;
      resizeHandler = onResize;
    },
    stop() {
      stops += 1;
      input = undefined;
      resizeHandler = undefined;
    },
    async drainInput() {
      drains += 1;
    },
    type(text) {
      for (const character of text) input?.(character);
    },
    send(data) {
      input?.(data);
    },
    resize(nextColumns, nextRows) {
      columns = nextColumns;
      rows = nextRows;
      resizeHandler?.();
    },
    write(data) {
      output += data;
    },
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  };
}
