import { formatSkillInvocation, type Skill } from "@earendil-works/pi-agent-core";
import { type JsonValue, toJsonValue } from "@noesis/domain";
import { toAgentActionPayload } from "./action-payload.ts";
import type { PiSkillResource } from "./skill-library.ts";

export interface ResolvedPiSkillInvocation {
  readonly name: string;
  readonly prompt: string;
  readonly evidence: JsonValue;
  readonly actionEvidence: JsonValue;
}

function actionEvidence(evidence: JsonValue, authority: JsonValue): JsonValue {
  const normalized = toAgentActionPayload(evidence);
  if (
    typeof normalized !== "object" ||
    normalized === null ||
    Array.isArray(normalized) ||
    Reflect.get(normalized, "truncated") !== true
  )
    return normalized;
  return toAgentActionPayload({ authority, evidence: normalized });
}

/**
 * Resolve an explicit `/name instructions` (or Pi-compatible `/skill:name instructions`)
 * against the exact skill snapshot already admitted for this turn.
 */
export function resolvePiSkillInvocation(
  prompt: string,
  skills: readonly PiSkillResource[],
): ResolvedPiSkillInvocation | undefined {
  if (!prompt.startsWith("/") || prompt.startsWith("//")) return undefined;
  const separator = prompt.search(/\s/u);
  const command = prompt.slice(1, separator < 0 ? undefined : separator);
  const name = command.startsWith("skill:") ? command.slice("skill:".length) : command;
  if (!name) return undefined;
  const skill = skills.find((candidate) => candidate.name === name);
  if (!skill) return undefined;
  const additionalInstructions = separator < 0 ? undefined : prompt.slice(separator).trimStart();
  const piSkill: Skill = {
    name: skill.name,
    description: skill.description,
    content: skill.content,
    filePath: skill.filePath,
    disableModelInvocation: skill.disableModelInvocation,
  };
  const evidence = toJsonValue({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    content: skill.content,
    contentDigest: skill.contentDigest,
    revision: skill.admittedRevision ?? null,
    invocation: "explicit",
  });
  const authority = toJsonValue({
    name: skill.name,
    filePath: skill.filePath,
    contentDigest: skill.contentDigest,
    revision: skill.admittedRevision ?? null,
    invocation: "explicit",
  });
  return Object.freeze({
    name: skill.name,
    prompt: formatSkillInvocation(piSkill, additionalInstructions || undefined),
    evidence,
    actionEvidence: actionEvidence(evidence, authority),
  });
}
