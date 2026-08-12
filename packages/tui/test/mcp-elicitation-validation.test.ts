import { describe, expect, test } from "vitest";
import {
  validateMcpMultiselectField,
  validateMcpNumberField,
  validateMcpTextField,
} from "../src/mcp-elicitation-validation.ts";

describe("MCP elicitation validation", () => {
  test("validates string length and the supported formats", () => {
    expect(validateMcpTextField({ type: "text", name: "code", label: "Code", minLength: 3 }, "ab")).toContain(
      "at least 3",
    );
    expect(
      validateMcpTextField({ type: "text", name: "code", label: "Code", maxLength: 3 }, "abcd"),
    ).toContain("at most 3");
    for (const [format, valid, invalid] of [
      ["date", "2026-08-12", "2026-02-30"],
      ["date-time", "2026-08-12T10:30:00Z", "2026-08-12T10:30Z"],
      ["email", "user@example.com", "user@example"],
      ["uri", "https://example.com/path", "not a uri"],
    ] as const) {
      expect(validateMcpTextField({ type: "text", name: "value", label: "Value", format }, valid)).toBe(
        undefined,
      );
      expect(
        validateMcpTextField({ type: "text", name: "value", label: "Value", format }, invalid),
      ).toContain(`valid ${format}`);
    }
    expect(
      validateMcpTextField(
        { type: "text", name: "value", label: "Value", format: "date-time" },
        "2026-08-12T23:59:60+05:30",
      ),
    ).toBe(undefined);
    for (const invalid of ["https://example.com/%zz", "https://example.com/a b", "//example.com"]) {
      expect(
        validateMcpTextField({ type: "text", name: "value", label: "Value", format: "uri" }, invalid),
      ).toContain("valid uri");
    }
    expect(
      validateMcpTextField(
        { type: "text", name: "value", label: "Value", format: "uri" },
        "urn:isbn:0451450523",
      ),
    ).toBe(undefined);
  });

  test("validates integer and numeric bounds", () => {
    const field = {
      type: "number" as const,
      name: "count",
      label: "Count",
      integer: true,
      minimum: 2,
      maximum: 4,
    };
    expect(validateMcpNumberField(field, 2.5)).toContain("integer");
    expect(validateMcpNumberField(field, 1)).toContain("at least 2");
    expect(validateMcpNumberField(field, 5)).toContain("at most 4");
    expect(validateMcpNumberField(field, 3)).toBe(undefined);
  });

  test("validates multi-select bounds", () => {
    const field = {
      type: "multiselect" as const,
      name: "labels",
      label: "Labels",
      choices: [],
      minItems: 2,
      maxItems: 3,
    };
    expect(validateMcpMultiselectField(field, 1)).toContain("at least 2 choices");
    expect(validateMcpMultiselectField(field, 4)).toContain("at most 3 choices");
    expect(validateMcpMultiselectField(field, 2)).toBe(undefined);
  });
});
