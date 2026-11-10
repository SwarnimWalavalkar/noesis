import {
  capabilityDocumentInFolderFormat,
  capabilityFolderDigest,
  type CapabilityFolder,
  isCapabilityFolderPath,
  type ActorRef,
  type CapabilityActivationMode,
  type CapabilityBinding,
  type CapabilityDefinition,
  type CapabilityEffect,
  type CapabilityFeedback,
  type CapabilityLifecycleRevision,
  type CapabilityRevision,
  type CapabilityScope,
  CapabilityEvidenceClaimSchema,
  capabilityEvidenceLabel,
  canonicalJson,
  createConditionalObject,
  createId,
  type EvidenceRef,
  type FileRevisionRef,
  type ProjectRef,
  capabilityGuidance,
  capabilityRevisionRef,
  learnedCapabilitySkillName,
  parseCapabilityDocument,
  renderCapabilityDocument,
  sha256,
  validateCapabilityEffects,
} from "@noesis/domain";
import type { CapabilityLifecycleStore, NoesisWorkspaceStore } from "@noesis/workspace";
import { z } from "zod";

export const CapabilityScopeDecisionSchema = z.enum(["global", "current_project", "current_session"]);

export const CapabilityConsequenceSchema = z.enum([
  "ordinary",
  "recovery_control",
  "credential_export",
  "irreversible_external",
]);

export const CapabilityEffectDraftSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("instruction"),
    content: z.string().trim().min(1).max(12_000),
  }),
  z.strictObject({
    kind: z.literal("program"),
    mode: z.enum(["script", "workflow"]),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    /** Which library owns the Program. Omitted means the project one first, then the global one. */
    scope: z.enum(["project", "global"]).optional(),
  }),
]);

/** The complete behavior-bearing proposal authored by either reflection or the foreground agent. */
export const CapabilityProposalSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(160),
    // The standard skill format allows 1,024 characters here, and a Capability folder is a skill.
    description: z.string().trim().min(1).max(1_024),
    applicability: z.string().trim().min(1).max(2_048),
    summary: z.string().trim().min(1).max(2_048),
    rationale: z.string().trim().min(1).max(4_096),
    anticipatedEffect: z.string().trim().min(1).max(2_048),
    effects: z.array(CapabilityEffectDraftSchema).min(1).max(8),
    scope: CapabilityScopeDecisionSchema.optional(),
    activationMode: z.enum(["relevant", "always"]).optional(),
    consequence: CapabilityConsequenceSchema,
    consequenceDescription: z.string().trim().min(1).max(2_048),
    evidence: CapabilityEvidenceClaimSchema.optional(),
  })
  .superRefine((proposal, context) => {
    if (proposal.effects.filter((effect) => effect.kind === "program").length <= 1) return;
    context.addIssue({
      code: "custom",
      path: ["effects"],
      message: "A Capability may attach at most one Program effect",
    });
  });

export type CapabilityProposal = Readonly<z.infer<typeof CapabilityProposalSchema>>;

const ExistingCapabilityDecisionFields = {
  capabilityId: z.string().trim().min(1),
  expectedBindingRevision: z.number().int().positive(),
};

/**
 * One complete semantic decision. The protected publisher supplies identity, evidence resolution,
 * immutable recording, stale-write detection, gating, and rollback lineage; it does not reinterpret
 * this decision with another model call.
 */
export const CapabilityDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("no_change"),
    reason: z.string().trim().min(1).max(2_048),
  }),
  z.strictObject({
    decision: z.literal("create"),
    proposal: CapabilityProposalSchema,
  }),
  z.strictObject({
    decision: z.literal("revise"),
    ...ExistingCapabilityDecisionFields,
    proposal: CapabilityProposalSchema,
  }),
  z.strictObject({
    decision: z.literal("pause"),
    ...ExistingCapabilityDecisionFields,
    reason: z.string().trim().min(1).max(2_048),
  }),
  z.strictObject({
    decision: z.literal("restore"),
    ...ExistingCapabilityDecisionFields,
    capabilityRevisionId: z.string().trim().min(1),
    reason: z.string().trim().min(1).max(2_048),
  }),
  z.strictObject({
    decision: z.literal("change_binding"),
    ...ExistingCapabilityDecisionFields,
    scope: CapabilityScopeDecisionSchema,
    activationMode: z.enum(["relevant", "always"]),
    reason: z.string().trim().min(1).max(2_048),
  }),
]);

export type CapabilityDecision = Readonly<z.infer<typeof CapabilityDecisionSchema>>;

/** Promotes one project Program to the global library. The decision is the model's or the user's. */
export const ProgramPromotionDecisionSchema = z.strictObject({
  mode: z.enum(["script", "workflow"]),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  reason: z.string().trim().min(1).max(2_048),
  expectedGlobalRevisionId: z.string().min(1).exactOptional(),
});
export type ProgramPromotionDecision = Readonly<z.infer<typeof ProgramPromotionDecisionSchema>>;

export const CapabilityPublicationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("no_change"),
    reason: z.string(),
  }),
  z.strictObject({
    status: z.enum(["activated", "revised", "pending", "paused", "restored", "binding_changed"]),
    capabilityId: z.string(),
    message: z.string(),
  }),
  z.strictObject({
    status: z.literal("stale"),
    capabilityId: z.string(),
    message: z.string(),
  }),
]);

export type CapabilityPublicationResult = Readonly<z.infer<typeof CapabilityPublicationResultSchema>>;

export const ProgramPromotionResultSchema = z.strictObject({
  status: z.literal("program_promoted"),
  mode: z.enum(["script", "workflow"]),
  name: z.string(),
  definitionRevisionId: z.string(),
  programRevision: z.number().int().positive(),
  unchanged: z.boolean(),
  message: z.string(),
});
export type ProgramPromotionResult = Readonly<z.infer<typeof ProgramPromotionResultSchema>>;

export interface CapabilityProgramLibrary {
  readonly list: (project: ProjectRef) => Promise<
    readonly {
      readonly mode: "script" | "workflow";
      readonly scope: "project" | "global";
      /** A global Program that a project Program with the same name hides from name lookups. */
      readonly shadowed?: boolean;
      readonly name: string;
      readonly description: string;
      readonly revision: number;
      readonly definitionRevision: FileRevisionRef;
    }[]
  >;
  readonly resolve: (
    mode: "script" | "workflow",
    name: string,
    project: ProjectRef,
    scope?: "project" | "global",
  ) => Promise<Extract<CapabilityEffect, { readonly kind: "program" }> | undefined>;
  /** Compiles the Programs in a folder's files to exact revisions a turn can run. */
  readonly compileFolderPrograms?: (input: {
    readonly capabilityId: string;
    readonly sessionId: string;
    readonly files: readonly {
      readonly path: string;
      readonly bytes: Uint8Array;
      readonly revision: FileRevisionRef;
    }[];
  }) => Promise<CapabilityFolder["programs"]>;
  /** Copies a project Program into the global library, leaving the original intact. */
  readonly promote?: (
    project: ProjectRef,
    input: ProgramPromotionDecision & {
      readonly evidenceRefs: readonly EvidenceRef[];
      readonly actor: ActorRef;
    },
  ) => Promise<{
    readonly definitionRevision: FileRevisionRef;
    readonly revision: number;
    readonly unchanged: boolean;
  }>;
}

