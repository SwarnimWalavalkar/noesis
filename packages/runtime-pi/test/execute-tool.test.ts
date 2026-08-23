import { createConditionalObject, sha256 } from "@noesis/domain";
import { describe, expect, test } from "vitest";
import {
  createPiExecuteTool,
  type PiMcpServerSummary,
  type PiWorkflowSummary,
  type PreparedPiCodeExecution,
} from "../src/index.ts";
function executeDescription(
  workflowSummaries?: readonly PiWorkflowSummary[],
  mcpServerSummaries?: readonly PiMcpServerSummary[],
): string {
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  const prepared: PreparedPiCodeExecution = createConditionalObject({
    catalog: Object.freeze({
      catalogId: "catalog-workflow-index",
      catalogDigest: sha256("catalog-workflow-index"),
      tools: Object.freeze([]),
    }),
  } as const)
    .addOptional(workflowSummaries ? { workflowSummaries } : undefined)
    .addOptional(mcpServerSummaries ? { mcpServerSummaries } : undefined)
    .add({
      execute: async () =>
        Object.freeze({
          executionId: "execution-workflow-index",
          value: null,
          calls: 0,
          durationMs: 0,
        }),
      close: async () => undefined,
    } as const)
    .finish();
  return createPiExecuteTool({
    prepared,
    turnId: "turn-workflow-index",
    signal: new AbortController().signal,
    emit: () => undefined,
  }).description;
}
function workflowIndexFrom(description: string): string {
  const start = description.indexOf("<available_workflows>");
  const end = description.indexOf(" Use store(key, value)", start);
  if (start < 0 || end < 0) throw new Error("Execute description has no workflow index");
  return description.slice(start, end);
}
describe("execute workflow discovery index", () => {
  test("shows a bounded escaped MCP capability summary without server instructions", () => {
    const servers = Array.from({ length: 80 }, (_, index) => ({
      name: index === 0 ? "docs<&" : `server-${String(index).padStart(3, "0")}`,
      tools: index,
      prompts: 2,
      resources: 3,
      resourceTemplates: 4,
    }));
    const description = executeDescription([], servers);
    const start = description.indexOf("<available_mcp_servers>");
    const end = description.indexOf(" Use store(key, value)", start);
    const index = description.slice(start, end);
    expect(index).toContain("docs&lt;&amp; (0 tools, 2 prompts, 3 resources, 4 templates)");
    expect(index).toContain("mcp.servers");
    expect(index).toContain("mcp.inspect");
    expect(index).toContain("noesis.search");
    expect(index).toContain("More servers are available");
    expect(new TextEncoder().encode(index).byteLength).toBeLessThanOrEqual(4 * 1024);
  });
  test("shows compact frozen workflow metadata with progressive-disclosure guidance", () => {
    const description = executeDescription([
      Object.freeze({
        name: "research-brief",
        description: "Research a topic and write a brief.",
        toolName: "workflow.0123456789abcdef.research-brief",
      }),
    ]);
    expect(description).toContain(
      "<available_workflows>research-brief [tool: workflow.0123456789abcdef.research-brief] — Research a topic and write a brief.</available_workflows>",
    );
    expect(description).toContain("exact listed tool name with adapt for project-safe hotbar pinning");
    expect(description).toContain("`workflows.run` is the generic runner");
    expect(description).toContain("tools.workflows.describe({ name })");
    expect(description).not.toContain("workflows.list");
  });
  test("normalizes each entry to one escaped line and sorts deterministically", () => {
    const description = executeDescription([
      Object.freeze({
        name: "zeta",
        description: "Second\n\tworkflow",
        toolName: "workflow.0123456789abcdef.zeta",
      }),
      Object.freeze({
        name: "alpha<&\"'",
        description: " First   <workflow> & its contract ",
        toolName: "workflow.0123456789abcdef.alpha<&\"'",
      }),
    ]);
    const index = workflowIndexFrom(description);
    expect(index).toContain(
      "alpha&lt;&amp;&quot;&apos; [tool: workflow.0123456789abcdef.alpha&lt;&amp;&quot;&apos;] — First &lt;workflow&gt; &amp; its contract; zeta [tool: workflow.0123456789abcdef.zeta] — Second workflow",
    );
    expect(index).not.toContain("\n");
    expect(index).not.toContain("\t");
  });
  test("bounds descriptions, entry count, and the complete index", () => {
    const summaries = Array.from({ length: 80 }, (_, index) =>
      Object.freeze({
        name: `workflow-${String(index).padStart(3, "0")}`,
        description: `${"😀<&".repeat(200)} ${String(index)}`,
        toolName: `workflow.0123456789abcdef.workflow-${String(index).padStart(3, "0")}`,
      }),
    );
    const index = workflowIndexFrom(executeDescription(summaries));
    const listedEntries = index.match(/workflow-\d{3} \[tool:/gu) ?? [];
    const singleIndex = workflowIndexFrom(
      executeDescription([
        Object.freeze({
          name: "bounded-description",
          description: "😀".repeat(200),
          toolName: "workflow.0123456789abcdef.bounded-description",
        }),
      ]),
    );
    const boundedDescription = /\] — (.*)<\/available_workflows>/u.exec(singleIndex)?.[1];
    if (!boundedDescription) throw new Error("Expected the bounded workflow description");
    expect(listedEntries.length).toBeLessThanOrEqual(32);
    expect(listedEntries.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(boundedDescription).byteLength).toBeLessThanOrEqual(192);
    expect(new TextEncoder().encode(index).byteLength).toBeLessThanOrEqual(4 * 1024);
    expect(index).toContain("More saved workflows are available; use workflows.list");
    expect(index).toContain("…");
  });
  test("omits the index when the frozen turn has no saved workflows", () => {
    expect(executeDescription()).not.toContain("available_workflows");
    expect(executeDescription([])).not.toContain("available_workflows");
  });
});
