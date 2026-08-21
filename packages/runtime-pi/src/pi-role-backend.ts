import { createConditionalObject } from "@noesis/domain";
import { AgentHarness } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage, MutableModels } from "@earendil-works/pi-ai";
import type { AgentUsage } from "@noesis/agent-types";
import { createAgentRoleRunner } from "./role-runner.ts";
import { createEphemeralPiSession, releasePiSessionResources } from "./session-lifecycle.ts";
import type {
  RoleBackendRequest,
  RoleBackendResult,
  RoleModelBackend,
  RoleVariantConfiguration,
  RuntimePiAgentRoleRunner,
} from "./role-types.ts";
function assistantText(message: AssistantMessage): string {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}
function usageOf(message: AssistantMessage): AgentUsage {
  const totalTokens =
    message.usage.totalTokens ||
    message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
  return Object.freeze({
    inputTokens: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
    outputTokens: message.usage.output,
    totalTokens,
    estimatedCost: message.usage.cost.total,
  });
}
function missingAuthMessage(provider: string): string {
  if (provider === "openai-codex") {
    return "Codex OAuth is not configured. Run `noesis auth login openai-codex` before using this role.";
  }
  if (provider === "openrouter") {
    return "OpenRouter authentication is missing. Set OPENROUTER_API_KEY or run `noesis auth login openrouter`.";
  }
  if (provider === "anthropic") {
    return "Claude authentication is missing. Set ANTHROPIC_API_KEY or run `noesis auth login anthropic` for Claude Pro/Max OAuth.";
  }
  if (provider === "opencode") {
    return "OpenCode Zen authentication is missing. Set OPENCODE_API_KEY or run `noesis auth login opencode`.";
  }
  return `Pi credentials are missing for provider ${provider}.`;
}
interface ActivePiRoleRun {
  readonly controller: AbortController;
  harness?: AgentHarness;
  sessionId?: string;
  requestHarnessAbort?: () => Promise<void>;
  abortError?: unknown;
}
export function createPiRoleModelBackend(cwd: string, models: MutableModels): RoleModelBackend {
  const active = new Map<string, ActivePiRoleRun>();
  const abort = async (runId: string): Promise<void> => {
    const execution = active.get(runId);
    execution?.controller.abort();
    await execution?.requestHarnessAbort?.();
    if (execution?.abortError) throw execution.abortError;
  };
  const run = async (request: RoleBackendRequest): Promise<RoleBackendResult> => {
    if (active.has(request.runId)) throw new Error(`Pi role run ${request.runId} is already active`);
    const execution: ActivePiRoleRun = { controller: new AbortController() };
    const forwardAbort = () => execution.controller.abort(request.signal.reason);
    if (request.signal.aborted) forwardAbort();
    else request.signal.addEventListener("abort", forwardAbort, { once: true });
    active.set(request.runId, execution);
    try {
      if (execution.controller.signal.aborted) throw new Error("Pi role run aborted");
      const model = models.getModel(request.provider, request.model);
      if (!model) throw new Error(`Pi model not found: ${request.provider}/${request.model}`);
      const auth = await models.getAuth(model);
      if (!auth) throw new Error(missingAuthMessage(request.provider));
      if (execution.controller.signal.aborted) throw new Error("Pi role run aborted");
      const { session, sessionId } = await createEphemeralPiSession();
      execution.sessionId = sessionId;
      if (execution.controller.signal.aborted) throw new Error("Pi role run aborted");
      // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
      const harness = new AgentHarness({
        env: new NodeExecutionEnv({ cwd }),
        session,
        models,
        model,
        tools: [],
        thinkingLevel: request.reasoning,
        systemPrompt: request.systemPrompt,
        streamOptions: createConditionalObject({} as const)
          .addOptional(!(request.timeoutMs === undefined) ? { timeoutMs: request.timeoutMs } : undefined)
          .addOptional(!(request.maxRetries === undefined) ? { maxRetries: request.maxRetries } : undefined)
          .finish(),
      });
      execution.harness = harness;
      let abortPromise: Promise<void> | undefined;
      const requestHarnessAbort = (): Promise<void> => {
        abortPromise ??= harness.abort().then(
          () => undefined,
          (cause: unknown) => {
            execution.abortError = cause;
          },
        );
        return abortPromise;
      };
      execution.requestHarnessAbort = requestHarnessAbort;
      const abortHarness = () => requestHarnessAbort();
      execution.controller.signal.addEventListener("abort", abortHarness, { once: true });
      let result: RoleBackendResult;
      try {
        const message = await harness.prompt(request.prompt);
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        result = Object.freeze(
          createConditionalObject({
            text: assistantText(message),
            provider: message.provider,
            model: message.model,
            stopReason: message.stopReason,
            usage: usageOf(message),
          } as const)
            .addOptional(message.errorMessage?.trim() ? { error: message.errorMessage.trim() } : undefined)
            .finish(),
        );
      } finally {
        execution.controller.signal.removeEventListener("abort", abortHarness);
        await abortPromise;
      }
      if (execution.abortError) throw execution.abortError;
      return result;
    } finally {
      request.signal.removeEventListener("abort", forwardAbort);
      try {
        try {
          if (execution.harness) await execution.harness.waitForIdle();
        } finally {
          if (execution.sessionId) releasePiSessionResources(execution.sessionId);
        }
      } finally {
        if (active.get(request.runId) === execution) active.delete(request.runId);
      }
    }
  };
  return Object.freeze({ run, abort });
}
export function createPiAgentRoleRunner(
  cwd: string,
  models: MutableModels,
  variants: readonly RoleVariantConfiguration[],
): RuntimePiAgentRoleRunner {
  return createAgentRoleRunner({ backend: createPiRoleModelBackend(cwd, models), variants });
}
