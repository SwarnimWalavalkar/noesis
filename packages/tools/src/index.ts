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
import type { AuthorityBoundary, EffectDecision, EffectRequest } from "@noesis/policy";
import { z } from "zod";

export * from "./builtins.ts";

const MAX_TOOL_RESULT_BYTES = 64 * 1024;

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
  const implementationDigest = sha256(
    canonicalJson({
      effect: definition.effect.toString(),
      execute: definition.execute.toString(),
      identityMaterial: definition.identityMaterial ?? null,
    }),
  );
  return Object.freeze({
    name: definition.name,
    label: definition.label,
    description: definition.description,
    visibility: definition.visibility,
    implementationDigest,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    effect: (rawInput: unknown, context: ToolExecutionContext) =>
      definition.effect(definition.inputSchema.parse(rawInput), context),
    execute: async (rawInput: unknown, context: ToolExecutionContext) => {
      const input = definition.inputSchema.parse(rawInput);
      return definition.outputSchema.parse(await definition.execute(input, context));
    },
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
  return toJsonValue(z.toJSONSchema(schema));
}

function freezeDefinition(definition: ToolDefinition): FrozenDefinition {
  const identity = Object.freeze({
    name: definition.name,
    label: definition.label,
    description: definition.description,
    visibility: definition.visibility,
    implementationDigest: definition.implementationDigest,
    inputSchema: schemaJson(definition.inputSchema),
    outputSchema: schemaJson(definition.outputSchema),
  });
  const revisionId = `tool_${sha256(canonicalJson(identity))}`;
  return Object.freeze({
    definition,
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
    if (!entry) return failure("not_found", `Unknown tool: ${name}`);
    if (invocationContext.signal.aborted) return failure("cancelled", "Execution was cancelled");
    const parsedInput = entry.definition.inputSchema.safeParse(rawInput);
    if (!parsedInput.success) return failure("invalid_input", z.prettifyError(parsedInput.error));
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
    const effect = entry.definition.effect(parsedInput.data, context);
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
        if (context.signal.aborted) throw new Error("Execution was cancelled");
        const rawOutput = await entry.definition.execute(parsedInput.data, context);
        const parsedOutput = entry.definition.outputSchema.safeParse(rawOutput);
        if (!parsedOutput.success)
          throw new Error(`Tool returned invalid output: ${z.prettifyError(parsedOutput.error)}`);
        const output = JsonValueSchema.parse(parsedOutput.data);
        if (Buffer.byteLength(JSON.stringify(output), "utf8") > MAX_TOOL_RESULT_BYTES)
          throw new Error(`Tool result exceeds ${MAX_TOOL_RESULT_BYTES} bytes`);
        return output;
      },
    });
    const decision = await options.authority.runForeground(request, options.permission);
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
