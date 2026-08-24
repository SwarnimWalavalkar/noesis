import { createConditionalObject, isJsonObject } from "@noesis/domain";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { FrozenTurnPlan } from "@noesis/agent-types";
import type { JsonValue } from "@noesis/domain";
import { z } from "zod";
import type { PiSkillResource } from "./skill-library.ts";
const executeParameters = z.strictObject({
  source: z
    .string()
    .min(1)
    .max(128 * 1024),
  timeoutMs: z.number().int().min(100).max(600000).optional(),
});
const executeParametersJsonSchema = z.toJSONSchema(executeParameters);
const MAX_SOURCE_BYTES = 128 * 1024;
const MAX_STARTER_OUTPUT_CONTRACT_BYTES = 1024;
const EXECUTE_DESCRIPTION = [
  "Execute JavaScript on the user's machine and compose work tools through the injected SDK.",
  "Compose related multi-call work in one program.",
  'Load the `execute` skill with tools.skills.load({ name: "execute" }) for SDK, composition, subagent, and Program guidance.',
].join(" ");
function jsonSchemaLiteral(value: JsonValue): string {
  return JSON.stringify(value) ?? "unknown";
}
function jsonSchemaPropertyName(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value) ? value : JSON.stringify(value);
}
function jsonSchemaType(schema: JsonValue, depth = 0): string | undefined {
  if (!isJsonObject(schema) || depth > 8) return undefined;
  if (Object.hasOwn(schema, "const")) return jsonSchemaLiteral(schema["const"] ?? null);
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues.map(jsonSchemaLiteral).join("|");
  for (const unionKey of ["oneOf", "anyOf"] as const) {
    const variants = schema[unionKey];
    if (!Array.isArray(variants) || variants.length === 0) continue;
    const rendered = variants.map((variant) => jsonSchemaType(variant, depth + 1));
    if (rendered.some((variant) => variant === undefined)) return undefined;
    return rendered.join("|");
  }
  const declaredType = schema["type"];
  if (Array.isArray(declaredType)) {
    const rendered = declaredType.map((type) =>
      typeof type === "string" ? jsonSchemaType({ type }, depth + 1) : undefined,
    );
    if (rendered.some((type) => type === undefined)) return undefined;
    return rendered.join("|");
  }
  if (declaredType === "null") return "null";
  if (declaredType === "string") return "string";
  if (declaredType === "number" || declaredType === "integer") return "number";
  if (declaredType === "boolean") return "boolean";
  if (declaredType === "array") {
    const itemType = jsonSchemaType(schema["items"] ?? {}, depth + 1) ?? "JsonValue";
    return `${itemType.includes("|") ? `(${itemType})` : itemType}[]`;
  }
  if (declaredType === "object" || isJsonObject(schema["properties"])) {
    const properties = schema["properties"];
    if (!isJsonObject(properties)) return "Record<string,JsonValue>";
    const requiredValue = schema["required"];
    const required = new Set(
      Array.isArray(requiredValue)
        ? requiredValue.filter((value): value is string => typeof value === "string")
        : [],
    );
    return `{${Object.entries(properties)
      .map(([name, propertySchema]) => {
        const propertyType = jsonSchemaType(propertySchema, depth + 1) ?? "JsonValue";
        return `${jsonSchemaPropertyName(name)}${required.has(name) ? "" : "?"}:${propertyType}`;
      })
      .join(";")}}`;
  }
  return "JsonValue";
}
function shellOutputContract(catalog: PiFrozenToolCatalog): string {
  const descriptor = catalog.tools.find((tool) => tool.name === "shell.run");
  if (!descriptor) return 'Before depending on shell.run result fields, use noesis.describe("shell.run").';
  const outputType = jsonSchemaType(descriptor.outputSchema);
  if (!outputType) return 'Before depending on shell.run result fields, use noesis.describe("shell.run").';
  const contract = `Schema-derived shell.run result: ${outputType}.`;
  return new TextEncoder().encode(contract).byteLength <= MAX_STARTER_OUTPUT_CONTRACT_BYTES
    ? contract
    : 'Before depending on shell.run result fields, use noesis.describe("shell.run").';
}
export interface PiMcpServerSummary {
  readonly name: string;
  readonly tools: number;
  readonly prompts: number;
  readonly resources: number;
  readonly resourceTemplates: number;
}
export type PiCodeExecutionEvent =
  | {
      readonly type: "started";
      readonly executionId: string;
    }
  | {
      readonly type: "progress";
      readonly value: JsonValue;
      readonly callId?: string;
      readonly name?: string;
      readonly callIndex?: number;
    }
  | {
      readonly type: "tool-start";
      readonly callId: string;
      readonly name: string;
      readonly callIndex: number;
      readonly input?: JsonValue;
    }
  | {
      readonly type: "tool-end";
      readonly callId: string;
      readonly name: string;
      readonly callIndex: number;
      readonly ok: boolean;
      readonly result?: JsonValue;
      readonly error?: string;
    };
