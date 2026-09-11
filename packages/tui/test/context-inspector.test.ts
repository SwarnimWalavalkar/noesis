import { describe, expect, test, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentContextInspection } from "@noesis/agent-types";
import {
  contextMap,
  renderContextOverview,
  renderContextDetails,
  renderContextTools,
  renderContextSkills,
} from "../src/context-inspector.ts";
import { createPiAgentRuntime, formatSkillsForNoesisPrompt } from "@noesis/runtime-pi";
import {
  createControlledPiModels,
  CONTROLLED_PI_PROVIDER,
  CONTROLLED_PI_MODEL,
} from "../../runtime-pi/test/support/controlled-pi-models.ts";
import { startNoesisTui } from "../src/index.ts";
import { createInMemoryTestRuntime } from "./support/in-memory-runtime.ts";
import { createTestTerminal } from "./support/test-terminal.ts";
import { requestContextComponents } from "../../runtime-pi/src/context-inspection.ts";

const largeCatalog = formatSkillsForNoesisPrompt(
  Array.from({ length: 60 }, (_, index) => ({
    name: `review-${index}`,
    description: 'Review <code> & "tests". '.repeat(20),
    disableModelInvocation: false,
  })),
  true,
);
const resumedCatalog = `${largeCatalog.slice(0, 16000)}\n[Preview truncated; count includes full content.]`;

const snapshot: AgentContextInspection = {
  source: "request",
  capturedAt: "2026-09-06T10:00:00Z",
  provider: "test",
  model: "model",
  contextWindow: 200000,
  inputBudget: 160000,
  outputReserve: 32000,
  components: [
    { label: "System", tokens: 1000, content: "System prompt" },
    {
      label: "Tools",
      tokens: 3000,
      content: JSON.stringify([
        { name: "shell", description: "Run a command.", parameters: { type: "object" } },
      ]),
    },
    { label: "Skill catalog", tokens: 16000, content: resumedCatalog },
  ],
  note: "Token counts are estimates.",
};

