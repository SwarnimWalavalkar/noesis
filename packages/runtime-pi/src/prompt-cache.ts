import type { AgentHarness } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import { sha256 } from "@noesis/domain";

/** Cache grouping is independent of Pi's per-execution transport/resource identity. */
export function promptCacheKey(workspace: string, scope: string): string {
  return sha256(JSON.stringify(["noesis-prompt-cache-v1", workspace, scope]));
}

const snakeCachePayload = z.looseObject({ prompt_cache_key: z.string() });
const camelCachePayload = z.looseObject({ promptCacheKey: z.string() });

export function applyPromptCacheKey<T>(payload: T, key: string) {
  // Parse only the optional provider extension; preserve all unrelated wire fields.
  const snake = snakeCachePayload.safeParse(payload);
  if (snake.success) return { ...snake.data, prompt_cache_key: key };
  const camel = camelCachePayload.safeParse(payload);
  if (camel.success) return { ...camel.data, promptCacheKey: key };
  return payload;
}

export function installPromptCacheKey(harness: AgentHarness, workspace: string, scope: string): void {
  const key = promptCacheKey(workspace, scope);
  harness.hooks.on("before_payload", async ({ payload }) => ({ payload: applyPromptCacheKey(payload, key) }));
}
