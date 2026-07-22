import type { SessionToolDefinition, SessionToolName } from "@noesis/intelligence";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createPiSessionToolRegistration } from "../src/session-tool-registration.ts";

const names = [
  "search_sessions",
  "open_session_evidence",
  "find_corrections",
  "find_similar_tasks",
  "prior_experiment_outcomes",
] as const satisfies readonly SessionToolName[];

describe("Pi session tool registration", () => {
  test("adapts exactly the five bounded tools without owning policy or state", async () => {
    const observed: Array<{ readonly name: SessionToolName; readonly input: unknown }> = [];
    const tools = createPiSessionToolRegistration({
      definitions: definitions(async (name, input) => {
        observed.push({ name, input });
        return {
          ok: true,
          value: { fragments: [{ content: "bounded", provenance: ["message:1"] }] },
        };
      }),
    });

    expect(tools.map((tool) => tool.name)).toEqual(names);
    expect(tools.every((tool) => tool.executionMode === "sequential")).toBe(true);
    for (const tool of tools) expect(tool.parameters).toMatchObject({ type: "object" });

    const result = await tools[0]?.execute("call-1", { query: "release research" });
    expect(observed).toEqual([{ name: "search_sessions", input: { query: "release research" } }]);
    expect(result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("bounded") }],
      details: { toolName: "search_sessions" },
    });
  });

  test("checks cancellation before and after forwarding Pi's signal", async () => {
    let invocations = 0;
    const definitionsWithBlocking = definitions(async (_name, _input, signal) => {
      invocations += 1;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { ok: true, value: { fragments: [] } };
    });
    const [search] = createPiSessionToolRegistration({ definitions: definitionsWithBlocking });
    if (!search) throw new Error("Expected search tool");

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      search.execute("call-pre", { query: "release research" }, preAborted.signal),
    ).rejects.toThrow("cancelled before execution");
    expect(invocations).toBe(0);

    const controller = new AbortController();
    const pending = search.execute("call-mid", { query: "release research" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled during execution");
    expect(invocations).toBe(1);
  });

  test("throws typed intelligence failures so Pi records an error tool result", async () => {
    const [search] = createPiSessionToolRegistration({
      definitions: definitions(async () => ({
        ok: false,
        error: { code: "unauthorized", message: "private session denied", retryable: false },
      })),
    });
    if (!search) throw new Error("Expected search tool");

    await expect(search.execute("call-1", { query: "release research" })).rejects.toThrow(
      "[unauthorized, not retryable]",
    );
  });

  test("revalidates input and rejects incomplete registrations", async () => {
    const definitionsList = definitions(async () => ({ ok: true, value: {} }));
    const [search] = createPiSessionToolRegistration({ definitions: definitionsList });
    if (!search) throw new Error("Expected search tool");
    await expect(search.execute("call-invalid", {})).rejects.toThrow("adapter validation");
    expect(() => createPiSessionToolRegistration({ definitions: definitionsList.slice(1) })).toThrow(
      "Missing session tools: search_sessions",
    );
  });
});

function definitions(
  execute: (
    name: SessionToolName,
    input: unknown,
    signal?: AbortSignal,
  ) => Promise<Awaited<ReturnType<SessionToolDefinition["execute"]>>>,
): readonly SessionToolDefinition[] {
  return names.map((name) => ({
    name,
    label: name,
    description: `Adapter test for ${name}`,
    inputSchema: z.strictObject({ query: z.string().min(1) }),
    execute: async (input, options = {}) => await execute(name, input, options.signal),
  }));
}
