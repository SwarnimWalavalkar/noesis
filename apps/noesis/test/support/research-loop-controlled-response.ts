import { CapabilityRevisionRefSchema } from "@noesis/domain";
import { z } from "zod";
import {
  type ControlledPiPrompt,
  controlledToolCallResponse,
} from "../../../../packages/runtime-pi/test/support/controlled-pi-models.ts";

const RolePromptSchema = z.object({
  role: z.enum(["capability_router", "history_reranker", "reflector"]),
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

function structuredPayload(content: string): unknown {
  const payload = content.split("\n\nReturn JSON only.", 1)[0]?.split("\n\nRepair the following", 1)[0];
  if (!payload) throw new Error("Controlled role received no structured payload");
  return JSON.parse(payload);
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
  if (prompt.role === "history_reranker") {
    const candidates = prompt.messages
      .filter((message) => message.name === "candidates")
      .flatMap(
        (message) =>
          z
            .object({
              candidates: z.array(z.object({ documentId: z.string() })),
            })
            .parse(structuredPayload(message.content)).candidates,
      );
    if (candidates.length < 2)
      throw new Error("Controlled history reranker requires at least two candidates to prove ordering");
    const reversed = candidates.toReversed();
    return JSON.stringify({
      ranking: reversed.map((candidate, index) => ({
        documentId: candidate.documentId,
        reason: `Controlled reverse rank ${String(index + 1)} for ${candidate.documentId}.`,
      })),
    });
  }
  if (prompt.role === "capability_router") {
    const turn = z
      .object({
        userInput: z.string(),
        candidates: z.array(
          z.object({
            capabilityId: z.string(),
            name: z.string(),
            scope: z.string(),
            intent: z.string(),
          }),
        ),
      })
      .parse(structuredPayload(namedMessage(prompt, "turn")));
    const priorConversation = prompt.messages
      .filter((message) => message.name === "prior_conversation")
      .map((message) =>
        z
          .object({
            messageId: z.string(),
            role: z.enum(["user", "assistant"]),
            content: z.string(),
            createdAt: z.string(),
          })
          .parse(structuredPayload(message.content)),
      );
    const semanticContext = [...priorConversation.map((message) => message.content), turn.userInput].join(
      "\n",
    );
    const selected = semanticContext.includes("research brief") ? turn.candidates[0] : undefined;
    return JSON.stringify({
      selections: selected
        ? [
            {
              capabilityId: selected.capabilityId,
              reason: "The current request is meaningfully within the research-brief scope.",
            },
          ]
        : [],
      reason: selected
        ? "Selected the active research-brief capability for relevant work."
        : "No narrow active capability is relevant to this request.",
      learningAttribution: selected
        ? {
            capabilityId: selected.capabilityId,
            reason: "The research-brief capability is the primary context for learning from this turn.",
          }
        : null,
    });
  }
  if (prompt.role === "reflector") {
    const settled = z.object({ userMessage: z.string() }).parse(parsedMessage(prompt, "settled_turn"));
    const current = z
      .object({
        capabilities: z.array(z.object({ capabilityId: z.string() })),
        omittedCount: z.number().int().nonnegative(),
      })
      .parse(parsedMessage(prompt, "current_capabilities"));
    const activeCapability = current.capabilities[0];
    if (settled.userMessage.includes("revise this research brief") && activeCapability)
      return JSON.stringify({
        decision: "revise",
        capabilityId: activeCapability.capabilityId,
        proposal: {
          name: "Evidence-grounded research briefs",
          kind: "instruction",
          description: "Separate cited evidence from inference in research briefs.",
          applicability: "Research briefs and evidence-grounded source synthesis.",
          summary: "Research briefs now label uncertainty as well as inference.",
          rationale: "The user requested a more precise version of the active Capability.",
          anticipatedEffect: "Research briefs expose uncertainty more consistently.",
          instruction:
            "Produce concise research briefs with explicit sections for cited evidence, inference, and uncertainty.",
          scope: "global",
          activationMode: "relevant",
          consequence: "ordinary",
          consequenceDescription: "Only the model instruction changes.",
          evidenceCitationIndexes: [0],
        },
      });
    if (!settled.userMessage.includes("research brief") || current.capabilities.length > 0)
      return JSON.stringify({
        decision: "no_change",
        reason: "No additional durable Capability is needed for this settled turn.",
      });
    return JSON.stringify({
      decision: "create",
      proposal: {
        name: "Evidence-grounded research briefs",
        kind: "instruction",
        description: "Separate cited evidence from inference in research briefs.",
        applicability: "Research briefs and evidence-grounded source synthesis.",
        summary: "Research briefs now distinguish cited evidence from inference.",
        rationale: "The user explicitly corrected how research briefs should present evidence.",
        anticipatedEffect: "Future research briefs are easier to audit and trust.",
        instruction: "Produce concise research briefs with explicit evidence, inference, and uncertainty.",
        scope: "global",
        activationMode: "relevant",
        consequence: "ordinary",
        consequenceDescription: "Only the model instruction changes.",
        evidenceCitationIndexes: [0],
      },
    });
  }
  throw new Error(`No controlled response for role ${prompt.role}`);
}
