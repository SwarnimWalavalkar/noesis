import { JsonValueSchema, schemaSignature, toJsonValue } from "../src/index.ts";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const signature = (schema: z.ZodType) =>
  schemaSignature(toJsonValue(z.toJSONSchema(schema, { unrepresentable: "any" })));

describe("schemaSignature", () => {
  it("renders optional, nullable, enum, array, and record fields as a compact type", () => {
    expect(
      signature(
        z.strictObject({
          agent: z
            .strictObject({
              provider: z.string().nullable().optional(),
              thinkingLevel: z.enum(["low", "high"]).nullable().optional(),
            })
            .optional(),
          tags: z.array(z.union([z.string(), z.number()])),
          counts: z.record(z.string(), z.number()),
          "odd-key": z.literal(1),
        }),
      ),
    ).toBe(
      '{ agent?: { provider?: string | null; thinkingLevel?: "low" | "high" | null }; tags: (string | number)[]; counts: Record<string, number>; "odd-key": 1 }',
    );
  });
  it("names the recursive JSON value schema instead of expanding it", () => {
    expect(signature(JsonValueSchema)).toBe("JSON");
    expect(signature(z.strictObject({ stored: JsonValueSchema }))).toBe("{ stored: JSON }");
  });
  it("keeps the shape of other recursive schemas and bounds mutual recursion", () => {
    const tree = {
      $defs: {
        node: {
          type: "object",
          properties: {
            label: { type: "string" },
            children: { type: "array", items: { $ref: "#/$defs/node" } },
          },
          required: ["label"],
        },
      },
      $ref: "#/$defs/node",
    };
    expect(schemaSignature(tree)).toBe("{ label: string; children?: (recursive)[] }");
    const mutual = {
      $defs: {
        a: { type: "object", properties: { b: { $ref: "#/$defs/b" } } },
        b: { type: "object", properties: { a: { $ref: "#/$defs/a" } } },
      },
      $ref: "#/$defs/a",
    };
    expect(schemaSignature(mutual)).toBe("{ b?: { a?: (recursive) } }");
  });
});
