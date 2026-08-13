import type { AgentMessage, AgentRole, AgentRunRequest } from "@noesis/agent-types";
import type { CapabilityRevisionRef } from "@noesis/domain";
import type { BoundedRoleInput, RoleContextPolicy } from "./role-types.ts";

const DEFAULT_MAX_MESSAGES = 24;
const DEFAULT_MESSAGE_CHARACTERS = 16_000;
const DEFAULT_TOTAL_CHARACTERS = 64_000;
const DEFAULT_EVIDENCE_REFS = 64;

const isolatedRoleMessageNames = {
  capability_router: ["turn", "prior_conversation"],
  session_compactor: ["compaction_input"],
  history_reranker: ["candidates"],
  signal_interpreter: ["turn", "related_history"],
  reflector: [
    "current_turn",
    "signals",
    "evidence",
    "active_capabilities",
    "user_preferences",
    "working_adjustment_context",
  ],
  revision_author: ["hypothesis", "source_cases"],
  case_generator: ["behavioral_objective", "evidence", "user_criteria"],
  trial: ["case", "arm"],
  judge_critic: ["rubric", "arm_A", "arm_B", "relevant_traces"],
  revision_agent: ["failures", "judgment_evidence"],
  ux_explainer: ["evidence", "diff", "report", "activation_lineage"],
} as const satisfies Readonly<Record<Exclude<AgentRole, "foreground">, readonly string[]>>;

export function createDefaultRoleContextPolicy(role: AgentRole): RoleContextPolicy {
  const foreground = role === "foreground";
  const compactor = role === "session_compactor";
  return Object.freeze({
    policyId: foreground ? "foreground-bounded-v1" : `${role}-isolated-v1`,
    maxMessages: compactor ? 1 : DEFAULT_MAX_MESSAGES,
    maxCharactersPerMessage: compactor ? 4_000_000 : DEFAULT_MESSAGE_CHARACTERS,
    maxTotalCharacters: compactor ? 4_000_000 : DEFAULT_TOTAL_CHARACTERS,
    maxEvidenceRefs: DEFAULT_EVIDENCE_REFS,
    maxTools: foreground ? 32 : 0,
    ...(foreground ? {} : { allowedMessageNames: isolatedRoleMessageNames[role] }),
    includeCapabilityRevisions: role !== "judge_critic",
  });
}

export function createRestrictedRoleContextPolicy(
  role: AgentRole,
  overrides: Partial<RoleContextPolicy> = {},
): RoleContextPolicy {
  const base = createDefaultRoleContextPolicy(role);
  const boundedValues = [
    ["maxMessages", overrides.maxMessages, base.maxMessages],
    ["maxCharactersPerMessage", overrides.maxCharactersPerMessage, base.maxCharactersPerMessage],
    ["maxTotalCharacters", overrides.maxTotalCharacters, base.maxTotalCharacters],
    ["maxEvidenceRefs", overrides.maxEvidenceRefs, base.maxEvidenceRefs],
    ["maxTools", overrides.maxTools, base.maxTools],
  ] as const;
  for (const [name, requested, maximum] of boundedValues) {
    if (requested !== undefined && requested > maximum)
      throw new Error(`Restricted role context cannot widen ${name} beyond ${maximum}`);
  }
  if (!base.includeCapabilityRevisions && overrides.includeCapabilityRevisions === true)
    throw new Error("Restricted role context cannot expose capability revisions");

  let allowedMessageNames = base.allowedMessageNames;
  if (base.allowedMessageNames && overrides.allowedMessageNames) {
    const baseNames = new Set(base.allowedMessageNames);
    if (overrides.allowedMessageNames.some((name) => !baseNames.has(name)))
      throw new Error("Restricted role context cannot add undeclared message names");
    allowedMessageNames = Object.freeze([...overrides.allowedMessageNames]);
  } else if (!base.allowedMessageNames && overrides.allowedMessageNames) {
    allowedMessageNames = Object.freeze([...overrides.allowedMessageNames]);
  }

  return Object.freeze({
    ...base,
    ...overrides,
    ...(allowedMessageNames ? { allowedMessageNames } : {}),
    includeCapabilityRevisions: overrides.includeCapabilityRevisions ?? base.includeCapabilityRevisions,
  });
}

