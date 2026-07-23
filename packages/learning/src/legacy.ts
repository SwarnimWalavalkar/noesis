import type { CandidateSkill } from "@noesis/capabilities";
import { createId } from "@noesis/domain";
import type { ExperienceLedger } from "@noesis/ledger";

export interface LearningProposal {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly kind: "memory" | "knowledge" | "workflow";
  readonly title: string;
  readonly content: string;
  readonly evidenceEventIds: readonly string[];
  readonly confidence: number;
}

export interface LearningEngine {
  readonly reflect: (trailId: string) => Promise<readonly LearningProposal[]>;
  readonly candidateFromWorkflow: (
    proposal: LearningProposal,
    cases: Readonly<CandidateSkill["cases"]>,
  ) => Omit<CandidateSkill, "capabilityId" | "version">;
}

/** Compatibility surface for the first-iteration CLI while AC-08 adopts the automatic organ. */
export function createLearningEngine(ledger: ExperienceLedger): LearningEngine {
  const reflect = async (trailId: string): Promise<readonly LearningProposal[]> => {
    const events = ledger.eventsForTrail(trailId);
    const completed = events.filter((event) => event.type === "turn.completed");
    if (completed.length === 0) throw new Error("A trail needs a completed turn before reflection");
    const evidence = completed.map((event) => event.eventId);
    const last = completed.at(-1);
    const input = String(last?.payload["input"] ?? "completed work");
    const output = String(last?.payload["output"] ?? "");
    const proposals: LearningProposal[] = [
      {
        schemaVersion: 1,
        proposalId: createId("proposal"),
        kind: "memory",
        title: "Retain user intent",
        content: input,
        evidenceEventIds: evidence,
        confidence: 0.8,
      },
      {
        schemaVersion: 1,
        proposalId: createId("proposal"),
        kind: "knowledge",
        title: "Retain verified outcome",
        content: output,
        evidenceEventIds: evidence,
        confidence: 0.7,
      },
      {
        schemaVersion: 1,
        proposalId: createId("proposal"),
        kind: "workflow",
        title: "Reuse successful procedure",
        content: `When asked about ${input}, apply the evidenced completion pattern.`,
        evidenceEventIds: evidence,
        confidence: 0.75,
      },
    ];
    for (const proposal of proposals) {
      await ledger.append({
        type: "proposal.created",
        principal: "reflector",
        trailId,
        payload: { ...proposal, evidenceEventIds: [...proposal.evidenceEventIds] },
      });
    }
    return proposals;
  };

  const candidateFromWorkflow = (
    proposal: LearningProposal,
    cases: Readonly<CandidateSkill["cases"]>,
  ): Omit<CandidateSkill, "capabilityId" | "version"> => {
    if (proposal.kind !== "workflow") throw new Error("Only workflow proposals become skills");
    return {
      schemaVersion: 1,
      name: proposal.title
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, "-")
        .replaceAll(/(^-|-$)/g, ""),
      description: proposal.title,
      instructions: proposal.content,
      evidenceEventIds: [...proposal.evidenceEventIds],
      manifest: { effects: ["read"], resourcePrefixes: ["workspace:"], maxCostPerRun: 1 },
      cases: cases.map((testCase) => ({
        ...testCase,
        expectedIncludes: [...testCase.expectedIncludes],
      })),
    };
  };

  return Object.freeze({ reflect, candidateFromWorkflow });
}
