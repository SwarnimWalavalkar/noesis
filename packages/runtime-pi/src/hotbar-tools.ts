import type { AgentTool } from "@earendil-works/pi-agent-core";
import { canonicalJson, type JsonValue, JsonValueSchema, sha256 } from "@noesis/domain";
import { z } from "zod";
import type * as ZodCore from "zod/v4/core";
import type { PiCodeExecutionEvent, PiFrozenToolCatalog, PreparedPiCodeExecution } from "./execute-tool.ts";

const preferredAliases = new Map<string, string>([
  ["files.read", "file_read"],
  ["files.list", "list_dir"],
  ["files.search", "file_search"],
  ["files.write", "file_write"],
  ["files.replace", "file_update"],
  ["shell.run", "shell"],
  ["web.fetch", "web_fetch"],
  ["artifacts.write", "artifact_write"],
]);

const reservedCoreToolNames = new Set(["inspect_self", "remember", "adapt", "execute"]);
const PROJECT_WORKFLOW_DIGEST_CHARACTERS = 16;
const savedWorkflowToolNamePattern = /^workflow\.[a-f0-9]{16}\.([a-z][a-z0-9-]{0,63})$/u;

export const PROJECT_WORKFLOW_TOOL_ADAPTER_REVISION = "project-workflow-tool-v1";

export function projectWorkflowToolName(projectId: string, workflowName: string): string {
  return `workflow.${sha256(projectId).slice(0, PROJECT_WORKFLOW_DIGEST_CHARACTERS)}.${workflowName}`;
}

export function isProjectWorkflowToolName(toolName: string): boolean {
  return savedWorkflowToolNamePattern.test(toolName);
}

export function isProjectWorkflowToolForProject(projectId: string, toolName: string): boolean {
  return isProjectWorkflowToolName(toolName) && toolName.startsWith(projectWorkflowToolName(projectId, ""));
}

export function projectWorkflowExecutionCatalogDigest(tools: JsonValue): string {
  return sha256(
    canonicalJson({
      tools,
      savedWorkflowAdapterRevision: PROJECT_WORKFLOW_TOOL_ADAPTER_REVISION,
    }),
  );
}

function savedWorkflowAlias(canonicalName: string): string | undefined {
  const match = savedWorkflowToolNamePattern.exec(canonicalName);
  const workflowName = match?.[1];
  return workflowName ? `workflow_${workflowName}` : undefined;
}

function aliasPriority(canonicalName: string): number {
  if (preferredAliases.has(canonicalName)) return 0;
  if (savedWorkflowAlias(canonicalName)) return 1;
  return 2;
}

function disambiguatedAlias(base: string, canonicalName: string, suffix = ""): string {
  return `${base}_${sha256(canonicalName).slice(0, 8)}${suffix}`;
}

export function hotbarToolAlias(canonicalName: string): string {
  const preferred = preferredAliases.get(canonicalName);
  const alias =
    preferred ?? savedWorkflowAlias(canonicalName) ?? canonicalName.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
  if (!alias) throw new Error(`Tool ${canonicalName} has no valid direct alias`);
  return reservedCoreToolNames.has(alias) ? disambiguatedAlias(alias, canonicalName) : alias;
}

/** Build one stable, injective alias map for the complete frozen catalog. */
export function createHotbarToolAliases(catalog: PiFrozenToolCatalog): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  const used = new Set(reservedCoreToolNames);
  const descriptors = [...catalog.tools].sort((left, right) => {
    const leftPreferred = aliasPriority(left.name);
    const rightPreferred = aliasPriority(right.name);
    if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
    if (left.name === right.name) return 0;
    return left.name < right.name ? -1 : 1;
  });
  for (const descriptor of descriptors) {
    if (aliases.has(descriptor.name))
      throw new Error(`Frozen tool catalog contains duplicate tool ${descriptor.name}`);
    const base = hotbarToolAlias(descriptor.name);
    let alias = base;
    let collision = 1;
    while (used.has(alias)) {
      alias = disambiguatedAlias(base, descriptor.name, collision === 1 ? "" : `_${String(collision)}`);
      collision += 1;
    }
    aliases.set(descriptor.name, alias);
    used.add(alias);
  }
  return aliases;
}

export interface ReconciledHotbarTools {
  readonly active: readonly string[];
  readonly unavailable: readonly string[];
}

