import { describe, expect, test } from "vitest";
import { GrantSchema, LedgerEventSchema, assertLedgerEvent, toJsonValue } from "../src/index.ts";

const ledgerEvent = {
  schemaVersion: 1,
  eventId: "evt-1",
  sequence: 1,
  occurredAt: "2026-01-01T00:00:00.000Z",
  principal: "system",
  type: "projection.rebuilt",
  payload: { nested: [null, true, 1, "value", { durable: true }] },
  previousChecksum: null,
  checksum: "a".repeat(64),
} as const;

describe("domain Zod schemas", () => {
  test("accepts the durable event shape and rejects unknown top-level keys with a JSON-pointer path", () => {
    expect(LedgerEventSchema.parse(ledgerEvent)).toEqual(ledgerEvent);
    expect(() => assertLedgerEvent({ ...ledgerEvent, unexpected: true })).toThrow("/unexpected");
  });

  test("preserves grant constraints and strict unknown-key rejection", () => {
    const grant = {
      schemaVersion: 1,
      grantId: "grant-1",
      principal: "foreground",
      effects: ["read"],
      resourcePrefixes: ["workspace:"],
      expiresAt: "2026-01-01T00:00:00.000Z",
      maxUses: 1,
      maxCost: 0,
    } as const;
    expect(GrantSchema.safeParse(grant).success).toBe(true);
    expect(GrantSchema.safeParse({ ...grant, maxUses: 0 }).success).toBe(false);
    expect(GrantSchema.safeParse({ ...grant, unexpected: true }).success).toBe(false);
  });

  test("accepts recursive JSON and rejects non-JSON values", () => {
    expect(toJsonValue({ values: [null, true, 1, "text"] })).toEqual({
      values: [null, true, 1, "text"],
    });
    expect(() => toJsonValue({ value: undefined })).toThrow();
    expect(() => toJsonValue(Number.POSITIVE_INFINITY)).toThrow();
  });
});
