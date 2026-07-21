import {
  candidateDigest,
  type CandidateSkill,
  type CapabilityRegistry,
  type RegressionCase,
} from "@noesis/capabilities";
import { canonicalJson, sha256, toJsonValue } from "@noesis/domain";
import type { ExperienceLedger } from "@noesis/ledger";

export interface CaseResult {
  readonly caseId: string;
  readonly source: RegressionCase["source"];
  readonly baselineScore: number;
  readonly candidateScore: number;
  readonly regression: boolean;
  readonly output: string;
}

export interface EvaluationReport {
  readonly schemaVersion: 1;
  readonly capabilityId: string;
  readonly version: number;
  readonly candidateDigest: string;
  readonly suiteId: string;
  readonly suiteDigest: string;
  readonly suiteProvenance: string;
  readonly passed: boolean;
  readonly score: number;
  readonly results: readonly CaseResult[];
  readonly risks: readonly string[];
}

export type SkillRunner = (candidate: CandidateSkill, testCase: RegressionCase) => Promise<string>;

export const deterministicSkillRunner: SkillRunner = async (candidate, testCase) =>
  `${candidate.instructions}\n${testCase.input}`;

export const PROTECTED_EVALUATION_SUITE = {
  schemaVersion: 1,
  suiteId: "noesis-protected-held-out-v1",
  provenance: "protected:noesis/evals/v1",
  cases: [
    {
      caseId: "protected-transfer",
      source: "held-out" as const,
      input: "transfer the workflow to a novel task",
      expectedIncludes: ["evidenced", "pattern"],
      baselineScore: 0.5,
    },
  ],
} as const;

export const PROTECTED_EVALUATION_SUITE_DIGEST = sha256(canonicalJson(PROTECTED_EVALUATION_SUITE));
export const PROTECTED_PROMOTION_POLICY = {
  suiteId: PROTECTED_EVALUATION_SUITE.suiteId,
  suiteDigest: PROTECTED_EVALUATION_SUITE_DIGEST,
} as const;

export interface EvaluationLab {
  readonly evaluate: (capabilityId: string, version: number) => Promise<EvaluationReport>;
}

export function createEvaluationLab(
  ledger: ExperienceLedger,
  registry: CapabilityRegistry,
  runner: SkillRunner = deterministicSkillRunner,
): EvaluationLab {
  const evaluate = async (capabilityId: string, version: number): Promise<EvaluationReport> => {
    const candidate = registry.getCandidate(capabilityId, version);
    if (!candidate) throw new Error(`Canonical candidate not found: ${capabilityId}@${version}`);
    if (candidate.cases.length === 0 || candidate.cases.some((item) => item.source !== "source"))
      throw new Error("Candidate authoring accepts source cases only; held-out cases are protected");
    const cases: readonly RegressionCase[] = [...candidate.cases, ...PROTECTED_EVALUATION_SUITE.cases];
    const results: CaseResult[] = [];
    for (const testCase of cases) {
      const output = await runner(candidate, testCase);
      const matches = testCase.expectedIncludes.filter((term) =>
        output.toLowerCase().includes(term.toLowerCase()),
      ).length;
      const score = testCase.expectedIncludes.length === 0 ? 1 : matches / testCase.expectedIncludes.length;
      results.push({
        caseId: testCase.caseId,
        source: testCase.source,
        baselineScore: testCase.baselineScore,
        candidateScore: score,
        regression: score < testCase.baselineScore,
        output,
      });
    }
    const score = results.reduce((sum, result) => sum + result.candidateScore, 0) / results.length;
    const regressions = results.filter((result) => result.regression);
    const report: EvaluationReport = {
      schemaVersion: 1,
      capabilityId: candidate.capabilityId,
      version: candidate.version,
      candidateDigest: candidateDigest(candidate),
      suiteId: PROTECTED_EVALUATION_SUITE.suiteId,
      suiteDigest: PROTECTED_EVALUATION_SUITE_DIGEST,
      suiteProvenance: PROTECTED_EVALUATION_SUITE.provenance,
      passed: regressions.length === 0 && score >= 0.8,
      score,
      results,
      risks: regressions.map((result) => `Regression in ${result.caseId}`),
    };
    await ledger.append({
      type: "capability.evaluated",
      principal: "evaluator",
      payload: {
        capabilityId: report.capabilityId,
        version: report.version,
        candidateDigest: report.candidateDigest,
        suiteId: report.suiteId,
        suiteDigest: report.suiteDigest,
        suiteProvenance: report.suiteProvenance,
        passed: report.passed,
        score: report.score,
        regressions: regressions.map((item) => item.caseId),
        report: toJsonValue(report),
      },
    });
    return report;
  };

  return Object.freeze({ evaluate });
}
