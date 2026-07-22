import { describe, expect, test } from "vitest";
import { ToolBrokerRequestSchema, ToolBrokerResultSchema } from "../src/index.ts";

describe("adapter-neutral agent contracts", () => {
  test("validates generated-tool IPC without exposing an authority handle", () => {
    const request = ToolBrokerRequestSchema.parse({
      requestId: "request-1",
      operationId: "operation-1",
      toolName: "search_history",
      input: { query: "prior outcomes" },
    });
    const result = ToolBrokerResultSchema.parse({
      ok: true,
      requestId: request.requestId,
      output: { matches: 2 },
      evidenceRefs: ["evidence-1"],
    });

    expect(request).not.toHaveProperty("authority");
    expect(result).not.toHaveProperty("receipt");
  });
});
