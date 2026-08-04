import {
  ArtifactFileRefSchema,
  type CapabilityRevision,
  type CapabilityRevisionRef,
  CapabilityRevisionRefSchema,
  CapabilityRevisionSchema,
  CapabilitySchema,
  canonicalJson,
  capabilityRevisionRef,
  EvidenceRefSchema,
  type Experiment,
  type FileRevisionRef,
  FileRevisionRefSchema,
  sameCapabilityRevisionRef,
  type WorkspaceStore,
} from "@noesis/domain";
import { z } from "zod";
import {
  type AutomaticLearningOrgan,
  type AutomaticLearningOrganOptions,
  createAutomaticLearningOrgan,
  experimentBriefPublicationCollisionError,
  type ExperimentBrief,
  type ExperimentBriefStore,
  type LearningCandidateManifestStore,
} from "./organ.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const namespace = "learning_experiment_brief";
const actor = Object.freeze({ actorId: "automatic-learning-organ", kind: "noesis" as const });

const CitationSchema = z.strictObject({
  source: z.union([
    z.strictObject({
      kind: z.literal("database_row"),
      table: z.enum(["sessions", "messages", "tool_calls", "outcomes"]),
      rowId: z.string().min(1),
      field: z.string().min(1),
    }),
    z.strictObject({
      kind: z.literal("file_revision"),
      revisionId: z.string().min(1),
      field: z.literal("bytes"),
    }),
  ]),
  occurredAt: z.string().min(1),
  excerpt: z.string(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});

const VariantSchema = z.strictObject({
  variantId: z.string().min(1),
  axis: z.enum(["role", "retrieval", "routing", "evaluation", "tool_runtime", "activation"]),
  configurationRefs: z.array(FileRevisionRefSchema),
});

const RoleRunSchema = z.strictObject({
  runId: z.string().min(1),
  role: z.enum([
    "foreground",
    "signal_interpreter",
    "reflector",
    "revision_author",
    "case_generator",
    "trial",
    "judge_critic",
    "revision_agent",
    "ux_explainer",
  ]),
  research: z.strictObject({
    promptRevision: FileRevisionRefSchema,
    model: z.string().min(1),
    reasoning: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  }),
  trace: z.strictObject({
    traceId: z.string().min(1),
    role: z.enum([
      "foreground",
      "signal_interpreter",
      "reflector",
      "revision_author",
      "case_generator",
      "trial",
      "judge_critic",
      "revision_agent",
      "ux_explainer",
    ]),
    variant: VariantSchema,
    startedAt: z.string().min(1),
    completedAt: z.string().min(1),
    usage: z.strictObject({
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
      totalTokens: z.number().nonnegative(),
      estimatedCost: z.number().nonnegative(),
    }),
    evidenceRefs: z.array(
      FileRevisionRefSchema.extend({
        kind: z.literal("evidence_revision"),
        evidenceKind: z.enum(["input", "output", "tool_trace", "judgment", "report"]),
      }),
    ),
    artifactRefs: z.array(ArtifactFileRefSchema),
  }),
});

const RawExperimentBriefSchema = z.strictObject({
  experimentId: z.string().min(1),
  title: z.string().min(1),
  hypothesis: z.string().min(1),
  hypothesisDedupeKey: z.string().min(1),
  scope: z.string().min(1),
  capability: CapabilitySchema,
  baselineRevision: CapabilityRevisionRefSchema,
  evidenceRefs: z.array(EvidenceRefSchema),
  feedbackSignalIds: z.array(z.string().min(1)),
  citations: z.array(CitationSchema),
  recurrenceCitations: z.array(CitationSchema).default([]),
  sourceCases: z.array(
    z.strictObject({
      caseId: z.string().min(1),
      title: z.string().min(1),
      scope: z.string().min(1),
      input: z.string().min(1),
      expectedBehavior: z.string().min(1),
      evidenceRefs: z.array(EvidenceRefSchema),
      citations: z.array(CitationSchema),
    }),
  ),
  recurrenceCount: z.number().int().nonnegative(),
  reflectionRun: RoleRunSchema.optional(),
});

const ExperimentBriefSchema: z.ZodType<ExperimentBrief> = RawExperimentBriefSchema.transform(
  (value): ExperimentBrief => {
    const { reflectionRun, ...brief } = value;
    return Object.freeze({
      ...brief,
      ...(reflectionRun === undefined ? {} : { reflectionRun }),
    });
  },
);

const CandidateManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("learning_candidate_revision"),
  brief: ExperimentBriefSchema,
  revision: CapabilityRevisionSchema,
  revisionRef: CapabilityRevisionRefSchema,
  researchRefs: z.strictObject({
    experiment: z.strictObject({
      kind: z.literal("database_row"),
      table: z.literal("experiments"),
      rowId: z.string().min(1),
    }),
    feedbackSignals: z.array(
      z.strictObject({
        kind: z.literal("database_row"),
        table: z.literal("feedback_signals"),
        rowId: z.string().min(1),
      }),
    ),
    evidenceRefs: z.array(EvidenceRefSchema),
  }),
});

