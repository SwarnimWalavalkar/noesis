import { appendFile, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { eventChecksum } from "@noesis/domain";
import {
  createArtifactStore,
  createExperienceLedger,
  TRAIL_PICKER_LIMIT,
  type DurableArtifactWriter,
} from "../src/index.ts";

describe("experience ledger", () => {
  test("replays an existing schema-v1 JSONL event without a migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-ledger-v1-compatibility-"));
    const ledger = createExperienceLedger(root);
    await ledger.initialize();
    const unsigned = {
      schemaVersion: 1,
      eventId: "evt-existing-v1",
      sequence: 1,
      occurredAt: "2026-01-01T00:00:00.000Z",
      principal: "system",
      type: "projection.rebuilt",
      payload: { source: "pre-zod-jsonl" },
      previousChecksum: null,
    } as const;
    const existingEvent = { ...unsigned, checksum: eventChecksum(unsigned) };
    await writeFile(ledger.paths.journal, `${JSON.stringify(existingEvent)}\n`);

    const replayed = createExperienceLedger(root);
    await expect(replayed.initialize()).resolves.toMatchObject({ events: 1, truncatedBytes: 0 });
    expect(replayed.readAll()).toEqual([existingEvent]);
  });

  test("replays an intact checksum chain and truncates only a partial tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-ledger-"));
    const ledger = createExperienceLedger(root);
    await ledger.initialize();
    await ledger.append({
      type: "trail.started",
      principal: "foreground",
      trailId: "trail-1",
      payload: { title: "test", provider: "fake", model: "fake", runtime: "fake" },
    });
    await ledger.append({
      type: "turn.started",
      principal: "foreground",
      trailId: "trail-1",
      payload: { input: "hello" },
    });
    await appendFile(ledger.paths.journal, '{"incomplete":');

    const recovered = createExperienceLedger(root);
    const report = await recovered.initialize();

    expect(report.events).toBe(2);
    expect(report.truncatedBytes).toBeGreaterThan(0);
    expect(recovered.readAll()).toEqual(ledger.readAll());
    expect(await readFile(ledger.paths.journal, "utf8")).toMatch(/\n$/);
  });

  test("serializes concurrent appends into one checksum chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-ledger-concurrent-"));
    const ledger = createExperienceLedger(root);
    await ledger.initialize();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        ledger.append({ type: "proposal.created", principal: "reflector", payload: { index } }),
      ),
    );
    expect(ledger.readAll().map((event) => event.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    const replayed = createExperienceLedger(root);
    await expect(replayed.initialize()).resolves.toMatchObject({ events: 20, truncatedBytes: 0 });
  });

  test("preserves a complete checksum-valid final event when only its newline is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-ledger-newline-"));
    const ledger = createExperienceLedger(root);
    await ledger.initialize();
    await ledger.append({ type: "proposal.created", principal: "reflector", payload: { valid: true } });
    const source = await readFile(ledger.paths.journal, "utf8");
    await writeFile(ledger.paths.journal, source.slice(0, -1));
    const recovered = createExperienceLedger(root);
    const report = await recovered.initialize();
    expect(report).toMatchObject({ events: 1, truncatedBytes: 0 });
    expect(await readFile(ledger.paths.journal, "utf8")).toMatch(/\n$/);
  });

  test("rejects a parseable newline-less event with a corrupt checksum", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-ledger-corrupt-tail-"));
    const ledger = createExperienceLedger(root);
    await ledger.initialize();
    await ledger.append({ type: "proposal.created", principal: "reflector", payload: { valid: true } });
    const event = JSON.parse((await readFile(ledger.paths.journal, "utf8")).trim()) as Record<
      string,
      unknown
    >;
    event["checksum"] = "0".repeat(64);
    await writeFile(ledger.paths.journal, JSON.stringify(event));
    await expect(createExperienceLedger(root).initialize()).rejects.toThrow("Checksum mismatch");
  });

  test("does not append artifact lineage before durable byte persistence finishes", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-artifact-order-"));
    const ledger = createExperienceLedger(root);
    await ledger.initialize();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer: DurableArtifactWriter = {
      async syncDirectory() {},
      async persist() {
        await blocked;
      },
    };
    const pending = createArtifactStore(ledger, writer).put("bytes", "text/plain");
    await Promise.resolve();
    expect(ledger.findByType("artifact.stored")).toHaveLength(0);
    release?.();
    await pending;
    expect(ledger.findByType("artifact.stored")).toHaveLength(1);
  });

  test("isolates mutable replay state between independent ledger factories", async () => {
    const first = createExperienceLedger(await mkdtemp(join(tmpdir(), "noesis-ledger-first-")));
    const second = createExperienceLedger(await mkdtemp(join(tmpdir(), "noesis-ledger-second-")));
    await Promise.all([first.initialize(), second.initialize()]);

    await first.append({ type: "proposal.created", principal: "reflector", payload: { owner: "first" } });

    expect(first.readAll()).toHaveLength(1);
    expect(second.readAll()).toEqual([]);
  });

  test("derives the bounded trail index from JSONL when the SQLite projection is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-ledger-trail-fallback-"));
    const ledger = createExperienceLedger(root);
    await ledger.initialize();
    await ledger.append({
      type: "trail.started",
      principal: "foreground",
      trailId: "trail-fallback",
      payload: { title: "fallback", provider: "fake", model: "model", runtime: "fake" },
    });
    await ledger.append({
      type: "turn.completed",
      principal: "foreground",
      trailId: "trail-fallback",
      payload: { input: "preview from JSONL", output: "done" },
    });
    await unlink(ledger.paths.projection);

    expect(ledger.listTrailProjections()).toEqual([
      expect.objectContaining({
        trailId: "trail-fallback",
        preview: "preview from JSONL",
        turnCount: 1,
      }),
    ]);
  });

  test("atomically replaces invalid SQLite bytes from authoritative JSONL", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-ledger-corrupt-projection-"));
    const ledger = createExperienceLedger(root);
    await ledger.initialize();
    await ledger.append({
      type: "trail.started",
      principal: "foreground",
      trailId: "trail-authoritative",
      payload: { title: "authoritative", provider: "fake", model: "model", runtime: "fake" },
    });
    const authoritativeJournal = await readFile(ledger.paths.journal, "utf8");
    await writeFile(ledger.paths.projection, Uint8Array.from([0, 1, 2, 3, 255]));

    const reopened = createExperienceLedger(root);
    await expect(reopened.initialize()).resolves.toMatchObject({ events: 1, truncatedBytes: 0 });
    expect(await readFile(reopened.paths.journal, "utf8")).toBe(authoritativeJournal);
    expect(reopened.listTrailProjections()).toEqual([
      expect.objectContaining({ trailId: "trail-authoritative", title: "authoritative" }),
    ]);
    const projection = new DatabaseSync(reopened.paths.projection, { readOnly: true });
    try {
      expect(projection.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      projection.close();
    }
  });

  test("falls back to JSONL when decodable SQLite omits an authoritative trail", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-ledger-stale-projection-"));
    const ledger = createExperienceLedger(root);
    await ledger.initialize();
    for (const trailId of ["trail-older", "trail-newer"]) {
      await ledger.append({
        type: "trail.started",
        principal: "foreground",
        trailId,
        payload: { title: trailId, provider: "fake", model: "model", runtime: "fake" },
      });
    }
    const projection = new DatabaseSync(ledger.paths.projection);
    try {
      projection.prepare("DELETE FROM trails WHERE trail_id = ?").run("trail-newer");
    } finally {
      projection.close();
    }

    expect(ledger.listTrailProjections().map((trail) => trail.trailId)).toEqual([
      "trail-newer",
      "trail-older",
    ]);
  });

  test("falls back to JSONL when SQLite would select the wrong latest trail", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-ledger-stale-order-"));
    let instant = Date.parse("2026-01-01T00:00:00.000Z");
    const ledger = createExperienceLedger(root, { now: () => new Date(instant++) });
    await ledger.initialize();
    for (const trailId of ["trail-older", "trail-authoritative-latest"]) {
      await ledger.append({
        type: "trail.started",
        principal: "foreground",
        trailId,
        payload: { title: trailId, provider: "fake", model: "model", runtime: "fake" },
      });
    }
    const projection = new DatabaseSync(ledger.paths.projection);
    try {
      projection
        .prepare("UPDATE trails SET updated_at = ? WHERE trail_id = ?")
        .run("2099-01-01T00:00:00.000Z", "trail-older");
    } finally {
      projection.close();
    }

    expect(ledger.listTrailProjections().map((trail) => trail.trailId)).toEqual([
      "trail-authoritative-latest",
      "trail-older",
    ]);
  });

  test("uses full trail ID ascending as the stable equal-activity tie-break", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-ledger-trail-tie-"));
    const ledger = createExperienceLedger(root, {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    await ledger.initialize();
    for (const trailId of ["trail-z", "trail-a", "trail-m"]) {
      await ledger.append({
        type: "trail.started",
        principal: "foreground",
        trailId,
        payload: { title: trailId, provider: "fake", model: "model", runtime: "fake" },
      });
    }

    expect(ledger.listTrailProjections().map((trail) => trail.trailId)).toEqual([
      "trail-a",
      "trail-m",
      "trail-z",
    ]);
  });

  test("caps SQLite and JSONL picker indexes to the same newest trails", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-ledger-picker-cap-"));
    let instant = Date.parse("2026-01-01T00:00:00.000Z");
    const ledger = createExperienceLedger(root, { now: () => new Date(instant++) });
    await ledger.initialize();
    const trailIds = Array.from(
      { length: TRAIL_PICKER_LIMIT + 3 },
      (_, index) => `trail-cap-${String(index).padStart(3, "0")}`,
    );
    for (const trailId of trailIds) {
      await ledger.append({
        type: "trail.started",
        principal: "foreground",
        trailId,
        payload: { title: trailId, provider: "fake", model: "model", runtime: "fake" },
      });
    }
    const expected = trailIds.slice(-TRAIL_PICKER_LIMIT).reverse();

    const sqlite = ledger.listTrailProjections();
    expect(sqlite).toHaveLength(TRAIL_PICKER_LIMIT);
    expect(sqlite.map((trail) => trail.trailId)).toEqual(expected);
    await unlink(ledger.paths.projection);
    const jsonl = ledger.listTrailProjections();
    expect(jsonl).toHaveLength(TRAIL_PICKER_LIMIT);
    expect(jsonl.map((trail) => trail.trailId)).toEqual(expected);
    expect(jsonl).toEqual(sqlite);
  }, 20_000);
});
