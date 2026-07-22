import type { AgentMessage, AgentRunRequest } from "@noesis/agent-types";
import type { CapabilityRevisionRef, ExperimentVariantRef, JsonValue } from "@noesis/domain";
import type {
  BlindedJudgeFixture,
  ComparableRoleVariantFixture,
  RuntimePiAgentRunRequest,
} from "./role-types.ts";

function cloneCapabilityRevisions(
  revisions: readonly CapabilityRevisionRef[],
): readonly CapabilityRevisionRef[] {
  return Object.freeze(revisions.map((revision) => Object.freeze({ ...revision })));
}

function withVariant(
  request: Omit<AgentRunRequest, "variant">,
  variant: ExperimentVariantRef,
  capabilityRevisions: readonly CapabilityRevisionRef[],
): RuntimePiAgentRunRequest {
  return Object.freeze({
    ...request,
    variant: Object.freeze({
      ...variant,
      configurationRefs: Object.freeze(
        variant.configurationRefs.map((reference) => Object.freeze({ ...reference })),
      ),
    }),
    messages: Object.freeze(request.messages.map((message) => Object.freeze({ ...message }))),
    evidenceRefs: Object.freeze(request.evidenceRefs.map((reference) => Object.freeze({ ...reference }))),
    availableTools: Object.freeze(request.availableTools.map((tool) => Object.freeze({ ...tool }))),
    capabilityRevisions,
  });
}

export function createComparableRoleVariantFixture(input: {
  readonly request: Omit<AgentRunRequest, "variant">;
  readonly baselineVariant: ExperimentVariantRef;
  readonly candidateVariant: ExperimentVariantRef;
  readonly capabilityRevisions: readonly CapabilityRevisionRef[];
}): ComparableRoleVariantFixture {
  if (input.baselineVariant.axis !== "role" || input.candidateVariant.axis !== "role") {
    throw new Error("Comparable role fixtures require role-axis variants");
  }
  const capabilityRevisions = cloneCapabilityRevisions(input.capabilityRevisions);
  return Object.freeze({
    baseline: withVariant(input.request, input.baselineVariant, capabilityRevisions),
    candidate: withVariant(input.request, input.candidateVariant, capabilityRevisions),
    capabilityRevisions,
  });
}

function judgeMessage(name: "arm_A" | "arm_B", output: JsonValue): AgentMessage {
  return Object.freeze({ role: "user", name, content: JSON.stringify(output) });
}

export function createBlindedJudgeFixture(input: {
  readonly first: JsonValue;
  readonly second: JsonValue;
  readonly swap: boolean;
  readonly rubric: string;
}): BlindedJudgeFixture {
  const armA = input.swap ? input.second : input.first;
  const armB = input.swap ? input.first : input.second;
  return Object.freeze({
    messages: Object.freeze([
      Object.freeze({ role: "user", name: "rubric", content: input.rubric }),
      judgeMessage("arm_A", armA),
      judgeMessage("arm_B", armB),
    ]),
    labels: Object.freeze({
      A: input.swap ? "second" : "first",
      B: input.swap ? "first" : "second",
    }),
  });
}
