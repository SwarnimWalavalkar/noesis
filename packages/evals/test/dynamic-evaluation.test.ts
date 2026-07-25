import {
  type CapabilityRevision,
  CapabilityRevisionRefSchema,
  canonicalJson,
  capabilityRevisionRef,
  type DatabaseRowRef,
  type EvidenceKind,
  type EvidenceRef,
  type EvidenceRevisionRef,
  type ExperimentTrial,
  type FileRevisionRef,
  type PreflightPlan,
  PreflightReportSchema,
  sha256,
} from "@noesis/domain";
import type { AuthorRevisionResult } from "@noesis/learning";
import type { RoleBackendRequest } from "@noesis/runtime-pi";
import {
  createDefaultRoleContextPolicy,
  createStructuredInferencePort,
  type RoleVariantConfiguration,
} from "@noesis/runtime-pi";
import { describe, expect, test } from "vitest";
import { createScriptedAgentRoleRunner } from "../../runtime-pi/test/support/scripted-role-runner.ts";
import {
  ALTERNATIVE_AGGREGATION_STRATEGY,
  ALTERNATIVE_GENERATOR_STRATEGY,
  ALTERNATIVE_JUDGE_STRATEGY,
  createCandidateAuthorCaseView,
  createDynamicEvaluationLaboratory,
  createLearningPreflightInput,
  createProtectedEvaluationSuiteRevision,
  DynamicPreflightInputBoundarySchema,
  type DynamicEvaluationConfig,
  type DynamicPreflightInput,
  type DynamicPreflightReport,
  type EvaluationCase,
  type EvaluationCriterionSet,
  type EvaluationEvidenceRecorder,
  type LearningAuthoredCandidate,
  type ProtectedEvaluationSuiteRevision,
  selectEvaluationCriteria,
  toWorkspacePreflightReport,
} from "../src/index.ts";

function digest(label: string): string {
  return sha256(label);
}

function fileRef(label: string, workingPath = `definitions/${label}.json`): FileRevisionRef {
  return Object.freeze({
    kind: "file_revision",
    revisionId: `revision-${label}`,
    workingPath,
    snapshotPath: `revisions/${label}.json`,
    contentDigest: digest(`file:${label}`),
  });
}

const sourceDefinition = fileRef("source-case");
const sourceEvidence = fileRef("source-evidence", "evidence/source-message.json");
const protectedEvidence = fileRef("protected-evidence", "evidence/protected-suite.json");
const protectedSuiteDefinition = fileRef(
  "protected-suite-definition",
  "config/evals/protected-research.json",
);
const criterionDefinition = fileRef("criterion-voice", "config/criteria/voice.json");
const criterionEvidence = fileRef("criterion-evidence", "evidence/user-correction.json");
const generatorPrompt = fileRef("generator-prompt", "config/evals/generator.md");
const trialPrompt = fileRef("trial-prompt", "config/evals/trial.md");
const judgePrompt = fileRef("judge-prompt", "config/evals/judge.md");

function revision(revisionId: string, prompt: FileRevisionRef): CapabilityRevision {
  const router = fileRef(`router-${revisionId}`, `candidates/${revisionId}/router.json`);
  return Object.freeze({
    capabilityRevisionId: revisionId,
    capabilityId: "cap-research",
    promptModules: Object.freeze([prompt]),
    skills: Object.freeze([]),
    tools: Object.freeze([]),
    toolset: Object.freeze({
      toolRevisionIds: Object.freeze([]),
      routerRevision: router,
      strategyId: "static-v1",
    }),
    activationPolicy: Object.freeze({ mode: "automatic_low_risk", scope: "research" }),
    permissionManifest: Object.freeze({
      effects: Object.freeze(["read"]),
      resourcePatterns: Object.freeze(["workspace:research/**"]),
      credentialRefs: Object.freeze([]),
    }),
    evidenceRefs: Object.freeze([sourceEvidence]),
    sourceEvaluationDefinitions: Object.freeze([sourceDefinition]),
    requestedPermissionDelta: Object.freeze({
      addedEffects: Object.freeze([]),
      widenedResources: Object.freeze([]),
      addedCredentialRefs: Object.freeze([]),
    }),
  });
}

const baselineRevision = revision("cap-research-r1", fileRef("baseline-prompt"));
const candidateRevision = revision("cap-research-r2", fileRef("candidate-prompt"));
const baselineRef = capabilityRevisionRef(baselineRevision);
const candidateRef = capabilityRevisionRef(candidateRevision);
let preflightSequence = 0;

function roleConfiguration(
  role: RoleVariantConfiguration["role"],
  promptRevision: FileRevisionRef,
): RoleVariantConfiguration {
  return Object.freeze({
    variant: Object.freeze({
      variantId: `${role}-default-v1`,
      axis: "role" as const,
      configurationRefs: Object.freeze([promptRevision]),
    }),
    role,
    provider: "fake",
    model: "fake-evaluator-1",
    reasoning: "off",
    systemPrompt: `Isolated ${role} role`,
    contextPolicy: createDefaultRoleContextPolicy(role),
  });
}

