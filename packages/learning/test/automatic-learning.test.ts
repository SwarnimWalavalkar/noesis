import type { AgentRunRequest, StructuredInferencePort } from "@noesis/agent-types";
import { type CapabilityRevisionConstruction, createAtomicCapabilityRegistry } from "@noesis/capabilities";
import type {
  CreateUserCriterionInput,
  UserCriterionError,
  UserCriterionReadModel,
  UserCriterionRepository,
} from "@noesis/config";
import {
  type Capability,
  capabilityRevisionRef,
  type DatabaseRowRef,
  type DefinitionWriteRequest,
  type EvidenceRef,
  type Experiment,
  type ExperimentStorePort,
  err,
  type FeedbackSignal,
  type FeedbackSignalStorePort,
  type FileRevisionRef,
  ok,
  type Result,
  sha256,
  WORKING_ADJUSTMENT_LIMITS,
} from "@noesis/domain";
import type { ExactCitation, HistoryPort, HistorySearchRequest } from "@noesis/intelligence";
import { describe, expect, test } from "vitest";
import {
  type AutomaticLearningConfig,
  AutomaticLearningConfigSchema,
  createAutomaticLearningOrgan,
  createInMemoryExperimentBriefStore,
  type ExperimentBrief,
  type ExperimentBriefStore,
  experimentBriefPublicationCollisionError,
  LearningTurnInputSchema,
  ReflectorOutputSchema,
  RevisionAuthorOutputSchema,
} from "../src/index.ts";
import {
  createScriptedLearningInferencePort,
  type ScriptedLearningInferencePort,
  type ScriptedLearningInferenceStep,
} from "./support/scripted-learning-inference.ts";

const capability: Capability = Object.freeze({
  capabilityId: "writing-assistance",
  name: "Writing assistance",
  scope: "writing",
  intent: "Help with evidence-grounded writing",
});

function fileRef(name: string): FileRevisionRef {
  return Object.freeze({
    kind: "file_revision",
    revisionId: `revision-${name}`,
    workingPath: `definitions/candidates/${name}`,
    snapshotPath: `revisions/${name}`,
    contentDigest: sha256(name),
  });
}

const reflectorPrompt = fileRef("reflector-prompt.md");
const authorPrompt = fileRef("author-prompt.md");
const revisionPrompt = fileRef("revision-prompt.md");

const config: AutomaticLearningConfig = Object.freeze({
  schemaVersion: 1,
  enabled: true,
  notifications: "quiet",
  retrieval: Object.freeze({
    maxResults: 2,
    lexicalLimit: 4,
    semanticLimit: 3,
    maxExcerptChars: 240,
    recurrenceThreshold: 2,
  }),
  roles: Object.freeze({
    reflector: Object.freeze({
      variant: Object.freeze({
        variantId: "reflector-v1",
        axis: "role",
        configurationRefs: Object.freeze([reflectorPrompt]),
      }),
      promptRevision: reflectorPrompt,
      model: "scripted-reflector-1",
      reasoning: "medium",
    }),
    revisionAuthor: Object.freeze({
      variant: Object.freeze({
        variantId: "revision-author-v1",
        axis: "role",
        configurationRefs: Object.freeze([authorPrompt]),
      }),
      promptRevision: authorPrompt,
      model: "scripted-author-1",
      reasoning: "high",
    }),
    revisionAgent: Object.freeze({
      variant: Object.freeze({
        variantId: "revision-agent-v1",
        axis: "role",
        configurationRefs: Object.freeze([revisionPrompt]),
      }),
      promptRevision: revisionPrompt,
      model: "scripted-reviser-1",
      reasoning: "xhigh",
    }),
  }),
});

function citation(index: number, excerpt = `prior correction ${index}`): ExactCitation {
  return Object.freeze({
    source: Object.freeze({
      kind: "database_row",
      table: "messages",
      rowId: `prior-message-${index}`,
      field: "content",
    }),
    occurredAt: `2026-01-0${index}T00:00:00.000Z`,
    excerpt,
    startOffset: 0,
    endOffset: excerpt.length,
    contentDigest: sha256(excerpt),
  });
}

function outcomeCitation(rowId: string, excerpt: string): ExactCitation {
  return Object.freeze({
    source: Object.freeze({ kind: "database_row", table: "outcomes", rowId, field: "summary" }),
    occurredAt: "2026-01-08T00:00:00.000Z",
    excerpt,
    startOffset: 0,
    endOffset: excerpt.length,
    contentDigest: sha256(excerpt),
  });
}

function experimentCitation(rowId: string, excerpt: string): ExactCitation {
  return Object.freeze({
    source: Object.freeze({ kind: "database_row", table: "experiments", rowId, field: "data_json" }),
    occurredAt: "2026-01-08T00:00:00.000Z",
    excerpt,
    startOffset: 0,
    endOffset: excerpt.length,
    contentDigest: sha256(excerpt),
  });
}

function fileRevisionCitation(revisionId: string, excerpt: string): ExactCitation {
  return Object.freeze({
    source: Object.freeze({ kind: "file_revision", revisionId, field: "bytes" }),
    occurredAt: "2026-01-09T00:00:00.000Z",
    excerpt,
    startOffset: 0,
    endOffset: excerpt.length,
    contentDigest: sha256(excerpt),
  });
}

function databaseRef(rowId: string): DatabaseRowRef<"messages"> {
  return Object.freeze({ kind: "database_row", table: "messages", rowId });
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (current >= 0xdc00 && current <= 0xdfff) return true;
  }
  return false;
}

function createHistoryHarness(citations: readonly ExactCitation[]) {
  const requests: HistorySearchRequest[] = [];
  const history: Pick<HistoryPort, "search" | "resolve"> = Object.freeze({
    search: async (request: HistorySearchRequest) => {
      requests.push(request);
      const selected = citations.slice(0, request.limit);
      return Object.freeze({
        query: request.query,
        hits: Object.freeze(
          selected.map((item, index) => Object.freeze({ citation: item, combinedScore: 1 - index * 0.1 })),
        ),
        candidateCount: citations.length,
        appliedBounds: Object.freeze({
          lexicalLimit: request.lexicalLimit ?? 0,
          semanticLimit: request.semanticLimit ?? 0,
          rerankLimit: selected.length,
          resultLimit: selected.length,
          maxExcerptChars: request.maxExcerptChars ?? 240,
        }),
      });
    },
    resolve: async (values: readonly ExactCitation[]) => Object.freeze([...values]),
  });
  return Object.freeze({ history, requests: () => Object.freeze([...requests]) });
}

function createFeedbackHarness() {
  const signals: FeedbackSignal[] = [];
  return Object.freeze({
    port: Object.freeze({
      getFeedbackSignal: async (signalId: string) => signals.find((signal) => signal.signalId === signalId),
      listFeedbackSignals: async (request: Parameters<FeedbackSignalStorePort["listFeedbackSignals"]>[0]) =>
        Object.freeze(
          signals
            .filter(
              (signal) => request.experimentId === undefined || signal.experimentId === request.experimentId,
            )
            .slice(0, request.limit),
        ),
      recordFeedbackSignal: async (signal: FeedbackSignal) => {
        const existing = signals.find((candidate) => candidate.signalId === signal.signalId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(signal)) {
          throw new Error(`Feedback signal ${signal.signalId} changed`);
        }
        if (!existing) signals.push(signal);
        return Object.freeze({
          kind: "database_row" as const,
          table: "feedback_signals" as const,
          rowId: signal.signalId,
        });
      },
    }),
    signals: () => Object.freeze([...signals]),
  });
}

function criterionModel(
  input: CreateUserCriterionInput & { readonly criterionId: string },
): UserCriterionReadModel {
  const definitionRevision = fileRef(`criterion-${input.criterionId}.json`);
  return Object.freeze({
    definition: Object.freeze({
      kind: "user_evaluation_criterion",
      criterionId: input.criterionId,
      revision: 1,
      status: "active",
      source: input.source,
      scope: input.scope,
      evaluatorInstruction: input.evaluatorInstruction,
      evidenceRefs: Object.freeze([...input.evidenceRefs]),
      promptOwnership: Object.freeze({ owner: "user", layer: "learned_profile" }),
      pinned: false,
    }),
    metadata: Object.freeze({
      criterionId: input.criterionId,
      revision: 1,
      definitionRevision,
      fileRevisionRow: Object.freeze({
        kind: "database_row",
        table: "file_revisions",
        rowId: definitionRevision.revisionId,
      }),
      activityRow: Object.freeze({
        kind: "database_row",
        table: "activity_log",
        rowId: `activity-${input.criterionId}`,
      }),
    }),
  });
}

function createCriteriaHarness() {
  const values = new Map<string, UserCriterionReadModel>();
  const creates: CreateUserCriterionInput[] = [];
  const repository: Pick<UserCriterionRepository, "create" | "inspect"> = Object.freeze({
    create: async (
      input: CreateUserCriterionInput,
    ): Promise<Result<UserCriterionReadModel, UserCriterionError>> => {
      creates.push(input);
      const criterionId = input.criterionId;
      if (!criterionId) return err({ code: "invalid_definition", message: "missing ID" });
      if (values.has(criterionId)) {
        return err({ code: "already_exists", message: "already exists", criterionId });
      }
      const model = criterionModel({ ...input, criterionId });
      values.set(criterionId, model);
      return ok(model);
    },
    inspect: async (criterionId: string): Promise<Result<UserCriterionReadModel, UserCriterionError>> => {
      const value = values.get(criterionId);
      return value ? ok(value) : err({ code: "not_found", message: "not found", criterionId });
    },
  });
  return Object.freeze({
    repository,
    creates: () => Object.freeze([...creates]),
    values: () => Object.freeze([...values.values()]),
  });
}

function baselineConstruction(): CapabilityRevisionConstruction {
  return Object.freeze({
    definitionState: "candidate",
    capabilityRevisionId: "baseline-revision",
    capabilityId: capability.capabilityId,
    promptModules: Object.freeze([fileRef("baseline-prompt.md")]),
    skills: Object.freeze([fileRef("baseline-skill.md")]),
    tools: Object.freeze([fileRef("baseline-tool.mjs")]),
    routerRevision: fileRef("baseline-router.json"),
    routerStrategyId: "baseline-router",
    activationPolicy: Object.freeze({ mode: "automatic_low_risk", scope: capability.scope }),
    permissionManifest: Object.freeze({
      effects: Object.freeze(["read"]),
      resourcePatterns: Object.freeze(["workspace:"]),
      credentialRefs: Object.freeze([]),
    }),
    evidenceRefs: Object.freeze([]),
    sourceEvaluationDefinitions: Object.freeze([fileRef("baseline-source-case.json")]),
    requestedPermissionDelta: Object.freeze({
      addedEffects: Object.freeze([]),
      widenedResources: Object.freeze([]),
      addedCredentialRefs: Object.freeze([]),
    }),
  });
}

