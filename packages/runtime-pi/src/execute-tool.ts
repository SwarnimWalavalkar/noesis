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
const MAX_WORKFLOW_SUMMARIES = 32;
const MAX_WORKFLOW_INDEX_BYTES = 4 * 1024;
const MAX_WORKFLOW_NAME_BYTES = 96;
const MAX_WORKFLOW_TOOL_NAME_BYTES = 128;
const MAX_WORKFLOW_DESCRIPTION_BYTES = 192;
const MAX_STARTER_OUTPUT_CONTRACT_BYTES = 512;
interface CodemodeStarterCall {
  readonly name: string;
  readonly call: string;
  readonly exposeOutputContract?: boolean;
}
const CODEMODE_STARTER_CALLS: readonly CodemodeStarterCall[] = Object.freeze([
  Object.freeze({ name: "files.read", call: "tools.files.read({ path })" }),
  Object.freeze({ name: "files.list", call: 'tools.files.list({ path: "." })' }),
  Object.freeze({
    name: "shell.run",
    call: "tools.shell.run({ command })",
    exposeOutputContract: true,
  }),
  Object.freeze({ name: "workflows.run", call: "tools.workflows.run({ name, input })" }),
  Object.freeze({ name: "skills.load", call: "tools.skills.load({ name })" }),
  Object.freeze({
    name: "history.search_sessions",
    call: "tools.history.search_sessions({ query }) (hybrid lexical and semantic search with reranking over this installation's previous sessions; one precise query normally suffices)",
  }),
  Object.freeze({
    name: "history.open_session_evidence",
    call: "tools.history.open_session_evidence({ citation: search.fragments[0].citation }) (after search_sessions, and only when search.fragments[0] exists; opens the one strongest exact citation using the reserved evidence allowance)",
  }),
]);
export interface PiWorkflowSummary {
  readonly name: string;
  readonly description: string;
  readonly toolName: string;
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
  readonly workflowSummaries?: readonly PiWorkflowSummary[];
  readonly mcpServerSummaries?: readonly PiMcpServerSummary[];
  readonly invoke?: (
    name: string,
    input: JsonValue,
    signal: AbortSignal,
    identity: {
      readonly executionId: string;
      readonly logicalExecutionId: string;
      readonly callId: string;
    },
    emitUpdate?: (update: JsonValue) => void,
  ) => Promise<JsonValue>;
  readonly execute: (
    source: string,
    timeoutMs: number | undefined,
    signal: AbortSignal,
    emit: (event: PiCodeExecutionEvent) => void,
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
function normalizeSingleLine(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}
function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
function escapeXmlBounded(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const escaped = escapeXml(value);
  if (encoder.encode(escaped).byteLength <= maxBytes) return escaped;
  const ellipsis = "…";
  const available = maxBytes - encoder.encode(ellipsis).byteLength;
  let result = "";
  let used = 0;
  for (const character of value) {
    const escapedCharacter = escapeXml(character);
    const bytes = encoder.encode(escapedCharacter).byteLength;
    if (used + bytes > available) break;
    result += escapedCharacter;
    used += bytes;
  }
  return `${result}${ellipsis}`;
}
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
  const intersections = schema["allOf"];
  if (Array.isArray(intersections) && intersections.length > 0) {
    const rendered = intersections.map((variant) => jsonSchemaType(variant, depth + 1));
    if (rendered.some((variant) => variant === undefined)) return undefined;
    return rendered.join("&");
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
    return `${itemType.includes("|") || itemType.includes("&") ? `(${itemType})` : itemType}[]`;
  }
  if (declaredType === "object" || isJsonObject(schema["properties"])) {
    const properties = schema["properties"];
    if (!isJsonObject(properties)) {
      const additional = schema["additionalProperties"];
      if (additional === false) return "Record<string,never>";
      const valueType = jsonSchemaType(additional ?? {}, depth + 1) ?? "JsonValue";
      return `Record<string,${valueType}>`;
    }
    const requiredValue = schema["required"];
    const required = new Set(
      Array.isArray(requiredValue)
        ? requiredValue.filter((value): value is string => typeof value === "string")
        : [],
    );
    const fields = Object.entries(properties).map(([name, propertySchema]) => {
      const propertyType = jsonSchemaType(propertySchema, depth + 1) ?? "JsonValue";
      return `${jsonSchemaPropertyName(name)}${required.has(name) ? "" : "?"}:${propertyType}`;
    });
    const additional = schema["additionalProperties"];
    if (additional !== false) {
      const valueType = jsonSchemaType(additional ?? {}, depth + 1) ?? "JsonValue";
      fields.push(`[key:string]:${valueType}`);
    }
    return `{${fields.join(";")}}`;
  }
  return "JsonValue";
}
function starterOutputContract(catalog: PiFrozenToolCatalog): string | undefined {
  const starter = CODEMODE_STARTER_CALLS.find((candidate) => candidate.exposeOutputContract);
  if (!starter) return undefined;
  const descriptor = catalog.tools.find((tool) => tool.name === starter.name);
  if (!descriptor) return undefined;
  const outputType = jsonSchemaType(descriptor.outputSchema);
  if (!outputType) return undefined;
  const contract = `${starter.name} returns ${outputType}.`;
  if (new TextEncoder().encode(contract).byteLength > MAX_STARTER_OUTPUT_CONTRACT_BYTES)
    return `Use noesis.describe(${JSON.stringify(starter.name)}) before depending on its result shape.`;
  return `Schema-derived starter result contract: ${contract}`;
}
function workflowIndex(summaries: readonly PiWorkflowSummary[] | undefined): string | undefined {
  if (!summaries || summaries.length === 0) return undefined;
  const normalized = summaries
    .map((summary) => ({
      name: normalizeSingleLine(summary.name),
      description: normalizeSingleLine(summary.description),
      toolName: normalizeSingleLine(summary.toolName),
    }))
    .sort((left, right) => {
      if (left.name !== right.name) return left.name < right.name ? -1 : 1;
      if (left.toolName !== right.toolName) return left.toolName < right.toolName ? -1 : 1;
      if (left.description === right.description) return 0;
      return left.description < right.description ? -1 : 1;
    });
  const selected = normalized.slice(0, MAX_WORKFLOW_SUMMARIES);
  const render = (entries: typeof selected, truncated: boolean): string => {
    const compactEntries = entries
      .map(
        ({ name, description, toolName }) =>
          `${escapeXmlBounded(name, MAX_WORKFLOW_NAME_BYTES)} [tool: ${escapeXmlBounded(toolName, MAX_WORKFLOW_TOOL_NAME_BYTES)}] — ${escapeXmlBounded(description, MAX_WORKFLOW_DESCRIPTION_BYTES)}`,
      )
      .join("; ");
    return [
      `<available_workflows>${compactEntries}</available_workflows>`,
      "Use each exact listed tool name with adapt for project-safe hotbar pinning.",
      "`workflows.run` is the generic runner; use `tools.workflows.describe({ name })` for the full workflow contract.",
      ...(truncated ? ["More saved workflows are available; use workflows.list to inspect them."] : []),
    ].join(" ");
  };
  let truncated = selected.length < normalized.length;
  while (selected.length > 0) {
    const value = render(selected, truncated);
    if (new TextEncoder().encode(value).byteLength <= MAX_WORKFLOW_INDEX_BYTES) return value;
    selected.pop();
    truncated = true;
  }
  return render([], true);
}
function mcpIndex(summaries: readonly PiMcpServerSummary[] | undefined): string | undefined {
  if (!summaries || summaries.length === 0) return undefined;
  const entries = summaries
    .slice(0, 32)
    .map(
      (server) =>
        `${escapeXmlBounded(server.name, 96)} (${String(server.tools)} tools, ${String(server.prompts)} prompts, ${String(server.resources)} resources, ${String(server.resourceTemplates)} templates)`,
    );
  while (entries.length > 0) {
    const value = `<available_mcp_servers>${entries.join("; ")}</available_mcp_servers> Use mcp.servers and mcp.inspect for details, and noesis.search to find exact MCP tool contracts.${summaries.length > entries.length ? " More servers are available through mcp.servers." : ""}`;
    if (new TextEncoder().encode(value).byteLength <= 4 * 1024) return value;
    entries.pop();
  }
  return "MCP servers are available. Use mcp.servers, mcp.inspect, and noesis.search for progressive discovery.";
}
function codemodeStarterKit(catalog: PiFrozenToolCatalog): string {
  const available = new Set(catalog.tools.map((tool) => tool.name));
  const calls = CODEMODE_STARTER_CALLS.filter(({ name }) => available.has(name)).map(({ call }) => call);
  if (calls.length === 0)
    return "For an unknown tool, return await noesis.search(query), then return await noesis.describe(exactName) to inspect its complete input and output contract.";
  const outputContract = starterOutputContract(catalog);
  return `Known starter tools—invoke these directly without search: ${calls.join("; ")}.${outputContract ? ` ${outputContract}` : ""} For any other tool, return await noesis.search(query), then return await noesis.describe(exactName) to inspect its complete input and output contract.`;
}
export function createPiExecuteTool(input: {
  readonly prepared: PreparedPiCodeExecution;
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly emit: (event: PiCodeExecutionEvent, parentToolCallId: string) => void;
}): AgentTool<typeof executeParametersJsonSchema, PiExecuteToolDetails> {
  const availableWorkflows = workflowIndex(input.prepared.workflowSummaries);
  const availableMcp = mcpIndex(input.prepared.mcpServerSummaries);
  const starterKit = codemodeStarterKit(input.prepared.catalog);
  const tool: AgentTool<typeof executeParametersJsonSchema, PiExecuteToolDetails> = {
    name: "execute",
    label: "Execute JavaScript",
    description: [
      "Execute JavaScript on the user's machine and compose work tools through the injected SDK.",
      "Compose the complete related operation in one program; do not wrap one known tool call or split one task across serial execute calls.",
      starterKit,
      "Invoke with return await tools.<family>.<operation>(input), or return await noesis.invoke(exactName, input).",
      "Batch independent calls with Promise.all. Keep intermediate results in code; when collected evidence needs judgment, pass it to one models.query call instead of repeatedly rewriting retrieval queries across foreground rounds.",
      "Inspect explicit completeness fields before models.query. Recover required truncated evidence through returned recovery fields or bounded recollection; if saved evidence is itself incomplete, narrow or safely rerun the collection. Never treat omitted output as proof that requested evidence is absent. Prefer several bounded independent calls over one aggregate command whose early output can crowd out later sections.",
      "For retrieval, one precise hybrid query normally suffices. Select and open the strongest citation in the same program. An empty or irrelevant result means only that this bounded search found no relevant evidence; report that bounded miss instead of cycling through paraphrases.",
      "For large-session analysis, context is a lazy immutable view of the complete pre-turn session timeline: inspect context.length, take context.slice(start, end), and await view.text() only when raw text is needed. Use await models.query(prompt, contextOrViews) for isolated tool-free subqueries on the frozen model route.",
      "emit(value) and notify(value) show progress to the user but do not return that value to you; use return for the final result that should enter conversation context.",
      "For reusable computation, save a typed Script with scripts.save; for durable or resumable phases, save a Workflow with workflows.save. Do not defer foreground program creation to reflection. Verify newly saved programs immediately.",
      ...(availableWorkflows ? [availableWorkflows] : []),
      ...(availableMcp ? [availableMcp] : []),
      "Use store(key, value)/load(key) for codemode-session scratch state.",
    ].join(" "),
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
          (event) => {
            if (event.type === "started") executionId = event.executionId;
            input.emit(event, toolCallId);
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
