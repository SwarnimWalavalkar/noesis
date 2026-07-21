import { describe, expect, test } from "vitest";
import { compileContext, decodeContextSnapshot } from "../src/index.ts";

describe("context compiler", () => {
  test("hard-bounds every fragment and the whole snapshot with provenance", () => {
    const snapshot = compileContext(
      [
        { id: "high", kind: "system", content: "a".repeat(1_000), provenance: ["protected"], priority: 100 },
        { id: "low", kind: "memory", content: "b".repeat(1_000), provenance: ["evt-1"], priority: 1 },
      ],
      { research: 3 },
      { maxTokens: 100, maxFragmentTokens: 60, now: new Date("2026-01-01T00:00:00.000Z") },
    );

    expect(snapshot.usedTokens).toBeLessThanOrEqual(100);
    expect(snapshot.fragments.every((fragment) => fragment.tokens <= 60)).toBe(true);
    expect(snapshot.fragments[0]?.provenance).toEqual(["protected"]);
    expect(snapshot.capabilityVersions).toEqual({ research: 3 });
  });

  test("strictly validates durable snapshots without changing schema v1", () => {
    const snapshot = compileContext(
      [{ id: "one", kind: "trail", content: "context", provenance: ["evt-1"], priority: 1 }],
      { research: 1 },
      { maxTokens: 10, maxFragmentTokens: 10, now: new Date("2026-01-01T00:00:00.000Z") },
    );

    expect(decodeContextSnapshot(snapshot)).toEqual(snapshot);
    expect(decodeContextSnapshot({ ...snapshot, unexpected: true })).toBeUndefined();
    expect(
      decodeContextSnapshot({
        ...snapshot,
        fragments: [{ ...snapshot.fragments[0], unexpected: true }],
      }),
    ).toBeUndefined();
    expect(decodeContextSnapshot({ ...snapshot, capabilityVersions: { research: 0 } })).toBeUndefined();
  });
});
