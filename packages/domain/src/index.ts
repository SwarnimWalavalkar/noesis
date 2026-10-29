import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CapabilityRevision, CapabilityRevisionRef } from "./research.ts";

// SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
const SCHEMA_VERSION = 1 as const;
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
export const EffectClassSchema = z.enum(["read", "write", "execute", "network", "promote", "schedule"]);
export type EffectClass = z.infer<typeof EffectClassSchema>;

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
/**
 * The skill name under which a `relevant` Capability's instructions are offered to the model.
 * The suffix comes from the stable Capability ID, so a renamed Capability still matches.
 */
export function learnedCapabilitySkillName(capabilityId: string, name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 40)
    .replace(/-+$/u, "");
  return `learned-${slug.length > 0 ? `${slug}-` : ""}${learnedCapabilitySkillSuffix(capabilityId)}`;
}

/** The part of a learned Capability skill name that identifies its Capability. */
export function learnedCapabilitySkillSuffix(capabilityId: string): string {
  return sha256(capabilityId).slice(0, 6);
}

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

export function assertGrant(value: unknown): asserts value is Grant {
  if (!GrantSchema.safeParse(value).success) throw new Error("Invalid grant schema");
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

export * from "./attachments.ts";
export * from "./json-schema-signature.ts";
export * from "./capability-document.ts";