export interface CapabilityPublicationContext {
  readonly project: ProjectRef;
  readonly sessionId: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly actor: ActorRef;
  readonly interpretation?: string;
  /** Foreground turns may pin program effects to the exact saved definitions visible at admission. */
  readonly programResolver?: Pick<CapabilityProgramLibrary, "resolve">;
}

export interface CapabilityPublisher {
  readonly publish: (
    decision: CapabilityDecision,
    context: CapabilityPublicationContext,
    signal: AbortSignal,
  ) => Promise<CapabilityPublicationResult>;
  /** Copies a project Program to the global library as a new revision that cites its source. */
  readonly promoteProgram: (
    decision: ProgramPromotionDecision,
    context: Pick<CapabilityPublicationContext, "project" | "evidenceRefs" | "actor">,
    signal: AbortSignal,
  ) => Promise<ProgramPromotionResult>;
  /** Rejects an always-active mode when the current guidance is too long for every prompt. */
  readonly assertCurrentGuidanceFitsAlways: (capabilityId: string) => Promise<void>;
  /** Rejects approving a pending always-active revision whose guidance is too long. */
  readonly assertGateFitsAlways: (gateRequestId: string) => Promise<void>;
  /** Rewrites a Capability's working folder to match its current revision after a restore or approval. */
  readonly syncWorkingDocument: (
    capabilityId: string,
    options?: {
      /** The user restored or approved this revision, so it replaces unapplied file edits. */
      readonly userChoseRevision?: boolean;
      /** Replace an unapplied edit only while each file, by folder path, holds these exact bytes. */
      readonly onlyReplacing?: ReadonlyMap<string, string>;
    },
  ) => Promise<void>;
  /**
   * Records direct edits to Capability folders as new revisions. An edit that cannot be read is left
   * in place and reported, and the Capability keeps its current revision.
   */
  readonly recordDocumentEdits: (
    context: Pick<CapabilityPublicationContext, "project" | "sessionId">,
    signal: AbortSignal,
  ) => Promise<CapabilityDocumentEditReport>;
  /** Replace one exact pending gated revision after a user-authored natural-language amendment. */
  readonly replacePendingGate: (
    input: {
      readonly gateRequestId: string;
      readonly proposal: CapabilityProposal;
      readonly instruction: string;
    },
    context: {
      readonly project?: ProjectRef;
      readonly actor: ActorRef;
    },
    signal: AbortSignal,
  ) => Promise<CapabilityPublicationResult>;
}

export interface CapabilityDocumentEditReport {
  readonly recorded: readonly { readonly capabilityId: string; readonly name: string }[];
  readonly problems: readonly {
    readonly capabilityId: string;
    readonly path: string;
    readonly error: string;
  }[];
}

export interface CreateCapabilityPublisherOptions {
  readonly workspace: NoesisWorkspaceStore;
  readonly store: CapabilityLifecycleStore;
  readonly programs?: CapabilityProgramLibrary;
  readonly now?: () => string;
  readonly nextId?: (prefix: string) => string;
}

function scopeFrom(
  decision: z.infer<typeof CapabilityScopeDecisionSchema>,
  context: Pick<CapabilityPublicationContext, "project" | "sessionId">,
): CapabilityScope {
  if (decision === "global") return Object.freeze({ kind: "global" });
  if (decision === "current_project")
    return Object.freeze({ kind: "project", project: Object.freeze({ ...context.project }) });
  return Object.freeze({ kind: "session", sessionId: context.sessionId });
}

export function capabilityScopeDecision(
  scope: CapabilityScope,
): z.infer<typeof CapabilityScopeDecisionSchema> {
  if (scope.kind === "global") return "global";
  if (scope.kind === "project") return "current_project";
  return "current_session";
}

function proposedScope(
  proposal: CapabilityProposal,
  context: Pick<CapabilityPublicationContext, "project" | "sessionId">,
  effects: readonly CapabilityEffect[],
  current?: CapabilityScope,
): CapabilityScope {
  // A project Program only exists in its project. A global Program leaves the scope free.
  const projectProgram = effects.find((effect) => effect.kind === "program" && effect.program.project);
  if (projectProgram?.kind === "program") {
    if (proposal.scope !== undefined && proposal.scope !== "current_project")
      throw new Error(
        `Project Program ${projectProgram.program.name} requires current-project scope. Promote it to global to use it more widely.`,
      );
    return Object.freeze({ kind: "project", project: Object.freeze({ ...context.project }) });
  }
  return proposal.scope === undefined
    ? (current ?? Object.freeze({ kind: "global" as const }))
    : scopeFrom(proposal.scope, context);
}

function proposedActivationMode(
  proposal: CapabilityProposal,
  current?: CapabilityActivationMode,
): CapabilityActivationMode {
  return proposal.activationMode ?? current ?? "relevant";
}

const evidenceKindLabel = capabilityEvidenceLabel;
/** The actor ambient reflection publishes as. */
export const AMBIENT_REFLECTION_ACTOR_ID = "automatic-learning-organ";
/** An always-active Capability enters every turn's prompt, so its guidance must stay short. */
export const ALWAYS_GUIDANCE_MAX_CHARACTERS = 2_000;

function assertAlwaysGuidanceFits(guidance: string): void {
  if (guidance.length > ALWAYS_GUIDANCE_MAX_CHARACTERS)
    throw new Error(
      `An always-active Capability's guidance must be at most ${String(ALWAYS_GUIDANCE_MAX_CHARACTERS)} characters; it has ${String(guidance.length)}. Keep it relevant, or shorten the guidance.`,
    );
}
export const CAPABILITY_DOCUMENT_FILE = "SKILL.md";
const MAX_FOLDER_FILES = 200;
const MAX_FOLDER_FILE_BYTES = 1024 * 1024;
const MAX_FOLDER_BYTES = 8 * 1024 * 1024;
/** The readable folder for a new Capability. It keeps this path for every later revision. */
function capabilityDocumentPath(capabilityId: string, name: string): string {
  return `capabilities/${learnedCapabilitySkillName(capabilityId, name).slice("learned-".length)}/${CAPABILITY_DOCUMENT_FILE}`;
}

