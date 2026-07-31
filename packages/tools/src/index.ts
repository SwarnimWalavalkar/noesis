import {
  type EffectClass,
  type JsonValue,
  JsonValueSchema,
  type PermissionManifest,
  canonicalJson,
  createId,
  sha256,
  toJsonValue,
} from "@noesis/domain";
import {
  createEffectExecutionFailure,
  inspectEffectExecutionFailure,
  type AuthorityBoundary,
  type EffectDecision,
  type EffectRequest,
} from "@noesis/policy";
import { z } from "zod";
import { MAX_TOOL_RESULT_BYTES } from "./limits.ts";

export * from "./builtins.ts";
export * from "./limits.ts";

export type ToolVisibility = "always" | "codemode_only";

export interface ToolExecutionContext {
  readonly executionId: string;
  readonly logicalExecutionId: string;
  readonly callId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly signal: AbortSignal;
}

export interface ToolEffect {
  readonly effect: EffectClass;
  readonly resource: string;
  readonly estimatedCost: number;
}

export interface ToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly visibility: ToolVisibility;
  readonly implementationDigest: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly outputSchema: z.ZodType<JsonValue>;
  readonly effect: (input: unknown, context: ToolExecutionContext) => ToolEffect;
  readonly execute: (input: unknown, context: ToolExecutionContext) => Promise<JsonValue>;
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
  const implementationDigest = sha256(
    canonicalJson({
      effect: deriveEffect.toString(),
      execute: execute.toString(),
      identityMaterial: definition.identityMaterial ?? null,
    }),
  );
  return Object.freeze({
    name,
    label,
    description,
    visibility,
    implementationDigest,
    inputSchema,
    outputSchema,
    // The broker is the sole validation boundary. These closures receive the already parsed value,
    // preventing Zod transforms from running once for effect derivation and again for execution.
    effect: (input: unknown, context: ToolExecutionContext) => deriveEffect(input as Input, context),
    execute: async (input: unknown, context: ToolExecutionContext) => await execute(input as Input, context),
  });
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
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreezeJson(item);
    return Object.freeze(value);
  }
  return value;
}

