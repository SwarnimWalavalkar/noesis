import type { NoesisAgentRuntime } from "@noesis/agent-types";
import { Container, TUI } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import {
  createSelectTheme,
  createTuiProviderPickerOrchestration,
  type TuiModelRoute,
  type TuiProviderAuthStatus,
} from "../src/index.ts";
import { createInMemoryTestRuntime } from "./support/in-memory-runtime.ts";
import { createTestTerminal } from "./support/test-terminal.ts";

const agent: NoesisAgentRuntime = {
  name: "provider-picker-test",
  async run(request) {
    return {
      text: request.prompt,
      provider: request.provider,
      model: request.model,
      outcome: "completed",
      stopReason: "stop",
    };
  },
  async steer() {
    return { status: "consumed", timelineSequence: 1, consumedAt: "2026-09-01T00:00:00.000Z" };
  },
  async abort() {},
};

const routes = Object.freeze([
  Object.freeze({
    provider: "alpha",
    providerName: "Alpha OAuth",
    model: "alpha-default",
    name: "Alpha Default",
    thinkingLevels: Object.freeze(["off"] as const),
    default: true,
    allowsCustomModelIds: false,
  }),
  Object.freeze({
    provider: "beta",
    providerName: "Beta Key",
    model: "beta-default",
    name: "Beta Default",
    thinkingLevels: Object.freeze(["off"] as const),
    default: true,
    allowsCustomModelIds: false,
  }),
  Object.freeze({
    provider: "gamma",
    providerName: "Gamma Env",
    model: "gamma-default",
    name: "Gamma Default",
    thinkingLevels: Object.freeze(["off"] as const),
    default: true,
    allowsCustomModelIds: false,
  }),
] satisfies readonly TuiModelRoute[]);

function createHarness(statuses: Map<string, TuiProviderAuthStatus>) {
  const terminal = createTestTerminal();
  const tui = new TUI(terminal);
  tui.addChild(new Container());
  tui.start();
  const base = createInMemoryTestRuntime(agent);
  const disconnects: string[] = [];
  const runtime = Object.freeze({
    ...base,
    providerAuthStatus: async (provider: string) => {
      const status = statuses.get(provider);
      if (!status) throw new Error(`Missing status for ${provider}`);
      return status;
    },
    disconnectProvider: async (provider: string) => {
      disconnects.push(provider);
      const status = { provider, configured: false, source: "none" as const };
      statuses.set(provider, status);
      return status;
    },
  });
  const picker = createTuiProviderPickerOrchestration({
    runtime,
    routes: () => routes,
    tui,
    theme: createSelectTheme(false),
    colorEnabled: false,
    height: () => 30,
  });
  return { terminal, tui, picker, disconnects };
}

describe("provider picker", () => {
  test("chooses a provider directly without opening a model picker", async () => {
    const statuses = new Map<string, TuiProviderAuthStatus>([
      ["alpha", { provider: "alpha", configured: true, source: "oauth" }],
      ["beta", { provider: "beta", configured: false, source: "none" }],
      ["gamma", { provider: "gamma", configured: true, source: "environment" }],
    ]);
    const { terminal, tui, picker } = createHarness(statuses);

    const selected = picker.select({ currentProvider: "alpha" });
    await vi.waitFor(() => expect(terminal.output).toContain("connected · OAuth"));
    expect(terminal.output).toContain("manage providers");
    expect(terminal.output).not.toContain("SELECT MODEL");
    terminal.send("\u001b[B");
    terminal.type("\r");

    await expect(selected).resolves.toEqual({ provider: "beta", providerName: "Beta Key" });
    picker.dispose();
    tui.stop();
  });

  test("disconnects stored credentials only after d is pressed twice", async () => {
    const statuses = new Map<string, TuiProviderAuthStatus>([
      ["alpha", { provider: "alpha", configured: true, source: "oauth" }],
      ["beta", { provider: "beta", configured: false, source: "none" }],
      ["gamma", { provider: "gamma", configured: true, source: "environment" }],
    ]);
    const { terminal, tui, picker, disconnects } = createHarness(statuses);

    const selected = picker.select({ currentProvider: "alpha" });
    await vi.waitFor(() => expect(terminal.output).toContain("connected · OAuth"));
    terminal.type("d");
    await vi.waitFor(() => expect(terminal.output).toContain("d again to disconnect"));
    expect(disconnects).toEqual([]);
    terminal.type("d");
    await vi.waitFor(() => expect(disconnects).toEqual(["alpha"]));
    await vi.waitFor(() => expect(terminal.output).toContain("Alpha OAuth disconnected."));
    terminal.send("\u001b");

    await expect(selected).resolves.toBeUndefined();
    picker.dispose();
    tui.stop();
  });

  test("explains that environment-owned credentials cannot be disconnected", async () => {
    const statuses = new Map<string, TuiProviderAuthStatus>([
      ["alpha", { provider: "alpha", configured: true, source: "oauth" }],
      ["beta", { provider: "beta", configured: false, source: "none" }],
      ["gamma", { provider: "gamma", configured: true, source: "environment" }],
    ]);
    const { terminal, tui, picker, disconnects } = createHarness(statuses);

    const selected = picker.select({ currentProvider: "alpha" });
    await vi.waitFor(() => expect(terminal.output).toContain("connected · environment"));
    terminal.send("\u001b[B");
    terminal.send("\u001b[B");
    terminal.type("d");
    await vi.waitFor(() => expect(terminal.output).toContain("configured by the environment"));
    expect(disconnects).toEqual([]);
    terminal.send("\u001b");

    await expect(selected).resolves.toBeUndefined();
    picker.dispose();
    tui.stop();
  });
});
