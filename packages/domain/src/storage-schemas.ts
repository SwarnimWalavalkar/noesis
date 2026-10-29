import { z } from "zod";
import type { Capability, ProjectRef } from "./research.ts";
import { DATABASE_TABLES } from "./research.ts";

const ContentDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const StoredPathSchema = z.string().min(1);
const WindowsDrivePathPattern = /^[a-z]:/iu;
const WorkspaceContainedStoredPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("\\") &&
      !WindowsDrivePathPattern.test(value) &&
      !value.includes("\0") &&
      !value.split(/[\\/]/u).includes(".."),
    "Stored paths must be relative and remain within the workspace",
  );

export const DatabaseRowRefSchema = z.strictObject({
  kind: z.literal("database_row"),
  table: z.enum(DATABASE_TABLES),
  rowId: z.string().min(1),
});

export const databaseRowRefSchema = <Table extends (typeof DATABASE_TABLES)[number]>(table: Table) =>
  z.strictObject({
    kind: z.literal("database_row"),
    table: z.literal(table),
    rowId: z.string().min(1),
  });

export const FileRevisionRefSchema = z.strictObject({
  kind: z.literal("file_revision"),
  revisionId: z.string().min(1),
  workingPath: StoredPathSchema,
  snapshotPath: StoredPathSchema,
  contentDigest: ContentDigestSchema,
});

const EvidenceRevisionRefFields = {
  kind: z.literal("evidence_revision"),
  revisionId: z.string().min(1),
  workingPath: StoredPathSchema,
  snapshotPath: StoredPathSchema,
  contentDigest: ContentDigestSchema,
};

export const EvidenceRevisionRefSchema = z.strictObject({
  ...EvidenceRevisionRefFields,
  evidenceKind: z.enum(["input", "output", "tool_trace", "judgment", "report"]),
});

export const evidenceRevisionRefSchema = <
  Kind extends "input" | "output" | "tool_trace" | "judgment" | "report",
>(
  evidenceKind: Kind,
) =>
  z.strictObject({
    ...EvidenceRevisionRefFields,
    evidenceKind: z.literal(evidenceKind),
  });

export const ArtifactFileRefSchema = z.strictObject({
  kind: z.literal("artifact_file"),
  artifactId: z.string().min(1),
  path: WorkspaceContainedStoredPathSchema,
  mediaType: z.string().min(1),
});

export const EvidenceRefSchema = z.discriminatedUnion("kind", [
  DatabaseRowRefSchema,
  FileRevisionRefSchema,
  EvidenceRevisionRefSchema,
  ArtifactFileRefSchema,
]);

export const ProjectRefSchema = z.strictObject({
  projectId: z.string().min(1),
  root: z.string().min(1),
}) satisfies z.ZodType<ProjectRef>;

export const CapabilityRevisionRefSchema = z.strictObject({
  kind: z.literal("capability_revision"),
  capabilityId: z.string().min(1),
  capabilityRevisionId: z.string().min(1),
  bundleDigest: ContentDigestSchema,
});

const PermissionManifestSchema = z.strictObject({
  effects: z.array(z.string()),
  resourcePatterns: z.array(z.string()),
  credentialRefs: z.array(z.string()),
});

const PermissionDeltaSchema = z.strictObject({
  addedEffects: z.array(z.string()),
  widenedResources: z.array(z.string()),
  addedCredentialRefs: z.array(z.string()),
});

export const CapabilitySchema = z.strictObject({
  capabilityId: z.string().min(1),
  name: z.string().min(1),
  scope: z.string().min(1),
  intent: z.string().min(1),
}) satisfies z.ZodType<Capability>;

const CapabilityProgramNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);

export const CapabilityEffectSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("instruction"),
    material: FileRevisionRefSchema,
  }),
  z.strictObject({
    kind: z.literal("skill"),
    name: CapabilityProgramNameSchema,
    description: z.string().min(1).max(2_048),
    material: FileRevisionRefSchema,
  }),
  z.strictObject({
    kind: z.literal("program"),
    program: z.strictObject({
      mode: z.enum(["script", "workflow"]),
      name: CapabilityProgramNameSchema,
      project: ProjectRefSchema,
      definitionRevision: FileRevisionRefSchema,
    }),
  }),
]);

