import {
  createConditionalObject,
  canonicalJson,
  createId,
  type EffectClass,
  isJsonObject,
  type JsonValue,
  JsonValueSchema,
  type PermissionManifest,
  sha256,
  toJsonValue,
} from "@noesis/domain";
import {
  type AuthorityBoundary,
  createEffectExecutionFailure,
  type EffectDecision,
  type EffectRequest,
  inspectEffectExecutionFailure,
} from "@noesis/policy";
import { z } from "zod";
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/u;
const MAX_TOOL_NAME_CHARACTERS = 128;
function isValidToolName(name: string): boolean {
  return name.length <= MAX_TOOL_NAME_CHARACTERS && TOOL_NAME_PATTERN.test(name);
}
function displayToolName(name: string): string {
  if (name.length <= MAX_TOOL_NAME_CHARACTERS) return name;
  return `${name.slice(0, MAX_TOOL_NAME_CHARACTERS)}… [truncated]`;
}
export * from "./builtins.ts";
export * from "./limits.ts";
export type ToolVisibility = "always" | "codemode_only";
export interface ToolExecutionContext {
  readonly executionId: string;
  /** Durable codemode execution that owns this call; absent for direct Broker invocations. */
  readonly parentExecutionId?: string;
  readonly logicalExecutionId: string;
  readonly callId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly signal: AbortSignal;
  readonly emitUpdate?: (update: JsonValue) => void;
}
export interface ToolEffect {
  readonly effect: EffectClass;
  readonly resource: string;
  readonly estimatedCost: number;
}
export interface ToolReportedFailure {
  readonly message: string;
  readonly details?: JsonValue;
}
export interface ToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly visibility: ToolVisibility;
  readonly implementationDigest: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly outputSchema: z.ZodType<JsonValue>;
  /** Optional protocol-owned validator used when native JSON Schema is the catalog authority. */
  /** BOUNDARY: Native protocol validation converts an untyped invocation into durable JSON. */
  readonly parseInput?: (input: unknown) => unknown;
  /** Optional protocol-owned validator used when native JSON Schema is the catalog authority. */
  /** BOUNDARY: Native protocol output is parsed before entering the durable tool record. */
  readonly parseOutput?: (output: unknown) => JsonValue;
  /** Native protocol schema to publish in the frozen catalog when Zod is not the schema authority. */
  readonly catalogInputSchema?: JsonValue;
  /** Native protocol schema to publish in the frozen catalog when Zod is not the schema authority. */
  readonly catalogOutputSchema?: JsonValue;
  /** BOUNDARY: The broker has parsed this erased value with inputSchema before dispatch. */
  readonly effect: (input: unknown, context: ToolExecutionContext) => ToolEffect;
  /** BOUNDARY: The broker has parsed this erased value with inputSchema before dispatch. */
  readonly execute: (input: unknown, context: ToolExecutionContext) => Promise<JsonValue>;
  /** Classifies a protocol-valid result as an expected tool failure after its effect has settled. */
  readonly reportedFailure?: (output: JsonValue) => ToolReportedFailure | undefined;
}
export interface ToolAuthoringDefinition<Input, Output extends JsonValue> {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly visibility: ToolVisibility;
  readonly identityMaterial?: JsonValue;
  readonly inputSchema: z.ZodType<Input>;
  readonly outputSchema: z.ZodType<Output>;
  readonly effect: (input: Input, context: ToolExecutionContext) => ToolEffect;
  readonly execute: (input: Input, context: ToolExecutionContext) => Promise<Output>;
  readonly reportedFailure?: (output: Output) => ToolReportedFailure | undefined;
}
export function defineTool<Input, Output extends JsonValue>(
  definition: ToolAuthoringDefinition<Input, Output>,
): ToolDefinition {
  const name = definition.name;
  const label = definition.label;
  const description = definition.description;
  const visibility = definition.visibility;
  const inputSchema = definition.inputSchema;
  const outputSchema = definition.outputSchema;
  const deriveEffect = definition.effect;
  const execute = definition.execute;
  const reportedFailure = definition.reportedFailure;
  const implementationDigest = sha256(
    canonicalJson({
      effect: deriveEffect.toString(),
      execute: execute.toString(),
      reportedFailure: reportedFailure?.toString() ?? null,
      identityMaterial: definition.identityMaterial ?? null,
    }),
  );
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze(
    createConditionalObject({
      name,
      label,
      description,
      visibility,
      implementationDigest,
      inputSchema,
      outputSchema,
      // The broker is the sole validation boundary. These closures receive the already parsed value,
      // preventing Zod transforms from running once for effect derivation and again for execution.
      // BOUNDARY: The broker parses every invocation with inputSchema before these erased closures run.
      effect: (input: unknown, context: ToolExecutionContext) => deriveEffect(input as Input, context),
      // BOUNDARY: The broker parses every invocation with inputSchema before these erased closures run.
      execute: async (input: unknown, context: ToolExecutionContext) =>
        await execute(input as Input, context),
    } as const)
      .addOptional(
        reportedFailure
          ? {
              // SAFETY: The broker parses every result with outputSchema before classification.
              reportedFailure: (output: JsonValue) => reportedFailure(output as Output),
            }
          : undefined,
      )
      .finish(),
  );
}
export interface FrozenToolDescriptor {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly visibility: ToolVisibility;
  readonly implementationDigest: string;
  readonly revisionId: string;
  readonly inputSchema: JsonValue;
  readonly outputSchema: JsonValue;
}
export interface ToolSearchHit {
  readonly name: string;
  readonly description: string;
  readonly revisionId: string;
  readonly score: number;
}
export type ToolInvocationFailureCode =
  | "not_found"
  | "invalid_input"
  | "invalid_output"
  | "denied"
  | "failed"
  | "ambiguous"
  | "collision"
  | "cancelled"
  | "result_too_large";
