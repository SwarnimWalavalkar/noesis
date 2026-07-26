import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentRuntimeRequest, FrozenTurnPlan } from "@noesis/agent-types";
import type { JsonValue } from "@noesis/domain";
import { z } from "zod";

const inspectInput = z.strictObject({
  section: z.enum(["overview", "context", "capabilities", "memory", "experiments", "tools"]).optional(),
});
const rememberInput = z.strictObject({
  memory: z.string().trim().min(1).max(8_192),
  scope: z.string().trim().min(1).max(512),
  anticipatedUse: z.string().trim().min(1).max(2_048),
});
const adaptInput = z.strictObject({
  target: z.enum(["prompt", "skill", "tool", "script", "workflow", "toolset", "router", "tui"]),
  change: z.string().trim().min(1).max(16_384),
  scope: z.string().trim().min(1).max(512),
  rationale: z.string().trim().min(1).max(4_096),
});

export interface PiSelfToolAdapter {
  readonly inspect: (input: {
    readonly section: z.infer<typeof inspectInput>["section"];
    readonly plan: FrozenTurnPlan;
    readonly request: AgentRuntimeRequest;
    readonly catalog?: { readonly catalogId: string; readonly catalogDigest: string };
  }) => Promise<JsonValue>;
  readonly remember: (
    input: z.infer<typeof rememberInput> & { readonly plan: FrozenTurnPlan },
  ) => Promise<JsonValue>;
  readonly adapt: (
    input: z.infer<typeof adaptInput> & { readonly plan: FrozenTurnPlan },
  ) => Promise<JsonValue>;
}

function directTool<Parameters extends z.ZodType>(input: {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly schema: Parameters;
  readonly execute: (parameters: z.output<Parameters>) => Promise<JsonValue>;
}): AgentTool {
  const parameters = z.toJSONSchema(input.schema);
  const tool: AgentTool<typeof parameters, { readonly semantic: true }> = {
    name: input.name,
    label: input.label,
    description: input.description,
    parameters,
    executionMode: "sequential",
    execute: async (_toolCallId, raw) => {
      const value = await input.execute(input.schema.parse(raw));
      return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        details: { semantic: true },
      };
    },
  };
  return Object.freeze(tool);
}

export function createPiSelfTools(input: {
  readonly adapter: PiSelfToolAdapter;
  readonly plan: FrozenTurnPlan;
  readonly request: AgentRuntimeRequest;
  readonly catalog?: { readonly catalogId: string; readonly catalogDigest: string };
}): readonly AgentTool[] {
  return Object.freeze([
    directTool({
      name: "inspect_self",
      label: "Inspect self",
      description:
        "Inspect Noesis's active context, capabilities, memory, experiments, or executable tool surface.",
      schema: inspectInput,
      execute: async ({ section = "overview" }) =>
        await input.adapter.inspect({
          section,
          plan: input.plan,
          request: input.request,
          ...(input.catalog ? { catalog: input.catalog } : {}),
        }),
    }),
    directTool({
      name: "remember",
      label: "Remember",
      description:
        "Record a narrow, evidence-bound user preference or durable learning with its scope and anticipated future use.",
      schema: rememberInput,
      execute: async (parameters) => await input.adapter.remember({ ...parameters, plan: input.plan }),
    }),
    directTool({
      name: "adapt",
      label: "Propose adaptation",
      description:
        "Propose a scoped change to Noesis behavior. This records evidence for reflection and evaluation; it never self-promotes.",
      schema: adaptInput,
      execute: async (parameters) => await input.adapter.adapt({ ...parameters, plan: input.plan }),
    }),
  ]);
}
