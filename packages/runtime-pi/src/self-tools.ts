import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentRuntimeRequest, FrozenTurnPlan } from "@noesis/agent-types";
import { type JsonValue, JsonValueSchema } from "@noesis/domain";
import { z } from "zod";
import type { PiFrozenToolCatalog } from "./execute-tool.ts";

const inspectInput = z.strictObject({
  section: z.enum(["overview", "context", "capabilities", "memory", "experiments", "tools"]).optional(),
  tool: z.string().trim().min(1).max(128).optional(),
  cursor: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(25).optional(),
});
const rememberInput = z.strictObject({
  memory: z.string().trim().min(1).max(8_192),
  scope: z.string().trim().min(1).max(512),
  anticipatedUse: z.string().trim().min(1).max(2_048),
});
const adaptInput = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("add_tool"),
    tool: z.string().trim().min(1).max(128),
  }),
  z.strictObject({
    action: z.literal("remove_tool"),
    tool: z.string().trim().min(1).max(128),
  }),
]);

export interface PiSelfToolAdapter {
  readonly hotbar: (input: {
    readonly plan: FrozenTurnPlan;
    readonly catalog: PiFrozenToolCatalog;
    readonly signal: AbortSignal;
  }) => Promise<readonly string[]>;
  readonly inspect: (input: {
    readonly section: z.infer<typeof inspectInput>["section"];
    readonly tool: z.infer<typeof inspectInput>["tool"];
    readonly cursor: z.infer<typeof inspectInput>["cursor"];
    readonly limit: z.infer<typeof inspectInput>["limit"];
    readonly plan: FrozenTurnPlan;
    readonly request: AgentRuntimeRequest;
    readonly catalog?: PiFrozenToolCatalog;
    readonly signal: AbortSignal;
  }) => Promise<JsonValue>;
  readonly remember: (
    input: z.infer<typeof rememberInput> & {
      readonly plan: FrozenTurnPlan;
      readonly signal: AbortSignal;
    },
  ) => Promise<JsonValue>;
  readonly adapt: (
    input: z.infer<typeof adaptInput> & {
      readonly plan: FrozenTurnPlan;
      readonly catalog?: PiFrozenToolCatalog;
      readonly applyHotbar: (canonicalToolNames: readonly string[]) => Promise<void>;
      readonly signal: AbortSignal;
    },
  ) => Promise<JsonValue>;
}

function directTool<Parameters extends z.ZodType>(input: {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly schema: Parameters;
  readonly signal: AbortSignal;
  readonly execute: (parameters: z.output<Parameters>, signal: AbortSignal) => Promise<JsonValue>;
}): AgentTool {
  const parameters = z.toJSONSchema(input.schema);
  const tool: AgentTool<typeof parameters, { readonly semantic: true }> = {
    name: input.name,
    label: input.label,
    description: input.description,
    parameters,
    executionMode: "sequential",
    execute: async (_toolCallId, raw, toolSignal) => {
      const controller = new AbortController();
      const forwardAbort = (signal: AbortSignal): void => controller.abort(signal.reason);
      const abortTurn = (): void => forwardAbort(input.signal);
      const abortTool = (): void => {
        if (toolSignal) forwardAbort(toolSignal);
      };
      if (input.signal.aborted) abortTurn();
      else input.signal.addEventListener("abort", abortTurn, { once: true });
      if (toolSignal?.aborted) abortTool();
      else toolSignal?.addEventListener("abort", abortTool, { once: true });
      let serialized: string;
      try {
        if (controller.signal.aborted) throw new Error(`${input.name} was cancelled before execution`);
        const value = JsonValueSchema.parse(await input.execute(input.schema.parse(raw), controller.signal));
        if (controller.signal.aborted) throw new Error(`${input.name} was cancelled`);
        serialized = JSON.stringify(value);
      } finally {
        input.signal.removeEventListener("abort", abortTurn);
        toolSignal?.removeEventListener("abort", abortTool);
      }
      return {
        content: [{ type: "text", text: serialized }],
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
  readonly signal: AbortSignal;
  readonly catalog?: PiFrozenToolCatalog;
  readonly applyHotbar: (canonicalToolNames: readonly string[]) => Promise<void>;
}): readonly AgentTool[] {
  const semanticTools = [
    directTool({
      name: "inspect_self",
      label: "Inspect self",
      description:
        "Inspect Noesis's active context, capabilities, memory, experiments, or executable tool surface. Section 'tools' returns a bounded page of the exact frozen tool names and descriptors; pass tool with one canonical name to inspect its complete descriptor and schemas.",
      schema: inspectInput,
      signal: input.signal,
      execute: async ({ section = "overview", tool, cursor, limit }, signal) =>
        await input.adapter.inspect({
          section,
          tool,
          cursor,
          limit,
          plan: input.plan,
          request: input.request,
          signal,
          ...(input.catalog ? { catalog: input.catalog } : {}),
        }),
    }),
    directTool({
      name: "remember",
      label: "Remember",
      description:
        "Record a narrow, evidence-bound user preference or durable learning with its scope and anticipated future use.",
      schema: rememberInput,
      signal: input.signal,
      execute: async (parameters, signal) =>
        await input.adapter.remember({ ...parameters, plan: input.plan, signal }),
    }),
  ];
  const catalog = input.catalog;
  if (!catalog) return Object.freeze(semanticTools);
  return Object.freeze([
    ...semanticTools,
    directTool({
      name: "adapt",
      label: "Adapt toolbox",
      description:
        "Change the direct-tool hotbar immediately with add_tool or remove_tool. Tool names are the canonical names shown by inspect_self(section: 'tools'). To create a new executable capability, use execute with scripts.save for one reusable program or workflows.save for durable phases, then verify it immediately. Hotbar changes never widen the frozen catalog or permissions.",
      schema: adaptInput,
      signal: input.signal,
      execute: async (parameters, signal) =>
        await input.adapter.adapt({
          ...parameters,
          plan: input.plan,
          signal,
          applyHotbar: input.applyHotbar,
          catalog,
        }),
    }),
  ]);
}