function createCandidateDefinitionHarness() {
  const requests: DefinitionWriteRequest[] = [];
  return Object.freeze({
    port: Object.freeze({
      recordCandidateDefinition: async (request: DefinitionWriteRequest): Promise<FileRevisionRef> => {
        requests.push(request);
        const sequence = requests.length;
        const contentDigest = sha256(request.bytes);
        return Object.freeze({
          kind: "file_revision",
          revisionId: `candidate-file-${sequence}`,
          workingPath: `definitions/candidates/${request.workingPath}`,
          snapshotPath: `revisions/candidate-file-${sequence}`,
          contentDigest,
        });
      },
    }),
    requests: () => Object.freeze([...requests]),
  });
}

const reflectionStep = Object.freeze({
  role: "reflector" as const,
  value: Object.freeze({
    observation: Object.freeze({ kind: "correction" as const, reason: "The user corrects prior behavior." }),
    decision: "experiment" as const,
    title: "Preserve writing intent",
    hypothesis: "A scoped writing capability can apply corrections consistently",
    scope: "writing",
    anticipatedFutureUse: "When rewriting future prose in the user's writing workflow.",
    scopeRelationship: "same" as const,
    scopeRationale: "The evidence concerns the same writing capability and does not support a wider scope.",
    staleOrContradictionConditions: Object.freeze([
      "The user rejects this behavior in a later writing task.",
    ]),
    capabilityName: "Writing assistance",
    capabilityIntent: "Apply evidence-grounded writing corrections",
    recurrenceEvidenceCitationIndexes: Object.freeze([0]),
    sourceCases: Object.freeze([
      Object.freeze({
        title: "Apply the observed correction",
        input: "Rewrite this paragraph",
        expectedBehavior: "Preserve the requested voice and cite primary evidence",
      }),
    ]),
  }),
}) satisfies ScriptedLearningInferenceStep;

function scopeVerificationStep(relationship: "same" | "narrower" | "broader"): ScriptedLearningInferenceStep {
  return Object.freeze({
    role: "reflector" as const,
    value: Object.freeze({
      relationship,
      reason: `Independent scope verification classified the proposal as ${relationship}.`,
    }),
  });
}

function withScopeVerification(
  steps: readonly ScriptedLearningInferenceStep[],
  relationships: readonly ("same" | "narrower" | "broader")[] = [],
): readonly ScriptedLearningInferenceStep[] {
  let experimentIndex = 0;
  return Object.freeze(
    steps.flatMap((step) => {
      const reflected = ReflectorOutputSchema.safeParse(step.value);
      if (!reflected.success || reflected.data.decision !== "experiment") return [step];
      const relationship = relationships[experimentIndex] ?? reflected.data.scopeRelationship;
      experimentIndex += 1;
      return [step, scopeVerificationStep(relationship)];
    }),
  );
}

const authorStep = Object.freeze({
  role: "revision_author" as const,
  value: Object.freeze({
    promptModules: Object.freeze([
      Object.freeze({ path: "voice.md", content: "Preserve the user's voice." }),
    ]),
    skills: Object.freeze([
      Object.freeze({ path: "SKILL.md", content: "Apply scoped writing corrections." }),
    ]),
    tools: Object.freeze([
      Object.freeze({ path: "rewrite.mjs", content: "export const rewrite = (text) => text;" }),
    ]),
    router: Object.freeze({
      path: "router.json",
      content: '{"when":"writing"}',
      strategyId: "writing-router-v2",
    }),
    activationPolicy: Object.freeze({ mode: "automatic_low_risk", scope: "writing" }),
    permissionManifest: Object.freeze({
      effects: Object.freeze(["read"]),
      resourcePatterns: Object.freeze(["workspace:"]),
      credentialRefs: Object.freeze([]),
    }),
    sourceEvaluationDefinitions: Object.freeze([
      Object.freeze({ path: "source-case.json", content: '{"kind":"source"}' }),
    ]),
    requestedPermissionDelta: Object.freeze({
      addedEffects: Object.freeze([]),
      widenedResources: Object.freeze([]),
      addedCredentialRefs: Object.freeze([]),
    }),
  }),
}) satisfies ScriptedLearningInferenceStep;

const revisionStep = Object.freeze({
  ...authorStep,
  role: "revision_agent" as const,
}) satisfies ScriptedLearningInferenceStep;

function turn(input: {
  readonly turnId?: string;
  readonly userMessage?: string;
  readonly correction?: string;
  readonly outcome?: "accepted" | "corrected" | "failed" | "unknown";
  readonly evidenceRef?: EvidenceRef;
}) {
  return Object.freeze({
    sessionId: "session-1",
    turnId: input.turnId ?? "turn-1",
    project: Object.freeze({ projectId: "project-noesis", root: "/work/noesis" }),
    expectedActiveAdjustmentId: null,
    servedWorkingAdjustmentOutcomes: Object.freeze([]),
    scope: "writing",
    userMessage: input.userMessage ?? "Please rewrite this paragraph",
    ...(input.correction ? { correction: input.correction } : {}),
    outcome: input.outcome ?? "corrected",
    occurredAt: "2026-01-10T00:00:00.000Z",
    evidenceRefs: Object.freeze([input.evidenceRef ?? databaseRef("current-message")]),
    sensitivity: "normal" as const,
    telemetry: Object.freeze({ retryCount: 0, toolFailureCount: 0, aborted: false }),
  });
}

function sequentialIds() {
  const counts = new Map<string, number>();
  return (prefix: string) => {
    const next = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, next);
    return `${prefix}-${next}`;
  };
}

function createHarness(input: {
  readonly steps: readonly ScriptedLearningInferenceStep[];
  readonly citations?: readonly ExactCitation[];
  readonly briefs?: ExperimentBriefStore;
  readonly inference?: ScriptedLearningInferencePort;
  readonly experimentState?: ReturnType<typeof createExperimentState>;
  readonly scopeVerificationRelationships?: readonly ("same" | "narrower" | "broader")[];
}) {
  const history = createHistoryHarness(input.citations ?? []);
  const feedback = createFeedbackHarness();
  const criteria = createCriteriaHarness();
  const inference =
    input.inference ??
    createScriptedLearningInferencePort({
      steps: withScopeVerification(input.steps, input.scopeVerificationRelationships),
    });
  const registry = createAtomicCapabilityRegistry();
  registry.registerCapability(capability);
  const baseline = registry.constructRevision(baselineConstruction());
  const candidates = createCandidateDefinitionHarness();
  const experimentState = input.experimentState ?? createExperimentState();
  const organ = createAutomaticLearningOrgan({
    config,
    history: history.history,
    feedbackSignals: feedback.port,
    inference,
    briefs: input.briefs ?? createInMemoryExperimentBriefStore(),
    capabilities: registry,
    candidateDefinitions: candidates.port,
    experiments: experimentState.port,
    nextId: sequentialIds(),
  });
  return Object.freeze({
    organ,
    baseline,
    registry,
    history,
    feedback,
    criteria,
    inference,
    candidates,
    experiments: experimentState.values,
    putExperiment: experimentState.port.putExperiment,
  });
}

function createExperimentState() {
  const experiments: Experiment[] = [];
  const port: ExperimentStorePort = Object.freeze({
    getExperiment: async (experimentId: string) =>
      experiments.find((experiment) => experiment.experimentId === experimentId),
    listExperiments: async (request: Parameters<ExperimentStorePort["listExperiments"]>[0]) =>
      Object.freeze(
        experiments
          .filter((experiment) => request.status === undefined || experiment.status === request.status)
          .slice(0, request.limit),
      ),
    putExperiment: async (experiment: Experiment) => {
      const index = experiments.findIndex((candidate) => candidate.experimentId === experiment.experimentId);
      const existing = index === -1 ? undefined : experiments[index];
      const value = existing
        ? Object.freeze({
            ...experiment,
            evidenceRefs: Object.freeze([
              ...new Map(
                [...existing.evidenceRefs, ...experiment.evidenceRefs].map((reference) => [
                  JSON.stringify(reference),
                  reference,
                ]),
              ).values(),
            ]),
            feedbackSignalIds: Object.freeze([
              ...new Set([...existing.feedbackSignalIds, ...experiment.feedbackSignalIds]),
            ]),
          })
        : experiment;
      if (index === -1) experiments.push(value);
      else experiments[index] = value;
      return Object.freeze({
        kind: "database_row" as const,
        table: "experiments" as const,
        rowId: experiment.experimentId,
      });
    },
  });
  return Object.freeze({ port, values: () => Object.freeze([...experiments]) });
}

function createContendedBriefStore(initial: ExperimentBrief) {
  let current = initial;
  let initialReads = 0;
  let collisions = 0;
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const port: ExperimentBriefStore = Object.freeze({
    findByDedupeKey: async (key: string) => {
      if (key !== current.hypothesisDedupeKey) return undefined;
      if (initialReads >= 2) return current;
      const observed = current;
      initialReads += 1;
      if (initialReads === 2) release();
      await barrier;
      return observed;
    },
    put: async (brief: ExperimentBrief) => {
      current = brief;
      return brief;
    },
    replace: async ({ expectedExperimentId, brief }: Parameters<ExperimentBriefStore["replace"]>[0]) => {
      if (current.experimentId !== expectedExperimentId) {
        collisions += 1;
        throw experimentBriefPublicationCollisionError(brief.hypothesisDedupeKey);
      }
      current = brief;
      return brief;
    },
  });
  return Object.freeze({ port, current: () => current, collisions: () => collisions });
}

function createContendedInitialBriefStore() {
  let current: ExperimentBrief | undefined;
  let dedupeKey: string | undefined;
  let initialReads = 0;
  let collisions = 0;
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const port: ExperimentBriefStore = Object.freeze({
    findByDedupeKey: async (key: string) => {
      dedupeKey ??= key;
      if (key !== dedupeKey) return undefined;
      if (initialReads >= 2) return current;
      const observed = current;
      initialReads += 1;
      if (initialReads === 2) release();
      await barrier;
      return observed;
    },
    put: async (brief: ExperimentBrief) => {
      if (current) {
        if (JSON.stringify(current) === JSON.stringify(brief)) return current;
        collisions += 1;
        throw experimentBriefPublicationCollisionError(brief.hypothesisDedupeKey);
      }
      current = brief;
      return brief;
    },
    replace: async ({ expectedExperimentId, brief }: Parameters<ExperimentBriefStore["replace"]>[0]) => {
      if (!current || current.experimentId !== expectedExperimentId) {
        collisions += 1;
        throw experimentBriefPublicationCollisionError(brief.hypothesisDedupeKey);
      }
      current = brief;
      return brief;
    },
  });
  return Object.freeze({ port, current: () => current, collisions: () => collisions });
}

function createBarrierInference(
  steps: readonly ScriptedLearningInferenceStep[],
): ScriptedLearningInferencePort {
  const base = createScriptedLearningInferencePort({ steps });
  let entrants = 0;
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run: StructuredInferencePort["run"] = async (request, schema) => {
    entrants += 1;
    if (entrants === 2) release();
    await barrier;
    return await base.run(request, schema);
  };
  return Object.freeze({ run, requests: base.requests, remaining: base.remaining });
}