const roleConfigurations = Object.freeze([
  roleConfiguration("case_generator", generatorPrompt),
  roleConfiguration("trial", trialPrompt),
  roleConfiguration("judge_critic", judgePrompt),
]);

function invocation(configuration: RoleVariantConfiguration): DynamicEvaluationConfig["trial"] {
  if (configuration.variant.axis !== "role") throw new Error("Test roles require role-axis variants");
  return Object.freeze({
    promptRevision: configuration.variant.configurationRefs[0] ?? fileRef("missing"),
    variant: Object.freeze({ ...configuration.variant, axis: "role" as const }),
    provider: configuration.provider,
    model: configuration.model,
    reasoning: configuration.reasoning,
  });
}

function config(
  overrides: {
    readonly generatorStrategy?: string;
    readonly judgeStrategy?: string;
    readonly aggregationStrategy?: string;
  } = {},
): DynamicEvaluationConfig {
  const generator = roleConfigurations[0];
  const trial = roleConfigurations[1];
  const judge = roleConfigurations[2];
  if (!generator || !trial || !judge) throw new Error("Missing test role configuration");
  return Object.freeze({
    schemaVersion: 1,
    generator: Object.freeze({
      ...invocation(generator),
      strategyId: overrides.generatorStrategy ?? "criterion-transfer-v1",
    }),
    trial: invocation(trial),
    judge: Object.freeze({
      ...invocation(judge),
      strategyId: overrides.judgeStrategy ?? "evidence-critic-v1",
    }),
    aggregation: Object.freeze({
      strategyId: overrides.aggregationStrategy ?? "majority-with-confidence-v1",
      minimumCandidateWins: 2,
      minimumConfidence: 0.7,
    }),
    rails: Object.freeze({
      sourceRegressionTolerance: 0,
      approvalOnPermissionDelta: true,
    }),
  });
}

function criterionSet(
  instruction = "Preserve my voice and concise phrasing",
  criterionId = "voice",
  revisionRef = candidateRef,
): EvaluationCriterionSet {
  const criteria = Object.freeze([
    Object.freeze({
      criterionId,
      revision: 1,
      scope: "research",
      evaluatorInstruction: instruction,
      evidenceRefs: Object.freeze([criterionEvidence]),
      definitionRevision: criterionDefinition,
    }),
  ]);
  const snapshotId = `criteria-${criterionId}`;
  const sourceSnapshotDigest = digest(`source-snapshot:${criterionId}`);
  return Object.freeze({
    snapshotId,
    scope: "research",
    candidateRevision: revisionRef,
    criteria,
    sourceSnapshotDigest,
    snapshotDigest: sha256(
      canonicalJson({
        snapshotId,
        scope: "research",
        candidateRevision: revisionRef,
        criteria,
        sourceSnapshotDigest,
      }),
    ),
  });
}

const sourceCase: EvaluationCase = Object.freeze({
  caseId: "source-correction",
  kind: "source",
  owner: "candidate_author",
  instruction: "Rewrite the research update",
  input: "A verbose source update",
  evidenceRefs: Object.freeze([sourceEvidence]),
  definitionRevision: sourceDefinition,
  criterionRefs: Object.freeze([]),
});

const protectedCase: EvaluationCase = Object.freeze({
  caseId: "held-out-private",
  kind: "protected",
  owner: "evaluator",
  instruction: "Apply the behavior to an unseen update",
  input: "SECRET HELD OUT INPUT",
  evidenceRefs: Object.freeze([protectedEvidence]),
  criterionRefs: Object.freeze([]),
});

const protectedSuite = createProtectedEvaluationSuiteRevision({
  suiteId: "protected-research",
  revision: 1,
  scope: "research",
  definitionRevision: protectedSuiteDefinition,
  cases: Object.freeze([protectedCase]),
});

function input(
  overrides: Partial<
    Pick<DynamicPreflightInput, "criteria" | "config" | "candidate" | "protectedSuite" | "signal">
  > = {},
): DynamicPreflightInput {
  preflightSequence += 1;
  return Object.freeze({
    preflightId: `preflight-${preflightSequence}`,
    experimentId: "experiment-research",
    planId: "plan-research",
    scope: "research",
    behaviorObjective: "Produce an evidence-grounded concise research update",
    baseline: Object.freeze({ ref: baselineRef, revision: baselineRevision }),
    candidate: overrides.candidate ?? Object.freeze({ ref: candidateRef, revision: candidateRevision }),
    criteria: overrides.criteria ?? criterionSet(),
    sourceCases: Object.freeze([sourceCase]),
    protectedSuite: overrides.protectedSuite ?? protectedSuite,
    budget: Object.freeze({ maxCases: 3, maxAttemptsPerArm: 1, maxCost: 0 }),
    config: overrides.config ?? config(),
    ...(overrides.signal ? { signal: overrides.signal } : {}),
  });
}

function parseRolePrompt(request: RoleBackendRequest): {
  readonly role: string;
  readonly messages: readonly { readonly name?: string; readonly content: string }[];
} {
  return JSON.parse(request.prompt) as {
    readonly role: string;
    readonly messages: readonly { readonly name?: string; readonly content: string }[];
  };
}

