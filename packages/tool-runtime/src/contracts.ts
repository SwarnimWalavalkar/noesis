import type {
  ActorRef,
  ArtifactFileRef,
  EffectClass,
  EvidenceRevisionRef,
  JsonValue,
  PermissionManifest,
  Principal,
} from "@noesis/domain";
import { EffectClassSchema, JsonValueSchema } from "@noesis/domain";
import { z } from "zod";

export interface GeneratedToolDependencyLock {
  readonly packageManager: "pnpm";
  readonly dependencies: Readonly<Record<string, string>>;
  readonly lockfile: string;
}

export interface GeneratedToolDefinition {
  readonly toolId: string;
  readonly name: string;
  readonly source: string;
  readonly inputSchemaId: string;
  readonly outputSchemaId: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly permissionManifest: PermissionManifest;
  readonly dependencyLock: GeneratedToolDependencyLock;
}

export interface GeneratedToolLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxBrokerMessageBytes: number;
  readonly maxBrokerRequests: number;
}

export const DEFAULT_GENERATED_TOOL_LIMITS: GeneratedToolLimits = Object.freeze({
  timeoutMs: 5_000,
  maxOutputBytes: 256 * 1_024,
  maxBrokerMessageBytes: 64 * 1_024,
  maxBrokerRequests: 32,
});

export const GeneratedEffectCallSchema = z.strictObject({
  requestId: z.string().min(1),
  operationId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  effect: EffectClassSchema,
  resource: z.string().min(1),
  estimatedCost: z.number().nonnegative(),
  input: JsonValueSchema,
});
export type GeneratedEffectCall = Readonly<z.infer<typeof GeneratedEffectCallSchema>>;

export type GeneratedEffectResult =
  | {
      readonly ok: true;
      readonly requestId: string;
      readonly output: JsonValue;
      readonly evidenceRefs: readonly string[];
      readonly replayed: boolean;
    }
  | {
      readonly ok: false;
      readonly requestId: string;
      readonly code: "invalid_input" | "undeclared" | "denied" | "failed" | "ambiguous" | "collision";
      readonly reason: string;
    };

export interface GeneratedToolBroker {
  readonly invoke: (call: GeneratedEffectCall) => Promise<GeneratedEffectResult>;
}

export interface GeneratedToolBackendRequest {
  readonly runId: string;
  readonly tool: GeneratedToolDefinition;
  readonly input: JsonValue;
  readonly limits: GeneratedToolLimits;
  readonly broker: GeneratedToolBroker;
  readonly signal?: AbortSignal;
}

export interface GeneratedToolBackendTrace {
  readonly backend: string;
  readonly previewIsolation: "local_child_process_not_security_boundary" | "deterministic_fake";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly brokerRequestCount: number;
}

export type GeneratedToolBackendResult =
  | {
      readonly ok: true;
      readonly output: JsonValue;
      readonly trace: GeneratedToolBackendTrace;
    }
  | {
      readonly ok: false;
      readonly code:
        | "child_error"
        | "timeout"
        | "output_limit"
        | "broker_limit"
        | "cancelled"
        | "protocol_error";
      readonly reason: string;
      readonly trace: GeneratedToolBackendTrace;
    };

/** Replace this port with a container, VM, or OS sandbox without changing tool authorship. */
export interface GeneratedToolBackend {
  readonly backendId: string;
  readonly execute: (request: GeneratedToolBackendRequest) => Promise<GeneratedToolBackendResult>;
}

export interface GeneratedToolArtifactSink {
  readonly recordSource: (request: {
    readonly runId: string;
    readonly toolId: string;
    readonly source: Uint8Array;
    readonly dependencyLock: Uint8Array;
    readonly actor: ActorRef;
  }) => Promise<ArtifactFileRef>;
  readonly recordTrace: (request: {
    readonly runId: string;
    readonly toolId: string;
    readonly trace: Uint8Array;
    readonly actor: ActorRef;
  }) => Promise<EvidenceRevisionRef<"tool_trace">>;
}

export interface GeneratedToolRunRequest {
  readonly runId: string;
  readonly tool: GeneratedToolDefinition;
  readonly input: JsonValue;
  readonly principal: Principal;
  readonly limits?: Partial<GeneratedToolLimits>;
  readonly signal?: AbortSignal;
}

export type GeneratedToolBackendFailureCode = Extract<
  GeneratedToolBackendResult,
  { readonly ok: false }
>["code"];

export type GeneratedToolRunResult =
  | {
      readonly ok: true;
      readonly output: JsonValue;
      readonly sourceArtifact: ArtifactFileRef;
      readonly traceEvidence: EvidenceRevisionRef<"tool_trace">;
    }
  | {
      readonly ok: false;
      readonly code: "invalid_input" | "invalid_output" | "dependency_lock" | GeneratedToolBackendFailureCode;
      readonly reason: string;
      readonly sourceArtifact: ArtifactFileRef;
      readonly traceEvidence: EvidenceRevisionRef<"tool_trace">;
    };

export interface EffectExecutionRequest {
  readonly principal: Principal;
  readonly effect: EffectClass;
  readonly resource: string;
  readonly input: JsonValue;
}

export interface EffectExecutionResult {
  readonly output: JsonValue;
  readonly evidenceRefs: readonly string[];
}

export interface ExistingEffectExecutor {
  readonly invoke: (request: EffectExecutionRequest) => Promise<EffectExecutionResult>;
}
