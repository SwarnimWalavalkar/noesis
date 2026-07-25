import type { AgentUsage } from "@noesis/agent-types";
import { createAgentRoleRunner } from "../../src/role-runner.ts";
import type {
  RoleBackendRequest,
  RoleBackendResult,
  RoleModelBackend,
  RoleStopReason,
  RoleVariantConfiguration,
  RuntimePiAgentRoleRunner,
} from "../../src/role-types.ts";

const ZERO_USAGE: AgentUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  estimatedCost: 0,
});

export interface ScriptedRoleResponse {
  readonly text: string;
  readonly stopReason?: RoleStopReason;
  readonly usage?: AgentUsage;
  readonly latencyMs?: number;
  readonly error?: string;
}

export interface CreateScriptedRoleModelBackendOptions {
  readonly respond: (request: RoleBackendRequest) => ScriptedRoleResponse | Promise<ScriptedRoleResponse>;
}

export interface CreateScriptedAgentRoleRunnerOptions extends CreateScriptedRoleModelBackendOptions {
  readonly variants: readonly RoleVariantConfiguration[];
  readonly now?: () => Date;
  readonly createTraceId?: () => string;
}

export function createScriptedAgentRoleRunner(
  options: CreateScriptedAgentRoleRunnerOptions,
): RuntimePiAgentRoleRunner {
  return createAgentRoleRunner({
    backend: createScriptedRoleModelBackend({ respond: options.respond }),
    variants: options.variants,
    ...(options.now ? { now: options.now } : {}),
    ...(options.createTraceId ? { createTraceId: options.createTraceId } : {}),
  });
}

export function createScriptedRoleModelBackend(
  options: CreateScriptedRoleModelBackendOptions,
): RoleModelBackend {
  const active = new Map<string, AbortController>();
  const abort = async (runId: string): Promise<void> => {
    active.get(runId)?.abort();
  };
  const run = async (request: RoleBackendRequest): Promise<RoleBackendResult> => {
    if (active.has(request.runId)) throw new Error(`Scripted role run ${request.runId} is already active`);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(request.signal.reason);
    if (request.signal.aborted) forwardAbort();
    else request.signal.addEventListener("abort", forwardAbort, { once: true });
    active.set(request.runId, controller);
    try {
      const response = await options.respond(request);
      if (response.latencyMs && response.latencyMs > 0) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, response.latencyMs);
          if (controller.signal.aborted) finish();
          else controller.signal.addEventListener("abort", finish, { once: true });
        });
      }
      const stopReason = controller.signal.aborted ? "aborted" : (response.stopReason ?? "stop");
      return Object.freeze({
        text: response.text,
        provider: request.provider,
        model: request.model,
        stopReason,
        usage: response.usage ?? ZERO_USAGE,
        ...(response.error ? { error: response.error } : {}),
      });
    } finally {
      request.signal.removeEventListener("abort", forwardAbort);
      if (active.get(request.runId) === controller) active.delete(request.runId);
    }
  };
  return Object.freeze({ run, abort });
}
