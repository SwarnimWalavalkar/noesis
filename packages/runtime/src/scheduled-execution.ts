import type { DurableJobRecord, JsonValue } from "@noesis/domain";
import type { AuthorityBoundary, EffectDecision } from "@noesis/policy";

export type ScheduledExecutionFailure = Readonly<{
  ok: false;
  code: Extract<EffectDecision<JsonValue>, { readonly ok: false }>["code"];
  reason: string;
  originalError?: unknown;
}>;

export type ScheduledExecutionResult<Result extends JsonValue> =
  | Readonly<{ ok: true; value: Result; replayed: boolean }>
  | ScheduledExecutionFailure;

export async function authorizeScheduledJob(
  authority: AuthorityBoundary,
  input: {
    readonly jobId: string;
    readonly budget: number;
    readonly expiresAt: string;
  },
): Promise<void> {
  const resource = `job:${input.jobId}:schedule`;
  const decision = await authority.schedule(resource, `schedule:${input.jobId}`, async (receipt) => {
    await authority.issueSchedulerGrant(
      input.jobId,
      Math.max(1, Math.floor(input.budget)),
      input.expiresAt,
      receipt,
    );
    return null;
  });
  if (!decision.ok) throw new Error(`Scheduled job authority ${decision.code}: ${decision.reason}`);
}

/**
 * A durable job claim is only a lease; it is not an effect identity. Each unambiguous failed
 * provider attempt may advance to the next bounded run identity. A reclaimed lease first probes
 * every earlier identity. Completed work replays, failed work may advance, and an unresolved
 * reservation fails closed without executing a fresh identity.
 */
export async function runScheduledJob<Result extends JsonValue>(
  authority: AuthorityBoundary,
  job: DurableJobRecord,
  operationFingerprint: string,
  execute: () => Promise<Result>,
  options: { readonly allowFailedAdvance?: boolean } = {},
): Promise<ScheduledExecutionResult<Result>> {
  for (let runNumber = 1; runNumber <= job.attempt; runNumber += 1) {
    let originalError: unknown;
    const decision = await authority.runScheduled(job.jobId, runNumber, operationFingerprint, async () => {
      try {
        return await execute();
      } catch (error) {
        originalError = error;
        throw error;
      }
    });
    if (decision.ok)
      return Object.freeze({
        ok: true as const,
        value: decision.value,
        replayed: decision.replayed,
      });
    if (originalError !== undefined)
      return Object.freeze({
        ok: false as const,
        code: decision.code,
        reason: decision.reason,
        originalError,
      });
    if (decision.code === "failed" && options.allowFailedAdvance !== false && runNumber < job.attempt)
      continue;
    return Object.freeze({
      ok: false as const,
      code: decision.code,
      reason: decision.reason,
    });
  }
  return Object.freeze({
    ok: false as const,
    code: "denied" as const,
    reason: `Scheduled job ${job.jobId} has no bounded execution attempt`,
  });
}