export interface RehydratedLearningCandidate {
  readonly brief: ExperimentBrief;
  readonly revision: CapabilityRevision;
  readonly revisionRef: CapabilityRevisionRef;
  readonly experiment: Experiment;
  readonly manifestRevision: FileRevisionRef;
}

type DurableWorkspace = Pick<
  WorkspaceStore,
  "reads" | "definitions" | "definitionMetadata" | "definitionPublications" | "research"
>;

function briefPath(key: string): string {
  return `evals/learning-briefs/${key}.json`;
}

function manifestPath(reference: CapabilityRevisionRef): string {
  return `${reference.capabilityId}/${reference.capabilityRevisionId}/manifest.json`;
}

function parseCapabilityRevision(value: unknown): CapabilityRevision {
  const parsed = CapabilityRevisionSchema.parse(value);
  const { predecessorRevisionId, dependencyLock, ...required } = parsed;
  return Object.freeze({
    ...required,
    ...(predecessorRevisionId === undefined ? {} : { predecessorRevisionId }),
    ...(dependencyLock === undefined ? {} : { dependencyLock }),
  });
}

async function readBrief(workspace: DurableWorkspace, reference: FileRevisionRef): Promise<ExperimentBrief> {
  return ExperimentBriefSchema.parse(
    JSON.parse(decoder.decode(await workspace.reads.readRevision(reference))),
  );
}

export function createWorkspaceExperimentBriefStore(workspace: DurableWorkspace): ExperimentBriefStore {
  const requireSamePublication = (existing: ExperimentBrief, requested: ExperimentBrief) => {
    if (canonicalJson(existing) !== canonicalJson(requested))
      throw experimentBriefPublicationCollisionError(requested.hypothesisDedupeKey);
    return existing;
  };
  return Object.freeze({
    findByDedupeKey: async (key: string) => {
      const current = await workspace.definitionMetadata.getCurrent(namespace, key);
      return current ? await readBrief(workspace, current.definitionRevision) : undefined;
    },
    put: async (brief: ExperimentBrief) => {
      const value = ExperimentBriefSchema.parse(brief);
      const current = await workspace.definitionMetadata.getCurrent(namespace, value.hypothesisDedupeKey);
      if (current) {
        const existing = await readBrief(workspace, current.definitionRevision);
        return requireSamePublication(existing, value);
      }
      const result = await workspace.definitionPublications.publish({
        namespace,
        definitionId: value.hypothesisDedupeKey,
        revision: 1,
        workingPath: briefPath(value.hypothesisDedupeKey),
        bytes: encoder.encode(canonicalJson(value)),
        sensitivity: "private",
        provenanceRefs: value.evidenceRefs,
        activity: {
          kind: "learning.brief_publish",
          actor,
          reason: `Durable experiment brief ${value.experimentId}`,
        },
      });
      if (!result.ok) {
        const winner = await workspace.definitionMetadata.getCurrent(namespace, value.hypothesisDedupeKey);
        if (!winner) throw new Error(result.error.message);
        return requireSamePublication(await readBrief(workspace, winner.definitionRevision), value);
      }
      return value;
    },
    replace: async (input: { readonly expectedExperimentId: string; readonly brief: ExperimentBrief }) => {
      const { expectedExperimentId, brief } = input;
      const value = ExperimentBriefSchema.parse(brief);
      const current = await workspace.definitionMetadata.getCurrent(namespace, value.hypothesisDedupeKey);
      if (!current) throw new Error(`Experiment brief replacement has no current publication`);
      const existing = await readBrief(workspace, current.definitionRevision);
      if (existing.experimentId !== expectedExperimentId)
        throw experimentBriefPublicationCollisionError(value.hypothesisDedupeKey);
      const result = await workspace.definitionPublications.publish({
        namespace,
        definitionId: value.hypothesisDedupeKey,
        revision: current.revision + 1,
        workingPath: briefPath(value.hypothesisDedupeKey),
        bytes: encoder.encode(canonicalJson(value)),
        expectedCurrentRevisionId: current.definitionRevision.revisionId,
        sensitivity: "private",
        provenanceRefs: value.evidenceRefs,
        activity: {
          kind: "learning.brief_replace",
          actor,
          reason: `Revise durable experiment brief ${value.experimentId}`,
        },
      });
      if (!result.ok) {
        const winner = await workspace.definitionMetadata.getCurrent(namespace, value.hypothesisDedupeKey);
        if (winner) {
          const published = await readBrief(workspace, winner.definitionRevision);
          if (canonicalJson(published) === canonicalJson(value)) return published;
        }
        throw experimentBriefPublicationCollisionError(value.hypothesisDedupeKey, result.error);
      }
      return value;
    },
  });
}

