import { describe, expect, test } from "vitest";
import {
  createTuiRoutePickerOverlay,
  type TuiModelRoute,
  type TuiRoutePickerSelection,
} from "../src/index.ts";

const routes = Object.freeze([
  Object.freeze({
    provider: "alpha",
    model: "alpha-current",
    name: "Alpha Current",
    thinkingLevels: Object.freeze(["off", "high"] as const),
    default: false,
    allowsCustomModelIds: false,
  }),
  Object.freeze({
    provider: "alpha",
    model: "alpha-second",
    name: "Second Alpha",
    thinkingLevels: Object.freeze(["off", "medium"] as const),
    default: true,
    allowsCustomModelIds: false,
  }),
  Object.freeze({
    provider: "beta",
    providerName: "Beta Cloud",
    model: "beta-model",
    name: "Beta Model",
    thinkingLevels: Object.freeze(["off"] as const),
    default: true,
    allowsCustomModelIds: false,
  }),
] satisfies readonly TuiModelRoute[]);

describe("route picker", () => {
  test("searches the current provider and selects the matching model", () => {
    const selected: TuiRoutePickerSelection[] = [];
    const overlay = createTuiRoutePickerOverlay({
      routes,
      intent: {
        kind: "model",
        currentProvider: "alpha",
        currentModel: "alpha-current",
        currentThinkingLevel: "high",
      },
      colorEnabled: false,
      height: () => 30,
      requestRender: () => undefined,
      select: (route) => selected.push(route),
      cancel: () => undefined,
    });
    overlay.focused = true;

    expect(overlay.render(80).join("\n")).toContain("alpha-current  ✓ current");
    for (const character of "second") overlay.handleInput(character);
    const filtered = overlay.render(80).join("\n");
    expect(filtered).toContain("alpha-second");
    expect(filtered).not.toContain("alpha-current  ✓ current");
    overlay.handleInput("\r");
    expect(overlay.render(80).join("\n")).toContain("SELECT REASONING · alpha-second");
    overlay.handleInput("\r");

    expect(selected).toEqual([
      {
        route: expect.objectContaining({ provider: "alpha", model: "alpha-second" }),
        thinkingLevel: "medium",
      },
    ]);
  });

  test("keeps the cache consequence visible at ordinary terminal widths", () => {
    const overlay = createTuiRoutePickerOverlay({
      routes,
      intent: {
        kind: "model",
        currentProvider: "alpha",
        currentModel: "alpha-current",
        currentThinkingLevel: "high",
      },
      colorEnabled: false,
      height: () => 24,
      requestRender: () => undefined,
      select: () => undefined,
      cancel: () => undefined,
    });

    expect(overlay.render(80).join("\n")).toContain(
      "New empty session · previous preserved · history not replayed",
    );
  });

  test("changes reasoning for the current model without claiming a new session", () => {
    const selected: TuiRoutePickerSelection[] = [];
    const overlay = createTuiRoutePickerOverlay({
      routes,
      intent: {
        kind: "model",
        currentProvider: "alpha",
        currentModel: "alpha-current",
        currentThinkingLevel: "high",
      },
      colorEnabled: false,
      height: () => 24,
      requestRender: () => undefined,
      select: (selection) => selected.push(selection),
      cancel: () => undefined,
    });
    overlay.focused = true;

    overlay.handleInput("\r");
    const reasoning = overlay.render(80).join("\n");
    expect(reasoning).toContain("SELECT REASONING · alpha-current");
    expect(reasoning).toContain("high  ✓ current");
    expect(reasoning).toContain("Reasoning updates current session · provider and model unchanged");
    overlay.handleInput("\u001b[A");
    overlay.handleInput("\r");

    expect(selected).toEqual([
      {
        route: expect.objectContaining({ model: "alpha-current" }),
        thinkingLevel: "off",
      },
    ]);
  });

  test("opens directly on reasoning and cancels without returning to models", () => {
    let cancelled = 0;
    const overlay = createTuiRoutePickerOverlay({
      routes,
      intent: {
        kind: "reasoning",
        currentProvider: "alpha",
        currentModel: "alpha-current",
        currentThinkingLevel: "high",
      },
      colorEnabled: false,
      height: () => 24,
      requestRender: () => undefined,
      select: () => undefined,
      cancel: () => {
        cancelled += 1;
      },
    });
    overlay.focused = true;

    const rendered = overlay.render(80).join("\n");
    expect(rendered).toContain("SELECT REASONING · alpha-current");
    expect(rendered).toContain("high  ✓ current");
    expect(rendered).toContain("Esc cancel");
    overlay.handleInput("\u001b");

    expect(cancelled).toBe(1);
  });

  test("updates an open picker from a refreshed catalog without losing its current route", () => {
    let renders = 0;
    const overlay = createTuiRoutePickerOverlay({
      routes,
      intent: {
        kind: "model",
        currentProvider: "alpha",
        currentModel: "alpha-current",
        currentThinkingLevel: "high",
      },
      colorEnabled: false,
      height: () => 24,
      requestRender: () => {
        renders += 1;
      },
      select: () => undefined,
      cancel: () => undefined,
    });

    overlay.updateRoutes(
      Object.freeze([
        ...routes,
        Object.freeze({
          provider: "alpha",
          model: "alpha-live",
          name: "Alpha Live",
          thinkingLevels: Object.freeze(["off", "xhigh"] as const),
          default: false,
          allowsCustomModelIds: false,
        }),
      ]),
    );

    const rendered = overlay.render(80).join("\n");
    expect(rendered).toContain("alpha-current  ✓ current");
    expect(rendered).toContain("alpha-live");
    expect(renders).toBe(1);
  });
});
