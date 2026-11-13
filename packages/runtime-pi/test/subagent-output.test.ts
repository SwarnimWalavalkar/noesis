import { expect, test } from "vitest";
import { compileSubAgentOutput, decodeSubAgentOutput } from "../src/subagent-output.ts";

test("two copies of a schema with the same $id both compile and validate", () => {
  const schema = {
    $id: "https://example.com/judgment",
    type: "object",
    properties: { safe: { type: "boolean" } },
    required: ["safe"],
  };
  compileSubAgentOutput(schema);
  expect(decodeSubAgentOutput('{"safe":true}', structuredClone(schema))).toEqual({ safe: true });
});

test("an asynchronous schema is rejected at admission", () => {
  expect(() => compileSubAgentOutput({ $async: true, type: "string" })).toThrow(/\$async/u);
});