export function createWorkspaceLearningCandidateManifestStore(
  workspace: DurableWorkspace,
): LearningCandidateManifestStore & {
  readonly rehydrate: (experimentId: string) => Promise<RehydratedLearningCandidate | undefined>;
} {
  const persist: LearningCandidateManifestStore["persist"] = async (input) => {
    const manifest = CandidateManifestSchema.parse({
      schemaVersion: 1,
      kind: "learning_candidate_revision",
      brief: input.brief,
      revision: input.revision,
      revisionRef: input.revisionRef,
      researchRefs: {
        experiment: { kind: "database_row", table: "experiments", rowId: input.brief.experimentId },
        feedbackSignals: input.brief.feedbackSignalIds.map((rowId) => ({
          kind: "database_row" as const,
          table: "feedback_signals" as const,
          rowId,
        })),
        evidenceRefs: input.brief.evidenceRefs,
      },
    });
    if (!sameCapabilityRevisionRef(manifest.revisionRef, input.revisionRef))
      throw new Error("Candidate manifest revision identity changed during validation");
    return await workspace.definitions.recordCandidateDefinition({
      workingPath: manifestPath(manifest.revisionRef),
      bytes: encoder.encode(canonicalJson(manifest)),
      actor,
      reason: `Restartable candidate manifest for ${manifest.brief.experimentId}`,
      provenanceRefs: manifest.brief.evidenceRefs,
      sensitivity: "private",
    });
  };

  const rehydrate = async (experimentId: string): Promise<RehydratedLearningCandidate | undefined> => {
    const experiment = await workspace.research.experiments.getExperiment(experimentId);
    if (!experiment) return undefined;
    const manifestRefs = experiment.evidenceRefs.filter(
      (reference): reference is FileRevisionRef =>
        reference.kind === "file_revision" && reference.workingPath.endsWith("/manifest.json"),
    );
    if (
      experiment.status === "hypothesis" &&
      experiment.candidateRevisions.length === 0 &&
      manifestRefs.length === 0
    )
      return undefined;
    if (manifestRefs.length !== 1)
      throw new Error(`Experiment ${experimentId} must reference exactly one candidate manifest`);
    const manifestRevision = manifestRefs[0];
    if (!manifestRevision) throw new Error(`Experiment ${experimentId} is missing its candidate manifest`);
    const manifest = CandidateManifestSchema.parse(
      JSON.parse(decoder.decode(await workspace.reads.readRevision(manifestRevision))),
    );
    const revision = parseCapabilityRevision(manifest.revision);
    const expectedCandidate = experiment.candidateRevisions[0];
    if (
      manifest.brief.experimentId !== experimentId ||
      manifest.researchRefs.experiment.rowId !== experimentId ||
      experiment.candidateRevisions.length !== 1 ||
      !expectedCandidate ||
      !sameCapabilityRevisionRef(manifest.revisionRef, expectedCandidate) ||
      !sameCapabilityRevisionRef(capabilityRevisionRef(revision), manifest.revisionRef)
    )
      throw new Error(
        `Candidate manifest for ${experimentId} does not match authoritative experiment identity`,
      );
    return Object.freeze({
      brief: manifest.brief,
      revision,
      revisionRef: manifest.revisionRef,
      experiment,
      manifestRevision,
    });
  };

  return Object.freeze({ persist, rehydrate });
}

export interface DurableAutomaticLearningOrganOptions
  extends Omit<
    AutomaticLearningOrganOptions,
    "briefs" | "candidateDefinitions" | "experiments" | "feedbackSignals" | "candidateManifests"
  > {
  readonly workspace: DurableWorkspace;
}

export function createDurableAutomaticLearningOrgan(
  options: DurableAutomaticLearningOrganOptions,
): AutomaticLearningOrgan {
  const manifests = createWorkspaceLearningCandidateManifestStore(options.workspace);
  return createAutomaticLearningOrgan({
    ...options,
    feedbackSignals: options.workspace.research.feedbackSignals,
    briefs: createWorkspaceExperimentBriefStore(options.workspace),
    candidateDefinitions: options.workspace.definitions,
    experiments: options.workspace.research.experiments,
    candidateManifests: manifests,
  });
}
