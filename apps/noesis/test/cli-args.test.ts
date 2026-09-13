import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli-args.ts";

describe("CLI argument grammar", () => {
  test.each([
    {
      args: ["inspect", "--continue"],
      message: "--continue is available only with the tui command",
    },
    {
      args: ["inspect", "unexpected"],
      message: "Unexpected inspect argument unexpected",
    },
    { args: ["demo"], message: "Unknown command demo" },
    {
      args: ["config", "show", "unexpected"],
      message: "Unexpected config argument unexpected",
    },
    {
      args: ["config", "init", "--model", "not-allowed"],
      message: "--model is not valid for config init",
    },
    {
      args: ["auth", "status", "openrouter", "unexpected"],
      message: "Unexpected auth argument unexpected",
    },
    {
      args: ["rebuild", "--resume"],
      message: "--resume is available only with the tui command",
    },
    {
      args: ["inspect", "--trust-workspace"],
      message: "--trust-workspace is valid only for the tui or skills command",
    },
    {
      args: ["--continue", "--resume"],
      message: "--continue and --resume are mutually exclusive",
    },
    {
      args: ["--resume", "trail_exact", "--continue"],
      message: "--continue and --resume are mutually exclusive",
    },
    {
      args: ["--continue", "--continue"],
      message: "--continue may be specified only once",
    },
    {
      args: ["--continue=value"],
      message: "--continue does not accept a value",
    },
    {
      args: ["--continue", "trail_not_a_value"],
      message: "--continue does not accept a value or trailing operand",
    },
    {
      args: ["tui", "--continue", "--home", ".noesis", "trailing"],
      message: "Unexpected tui argument trailing",
    },
    {
      args: ["onboard", "unexpected"],
      message: "Unexpected onboard argument unexpected",
    },
    {
      args: ["help", "unexpected"],
      message: "Unexpected help argument unexpected",
    },
  ])("rejects malformed non-TUI arguments: $message", ({ args, message }) => {
    expect(() => parseArgs(args)).toThrow(message);
  });
});
