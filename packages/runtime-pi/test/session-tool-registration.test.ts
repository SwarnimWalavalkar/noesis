import type { SessionToolDefinition, SessionToolName } from "@noesis/intelligence";
import { sha256 } from "@noesis/domain";
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
    const visibleText = result?.content[0]?.type === "text" ? result.content[0].text : "";
    expect(visibleText.match(/bounded/gu)).toHaveLength(1);
    expect(result?.details).toEqual({
      toolName: "search_sessions",
      resultDigest: sha256(visibleText),
    });
    expect(JSON.stringify(result?.details)).not.toContain("bounded");
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

  test("bounds the serialized Pi payload and resolves compact citation handles", async () => {
    const observed: Array<{ readonly name: SessionToolName; readonly input: unknown }> = [];
    const citationDigest = "a".repeat(64);
    const definitionsList = definitions(async (name, input) => {
      observed.push({ name, input });
      if (name === "search_sessions") {
        return {
          ok: true,
          value: {
            query: "bounded",
            fragments: [
              {
                id: "history-1",
                kind: "trail",
                content: "é".repeat(1_000),
                provenance: ["database_row:messages:secret-source"],
                citation: {
                  citationDigest,
                  documentId: "document-1",
                  source: { kind: "database_row", table: "messages", rowId: "message-1" },
                  sessionIds: ["session-private"],
                  messageIds: ["message-1"],
                  sensitivity: "private",
                  provenanceRefs: [{ kind: "database_row", table: "messages", rowId: "message-1" }],
                  occurredAt: "2026-07-22T10:00:00.000Z",
                  excerptDigest: "b".repeat(64),
                  startOffset: 0,
                  endOffset: 1_000,
                  contentDigest: "c".repeat(64),
                },
                priority: 1,
                untrusted: true,
                sensitive: true,
              },
            ],
            hits: [{ fragmentId: "history-1", score: 1 }],
          },
        };
      }
      return { ok: true, value: { fragment: { content: "opened" } } };
    });
    const tools = createPiSessionToolRegistration({
      definitions: definitionsList,
      maxSerializedResultBytes: 320,
    });
    const search = tools.find((tool) => tool.name === "search_sessions");
    const open = tools.find((tool) => tool.name === "open_session_evidence");
    if (!search || !open) throw new Error("Expected session tools");
    const result = await search.execute("call-search", { query: "bounded" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(320);
    expect(text).toContain(citationDigest);
    expect(text).not.toContain("provenance");
    expect(text).not.toContain("session-private");
    await open.execute("call-open", { citationId: citationDigest, maxChars: 200 });
    expect(observed.at(-1)).toMatchObject({
      name: "open_session_evidence",
      input: { citation: { citationDigest }, maxChars: 200 },
    });
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