function freezeDefinition(definition: ToolDefinition): FrozenDefinition {
  const capturedDefinition: ToolDefinition = Object.freeze({
    name: definition.name,
    label: definition.label,
    description: definition.description,
    visibility: definition.visibility,
    implementationDigest: definition.implementationDigest,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    effect: definition.effect,
    execute: definition.execute,
  });
  const identity = Object.freeze({
    name: capturedDefinition.name,
    label: capturedDefinition.label,
    description: capturedDefinition.description,
    visibility: capturedDefinition.visibility,
    implementationDigest: capturedDefinition.implementationDigest,
    inputSchema: schemaJson(capturedDefinition.inputSchema),
    outputSchema: schemaJson(capturedDefinition.outputSchema),
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
  const normalized = requestedName.toLocaleLowerCase();
  const separator = normalized.indexOf(".");
  const requestedFamily = separator === -1 ? normalized : normalized.slice(0, separator);
  const requestedOperation = separator === -1 ? normalized : normalized.slice(separator + 1);
  return Object.freeze(
    descriptors
      .map((descriptor) => {
        const name = descriptor.name.toLocaleLowerCase();
        const candidateSeparator = name.indexOf(".");
        const candidateFamily = candidateSeparator === -1 ? name : name.slice(0, candidateSeparator);
        const candidateOperation = candidateSeparator === -1 ? name : name.slice(candidateSeparator + 1);
        const sameFamily = requestedFamily.length > 0 && requestedFamily === candidateFamily;
        const distance = sameFamily
          ? editDistance(requestedOperation, candidateOperation)
          : editDistance(normalized, name);
        return Object.freeze({ name: descriptor.name, sameFamily, distance });
      })
      .filter(({ sameFamily, distance }) => sameFamily || distance <= Math.max(2, normalized.length / 3))
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

function failure(code: ToolInvocationFailureCode, message: string): ToolInvocationFailure {
  return Object.freeze({ ok: false, code, message });
}

function decisionFailure(
  decision: Extract<EffectDecision<JsonValue>, { readonly ok: false }>,
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
    if (!/^[a-z][a-z0-9_.-]{0,127}$/u.test(entry.descriptor.name))
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
        `Unknown tool: ${name}.${recovery} Discover the frozen catalog with noesis.search(query), then inspect an exact contract with noesis.describe(name).`,
      );
    }
    if (invocationContext.signal.aborted) return failure("cancelled", "Execution was cancelled");
    const parsedInput = entry.definition.inputSchema.safeParse(rawInput);
    if (!parsedInput.success)
      return failure(
        "invalid_input",
        `Invalid input for ${name}: ${z.prettifyError(parsedInput.error)} Inspect the exact input schema with noesis.describe("${name}").`,
      );
    const input = toJsonValue(parsedInput.data);
    const callId = invocationContext.callId ?? createId("tool_call");
    const logicalExecutionId = invocationContext.logicalExecutionId ?? invocationContext.executionId;
    const occurredAt = now().toISOString();
    const context: ToolExecutionContext = Object.freeze({
      ...invocationContext,
      logicalExecutionId,
      callId,
    });
    const baseRecord = Object.freeze({
      callId,
      executionId: context.executionId,
      catalogId,
      catalogDigest,
      sessionId: context.sessionId,
      ...(context.turnId ? { turnId: context.turnId } : {}),
      toolName: name,
      toolRevisionId: entry.descriptor.revisionId,
      input,
      occurredAt,
    });
    const recordedStatus = await options.recorder?.status?.(callId);
    const recordedIsTerminal =
      recordedStatus === "completed" ||
      recordedStatus === "failed" ||
      recordedStatus === "denied" ||
      recordedStatus === "ambiguous";
    if (recordedStatus === undefined) {
      await options.recorder?.record(Object.freeze({ ...baseRecord, status: "requested" as const }));
      await options.recorder?.record(Object.freeze({ ...baseRecord, status: "running" as const }));
    }
    let effect: ToolEffect;
    try {
      effect = entry.definition.effect(parsedInput.data, context);
    } catch (error) {
      const executionFailure = inspectEffectExecutionFailure(error);
      const result = failure(
        executionFailure?.code ?? (context.signal.aborted ? "cancelled" : "failed"),
        executionFailure?.message ?? (error instanceof Error ? error.message : String(error)),
      );
      if (!recordedIsTerminal)
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
          rawOutput = await entry.definition.execute(parsedInput.data, context);
        } catch (error) {
          if (context.signal.aborted)
            throw createEffectExecutionFailure("cancelled", "Execution was cancelled");
          throw error;
        }
        const parsedOutput = entry.definition.outputSchema.safeParse(rawOutput);
        if (!parsedOutput.success)
          throw createEffectExecutionFailure(
            "invalid_output",
            `Tool returned invalid output: ${z.prettifyError(parsedOutput.error)}`,
          );
        const output = JsonValueSchema.parse(parsedOutput.data);
        if (Buffer.byteLength(JSON.stringify(output), "utf8") > MAX_TOOL_RESULT_BYTES)
          throw createEffectExecutionFailure(
            "result_too_large",
            `Tool result exceeds ${MAX_TOOL_RESULT_BYTES} bytes`,
          );
        return output;
      },
    });
    const decision = await options.authority.runForeground(request, permission);
    const completedAt = now().toISOString();
    if (!decision.ok) {
      const result = decisionFailure(decision);
      if (!recordedIsTerminal)
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
    if (!recordedIsTerminal)
      await options.recorder?.record(
        Object.freeze({
          ...baseRecord,
          status: "completed" as const,
          output: decision.value,
          completedAt,
        }),
      );
    return Object.freeze({
      ok: true,
      value: decision.value,
      callId,
      toolRevisionId: entry.descriptor.revisionId,
      replayed: decision.replayed,
    });
  };

  return Object.freeze({ catalogId, catalogDigest, list, search, describe, invoke });
}