/** Reconcile a durable hotbar preference with the catalog frozen for this turn. */
export function reconcileHotbarTools(
  catalog: PiFrozenToolCatalog,
  requested: readonly string[],
): ReconciledHotbarTools {
  const available = new Set(catalog.tools.map((tool) => tool.name));
  const unique = [...new Set(requested)];
  return Object.freeze({
    active: Object.freeze(unique.filter((name) => available.has(name))),
    unavailable: Object.freeze(unique.filter((name) => !available.has(name))),
  });
}

export function resolveHotbarTools(
  catalog: PiFrozenToolCatalog,
  requested: readonly string[],
): readonly string[] {
  const reconciled = reconcileHotbarTools(catalog, requested);
  if (reconciled.unavailable.length > 0)
    throw new Error(`Hotbar tool(s) are not available in this turn: ${reconciled.unavailable.join(", ")}`);
  return reconciled.active;
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonSchema(value: JsonValue): boolean | ZodCore.JSONSchema.JSONSchema {
  if (typeof value === "boolean") return value;
  if (isJsonObject(value)) return value;
  throw new Error("Frozen tool input schema is not a JSON Schema object");
}

export interface PiHotbarToolDetails {
  readonly canonicalName: string;
  readonly callId: string;
}

export function createPiHotbarTools(input: {
  readonly prepared: PreparedPiCodeExecution;
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly emit: (event: PiCodeExecutionEvent, parentToolCallId?: string, recordedByBroker?: boolean) => void;
}): readonly AgentTool[] {
  const invoke = input.prepared.invoke;
  if (!invoke && input.prepared.catalog.tools.length > 0)
    throw new Error("Direct tools require a prepared Broker invocation path");
  const aliases = createHotbarToolAliases(input.prepared.catalog);
  return Object.freeze(
    input.prepared.catalog.tools.map((descriptor) => {
      const alias = aliases.get(descriptor.name);
      if (!alias) throw new Error(`Frozen tool catalog has no direct alias for ${descriptor.name}`);
      const schema = z.fromJSONSchema(jsonSchema(descriptor.inputSchema));
      const parameters = z.toJSONSchema(schema);
      const tool: AgentTool<typeof parameters, PiHotbarToolDetails> = {
        name: alias,
        label: descriptor.label,
        description: `${descriptor.description} Direct access to ${descriptor.name}; use adapt to change the hotbar.`,
        parameters,
        executionMode: "sequential",
        execute: async (toolCallId, rawInput, toolSignal) => {
          const parsed = JsonValueSchema.parse(schema.parse(rawInput));
          const controller = new AbortController();
          const abortTurn = (): void => controller.abort(input.signal.reason);
          const abortTool = (): void => controller.abort(toolSignal?.reason);
          if (input.signal.aborted) abortTurn();
          else input.signal.addEventListener("abort", abortTurn, { once: true });
          if (toolSignal?.aborted) abortTool();
          else toolSignal?.addEventListener("abort", abortTool, { once: true });
          try {
            const eventCallId = `direct:${toolCallId}`;
            const callId = `${input.turnId}:${eventCallId}`;
            input.emit(
              {
                type: "tool-start",
                callId: eventCallId,
                name: descriptor.name,
                callIndex: 0,
                input: parsed,
              },
              undefined,
              true,
            );
            let value: JsonValue;
            try {
              if (!invoke) throw new Error("Direct Broker invocation is unavailable");
              value = await invoke(descriptor.name, parsed, controller.signal, {
                executionId: `direct:${input.turnId}`,
                logicalExecutionId: `${input.turnId}:${toolCallId}`,
                callId,
              });
              input.emit(
                {
                  type: "tool-end",
                  callId: eventCallId,
                  name: descriptor.name,
                  callIndex: 0,
                  ok: true,
                  result: value,
                },
                undefined,
                true,
              );
            } catch (error) {
              input.emit(
                {
                  type: "tool-end",
                  callId: eventCallId,
                  name: descriptor.name,
                  callIndex: 0,
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                },
                undefined,
                true,
              );
              throw error;
            }
            return {
              content: [{ type: "text" as const, text: JSON.stringify(value) }],
              details: Object.freeze({
                canonicalName: descriptor.name,
                callId,
              }),
            };
          } finally {
            input.signal.removeEventListener("abort", abortTurn);
            toolSignal?.removeEventListener("abort", abortTool);
          }
        },
      };
      return Object.freeze(tool);
    }),
  );
}
