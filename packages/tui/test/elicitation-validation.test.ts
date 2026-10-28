import { describe, expect, test } from "vitest";
import {
  validateMultiselectField,
  validateNumberField,
  validateTextField,
} from "../src/elicitation-validation.ts";

describe("elicitation field validation", () => {
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test("validates string length and the supported formats", () => {
    expect(validateTextField({ type: "text", name: "code", label: "Code", minLength: 3 }, "ab")).toContain(
      "at least 3",
    );
    expect(validateTextField({ type: "text", name: "code", label: "Code", maxLength: 3 }, "abcd")).toContain(
      "at most 3",
    );
    for (const [format, valid, invalid] of [
      ["date", "2026-08-12", "2026-02-30"],
      ["date-time", "2026-08-12T10:30:00Z", "2026-08-12T10:30Z"],
      ["email", "user@example.com", "user@example"],
      ["uri", "https://example.com/path", "not a uri"],
    ] as const) {
      expect(validateTextField({ type: "text", name: "value", label: "Value", format }, valid)).toBe(
        undefined,
      );
      expect(validateTextField({ type: "text", name: "value", label: "Value", format }, invalid)).toContain(
        `valid ${format}`,
      );
    }
    expect(
      validateTextField(
        { type: "text", name: "value", label: "Value", format: "date-time" },
        "2026-08-12T23:59:60+05:30",
      ),
    ).toBe(undefined);
    for (const invalid of ["https://example.com/%zz", "https://example.com/a b", "//example.com"]) {
      expect(
        validateTextField({ type: "text", name: "value", label: "Value", format: "uri" }, invalid),
      ).toContain("valid uri");
    }
    expect(
      validateTextField(
        { type: "text", name: "value", label: "Value", format: "uri" },
        "urn:isbn:0451450523",
      ),
    ).toBe(undefined);
  });

  test("validates integer and numeric bounds", () => {
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const field = {
      type: "number" as const,
      name: "count",
      label: "Count",
      integer: true,
      minimum: 2,
      maximum: 4,
    };
    expect(validateNumberField(field, 2.5)).toContain("integer");
    expect(validateNumberField(field, 1)).toContain("at least 2");
    expect(validateNumberField(field, 5)).toContain("at most 4");
    expect(validateNumberField(field, 3)).toBe(undefined);
  });

  test("validates multi-select bounds", () => {
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const field = {
      type: "multiselect" as const,
      name: "labels",
      label: "Labels",
      choices: [],
      minItems: 2,
      maxItems: 3,
    };
    expect(validateMultiselectField(field, 1)).toContain("at least 2 choices");
    expect(validateMultiselectField(field, 4)).toContain("at most 3 choices");
    expect(validateMultiselectField(field, 2)).toBe(undefined);
  });
});
