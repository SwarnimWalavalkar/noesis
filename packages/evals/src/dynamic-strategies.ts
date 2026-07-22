import { canonicalJson } from "@noesis/domain";
import type {
  AggregatedComparison,
  CaseComparison,
  DynamicEvaluationConfig,
  EvaluationAggregationStrategy,
  EvaluationGeneratorStrategy,
  EvaluationJudgeStrategy,
} from "./dynamic-contracts.ts";

function criterionRubric(input: {
  readonly criteria: readonly {
    readonly criterionId: string;
    readonly revision: number;
    readonly evaluatorInstruction: string;
    readonly evidenceRefs: readonly unknown[];
    readonly definitionRevision: unknown;
  }[];
}): readonly object[] {
  return input.criteria.map((criterion) => ({
    criterionId: criterion.criterionId,
    revision: criterion.revision,
    evaluatorInstruction: criterion.evaluatorInstruction,
    evidenceRefs: criterion.evidenceRefs,
    definitionRevision: criterion.definitionRevision,
  }));
}

export const DEFAULT_GENERATOR_STRATEGY: EvaluationGeneratorStrategy = {
  strategyId: "criterion-transfer-v1",
  renderPrompt: (input) =>
    canonicalJson({
      instruction:
        "Generate bounded transfer and negative cases that distinguish the intended behavior without using candidate outputs.",
      behaviorObjective: input.behaviorObjective,
      maxGeneratedCases: input.maxGeneratedCases,
      sourceCases: input.sourceCases.map((evaluationCase) => ({
        caseId: evaluationCase.caseId,
        instruction: evaluationCase.instruction,
        input: evaluationCase.input,
        evidenceRefs: evaluationCase.evidenceRefs,
      })),
      criteria: criterionRubric(input.criteria),
    }),
};

export const ALTERNATIVE_GENERATOR_STRATEGY: EvaluationGeneratorStrategy = {
  strategyId: "criterion-adversarial-v1",
  renderPrompt: (input) =>
    canonicalJson({
      instruction:
        "Generate bounded counterexamples, over-trigger cases, and abstention cases. Never infer candidate implementation details.",
      behaviorObjective: input.behaviorObjective,
      maxGeneratedCases: input.maxGeneratedCases,
      motivatingCases: input.sourceCases.map((evaluationCase) => ({
        caseId: evaluationCase.caseId,
        instruction: evaluationCase.instruction,
        input: evaluationCase.input,
        evidenceRefs: evaluationCase.evidenceRefs,
      })),
      hardQuestions: [
        "Where could literal compliance violate the user criterion?",
        "Where should the capability abstain?",
      ],
      criteria: criterionRubric(input.criteria),
    }),
};

export const DEFAULT_JUDGE_STRATEGY: EvaluationJudgeStrategy = {
  strategyId: "evidence-critic-v1",
  renderRubric: (input) =>
    canonicalJson({
      instruction:
        "Compare anonymous arms A and B. Critique both against the case and cited criteria, then choose a winner. Do not guess arm identity.",
      behaviorObjective: input.behaviorObjective,
      evaluationCase: {
        caseId: input.evaluationCase.caseId,
        kind: input.evaluationCase.kind,
        instruction: input.evaluationCase.instruction,
        input: input.evaluationCase.input,
        evidenceRefs: input.evaluationCase.evidenceRefs,
      },
      criteria: criterionRubric(input.criteria),
    }),
};

export const ALTERNATIVE_JUDGE_STRATEGY: EvaluationJudgeStrategy = {
  strategyId: "constraint-first-critic-v1",
  renderRubric: (input) =>
    canonicalJson({
      instruction:
        "Compare anonymous arms A and B. First enumerate criterion and artifact violations, then compare useful quality only among valid arms. Do not infer arm identity.",
      behaviorObjective: input.behaviorObjective,
      evaluationCase: {
        caseId: input.evaluationCase.caseId,
        kind: input.evaluationCase.kind,
        instruction: input.evaluationCase.instruction,
        input: input.evaluationCase.input,
        evidenceRefs: input.evaluationCase.evidenceRefs,
      },
      criteria: criterionRubric(input.criteria),
    }),
};

