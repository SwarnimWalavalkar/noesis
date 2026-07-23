import {
  canonicalJson,
  createId,
  sha256,
  toJsonValue,
  type EffectClass,
  type JsonValue,
} from "@noesis/domain";
import { LedgerConflictError, type ExperienceLedger } from "@noesis/ledger";
import type { AuthorityReceipt, AuthorityReceiptVerifier } from "@noesis/policy";
import { z } from "zod";

export * from "./atomic.ts";

export interface PermissionManifest {
  readonly effects: readonly EffectClass[];
  readonly resourcePrefixes: readonly string[];
  readonly maxCostPerRun: number;
}

export interface RegressionCase {
  readonly caseId: string;
  readonly source: "source" | "held-out";
  readonly input: string;
  readonly expectedIncludes: readonly string[];
  readonly baselineScore: number;
}

const CandidateSkillSchema = z.strictObject({
  schemaVersion: z.literal(1),
  capabilityId: z.string(),
  version: z.number().int().min(1),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  evidenceEventIds: z.array(z.string()),
  manifest: z
    .object({
      effects: z.array(z.enum(["read", "write", "execute", "network", "promote", "schedule"])),
      resourcePrefixes: z.array(z.string()),
      maxCostPerRun: z.number().min(0),
    })
    .passthrough(),
  cases: z.array(
    z
      .object({
        caseId: z.string(),
        source: z.literal("source"),
        input: z.string(),
        expectedIncludes: z.array(z.string()),
        baselineScore: z.number().min(0).max(1),
      })
      .passthrough(),
  ),
});
export interface CandidateSkill {
  readonly schemaVersion: 1;
  readonly capabilityId: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly evidenceEventIds: readonly string[];
  readonly manifest: PermissionManifest;
  readonly cases: readonly (RegressionCase & { readonly source: "source" })[];
}

export interface CapabilityVersion extends CandidateSkill {
  readonly status: "candidate" | "active" | "rejected" | "rolled_back";
  readonly score?: number;
  readonly candidateDigest?: string;
  readonly suiteId?: string;
  readonly suiteDigest?: string;
}

function readCandidate(payload: Readonly<Record<string, JsonValue>>): CandidateSkill | undefined {
  const candidate = payload["candidate"];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  return CandidateSkillSchema.parse(candidate);
}

export const candidateDigest = (candidate: CandidateSkill): string =>
  sha256(
    canonicalJson({
      schemaVersion: candidate.schemaVersion,
      capabilityId: candidate.capabilityId,
      version: candidate.version,
      name: candidate.name,
      description: candidate.description,
      instructions: candidate.instructions,
      evidenceEventIds: candidate.evidenceEventIds,
      manifest: candidate.manifest,
      cases: candidate.cases,
    }),
  );

export interface PromotionPolicy {
  readonly suiteId: string;
  readonly suiteDigest: string;
}

export type CandidateSkillInput = Omit<CandidateSkill, "schemaVersion" | "capabilityId" | "version"> & {
  readonly capabilityId?: string;
};

export interface CapabilityRegistry {
  readonly createCandidate: (input: CandidateSkillInput) => Promise<CandidateSkill>;
  readonly getCandidate: (capabilityId: string, version: number) => CandidateSkill | undefined;
  readonly getVersions: (capabilityId: string) => readonly CapabilityVersion[];
  readonly listActive: () => readonly CapabilityVersion[];
  readonly activeVersions: () => Readonly<Record<string, number>>;
  readonly promote: (capabilityId: string, version: number, receipt: AuthorityReceipt) => Promise<void>;
  readonly recordUse: (
    capabilityId: string,
    version: number,
    trailId: string,
    outcome: string,
  ) => Promise<void>;
  readonly rollback: (
    capabilityId: string,
    version: number,
    reason: string,
    receipt: AuthorityReceipt,
  ) => Promise<void>;
}

