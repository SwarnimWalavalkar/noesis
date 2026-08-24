import { fileURLToPath } from "node:url";
import type { PiBuiltInSkill } from "@noesis/runtime-pi";

export const NOESIS_BUILT_IN_SKILL: PiBuiltInSkill = Object.freeze({
  name: "noesis",
  aliases: Object.freeze(["refine"]),
  description:
    "Inspect and deliberately refine Noesis's lasting Capabilities, skills, and harness. Use for self-improvement, learned behavior, feedback, scope, activation, or restoration.",
  filePath: fileURLToPath(new URL("../skills/noesis/SKILL.md", import.meta.url)),
  disableModelInvocation: false,
});

export const EXECUTE_BUILT_IN_SKILL: PiBuiltInSkill = Object.freeze({
  name: "execute",
  description:
    "Compose multi-call work through Noesis Code Mode and its injected SDK. Use for tool discovery, session analysis, subagents, MCP access, or authoring and running Programs.",
  filePath: fileURLToPath(new URL("../skills/execute/SKILL.md", import.meta.url)),
  disableModelInvocation: false,
});

export const NOESIS_BUILT_IN_SKILLS = Object.freeze([EXECUTE_BUILT_IN_SKILL, NOESIS_BUILT_IN_SKILL]);
