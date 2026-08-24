import { fileURLToPath } from "node:url";
import type { PiBuiltInSkill } from "@noesis/runtime-pi";

export const NOESIS_BUILT_IN_SKILL: PiBuiltInSkill = Object.freeze({
  name: "noesis",
  aliases: Object.freeze(["refine"]),
  description:
    "Understand and deliberately refine Noesis's memory, Capabilities, skills, Programs, and harness.",
  filePath: fileURLToPath(new URL("../skills/noesis/SKILL.md", import.meta.url)),
  disableModelInvocation: false,
});

export const NOESIS_BUILT_IN_SKILLS = Object.freeze([NOESIS_BUILT_IN_SKILL]);
