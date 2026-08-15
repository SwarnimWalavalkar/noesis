import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { estimateInputTokens } from "@noesis/agent-types";
import { describe, expect, test } from "vitest";
import { createPiRequestBudgetProjector } from "../src/context-budget.ts";

const usage = (totalTokens: number) => ({
  input: totalTokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

describe("Pi request token budgeting", () => {
  test("uses a portable four-byte estimate before provider usage exists", () => {
    expect(estimateInputTokens("a".repeat(400))).toBe(100);
    expect(estimateInputTokens("界".repeat(4))).toBe(3);
  });

  test("uses provider-reported usage and estimates only the trailing tool result", () => {
    const reported = {
      ...fauxAssistantMessage("Calling the tool.", { stopReason: "toolUse" }),
      usage: usage(12_000),
    };
    const messages: AgentMessage[] = [
      { role: "user", content: "Find evidence.", timestamp: 1 },
      reported,
      {
        role: "toolResult",
        toolCallId: "call-reported",
        toolName: "search",
        content: [{ type: "text", text: "x".repeat(4_000) }],
        isError: false,
        timestamp: 2,
      },
    ];

    const result = createPiRequestBudgetProjector().project({
      messages,
      systemPrompt: "System",
      activeToolMaterial: "[]",
      activeToolCount: 0,
      tokenBudget: 20_000,
      planId: "plan-reported",
    });

    expect(result.providerReportedTokens).toBe(12_000);
    expect(result.trailingEstimatedTokens).toBe(1_000);
    expect(result.projectedToolResults).toBe(0);
    expect(result.estimatedTokens).toBeLessThan(14_000);
  });

  test("does not add fixed request material to authoritative provider usage twice", () => {
    const reported = {
      ...fauxAssistantMessage("The provider accepted the complete request."),
      usage: usage(145_000),
    };
    const result = createPiRequestBudgetProjector().project({
      messages: [{ role: "user", content: "Continue.", timestamp: 1 }, reported],
      systemPrompt: "system".repeat(4_000),
      activeToolMaterial: "schema".repeat(8_000),
      activeToolCount: 12,
      tokenBudget: 160_000,
      planId: "plan-authoritative-provider-usage",
    });

    expect(result.providerReportedTokens).toBe(145_000);
    expect(result.fixedTokens).toBeGreaterThan(10_000);
    expect(result.estimatedTokens).toBe(145_000);
  });

  test("projects older tool results only in the model request while retaining trace identity", () => {
    const first = "alpha".repeat(8_000);
    const second = "beta".repeat(10_000);
    const messages: AgentMessage[] = [
      { role: "user", content: "Research this.", timestamp: 1 },
      fauxAssistantMessage(
        [
          fauxToolCall("search", { query: "alpha" }, { id: "call-alpha" }),
          fauxToolCall("search", { query: "beta" }, { id: "call-beta" }),
        ],
        { stopReason: "toolUse" },
      ),
      {
        role: "toolResult",
        toolCallId: "call-alpha",
        toolName: "search",
        content: [{ type: "text", text: first }],
        isError: false,
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-beta",
        toolName: "search",
        content: [{ type: "text", text: second }],
        isError: false,
        timestamp: 3,
      },
    ];

    const result = createPiRequestBudgetProjector().project({
      messages,
      systemPrompt: "System",
      activeToolMaterial: "[]",
      activeToolCount: 0,
      tokenBudget: 2_000,
      planId: "plan-projected",
    });

    expect(result.projectedToolResults).toBe(2);
    expect(result.estimatedTokens).toBeLessThanOrEqual(2_000);
    expect(result.messages[2]).toMatchObject({ role: "toolResult", toolCallId: "call-alpha" });
    expect(JSON.stringify(result.messages[2])).toContain(
      "Full result remains in the durable tool-call trace",
    );
    expect(JSON.stringify(result.messages[3])).toContain("call-beta");
    const original = messages[2];
    if (!original || original.role !== "toolResult" || original.content[0]?.type !== "text")
      throw new Error("Expected the original text tool result");
    expect(original.content[0].text).toBe(first);
  });

  test("returns to authoritative provider usage after a projected request completes", () => {
    const projector = createPiRequestBudgetProjector();
    const toolResult = {
      role: "toolResult" as const,
      toolCallId: "call-large",
      toolName: "search",
      content: [{ type: "text" as const, text: "result".repeat(4_000) }],
      isError: false,
      timestamp: 2,
    };
    const firstMessages: AgentMessage[] = [
      { role: "user", content: "Search.", timestamp: 1 },
      { ...fauxAssistantMessage("Searching.", { stopReason: "toolUse" }), usage: usage(2_000) },
      toolResult,
    ];
    const first = projector.project({
      messages: firstMessages,
      systemPrompt: "System",
      activeToolMaterial: "[]",
      activeToolCount: 0,
      tokenBudget: 3_000,
      planId: "plan-first-projection",
    });
    expect(first.projectedToolResults).toBe(1);
    expect(first.providerReportedTokens).toBe(2_000);

    const second = projector.project({
      messages: [...firstMessages, { ...fauxAssistantMessage("The result is ready."), usage: usage(900) }],
      systemPrompt: "System",
      activeToolMaterial: "[]",
      activeToolCount: 0,
      tokenBudget: 3_000,
      planId: "plan-provider-reset",
    });

    expect(second.providerReportedTokens).toBe(900);
    expect(second.projectedToolResults).toBe(1);
    expect(second.estimatedTokens).toBeLessThan(1_100);
    expect(JSON.stringify(second.messages[2])).toContain("call-large");
  });

  test("reports the complete estimate when non-tool material still cannot fit", () => {
    expect(() =>
      createPiRequestBudgetProjector().project({
        messages: [{ role: "user", content: "request", timestamp: 1 }],
        systemPrompt: "system".repeat(10_000),
        activeToolMaterial: "[]",
        activeToolCount: 0,
        tokenBudget: 100,
        planId: "plan-diagnostic",
      }),
    ).toThrow(/estimated=.+budget=100.+fixed=.+projectedToolResults=0/u);
  });
});
