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
  type FileRevisionRef,
  ok,
  type Result,
  sha256,
} from "@noesis/domain";
import type { ExactCitation, HistoryPort, HistorySearchRequest } from "@noesis/intelligence";
import { describe, expect, test } from "vitest";
import {
  type AutomaticLearningConfig,
  AutomaticLearningConfigSchema,
  createAutomaticLearningOrgan,
  createInMemoryExperimentBriefStore,
  type ExperimentBriefStore,
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
    decision: "experiment" as const,
    title: "Preserve writing intent",
    hypothesis: "A scoped writing capability can apply corrections consistently",
    scope: "writing",
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
}) {
  const history = createHistoryHarness(input.citations ?? []);
  const feedback = createFeedbackHarness();
  const criteria = createCriteriaHarness();
  const inference = input.inference ?? createScriptedLearningInferencePort({ steps: input.steps });
  const registry = createAtomicCapabilityRegistry();
  registry.registerCapability(capability);
  const baseline = registry.constructRevision(baselineConstruction());
  const candidates = createCandidateDefinitionHarness();
  const experiments: Experiment[] = [];
  const experimentStore: ExperimentStorePort = Object.freeze({
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
      if (index === -1) experiments.push(experiment);
      else experiments[index] = experiment;
      return Object.freeze({
        kind: "database_row" as const,
        table: "experiments" as const,
        rowId: experiment.experimentId,
      });
    },
  });
  const organ = createAutomaticLearningOrgan({
    config,
    history: history.history,
    feedbackSignals: feedback.port,
    criteria: criteria.repository,
    inference,
    briefs: input.briefs ?? createInMemoryExperimentBriefStore(),
    capabilities: registry,
    candidateDefinitions: candidates.port,
    experiments: experimentStore,
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
    experiments: () => Object.freeze([...experiments]),
    putExperiment: experimentStore.putExperiment,
  });
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
        decision: "experiment" as const,
        title: "Research brief evidence",
        hypothesis: "Research briefs should separate evidence from inference",
        scope: "research brief",
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

    const authored = await harness.organ.authorExperimentRevision({ brief: observed.brief });
    expect(authored.revision.capabilityId).toBe(observed.brief.capability.capabilityId);
    expect(authored.revision.predecessorRevisionId).toBeUndefined();
    expect(authored.experiment.baselineRevision).toEqual(harness.baseline);
    expect(
      harness.candidates.requests().every((request) => request.predecessorRevisionId === undefined),
    ).toBe(true);
  });

  test("creates exactly one scoped criterion only for explicitly normative feedback", async () => {
    const harness = createHarness({ steps: [reflectionStep], citations: [citation(1)] });
    const result = await harness.organ.observeTurn({
      turn: turn({ correction: "Always preserve my voice when editing." }),
      baselineRevision: harness.baseline,
      capability,
    });

    expect(result.status).toBe("experiment");
    expect(harness.criteria.creates()).toHaveLength(1);
    expect(harness.criteria.values()[0]?.definition).toMatchObject({
      source: "correction",
      scope: "writing",
      evaluatorInstruction: "Always preserve my voice when editing.",
      promptOwnership: { owner: "user", layer: "learned_profile" },
    });
    expect(result.harvest.criterionCapture).toMatchObject({
      created: true,
      capture: { explicitlyNormative: true, confidence: 0.99, scope: "writing" },
    });
    expect(result.notification).toEqual({
      mode: "quiet",
      kind: "criterion",
      message: "Learned criterion for writing: Always preserve my voice when editing.",
    });
  });

  test("returns no change for irrelevant chat without retrieval, roles, criteria, or a modal", async () => {
    const harness = createHarness({ steps: [] });
    const result = await harness.organ.observeTurn({
      turn: turn({ userMessage: "Thanks, that looks good.", outcome: "accepted" }),
      baselineRevision: harness.baseline,
      capability,
    });

    expect(result).toMatchObject({ status: "no_change", reason: "irrelevant", interruption: null });
    expect(harness.history.requests()).toHaveLength(0);
    expect(harness.feedback.signals()).toHaveLength(0);
    expect(harness.criteria.creates()).toHaveLength(0);
    expect(harness.inference.requests()).toHaveLength(0);
  });

  test("accepts an explicit reflector no-change result without authoring a candidate", async () => {
    const harness = createHarness({
      steps: [
        Object.freeze({
          role: "reflector",
          value: Object.freeze({
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
    });
    expect(harness.candidates.requests()).toHaveLength(0);
    expect(harness.experiments()).toHaveLength(0);
  });

  test("harvests failed session outcomes as evidence-linked failure signals", async () => {
    const harness = createHarness({
      steps: [
        Object.freeze({
          role: "reflector",
          value: Object.freeze({ decision: "no_change", reason: "One failure is not recurrent yet." }),
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

  test("serializes two reflected observations without losing either provenance set", async () => {
    const inference = createBarrierInference([reflectionStep, reflectionStep]);
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
    if (first.status === "no_change" || second.status === "no_change")
      throw new Error("Expected concurrent experiment results");
    const brief = first.status === "deduped" ? first.brief : second.brief;
    expect(brief.feedbackSignalIds).toHaveLength(2);
    expect(brief.evidenceRefs).toEqual(
      expect.arrayContaining([databaseRef("current-message"), databaseRef("current-message-2")]),
    );
    expect(harness.experiments()).toHaveLength(1);
    expect(harness.experiments()[0]?.feedbackSignalIds).toHaveLength(2);
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

  test("does not count a current-turn file revision returned by history as recurrence", async () => {
    const currentRevision = fileRef("current-turn-source.md");
    const noRecurrence = Object.freeze({
      ...reflectionStep,
      value: Object.freeze({
        ...reflectionStep.value,
        recurrenceEvidenceCitationIndexes: Object.freeze([]),
      }),
    }) satisfies ScriptedLearningInferenceStep;
    const harness = createHarness({
      steps: [noRecurrence],
      citations: [fileRevisionCitation(currentRevision.revisionId, "The current correction")],
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
    expect(result.brief.evidenceRefs).toEqual([currentRevision]);
    expect(result.brief.citations).toEqual([]);
    expect(result.brief.recurrenceCitations).toEqual([]);
    expect(result.brief.recurrenceCount).toBe(0);
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
    expect(requests.map((request) => request.signal)).toEqual([controller.signal, controller.signal]);
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
    expect(requests.map((request) => request.role)).toEqual(["reflector", "revision_author"]);
    expect(requests[0]?.messages.map((message) => message.name)).toEqual([
      "signals",
      "evidence",
      "active_capabilities",
      "user_preferences",
    ]);
    expect(requests[1]?.messages.map((message) => message.name)).toEqual(["hypothesis", "source_cases"]);
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
    expect(result.revision.predecessorRevisionId).toBe(harness.baseline.capabilityRevisionId);
    expect(result.experiment.baselineRevision).toEqual(harness.baseline);
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