export const CapabilityRevisionSchema = z.strictObject({
  capabilityRevisionId: z.string().min(1),
  capabilityId: z.string().min(1),
  predecessorRevisionId: z.string().min(1).optional(),
  effects: z.array(CapabilityEffectSchema).min(1).max(32).optional(),
  promptModules: z.array(FileRevisionRefSchema),
  skills: z.array(FileRevisionRefSchema),
  tools: z.array(FileRevisionRefSchema),
  toolset: z.strictObject({
    toolRevisionIds: z.array(z.string().min(1)),
    routerRevision: FileRevisionRefSchema,
    strategyId: z.string().min(1),
  }),
  activationPolicy: z.strictObject({
    mode: z.enum(["automatic_low_risk", "approval_required"]),
    scope: z.string().min(1),
  }),
  dependencyLock: FileRevisionRefSchema.optional(),
  permissionManifest: PermissionManifestSchema,
  evidenceRefs: z.array(EvidenceRefSchema),
  sourceEvaluationDefinitions: z.array(FileRevisionRefSchema),
  requestedPermissionDelta: PermissionDeltaSchema,
});

export const CapabilityKindSchema = z.enum([
  "instruction",
  "skill",
  "tool",
  "workflow",
  "router",
  "model_configuration",
  "harness_configuration",
  "core_update",
  "composite",
]);

export const CapabilityDefinitionSchema = z.strictObject({
  capabilityId: z.string().min(1),
  name: z.string().min(1),
  kind: CapabilityKindSchema.optional(),
  description: z.string().min(1),
  applicability: z.string().min(1),
  createdAt: z.string().datetime(),
});

/** What kind of evidence supports a learned Capability, stated by the model that authored it. */
export const CapabilityEvidenceClaimSchema = z.strictObject({
  kind: z.enum(["explicit_request", "user_correction", "repeated_across_sessions", "verified_method"]),
  quote: z.string().trim().min(1).max(1_000),
  wouldOtherwise: z.string().trim().min(1).max(1_000),
});

export const CapabilityLifecycleRevisionSchema = z.strictObject({
  revision: CapabilityRevisionSchema,
  reference: CapabilityRevisionRefSchema,
  summary: z.string().min(1),
  rationale: z.string().min(1),
  anticipatedEffect: z.string().min(1),
  evidence: CapabilityEvidenceClaimSchema.optional(),
  createdAt: z.string().datetime(),
});

export const CapabilityScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("project"), project: ProjectRefSchema }),
  z.strictObject({ kind: z.literal("session"), sessionId: z.string().min(1) }),
]);

export const CapabilityBindingSchema = z.strictObject({
  capabilityId: z.string().min(1),
  revision: CapabilityRevisionRefSchema,
  scope: CapabilityScopeSchema,
  activationMode: z.enum(["relevant", "always"]),
  state: z.enum(["active", "paused"]),
  revisionNumber: z.number().int().positive(),
  updatedAt: z.string().datetime(),
});

export const CapabilityFeedbackSchema = z
  .strictObject({
    feedbackId: z.string().min(1),
    capabilityId: z.string().min(1),
    revision: CapabilityRevisionRefSchema,
    evidenceRefs: z.array(EvidenceRefSchema).min(1).max(64),
    interpretation: z.string().min(1).max(8_192),
    disposition: z.enum([
      "positive",
      "correction",
      "regression",
      "scope_change",
      "activation_change",
      "restore_request",
    ]),
    createdAt: z.string().datetime(),
  })
  .refine((feedback) => feedback.capabilityId === feedback.revision.capabilityId, {
    message: "Capability feedback and revision identities must match",
    path: ["revision", "capabilityId"],
  });

export const CapabilityGateRequestSchema = z
  .strictObject({
    gateRequestId: z.string().min(1),
    capabilityId: z.string().min(1),
    revision: CapabilityRevisionRefSchema,
    expectedBindingRevision: z.number().int().positive(),
    proposedScope: CapabilityScopeSchema,
    proposedActivationMode: z.enum(["relevant", "always"]),
    consequence: z.string().min(1).max(8_192),
    status: z.enum(["pending", "approved", "denied", "superseded"]),
    instruction: z.string().min(1).max(8_192).optional(),
    createdAt: z.string().datetime(),
    settledAt: z.string().datetime().optional(),
  })
  .refine((gate) => gate.capabilityId === gate.revision.capabilityId, {
    message: "Capability gate and revision identities must match",
    path: ["revision", "capabilityId"],
  });
