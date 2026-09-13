import { vi } from "vitest";

// Synthetic input must not inherit the developer's physical Shift key on macOS.
// This upstream native hardware probe has no injectable API; real PTY subprocesses
// do not load this setup and continue to exercise the production input path.
// eslint-disable-next-line anti-slop/no-module-mocking
vi.mock("@earendil-works/pi-tui/dist/native-modifiers.js", () => ({
  isNativeModifierPressed: () => false,
}));
