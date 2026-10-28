import type { AgentContextInspection, FrozenTurnPlan } from "@noesis/agent-types";
import { ThinkingLevelSchema, type ResolvedNoesisConfig } from "@noesis/config";
import { defineTool, type ToolDefinition } from "@noesis/tools";
import type { ContextCheckpointRecord, SessionRecord } from "@noesis/workspace";
import { z } from "zod";

export interface SessionInspectionPort {
  readonly session: (sessionId: string) => Promise<SessionRecord | undefined>;
  readonly completedTurns: (sessionId: string) => number;
  /** The live configuration, for the default route and context settings. */
  readonly config: () => ResolvedNoesisConfig;
  /** The same read model as /context: the last model request, or a preview before the first one. */
  readonly inspectContext: (sessionId: string) => Promise<AgentContextInspection>;
  /** Compaction checkpoints from oldest to the active one. */
  readonly checkpoints: (sessionId: string) => Promise<readonly ContextCheckpointRecord[]>;
}

const ROUTE_KEYS = ["provider", "model", "thinkingLevel"] as const;

const routeFields = { provider: z.string(), model: z.string(), thinkingLevel: ThinkingLevelSchema };
const RouteSchema = z.strictObject(routeFields);
const UsageSchema = z.strictObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  estimatedCost: z.number(),
});
const SessionInspectOutputSchema = z.strictObject({
  session: z.strictObject({
    sessionId: z.string(),
    title: z.string().nullable(),
    project: z.strictObject({ projectId: z.string(), root: z.string() }).nullable(),
    createdAt: z.string().nullable(),
    completedTurns: z.number(),
    turnId: z.string(),
  }),
  route: z.strictObject({
    ...routeFields,
    default: RouteSchema,
    differsFromDefault: z.array(z.enum(ROUTE_KEYS)),
    note: z.string(),
    subAgentDefaults: z.strictObject({ ...routeFields, requestTokenBudget: z.number() }).nullable(),
  }),
  context: z.strictObject({
    source: z.enum(["request", "preview"]),
    capturedAt: z.string(),
    provider: z.string(),
    model: z.string(),
    contextWindow: z.number(),
    requestBudget: z.number(),
    outputReserve: z.number(),
    usedTokens: z.number(),
    percentOfWindow: z.number(),
    percentOfRequestBudget: z.number(),
    components: z.array(z.strictObject({ label: z.string(), tokens: z.number() })),
    cache: z
      .strictObject({ inputTokens: z.number(), readTokens: z.number(), writeTokens: z.number() })
      .nullable(),
    note: z.string(),
    historyBudget: z.number().nullable(),
    autoCompact: z.boolean(),
  }),
  compaction: z.strictObject({
    checkpoints: z.number(),
    notesInContext: z.number(),
    omittedNotes: z.number(),
    history: z.array(
      z.strictObject({
        checkpointId: z.string(),
        createdAt: z.string(),
        kind: z.enum(["legacy_snapshot", "note_delta"]),
        messagesCovered: z.number(),
        summaryTokens: z.number(),
        tokenBudget: z.number(),
        ...routeFields,
        usage: UsageSchema,
      }),
    ),
    note: z.string(),
  }),
  permissions: z.strictObject({
    effects: z.array(z.string()),
    resourcePatterns: z.array(z.string()),
    credentialRefs: z.array(z.string()),
  }),
});

const percent = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;

/** Summarizes /context's component breakdown without the component text, which is already in the prompt. */
function summarizeContextWindow(inspection: AgentContextInspection) {
  const usedTokens = inspection.components.reduce((sum, component) => sum + component.tokens, 0);
  return {
    source: inspection.source,
    capturedAt: inspection.capturedAt,
    provider: inspection.provider,
    model: inspection.model,
    contextWindow: inspection.contextWindow,
    requestBudget: inspection.inputBudget,
    outputReserve: inspection.outputReserve,
    usedTokens,
    percentOfWindow: percent(usedTokens, inspection.contextWindow),
    percentOfRequestBudget: percent(usedTokens, inspection.inputBudget),
    components: inspection.components.map(({ label, tokens }) => ({ label, tokens })),
    cache: inspection.cache
      ? {
          inputTokens: inspection.cache.inputTokens,
          readTokens: inspection.cache.readTokens,
          writeTokens: inspection.cache.writeTokens,
        }
      : null,
    note: inspection.note,
  };
}

