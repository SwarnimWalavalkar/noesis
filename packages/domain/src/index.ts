import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;
const ISO_DATE_TIME_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

const PrincipalSchema = z.enum(["foreground", "reflector", "evaluator", "promoter", "scheduler", "system"]);
export type Principal = z.infer<typeof PrincipalSchema>;
export type TrailStatus = "idle" | "running" | "aborted" | "failed" | "completed";
export type ProposalKind = "memory" | "knowledge" | "workflow";
export type CapabilityStatus = "candidate" | "active" | "rejected" | "rolled_back";
const EffectClassSchema = z.enum(["read", "write", "execute", "network", "promote", "schedule"]);
export type EffectClass = z.infer<typeof EffectClassSchema>;

export const EventTypeSchema = z.enum([
  "trail.started",
  "trail.resumed",
  "trail.forked",
  "trail.steered",
  "trail.followed_up",
  "trail.aborted",
  "trail.compacted",
  "trail.recovered",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "artifact.stored",
  "proposal.created",
  "proposal.accepted",
  "proposal.rejected",
  "memory.recorded",
  "memory.superseded",
  "capability.candidate_created",
  "capability.evaluated",
  "capability.promoted",
  "capability.used",
  "capability.rolled_back",
  "authority.grant_issued",
  "effect.requested",
  "effect.reserved",
  "effect.denied",
  "effect.completed",
  "effect.failed",
  "job.scheduled",
  "job.lease_acquired",
  "job.heartbeat",
  "job.completed",
  "job.failed",
  "job.budget_exhausted",
  "projection.rebuilt",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export function toJsonValue(value: unknown): JsonValue {
  return JsonValueSchema.parse(value);
}

export const LedgerEventSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  eventId: z.string().min(1),
  sequence: z.number().int().min(1),
  occurredAt: z.string().regex(new RegExp(ISO_DATE_TIME_PATTERN)),
  principal: PrincipalSchema,
  type: EventTypeSchema,
  trailId: z.string().min(1).optional(),
  payload: z.record(z.string(), JsonValueSchema),
  previousChecksum: z.string().nullable(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});
export type LedgerEvent = Readonly<z.infer<typeof LedgerEventSchema>>;

export const GrantSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  grantId: z.string(),
  principal: PrincipalSchema,
  effects: z.array(EffectClassSchema),
  resourcePrefixes: z.array(z.string()),
  expiresAt: z.string().regex(new RegExp(ISO_DATE_TIME_PATTERN)),
  maxUses: z.number().int().min(1),
  maxCost: z.number().min(0),
});
export type Grant = Readonly<z.infer<typeof GrantSchema>>;

function issuePath(issue: z.ZodIssue): string {
  const path = [...issue.path];
  if (issue.code === "unrecognized_keys" && issue.keys[0] !== undefined) path.push(issue.keys[0]);
  return path.length === 0
    ? ""
    : `/${path.map((segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };
export const createId = (prefix: string): string => `${prefix}_${randomUUID()}`;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(Object.getOwnPropertyDescriptor(value, key)?.value)}`,
    )
    .join(",")}}`;
}

export const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export function assertLedgerEvent(value: unknown): asserts value is LedgerEvent {
  const parsed = LedgerEventSchema.safeParse(value);
  if (parsed.success) return;
  const first = parsed.error.issues[0];
  throw new Error(`Invalid ledger event${first ? ` at ${issuePath(first)}: ${first.message}` : ""}`);
}

export function assertGrant(value: unknown): asserts value is Grant {
  if (!GrantSchema.safeParse(value).success) throw new Error("Invalid grant schema");
}

export function eventChecksum(event: Omit<LedgerEvent, "checksum">): string {
  return sha256(canonicalJson(event));
}
