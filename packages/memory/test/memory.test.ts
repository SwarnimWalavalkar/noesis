import { mkdtemp, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createExperienceLedger } from "@noesis/ledger";
import { createMemoryRepository } from "../src/index.ts";

describe("typed memory", () => {
  test("retains provenance and supersession history while projecting active memory", async () => {
    const ledger = createExperienceLedger(await mkdtemp(join(tmpdir(), "noesis-memory-")));
    await ledger.initialize();
    const repository = createMemoryRepository(ledger);
    const first = await repository.record({
      kind: "preference",
      content: "Prefers terse reports",
      scope: "reports",
      evidence: [{ eventId: "evt-source", excerpt: "keep it short", confidence: 0.9 }],
    });
    const second = await repository.record({
      kind: "preference",
      content: "Prefers terse reports with evidence",
      scope: "reports",
      evidence: [{ eventId: "evt-correction", excerpt: "include sources", confidence: 1 }],
      supersedes: first.memoryId,
    });

    expect(repository.listActive()).toEqual([second]);
    expect(ledger.findByType("memory.superseded")).toHaveLength(1);
    expect(await readFile(join(ledger.paths.views, "memory.md"), "utf8")).toContain("evt-correction");
    await unlink(join(ledger.paths.views, "memory.md"));
    await ledger.rebuildProjection();
    const rebuilt = await readFile(join(ledger.paths.views, "memory.md"), "utf8");
    expect(rebuilt).toContain("evt-correction");
    expect(rebuilt).not.toContain("Prefers terse reports\n");
  });

  test("isolates independent repository closures", async () => {
    const firstLedger = createExperienceLedger(await mkdtemp(join(tmpdir(), "noesis-memory-first-")));
    const secondLedger = createExperienceLedger(await mkdtemp(join(tmpdir(), "noesis-memory-second-")));
    await Promise.all([firstLedger.initialize(), secondLedger.initialize()]);
    const first = createMemoryRepository(firstLedger);
    const second = createMemoryRepository(secondLedger);

    await first.record({
      kind: "claim",
      content: "first only",
      scope: "test",
      evidence: [{ eventId: "evt-first", excerpt: "first", confidence: 1 }],
    });

    expect(Object.isFrozen(first)).toBe(true);
    expect(first.listActive()).toHaveLength(1);
    expect(second.listActive()).toHaveLength(0);
  });

  test("preserves evidence extensions while enforcing confidence bounds during replay", async () => {
    const ledger = createExperienceLedger(await mkdtemp(join(tmpdir(), "noesis-memory-schema-")));
    await ledger.initialize();
    const repository = createMemoryRepository(ledger);
    await ledger.append({
      type: "memory.recorded",
      principal: "foreground",
      payload: {
        memoryId: "mem-valid",
        kind: "fact",
        content: "validated",
        scope: "test",
        evidence: [{ eventId: "evt-1", excerpt: "source", confidence: 1, source: "fixture" }],
      },
    });
    expect(repository.listActive()[0]?.evidence[0]).toMatchObject({ source: "fixture" });

    await ledger.append({
      type: "memory.recorded",
      principal: "foreground",
      payload: {
        memoryId: "mem-invalid",
        kind: "fact",
        content: "invalid",
        scope: "test",
        evidence: [{ eventId: "evt-2", excerpt: "source", confidence: 2 }],
      },
    });
    expect(() => repository.listActive()).toThrow();
  });
});