describe("context visualization", () => {
  test("renders the real skill catalog with decoded text and bounded colored rows", () => {
    const content = formatSkillsForNoesisPrompt(
      [
        {
          name: "review",
          description: 'Review <code> & "tests".\nKeep &lt; literal.',
          disableModelInvocation: false,
        },
        { name: "write", description: "Write clearly.", disableModelInvocation: false },
      ],
      true,
    );
    const rendered = renderContextSkills(content, 100, false).join("\n");
    expect(rendered).toContain('review\nReview <code> & "tests".\nKeep &lt; literal.');
    expect(rendered).toContain("\n\nwrite\nWrite clearly.");
    expect(rendered).toContain("tools.skills.load");
    expect(rendered).not.toContain("<available_skills>");
    for (const width of [12, 40, 80]) {
      for (const row of renderContextSkills(content, width, true))
        expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    }
    for (const fallback of [content.replaceAll("</name>", "</unknown>"), "Unrecognized catalog"]) {
      expect(renderContextSkills(fallback, 1000, false).join("\n")).toBe(fallback);
    }
  });
  test("formats complete entries in bounded request and resume previews without losing the tail", () => {
    const captured = requestContextComponents({
      systemPrompt: "",
      skillsPrompt: largeCatalog,
      tools: "",
      messages: [],
    });
    const requestCatalog = captured.find((part) => part.label === "Skill catalog")?.content ?? "";
    expect(largeCatalog.length).toBeGreaterThan(16000);
    for (const content of [resumedCatalog, requestCatalog]) {
      const rendered = renderContextSkills(content, 100, false).join("\n");
      expect(rendered).toContain('review-0\nReview <code> & "tests".');
      expect(rendered).not.toContain("<available_skills>");
      expect(rendered).not.toContain("<name>review-0</name>");
      const tail = content.slice(content.lastIndexOf("</skill>") + "</skill>".length).trim();
      expect(renderContextSkills(content, 100000, false).join("\n")).toContain(tail);
      expect(rendered).toContain("truncated");
    }
    const unfamiliar = largeCatalog.replace("</skill>", "</skill>\n<unknown>Keep me</unknown>");
    expect(renderContextSkills(unfamiliar, 100, false).join("\n")).toContain("<unknown>Keep me</unknown>");
  });
  test("renders captured tools readably and preserves nested schemas on demand", () => {
    const content = JSON.stringify([
      {
        name: "file_write",
        description: "Write a file.\nSupports exact replacements.",
        parameters: {
          anyOf: [{ type: "object", required: ["path"], properties: { path: { type: "string" } } }],
        },
      },
      { name: "shell", description: "Run a command.", parameters: { type: "object" } },
    ]);
    const collapsed = renderContextTools(content, 80, false, false).join("\n");
    expect(collapsed).toContain("file_write\nWrite a file.");
    expect(collapsed).toContain("\n\nshell\n");
    expect(collapsed).not.toContain("anyOf");
    const expanded = renderContextTools(content, 80, false, true).join("\n");
    expect(expanded).toContain('  "anyOf": [');
    expect(expanded).toContain('"required": [');
    expect(expanded).toContain('"path"');
    for (const width of [12, 40, 80]) {
      for (const line of renderContextTools(content, width, true, true)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
  test("keeps malformed and truncated previews available without crashing", () => {
    for (const content of ['[{"name":', "[null]", '{"unknown":true}', "[]\n[Inspection preview truncated]"]) {
      expect(renderContextTools(content, 80, false, false).join("\n")).toBe(content);
    }
  });
  test("opens through the real TUI, drills into content, and returns focus to the composer", async () => {
    const controlled = createControlledPiModels();
    const runtime = {
      ...createInMemoryTestRuntime(createPiAgentRuntime(process.cwd(), controlled.models)),
      inspectContext: async () => ({
        ...snapshot,
        components: [...snapshot.components, { label: "Empty checkpoint", tokens: 0, content: "" }],
      }),
    };
    const terminal = createTestTerminal();
    const running = startNoesisTui(
      runtime,
      { provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL },
      terminal,
    );
    await vi.waitFor(() => expect(terminal.output).toContain("● IDLE"));
    terminal.type("/context\r");
    await vi.waitFor(() => expect(terminal.output).toContain("cache hit rate"));
    terminal.send("\u001b[B");
    terminal.send("\u001b[B");
    terminal.send("\u001b[B");
    terminal.send("\r");
    await vi.waitFor(() => expect(terminal.output).toContain("Empty checkpoint"));
    terminal.send("\u001b[A");
    terminal.send("\r");
    await vi.waitFor(() => expect(terminal.output).toContain("No material in this component."));
    terminal.send("\u001b");
    terminal.send("\u001b[A");
    terminal.send("\u001b[A");
    terminal.send("\u001b[A");
    terminal.send("?");
    await vi.waitFor(() => expect(terminal.output).toContain("LAST REQUEST CACHE"));
    terminal.send("\u001b");
    terminal.send("\r");
    await vi.waitFor(() => expect(terminal.output).toContain("System prompt"));
    terminal.send("\u001b");
    terminal.send("\u001b[B");
    terminal.send("\r");
    await vi.waitFor(() => expect(terminal.output).toContain("Parameters · hidden"));
    terminal.send("s");
    await vi.waitFor(() => expect(terminal.output).toContain('"type": "object"'));
    terminal.send("s");
    await vi.waitFor(() => expect(terminal.output).toContain("s show schemas"));
    terminal.send("\u001b");
    terminal.send("\u001b[B");
    terminal.send("\r");
    await vi.waitFor(() => expect(terminal.output).toContain("CONTEXT / Skill catalog"));
    await vi.waitFor(() => expect(terminal.output).toContain('Review <code> & "tests".'));
    expect(terminal.output).not.toContain("<name>review-0</name>");
    terminal.resize(40, 16);
    terminal.send("\u001b");
    terminal.send("\u001b");
    terminal.type("/quit\r");
    await running;
  });
  test("uses proportional cells without inflating tiny segments", () => {
    const cells = contextMap([1000, 3000, 16000], 100);
    expect(cells.filter((cell) => cell === 0)).toHaveLength(5);
    expect(cells.filter((cell) => cell === 1)).toHaveLength(15);
    expect(cells.filter((cell) => cell === 2)).toHaveLength(80);
    expect(contextMap([0, 0], 100)).toEqual([]);
    expect(contextMap([1], 0)).toEqual([]);
  });
  test("keeps the overview compact and puts accounting behind details", () => {
    const text = renderContextOverview(snapshot, 100, false).join("\n");
    expect(text).toContain("~20k / 160k tokens · 13% used · — cache hit rate");
    expect(text).toContain("Last request");
    expect(text).not.toContain("Output reserve");
    const details = renderContextDetails(snapshot, 100).join("\n");
    expect(details).toContain("200,000 tokens");
    expect(details).toContain("140,000 tokens");
    expect(details).toContain("32,000 tokens");
    expect(text).not.toContain("\u001b");
  });
  test("keeps every overview row within the requested display width with color", () => {
    for (const width of [12, 40, 80, 130]) {
      const rows = renderContextOverview(snapshot, width, true);
      for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      expect(rows.some((row) => row.includes("█") && visibleWidth(row) === width)).toBe(true);
    }
  });
  test("labels previews and exposes overflow instead of negative free space", () => {
    const text = renderContextOverview({ ...snapshot, source: "preview", inputBudget: 10 }, 80, false).join(
      "\n",
    );
    expect(text).toContain("Startup / resume preview");
    expect(text).toContain("exceeds the input budget");
  });
  test("collapses empty sections without losing their inspectable content", () => {
    const withEmpty = {
      ...snapshot,
      components: [...snapshot.components, { label: "Checkpoint", tokens: 0, content: "" }],
    };
    expect(renderContextOverview(withEmpty, 80, false).join("\n")).toContain("▸ 1 empty section");
    expect(renderContextOverview(withEmpty, 80, false).join("\n")).not.toContain("Checkpoint");
    expect(renderContextOverview(withEmpty, 80, false, 3, true).join("\n")).toContain("› Checkpoint");
  });
  test("uses last-request token accounting, not the estimated component total", () => {
    const cached = { ...snapshot, cache: { inputTokens: 10000, readTokens: 9200, writeTokens: 500 } };
    expect(renderContextOverview(cached, 80, false).join("\n")).toContain("92% cache hit rate");
    expect(renderContextDetails(cached, 100).join("\n")).toContain("Uncached input    300 tokens");
    expect(
      renderContextOverview({ ...cached, cache: { ...cached.cache, readTokens: 0 } }, 80, false).join("\n"),
    ).toContain("0% cache hit rate");
  });
});