function countComparisons(comparisons: readonly CaseComparison[]) {
  return Object.freeze({
    candidateWins: comparisons.filter((item) => item.winner === "candidate").length,
    baselineWins: comparisons.filter((item) => item.winner === "baseline").length,
    ties: comparisons.filter((item) => item.winner === "tie").length,
    inconclusive: comparisons.filter((item) => item.winner === "inconclusive").length,
  });
}

function meanConfidence(comparisons: readonly CaseComparison[]): number {
  if (comparisons.length === 0) return 0;
  return comparisons.reduce((sum, item) => sum + item.judgment.confidence, 0) / comparisons.length;
}

function comparisonSummary(strategyId: string, counts: ReturnType<typeof countComparisons>): string {
  return `${strategyId}: candidate=${counts.candidateWins}, baseline=${counts.baselineWins}, tie=${counts.ties}, inconclusive=${counts.inconclusive}`;
}

export const DEFAULT_AGGREGATION_STRATEGY: EvaluationAggregationStrategy = {
  strategyId: "majority-with-confidence-v1",
  aggregate: (comparisons, config): AggregatedComparison => {
    const counts = countComparisons(comparisons);
    const confidence = meanConfidence(comparisons);
    const winner =
      counts.inconclusive > 0 || confidence < config.minimumConfidence
        ? "inconclusive"
        : counts.candidateWins >= config.minimumCandidateWins && counts.candidateWins > counts.baselineWins
          ? "candidate"
          : counts.baselineWins > counts.candidateWins
            ? "baseline"
            : "tie";
    return Object.freeze({
      winner,
      confidence,
      summary: comparisonSummary("majority-with-confidence-v1", counts),
      candidateWins: counts.candidateWins,
      baselineWins: counts.baselineWins,
      ties: counts.ties,
    });
  },
};

export const ALTERNATIVE_AGGREGATION_STRATEGY: EvaluationAggregationStrategy = {
  strategyId: "confidence-weighted-v1",
  aggregate: (comparisons, config): AggregatedComparison => {
    const counts = countComparisons(comparisons);
    const candidateWeight = comparisons
      .filter((item) => item.winner === "candidate")
      .reduce((sum, item) => sum + item.judgment.confidence, 0);
    const baselineWeight = comparisons
      .filter((item) => item.winner === "baseline")
      .reduce((sum, item) => sum + item.judgment.confidence, 0);
    const confidence = meanConfidence(comparisons);
    const winner =
      counts.inconclusive > 0 || confidence < config.minimumConfidence
        ? "inconclusive"
        : counts.candidateWins >= config.minimumCandidateWins && candidateWeight > baselineWeight
          ? "candidate"
          : baselineWeight > candidateWeight
            ? "baseline"
            : "tie";
    return Object.freeze({
      winner,
      confidence,
      summary: `${comparisonSummary("confidence-weighted-v1", counts)}, candidateWeight=${candidateWeight.toFixed(3)}, baselineWeight=${baselineWeight.toFixed(3)}`,
      candidateWins: counts.candidateWins,
      baselineWins: counts.baselineWins,
      ties: counts.ties,
    });
  },
};

export const BUILT_IN_GENERATOR_STRATEGIES = Object.freeze([
  DEFAULT_GENERATOR_STRATEGY,
  ALTERNATIVE_GENERATOR_STRATEGY,
]);

export const BUILT_IN_JUDGE_STRATEGIES = Object.freeze([DEFAULT_JUDGE_STRATEGY, ALTERNATIVE_JUDGE_STRATEGY]);

export const BUILT_IN_AGGREGATION_STRATEGIES = Object.freeze([
  DEFAULT_AGGREGATION_STRATEGY,
  ALTERNATIVE_AGGREGATION_STRATEGY,
]);

export function decisionFromEvaluation(input: {
  readonly candidateHasPermissionDelta: boolean;
  readonly railsPassed: boolean;
  readonly aggregation: AggregatedComparison;
  readonly config: DynamicEvaluationConfig;
}): "pass" | "block" | "approval-required" {
  if (!input.railsPassed || input.aggregation.winner !== "candidate") return "block";
  if (input.candidateHasPermissionDelta && input.config.rails.approvalOnPermissionDelta)
    return "approval-required";
  return "pass";
}