export interface PiFrozenToolCatalog {
  readonly catalogId: string;
  readonly catalogDigest: string;
  readonly tools: readonly {
    readonly name: string;
    readonly label: string;
    readonly description: string;
    readonly revisionId: string;
    readonly inputSchema: JsonValue;
    readonly outputSchema: JsonValue;
  }[];
}
export interface PreparedPiCodeExecution {
  readonly catalog: PiFrozenToolCatalog;
  readonly mcpServerSummaries?: readonly PiMcpServerSummary[];
  readonly invoke?: (
    name: string,
    input: JsonValue,
    signal: AbortSignal,
    identity: {
      readonly executionId: string;
      readonly parentExecutionId?: string;
      readonly logicalExecutionId: string;
      readonly callId: string;
    },
    emitUpdate?: (update: JsonValue) => void,
    emitEvent?: (event: PiCodeExecutionEvent, parentToolCallId?: string, recordedByBroker?: boolean) => void,
    origin?: "foreground" | "subagent",
  ) => Promise<JsonValue>;
  readonly execute: (
    source: string,
    timeoutMs: number | undefined,
    signal: AbortSignal,
    emit: (event: PiCodeExecutionEvent, parentToolCallId?: string, recordedByBroker?: boolean) => void,
    identity?: {
      readonly logicalExecutionId: string;
    },
  ) => Promise<{
    readonly executionId: string;
    readonly value: JsonValue;
    readonly calls: number;
    readonly durationMs: number;
  }>;
  readonly close: () => Promise<void>;
}
export interface PiCodeExecutionAdapter {
  readonly prepare: (
    plan: FrozenTurnPlan,
    signal: AbortSignal,
    resources?: {
      readonly skills: readonly PiSkillResource[];
    },
  ) => Promise<PreparedPiCodeExecution>;
  readonly shutdown: () => Promise<void>;
}
export type PiExecuteToolDetails =
  | {
      readonly kind: "activity";
      readonly executionId?: string;
      readonly event: PiCodeExecutionEvent;
    }
  | {
      readonly kind: "result";
      readonly executionId: string;
      readonly calls: number;
    };
export function createPiExecuteTool(input: {
  readonly prepared: PreparedPiCodeExecution;
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly emit: (event: PiCodeExecutionEvent, parentToolCallId: string, recordedByBroker?: boolean) => void;
}): AgentTool<typeof executeParametersJsonSchema, PiExecuteToolDetails> {
  const tool: AgentTool<typeof executeParametersJsonSchema, PiExecuteToolDetails> = {
    name: "execute",
    label: "Execute JavaScript",
    description: `${EXECUTE_DESCRIPTION} ${shellOutputContract(input.prepared.catalog)}`,
    parameters: executeParametersJsonSchema,
    executionMode: "sequential",
    execute: async (toolCallId, rawInput, toolSignal, onUpdate) => {
      const params = executeParameters.parse(rawInput);
      if (new TextEncoder().encode(params.source).byteLength > MAX_SOURCE_BYTES)
        throw new Error(`Codemode source exceeds ${String(MAX_SOURCE_BYTES)} UTF-8 bytes`);
      const controller = new AbortController();
      const abortTurn = (): void => controller.abort(input.signal.reason);
      const abortTool = (): void => controller.abort(toolSignal?.reason);
      if (input.signal.aborted) abortTurn();
      else input.signal.addEventListener("abort", abortTurn, { once: true });
      if (toolSignal?.aborted) abortTool();
      else toolSignal?.addEventListener("abort", abortTool, { once: true });
      try {
        if (controller.signal.aborted) throw new Error("Codemode execution was cancelled before start");
        let executionId: string | undefined;
        const result = await input.prepared.execute(
          params.source,
          params.timeoutMs,
          controller.signal,
          (event, parentToolCallId, recordedByBroker) => {
            if (event.type === "started") executionId = event.executionId;
            input.emit(event, parentToolCallId ?? toolCallId, recordedByBroker);
            // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
            onUpdate?.({
              content: [],
              details: Object.freeze(
                createConditionalObject({
                  kind: "activity",
                } as const)
                  .addOptional(executionId ? { executionId } : undefined)
                  .add({
                    event,
                  } as const)
                  .finish(),
              ),
            });
          },
          { logicalExecutionId: `${input.turnId}:${toolCallId}` },
        );
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.value) }],
          details: {
            kind: "result",
            executionId: result.executionId,
            calls: result.calls,
          },
        };
      } finally {
        input.signal.removeEventListener("abort", abortTurn);
        toolSignal?.removeEventListener("abort", abortTool);
      }
    },
  };
  return Object.freeze(tool);
}
