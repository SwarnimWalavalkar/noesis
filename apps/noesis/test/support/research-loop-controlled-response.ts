import {
  CapabilityRevisionRefSchema,
  EvidenceRefSchema,
  type CapabilityRevisionRef,
  type EvidenceRef,
} from "@noesis/domain";
import { z } from "zod";
import {
  controlledToolCallResponse,
  type ControlledPiPrompt,
} from "../../../../packages/runtime-pi/test/support/controlled-pi-models.ts";

const RolePromptSchema = z.object({
  role: z.enum(["reflector", "revision_author", "revision_agent", "case_generator", "trial", "judge_critic"]),
  messages: z.array(z.object({ name: z.string().optional(), content: z.string() })),
  capabilityRevisions: z.array(CapabilityRevisionRefSchema),
});

type RolePrompt = Readonly<z.infer<typeof RolePromptSchema>>;

function parseRolePrompt(prompt: string): RolePrompt {
  return RolePromptSchema.parse(JSON.parse(prompt));
}

function namedMessage(prompt: RolePrompt, name: string): string {
  const message = prompt.messages.find((candidate) => candidate.name === name);
  if (!message) throw new Error(`Controlled ${prompt.role} role is missing message ${name}`);
  return message.content;
}

function parsedMessage(prompt: RolePrompt, name: string): unknown {
  return JSON.parse(namedMessage(prompt, name));
}

function sourceEvidence(prompt: RolePrompt): EvidenceRef {
  const cases = z
    .array(z.object({ evidenceRefs: z.array(EvidenceRefSchema).min(1) }))
    .min(1)
    .parse(parsedMessage(prompt, "evidence"));
  const reference = cases[0]?.evidenceRefs[0];
  if (!reference) throw new Error("Controlled case generator received no source evidence");
  return reference;
}

function trialRevision(prompt: RolePrompt): CapabilityRevisionRef {
  const revision = prompt.capabilityRevisions[0];
  if (!revision) throw new Error("Controlled trial received no pinned capability revision");
  return revision;
}

export function researchLoopControlledResponse(
  input: ControlledPiPrompt,
): string | ReturnType<typeof controlledToolCallResponse> {
  if (!input.systemPrompt.includes("role:")) {
    const immutableSkill =
      "Produce concise research briefs with explicit evidence, inference, and uncertainty.";
    if (
      input.lastUserText.includes("Prepare a research brief") &&
      input.systemPrompt.includes(immutableSkill)
    ) {
      if (!input.context.messages.some((message) => message.role === "toolResult"))
        return controlledToolCallResponse(
          "search_sessions",
          { query: "research brief evidence" },
          "acceptance-search",
        );
      return "Served immutable research-brief behavior through the pinned search_sessions tool.";
    }
    return `Controlled Pi completion for: ${input.lastUserText}`;
  }
  const prompt = parseRolePrompt(input.lastUserText);
  if (input.systemPrompt.includes("role: outcome_judge")) {
    const comparisonMessage = prompt.messages.some((message) => message.name === "outcome_comparison")
      ? "outcome_comparison"
      : "relevant_traces";
    const observationIds = [
      ...namedMessage(prompt, comparisonMessage).matchAll(/"observationId"\s*:\s*"([^"]+)"/gu),
    ].flatMap((match) => (match[1] ? [match[1]] : []));
    if (observationIds.length === 0)
      throw new Error("Controlled outcome judge received no experiment observations");
    return JSON.stringify({
      proposal: "revert",
      citedObservationIds: [...new Set(observationIds)],
      summary: "The controlled correction evidence requests a protected revert.",
    });
  }
  if (prompt.role === "reflector")
    return JSON.stringify({
      decision: "experiment",
      title: "Evidence-grounded research briefs",
      hypothesis: "Research briefs improve when cited evidence is separated from inference",
      scope: "research brief",
      capabilityName: "Research brief evidence",
      capabilityIntent: "Separate cited evidence from inference in research briefs",
      sourceCases: [
        {
          title: "Prepare an evidence-grounded brief",
          input: "Prepare a research brief about the current question.",
          expectedBehavior: "Clearly separate cited evidence from inference.",
        },
      ],
    });
  if (prompt.role === "revision_author" || prompt.role === "revision_agent")
    return JSON.stringify({
      promptModules: [
        {
          path: "evidence.md",
          content: "For research briefs, clearly label sourced evidence and distinguish it from inference.",
        },
      ],
      skills: [
        {
          path: "SKILL.md",
          content: "Produce concise research briefs with explicit evidence, inference, and uncertainty.",
        },
      ],
      tools: [
        {
          path: "session-tools.json",
          content: JSON.stringify({
            kind: "noesis_session_tools",
            tools: [
              "search_sessions",
              "open_session_evidence",
              "find_corrections",
              "find_similar_tasks",
              "prior_experiment_outcomes",
            ],
          }),
        },
      ],
      router: {
        path: "router.json",
        content: JSON.stringify({ allTerms: ["research", "brief"] }),
        strategyId: "research-brief-scope-v1",
      },
      activationPolicy: { mode: "automatic_low_risk", scope: "research brief" },
      permissionManifest: { effects: [], resourcePatterns: [], credentialRefs: [] },
      sourceEvaluationDefinitions: [
        {
          path: "source-case.json",
          content: JSON.stringify({
            behavior: "Separate cited evidence from inference in a research brief",
          }),
        },
      ],
      requestedPermissionDelta: {
        addedEffects: [],
        widenedResources: [],
        addedCredentialRefs: [],
      },
    });
  if (prompt.role === "case_generator")
    return JSON.stringify({
      cases: [
        {
          caseId: "research-brief-transfer",
          kind: "generated_transfer",
          instruction: "Transfer the evidence/inference distinction to another research brief.",
          input: "Prepare a research brief on a related topic.",
          sourceEvidenceRefs: [sourceEvidence(prompt)],
          criterionRefs: [],
        },
      ],
    });
  if (prompt.role === "trial") {
    const revision = trialRevision(prompt);
    const candidate = revision.capabilityId.startsWith("learned-");
    return JSON.stringify({
      content: candidate
        ? "Candidate adaptation: cited evidence is separate from explicit inference."
        : "Baseline response: a concise research summary.",
      valid: true,
      invalidArtifacts: [],
      unexpectedEffects: [],
      sourceAssertions: [
        {
          assertionId: "evidence-inference-separation",
          passed: true,
          evidence: candidate
            ? "The candidate explicitly separates evidence and inference."
            : "The baseline remains a valid comparison artifact.",
        },
      ],
      identity: {
        capabilityId: revision.capabilityId,
        capabilityRevisionId: revision.capabilityRevisionId,
        bundleDigest: revision.bundleDigest,
      },
    });
  }
  if (prompt.role === "judge_critic") {
    const armA = z.object({ content: z.string() }).parse(parsedMessage(prompt, "arm_A"));
    const rubric = z
      .object({
        criteria: z.array(
          z.object({ criterionId: z.string().min(1), revision: z.number().int().positive() }),
        ),
      })
      .parse(parsedMessage(prompt, "rubric"));
    return JSON.stringify({
      winner: armA.content.startsWith("Candidate adaptation:") ? "A" : "B",
      confidence: 0.99,
      reasons: ["The candidate explicitly satisfies the bounded behavioral objective."],
      violations: [],
      appliedCriteria: rubric.criteria.map(({ criterionId, revision }) => ({
        criterionId,
        revision,
      })),
    });
  }
  throw new Error(`No controlled response for role ${prompt.role}`);
}