/**
 * The editable SKILL.md for a Capability file revision, outside the candidate area. A revision from
 * before folders recorded `<name>-<id>.md`; its folder is `<name>-<id>/`.
 */
export function capabilityWorkingDocumentPath(document: FileRevisionRef): string {
  const working = document.workingPath.replace(/^definitions\/candidates\//u, "definitions/");
  return working.endsWith(`/${CAPABILITY_DOCUMENT_FILE}`)
    ? working
    : working.replace(/\.md$/u, `/${CAPABILITY_DOCUMENT_FILE}`);
}

/** The editable folder that holds a Capability file revision. */
export function capabilityWorkingFolderPath(document: FileRevisionRef): string {
  return capabilityWorkingDocumentPath(document).slice(0, -`/${CAPABILITY_DOCUMENT_FILE}`.length);
}

/** Why a folder cannot become a revision, or undefined when it can. */
function folderContentProblem(
  files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
  unsupported: readonly string[],
): string | undefined {
  const link = unsupported[0];
  if (link) return `${link} is a link or special file. A Capability folder holds plain files only.`;
  if (files.length > MAX_FOLDER_FILES)
    return `The folder has ${String(files.length)} files. The limit is ${String(MAX_FOLDER_FILES)}.`;
  const badPath = files.find((file) => !isCapabilityFolderPath(file.path));
  if (badPath) return `${badPath.path} is not a usable file name in a Capability folder.`;
  const large = files.find((file) => file.bytes.length > MAX_FOLDER_FILE_BYTES);
  if (large) return `${large.path} is larger than ${String(MAX_FOLDER_FILE_BYTES)} bytes.`;
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (total > MAX_FOLDER_BYTES) return `The folder is larger than ${String(MAX_FOLDER_BYTES)} bytes.`;
  return undefined;
}

function folderNameOf(folderPath: string): string {
  return folderPath.split("/").at(-1) ?? folderPath;
}

/** What a revision pins, by folder path. A revision from before folders pins its one file. */
export function capabilityFolderFiles(lifecycle: CapabilityLifecycleRevision): CapabilityFolder["files"] {
  return (
    lifecycle.revision.folder?.files ??
    Object.freeze([
      Object.freeze({ path: CAPABILITY_DOCUMENT_FILE, revision: capabilityDocumentRevision(lifecycle) }),
    ])
  );
}

/** The Capability file a revision pins: its first effect is always the instruction file. */
export function capabilityDocumentRevision(revision: CapabilityLifecycleRevision): FileRevisionRef {
  const first = revision.revision.effects[0];
  if (first?.kind !== "instruction")
    throw new Error(`Capability revision ${revision.reference.capabilityRevisionId} has no instruction file`);
  return first.material;
}

function normalizedEvidence(references: readonly EvidenceRef[]): readonly EvidenceRef[] {
  const unique = new Map(references.map((reference) => [canonicalJson(reference), reference]));
  if (unique.size === 0) throw new Error("Capability publication requires authoritative evidence");
  return Object.freeze([...unique.values()]);
}

export function createCapabilityPublisher(options: CreateCapabilityPublisherOptions): CapabilityPublisher {
  const now = options.now ?? (() => new Date().toISOString());
  const nextId = options.nextId ?? createId;
  const programs: CapabilityProgramLibrary =
    options.programs ??
    Object.freeze({
      list: async () => Object.freeze([]),
      resolve: async () => undefined,
    });

  const authorRevision = async (input: {
    readonly proposal: CapabilityProposal;
    readonly capabilityId: string;
    readonly predecessor?: CapabilityLifecycleRevision;
    readonly evidenceRefs: readonly EvidenceRef[];
    readonly project?: ProjectRef;
    readonly actor: ActorRef;
    readonly programResolver?: Pick<CapabilityProgramLibrary, "resolve">;
    /** The folder's other files and Programs. Without it, a revision keeps its predecessor's. */
    readonly folderExtras?: Pick<CapabilityFolder, "files" | "programs">;
  }): Promise<{
    readonly definition: CapabilityDefinition;
    readonly revision: CapabilityLifecycleRevision;
  }> => {
    const capabilityRevisionId = nextId("capability_revision");
    const existingDefinition = input.predecessor
      ? await options.store.getDefinition(input.capabilityId)
      : undefined;
    if (input.predecessor && !existingDefinition)
      throw new Error(`Capability ${input.capabilityId} has a revision but no definition`);
    // A revision may refine the name, description, and applicability. The Capability ID and its
    // creation time stay fixed, so lineage and restoration still refer to the same Capability.
    const definition: CapabilityDefinition = Object.freeze({
      capabilityId: input.capabilityId,
      name: input.proposal.name,
      description: input.proposal.description,
      applicability: input.proposal.applicability,
      createdAt: existingDefinition?.createdAt ?? now(),
    });
    // Instruction drafts become the guidance of one readable Capability file.
    const guidance = input.proposal.effects
      .flatMap((draft) => (draft.kind === "instruction" ? [draft.content.trim()] : []))
      .join("\n\n");
    const programDrafts = input.proposal.effects.filter((draft) => draft.kind === "program");
    if (guidance.length === 0 && programDrafts.length === 0)
      throw new Error("A Capability needs guidance or a saved Program");
    const predecessorDocument = input.predecessor ? capabilityDocumentRevision(input.predecessor) : undefined;
    // listRevisions without a limit returns the oldest first; the file lists the newest first.
    const history = input.predecessor
      ? (await options.store.listRevisions(input.capabilityId)).toReversed().map((revision) => ({
          date: revision.createdAt.slice(0, 10),
          summary: revision.summary,
        }))
      : [];
    const documentPath = predecessorDocument
      ? capabilityWorkingDocumentPath(predecessorDocument)
      : capabilityDocumentPath(input.capabilityId, input.proposal.name);
    const folderName = folderNameOf(documentPath.slice(0, -`/${CAPABILITY_DOCUMENT_FILE}`.length));
    const bytes = new TextEncoder().encode(
      renderCapabilityDocument(
        folderName,
        {
          name: input.proposal.name,
          when: input.proposal.applicability,
          description: input.proposal.description,
          guidance:
            guidance.length > 0
              ? guidance
              : `Use the saved ${programDrafts.map((draft) => `${draft.mode} \`${draft.name}\``).join(" and ")}.`,
        },
        createConditionalObject({
          rationale: input.proposal.rationale,
          history: [{ date: now().slice(0, 10), summary: input.proposal.summary }, ...history],
        } as const)
          .addOptional(
            input.proposal.evidence
              ? {
                  evidence: {
                    label: evidenceKindLabel(input.proposal.evidence.kind),
                    quote: input.proposal.evidence.quote,
                    wouldOtherwise: input.proposal.evidence.wouldOtherwise,
                  },
                }
              : undefined,
          )
          .finish(),
      ),
    );
    const documentRequest = createConditionalObject({
      workingPath: documentPath,
      bytes,
      actor: input.actor,
      reason: input.proposal.rationale,
      provenanceRefs: input.evidenceRefs,
    } as const)
      .addOptional(
        predecessorDocument ? { predecessorRevisionId: predecessorDocument.revisionId } : undefined,
      )
      .finish();
    // Each revision is recorded as a candidate snapshot. The file the user reads changes only after
    // the revision becomes current, so a failed or stale publication never looks like a user edit.
    const document = await options.workspace.definitions.recordCandidateDefinition(documentRequest);
    const programEffects = await Promise.all(
      programDrafts.map(async (draft): Promise<CapabilityEffect> => {
        if (!input.project) throw new Error(`Capability program ${draft.name} has no project authority`);
        const resolved = await (input.programResolver ?? programs).resolve(
          draft.mode,
          draft.name,
          input.project,
          draft.scope,
        );
        if (!resolved)
          throw new Error(
            `Unknown saved ${draft.scope ? `${draft.scope} ` : ""}${draft.mode} Program ${draft.name}`,
          );
        return resolved;
      }),
    );
    const effects = validateCapabilityEffects([
      Object.freeze({ kind: "instruction" as const, material: document }),
      ...programEffects,
    ]);
    const extras: Pick<CapabilityFolder, "files" | "programs"> = input.folderExtras ?? {
      files: input.predecessor
        ? capabilityFolderFiles(input.predecessor).filter((file) => file.path !== CAPABILITY_DOCUMENT_FILE)
        : [],
      programs: input.predecessor?.revision.folder?.programs ?? [],
    };
    const folderFiles = Object.freeze([
      Object.freeze({ path: CAPABILITY_DOCUMENT_FILE, revision: document }),
      ...extras.files,
    ]);
    const revision: CapabilityRevision = Object.freeze(
      createConditionalObject({
        capabilityRevisionId,
        capabilityId: input.capabilityId,
      } as const)
        .addOptional(
          input.predecessor
            ? { predecessorRevisionId: input.predecessor.revision.capabilityRevisionId }
            : undefined,
        )
        .add({
          effects,
          folder: Object.freeze({
            digest: capabilityFolderDigest(folderFiles),
            files: folderFiles,
            programs: Object.freeze([...extras.programs]),
          }),
          evidenceRefs: Object.freeze([...input.evidenceRefs]),
        } as const)
        .finish(),
    );
    const reference = capabilityRevisionRef(revision);
    return Object.freeze({
      definition,
      revision: Object.freeze(
        createConditionalObject({
          revision,
          reference,
          summary: input.proposal.summary,
          rationale: input.proposal.rationale,
          anticipatedEffect: input.proposal.anticipatedEffect,
        } as const)
          .addOptional(input.proposal.evidence ? { evidence: input.proposal.evidence } : undefined)
          .add({ createdAt: now() } as const)
          .finish(),
      ),
    });
  };

  const publish: CapabilityPublisher["publish"] = async (decision, context, signal) =>
    await publishWithFolder(decision, context, signal, undefined);
  const publishWithFolder = async (
    decision: CapabilityDecision,
    context: CapabilityPublicationContext,
    signal: AbortSignal,
    folderExtras: Pick<CapabilityFolder, "files" | "programs"> | undefined,
  ): Promise<CapabilityPublicationResult> => {
    signal.throwIfAborted();
    if (decision.decision === "no_change")
      return Object.freeze({ status: "no_change" as const, reason: decision.reason });
    const evidenceRefs = normalizedEvidence(context.evidenceRefs);
    const decisionFeedback = (
      binding: CapabilityBinding,
      interpretation: string,
      disposition: CapabilityFeedback["disposition"],
    ): CapabilityFeedback =>
      Object.freeze({
        feedbackId: nextId("capability_feedback"),
        capabilityId: binding.capabilityId,
        revision: binding.revision,
        evidenceRefs,
        interpretation,
        disposition,
        createdAt: now(),
      });

    if (decision.decision === "pause") {
      const binding = await options.store.getBinding(decision.capabilityId);
      if (!binding) throw new Error(`Unknown capability ${decision.capabilityId}`);
      if (binding.revisionNumber !== decision.expectedBindingRevision)
        return Object.freeze({
          status: "stale" as const,
          capabilityId: binding.capabilityId,
          message: "Capability changed concurrently",
        });
      signal.throwIfAborted();
      const updated = await options.store.updateBindingWithFeedback({
        capabilityId: binding.capabilityId,
        expectedRevisionNumber: decision.expectedBindingRevision,
        state: "paused",
        feedback: decisionFeedback(binding, decision.reason, "correction"),
      });
      return Object.freeze({
        status: updated.status === "stale" ? ("stale" as const) : ("paused" as const),
        capabilityId: binding.capabilityId,
        message: decision.reason,
      });
    }

    if (decision.decision === "restore") {
      const [binding, target] = await Promise.all([
        options.store.getBinding(decision.capabilityId),
        options.store.getRevisionById(decision.capabilityId, decision.capabilityRevisionId),
      ]);
      if (!binding) throw new Error(`Unknown capability ${decision.capabilityId}`);
      if (binding.revisionNumber !== decision.expectedBindingRevision)
        return Object.freeze({
          status: "stale" as const,
          capabilityId: binding.capabilityId,
          message: "Capability changed concurrently",
        });
      if (!target) throw new Error(`Unknown restorable revision ${decision.capabilityRevisionId}`);
      signal.throwIfAborted();
      const updated = await options.store.updateBindingWithFeedback({
        capabilityId: binding.capabilityId,
        expectedRevisionNumber: decision.expectedBindingRevision,
        revision: target.reference,
        state: "active",
        feedback: decisionFeedback(binding, decision.reason, "restore_request"),
      });
      if (updated.status !== "stale")
        // Ambient reflection restoring a revision does not override the user's unapplied edits.
        await syncWorkingDocument(binding.capabilityId, {
          userChoseRevision: context.actor.actorId !== AMBIENT_REFLECTION_ACTOR_ID,
        });
      return Object.freeze({
        status: updated.status === "stale" ? ("stale" as const) : ("restored" as const),
        capabilityId: binding.capabilityId,
        message: decision.reason,
      });
    }

    if (decision.decision === "change_binding") {
      const binding = await options.store.getBinding(decision.capabilityId);
      if (!binding) throw new Error(`Unknown capability ${decision.capabilityId}`);
      if (binding.revisionNumber !== decision.expectedBindingRevision)
        return Object.freeze({
          status: "stale" as const,
          capabilityId: binding.capabilityId,
          message: "Capability changed concurrently",
        });
      if (decision.activationMode === "always") await assertCurrentGuidanceFitsAlways(binding.capabilityId);
      signal.throwIfAborted();
      const updated = await options.store.updateBindingWithFeedback({
        capabilityId: binding.capabilityId,
        expectedRevisionNumber: decision.expectedBindingRevision,
        scope: scopeFrom(decision.scope, context),
        activationMode: decision.activationMode,
        feedback: decisionFeedback(
          binding,
          decision.reason,
          decision.activationMode !== binding.activationMode ? "activation_change" : "scope_change",
        ),
      });
      return Object.freeze({
        status: updated.status === "stale" ? ("stale" as const) : ("binding_changed" as const),
        capabilityId: binding.capabilityId,
        message: decision.reason,
      });
    }

    const proposal = decision.proposal;
    const capabilityId = decision.decision === "create" ? nextId("capability") : decision.capabilityId;
    const binding = await options.store.getBinding(capabilityId);
    if (decision.decision === "create" && binding)
      throw new Error(`Cannot create existing capability ${capabilityId}`);
    if (decision.decision === "revise") {
      if (!binding) throw new Error(`Cannot revise unknown capability ${capabilityId}`);
      if (binding.revisionNumber !== decision.expectedBindingRevision)
        return Object.freeze({
          status: "stale" as const,
          capabilityId,
          message: "Capability changed concurrently",
        });
    }
    const predecessor = binding ? await options.store.getRevision(binding.revision) : undefined;
    if (decision.decision === "revise" && !predecessor)
      throw new Error(`Cannot revise unknown capability ${capabilityId}`);
    const authored = await authorRevision(
      createConditionalObject({
        proposal,
        capabilityId,
        evidenceRefs,
        project: context.project,
        actor: context.actor,
      } as const)
        .addOptional(context.programResolver ? { programResolver: context.programResolver } : undefined)
        .addOptional(predecessor ? { predecessor } : undefined)
        .addOptional(folderExtras ? { folderExtras } : undefined)
        .finish(),
    );
    // Ordinary revisions only mount guidance or an already-saved Program, and any later
    // execution still passes through that Program's frozen Broker and AuthorityBoundary.
    const requiresGate = proposal.consequence !== "ordinary";
    const nextScope = proposedScope(proposal, context, authored.revision.revision.effects, binding?.scope);
    const nextActivationMode = proposedActivationMode(proposal, binding?.activationMode);
    if (nextActivationMode === "always") await assertRevisionGuidanceFitsAlways(authored.revision);

    if (!binding) {
      const gate = requiresGate
        ? Object.freeze({
            gateRequestId: nextId("capability_gate"),
            capabilityId,
            revision: authored.revision.reference,
            expectedBindingRevision: 1,
            proposedScope: nextScope,
            proposedActivationMode: nextActivationMode,
            consequence: proposal.consequenceDescription,
            status: "pending" as const,
            createdAt: now(),
          })
        : undefined;
      signal.throwIfAborted();
      await options.store.create(
        createConditionalObject({
          definition: authored.definition,
          revision: authored.revision,
          binding: Object.freeze({
            capabilityId,
            revision: authored.revision.reference,
            scope: nextScope,
            activationMode: nextActivationMode,
            state: requiresGate ? ("paused" as const) : ("active" as const),
          }),
        } as const)
          .addOptional(gate ? { gate } : undefined)
          .finish(),
      );
      await syncWorkingDocument(capabilityId);
      return Object.freeze({
        status: requiresGate ? ("pending" as const) : ("activated" as const),
        capabilityId,
        message: authored.revision.summary,
      });
    }

    const expectedBindingRevision =
      decision.decision === "revise" ? decision.expectedBindingRevision : binding.revisionNumber;
    const feedback = Object.freeze({
      feedbackId: nextId("capability_feedback"),
      capabilityId,
      revision: binding.revision,
      evidenceRefs,
      interpretation: context.interpretation ?? proposal.rationale,
      disposition: "correction" as const,
      createdAt: now(),
    }) satisfies CapabilityFeedback;
    if (requiresGate) {
      signal.throwIfAborted();
      const staged = await options.store.stageGatedRevision({
        revision: authored.revision,
        feedback,
        gate: Object.freeze({
          gateRequestId: nextId("capability_gate"),
          capabilityId,
          revision: authored.revision.reference,
          expectedBindingRevision,
          proposedScope: nextScope,
          proposedActivationMode: nextActivationMode,
          consequence: proposal.consequenceDescription,
          status: "pending",
          createdAt: now(),
        }),
      });
      if (staged.status === "stale")
        return Object.freeze({
          status: "stale" as const,
          capabilityId,
          message: "Capability changed concurrently",
        });
      return Object.freeze({
        status: "pending" as const,
        capabilityId,
        message: authored.revision.summary,
      });
    }
    signal.throwIfAborted();
    const updated = await options.store.applyRevision({
      revision: authored.revision,
      definition: authored.definition,
      feedback,
      expectedBindingRevision,
      scope: nextScope,
      activationMode: nextActivationMode,
    });
    if (updated.status !== "stale") await syncWorkingDocument(capabilityId);
    return Object.freeze({
      status: updated.status === "stale" ? ("stale" as const) : ("revised" as const),
      capabilityId,
      message: authored.revision.summary,
    });
  };

  const promoteProgram: CapabilityPublisher["promoteProgram"] = async (decision, context, signal) => {
    signal.throwIfAborted();
    if (!programs.promote) throw new Error("This workspace has no Program library to promote into");
    const promoted = await programs.promote(context.project, {
      ...decision,
      evidenceRefs: normalizedEvidence(context.evidenceRefs),
      actor: context.actor,
    });
    return Object.freeze({
      status: "program_promoted" as const,
      mode: decision.mode,
      name: decision.name,
      definitionRevisionId: promoted.definitionRevision.revisionId,
      programRevision: promoted.revision,
      unchanged: promoted.unchanged,
      message: promoted.unchanged
        ? `Program ${decision.name} is already global`
        : `Promoted Program ${decision.name} to global: ${decision.reason}`,
    });
  };

  const replacePendingGate: CapabilityPublisher["replacePendingGate"] = async (input, context, signal) => {
    signal.throwIfAborted();
    const gate = await options.store.getGate(input.gateRequestId);
    if (!gate) throw new Error(`Unknown capability gate ${input.gateRequestId}`);
    if (gate.status !== "pending")
      throw new Error(`Capability gate ${input.gateRequestId} is already ${gate.status}`);
    const [binding, predecessor, definition] = await Promise.all([
      options.store.getBinding(gate.capabilityId),
      options.store.getRevision(gate.revision),
      options.store.getDefinition(gate.capabilityId),
    ]);
    if (!binding || !predecessor || !definition)
      throw new Error(`Capability gate ${input.gateRequestId} has incomplete authority`);
    const evidenceRefs = normalizedEvidence(predecessor.revision.evidenceRefs);
    const authored = await authorRevision(
      createConditionalObject({
        proposal: input.proposal,
        capabilityId: gate.capabilityId,
        predecessor,
        evidenceRefs,
        actor: context.actor,
      } as const)
        .addOptional(context.project ? { project: context.project } : undefined)
        .finish(),
    );
    if (gate.proposedActivationMode === "always") await assertRevisionGuidanceFitsAlways(authored.revision);
    signal.throwIfAborted();
    const staged = await options.store.stageGatedRevision({
      revision: authored.revision,
      feedback: Object.freeze({
        feedbackId: nextId("capability_feedback"),
        capabilityId: gate.capabilityId,
        revision: binding.revision,
        evidenceRefs,
        interpretation: input.instruction,
        disposition: "correction",
        createdAt: now(),
      }),
      supersedeGateRequestId: gate.gateRequestId,
      gate: Object.freeze({
        gateRequestId: nextId("capability_gate"),
        capabilityId: gate.capabilityId,
        revision: authored.revision.reference,
        expectedBindingRevision: binding.revisionNumber,
        proposedScope: gate.proposedScope,
        proposedActivationMode: gate.proposedActivationMode,
        consequence: input.proposal.consequenceDescription,
        status: "pending",
        instruction: input.instruction,
        createdAt: now(),
      }),
    });
    if (staged.status === "stale")
      return Object.freeze({
        status: "stale" as const,
        capabilityId: gate.capabilityId,
        message: "Capability changed concurrently",
      });
    return Object.freeze({
      status: "pending" as const,
      capabilityId: gate.capabilityId,
      message: authored.revision.summary,
    });
  };

  async function assertRevisionGuidanceFitsAlways(revision: CapabilityLifecycleRevision): Promise<void> {
    const document = capabilityDocumentRevision(revision);
    assertAlwaysGuidanceFits(
      capabilityGuidance(new TextDecoder().decode(await options.workspace.reads.readRevision(document))),
    );
  }
  const assertCurrentGuidanceFitsAlways = async (capabilityId: string): Promise<void> => {
    const binding = await options.store.getBinding(capabilityId);
    const lifecycle = binding ? await options.store.getRevision(binding.revision) : undefined;
    if (lifecycle) await assertRevisionGuidanceFitsAlways(lifecycle);
  };
  const assertGateFitsAlways = async (gateRequestId: string): Promise<void> => {
    const gate = await options.store.getGate(gateRequestId);
    if (gate?.proposedActivationMode !== "always") return;
    const lifecycle = await options.store.getRevision(gate.revision);
    if (lifecycle) await assertRevisionGuidanceFitsAlways(lifecycle);
  };
  const systemActor: ActorRef = Object.freeze({ actorId: "capability-files", kind: "system" });
  const userActor: ActorRef = Object.freeze({ actorId: "workspace-user", kind: "user" });
  /**
   * True when Noesis's own file sync made the last record at this path and the file still matches
   * it. A user edit, including bytes restored from a backup, never meets both.
   */
  const isUnchangedNoesisWrite = async (path: string, working: Uint8Array): Promise<boolean> => {
    const lastRecorded = await options.workspace.reads.latestWorkingRevision(path);
    return (
      lastRecorded?.actor.actorId === systemActor.actorId &&
      lastRecorded.actor.kind === systemActor.kind &&
      lastRecorded.revision.contentDigest === sha256(working)
    );
  };

  /**
   * True when the file still holds bytes this Capability already took in: Noesis's own sync wrote
   * them, or some revision of the Capability pins the file revision recorded for them. Such bytes may
   * be replaced or removed when the folder follows another revision. Anything else is an edit Noesis
   * has not applied, such as a file recorded by a scan whose import then failed.
   */
  const isAdoptedFile = async (capabilityId: string, path: string, working: Uint8Array): Promise<boolean> => {
    const lastRecorded = await options.workspace.reads.latestWorkingRevision(path);
    if (lastRecorded?.revision.contentDigest !== sha256(working)) return false;
    if (lastRecorded.actor.actorId === systemActor.actorId && lastRecorded.actor.kind === systemActor.kind)
      return true;
    const revisions = await options.store.listRevisions(capabilityId);
    return revisions.some((lifecycle) =>
      capabilityFolderFiles(lifecycle).some(
        (file) => file.revision.revisionId === lastRecorded.revision.revisionId,
      ),
    );
  };

  /** The exact Program a revision attaches, kept when an edit replaces only its guidance. */
  const currentProgram = (
    lifecycle: CapabilityLifecycleRevision,
  ): {
    readonly drafts: readonly CapabilityProposal["effects"][number][];
    readonly resolver: Pick<CapabilityProgramLibrary, "resolve">;
    readonly project?: ProjectRef;
  } => {
    const programs = lifecycle.revision.effects.filter((effect) => effect.kind === "program");
    return createConditionalObject({
      drafts: Object.freeze(
        programs.map((effect) => ({
          kind: "program" as const,
          mode: effect.program.mode,
          name: effect.program.name,
          scope: effect.program.project ? ("project" as const) : ("global" as const),
        })),
      ),
      // Keep the exact pinned Program revisions instead of resolving the live library.
      resolver: Object.freeze({
        resolve: async (
          mode: "script" | "workflow",
          name: string,
          _project: ProjectRef,
          scope?: "project" | "global",
        ) =>
          programs.find(
            (effect) =>
              effect.program.mode === mode &&
              effect.program.name === name &&
              (scope === undefined || (scope === "project") === (effect.program.project !== undefined)),
          ),
      }),
    } as const)
      .addOptional(programs[0] ? { project: programs[0].program.project } : undefined)
      .finish();
  };

  /** The exact files a revision pins, with their bytes, as they should sit in the working folder. */
  const pinnedFolderFiles = async (
    lifecycle: CapabilityLifecycleRevision,
    folderPath: string,
  ): Promise<
    readonly {
      readonly path: string;
      readonly bytes: Uint8Array;
      readonly digest: string;
      readonly revision: FileRevisionRef;
    }[]
  > =>
    await Promise.all(
      capabilityFolderFiles(lifecycle).map(async ({ path, revision }) => {
        const stored = await options.workspace.reads.readRevision(revision);
        // A revision from before folders keeps its bytes. Its working copy has folder frontmatter.
        const bytes =
          lifecycle.revision.folder || path !== CAPABILITY_DOCUMENT_FILE
            ? stored
            : new TextEncoder().encode(
                capabilityDocumentInFolderFormat(folderNameOf(folderPath), new TextDecoder().decode(stored)),
              );
        return Object.freeze({ path, bytes, digest: sha256(bytes), revision });
      }),
    );
  /**
   * Moves a working file from before folders into its folder. It is safe to repeat: the old file
   * goes away only after its bytes are in the folder or in a recorded revision. An edit Noesis has
   * not recorded goes into SKILL.md as it is, so the next scan imports it as the user's edit.
   */
  const moveSingleFileIntoFolder = async (folderPath: string, pinnedDocument: Uint8Array): Promise<void> => {
    const legacyPath = `${folderPath}.md`;
    const legacy = await options.workspace.reads.readWorkingFile(legacyPath);
    if (!legacy) return;
    const documentPath = `${folderPath}/${CAPABILITY_DOCUMENT_FILE}`;
    const legacyDigest = sha256(legacy);
    const recorded = await options.workspace.reads.latestWorkingRevision(legacyPath);
    const isUnrecordedEdit = recorded?.revision.contentDigest !== legacyDigest;
    if (isUnrecordedEdit)
      await options.workspace.recordDirectEdit(
        legacyPath,
        userActor,
        "Edit carried into a Capability folder",
      );
    const current = await options.workspace.reads.readWorkingFile(documentPath);
    const replaceable = !current || (await isUnchangedNoesisWrite(documentPath, current));
    if (replaceable) {
      const carried = isUnrecordedEdit ? legacy : pinnedDocument;
      await options.workspace.definitions.recordWorkingDefinition({
        workingPath: documentPath,
        bytes: carried,
        actor: isUnrecordedEdit ? userActor : systemActor,
        reason: "Moved a Capability file into its folder",
      });
      const written = await options.workspace.reads.readWorkingFile(documentPath);
      if (!written || sha256(written) !== sha256(carried))
        throw new Error(`Capability folder ${folderPath} did not receive its file`);
    }
    await options.workspace.definitions.removeWorkingFile(legacyPath, "definitions/capabilities");
  };

  // Syncs for one Capability run one at a time. Each reads the binding when it starts, so the last
  // sync always writes the current revision even when publications race.
  const syncQueues = new Map<string, Promise<void>>();
  const syncWorkingDocument: CapabilityPublisher["syncWorkingDocument"] = async (capabilityId, options_) => {
    const previous = syncQueues.get(capabilityId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(
        async () =>
          await syncNow(capabilityId, options_?.userChoseRevision === true, options_?.onlyReplacing),
      );
    syncQueues.set(capabilityId, next);
    try {
      await next;
    } finally {
      if (syncQueues.get(capabilityId) === next) syncQueues.delete(capabilityId);
    }
  };
  const syncNow = async (
    capabilityId: string,
    userChoseRevision: boolean,
    onlyReplacing: ReadonlyMap<string, string> | undefined,
  ): Promise<void> => {
    const binding = await options.store.getBinding(capabilityId);
    if (!binding) return;
    const lifecycle = await options.store.getRevision(binding.revision);
    if (!lifecycle) return;
    const document = capabilityDocumentRevision(lifecycle);
    // A restore or approval may select a revision with an older name or "when" text.
    const parsed = parseCapabilityDocument(
      new TextDecoder().decode(await options.workspace.reads.readRevision(document)),
    );
    const definition = await options.store.getDefinition(capabilityId);
    if (
      parsed.ok &&
      definition &&
      (definition.name !== parsed.content.name ||
        definition.applicability !== parsed.content.when ||
        definition.description !== parsed.content.description)
    ) {
      const updated = Object.freeze({
        ...definition,
        name: parsed.content.name,
        applicability: parsed.content.when,
        description: parsed.content.description,
      });
      await options.store.updateDefinition(updated);
    }
    const folderPath = capabilityWorkingFolderPath(document);
    const pinned = await pinnedFolderFiles(lifecycle, folderPath);
    const pinnedDocument = pinned.find((file) => file.path === CAPABILITY_DOCUMENT_FILE);
    if (pinnedDocument) await moveSingleFileIntoFolder(folderPath, pinnedDocument.bytes);
    for (const file of pinned) {
      const path = `${folderPath}/${file.path}`;
      const working = await options.workspace.reads.readWorkingFile(path);
      if (working && sha256(working) === file.digest) continue;
      if (working && !(await isAdoptedFile(capabilityId, path, working))) {
        // The file holds an edit Noesis has not recorded yet. A publication leaves it, so the next
        // scan applies the user's edit on top of this revision. The user's own restore or approval
        // replaces it, after keeping its bytes as a revision so nothing is lost.
        if (!userChoseRevision) continue;
        if (onlyReplacing && onlyReplacing.get(file.path) !== sha256(working)) continue;
        await options.workspace.recordDirectEdit(
          path,
          userActor,
          "Unapplied edit replaced by the user's restore",
        );
      }
      await options.workspace.definitions.recordWorkingDefinition({
        workingPath: path,
        bytes: file.bytes,
        actor: systemActor,
        reason: "Match the Capability folder to its current revision",
        provenanceRefs: [file.revision],
      });
    }
    // Scanned files are handled above, so anything else appeared after that scan began.
    if (onlyReplacing) return;
    const expected = new Set(pinned.map((file) => file.path));
    const { files } = await options.workspace.reads.listWorkingFiles(folderPath);
    for (const extra of files) {
      if (expected.has(extra)) continue;
      const path = `${folderPath}/${extra}`;
      const working = await options.workspace.reads.readWorkingFile(path);
      if (!working) continue;
      if (!(await isAdoptedFile(capabilityId, path, working))) {
        if (!userChoseRevision) continue;
        await options.workspace.recordDirectEdit(
          path,
          userActor,
          "Unapplied file removed by the user's restore",
        );
      }
      await options.workspace.definitions.removeWorkingFile(path, folderPath);
    }
  };

  const recordDocumentEdits: CapabilityPublisher["recordDocumentEdits"] = async (context, signal) => {
    const definitions = await options.store.listDefinitions();
    const bindings = await options.store.getBindings(
      definitions.map((definition) => definition.capabilityId),
    );
    const recorded: { capabilityId: string; name: string }[] = [];
    const problems: { capabilityId: string; path: string; error: string }[] = [];
    for (const binding of bindings) {
      signal.throwIfAborted();
      const lifecycle = await options.store.getRevision(binding.revision);
      if (!lifecycle) continue;
      const document = capabilityDocumentRevision(lifecycle);
      const folderPath = capabilityWorkingFolderPath(document);
      const path = capabilityWorkingDocumentPath(document);
      const pinned = await pinnedFolderFiles(lifecycle, folderPath);
      const pinnedDocument = pinned.find((file) => file.path === CAPABILITY_DOCUMENT_FILE);
      if (!pinnedDocument) continue;
      const moved = await moveSingleFileIntoFolder(folderPath, pinnedDocument.bytes).then(
        () => undefined,
        (cause: Error) => cause.message,
      );
      if (moved !== undefined) {
        problems.push({ capabilityId: binding.capabilityId, path: folderPath, error: moved });
        continue;
      }
      const working = await options.workspace.reads.readWorkingFile(path);
      if (!working) {
        // Without SKILL.md the folder is not a skill. Say so; the current revision stays in effect.
        problems.push({
          capabilityId: binding.capabilityId,
          path,
          error: `${CAPABILITY_DOCUMENT_FILE} is missing, so the Capability keeps its current revision`,
        });
        continue;
      }
      const listing = await options.workspace.reads.listWorkingFiles(folderPath);
      const workingFiles = await Promise.all(
        listing.files.map(async (file) => {
          const bytes = await options.workspace.reads.readWorkingFile(`${folderPath}/${file}`);
          return bytes ? [Object.freeze({ path: file, bytes, digest: sha256(bytes) })] : [];
        }),
      ).then((groups) => groups.flat());
      const pinnedByPath = new Map(pinned.map((file) => [file.path, file] as const));
      const changed = workingFiles.filter((file) => pinnedByPath.get(file.path)?.digest !== file.digest);
      const removed = pinned.filter((file) => !workingFiles.some((item) => item.path === file.path));
      if (changed.length === 0 && removed.length === 0 && listing.unsupported.length === 0) continue;
      // A file Noesis wrote that was never brought up to date, e.g. Noesis stopped right after
      // publishing, is synced instead of imported as the user's edit.
      const writtenByNoesis =
        removed.length === 0 &&
        listing.unsupported.length === 0 &&
        (
          await Promise.all(
            changed.map(
              async (file) => await isUnchangedNoesisWrite(`${folderPath}/${file.path}`, file.bytes),
            ),
          )
        ).every(Boolean);
      if (writtenByNoesis) {
        await syncWorkingDocument(binding.capabilityId);
        continue;
      }
      const folderProblem = folderContentProblem(workingFiles, listing.unsupported);
      if (folderProblem) {
        problems.push({ capabilityId: binding.capabilityId, path: folderPath, error: folderProblem });
        continue;
      }
      const parsed = parseCapabilityDocument(new TextDecoder().decode(working));
      if (!parsed.ok) {
        problems.push({ capabilityId: binding.capabilityId, path, error: parsed.error });
        continue;
      }
      const current = currentProgram(lifecycle);
      if (current.project && current.project.projectId !== context.project.projectId) continue;
      // An edit gets the same limits as any authored Capability, e.g. name and guidance length.
      const proposal = CapabilityProposalSchema.safeParse({
        name: parsed.content.name,
        description: parsed.content.description,
        applicability: parsed.content.when,
        summary: "Edited directly in its Capability folder.",
        rationale: "The user edited the Capability folder.",
        anticipatedEffect: "Noesis follows the edited folder from the next turn.",
        effects: [
          { kind: "instruction", content: parsed.content.guidance },
          ...current.drafts.filter((draft) => draft.kind === "program"),
        ],
        consequence: "ordinary",
        consequenceDescription: "The user changed the folder directly.",
        evidence: {
          kind: "explicit_request",
          quote: `Edited ${folderPath}`,
          wouldOtherwise: "Noesis would keep following the folder the user replaced.",
        },
      });
      if (!proposal.success) {
        problems.push({
          capabilityId: binding.capabilityId,
          path,
          error: proposal.error.issues
            .map((issue) => `${issue.path.join(".") || "file"}: ${issue.message}`)
            .join("; "),
        });
        continue;
      }
      const outcome = await (async () => {
        const edits: FileRevisionRef[] = [];
        const extras: { path: string; bytes: Uint8Array; revision: FileRevisionRef }[] = [];
        for (const file of workingFiles) {
          if (file.path === CAPABILITY_DOCUMENT_FILE) continue;
          const unchanged = pinnedByPath.get(file.path);
          if (unchanged?.digest === file.digest) {
            extras.push({ path: file.path, bytes: file.bytes, revision: unchanged.revision });
            continue;
          }
          const revision = await options.workspace.recordDirectEdit(
            `${folderPath}/${file.path}`,
            userActor,
            "Direct edit to a Capability folder",
          );
          edits.push(revision);
          extras.push({ path: file.path, bytes: file.bytes, revision });
        }
        if (sha256(working) !== pinnedDocument.digest || edits.length === 0)
          edits.push(
            await options.workspace.recordDirectEdit(path, userActor, "Direct edit to a Capability file"),
          );
        const hasPrograms = extras.some((file) => file.path.startsWith("programs/"));
        if (hasPrograms && !programs.compileFolderPrograms)
          throw new Error("This workspace cannot read Programs in a Capability folder");
        const folderPrograms =
          hasPrograms && programs.compileFolderPrograms
            ? await programs.compileFolderPrograms({
                capabilityId: binding.capabilityId,
                sessionId: context.sessionId,
                files: extras,
              })
            : [];
        return await publishWithFolder(
          {
            decision: "revise",
            capabilityId: binding.capabilityId,
            expectedBindingRevision: binding.revisionNumber,
            proposal: proposal.data,
          },
          {
            project: current.project ?? context.project,
            sessionId: context.sessionId,
            evidenceRefs: edits,
            actor: userActor,
            interpretation: "The user edited the Capability folder directly",
            programResolver: current.resolver,
          },
          signal,
          Object.freeze({
            files: Object.freeze(
              extras.map(({ path: file, revision }) => Object.freeze({ path: file, revision })),
            ),
            programs: folderPrograms,
          }),
        );
      })().then(
        (result) => ({ ok: true as const, result }),
        (cause: Error) => ({ ok: false as const, message: cause.message }),
      );
      if (!outcome.ok) {
        // The edit stays in the folder. Noesis reports it and keeps the current revision.
        problems.push({ capabilityId: binding.capabilityId, path, error: outcome.message });
        continue;
      }
      const result = outcome.result;
      // The edit is now the current revision, so write its normalized file over the user's bytes,
      // unless the user saved again meanwhile; the next scan imports that newer save.
      if (result.status === "revised") {
        const synced = await syncWorkingDocument(binding.capabilityId, {
          userChoseRevision: true,
          onlyReplacing: new Map(workingFiles.map((file) => [file.path, file.digest] as const)),
        }).then(
          () => undefined,
          (cause: Error) => cause.message,
        );
        if (synced !== undefined) problems.push({ capabilityId: binding.capabilityId, path, error: synced });
      }
      if (result.status === "revised")
        recorded.push({ capabilityId: binding.capabilityId, name: parsed.content.name });
    }
    return Object.freeze({ recorded: Object.freeze(recorded), problems: Object.freeze(problems) });
  };

  return Object.freeze({
    publish,
    promoteProgram,
    replacePendingGate,
    assertCurrentGuidanceFitsAlways,
    assertGateFitsAlways,
    syncWorkingDocument,
    recordDocumentEdits,
  });
}