function isCapabilityRevisionRef(revision: unknown): revision is CapabilityRevisionRef {
  return (
    revision !== null &&
    typeof revision === "object" &&
    "kind" in revision &&
    revision.kind === "capability_revision" &&
    "capabilityId" in revision &&
    typeof revision.capabilityId === "string" &&
    revision.capabilityId.length > 0 &&
    "capabilityRevisionId" in revision &&
    typeof revision.capabilityRevisionId === "string" &&
    revision.capabilityRevisionId.length > 0 &&
    "bundleDigest" in revision &&
    typeof revision.bundleDigest === "string" &&
    /^[a-f0-9]{64}$/.test(revision.bundleDigest)
  );
}

function capabilityRevisionsOf(request: AgentRunRequest): readonly CapabilityRevisionRef[] {
  if (!("capabilityRevisions" in request)) return [];
  const revisions = request.capabilityRevisions;
  if (!Array.isArray(revisions) || !revisions.every(isCapabilityRevisionRef)) {
    throw new Error("Role input contains an invalid CapabilityRevisionRef");
  }
  return revisions;
}

export function signalOf(request: AgentRunRequest): AbortSignal | undefined {
  if (!("signal" in request)) return undefined;
  const signal = request.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function boundMessages(
  messages: readonly AgentMessage[],
  policy: RoleContextPolicy,
): readonly AgentMessage[] {
  if (messages.length > policy.maxMessages)
    throw new Error(`Context policy ${policy.policyId} rejects messages beyond its message bound`);
  const bounded: AgentMessage[] = [];
  let totalCharacters = 0;
  for (const message of messages) {
    if (policy.allowedMessageNames) {
      if (!message.name || !policy.allowedMessageNames.includes(message.name)) {
        throw new Error(
          `Context policy ${policy.policyId} rejects undeclared message ${message.name ?? "<unnamed>"}`,
        );
      }
    }
    if (message.content.length > policy.maxCharactersPerMessage)
      throw new Error(
        `Context policy ${policy.policyId} rejects message ${message.name ?? "<unnamed>"} beyond its character bound`,
      );
    totalCharacters += message.content.length;
    if (totalCharacters > policy.maxTotalCharacters)
      throw new Error(`Context policy ${policy.policyId} rejects messages beyond its total character bound`);
    bounded.push(Object.freeze({ ...message }));
  }
  return Object.freeze(bounded);
}

export function applyRoleContextPolicy(
  request: AgentRunRequest,
  policy: RoleContextPolicy,
): BoundedRoleInput {
  if (request.role !== "foreground" && policy.maxTools > 0) {
    throw new Error(`Context policy ${policy.policyId} cannot expose tools to isolated role ${request.role}`);
  }
  return Object.freeze({
    runId: request.runId,
    role: request.role,
    variant: request.variant,
    messages: boundMessages(request.messages, policy),
    evidenceRefs: Object.freeze(request.evidenceRefs.slice(0, policy.maxEvidenceRefs)),
    availableTools: Object.freeze(request.availableTools.slice(0, policy.maxTools)),
    capabilityRevisions: Object.freeze(capabilityRevisionsOf(request).map((revision) => ({ ...revision }))),
  });
}

export function renderBoundedRolePrompt(input: BoundedRoleInput, policy: RoleContextPolicy): string {
  const visibleCapabilityRevisions = policy.includeCapabilityRevisions ? input.capabilityRevisions : [];
  return JSON.stringify(
    {
      runId: input.runId,
      role: input.role,
      variant: input.variant,
      messages: input.messages,
      evidenceRefs: input.evidenceRefs,
      availableTools: input.availableTools,
      capabilityRevisions: visibleCapabilityRevisions,
    },
    null,
    2,
  );
}
