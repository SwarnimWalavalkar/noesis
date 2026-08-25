import { sha256 } from "@noesis/domain";
import { describe, expect, test } from "vitest";
import { ScriptProgramManifestSchema, WorkflowProgramManifestSchema } from "../src/index.ts";

const createdFrom = Object.freeze({
  sessionId: "session-program-manifest",
  turnId: "turn-program-manifest",
  planId: "plan-program-manifest",
});

describe("Program manifests", () => {
  test("preserve large accepted Program definitions without hidden immutable-schema ceilings", () => {
    const requiredTools = Array.from({ length: 200 }, (_, index) => `tool.${String(index)}`);
    const phase = Object.freeze({
      name: "phase",
      description: "Run a large frozen dependency set.",
      source: "return input;",
      inputSchema: Object.freeze({}),
      outputSchema: Object.freeze({}),
      requiredTools,
    });

    expect(
      ScriptProgramManifestSchema.safeParse({
        kind: "noesis_program",
        mode: "script",
        name: "large-script",
        description: "A script with a large frozen dependency set.",
        revision: 1,
        sourceRevision: {
          kind: "file_revision",
          revisionId: "revision-large-script",
          workingPath: "programs/large-script.mjs",
          snapshotPath: ".noesis/revisions/revision-large-script",
          contentDigest: sha256("return input;"),
        },
        inputSchema: {},
        outputSchema: {},
        requiredTools,
        createdFrom,
      }).success,
    ).toBe(true);

    expect(
      WorkflowProgramManifestSchema.safeParse({
        kind: "noesis_program",
        mode: "workflow",
        name: "large-workflow",
        description: "A workflow with many phases.",
        revision: 1,
        inputSchema: {},
        outputSchema: {},
        phases: Array.from({ length: 65 }, (_, index) => ({
          ...phase,
          name: `phase-${String(index)}`,
        })),
        createdFrom,
      }).success,
    ).toBe(true);
  });
});
