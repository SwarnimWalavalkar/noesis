import { createConditionalObject } from "@noesis/domain";
import type { AgentActionEvent, AgentRuntimeEvent } from "@noesis/agent-types";
import type { NoesisTuiAction } from "./state.ts";
import { safeTerminalText } from "./theme.ts";
/** Runtime action identities are already durable and must survive transcript hydration unchanged. */
export function actionIdentityForView(event: AgentActionEvent): {
  readonly actionId: string;
  readonly parentActionId?: string;
} {
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze(
    createConditionalObject({
      actionId: event.actionId,
    } as const)
      .addOptional(event.parentActionId ? { parentActionId: event.parentActionId } : undefined)
      .finish(),
  );
}
export function tuiActionForAgentEvent(
  event: Exclude<AgentRuntimeEvent, { readonly type: "delta" } | { readonly type: "reasoning-delta" }>,
  at = Date.now(),
): NoesisTuiAction | undefined {
  if (event.type === "tool-start") {
    const identity = actionIdentityForView(event);
    return {
      type: "action-started",
      ...identity,
      name: event.name,
      input: event.input,
      at,
    };
  }
  if (event.type === "tool-update")
    return {
      type: "action-updated",
      actionId: event.actionId,
      update: event.update,
    };
  if (event.type === "tool-end")
    return {
      type: "action-ended",
      actionId: event.actionId,
      output: event.result,
      isError: event.isError,
      at,
    };
  if (event.type === "model")
    return {
      type: "model-metadata",
      provider: event.provider,
      model: event.model,
      contextWindow: event.contextWindow,
    };
  if (event.type === "usage")
    return {
      type: "usage-updated",
      usedTokens: event.usedTokens,
      contextWindow: event.contextWindow,
      accuracy: event.accuracy,
    };
  if (event.type === "assistant-message") return undefined;
  if (event.type === "reasoning-message") return { type: "reasoning-reconciled", text: event.text };
  if (event.status === "started") return { type: "execution-changed", execution: "thinking" };
  if (event.status === "aborted") return { type: "execution-changed", execution: "idle" };
  if (event.status === "failed") return { type: "failed", error: safeTerminalText(event.error) };
  return undefined;
}
