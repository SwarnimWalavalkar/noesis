import { canonicalJson, sha256 } from "@noesis/domain";
import type { ScriptProgramManifest } from "@noesis/agent-types";
import { expect, test } from "vitest";
import {
  createTurnProgramLibrary,
  GLOBAL_PROGRAM_OWNER,
  programDefinitionScope,
  projectProgramOwner,
  type StoredScriptProgram,
} from "../src/program-library.ts";

const project = Object.freeze({ projectId: "project_a", root: "/work/a" });
const projectOwner = projectProgramOwner(project);
function script(
  name: string,
  owner: StoredScriptProgram["owner"],
  revisionId: string,
  revision = 1,
): StoredScriptProgram {
  const file = (id: string) =>
    Object.freeze({
      kind: "file_revision" as const,
      revisionId: id,
      workingPath: `w/${id}`,
      snapshotPath: `s/${id}`,
      contentDigest: sha256(id),
    });
  const manifest: ScriptProgramManifest = Object.freeze({
    kind: "noesis_program",
    mode: "script",
    name,
    description: "d",
    revision,
    sourceRevision: file(`${revisionId}-source`),
    inputSchema: {},
    outputSchema: {},
    requiredTools: [],
    createdFrom: { sessionId: "s", turnId: "t", planId: "p" },
  });
  return Object.freeze({ manifest, definitionRevision: file(revisionId), owner });
}

test("stores global Programs beside the project roots", () => {
  expect(programDefinitionScope("script", GLOBAL_PROGRAM_OWNER)).toEqual({
    namespace: "program:global:script",
    workingRoot: "programs/global/script",
  });
  expect(programDefinitionScope("workflow", projectOwner)).toEqual({
    namespace: "program:project_a:workflow",
    workingRoot: "programs/projects/project_a/workflow",
  });
});

test("a name resolves project first, keeps both visible, and stays frozen for the turn", () => {
  const library = createTurnProgramLibrary({
    scripts: [
      script("shared", GLOBAL_PROGRAM_OWNER, "global-1"),
      script("shared", projectOwner, "project-1"),
      script("only-global", GLOBAL_PROGRAM_OWNER, "only-global-1"),
    ],
    workflows: [],
  });
  expect(library.script("shared")?.definitionRevision.revisionId).toBe("project-1");
  expect(library.script("shared", { scope: "global" })?.definitionRevision.revisionId).toBe("global-1");
  expect(library.script("only-global")?.definitionRevision.revisionId).toBe("only-global-1");
  expect(library.script("only-global", { scope: "project" })).toBeUndefined();
  expect(library.isShadowed("script", GLOBAL_PROGRAM_OWNER, "shared")).toBe(true);
  expect(library.isShadowed("script", GLOBAL_PROGRAM_OWNER, "only-global")).toBe(false);
  expect(library.isShadowed("script", projectOwner, "shared")).toBe(false);
  expect(library.scripts()).toHaveLength(3);

  // A save in this turn takes effect; the library holds no reference to anything else that changes.
  library.recordScript(script("only-global", projectOwner, "new-project"));
  expect(library.script("only-global")?.definitionRevision.revisionId).toBe("new-project");
});

test("the workflow pin keeps its earlier digest until a global Program is visible", () => {
  const local = script("local", projectOwner, "local-1");
  const library = createTurnProgramLibrary({ scripts: [local], workflows: [] });
  const earlier = sha256(
    canonicalJson({
      scripts: [
        {
          name: "local",
          revision: 1,
          sourceRevisionId: local.manifest.sourceRevision.revisionId,
          sourceDigest: local.manifest.sourceRevision.contentDigest,
        },
      ],
      workflows: [],
    }),
  );
  expect(library.dependenciesDigest()).toBe(earlier);
  library.recordScript(script("shared", GLOBAL_PROGRAM_OWNER, "shared-1"));
  expect(library.dependenciesDigest()).not.toBe(earlier);
});