function contractFreeJson(content: string): Readonly<Record<string, unknown>> {
  const body = content.split(/\n\n(?:Return JSON only\.|Repair the following malformed)/)[0] ?? content;
  return JSON.parse(body) as Readonly<Record<string, unknown>>;
}

function criterionRefsFrom(
  text: string,
): readonly { readonly criterionId: string; readonly revision: number }[] {
  const parsed = contractFreeJson(text);
  const { criteria } = parsed;
  if (!Array.isArray(criteria)) return Object.freeze([]);
  return Object.freeze(
    criteria.flatMap((criterion) => {
      if (
        criterion === null ||
        typeof criterion !== "object" ||
        !("criterionId" in criterion) ||
        typeof criterion.criterionId !== "string" ||
        !("revision" in criterion) ||
        typeof criterion.revision !== "number"
      )
        return [];
      return [
        Object.freeze({
          criterionId: criterion.criterionId,
          revision: criterion.revision,
        }),
      ];
    }),
  );
}

interface BackendScenario {
  readonly sourceRegression?: boolean;
  readonly invalidArtifact?: boolean;
  readonly malformedGenerator?: boolean;
  readonly repairGenerator?: boolean;
  readonly latencyMs?: number;
  readonly returnedRevisionMismatch?: boolean;
  readonly protectedRegression?: boolean;
  readonly ambiguousJudgment?: boolean;
}

function createBackend(scenario: BackendScenario = {}) {
  const prompts: RoleBackendRequest[] = [];
  const response = (text: string) => ({
    text,
    ...(scenario.latencyMs === undefined ? {} : { latencyMs: scenario.latencyMs }),
  });
  const respond = (request: RoleBackendRequest) => {
    prompts.push(request);
    const rendered = parseRolePrompt(request);
    if (rendered.role === "case_generator") {
      if (scenario.malformedGenerator || (scenario.repairGenerator && !request.runId.includes(":repair:")))
        return response("not-json");
      const criteriaMessage = rendered.messages.find((message) => message.name === "user_criteria");
      if (!criteriaMessage) throw new Error("Missing case-generator criteria");
      const criterionRefs = criterionRefsFrom(criteriaMessage.content);
      const voiceInstruction = request.prompt.includes("Preserve my voice")
        ? "Preserve voice in a transfer update"
        : "Apply the selected criterion in a transfer update";
      return response(
        JSON.stringify({
          cases: [
            {
              caseId: "generated-transfer",
              kind: "generated_transfer",
              instruction: voiceInstruction,
              input: voiceInstruction,
              sourceEvidenceRefs: [sourceEvidence],
              criterionRefs,
            },
          ],
        }),
      );
    }
    if (rendered.role === "trial") {
      const caseMessage = rendered.messages.find((message) => message.name === "case");
      const armMessage = rendered.messages.find((message) => message.name === "arm");
      if (!caseMessage || !armMessage) throw new Error("Missing paired trial messages");
      const trialCase = contractFreeJson(caseMessage.content);
      const arm = contractFreeJson(armMessage.content);
      const { capabilityRevision: capabilityRevisionValue } = arm;
      const capabilityRevision = CapabilityRevisionRefSchema.parse(capabilityRevisionValue);
      const candidate = capabilityRevision.capabilityRevisionId === candidateRef.capabilityRevisionId;
      const { caseId } = trialCase;
      const source = caseId === sourceCase.caseId;
      const protectedEvaluation = caseId === protectedCase.caseId;
      const mismatch = scenario.returnedRevisionMismatch && candidate;
      return response(
        JSON.stringify({
          content: candidate
            ? scenario.protectedRegression && protectedEvaluation
              ? "candidate overfit failure on held-out evidence"
              : "excellent concise output with preserved voice"
            : "generic output without the requested style",
          valid: !(candidate && scenario.invalidArtifact),
          invalidArtifacts:
            candidate && scenario.invalidArtifact ? ["artifact failed schema validation"] : [],
          unexpectedEffects: [],
          sourceAssertions: source
            ? [
                {
                  assertionId: "source-behavior",
                  passed: !(candidate && scenario.sourceRegression),
                  evidence: "source assertion check",
                },
              ]
            : [],
          identity: mismatch
            ? {
                capabilityId: "wrong-capability",
                capabilityRevisionId: "wrong-revision",
                bundleDigest: "0".repeat(64),
              }
            : {
                capabilityId: capabilityRevision.capabilityId,
                capabilityRevisionId: capabilityRevision.capabilityRevisionId,
                bundleDigest: capabilityRevision.bundleDigest,
              },
        }),
      );
    }
    if (rendered.role === "judge_critic") {
      const rubric = rendered.messages.find((message) => message.name === "rubric");
      const armA = rendered.messages.find((message) => message.name === "arm_A");
      const armB = rendered.messages.find((message) => message.name === "arm_B");
      if (!rubric || !armA || !armB) throw new Error("Missing blind judge inputs");
      if (scenario.ambiguousJudgment)
        return response(
          JSON.stringify({
            winner: "inconclusive",
            confidence: 0.2,
            reasons: ["The cited evidence cannot distinguish the anonymous arms"],
            violations: [],
            appliedCriteria: criterionRefsFrom(rubric.content),
          }),
        );
      const aOverfit = armA.content.includes("candidate overfit failure");
      const bOverfit = armB.content.includes("candidate overfit failure");
      const aCandidate = armA.content.includes("excellent concise output");
      const bCandidate = armB.content.includes("excellent concise output");
      return response(
        JSON.stringify({
          winner: aOverfit ? "B" : bOverfit ? "A" : aCandidate ? "A" : bCandidate ? "B" : "tie",
          confidence: 0.95,
          reasons: [
            request.prompt.includes("Preserve my voice")
              ? "preferred arm preserves the explicit voice criterion"
              : "preferred arm better satisfies the selected rubric",
          ],
          violations: [],
          appliedCriteria: criterionRefsFrom(rubric.content),
        }),
      );
    }
    throw new Error(`Unexpected role ${rendered.role}`);
  };
  return { prompts, respond };
}

