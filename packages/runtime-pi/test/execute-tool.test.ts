import { sha256 } from "@noesis/domain";
import { describe, expect, test } from "vitest";
import { createPiExecuteTool, type PiMcpServerSummary, type PreparedPiCodeExecution } from "../src/index.ts";

const shellDescriptor = Object.freeze({
  name: "shell.run",
  label: "Run shell command",
  description: "Run one shell command.",
  revisionId: "shell-run-v1",
  inputSchema: Object.freeze({ type: "object" }),
  outputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      exitCode: Object.freeze({ anyOf: [{ type: "integer" }, { type: "null" }] }),
      signal: Object.freeze({ anyOf: [{ type: "string" }, { type: "null" }] }),
      output: Object.freeze({ type: "string" }),
      outputCharacterLength: Object.freeze({ type: "integer" }),
      truncated: Object.freeze({ type: "boolean" }),
      fullOutputPath: Object.freeze({ type: "string" }),
      fullOutputComplete: Object.freeze({ type: "boolean" }),
    }),
    required: Object.freeze([
      "exitCode",
      "signal",
      "output",
      "outputCharacterLength",
      "truncated",
      "fullOutputComplete",
    ]),
    additionalProperties: false,
  }),
});

function executeDescription(
  mcpServerSummaries?: readonly PiMcpServerSummary[],
  tools: PreparedPiCodeExecution["catalog"]["tools"] = Object.freeze([
    Object.freeze({
      name: "programs.list",
      label: "List Programs",
      description: "List Programs",
      revisionId: "programs-list-v1",
      inputSchema: Object.freeze({ type: "object" }),
      outputSchema: Object.freeze({ type: "array" }),
    }),
    shellDescriptor,
  ]),
): string {
  const preparedBase: PreparedPiCodeExecution = {
    catalog: Object.freeze({
      catalogId: "catalog-progressive-disclosure",
      catalogDigest: sha256("catalog-progressive-disclosure"),
      tools,
    }),
    execute: async () =>
      Object.freeze({ executionId: "execution-test", value: null, calls: 0, durationMs: 0 }),
    close: async () => undefined,
  };
  const prepared = Object.freeze(
    mcpServerSummaries === undefined ? preparedBase : { ...preparedBase, mcpServerSummaries },
  );
  return createPiExecuteTool({
    prepared,
    turnId: "turn-test",
    signal: new AbortController().signal,
    emit: () => undefined,
  }).description;
}

describe("execute progressive disclosure", () => {
  test("keeps its provider-facing descriptor byte-stable as catalogs and MCP servers change", () => {
    const servers = Array.from({ length: 80 }, (_, index) => ({
      name: index === 0 ? "docs<&" : `server-${String(index).padStart(3, "0")}`,
      tools: index,
      prompts: 2,
      resources: 3,
      resourceTemplates: 4,
    }));
    const changedCatalog = Object.freeze([
      Object.freeze({
        name: "mcp.docs.search",
        label: "Search docs",
        description: "A changed dynamic catalog tool",
        revisionId: "mcp-docs-search-v9",
        inputSchema: Object.freeze({ type: "object" }),
        outputSchema: Object.freeze({ type: "string" }),
      }),
      shellDescriptor,
    ]);
    const baseline = executeDescription();
    expect(executeDescription(servers, changedCatalog)).toBe(baseline);
    expect(baseline).toContain('tools.skills.load({ name: "execute" })');
    expect(baseline).toContain("Schema-derived shell.run result");
    expect(baseline).toContain("fullOutputPath?:string");
    expect(baseline).toContain("fullOutputComplete:boolean");
    expect(Buffer.byteLength(baseline, "utf8")).toBeLessThanOrEqual(1024);
    expect(baseline).not.toContain("docs<&");
  });

  test("keeps SDK and Program guidance progressively disclosed", () => {
    const description = executeDescription();
    expect(description).toContain("Load the `execute` skill");
    expect(description).not.toContain("programs.save");
    expect(description).not.toContain("agents.run");
    expect(description).not.toContain("noesis.search");
    expect(description).not.toContain("available_workflows");
  });
});