/** Read-only facts about the running session, bound to the frozen plan of the current turn. */
export function createSessionInspectionTool(
  port: SessionInspectionPort,
  plan: FrozenTurnPlan,
): ToolDefinition {
  return defineTool({
    name: "session.inspect",
    label: "Inspect this session",
    description:
      "Read facts about the current session: its identity and project, the model route this turn runs on and how it compares with the configured default, context window use broken down like /context, compaction history, and this turn's permissions. Use this to answer 'which model are you using', 'how full is your context', or 'has this session been compacted'. The full earlier transcript is the codemode `context` object, not part of this result.",
    inputSchema: z.strictObject({}),
    outputSchema: SessionInspectOutputSchema,
    effect: () => ({ effect: "read", resource: `session:${plan.sessionId}`, estimatedCost: 0 }),
    execute: async () => {
      const [session, inspection, checkpoints] = await Promise.all([
        port.session(plan.sessionId),
        port.inspectContext(plan.sessionId),
        port.checkpoints(plan.sessionId),
      ]);
      const config = port.config();
      const defaults = {
        provider: config.agent.provider,
        model: config.agent.model,
        thinkingLevel: config.agent.thinkingLevel,
      };
      const route = { provider: plan.provider, model: plan.model, thinkingLevel: plan.thinkingLevel };
      const differsFromDefault = ROUTE_KEYS.filter((key) => route[key] !== defaults[key]);
      return {
        session: {
          sessionId: plan.sessionId,
          title: session?.title ?? null,
          project: plan.project ? { projectId: plan.project.projectId, root: plan.project.root } : null,
          createdAt: session?.createdAt ?? null,
          completedTurns: port.completedTurns(plan.sessionId),
          turnId: plan.turnId,
        },
        route: {
          ...route,
          default: defaults,
          differsFromDefault,
          note: "The session route is pinned. /provider, /model, and /reasoning change it; config.update changes only the default for new sessions.",
          subAgentDefaults: plan.subAgentDefaults ? { ...plan.subAgentDefaults } : null,
        },
        context: {
          ...summarizeContextWindow(inspection),
          historyBudget: plan.contextTokenBudget ?? null,
          autoCompact: config.context.autoCompact ?? true,
        },
        compaction: {
          checkpoints: checkpoints.length,
          notesInContext: plan.contextCheckpoint?.notes?.length ?? (plan.contextCheckpoint ? 1 : 0),
          omittedNotes: plan.contextCheckpoint?.omittedNoteCount ?? 0,
          history: checkpoints.map((checkpoint) => ({
            checkpointId: checkpoint.checkpointId,
            createdAt: checkpoint.createdAt,
            kind: checkpoint.summaryKind,
            messagesCovered: checkpoint.sources.length,
            summaryTokens: checkpoint.estimatedSummaryTokens,
            tokenBudget: checkpoint.tokenBudget,
            provider: checkpoint.provider,
            model: checkpoint.model,
            thinkingLevel: checkpoint.thinkingLevel,
            usage: { ...checkpoint.usage },
          })),
          note: "Compaction notes are already in your prompt; this lists when and how they were made.",
        },
        permissions: {
          effects: [...plan.permissionSnapshot.effects],
          resourcePatterns: [...plan.permissionSnapshot.resourcePatterns],
          credentialRefs: [...plan.permissionSnapshot.credentialRefs],
        },
      };
    },
  });
}