interface RecordedEvidence {
  readonly ref: EvidenceRevisionRef;
  readonly value: unknown;
  readonly provenanceRefs: readonly EvidenceRef[];
}

function createRecorder(): EvaluationEvidenceRecorder & {
  readonly evidence: RecordedEvidence[];
  readonly trials: ExperimentTrial[];
  readonly reports: DynamicPreflightReport[];
  readonly plans: PreflightPlan[];
  readonly events: string[];
} {
  const evidence: RecordedEvidence[] = [];
  const trials: ExperimentTrial[] = [];
  const reports: DynamicPreflightReport[] = [];
  const plans: PreflightPlan[] = [];
  const events: string[] = [];
  let revision = 0;
  const appendEvidence = async <Kind extends EvidenceKind>(request: {
    readonly preflightId: string;
    readonly name: string;
    readonly kind: Kind;
    readonly value: unknown;
    readonly provenanceRefs: readonly EvidenceRef[];
  }): Promise<EvidenceRevisionRef<Kind>> => {
    revision += 1;
    const ref = Object.freeze({
      kind: "evidence_revision" as const,
      revisionId: `evidence-${revision}`,
      workingPath: `evaluations/${request.preflightId}/${request.name}.json`,
      snapshotPath: `evidence/${revision}.json`,
      contentDigest: sha256(canonicalJson(request.value)),
      evidenceKind: request.kind,
    });
    evidence.push({ ref, value: request.value, provenanceRefs: request.provenanceRefs });
    return ref;
  };
  const recordTrial = async (trial: ExperimentTrial): Promise<DatabaseRowRef<"experiment_trials">> => {
    events.push(`trial:${trial.trialId}`);
    trials.push(trial);
    return Object.freeze({ kind: "database_row", table: "experiment_trials", rowId: trial.trialId });
  };
  const recordPlan = async (plan: PreflightPlan): Promise<DatabaseRowRef<"preflight_plans">> => {
    plans.push(plan);
    events.push(`plan:${plan.planId}`);
    return Object.freeze({ kind: "database_row", table: "preflight_plans", rowId: plan.planId });
  };
  const recordReport = async (
    report: DynamicPreflightReport,
  ): Promise<DatabaseRowRef<"preflight_reports">> => {
    reports.push(report);
    return Object.freeze({
      kind: "database_row",
      table: "preflight_reports",
      rowId: report.preflightId,
    });
  };
  return Object.freeze({
    appendEvidence,
    recordPlan,
    recordTrial,
    recordReport,
    evidence,
    trials,
    reports,
    plans,
    events,
  });
}

function createHarness(scenario: BackendScenario = {}, maxRepairAttempts = 1) {
  const backend = createBackend(scenario);
  const runner = createScriptedAgentRoleRunner({
    variants: roleConfigurations,
    respond: backend.respond,
  });
  const structuredRoles = createStructuredInferencePort({ runner, maxRepairAttempts });
  const recorder = createRecorder();
  const laboratory = createDynamicEvaluationLaboratory({
    structuredRoles,
    recorder,
  });
  return { backend, recorder, laboratory };
}