describe("automatic learning organ", () => {
  test("bounds working-adjustment model output and served outcome context at the durable job boundary", () => {
    const exactDecision = {
      observation: {
        kind: "correction" as const,
        reason: "o".repeat(WORKING_ADJUSTMENT_LIMITS.observationChars),
      },
      decision: "apply_working_adjustment" as const,
      expectedActiveAdjustmentId: null,
      rationale: "r".repeat(WORKING_ADJUSTMENT_LIMITS.observationChars),
      strategy: "s".repeat(WORKING_ADJUSTMENT_LIMITS.strategyChars),
      successSignal: "x".repeat(WORKING_ADJUSTMENT_LIMITS.successSignalChars),
      evidenceCitationIndexes: [0],
    };
    expect(ReflectorOutputSchema.safeParse(exactDecision).success).toBe(true);
    expect(
      ReflectorOutputSchema.safeParse({
        ...exactDecision,
        strategy: `${exactDecision.strategy}x`,
      }).success,
    ).toBe(false);
    expect(
      ReflectorOutputSchema.safeParse({
        ...exactDecision,
        rationale: `${exactDecision.rationale}x`,
      }).success,
    ).toBe(false);
    expect(
      ReflectorOutputSchema.safeParse({
        ...exactDecision,
        successSignal: `${exactDecision.successSignal}x`,
      }).success,
    ).toBe(false);
    expect(
      ReflectorOutputSchema.safeParse({
        ...exactDecision,
        observation: { ...exactDecision.observation, reason: `${exactDecision.observation.reason}x` },
      }).success,
    ).toBe(false);

    const base = turn({ turnId: "turn-bounded-evidence" });
    const parsed = LearningTurnInputSchema.parse({
      ...base,
      servedWorkingAdjustmentOutcomes: Array.from({ length: 8 }, (_, outcomeIndex) => ({
        adjustmentId: "adjustment-active",
        planId: `plan-${outcomeIndex}`,
        sessionId: `session-${outcomeIndex}`,
        turnId: `served-turn-${outcomeIndex}`,
        outcomeId: `outcome-${outcomeIndex}`,
        outcome: "accepted" as const,
        summary: "q".repeat(1_000),
        settledAt: "2026-01-10T00:00:00.000Z",
        evidenceRefs: Array.from({ length: 10 }, (_, referenceIndex) =>
          databaseRef(`served-${outcomeIndex}-${referenceIndex}`),
        ),
      })),
    });

    expect(
      parsed.servedWorkingAdjustmentOutcomes.reduce((total, outcome) => total + outcome.summary.length, 0),
    ).toBe(2_048);
    expect(parsed.servedWorkingAdjustmentOutcomes.flatMap((outcome) => outcome.evidenceRefs)).toHaveLength(
      WORKING_ADJUSTMENT_LIMITS.evidenceRefs,
    );
    expect(
      new Set(
        parsed.servedWorkingAdjustmentOutcomes
          .flatMap((outcome) => outcome.evidenceRefs)
          .map((reference) => JSON.stringify(reference)),
      ).size,
    ).toBe(WORKING_ADJUSTMENT_LIMITS.evidenceRefs);
  });

  test("keeps automatic-learning configuration on schema version 1", () => {
    expect(AutomaticLearningConfigSchema.safeParse(config).success).toBe(true);
    expect(AutomaticLearningConfigSchema.safeParse({ ...config, schemaVersion: 2 }).success).toBe(false);
  });

  test("turns a normal correction into one bounded evidence-linked experiment brief", async () => {
    const harness = createHarness({
      steps: [reflectionStep],
      citations: [citation(1), citation(2), citation(3)],
    });
    const result = await harness.organ.observeTurn({
      turn: turn({ correction: "Use primary sources, not summaries." }),
      baselineRevision: harness.baseline,
      capability,
    });

    expect(result.status).toBe("experiment");
    if (result.status !== "experiment") throw new Error("Expected an experiment brief");
    expect(result.harvest.signals).toHaveLength(1);
    expect(harness.feedback.signals()).toHaveLength(1);
    expect(result.brief.feedbackSignalIds).toEqual([result.harvest.signals[0]?.signal.signalId]);
    expect(result.brief.evidenceRefs).toEqual([
      databaseRef("current-message"),
      databaseRef("prior-message-1"),
      databaseRef("prior-message-2"),
    ]);
    expect(result.brief.citations).toHaveLength(2);
    expect(result.brief.recurrenceCount).toBe(1);
    expect(result.brief).toMatchObject({
      anticipatedFutureUse: "When rewriting future prose in the user's writing workflow.",
      scopeRelationship: "same",
      scopeRationale: "The evidence concerns the same writing capability and does not support a wider scope.",
      staleOrContradictionConditions: ["The user rejects this behavior in a later writing task."],
    });
    expect(harness.experiments()).toEqual([
      expect.objectContaining({ experimentId: result.brief.experimentId, status: "hypothesis" }),
    ]);
    expect(result.notification).toEqual({
      mode: "quiet",
      kind: "experiment",
      message: "Learning experiment ready: Preserve writing intent",
    });
    expect(result.interruption).toBeNull();
    expect(harness.criteria.creates()).toHaveLength(0);
    expect(harness.history.requests()[0]).toMatchObject({
      limit: 2,
      lexicalLimit: 4,
      semanticLimit: 3,
      maxExcerptChars: 240,
      privacy: "normal",
    });
  });

  test("authors a narrow reflection as a new capability slot without claiming genesis lineage", async () => {
    const narrowReflection = Object.freeze({
      role: "reflector" as const,
      value: Object.freeze({
        observation: Object.freeze({
          kind: "correction" as const,
          reason: "The user corrects how research evidence should be presented.",
        }),
        decision: "experiment" as const,
        title: "Research brief evidence",
        hypothesis: "Research briefs should separate evidence from inference",
        scope: "research brief",
        anticipatedFutureUse: "When the user requests another evidence-grounded research brief.",
        scopeRelationship: "narrower" as const,
        scopeRationale: "The correction concerns research briefs, a narrower case than general writing.",
        staleOrContradictionConditions: Object.freeze([
          "The user requests a format where evidence and inference should intentionally be blended.",
        ]),
        capabilityName: "Research brief evidence",
        capabilityIntent: "Make research briefs evidence-grounded and explicit about inference",
        sourceCases: Object.freeze([
          Object.freeze({
            title: "Correct a research brief",
            input: "Prepare a research brief",
            expectedBehavior: "Separate sourced evidence from inference",
          }),
        ]),
      }),
    }) satisfies ScriptedLearningInferenceStep;
    const harness = createHarness({
      steps: [narrowReflection, authorStep],
      citations: [citation(1)],
    });
    const observed = await harness.organ.observeTurn({
      turn: turn({ correction: "No, in a research brief separate evidence from inference." }),
      baselineRevision: harness.baseline,
      capability,
    });
    if (observed.status !== "experiment") throw new Error("Expected a narrow experiment brief");

    expect(observed.brief.capability).toMatchObject({
      capabilityId: expect.stringMatching(/^learned-research-brief-evidence-[a-f0-9]{12}$/u),
      name: "Research brief evidence",
      scope: "research brief",
      intent: "Make research briefs evidence-grounded and explicit about inference",
    });
    expect(observed.brief.capability.capabilityId).not.toBe(capability.capabilityId);
    expect(observed.brief).toMatchObject({
      scopeRelationship: "narrower",
      verifiedScopeRelationship: "narrower",
      scopeVerificationReason: "Independent scope verification classified the proposal as narrower.",
    });

    const authored = await harness.organ.authorExperimentRevision({ brief: observed.brief });
    expect(authored.revision.capabilityId).toBe(observed.brief.capability.capabilityId);
    expect(authored.revision.predecessorRevisionId).toBeUndefined();
    expect(authored.experiment.baselineRevision).toEqual(harness.baseline);
    expect(
      harness.candidates.requests().every((request) => request.predecessorRevisionId === undefined),
    ).toBe(true);
  });

  test("rejects one-off broadening without the configured distinct recurrence evidence", async () => {
    const broadReflection = Object.freeze({
      ...reflectionStep,
      value: Object.freeze({
        ...reflectionStep.value,
        scope: "all collaboration",
        scopeRelationship: "broader" as const,
        scopeRationale: "The proposal would apply this behavior beyond writing.",
        anticipatedFutureUse: "Whenever the user asks for evidence-grounded work.",
        recurrenceEvidenceCitationIndexes: Object.freeze([0, 0]),
      }),
    }) satisfies ScriptedLearningInferenceStep;
    const harness = createHarness({ steps: [broadReflection], citations: [citation(1)] });

    await expect(
      harness.organ.observeTurn({
        turn: turn({ correction: "Use primary sources." }),
        baselineRevision: harness.baseline,
        capability,
      }),
    ).rejects.toThrow("Broader learning scope requires at least 2 distinct recurrence citations");
    expect(harness.experiments()).toHaveLength(0);
  });

  test("accepts broader scope when the reflector cites enough distinct recurrence evidence", async () => {
    const broadReflection = Object.freeze({
      ...reflectionStep,
      value: Object.freeze({
        ...reflectionStep.value,
        scope: "all collaboration",
        scopeRelationship: "broader" as const,
        scopeRationale: "Two distinct prior contexts support applying the behavior beyond writing.",
        anticipatedFutureUse: "Whenever the user asks for evidence-grounded work.",
        recurrenceEvidenceCitationIndexes: Object.freeze([0, 1]),
      }),
    }) satisfies ScriptedLearningInferenceStep;
    const harness = createHarness({
      steps: [broadReflection],
      citations: [citation(1), citation(2)],
    });

    const result = await harness.organ.observeTurn({
      turn: turn({ correction: "Use primary sources." }),
      baselineRevision: harness.baseline,
      capability,
    });

    if (result.status !== "experiment") throw new Error("Expected a broader experiment");
    expect(result.brief).toMatchObject({
      scope: "all collaboration",
      scopeRelationship: "broader",
      recurrenceCount: 2,
      anticipatedFutureUse: "Whenever the user asks for evidence-grounded work.",
    });
  });

  test("rejects a broad proposal that self-labels as narrower", async () => {
    const inconsistentReflection = Object.freeze({
      ...reflectionStep,
      value: Object.freeze({
        ...reflectionStep.value,
        scope: "all collaboration",
        scopeRelationship: "narrower" as const,
      }),
    }) satisfies ScriptedLearningInferenceStep;
    const harness = createHarness({
      steps: [inconsistentReflection],
      citations: [citation(1)],
      scopeVerificationRelationships: ["broader"],
    });

    await expect(
      harness.organ.observeTurn({
        turn: turn({ correction: "Use primary sources." }),
        baselineRevision: harness.baseline,
        capability,
      }),
    ).rejects.toThrow("disagrees with independent verification broader");
    expect(harness.experiments()).toHaveLength(0);
  });

  test("leaves normative interpretation to the reflector instead of creating a keyword criterion", async () => {
    const harness = createHarness({ steps: [reflectionStep], citations: [citation(1)] });
    const result = await harness.organ.observeTurn({
      turn: turn({ correction: "Always preserve my voice when editing." }),
      baselineRevision: harness.baseline,
      capability,
    });

    expect(result.status).toBe("experiment");
    expect(harness.criteria.creates()).toHaveLength(0);
    expect(harness.inference.requests()[0]?.messages[0]).toMatchObject({
      role: "user",
      name: "current_turn",
    });
    expect(result.notification).toEqual({
      mode: "quiet",
      kind: "experiment",
      message: "Learning experiment ready: Preserve writing intent",
    });
  });

  test("links an experiment to an active adjustment only when the reflector cites its evidence", async () => {
    const activeAdjustment = Object.freeze({
      adjustmentId: "adjustment-active",
      scope: Object.freeze({ projectId: "project-noesis", root: "/work/noesis" }),
      observation: "Success was claimed without checking observable state.",
      strategy: "Verify observable state before claiming success.",
      successSignal: "Success claims cite fresh runtime evidence.",
      evidenceRefs: Object.freeze([databaseRef("adjustment-source")]),
      createdFromTurnId: "turn-before",
    });
    const linkedStep = Object.freeze({
      ...reflectionStep,
      value: Object.freeze({
        ...reflectionStep.value,
        workingAdjustmentEvidenceCitationIndexes: Object.freeze([0]),
      }),
    });
    const linked = createHarness({ steps: [linkedStep], citations: [citation(1)] });
    const linkedTurn = turn({ turnId: "turn-linked", correction: "Verify the real state first." });
    const linkedResult = await linked.organ.observeTurn({
      turn: Object.freeze({
        ...linkedTurn,
        expectedActiveAdjustmentId: activeAdjustment.adjustmentId,
      }),
      baselineRevision: linked.baseline,
      capability,
      activeWorkingAdjustment: activeAdjustment,
    });
    if (linkedResult.status !== "experiment") throw new Error("Expected a linked experiment");

    expect(linkedResult.brief.sourceAdjustmentId).toBe(activeAdjustment.adjustmentId);
    expect(linked.experiments()[0]?.sourceAdjustmentId).toBe(activeAdjustment.adjustmentId);
    expect(linkedResult.brief.evidenceRefs).toContainEqual({
      kind: "database_row",
      table: "working_adjustments",
      rowId: activeAdjustment.adjustmentId,
    });

    const unlinked = createHarness({ steps: [reflectionStep], citations: [citation(1)] });
    const unlinkedTurn = turn({ turnId: "turn-unlinked", correction: "Use primary sources." });
    const unlinkedResult = await unlinked.organ.observeTurn({
      turn: Object.freeze({
        ...unlinkedTurn,
        expectedActiveAdjustmentId: activeAdjustment.adjustmentId,
      }),
      baselineRevision: unlinked.baseline,
      capability,
      activeWorkingAdjustment: activeAdjustment,
    });
    if (unlinkedResult.status !== "experiment") throw new Error("Expected an unrelated experiment");
    expect(unlinkedResult.brief.sourceAdjustmentId).toBeUndefined();
    expect(unlinked.experiments()[0]?.sourceAdjustmentId).toBeUndefined();
  });

  test("carries cited working-adjustment outcome evidence into revision-author source cases", async () => {
    const activeAdjustment = Object.freeze({
      adjustmentId: "adjustment-source-cases",
      scope: Object.freeze({ projectId: "project-noesis", root: "/work/noesis" }),
      observation: "Success was claimed without checking observable state.",
      strategy: "Verify observable state before claiming success.",
      successSignal: "Success claims cite fresh runtime evidence.",
      evidenceRefs: Object.freeze([databaseRef("adjustment-original-evidence")]),
      createdFromTurnId: "turn-before",
    });
    const citedServedOutcome = databaseRef("served-adjustment-outcome");
    const linkedStep = Object.freeze({
      ...reflectionStep,
      value: Object.freeze({
        ...reflectionStep.value,
        workingAdjustmentEvidenceCitationIndexes: Object.freeze([1]),
      }),
    });
    const harness = createHarness({ steps: [linkedStep, authorStep], citations: [citation(1)] });
    const observed = await harness.organ.observeTurn({
      turn: Object.freeze({
        ...turn({ turnId: "turn-adjustment-source-case", correction: "Verify the real state first." }),
        expectedActiveAdjustmentId: activeAdjustment.adjustmentId,
        servedWorkingAdjustmentOutcomes: Object.freeze([
          Object.freeze({
            adjustmentId: activeAdjustment.adjustmentId,
            planId: "plan-adjustment-source-case",
            sessionId: "session-before",
            turnId: "turn-served-adjustment",
            outcomeId: "outcome-served-adjustment",
            outcome: "accepted" as const,
            summary: "The verification strategy produced an evidence-backed completion.",
            settledAt: "2026-01-09T00:00:00.000Z",
            evidenceRefs: Object.freeze([citedServedOutcome]),
          }),
        ]),
      }),
      baselineRevision: harness.baseline,
      capability,
      activeWorkingAdjustment: activeAdjustment,
    });
    if (observed.status !== "experiment") throw new Error("Expected an adjustment-backed experiment");

    const expectedAdjustmentEvidence = Object.freeze({
      kind: "database_row" as const,
      table: "working_adjustments" as const,
      rowId: activeAdjustment.adjustmentId,
    });
    expect(observed.brief.sourceAdjustmentId).toBe(activeAdjustment.adjustmentId);
    expect(observed.brief.sourceCases[0]?.evidenceRefs).toEqual(observed.brief.evidenceRefs);
    expect(observed.brief.sourceCases[0]?.evidenceRefs).toContainEqual(expectedAdjustmentEvidence);
    expect(observed.brief.sourceCases[0]?.evidenceRefs).toContainEqual(citedServedOutcome);

    await harness.organ.authorExperimentRevision({ brief: observed.brief });
    const authorRequest = harness.inference.requests().find((request) => request.role === "revision_author");
    const sourceCasesMessage = authorRequest?.messages.find((message) => message.name === "source_cases");
    const authoredSourceCases: unknown = JSON.parse(sourceCasesMessage?.content ?? "null");
    expect(authoredSourceCases).toEqual(observed.brief.sourceCases);
  });

  test("lets the reflector return no change for ordinary chat", async () => {
    const harness = createHarness({
      steps: [
        Object.freeze({
          role: "reflector",
          value: Object.freeze({
            observation: Object.freeze({ kind: "other", reason: "This is ordinary conversation." }),
            decision: "no_change",
            reason: "No durable learning is useful.",
          }),
        }),
      ],
    });
    const result = await harness.organ.observeTurn({
      turn: turn({ userMessage: "Thanks, that looks good.", outcome: "accepted" }),
      baselineRevision: harness.baseline,
      capability,
    });

    expect(result).toMatchObject({ status: "no_change", reason: "reflector_no_change", interruption: null });
    expect(harness.history.requests()).toHaveLength(1);
    expect(harness.feedback.signals()).toHaveLength(0);
    expect(harness.criteria.creates()).toHaveLength(0);
    expect(harness.inference.requests()).toHaveLength(1);
  });

  test("returns a cited project working-adjustment decision without opening an experiment", async () => {
    const harness = createHarness({
      steps: [
        Object.freeze({
          role: "reflector",
          value: Object.freeze({
            observation: Object.freeze({
              kind: "correction",
              reason: "The completed turn lacked observable verification.",
            }),
            decision: "apply_working_adjustment",
            expectedActiveAdjustmentId: null,
            rationale: "Claims should be grounded in fresh runtime evidence.",
            strategy: "Verify observable state before claiming success.",
            successSignal: "Later success claims cite runtime evidence.",
            evidenceCitationIndexes: Object.freeze([0]),
          }),
        }),
      ],
    });
    const currentEvidence = Object.freeze(
      Array.from({ length: 40 }, (_, index) => databaseRef(`current-message-${index}`)),
    );
    const base = turn({ correction: "You said it worked without checking the actual state." });

    const result = await harness.organ.observeTurn({
      turn: Object.freeze({ ...base, evidenceRefs: currentEvidence }),
      baselineRevision: harness.baseline,
      capability,
    });

    expect(result).toMatchObject({
      status: "apply_working_adjustment",
      project: { projectId: "project-noesis" },
      expectedActiveAdjustmentId: null,
      strategy: "Verify observable state before claiming success.",
    });
    if (result.status !== "apply_working_adjustment") throw new Error("Expected an adjustment decision");
    expect(result.evidenceRefs).toHaveLength(WORKING_ADJUSTMENT_LIMITS.evidenceRefs);
    expect(result.evidenceRefs[0]).toEqual(databaseRef("current-message-0"));
    expect(harness.experiments()).toHaveLength(0);
    expect(harness.inference.requests()[0]?.messages.at(-1)).toMatchObject({
      name: "working_adjustment_context",
    });
  });

  test("does not duplicate current-turn message text in working-adjustment evidence context", async () => {
    const harness = createHarness({
      steps: [
        Object.freeze({
          role: "reflector",
          value: Object.freeze({
            observation: Object.freeze({ kind: "other", reason: "No adjustment is useful." }),
            decision: "no_change",
            reason: "The completed turn does not suggest a reusable change.",
          }),
        }),
      ],
    });
    const userMessage = `unique-user-message-${"u".repeat(20_000)}`;
    const assistantMessage = `unique-assistant-message-${"a".repeat(20_000)}`;

    await harness.organ.observeTurn({
      turn: Object.freeze({
        ...turn({ userMessage }),
        assistantMessage,
      }),
      baselineRevision: harness.baseline,
      capability,
    });

    const request = harness.inference.requests()[0];
    const currentTurnMessage = request?.messages.find((message) => message.name === "current_turn");
    const adjustmentContextMessage = request?.messages.find(
      (message) => message.name === "working_adjustment_context",
    );
    if (!currentTurnMessage || !adjustmentContextMessage)
      throw new Error("Expected reflector context messages");

    expect(currentTurnMessage.content).toContain(userMessage);
    expect(currentTurnMessage.content).toContain(assistantMessage);
    expect(adjustmentContextMessage.content).not.toContain(userMessage);
    expect(adjustmentContextMessage.content).not.toContain(assistantMessage);
    expect(adjustmentContextMessage.content).toContain('"kind":"current_turn"');
    expect(adjustmentContextMessage.content).toContain('"turnId":"turn-1"');
    expect(adjustmentContextMessage.content).toContain('"outcome":"corrected"');
    expect(adjustmentContextMessage.content.length).toBeLessThan(4_000);
  });

  test("keeps worst-case working-adjustment context below the reflector message policy without losing citation indexes", async () => {
    const activeAdjustmentId = `adjustment-${"d".repeat(4_000)}`;
    const promptAdjustmentIdentity = `${activeAdjustmentId.slice(0, 239)}…${sha256(activeAdjustmentId).slice(0, 16)}`;
    const servedEvidence = Array.from({ length: 8 }, (_, outcomeIndex) =>
      Object.freeze(
        Array.from({ length: 4 }, (_, referenceIndex) =>
          databaseRef(`served-${outcomeIndex}-${referenceIndex}-${"e".repeat(2_000)}`),
        ),
      ),
    );
    const lastServedEvidence = servedEvidence[7]?.[3];
    if (!lastServedEvidence) throw new Error("Expected worst-case served evidence");
    const harness = createHarness({
      steps: [
        Object.freeze({
          role: "reflector",
          value: Object.freeze({
            observation: Object.freeze({
              kind: "correction",
              reason: "The served strategy should be replaced.",
            }),
            decision: "apply_working_adjustment",
            expectedActiveAdjustmentId: promptAdjustmentIdentity,
            rationale: "The evidence supports a more useful strategy.",
            strategy: "Use the improved project strategy.",
            successSignal: "The next turn improves.",
            evidenceCitationIndexes: Object.freeze([8]),
          }),
        }),
      ],
    });
    const project = Object.freeze({
      projectId: `project-${"p".repeat(4_000)}`,
      root: `/work/${"r".repeat(4_000)}`,
    });
    const activeAdjustment = Object.freeze({
      adjustmentId: activeAdjustmentId,
      scope: project,
      observation: "o".repeat(WORKING_ADJUSTMENT_LIMITS.observationChars),
      strategy: "s".repeat(WORKING_ADJUSTMENT_LIMITS.strategyChars),
      successSignal: "x".repeat(WORKING_ADJUSTMENT_LIMITS.successSignalChars),
      evidenceRefs: Object.freeze(
        Array.from({ length: WORKING_ADJUSTMENT_LIMITS.evidenceRefs }, (_, index) =>
          databaseRef(`active-${index}-${"a".repeat(2_000)}`),
        ),
      ),
      createdFromTurnId: `turn-${"t".repeat(2_000)}`,
    });
    const base = turn({ turnId: "turn-worst-case-context" });

    const result = await harness.organ.observeTurn({
      turn: Object.freeze({
        ...base,
        project,
        expectedActiveAdjustmentId: activeAdjustmentId,
        servedWorkingAdjustmentOutcomes: Object.freeze(
          servedEvidence.map((evidenceRefs, outcomeIndex) =>
            Object.freeze({
              adjustmentId: activeAdjustmentId,
              planId: `plan-${outcomeIndex}-${"l".repeat(2_000)}`,
              sessionId: `session-${outcomeIndex}-${"n".repeat(2_000)}`,
              turnId: `served-turn-${outcomeIndex}-${"u".repeat(2_000)}`,
              outcomeId: `outcome-${outcomeIndex}-${"i".repeat(2_000)}`,
              outcome: "accepted" as const,
              summary: "q".repeat(512),
              settledAt: "2026-01-10T00:00:00.000Z",
              evidenceRefs,
            }),
          ),
        ),
      }),
      baselineRevision: harness.baseline,
      capability,
      activeWorkingAdjustment: activeAdjustment,
    });

    if (result.status !== "apply_working_adjustment")
      throw new Error("Expected a replacement working adjustment");
    expect(result.expectedActiveAdjustmentId).toBe(activeAdjustmentId);
    expect(result.evidenceRefs).toContainEqual(lastServedEvidence);

    const adjustmentContextMessage = harness.inference
      .requests()[0]
      ?.messages.find((message) => message.name === "working_adjustment_context");
    if (!adjustmentContextMessage) throw new Error("Expected working-adjustment context");
    expect(adjustmentContextMessage.content.length).toBeLessThan(12_000);
    const promptContext = JSON.parse(adjustmentContextMessage.content) as {
      readonly expectedActiveAdjustmentId: string;
      readonly activeAdjustment: Readonly<Record<string, unknown>>;
      readonly evidence: readonly Readonly<Record<string, unknown> & { readonly citationIndex: number }>[];
    };
    expect(promptContext.expectedActiveAdjustmentId).toBe(promptAdjustmentIdentity);
    expect(promptContext.activeAdjustment).not.toHaveProperty("evidenceRefs");
    expect(promptContext.evidence).toHaveLength(9);
    expect(promptContext.evidence.map((candidate) => candidate.citationIndex)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(promptContext.evidence.every((candidate) => !("evidenceRefs" in candidate))).toBe(true);
    expect(adjustmentContextMessage.content).not.toContain(lastServedEvidence.rowId);
  });

  test("does not split an emoji surrogate pair at a working-adjustment prompt boundary", async () => {
    expect(hasUnpairedSurrogate("\ud800")).toBe(true);
    expect(hasUnpairedSurrogate("😀")).toBe(false);
    const harness = createHarness({
      steps: [
        Object.freeze({
          role: "reflector",
          value: Object.freeze({
            observation: Object.freeze({ kind: "other", reason: "No adjustment change is useful." }),
            decision: "no_change",
            reason: "The current strategy remains useful.",
          }),
        }),
      ],
    });
    const base = turn({ correction: "Keep the current project strategy." });
    const strategy = `${"a".repeat(3_054)}😀${"z".repeat(500)}`;
    const activeAdjustment = Object.freeze({
      adjustmentId: "adjustment-emoji-boundary",
      scope: base.project,
      observation: "The project needs a stable strategy.",
      strategy,
      successSignal: "The next turn remains useful.",
      evidenceRefs: Object.freeze([databaseRef("emoji-boundary-evidence")]),
      createdFromTurnId: "turn-emoji-source",
    });

    await harness.organ.observeTurn({
      turn: Object.freeze({
        ...base,
        expectedActiveAdjustmentId: activeAdjustment.adjustmentId,
      }),
      baselineRevision: harness.baseline,
      capability,
      activeWorkingAdjustment: activeAdjustment,
    });

    const message = harness.inference
      .requests()[0]
      ?.messages.find((candidate) => candidate.name === "working_adjustment_context");
    if (!message) throw new Error("Expected working-adjustment context");
    const parsed = JSON.parse(message.content) as {
      readonly activeAdjustment: { readonly strategy: string };
    };
    expect(parsed.activeAdjustment.strategy).toBe(`${"a".repeat(3_054)}…${sha256(strategy).slice(0, 16)}`);
    expect(hasUnpairedSurrogate(parsed.activeAdjustment.strategy)).toBe(false);
    expect(message.content.length).toBeLessThan(12_000);
  });

  test("keeps escape-heavy maximum fields as valid bounded JSON with exact citation indexes", async () => {
    const activeAdjustmentId = "adjustment-escape-heavy";
    const escaped = '\u0000\n\\"';
    const servedEvidence = Array.from({ length: 8 }, (_, index) =>
      Object.freeze([databaseRef(`escape-heavy-served-${index}`)]),
    );
    const citedEvidence = servedEvidence[7]?.[0];
    if (!citedEvidence) throw new Error("Expected cited served evidence");
    const harness = createHarness({
      steps: [
        Object.freeze({
          role: "reflector",
          value: Object.freeze({
            observation: Object.freeze({
              kind: "correction",
              reason: "The escape-heavy strategy should be replaced.",
            }),
            decision: "apply_working_adjustment",
            expectedActiveAdjustmentId: activeAdjustmentId,
            rationale: "The cited served turn supports a replacement.",
            strategy: "Use the replacement strategy.",
            successSignal: "The next turn improves.",
            evidenceCitationIndexes: Object.freeze([8]),
          }),
        }),
      ],
    });
    const project = Object.freeze({
      projectId: escaped.repeat(1_000),
      root: `/${escaped.repeat(1_000)}`,
    });
    const activeAdjustment = Object.freeze({
      adjustmentId: activeAdjustmentId,
      scope: project,
      observation: escaped.repeat(WORKING_ADJUSTMENT_LIMITS.observationChars / escaped.length),
      strategy: escaped.repeat(WORKING_ADJUSTMENT_LIMITS.strategyChars / escaped.length),
      successSignal: escaped.repeat(WORKING_ADJUSTMENT_LIMITS.successSignalChars / escaped.length),
      evidenceRefs: Object.freeze([databaseRef("escape-heavy-active")]),
      createdFromTurnId: escaped.repeat(1_000),
    });
    const base = turn({ turnId: escaped.repeat(1_000) });

    const result = await harness.organ.observeTurn({
      turn: Object.freeze({
        ...base,
        project,
        expectedActiveAdjustmentId: activeAdjustmentId,
        servedWorkingAdjustmentOutcomes: Object.freeze(
          servedEvidence.map((evidenceRefs, index) =>
            Object.freeze({
              adjustmentId: activeAdjustmentId,
              planId: `plan-${index}`,
              sessionId: `session-${index}`,
              turnId: escaped.repeat(1_000),
              outcomeId: `outcome-${index}`,
              outcome: "accepted" as const,
              summary: escaped.repeat(128),
              settledAt: "2026-01-10T00:00:00.000Z",
              evidenceRefs,
            }),
          ),
        ),
      }),
      baselineRevision: harness.baseline,
      capability,
      activeWorkingAdjustment: activeAdjustment,
    });

    if (result.status !== "apply_working_adjustment")
      throw new Error("Expected a replacement working adjustment");
    expect(result.evidenceRefs).toContainEqual(citedEvidence);
    const message = harness.inference
      .requests()[0]
      ?.messages.find((candidate) => candidate.name === "working_adjustment_context");
    if (!message) throw new Error("Expected working-adjustment context");
    expect(message.content.length).toBeLessThan(12_000);
    const parsed = JSON.parse(message.content) as {
      readonly expectedActiveAdjustmentId: string;
      readonly evidence: readonly { readonly citationIndex: number }[];
    };
    expect(parsed.expectedActiveAdjustmentId).toBe(activeAdjustmentId);
    expect(parsed.evidence.map((candidate) => candidate.citationIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(message.content).not.toContain(citedEvidence.rowId);
  });

  test("requires an unapply decision to target the exact adjustment served to the turn", async () => {
    const harness = createHarness({
      steps: [
        Object.freeze({
          role: "reflector",
          value: Object.freeze({
            observation: Object.freeze({ kind: "other", reason: "The strategy made the work worse." }),
            decision: "unapply_working_adjustment",
            expectedActiveAdjustmentId: "adjustment-other",
            reason: "The adjustment did not help.",
            evidenceCitationIndexes: Object.freeze([0]),
          }),
        }),
      ],
    });
    const base = turn({ userMessage: "That approach was less useful." });

    await expect(
      harness.organ.observeTurn({
        turn: Object.freeze({
          ...base,
          expectedActiveAdjustmentId: "adjustment-active",
        }),
        baselineRevision: harness.baseline,
        capability,
        activeWorkingAdjustment: Object.freeze({
          adjustmentId: "adjustment-active",
          scope: base.project,
          observation: "Try a more structured response.",
          strategy: "Lead with a rigid checklist.",
          successSignal: "The user finds the work clearer.",
          evidenceRefs: Object.freeze([databaseRef("current-message")]),
          createdFromTurnId: "turn-before",
        }),
      }),
    ).rejects.toThrow("changed the expected active identity");
    expect(harness.experiments()).toHaveLength(0);
  });

  test("records a model-classified preference independently of experiment creation", async () => {
    const harness = createHarness({
      steps: [
        Object.freeze({
          role: "reflector",
          value: Object.freeze({
            observation: Object.freeze({
              kind: "preference",
              reason: "The user expresses a reusable presentation preference.",
            }),
            decision: "no_change",
            reason: "One preference observation does not justify an experiment yet.",
          }),
        }),
      ],
    });

    const result = await harness.organ.observeTurn({
      turn: turn({ userMessage: "I prefer concise summaries with links to primary sources." }),
      baselineRevision: harness.baseline,
      capability,
    });

    expect(result).toMatchObject({
      status: "no_change",
      observation: { kind: "preference" },
    });
    expect(harness.feedback.signals()).toMatchObject([
      {
        kind: "preference_expression",
        strength: 0.8,
      },
    ]);
    expect(harness.experiments()).toHaveLength(0);
  });

  test("accepts an explicit reflector no-change result without authoring a candidate", async () => {
    const harness = createHarness({
      steps: [
        Object.freeze({
          role: "reflector",
          value: Object.freeze({
            observation: Object.freeze({
              kind: "correction",
              reason: "The user corrects a detail for this artifact.",
            }),
            decision: "no_change",
            reason: "The correction is specific to this one artifact.",
          }),
        }),
      ],
      citations: [citation(1)],
    });
    const result = await harness.organ.observeTurn({
      turn: turn({ correction: "Change this one heading." }),
      baselineRevision: harness.baseline,
      capability,
    });

    expect(result).toMatchObject({
      status: "no_change",
      reason: "reflector_no_change",
      interruption: null,
      reflectionRun: { role: "reflector" },
      observation: { kind: "correction" },
    });
    expect(harness.feedback.signals().map((signal) => signal.kind)).toEqual(["explicit_correction"]);
    expect(harness.candidates.requests()).toHaveLength(0);
    expect(harness.experiments()).toHaveLength(0);
  });

  test("harvests failed session outcomes as evidence-linked failure signals", async () => {
    const harness = createHarness({
      steps: [
        Object.freeze({
          role: "reflector",
          value: Object.freeze({
            observation: Object.freeze({ kind: "other", reason: "The turn reports a failure." }),
            decision: "no_change",
            reason: "One failure is not recurrent yet.",
          }),
        }),
      ],
      citations: [citation(1)],
    });
    const result = await harness.organ.observeTurn({
      turn: turn({ userMessage: "Generate the report", outcome: "failed" }),
      baselineRevision: harness.baseline,
      capability,
    });

    expect(result.status).toBe("no_change");
    expect(result.harvest.signals[0]?.signal).toMatchObject({
      kind: "repeated_failure",
      scope: "writing",
      evidenceRefs: [databaseRef("current-message")],
    });
    expect(harness.criteria.creates()).toHaveLength(0);
  });

  test("deduplicates recurring hypotheses while retaining exact source-case citations", async () => {
    const briefs = createInMemoryExperimentBriefStore();
    const harness = createHarness({
      steps: [reflectionStep, reflectionStep, authorStep],
      citations: [citation(1), citation(2)],
      briefs,
    });
    const first = await harness.organ.observeTurn({
      turn: turn({ turnId: "turn-1", correction: "Use primary sources." }),
      baselineRevision: harness.baseline,
      capability,
    });
    const second = await harness.organ.observeTurn({
      turn: turn({
        turnId: "turn-2",
        correction: "Use primary sources.",
        evidenceRef: databaseRef("current-message-2"),
      }),
      baselineRevision: harness.baseline,
      capability,
    });

    expect(first.status).toBe("experiment");
    expect(second.status).toBe("deduped");
    if (first.status !== "experiment" || second.status !== "deduped") {
      throw new Error("Expected experiment and deduped outcomes");
    }
    expect(second.brief.experimentId).toBe(first.brief.experimentId);
    expect(first.brief.sourceCases[0]?.evidenceRefs).toEqual(first.brief.evidenceRefs);
    expect(first.brief.sourceCases[0]?.citations).toEqual(first.brief.citations);
    expect(first.brief.sourceCases[0]?.citations).toHaveLength(2);
    expect(harness.feedback.signals()).toHaveLength(2);
    const authored = await harness.organ.authorExperimentRevision({ brief: second.brief });
    expect(authored.brief.experimentId).toBe(first.brief.experimentId);
    expect(authored.revisionRef).toEqual(capabilityRevisionRef(authored.revision));
    expect(authored.experiment.candidateRevisions).toEqual([authored.revisionRef]);
  });

  test("reconciles newly cited working-adjustment evidence into a deduped brief and experiment", async () => {
    const activeAdjustment = Object.freeze({
      adjustmentId: "adjustment-deduped-evidence",
      scope: Object.freeze({ projectId: "project-noesis", root: "/work/noesis" }),
      observation: "The project needs observable verification.",
      strategy: "Verify observable state before claiming success.",
      successSignal: "Success claims cite fresh runtime evidence.",
      evidenceRefs: Object.freeze([databaseRef("adjustment-original-evidence")]),
      createdFromTurnId: "turn-before",
    });
    const firstLinkedStep = Object.freeze({
      ...reflectionStep,
      value: Object.freeze({
        ...reflectionStep.value,
        workingAdjustmentEvidenceCitationIndexes: Object.freeze([0]),
      }),
    });
    const secondLinkedStep = Object.freeze({
      ...reflectionStep,
      value: Object.freeze({
        ...reflectionStep.value,
        workingAdjustmentEvidenceCitationIndexes: Object.freeze([1]),
      }),
    });
    const newlyCitedServedEvidence = databaseRef("newly-cited-served-adjustment-outcome");
    const harness = createHarness({
      steps: [firstLinkedStep, secondLinkedStep],
      citations: [citation(1)],
    });

    const firstTurn = turn({ turnId: "turn-adjustment-dedupe-1", correction: "Verify the real state." });
    const first = await harness.organ.observeTurn({
      turn: Object.freeze({
        ...firstTurn,
        expectedActiveAdjustmentId: activeAdjustment.adjustmentId,
      }),
      baselineRevision: harness.baseline,
      capability,
      activeWorkingAdjustment: activeAdjustment,
    });
    const secondTurn = turn({
      turnId: "turn-adjustment-dedupe-2",
      correction: "Keep verifying the real state.",
      evidenceRef: databaseRef("current-adjustment-dedupe-2"),
    });
    const second = await harness.organ.observeTurn({
      turn: Object.freeze({
        ...secondTurn,
        expectedActiveAdjustmentId: activeAdjustment.adjustmentId,
        servedWorkingAdjustmentOutcomes: Object.freeze([
          Object.freeze({
            adjustmentId: activeAdjustment.adjustmentId,
            planId: "plan-adjustment-dedupe",
            sessionId: "session-before",
            turnId: "turn-served-adjustment-dedupe",
            outcomeId: "outcome-served-adjustment-dedupe",
            outcome: "accepted" as const,
            summary: "The strategy produced a verified completion.",
            settledAt: "2026-01-09T00:00:00.000Z",
            evidenceRefs: Object.freeze([newlyCitedServedEvidence]),
          }),
        ]),
      }),
      baselineRevision: harness.baseline,
      capability,
      activeWorkingAdjustment: activeAdjustment,
    });

    if (first.status !== "experiment" || second.status !== "deduped")
      throw new Error("Expected an experiment followed by a deduped observation");
    expect(second.brief.experimentId).toBe(first.brief.experimentId);
    expect(second.brief.evidenceRefs).toContainEqual(newlyCitedServedEvidence);
    expect(second.brief.sourceCases[0]?.evidenceRefs).toContainEqual(newlyCitedServedEvidence);
    expect(new Set(second.brief.evidenceRefs.map((reference) => JSON.stringify(reference))).size).toBe(
      second.brief.evidenceRefs.length,
    );
    const durableExperiment = harness
      .experiments()
      .find((experiment) => experiment.experimentId === second.brief.experimentId);
    expect(durableExperiment?.evidenceRefs).toContainEqual(newlyCitedServedEvidence);
  });

  test("serializes two reflected observations without losing either provenance set", async () => {
    const inference = createBarrierInference([
      reflectionStep,
      reflectionStep,
      scopeVerificationStep("same"),
      scopeVerificationStep("same"),
    ]);
    const harness = createHarness({
      steps: [],
      inference,
      citations: [citation(1)],
    });

    const [first, second] = await Promise.all([
      harness.organ.observeTurn({
        turn: turn({ turnId: "turn-concurrent-1", correction: "Use primary sources." }),
        baselineRevision: harness.baseline,
        capability,
      }),
      harness.organ.observeTurn({
        turn: turn({
          turnId: "turn-concurrent-2",
          correction: "Use primary sources.",
          evidenceRef: databaseRef("current-message-2"),
        }),
        baselineRevision: harness.baseline,
        capability,
      }),
    ]);

    expect([first.status, second.status].sort()).toEqual(["deduped", "experiment"]);
    if (!("brief" in first) || !("brief" in second))
      throw new Error("Expected concurrent experiment results");
    const brief = first.status === "deduped" ? first.brief : second.brief;
    expect(brief.feedbackSignalIds).toHaveLength(2);
    expect(brief.evidenceRefs).toEqual(
      expect.arrayContaining([databaseRef("current-message"), databaseRef("current-message-2")]),
    );
    expect(harness.experiments()).toHaveLength(1);
    expect(harness.experiments()[0]?.feedbackSignalIds).toHaveLength(2);
  });

  test("reconciles a concurrent initial publication with the winning brief", async () => {
    const experimentState = createExperimentState();
    const briefs = createContendedInitialBriefStore();
    const left = createHarness({
      steps: [reflectionStep],
      citations: [citation(1)],
      briefs: briefs.port,
      experimentState,
    });
    const right = createHarness({
      steps: [reflectionStep],
      citations: [citation(1)],
      briefs: briefs.port,
      experimentState,
    });

    const [leftResult, rightResult] = await Promise.all([
      left.organ.observeTurn({
        turn: turn({
          turnId: "turn-initial-left",
          correction: "Use primary sources.",
          evidenceRef: databaseRef("current-message-initial-left"),
        }),
        baselineRevision: left.baseline,
        capability,
      }),
      right.organ.observeTurn({
        turn: turn({
          turnId: "turn-initial-right",
          correction: "Use primary sources.",
          evidenceRef: databaseRef("current-message-initial-right"),
        }),
        baselineRevision: right.baseline,
        capability,
      }),
    ]);

    expect([leftResult.status, rightResult.status].sort()).toEqual(["deduped", "experiment"]);
    if (!("brief" in leftResult) || !("brief" in rightResult))
      throw new Error("Expected concurrent initial publication results");
    expect(leftResult.brief.experimentId).toBe(rightResult.brief.experimentId);
    expect(briefs.collisions()).toBe(1);
    expect(briefs.current()).toMatchObject({
      experimentId: leftResult.brief.experimentId,
      evidenceRefs: expect.arrayContaining([
        databaseRef("current-message-initial-left"),
        databaseRef("current-message-initial-right"),
      ]),
      feedbackSignalIds: expect.arrayContaining([
        leftResult.harvest.signals[0]?.signal.signalId,
        rightResult.harvest.signals[0]?.signal.signalId,
      ]),
    });
    expect(experimentState.values()).toHaveLength(1);
    expect(experimentState.values()[0]).toMatchObject({
      experimentId: leftResult.brief.experimentId,
      evidenceRefs: expect.arrayContaining([
        databaseRef("current-message-initial-left"),
        databaseRef("current-message-initial-right"),
      ]),
      feedbackSignalIds: expect.arrayContaining([
        leftResult.harvest.signals[0]?.signal.signalId,
        rightResult.harvest.signals[0]?.signal.signalId,
      ]),
    });
  });

  test("retains outcome and file-revision citations independently of evidence conversion", async () => {
    const outcome = outcomeCitation("outcome-prior", "The report failed source review");
    const file = fileRevisionCitation("revision-prior-report", "A prior report omitted citations");
    const reflection = Object.freeze({
      ...reflectionStep,
      value: Object.freeze({
        ...reflectionStep.value,
        recurrenceEvidenceCitationIndexes: Object.freeze([0, 1]),
      }),
    }) satisfies ScriptedLearningInferenceStep;
    const harness = createHarness({ steps: [reflection], citations: [outcome, file] });

    const result = await harness.organ.observeTurn({
      turn: turn({ correction: "Use primary sources." }),
      baselineRevision: harness.baseline,
      capability,
    });

    if (result.status !== "experiment") throw new Error("Expected an experiment");
    expect(result.brief.citations).toEqual([outcome, file]);
    expect(result.brief.recurrenceCitations).toEqual([outcome, file]);
    expect(result.brief.evidenceRefs).toContainEqual({
      kind: "database_row",
      table: "outcomes",
      rowId: "outcome-prior",
    });
    expect(result.brief.evidenceRefs).not.toContainEqual(
      expect.objectContaining({
        kind: "file_revision",
        revisionId: "revision-prior-report",
      }),
    );
  });

  test("retains completed experiment citations as authoritative learning evidence", async () => {
    const experiment = experimentCitation(
      "experiment-prior",
      "A prior citation experiment completed with outcome keep",
    );
    const harness = createHarness({ steps: [reflectionStep], citations: [experiment] });

    const result = await harness.organ.observeTurn({
      turn: turn({ correction: "Use primary sources." }),
      baselineRevision: harness.baseline,
      capability,
    });

    if (result.status !== "experiment") throw new Error("Expected an experiment");
    expect(result.brief.citations).toEqual([experiment]);
    expect(result.brief.recurrenceCitations).toEqual([experiment]);
    expect(result.brief.evidenceRefs).toContainEqual({
      kind: "database_row",
      table: "experiments",
      rowId: "experiment-prior",
    });
  });

  test("does not count a current-turn file revision returned by history as recurrence", async () => {
    const currentRevision = fileRef("current-turn-source.md");
    const currentCitation = fileRevisionCitation(currentRevision.revisionId, "The current correction");
    const priorOutcome = outcomeCitation("outcome-earlier-correction", "An earlier correction recurred");
    const selectsFilteredIndex = Object.freeze({
      ...reflectionStep,
      value: Object.freeze({
        ...reflectionStep.value,
        recurrenceEvidenceCitationIndexes: Object.freeze([0]),
      }),
    }) satisfies ScriptedLearningInferenceStep;
    const harness = createHarness({
      steps: [selectsFilteredIndex],
      citations: [currentCitation, priorOutcome],
    });

    const result = await harness.organ.observeTurn({
      turn: turn({
        correction: "Use primary sources.",
        evidenceRef: currentRevision,
      }),
      baselineRevision: harness.baseline,
      capability,
    });

    if (result.status !== "experiment") throw new Error("Expected an experiment");
    expect(result.brief.evidenceRefs).toEqual([
      currentRevision,
      { kind: "database_row", table: "outcomes", rowId: "outcome-earlier-correction" },
    ]);
    expect(result.brief.citations).toEqual([priorOutcome]);
    expect(result.brief.citations).not.toContainEqual(currentCitation);
    expect(result.brief.recurrenceCitations).toEqual([priorOutcome]);
    expect(result.brief.recurrenceCount).toBe(1);
  });

  test("retries one reflected turn without duplicating its feedback signal or hypothesis", async () => {
    const harness = createHarness({
      steps: [reflectionStep, reflectionStep],
      citations: [citation(1), citation(2)],
    });
    const request = {
      turn: turn({ turnId: "turn-retried", correction: "Use primary sources." }),
      baselineRevision: harness.baseline,
      capability,
    } as const;

    const first = await harness.organ.observeTurn(request);
    const retried = await harness.organ.observeTurn(request);

    expect(first.status).toBe("experiment");
    expect(retried.status).toBe("deduped");
    expect(harness.feedback.signals()).toHaveLength(1);
    expect(harness.experiments()).toHaveLength(1);
    expect(harness.feedback.signals()[0]?.signalId).toMatch(/^signal_[a-f0-9]{32}$/u);
  });

  test("counts only distinct recurrence citations selected by the reflector", async () => {
    const selectiveReflection = Object.freeze({
      ...reflectionStep,
      value: Object.freeze({
        ...reflectionStep.value,
        recurrenceEvidenceCitationIndexes: Object.freeze([0]),
      }),
    }) satisfies ScriptedLearningInferenceStep;
    const harness = createHarness({
      steps: [selectiveReflection],
      citations: [citation(1, "same correction"), citation(2, "same correction")],
    });

    const result = await harness.organ.observeTurn({
      turn: turn({ correction: "Use primary sources." }),
      baselineRevision: harness.baseline,
      capability,
    });

    if (result.status !== "experiment") throw new Error("Expected an experiment");
    expect(result.brief.citations).toHaveLength(2);
    expect(result.brief.recurrenceCount).toBe(1);
  });

  test("reports fresh recurrence without overwriting exact cumulative recurrence evidence", async () => {
    const noFreshRecurrence = Object.freeze({
      ...reflectionStep,
      value: Object.freeze({
        ...reflectionStep.value,
        recurrenceEvidenceCitationIndexes: Object.freeze([]),
      }),
    }) satisfies ScriptedLearningInferenceStep;
    const harness = createHarness({
      steps: [reflectionStep, noFreshRecurrence],
      citations: [citation(1)],
    });
    await harness.organ.observeTurn({
      turn: turn({ turnId: "turn-recurrence-1", correction: "Use primary sources." }),
      baselineRevision: harness.baseline,
      capability,
    });
    const second = await harness.organ.observeTurn({
      turn: turn({
        turnId: "turn-recurrence-2",
        correction: "Use primary sources.",
        evidenceRef: databaseRef("current-message-2"),
      }),
      baselineRevision: harness.baseline,
      capability,
    });

    if (second.status !== "deduped") throw new Error("Expected a deduped experiment");
    expect(second.harvest.recurrenceCount).toBe(0);
    expect(second.brief.recurrenceCount).toBe(1);
    expect(second.brief.recurrenceCitations).toEqual([citation(1)]);
  });

  test("creates a fresh generation when new evidence recurs after a completed experiment", async () => {
    const harness = createHarness({
      steps: [reflectionStep, reflectionStep],
      citations: [citation(1)],
    });
    const first = await harness.organ.observeTurn({
      turn: turn({ turnId: "turn-generation-1", correction: "Use primary sources." }),
      baselineRevision: harness.baseline,
      capability,
    });
    if (first.status !== "experiment") throw new Error("Expected an experiment");
    const openExperiment = harness.experiments()[0];
    if (!openExperiment) throw new Error("Expected the first experiment to be stored");
    const completedExperiment: Experiment = Object.freeze({
      experimentId: openExperiment.experimentId,
      hypothesis: openExperiment.hypothesis,
      scope: openExperiment.scope,
      evidenceRefs: openExperiment.evidenceRefs,
      baselineRevision: openExperiment.baselineRevision,
      candidateRevisions: openExperiment.candidateRevisions,
      feedbackSignalIds: openExperiment.feedbackSignalIds,
      ...(openExperiment.preflightRef ? { preflightRef: openExperiment.preflightRef } : {}),
      ...(openExperiment.activatedRevision ? { activatedRevision: openExperiment.activatedRevision } : {}),
      ...(openExperiment.followUpExperimentId
        ? { followUpExperimentId: openExperiment.followUpExperimentId }
        : {}),
      status: "completed",
      outcome: "keep",
    });
    await harness.putExperiment(completedExperiment);

    const second = await harness.organ.observeTurn({
      turn: turn({
        turnId: "turn-generation-2",
        correction: "Use primary sources.",
        evidenceRef: databaseRef("current-message-2"),
      }),
      baselineRevision: harness.baseline,
      capability,
    });

    if (second.status !== "experiment") throw new Error("Expected a follow-up experiment");
    expect(second.brief.experimentId).not.toBe(first.brief.experimentId);
    expect(harness.experiments()).toHaveLength(2);
    expect(
      harness.experiments().find(({ experimentId }) => experimentId === first.brief.experimentId),
    ).toMatchObject({
      status: "completed",
      outcome: "keep",
    });
    expect(
      harness.experiments().find(({ experimentId }) => experimentId === second.brief.experimentId),
    ).toMatchObject({
      status: "hypothesis",
      evidenceRefs: expect.arrayContaining([
        { kind: "database_row", table: "experiments", rowId: first.brief.experimentId },
        databaseRef("current-message-2"),
      ]),
    });
  });

  test("reconciles concurrent follow-up observations into one reachable successor", async () => {
    const experimentState = createExperimentState();
    const genesis = createHarness({
      steps: [reflectionStep],
      citations: [citation(1)],
      experimentState,
    });
    const first = await genesis.organ.observeTurn({
      turn: turn({ turnId: "turn-follow-up-parent", correction: "Use primary sources." }),
      baselineRevision: genesis.baseline,
      capability,
    });
    if (first.status !== "experiment") throw new Error("Expected a parent experiment");
    const parent = experimentState.values()[0];
    if (!parent) throw new Error("Expected the parent experiment to be stored");
    await experimentState.port.putExperiment(
      Object.freeze({
        ...parent,
        status: "completed" as const,
        outcome: "keep" as const,
      }),
    );

    const briefs = createContendedBriefStore(first.brief);
    const left = createHarness({
      steps: [reflectionStep],
      citations: [citation(1)],
      briefs: briefs.port,
      experimentState,
    });
    const right = createHarness({
      steps: [reflectionStep],
      citations: [citation(1)],
      briefs: briefs.port,
      experimentState,
    });
    const [leftResult, rightResult] = await Promise.all([
      left.organ.observeTurn({
        turn: turn({
          turnId: "turn-follow-up-left",
          correction: "Use primary sources.",
          evidenceRef: databaseRef("current-message-left"),
        }),
        baselineRevision: left.baseline,
        capability,
      }),
      right.organ.observeTurn({
        turn: turn({
          turnId: "turn-follow-up-right",
          correction: "Use primary sources.",
          evidenceRef: databaseRef("current-message-right"),
        }),
        baselineRevision: right.baseline,
        capability,
      }),
    ]);

    expect([leftResult.status, rightResult.status].sort()).toEqual(["deduped", "experiment"]);
    if (!("brief" in leftResult) || !("brief" in rightResult))
      throw new Error("Expected concurrent follow-up results");
    const successorId = leftResult.brief.experimentId;
    expect(rightResult.brief.experimentId).toBe(successorId);
    expect(briefs.collisions()).toBe(1);
    expect(briefs.current()).toMatchObject({
      experimentId: successorId,
      evidenceRefs: expect.arrayContaining([
        databaseRef("current-message-left"),
        databaseRef("current-message-right"),
      ]),
    });
    const experiments = experimentState.values();
    expect(experiments).toHaveLength(2);
    expect(experiments.filter(({ status }) => status === "hypothesis")).toHaveLength(1);
    expect(experiments.find(({ experimentId }) => experimentId === successorId)).toMatchObject({
      status: "hypothesis",
      evidenceRefs: expect.arrayContaining([
        { kind: "database_row", table: "experiments", rowId: parent.experimentId },
        databaseRef("current-message-left"),
        databaseRef("current-message-right"),
      ]),
      feedbackSignalIds: expect.arrayContaining([
        leftResult.harvest.signals[0]?.signal.signalId,
        rightResult.harvest.signals[0]?.signal.signalId,
      ]),
    });
  });

  test("authors a complete immutable AC-03 revision and a canonical authoring experiment", async () => {
    const harness = createHarness({ steps: [reflectionStep, authorStep], citations: [citation(1)] });
    const observed = await harness.organ.observeTurn({
      turn: turn({ correction: "Use primary sources." }),
      baselineRevision: harness.baseline,
      capability,
    });
    if (observed.status !== "experiment") throw new Error("Expected an experiment brief");
    const authored = await harness.organ.authorExperimentRevision({ brief: observed.brief });

    expect(authored.revisionRef).toEqual(capabilityRevisionRef(authored.revision));
    expect(authored.revision.predecessorRevisionId).toBe(harness.baseline.capabilityRevisionId);
    expect(authored.revision.promptModules).toHaveLength(1);
    expect(authored.revision.skills).toHaveLength(1);
    expect(authored.revision.tools).toHaveLength(1);
    expect(authored.revision.toolset.toolRevisionIds).toEqual([authored.revision.tools[0]?.revisionId]);
    expect(authored.revision.sourceEvaluationDefinitions).toHaveLength(1);
    expect(authored.revision.permissionManifest).toEqual({
      effects: ["read"],
      resourcePatterns: ["workspace:"],
      credentialRefs: [],
    });
    expect(Object.isFrozen(authored.revision)).toBe(true);
    expect(harness.candidates.requests()).toHaveLength(5);
    expect(
      harness.candidates
        .requests()
        .every((request) =>
          request.workingPath.startsWith(
            `${capability.capabilityId}/${authored.revision.capabilityRevisionId}/`,
          ),
        ),
    ).toBe(true);
    expect(authored.experiment).toMatchObject({
      experimentId: observed.brief.experimentId,
      status: "authoring",
      candidateRevisions: [authored.revisionRef],
    });
    expect(harness.experiments()).toEqual([authored.experiment]);
    expect("activate" in harness.registry).toBe(false);
  });

  test("repairs a singleton-array revision-author handoff without choosing among candidates", async () => {
    const wrappedAuthor = Object.freeze({
      role: "revision_author" as const,
      value: Object.freeze([authorStep.value]),
    }) satisfies ScriptedLearningInferenceStep;
    const harness = createHarness({ steps: [reflectionStep, wrappedAuthor], citations: [citation(1)] });
    const observed = await harness.organ.observeTurn({
      turn: turn({ correction: "Use primary sources." }),
      baselineRevision: harness.baseline,
      capability,
    });
    if (observed.status !== "experiment") throw new Error("Expected an experiment brief");

    const authored = await harness.organ.authorExperimentRevision({ brief: observed.brief });

    expect(authored.revision.promptModules).toHaveLength(1);
    expect(authored.experiment.status).toBe("authoring");
  });

  test("keeps coordinator cancellation transient while forwarding it to reflector and author roles", async () => {
    const harness = createHarness({ steps: [reflectionStep, authorStep], citations: [citation(1)] });
    const controller = new AbortController();
    const observed = await harness.organ.observeTurn({
      turn: turn({ correction: "Use primary sources." }),
      baselineRevision: harness.baseline,
      capability,
      signal: controller.signal,
    });
    if (observed.status !== "experiment") throw new Error("Expected an experiment brief");

    await harness.organ.authorExperimentRevision({
      brief: observed.brief,
      signal: controller.signal,
    });

    const requests = harness.inference.requests();
    expect(requests.map((request) => request.signal)).toEqual([
      controller.signal,
      controller.signal,
      controller.signal,
    ]);
    expect(JSON.stringify(observed.brief)).not.toContain('"signal":');
    expect(JSON.stringify(harness.experiments())).not.toContain('"signal":');
  });

  test("isolates reflector and author inputs from protected control-plane context", async () => {
    const harness = createHarness({ steps: [reflectionStep, authorStep], citations: [citation(1)] });
    const observed = await harness.organ.observeTurn({
      turn: turn({ correction: "Use primary sources." }),
      baselineRevision: harness.baseline,
      capability,
    });
    if (observed.status !== "experiment") throw new Error("Expected an experiment brief");
    await harness.organ.authorExperimentRevision({ brief: observed.brief });

    const requests = harness.inference.requests();
    expect(requests.map((request) => request.role)).toEqual(["reflector", "reflector", "revision_author"]);
    expect(requests[0]?.messages.map((message) => message.name)).toEqual([
      "current_turn",
      "signals",
      "evidence",
      "active_capabilities",
      "user_preferences",
      "working_adjustment_context",
    ]);
    expect(requests[1]?.messages.map((message) => message.name)).toEqual(["evidence"]);
    expect(JSON.parse(requests[1]?.messages[0]?.content ?? "null")).toEqual({
      currentScope: "writing",
      proposedScope: "writing",
      scopeRationale: "The evidence concerns the same writing capability and does not support a wider scope.",
    });
    expect(requests[1]?.evidenceRefs).toEqual([]);
    expect(requests[2]?.messages.map((message) => message.name)).toEqual(["hypothesis", "source_cases"]);
    for (const request of requests) {
      expect(request.availableTools).toEqual([]);
      expect(request).not.toHaveProperty("authorityGrant");
      expect(request).not.toHaveProperty("activationHandle");
      expect(request).not.toHaveProperty("protectedCases");
      const encoded = JSON.stringify(request).toLocaleLowerCase();
      expect(encoded).not.toContain("hidden_policy");
      expect(encoded).not.toContain("authority_grant");
      expect(encoded).not.toContain("protected_case");
      expect(encoded).not.toContain("activation_handle");
    }
  });

  test("authors revise outcomes as successor revisions with linked experiment lineage", async () => {
    const harness = createHarness({ steps: [revisionStep], citations: [] });
    const parent: Experiment = Object.freeze({
      experimentId: "experiment-parent",
      hypothesis: "The candidate preserves voice",
      scope: "writing",
      evidenceRefs: Object.freeze([databaseRef("parent-evidence")]),
      baselineRevision: harness.baseline,
      candidateRevisions: Object.freeze([harness.baseline]),
      activatedRevision: harness.baseline,
      feedbackSignalIds: Object.freeze(["signal-parent"]),
      followUpExperimentId: "experiment-follow-up",
      sourceAdjustmentId: "adjustment-parent-source",
      status: "completed",
      outcome: "revise",
    });
    const result = await harness.organ.authorFollowUpRevision({
      parentExperiment: parent,
      capability,
      failureSummary: "The rewrite flattened the user's tone",
      judgmentEvidenceRefs: Object.freeze([databaseRef("judgment-evidence")]),
      citations: Object.freeze([citation(1, "The rewrite flattened the user's tone")]),
    });

    expect(result.brief.experimentId).toBe(parent.followUpExperimentId);
    expect(result.brief.sourceAdjustmentId).toBe(parent.sourceAdjustmentId);
    expect(result.revision.predecessorRevisionId).toBe(harness.baseline.capabilityRevisionId);
    expect(result.experiment.baselineRevision).toEqual(harness.baseline);
    expect(result.experiment.sourceAdjustmentId).toBe(parent.sourceAdjustmentId);
    expect(result.authorRun.role).toBe("revision_agent");
    expect(result.authorRun.research).toMatchObject({
      promptRevision: revisionPrompt,
      model: "scripted-reviser-1",
      reasoning: "xhigh",
    });
    expect(harness.inference.requests()[0]?.messages.map((message) => message.name)).toEqual([
      "failures",
      "judgment_evidence",
    ]);
  });

  test("records deterministic scripted prompt, model, reasoning, and trace metadata", async () => {
    const harness = createHarness({ steps: [reflectionStep], citations: [citation(1)] });
    const result = await harness.organ.observeTurn({
      turn: turn({ correction: "Use primary sources." }),
      baselineRevision: harness.baseline,
      capability,
    });
    if (result.status !== "experiment") throw new Error("Expected an experiment brief");

    expect(result.reflectionRun).toMatchObject({
      role: "reflector",
      research: {
        promptRevision: reflectorPrompt,
        model: "scripted-reflector-1",
        reasoning: "medium",
      },
      trace: {
        traceId: "scripted-learning-trace-1",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 },
      },
    });
    expect(result.brief.scopeVerificationRun).toMatchObject({
      role: "reflector",
      trace: { traceId: "scripted-learning-trace-2" },
    });
    expect(harness.inference.remaining()).toBe(0);
  });

  test("the scripted inference rejects role drift deterministically", async () => {
    const inference = createScriptedLearningInferencePort({ steps: [reflectionStep] });
    const request: AgentRunRequest = Object.freeze({
      runId: "wrong-role",
      role: "revision_author",
      variant: config.roles.revisionAuthor.variant,
      messages: Object.freeze([]),
      evidenceRefs: Object.freeze([]),
      availableTools: Object.freeze([]),
    });

    await expect(inference.run(request, RevisionAuthorOutputSchema)).rejects.toThrow(
      "Expected scripted role reflector",
    );
  });
});
