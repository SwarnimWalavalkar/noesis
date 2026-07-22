import type { AgentTool } from "@earendil-works/pi-agent-core";
import { sha256, toJsonValue } from "@noesis/domain";
import type { SessionToolDefinition, SessionToolError, SessionToolName } from "@noesis/intelligence";
import { z } from "zod";

const REQUIRED_SESSION_TOOLS = [
  "search_sessions",
  "open_session_evidence",
  "find_corrections",
  "find_similar_tasks",
  "prior_experiment_outcomes",
] as const satisfies readonly SessionToolName[];

export interface PiSessionToolDetails {
  readonly toolName: SessionToolName;
  readonly resultDigest: string;
}

export interface CreatePiSessionToolRegistrationOptions {
  readonly definitions: readonly SessionToolDefinition[];
}

/**
 * Adapts one turn-scoped intelligence toolset to Pi. This module owns no retrieval policy,
 * authorization, budget, or durable state; callers create a fresh intelligence toolset per turn.
 */
export function createPiSessionToolRegistration(
  options: CreatePiSessionToolRegistrationOptions,
): readonly AgentTool[] {
  const byName = new Map<SessionToolName, SessionToolDefinition>();
  for (const definition of options.definitions) {
    if (byName.has(definition.name)) throw new Error(`Duplicate session tool ${definition.name}`);
    byName.set(definition.name, definition);
  }
  const missing = REQUIRED_SESSION_TOOLS.filter((name) => !byName.has(name));
  if (missing.length > 0) throw new Error(`Missing session tools: ${missing.join(", ")}`);

  return Object.freeze(
    REQUIRED_SESSION_TOOLS.map((name) => {
      const definition = byName.get(name);
      if (!definition) throw new Error(`Missing session tool ${name}`);
      const parameters = z.toJSONSchema(definition.inputSchema);
      const tool: AgentTool<typeof parameters, PiSessionToolDetails> = {
        name: definition.name,
        label: definition.label,
        description: definition.description,
        parameters,
        executionMode: "sequential",
        execute: async (_toolCallId, params, signal) => {
          if (signal?.aborted) throw new Error(`${definition.name} was cancelled before execution`);
          const validated = definition.inputSchema.safeParse(params);
          if (!validated.success)
            throw new Error(`${definition.name} received input that failed adapter validation`);
          const result = await definition.execute(validated.data, signal ? { signal } : {});
          if (signal?.aborted) throw new Error(`${definition.name} was cancelled during execution`);
          if (!result.ok) throw sessionToolFailure(definition.name, result.error);
          const value = toJsonValue(result.value);
          const text = JSON.stringify(value);
          return {
            content: [{ type: "text", text }],
            details: { toolName: definition.name, resultDigest: sha256(text) },
          };
        },
      };
      return Object.freeze(tool);
    }),
  );
}

function sessionToolFailure(name: SessionToolName, error: SessionToolError): Error {
  const retry = error.retryable ? "retryable" : "not retryable";
  return new Error(`${name} failed [${error.code}, ${retry}]: ${error.message}`);
}