describe("AC-06 dynamic evaluation laboratory", () => {
  test("selects immutable criterion revisions with complete definition and provenance citations", async () => {
    const selected = await selectEvaluationCriteria(
      {
        snapshotRelevant: async (request) => ({
          ok: true,
          value: {
            snapshotId: request.snapshotId,
            scope: request.scope,
            candidateRevision: request.candidateRevision,
            selectedCriterionIds: ["voice"],
            criteria: [
              {
                criterionId: "voice",
                revision: 3,
                scope: "research",
                evaluatorInstruction: "Preserve my voice",
                evidenceRefs: [criterionEvidence],
                promptOwnership: { owner: "user", layer: "learned_profile" },
                definitionRevision: criterionDefinition,
              },
            ],
            snapshotDigest: digest("config-snapshot"),
          },
        }),
      },
      {
        snapshotId: "criteria-evaluation",
        scope: "research",
        candidateRevision: candidateRef,
      },
    );

    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.value.criteria[0]).toMatchObject({
      criterionId: "voice",
      revision: 3,
      definitionRevision: criterionDefinition,
      evidenceRefs: [criterionEvidence],
    });
    expect(selected.value.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("composes an AC-05 authored candidate into the AC-06 preflight contract without runtime coordination", async () => {
    const learningOutputFitsHandoff: AuthorRevisionResult extends LearningAuthoredCandidate ? true : false =
      true;
    expect(learningOutputFitsHandoff).toBe(true);
    const authored: LearningAuthoredCandidate = Object.freeze({
      brief: Object.freeze({
        experimentId: "experiment-research",
        hypothesis: "Produce an evidence-grounded concise research update",
        scope: "research",
        baselineRevision: baselineRef,
        sourceCases: Object.freeze([
          Object.freeze({
            caseId: sourceCase.caseId,
            scope: "research",
            input: sourceCase.input,
            expectedBehavior: sourceCase.instruction,
            evidenceRefs: sourceCase.evidenceRefs,
          }),
        ]),
      }),
      revision: candidateRevision,
      revisionRef: candidateRef,
      experiment: Object.freeze({
        experimentId: "experiment-research",
        hypothesis: "Produce an evidence-grounded concise research update",
        scope: "research",
        evidenceRefs: Object.freeze([sourceEvidence]),
        baselineRevision: baselineRef,
        candidateRevisions: Object.freeze([candidateRef]),
        feedbackSignalIds: Object.freeze(["signal-correction"]),
        status: "authoring" as const,
      }),
    });
    const composed = createLearningPreflightInput({
      preflightId: "preflight-learning-handoff",
      planId: "plan-learning-handoff",
      authored,
      baselineRevision,
      criteria: criterionSet(),
      protectedSuite,
      budget: Object.freeze({ maxCases: 3, maxAttemptsPerArm: 1, maxCost: 0 }),
      config: config(),
    });

    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(DynamicPreflightInputBoundarySchema.safeParse(composed.value).success).toBe(true);
    expect(composed.value.candidate.ref).toEqual(candidateRef);
    expect(composed.value.sourceCases).toEqual([sourceCase]);
    expect(
      createCandidateAuthorCaseView([...composed.value.sourceCases, ...composed.value.protectedSuite.cases]),
    ).toEqual({ sourceCases: [sourceCase] });
    const driftedRef = Object.freeze({ ...candidateRef, bundleDigest: "0".repeat(64) });
    const mismatched = createLearningPreflightInput({
      preflightId: "preflight-drifted-handoff",
      planId: "plan-drifted-handoff",
      authored: Object.freeze({
        ...authored,
        revisionRef: driftedRef,
        experiment: Object.freeze({
          ...authored.experiment,
          candidateRevisions: Object.freeze([driftedRef]),
        }),
      }),
      baselineRevision,
      criteria: criterionSet("Preserve my voice and concise phrasing", "voice", driftedRef),
      protectedSuite,
      budget: Object.freeze({ maxCases: 3, maxAttemptsPerArm: 1, maxCost: 0 }),
      config: config(),
    });
    expect(mismatched).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });

    const harness = createHarness();
    const result = await harness.laboratory.runPreflight(composed.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      decision: "pass",
      baselineRevision: baselineRef,
      candidateRevision: candidateRef,
      canonicalCandidateDigest: candidateRef.bundleDigest,
    });
    const roleRequests = harness.backend.prompts.map(parseRolePrompt);
    expect(roleRequests.find((request) => request.role === "case_generator")?.messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining("SECRET HELD OUT INPUT") }),
      ]),
    );
    expect(
      roleRequests
        .filter((request) => request.role === "judge_critic")
        .every((request) => !JSON.stringify(request.messages).includes(candidateRef.capabilityRevisionId)),
    ).toBe(true);
  });

  test("passes a convincing candidate and emits a fully cited preflight report", async () => {
    const harness = createHarness();
    const result = await harness.laboratory.runPreflight(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe("pass");
    expect(result.value.trials).toHaveLength(6);
    for (const caseId of result.value.cases.map((evaluationCase) => evaluationCase.caseId)) {
      const pair = result.value.trials.filter((trial) => trial.caseId === caseId);
      expect(new Set(pair.map((trial) => trial.inputDigest)).size).toBe(1);
    }
    expect(result.value.comparisons).toHaveLength(3);
    expect(result.value.railChecks.every((rail) => rail.passed)).toBe(true);
    expect(result.value.protectedSuite).toEqual(protectedSuite);
    expect(result.value.aggregation).toMatchObject({
      inconclusive: 0,
      decisiveDisagreements: 0,
    });
    expect(result.value.aggregation.comparisonEvidenceRefs).toEqual(
      result.value.comparisons.map((comparison) => comparison.judgmentEvidence),
    );
    expect(result.value.canonicalCandidateDigest).toBe(candidateRef.bundleDigest);
    expect(result.value.suiteDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.value.config.generator).toMatchObject({
      promptRevision: generatorPrompt,
      provider: "fake",
      model: "fake-evaluator-1",
      reasoning: "off",
    });
    expect(result.value.config.judge.promptRevision).toEqual(judgePrompt);
    expect(result.value.criterionSnapshot.criteria[0]).toMatchObject({
      definitionRevision: criterionDefinition,
      evidenceRefs: [criterionEvidence],
    });
    expect(result.value.cases.every((evaluationCase) => evaluationCase.evidenceRefs.length > 0)).toBe(true);
    expect(result.value.trials.every((trial) => trial.outputEvidence && trial.traceEvidence)).toBe(true);
    expect(result.value.comparisons.every((item) => item.judgmentEvidence)).toBe(true);
    const reportRecord = harness.recorder.evidence.find((item) => item.ref.evidenceKind === "report");
    expect(reportRecord?.provenanceRefs).toEqual(
      expect.arrayContaining([
        criterionDefinition,
        criterionEvidence,
        sourceDefinition,
        sourceEvidence,
        protectedEvidence,
        protectedSuiteDefinition,
        generatorPrompt,
        trialPrompt,
        judgePrompt,
      ]),
    );
    expect(harness.recorder.reports).toHaveLength(1);
    expect(harness.recorder.plans).toHaveLength(1);
    expect(harness.recorder.plans[0]?.caseRefs).toEqual(result.value.caseEvidence);
    expect(harness.recorder.events[0]).toBe(`plan:${result.value.planId}`);
  });

  test("fails the boundary when the protected suite is missing and fails preflight when stale", async () => {
    const validInput = input();
    const { protectedSuite: _protectedSuite, ...withoutProtectedSuite } = validInput;
    const missing = DynamicPreflightInputBoundarySchema.safeParse(withoutProtectedSuite);
    expect(missing.success).toBe(false);

    const staleSuite: ProtectedEvaluationSuiteRevision = Object.freeze({
      ...protectedSuite,
      revision: protectedSuite.revision + 1,
    });
    const staleHarness = createHarness();
    const stale = await staleHarness.laboratory.runPreflight(input({ protectedSuite: staleSuite }));
    expect(stale).toMatchObject({
      ok: false,
      error: {
        code: "configuration",
        stage: "setup",
        message: expect.stringContaining("Protected suite revision digest"),
      },
    });
    expect(staleHarness.backend.prompts).toHaveLength(0);
  });

  test("blocks a source-overfit candidate that loses an evaluator-owned protected case", async () => {
    const harness = createHarness({ protectedRegression: true });
    const result = await harness.laboratory.runPreflight(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.aggregation.winner).toBe("candidate");
    expect(result.value.decision).toBe("block");
    expect(result.value.railChecks.find((rail) => rail.rail === "protected_case_regression")).toMatchObject({
      passed: false,
      details: [`${protectedCase.caseId}:baseline`],
    });
  });

  test("records ambiguous comparisons as cited abstentions with no activation-eligible decision", async () => {
    const harness = createHarness({ ambiguousJudgment: true });
    const result = await harness.laboratory.runPreflight(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.aggregation).toMatchObject({
      winner: "inconclusive",
      inconclusive: 3,
      decisiveDisagreements: 0,
    });
    expect(result.value.aggregation.comparisonEvidenceRefs).toEqual(
      result.value.comparisons.map((comparison) => comparison.judgmentEvidence),
    );
    expect(result.value.decision).toBe("block");
    expect(result.value.railChecks.find((rail) => rail.rail === "protected_case_regression")).toMatchObject({
      passed: false,
      details: [`${protectedCase.caseId}:inconclusive`],
    });
    const reportEvidence = harness.recorder.evidence.find(
      (evidence) => evidence.ref.evidenceKind === "report",
    );
    expect(reportEvidence?.value).toMatchObject({
      aggregation: {
        inconclusive: 3,
        comparisonEvidenceRefs: result.value.aggregation.comparisonEvidenceRefs,
      },
    });
  });

  test("blocks a motivating source regression even when the blind judge prefers the candidate", async () => {
    const harness = createHarness({ sourceRegression: true });
    const result = await harness.laboratory.runPreflight(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.aggregation.winner).toBe("candidate");
    expect(result.value.decision).toBe("block");
    expect(result.value.railChecks.find((rail) => rail.rail === "source_regression")).toMatchObject({
      passed: false,
      details: ["source-behavior"],
    });
  });

  test("blocks invalid candidate artifacts through a deterministic rail", async () => {
    const harness = createHarness({ invalidArtifact: true });
    const result = await harness.laboratory.runPreflight(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe("block");
    expect(result.value.railChecks.find((rail) => rail.rail === "artifact_validity")).toMatchObject({
      passed: false,
      details: expect.arrayContaining(["artifact failed schema validation"]),
    });
  });

  test("records approval_required without activating or resolving an experiment", async () => {
    const permissionCandidate = Object.freeze({
      ...candidateRevision,
      requestedPermissionDelta: Object.freeze({
        addedEffects: Object.freeze(["network"]),
        widenedResources: Object.freeze([]),
        addedCredentialRefs: Object.freeze([]),
      }),
    });
    const permissionRef = capabilityRevisionRef(permissionCandidate);
    const harness = createHarness();
    const result = await harness.laboratory.runPreflight(
      input({
        candidate: Object.freeze({ ref: permissionRef, revision: permissionCandidate }),
        criteria: criterionSet("Preserve my voice and concise phrasing", "voice", permissionRef),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.aggregation.winner).toBe("candidate");
    expect(result.value.decision).toBe("approval_required");
    expect(harness.recorder.reports.at(-1)?.decision).toBe("approval_required");
    const durableReport = toWorkspacePreflightReport(result.value);
    expect(durableReport.decision).toBe("approval_required");
    expect(PreflightReportSchema.safeParse(durableReport).success).toBe(true);
  });

  test("derives approval_required from manifest expansion despite a lying empty delta", async () => {
    const expandedCandidate = Object.freeze({
      ...candidateRevision,
      permissionManifest: Object.freeze({
        ...candidateRevision.permissionManifest,
        effects: Object.freeze([...candidateRevision.permissionManifest.effects, "network"]),
      }),
      requestedPermissionDelta: Object.freeze({
        addedEffects: Object.freeze([]),
        widenedResources: Object.freeze([]),
        addedCredentialRefs: Object.freeze([]),
      }),
    });
    const expandedRef = capabilityRevisionRef(expandedCandidate);
    const result = await createHarness().laboratory.runPreflight(
      input({
        candidate: Object.freeze({ ref: expandedRef, revision: expandedCandidate }),
        criteria: criterionSet("Preserve my voice and concise phrasing", "voice", expandedRef),
      }),
    );
    expect(result).toMatchObject({ ok: true, value: { decision: "approval_required" } });
  });

  test("records explicit approval-required activation policy even without permission expansion", async () => {
    const approvalCandidate = Object.freeze({
      ...candidateRevision,
      activationPolicy: Object.freeze({ mode: "approval_required" as const, scope: "research" }),
    });
    const approvalRef = capabilityRevisionRef(approvalCandidate);
    const result = await createHarness().laboratory.runPreflight(
      input({
        candidate: Object.freeze({ ref: approvalRef, revision: approvalCandidate }),
        criteria: criterionSet("Preserve my voice and concise phrasing", "voice", approvalRef),
      }),
    );
    expect(result).toMatchObject({ ok: true, value: { decision: "approval_required" } });
  });

  test("an explicit criterion changes generated cases and evidence-backed judgment", async () => {
    const voiceHarness = createHarness();
    const factualHarness = createHarness();
    const voice = await voiceHarness.laboratory.runPreflight(input());
    const factualCriteria = criterionSet("Prioritize factual completeness", "factual");
    const factual = await factualHarness.laboratory.runPreflight(input({ criteria: factualCriteria }));

    expect(voice.ok && factual.ok).toBe(true);
    if (!voice.ok || !factual.ok) return;
    expect(voice.value.cases.find((item) => item.kind === "generated_transfer")?.input).toContain(
      "Preserve voice",
    );
    expect(factual.value.cases.find((item) => item.kind === "generated_transfer")?.input).not.toContain(
      "Preserve voice",
    );
    expect(voice.value.comparisons[0]?.judgment.reasons[0]).toContain("voice criterion");
    expect(factual.value.comparisons[0]?.judgment.reasons[0]).toContain("selected rubric");
    expect(factual.value.comparisons[0]?.judgment.appliedCriteria).toEqual([
      { criterionId: "factual", revision: 1 },
    ]);
  });

  test("fails closed before role execution when the complete candidate digest is mismatched", async () => {
    const harness = createHarness();
    const mismatchedRef = Object.freeze({ ...candidateRef, bundleDigest: "0".repeat(64) });
    const result = await harness.laboratory.runPreflight(
      input({
        candidate: Object.freeze({ ref: mismatchedRef, revision: candidateRevision }),
        criteria: criterionSet("Preserve my voice and concise phrasing", "voice", mismatchedRef),
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "identity_mismatch", stage: "setup" },
    });
    expect(harness.backend.prompts).toHaveLength(0);
  });

  test("accepts a genesis comparison for a genuinely new scoped capability slot", async () => {
    const { predecessorRevisionId: _predecessorRevisionId, ...candidateWithoutPredecessor } =
      candidateRevision;
    const newSlotRevision = Object.freeze({
      ...candidateWithoutPredecessor,
      capabilityId: "research-brief-evidence",
      activationPolicy: Object.freeze({
        ...candidateWithoutPredecessor.activationPolicy,
        scope: "research",
      }),
    });
    const newSlotRef = capabilityRevisionRef(newSlotRevision);
    const harness = createHarness();
    const result = await harness.laboratory.runPreflight(
      input({
        candidate: Object.freeze({ ref: newSlotRef, revision: newSlotRevision }),
        criteria: criterionSet("Preserve my voice and concise phrasing", "voice", newSlotRef),
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        baselineRevision: baselineRef,
        candidateRevision: newSlotRef,
        decision: "pass",
      },
    });
  });

  test("rejects a cross-capability replacement when the candidate claims a predecessor", async () => {
    const crossCapabilityRevision = Object.freeze({
      ...candidateRevision,
      capabilityId: "research-brief-evidence",
      predecessorRevisionId: baselineRevision.capabilityRevisionId,
    });
    const crossCapabilityRef = capabilityRevisionRef(crossCapabilityRevision);
    const harness = createHarness();
    const result = await harness.laboratory.runPreflight(
      input({
        candidate: Object.freeze({
          ref: crossCapabilityRef,
          revision: crossCapabilityRevision,
        }),
        criteria: criterionSet("Preserve my voice and concise phrasing", "voice", crossCapabilityRef),
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "identity_mismatch",
        stage: "setup",
        message:
          "A candidate may cross capability identity only when it creates a new slot without a predecessor",
      },
    });
    expect(harness.backend.prompts).toHaveLength(0);
  });

  test("keeps held-out cases from candidate authors and blinds judge arm identity", async () => {
    const harness = createHarness();
    const result = await harness.laboratory.runPreflight(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const authorView = createCandidateAuthorCaseView(result.value.cases);
    expect(authorView.sourceCases.map((item) => item.caseId)).toEqual([sourceCase.caseId]);
    expect(JSON.stringify(authorView)).not.toContain(protectedCase.input);
    const generatorRequest = harness.backend.prompts.find(
      (request) => parseRolePrompt(request).role === "case_generator",
    );
    expect(generatorRequest?.prompt).not.toContain(protectedCase.input);
    const judgeRequests = harness.backend.prompts.filter(
      (request) => parseRolePrompt(request).role === "judge_critic",
    );
    expect(judgeRequests).toHaveLength(3);
    for (const request of judgeRequests) {
      expect(request.prompt).not.toContain(baselineRef.capabilityRevisionId);
      expect(request.prompt).not.toContain(candidateRef.capabilityRevisionId);
      expect(request.prompt).not.toContain(baselineRef.bundleDigest);
      expect(request.prompt).not.toContain(candidateRef.bundleDigest);
      expect(request.prompt).not.toContain('"baseline"');
      expect(request.prompt).not.toContain('"candidate"');
      expect(request.prompt).toContain('"name": "arm_A"');
      expect(request.prompt).toContain('"name": "arm_B"');
    }
  });

  test("swaps generator, judge, and aggregation strategies into a comparable research run", async () => {
    const defaultHarness = createHarness();
    const alternativeHarness = createHarness();
    const defaultRun = await defaultHarness.laboratory.runPreflight(input());
    const alternativeConfig = config({
      generatorStrategy: ALTERNATIVE_GENERATOR_STRATEGY.strategyId,
      judgeStrategy: ALTERNATIVE_JUDGE_STRATEGY.strategyId,
      aggregationStrategy: ALTERNATIVE_AGGREGATION_STRATEGY.strategyId,
    });
    const alternativeRun = await alternativeHarness.laboratory.runPreflight(
      input({ config: alternativeConfig }),
    );

    expect(defaultRun.ok && alternativeRun.ok).toBe(true);
    if (!defaultRun.ok || !alternativeRun.ok) return;
    expect(alternativeRun.value.decision).toBe("pass");
    expect(alternativeRun.value.baselineRevision).toEqual(defaultRun.value.baselineRevision);
    expect(alternativeRun.value.candidateRevision).toEqual(defaultRun.value.candidateRevision);
    expect(alternativeRun.value.trials.map((trial) => trial.inputDigest)).toEqual(
      defaultRun.value.trials.map((trial) => trial.inputDigest),
    );
    expect(alternativeRun.value.config).toMatchObject({
      generator: { strategyId: "criterion-adversarial-v1" },
      judge: { strategyId: "constraint-first-critic-v1" },
      aggregation: { strategyId: "confidence-weighted-v1" },
    });
    expect(alternativeRun.value.aggregation.summary).toContain("confidence-weighted-v1");
  });

  test("surfaces malformed role output with repair telemetry", async () => {
    const harness = createHarness({ malformedGenerator: true }, 1);
    const result = await harness.laboratory.runPreflight(input());

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "malformed_role_output",
        stage: "case_generation",
        role: "case_generator",
        trace: { telemetry: { repairAttempts: 1, status: "failed" } },
      },
    });
  });

  test("records successful structured-output repair telemetry in the report", async () => {
    const harness = createHarness({ repairGenerator: true }, 1);
    const result = await harness.laboratory.runPreflight(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.roleTelemetry[0]?.telemetry).toMatchObject({
      attempts: 2,
      repairAttempts: 1,
      status: "completed",
    });
  });

  test("surfaces cancellation with aborted role telemetry", async () => {
    const harness = createHarness({ latencyMs: 50 });
    const controller = new AbortController();
    const pending = harness.laboratory.runPreflight(input({ signal: controller.signal }));
    controller.abort("test cancellation");
    const result = await pending;

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "cancelled",
        stage: "case_generation",
        role: "case_generator",
        trace: { telemetry: { status: "aborted" } },
      },
    });
  });

  test("blocks a trial runner identity mismatch through the protected identity rail", async () => {
    const harness = createHarness({ returnedRevisionMismatch: true });
    const result = await harness.laboratory.runPreflight(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe("block");
    expect(result.value.railChecks.find((rail) => rail.rail === "capability_identity")).toMatchObject({
      passed: false,
    });
  });
});