export function createCapabilityRegistry(
  ledger: ExperienceLedger,
  promotionPolicy?: PromotionPolicy,
  authority?: AuthorityReceiptVerifier,
): CapabilityRegistry {
  const getCandidate = (capabilityId: string, version: number): CandidateSkill | undefined =>
    ledger
      .findByType("capability.candidate_created")
      .map((event) => readCandidate(event.payload))
      .find((candidate) => candidate?.capabilityId === capabilityId && candidate.version === version);

  const getVersions = (capabilityId: string): readonly CapabilityVersion[] => {
    const versions = new Map<number, CapabilityVersion>();
    for (const event of ledger.readAll()) {
      const candidate =
        event.type === "capability.candidate_created" ? readCandidate(event.payload) : undefined;
      if (candidate?.capabilityId === capabilityId)
        versions.set(candidate.version, { ...candidate, status: "candidate" });
      if (String(event.payload["capabilityId"]) !== capabilityId) continue;
      const version = Number(event.payload["version"]);
      const current = versions.get(version);
      if (!current) continue;
      if (event.type === "capability.evaluated") {
        const digest = candidateDigest(current);
        const evaluationMatches =
          event.payload["candidateDigest"] === digest &&
          event.payload["suiteId"] === promotionPolicy?.suiteId &&
          event.payload["suiteDigest"] === promotionPolicy?.suiteDigest;
        versions.set(version, {
          ...current,
          status: event.payload["passed"] === true && evaluationMatches ? "candidate" : "rejected",
          score: Number(event.payload["score"]),
          candidateDigest: String(event.payload["candidateDigest"] ?? ""),
          suiteId: String(event.payload["suiteId"] ?? ""),
          suiteDigest: String(event.payload["suiteDigest"] ?? ""),
        });
      } else if (event.type === "capability.promoted") {
        versions.set(version, { ...current, status: "active" });
      } else if (event.type === "capability.rolled_back") {
        versions.set(version, { ...current, status: "rolled_back" });
      }
    }
    return [...versions.values()].sort((left, right) => left.version - right.version);
  };

  const createCandidate = async (input: CandidateSkillInput): Promise<CandidateSkill> => {
    const capabilityId = input.capabilityId ?? createId("cap");
    for (;;) {
      const expectedSequence = ledger.readAll().length;
      const existing = getVersions(capabilityId);
      const candidate: CandidateSkill = {
        schemaVersion: 1,
        capabilityId,
        version: Math.max(0, ...existing.map((version) => version.version)) + 1,
        name: input.name,
        description: input.description,
        instructions: input.instructions,
        evidenceEventIds: [...input.evidenceEventIds],
        manifest: input.manifest,
        cases: [...input.cases],
      };
      try {
        await ledger.append(
          {
            type: "capability.candidate_created",
            principal: "reflector",
            payload: {
              capabilityId: candidate.capabilityId,
              version: candidate.version,
              name: candidate.name,
              manifest: toJsonValue(candidate.manifest),
              candidate: toJsonValue(candidate),
              candidateDigest: candidateDigest(candidate),
            },
          },
          expectedSequence,
        );
        return candidate;
      } catch (error) {
        if (error instanceof LedgerConflictError) continue;
        throw error;
      }
    }
  };

  const listActive = (): readonly CapabilityVersion[] => {
    const ids = new Set(
      ledger.findByType("capability.candidate_created").map((event) => String(event.payload["capabilityId"])),
    );
    return [...ids].flatMap((id) => getVersions(id)).filter((version) => version.status === "active");
  };

  const activeVersions = (): Readonly<Record<string, number>> =>
    Object.fromEntries(listActive().map((capability) => [capability.name, capability.version]));

  const promote = async (capabilityId: string, version: number, receipt: AuthorityReceipt): Promise<void> => {
    const resource = `capability:${capabilityId}@${version}:promote`;
    if (!authority?.isReceipt(receipt, "promote", resource, ledger))
      throw new Error("Promotion requires authority");
    const candidate = getVersions(capabilityId).find((item) => item.version === version);
    if (
      !candidate ||
      candidate.status !== "candidate" ||
      candidate.score === undefined ||
      candidate.candidateDigest !== candidateDigest(candidate) ||
      candidate.suiteId !== promotionPolicy?.suiteId ||
      candidate.suiteDigest !== promotionPolicy?.suiteDigest
    )
      throw new Error("Only digest-bound candidates passing the protected suite can be promoted");
    for (const active of getVersions(capabilityId).filter((item) => item.status === "active"))
      await ledger.append({
        type: "capability.rolled_back",
        principal: "promoter",
        payload: {
          capabilityId,
          version: active.version,
          reason: "superseded",
          authorityResource: resource,
        },
      });
    await ledger.append({
      type: "capability.promoted",
      principal: "promoter",
      payload: {
        capabilityId,
        version,
        score: candidate.score,
        candidateDigest: candidate.candidateDigest,
        suiteId: String(candidate.suiteId),
        suiteDigest: String(candidate.suiteDigest),
        authorityResource: resource,
      },
    });
  };

  const recordUse = async (
    capabilityId: string,
    version: number,
    trailId: string,
    outcome: string,
  ): Promise<void> => {
    const candidate = getVersions(capabilityId).find((item) => item.version === version);
    if (!candidate || candidate.status !== "active") throw new Error("Capability version is not active");
    await ledger.append({
      type: "capability.used",
      principal: "foreground",
      trailId,
      payload: { capabilityId, version, outcome },
    });
  };

  const rollback = async (
    capabilityId: string,
    version: number,
    reason: string,
    receipt: AuthorityReceipt,
  ): Promise<void> => {
    const resource = `capability:${capabilityId}@${version}:rollback`;
    if (!authority?.isReceipt(receipt, "promote", resource, ledger))
      throw new Error("Rollback requires authority");
    const candidate = getVersions(capabilityId).find((item) => item.version === version);
    if (!candidate || candidate.status !== "active")
      throw new Error("Only active capabilities can be rolled back");
    await ledger.append({
      type: "capability.rolled_back",
      principal: "promoter",
      payload: { capabilityId, version, reason, authorityResource: resource },
    });
  };

  return Object.freeze({
    createCandidate,
    getCandidate,
    getVersions,
    listActive,
    activeVersions,
    promote,
    recordUse,
    rollback,
  });
}
