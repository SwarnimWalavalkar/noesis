import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createConditionalObject, type JsonValue, JsonValueSchema, sha256 } from "@noesis/domain";
import { z } from "zod";
import type * as ZodCore from "zod/v4/core";
import type { PiCodeExecutionEvent, PiFrozenToolCatalog, PreparedPiCodeExecution } from "./execute-tool.ts";

export const FOREGROUND_DIRECT_TOOL_NAMES = Object.freeze(["files.read", "files.write", "shell.run"]);

const preferredAliases = new Map<string, string>([
  ["files.read", "file_read"],
  ["files.write", "file_write"],
  ["shell.run", "shell"],
]);
const reservedCoreToolNames = new Set(["execute"]);
function aliasPriority(canonicalName: string): number {
  if (preferredAliases.has(canonicalName)) return 0;
  return 1;
}

function disambiguatedAlias(base: string, canonicalName: string, suffix = ""): string {
  return `${base}_${sha256(canonicalName).slice(0, 8)}${suffix}`;
}

export function brokerToolAlias(canonicalName: string): string {
  const preferred = preferredAliases.get(canonicalName);
  const alias = preferred ?? canonicalName.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
  if (!alias) throw new Error(`Tool ${canonicalName} has no valid Pi alias`);
  return reservedCoreToolNames.has(alias) ? disambiguatedAlias(alias, canonicalName) : alias;
}

/** Build one stable, injective Pi alias map for a complete frozen catalog. */
export function createBrokerToolAliases(catalog: PiFrozenToolCatalog): ReadonlyMap<string, string> {
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
    const base = brokerToolAlias(descriptor.name);
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

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertJsonValue(value: unknown): asserts value is JsonValue {
  JsonValueSchema.parse(value);
}

function jsonSchema(value: JsonValue): boolean | ZodCore.JSONSchema.JSONSchema {
  if (typeof value === "boolean") return value;
  if (isJsonObject(value)) return value;
  throw new Error("Frozen tool input schema is not a JSON Schema object");
}

export interface PiBrokerToolDetails {
  readonly canonicalName: string;
  readonly callId: string;
}

/**
 * Adapt frozen Broker tools to Pi without creating another invocation path.
 * Foreground callers pass the fixed direct names; subagents pass their frozen delegated catalog.
 */
export function createPiBrokerTools(input: {
  readonly prepared: PreparedPiCodeExecution;
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly canonicalNames?: readonly string[];
  readonly maximumCalls?: number;
  readonly parentExecutionId?: string;
  readonly descriptionSuffix?: string;
  readonly origin?: "foreground" | "subagent";
  readonly emit: (event: PiCodeExecutionEvent, parentToolCallId?: string, recordedByBroker?: boolean) => void;
}): readonly AgentTool[] {
  const invoke = input.prepared.invoke;
  const names = input.canonicalNames ?? input.prepared.catalog.tools.map((tool) => tool.name);
  const byName = new Map(input.prepared.catalog.tools.map((descriptor) => [descriptor.name, descriptor]));
  const descriptors = names.map((name) => {
    const descriptor = byName.get(name);
    if (!descriptor) throw new Error(`Frozen tool catalog has no tool ${name}`);
    return descriptor;
  });
  const aliases = createBrokerToolAliases(input.prepared.catalog);
  let callCount = 0;
  return Object.freeze(
    descriptors.map((descriptor) => {
      const alias = aliases.get(descriptor.name);
      if (!alias) throw new Error(`Frozen tool catalog has no Pi alias for ${descriptor.name}`);
      const parameters = jsonSchema(descriptor.inputSchema);
      let localInputSchema: z.ZodType<unknown> | undefined;
      try {
        localInputSchema = z.fromJSONSchema(parameters);
      } catch {
        localInputSchema = undefined;
      }
      const tool: AgentTool<typeof parameters, PiBrokerToolDetails> = {
        name: alias,
        label: descriptor.label,
        description: `${descriptor.description} ${input.descriptionSuffix ?? `Direct access to ${descriptor.name}.`}`,
        parameters,
        executionMode: "sequential",
        execute: async (toolCallId, rawInput, toolSignal) => {
          callCount += 1;
          if (input.maximumCalls !== undefined && callCount > input.maximumCalls)
            throw new Error(`Tool-call limit of ${String(input.maximumCalls)} exceeded`);
          assertJsonValue(rawInput);
          if (localInputSchema) localInputSchema.parse(rawInput);
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
                input: rawInput,
              },
              undefined,
              true,
            );
            let value: JsonValue;
            try {
              if (!invoke) throw new Error("Direct Broker invocation is unavailable");
              value = await invoke(
                descriptor.name,
                rawInput,
                controller.signal,
                Object.freeze(
                  createConditionalObject({
                    executionId: `direct:${input.turnId}`,
                    logicalExecutionId: `${input.turnId}:${toolCallId}`,
                    callId,
                  } as const)
                    .addOptional(
                      input.parentExecutionId ? { parentExecutionId: input.parentExecutionId } : undefined,
                    )
                    .finish(),
                ),
                (update) =>
                  input.emit(
                    {
                      type: "progress",
                      value: update,
                      callId: eventCallId,
                      name: descriptor.name,
                      callIndex: 0,
                    },
                    undefined,
                    true,
                  ),
                input.emit,
                input.origin,
              );
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
              details: Object.freeze({ canonicalName: descriptor.name, callId }),
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
