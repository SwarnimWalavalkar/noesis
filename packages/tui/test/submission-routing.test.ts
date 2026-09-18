import { describe, expect, test } from "vitest";
import { NOESIS_SLASH_COMMANDS } from "../src/command-autocomplete.ts";
import { routeSubmission } from "../src/submission-routing.ts";

describe("submission routing", () => {
  test.each([
    "  /not-a-command explain this  ",
    "/tmp/report.txt",
    "/helpful",
    "/help explain this command",
    "/help\nexplain this command",
    "Explain /help and /steer",
    "A message\n/quit",
    "`/quit`",
    "/skill:help explain this",
    "/refine improve this",
    "  /learning",
  ])("leaves prompt or skill text to the runtime: %j", (text) => {
    expect(routeSubmission(text)).toEqual({ kind: "prompt" });
  });

  test.each(NOESIS_SLASH_COMMANDS)("recognizes advertised command /$name", ({ name }) => {
    expect(routeSubmission(`/${name}`).kind).not.toBe("prompt");
  });
});
