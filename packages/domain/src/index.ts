import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CapabilityRevision, CapabilityRevisionRef } from "./research.ts";

// SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
export const SCHEMA_VERSION = 1 as const;
const ISO_DATE_TIME_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const PrincipalSchema = z.enum([
  "foreground",
  "subagent",
  "reflector",
  "evaluator",
  "promoter",
  "scheduler",
  "system",
]);
export type Principal = z.infer<typeof PrincipalSchema>;
export type TrailStatus = "idle" | "running" | "aborted" | "failed" | "completed";
export type ProposalKind = "memory" | "knowledge" | "workflow";
export type CapabilityStatus = "candidate" | "active" | "rejected" | "rolled_back";
export const EffectClassSchema = z.enum(["read", "write", "execute", "network", "promote", "schedule"]);
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

export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
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

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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

// BOUNDARY: Canonical serialization deliberately accepts any JavaScript value and recursively
// normalizes it into deterministic JSON text.
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

export function capabilityRevisionDigest(revision: CapabilityRevision): string {
  return sha256(canonicalJson(revision));
}

export function capabilityRevisionRef(revision: CapabilityRevision): CapabilityRevisionRef {
  return Object.freeze({
    kind: "capability_revision",
    capabilityId: revision.capabilityId,
    capabilityRevisionId: revision.capabilityRevisionId,
    bundleDigest: capabilityRevisionDigest(revision),
  });
}

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

export const StableEffectOperationIdentitySchema = z.strictObject({
  operationId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  principal: PrincipalSchema,
  effect: EffectClassSchema,
  resource: z.string().min(1),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type StableEffectOperationIdentity = Readonly<z.infer<typeof StableEffectOperationIdentitySchema>>;

export const StableEffectOperationAttemptSchema = z.strictObject({
  identity: StableEffectOperationIdentitySchema,
  estimatedCost: z.number().nonnegative(),
  attempt: z.number().int().positive(),
});
export type StableEffectOperationAttempt = Readonly<z.infer<typeof StableEffectOperationAttemptSchema>>;

export function effectOperationFingerprint(identity: StableEffectOperationIdentity): string {
  return sha256(
    canonicalJson({
      operationId: identity.operationId,
      idempotencyKey: identity.idempotencyKey,
      principal: identity.principal,
      effect: identity.effect,
      resource: identity.resource,
      requestDigest: identity.requestDigest,
    }),
  );
}

export * from "./research.ts";
export * from "./object-builder.ts";
export * from "./storage-schemas.ts";
export * from "./workspace.ts";