export interface ToolInvocationFailure {
  readonly ok: false;
  readonly code: ToolInvocationFailureCode;
  readonly message: string;
  readonly details?: JsonValue;
}
export interface ToolInvocationSuccess {
  readonly ok: true;
  readonly value: JsonValue;
  readonly callId: string;
  readonly toolRevisionId: string;
  readonly replayed: boolean;
}
export type ToolInvocationResult = ToolInvocationSuccess | ToolInvocationFailure;
export interface ToolInvocationRecord {
  readonly callId: string;
  readonly executionId: string;
  readonly catalogId: string;
  readonly catalogDigest: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly toolName: string;
  readonly toolRevisionId: string;
  readonly input: JsonValue;
  readonly output?: JsonValue;
  readonly status: "requested" | "running" | "completed" | "failed" | "denied" | "ambiguous";
  readonly occurredAt: string;
  readonly completedAt?: string;
  readonly error?: string;
}
export interface ToolInvocationRecorder {
  readonly record: (record: ToolInvocationRecord) => Promise<void>;
  readonly status?: (callId: string) => Promise<ToolInvocationRecord["status"] | undefined>;
}
export interface ToolBroker {
  readonly catalogId: string;
  readonly catalogDigest: string;
  readonly list: () => readonly FrozenToolDescriptor[];
  readonly search: (query: string, limit?: number) => readonly ToolSearchHit[];
  readonly describe: (name: string) => FrozenToolDescriptor | undefined;
  /** BOUNDARY: Public tool invocation input is parsed by the selected frozen definition. */
  readonly invoke: (
    name: string,
    input: unknown,
    context: Omit<ToolExecutionContext, "callId" | "logicalExecutionId"> & {
      readonly callId?: string;
      readonly logicalExecutionId?: string;
    },
  ) => Promise<ToolInvocationResult>;
}
interface FrozenDefinition {
  readonly definition: ToolDefinition;
  readonly descriptor: FrozenToolDescriptor;
}
function schemaJson(schema: z.ZodType): JsonValue {
  return deepFreezeJson(toJsonValue(z.toJSONSchema(schema, { unrepresentable: "any" })));
}
function deepFreezeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item);
    return Object.freeze(value);
  }
  if (isJsonObject(value)) {
    for (const item of Object.values(value)) deepFreezeJson(item);
    return Object.freeze(value);
  }
  return value;
}
function freezeDefinition(definition: ToolDefinition): FrozenDefinition {
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const capturedDefinition: ToolDefinition = Object.freeze(
    createConditionalObject({
      name: definition.name,
      label: definition.label,
      description: definition.description,
      visibility: definition.visibility,
      implementationDigest: definition.implementationDigest,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
    } as const)
      .addOptional(definition.parseInput ? { parseInput: definition.parseInput } : undefined)
      .addOptional(definition.parseOutput ? { parseOutput: definition.parseOutput } : undefined)
      .addOptional(definition.reportedFailure ? { reportedFailure: definition.reportedFailure } : undefined)
      .addOptional(
        !(definition.catalogInputSchema === undefined)
          ? {
              catalogInputSchema: deepFreezeJson(structuredClone(definition.catalogInputSchema)),
            }
          : undefined,
      )
      .addOptional(
        !(definition.catalogOutputSchema === undefined)
          ? {
              catalogOutputSchema: deepFreezeJson(structuredClone(definition.catalogOutputSchema)),
            }
          : undefined,
      )
      .add({
        effect: definition.effect,
        execute: definition.execute,
      } as const)
      .finish(),
  );
  const identity = Object.freeze({
    name: capturedDefinition.name,
    label: capturedDefinition.label,
    description: capturedDefinition.description,
    visibility: capturedDefinition.visibility,
    implementationDigest: capturedDefinition.implementationDigest,
    inputSchema: capturedDefinition.catalogInputSchema ?? schemaJson(capturedDefinition.inputSchema),
    outputSchema: capturedDefinition.catalogOutputSchema ?? schemaJson(capturedDefinition.outputSchema),
  });
  const revisionId = `tool_${sha256(canonicalJson(identity))}`;
  return Object.freeze({
    definition: capturedDefinition,
    descriptor: Object.freeze({ ...identity, revisionId }),
  });
}
function normalizeTerms(value: string): readonly string[] {
  return Object.freeze(
    value
      .toLocaleLowerCase()
      .split(/[^a-z0-9_-]+/u)
      .filter(Boolean),
  );
}
function scoreDescriptor(descriptor: FrozenToolDescriptor, terms: readonly string[]): number {
  if (terms.length === 0) return 1;
  const name = descriptor.name.toLocaleLowerCase();
  const haystack = `${name} ${descriptor.label} ${descriptor.description}`.toLocaleLowerCase();
  return terms.reduce((score, term) => {
    if (name === term) return score + 20;
    if (name.includes(term)) return score + 8;
    if (haystack.includes(term)) return score + 2;
    return score;
  }, 0);
}
function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(
        Math.min(
          (current[rightIndex] ?? 0) + 1,
          (previous[rightIndex + 1] ?? 0) + 1,
          (previous[rightIndex] ?? 0) + (left[leftIndex] === right[rightIndex] ? 0 : 1),
        ),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous.at(-1) ?? 0;
}
function nearestToolNames(
  requestedName: string,
  descriptors: readonly FrozenToolDescriptor[],
): readonly string[] {
  if (requestedName.length > MAX_TOOL_NAME_CHARACTERS) return Object.freeze([]);
  const normalized = requestedName.toLocaleLowerCase();
  const separator = normalized.indexOf(".");
  const requestedHasSeparator = separator !== -1;
  const requestedFamily = separator === -1 ? normalized : normalized.slice(0, separator);
  const requestedOperation = separator === -1 ? normalized : normalized.slice(separator + 1);
  return Object.freeze(
    descriptors
      .map((descriptor) => {
        const name = descriptor.name.toLocaleLowerCase();
        const candidateSeparator = name.indexOf(".");
        const candidateHasSeparator = candidateSeparator !== -1;
        const candidateFamily = candidateSeparator === -1 ? name : name.slice(0, candidateSeparator);
        const candidateOperation = candidateSeparator === -1 ? name : name.slice(candidateSeparator + 1);
        const sameFamily =
          requestedHasSeparator &&
          candidateHasSeparator &&
          requestedFamily.length > 0 &&
          requestedFamily === candidateFamily;
        const distance = sameFamily
          ? editDistance(requestedOperation, candidateOperation)
          : editDistance(normalized, name);
        const comparedLength = Math.max(
          sameFamily ? requestedOperation.length : normalized.length,
          sameFamily ? candidateOperation.length : name.length,
        );
        return Object.freeze({ name: descriptor.name, sameFamily, distance, comparedLength });
      })
      .filter(
        ({ distance, comparedLength }) =>
          comparedLength > 0 && distance <= Math.max(1, Math.floor(comparedLength / 3)),
      )
      .sort(
        (left, right) =>
          Number(right.sameFamily) - Number(left.sameFamily) ||
          left.distance - right.distance ||
          left.name.localeCompare(right.name),
      )
      .slice(0, 3)
      .map(({ name }) => name),
  );
}
function failure(
  code: ToolInvocationFailureCode,
  message: string,
  details?: JsonValue,
): ToolInvocationFailure {
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze(
    createConditionalObject({
      ok: false,
      code,
      message,
    } as const)
      .addOptional(!(details === undefined) ? { details } : undefined)
      .finish(),
  );
}
function decisionFailure(
  decision: Extract<
    EffectDecision<JsonValue>,
    {
      readonly ok: false;
    }
  >,
): ToolInvocationFailure {
  return failure(decision.code, decision.reason);
}
export interface CreateToolBrokerOptions {
  readonly definitions: readonly ToolDefinition[];
  readonly authority: Pick<AuthorityBoundary, "runForeground">;
  readonly permission: PermissionManifest;
  readonly recorder?: ToolInvocationRecorder;
  readonly now?: () => Date;
}
export function createToolBroker(options: CreateToolBrokerOptions): ToolBroker {
  const frozen = Object.freeze(options.definitions.map(freezeDefinition));
  const permission: PermissionManifest = Object.freeze({
    effects: Object.freeze([...options.permission.effects]),
    resourcePatterns: Object.freeze([...options.permission.resourcePatterns]),
    credentialRefs: Object.freeze([...options.permission.credentialRefs]),
  });
  const names = new Set<string>();
  for (const entry of frozen) {
    if (!isValidToolName(entry.descriptor.name))
      throw new Error(`Invalid tool name ${entry.descriptor.name}`);
    if (names.has(entry.descriptor.name)) throw new Error(`Duplicate tool name ${entry.descriptor.name}`);
    names.add(entry.descriptor.name);
  }
  const ordered = Object.freeze(
    [...frozen].sort((left, right) => left.descriptor.name.localeCompare(right.descriptor.name)),
  );
  const byName = new Map(ordered.map((entry) => [entry.descriptor.name, entry]));
  const descriptors = Object.freeze(ordered.map((entry) => entry.descriptor));
  const catalogDigest = sha256(canonicalJson(descriptors));
  const catalogId = `catalog_${catalogDigest}`;
  const now = options.now ?? (() => new Date());
  const list = (): readonly FrozenToolDescriptor[] => descriptors;
  const describe = (name: string): FrozenToolDescriptor | undefined => byName.get(name)?.descriptor;
  const search = (query: string, limit = 12): readonly ToolSearchHit[] => {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const terms = normalizeTerms(query);
    return Object.freeze(
      ordered
        .map(({ descriptor }) => Object.freeze({ descriptor, score: scoreDescriptor(descriptor, terms) }))
        .filter(({ score }) => score > 0)
        .sort(
          (left, right) =>
            right.score - left.score || left.descriptor.name.localeCompare(right.descriptor.name),
        )
        .slice(0, safeLimit)
        .map(({ descriptor, score }) =>
          Object.freeze({
            name: descriptor.name,
            description: descriptor.description,
            revisionId: descriptor.revisionId,
            score,
          }),
        ),
    );
  };
  const invoke: ToolBroker["invoke"] = async (name, rawInput, invocationContext) => {
    const entry = byName.get(name);
    if (!entry) {
      const suggestions = nearestToolNames(name, descriptors);
      const recovery = suggestions.length > 0 ? ` Did you mean ${suggestions.join(", ")}?` : "";
      return failure(
        "not_found",
        `Unknown tool: ${displayToolName(name)}.${recovery} Discover the frozen catalog with noesis.search(query), then inspect an exact contract with noesis.describe(name).`,
      );
    }
    if (invocationContext.signal.aborted) return failure("cancelled", "Execution was cancelled");
    let parsedInput: unknown;
    let input: JsonValue;
    try {
      parsedInput = entry.definition.parseInput
        ? entry.definition.parseInput(rawInput)
        : entry.definition.inputSchema.parse(rawInput);
      input = toJsonValue(parsedInput);
    } catch (error) {
      const detail =
        error instanceof z.ZodError
          ? z.prettifyError(error)
          : error instanceof Error
            ? error.message
            : String(error);
      return failure(
        "invalid_input",
        `Invalid input for ${name}: ${detail} Inspect the exact input schema with noesis.describe("${name}").`,
      );
    }
    const callId = invocationContext.callId ?? createId("tool_call");
    const logicalExecutionId = invocationContext.logicalExecutionId ?? invocationContext.executionId;
    const occurredAt = now().toISOString();
    const context: ToolExecutionContext = Object.freeze({
      ...invocationContext,
      logicalExecutionId,
      callId,
    });
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const baseRecord = Object.freeze(
      createConditionalObject({
        callId,
        executionId: context.executionId,
        catalogId,
        catalogDigest,
        sessionId: context.sessionId,
      } as const)
        .addOptional(context.turnId ? { turnId: context.turnId } : undefined)
        .add({
          toolName: name,
          toolRevisionId: entry.descriptor.revisionId,
          input,
          occurredAt,
        } as const)
        .finish(),
    );
    const recordedStatus = await options.recorder?.status?.(callId);
    const recordedIsTerminal =
      recordedStatus === "completed" ||
      recordedStatus === "failed" ||
      recordedStatus === "denied" ||
      recordedStatus === "ambiguous";
    if (recordedStatus === undefined) {
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      await options.recorder?.record(Object.freeze({ ...baseRecord, status: "requested" as const }));
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      await options.recorder?.record(Object.freeze({ ...baseRecord, status: "running" as const }));
    }
    let effect: ToolEffect;
    try {
      effect = entry.definition.effect(parsedInput, context);
    } catch (error) {
      const executionFailure = inspectEffectExecutionFailure(error);
      const result = failure(
        executionFailure?.code ?? (context.signal.aborted ? "cancelled" : "failed"),
        executionFailure?.message ?? (error instanceof Error ? error.message : String(error)),
      );
      if (!recordedIsTerminal)
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        await options.recorder?.record(
          Object.freeze({
            ...baseRecord,
            status: "failed" as const,
            completedAt: now().toISOString(),
            error: result.message,
          }),
        );
      return result;
    }
    const requestDigest = sha256(
      canonicalJson({
        catalogDigest,
        toolRevisionId: entry.descriptor.revisionId,
        input,
        effect,
      }),
    );
    const request: Omit<EffectRequest<JsonValue>, "principal"> = Object.freeze({
      operationId: `operation_${sha256(`${callId}:${requestDigest}`)}`,
      effect: effect.effect,
      resource: effect.resource,
      estimatedCost: effect.estimatedCost,
      idempotencyKey: `tool:${callId}:${entry.descriptor.revisionId}`,
      requestDigest,
      execute: async () => {
        if (context.signal.aborted)
          throw createEffectExecutionFailure("cancelled", "Execution was cancelled");
        let rawOutput: JsonValue;
        try {
          rawOutput = await entry.definition.execute(parsedInput, context);
        } catch (error) {
          if (context.signal.aborted)
            throw createEffectExecutionFailure("cancelled", "Execution was cancelled");
          throw error;
        }
        let output: JsonValue;
        try {
          output = JsonValueSchema.parse(
            entry.definition.parseOutput
              ? entry.definition.parseOutput(rawOutput)
              : entry.definition.outputSchema.parse(rawOutput),
          );
        } catch (error) {
          const detail =
            error instanceof z.ZodError
              ? z.prettifyError(error)
              : error instanceof Error
                ? error.message
                : String(error);
          throw createEffectExecutionFailure("invalid_output", `Tool returned invalid output: ${detail}`);
        }
        return output;
      },
    });
    const decision = await options.authority.runForeground(request, permission);
    const completedAt = now().toISOString();
    if (!decision.ok) {
      const result = decisionFailure(decision);
      if (!recordedIsTerminal)
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        await options.recorder?.record(
          Object.freeze({
            ...baseRecord,
            status:
              decision.code === "denied"
                ? ("denied" as const)
                : decision.code === "ambiguous"
                  ? ("ambiguous" as const)
                  : ("failed" as const),
            completedAt,
            error: result.message,
          }),
        );
      return result;
    }
    const completedValue = decision.value;
    const reportedFailure = entry.definition.reportedFailure?.(completedValue);
    if (reportedFailure) {
      if (!recordedIsTerminal)
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        await options.recorder?.record(
          Object.freeze({
            ...baseRecord,
            status: "failed" as const,
            output: completedValue,
            completedAt,
            error: reportedFailure.message,
          }),
        );
      return failure("failed", reportedFailure.message, completedValue);
    }
    if (!recordedIsTerminal)
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      await options.recorder?.record(
        Object.freeze({
          ...baseRecord,
          status: "completed" as const,
          output: completedValue,
          completedAt,
        }),
      );
    return Object.freeze({
      ok: true,
      value: completedValue,
      callId,
      toolRevisionId: entry.descriptor.revisionId,
      replayed: decision.replayed,
    });
  };
  return Object.freeze({ catalogId, catalogDigest, list, search, describe, invoke });
}
