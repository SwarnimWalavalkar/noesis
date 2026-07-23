import {
  canonicalJson,
  effectOperationFingerprint,
  type JsonValue,
  JsonValueSchema,
  type PermissionManifest,
  type Principal,
  type StableEffectOperationIdentity,
  sha256,
  toJsonValue,
} from "@noesis/domain";
import type { EffectGateway, GrantHandle } from "@noesis/policy";
import { z } from "zod";
import {
  type ExistingEffectExecutor,
  type GeneratedEffectCall,
  GeneratedEffectCallSchema,
  type GeneratedEffectResult,
  type GeneratedToolBroker,
} from "./contracts.ts";

const EffectEnvelopeSchema = z.strictObject({
  output: JsonValueSchema,
  evidenceRefs: z.array(z.string()),
});

export interface EffectGatewayBrokerOptions {
  readonly toolId: string;
  readonly principal: Principal;
  readonly manifest: PermissionManifest;
  readonly gateway: EffectGateway;
  readonly grantHandle?: GrantHandle;
  readonly executor: ExistingEffectExecutor;
}

function declared(manifest: PermissionManifest, call: GeneratedEffectCall): boolean {
  return (
    manifest.effects.includes(call.effect) &&
    manifest.resourcePatterns.some((pattern) => call.resource.startsWith(pattern))
  );
}

function effectIdentity(
  options: EffectGatewayBrokerOptions,
  call: GeneratedEffectCall,
): StableEffectOperationIdentity {
  return Object.freeze({
    operationId: call.operationId,
    idempotencyKey: call.idempotencyKey,
    principal: options.principal,
    effect: call.effect,
    resource: call.resource,
    requestDigest: sha256(
      canonicalJson({
        toolId: options.toolId,
        effect: call.effect,
        resource: call.resource,
        input: call.input,
      }),
    ),
  });
}

/**
 * Trusted parent-side adapter. Grant handles and receipts close over this object and never cross IPC.
 */
export function createEffectGatewayBroker(options: EffectGatewayBrokerOptions): GeneratedToolBroker {
  const fingerprintsByIdempotencyKey = new Map<string, string>();
  const fingerprintsByOperationId = new Map<string, string>();

  const reject = (
    requestId: string,
    code: Extract<GeneratedEffectResult, { readonly ok: false }>["code"],
    reason: string,
  ): GeneratedEffectResult => ({ ok: false, requestId, code, reason });

  const invoke = async (unknownCall: GeneratedEffectCall): Promise<GeneratedEffectResult> => {
    const parsed = GeneratedEffectCallSchema.safeParse(unknownCall);
    if (!parsed.success) return reject(unknownCall.requestId, "invalid_input", parsed.error.message);
    const call = parsed.data;
    if (!declared(options.manifest, call)) {
      return reject(
        call.requestId,
        "undeclared",
        "The effect or resource is not declared by this tool revision",
      );
    }

    const identity = effectIdentity(options, call);
    const fingerprint = effectOperationFingerprint(identity);
    const keyFingerprint = fingerprintsByIdempotencyKey.get(identity.idempotencyKey);
    const operationFingerprint = fingerprintsByOperationId.get(identity.operationId);
    if (
      (keyFingerprint !== undefined && keyFingerprint !== fingerprint) ||
      (operationFingerprint !== undefined && operationFingerprint !== fingerprint)
    ) {
      return reject(
        call.requestId,
        "collision",
        "Operation identity is already bound to different request bytes",
      );
    }
    fingerprintsByIdempotencyKey.set(identity.idempotencyKey, fingerprint);
    fingerprintsByOperationId.set(identity.operationId, fingerprint);

    const decision = await options.gateway.run(
      {
        ...identity,
        estimatedCost: call.estimatedCost,
        execute: async () => {
          const execution = await options.executor.invoke({
            principal: options.principal,
            effect: call.effect,
            resource: call.resource,
            input: call.input,
          });
          return toJsonValue(execution);
        },
      },
      options.grantHandle,
    );
    if (!decision.ok) return reject(call.requestId, decision.code, decision.reason);
    const envelope = EffectEnvelopeSchema.safeParse(decision.value);
    if (!envelope.success) {
      return reject(call.requestId, "failed", "Authorized effect returned an invalid broker envelope");
    }
    const output: JsonValue = envelope.data.output;
    return {
      ok: true,
      requestId: call.requestId,
      output,
      evidenceRefs: envelope.data.evidenceRefs,
      replayed: decision.replayed,
    };
  };

  return Object.freeze({ invoke });
}
