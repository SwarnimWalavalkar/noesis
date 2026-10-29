import { renderComposerAttachmentText } from "./attachments.ts";
import {
  type AgentThinkingLevel,
  type FrozenCapabilitySelection,
  type FrozenContextCheckpoint,
  type FrozenContextDocument,
  type FrozenRevisionMaterial,
  type FrozenTurnPlan,
  frozenTurnPlanDigest,
  renderFrozenConversationHistoryContent,
  MAX_FROZEN_CONVERSATION_HISTORY_ENTRY_CHARACTERS,
  MAX_FROZEN_CONVERSATION_HISTORY_MESSAGES,
  MAX_FROZEN_CONVERSATION_HISTORY_TOTAL_CHARACTERS,
  validateFrozenTurnPlan,
} from "@noesis/agent-types";
import type {
  ComposerAttachment,
  EvidenceRef,
  FileRevisionRef,
  PermissionManifest,
  ProjectRef,
} from "@noesis/domain";
import {
  assertCapabilityEffectsEligible,
  capabilityGuidance,
  ComposerAttachmentsSchema,
  createConditionalObject,
  canonicalJson,
  sha256,
  toJsonValue,
  validateCapabilityEffects,
} from "@noesis/domain";
import { isCapabilityBindingAdmissionConflictError, type NoesisWorkspaceStore } from "@noesis/workspace";
import type { ProtectedWorkspaceRuntime } from "../../workspace/src/protected-runtime.ts";
import { contextNotebookTokenBudget, resolveContextNotebook } from "./session-compaction.ts";
const decoder = new TextDecoder("utf8", { fatal: true });
export interface TurnPlanningRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly userInput: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: AgentThinkingLevel;
  readonly baseSystemPrompt: string;
  readonly priorHistory?: readonly TurnRoutingHistoryMessage[];
  readonly contextCheckpointId?: string;
  readonly contextTokenBudget?: number;
  readonly requestTokenBudget?: number;
  readonly subAgentDefaults?: FrozenTurnPlan["subAgentDefaults"];
  readonly retrievalCitations?: readonly EvidenceRef[];
}
async function freezeContextCheckpoint(
  workspace: NoesisWorkspaceStore,
  sessionId: string,
  checkpointId: string | undefined,
  contextTokenBudget: number | undefined,
): Promise<FrozenContextCheckpoint | undefined> {
  if (checkpointId === undefined) return undefined;
  if (contextTokenBudget === undefined)
    throw new Error(`Context checkpoint ${checkpointId} requires a context token budget`);
  const lineage = await workspace.operational.contextCheckpoints.lineage(checkpointId);
  const checkpoint = lineage.at(-1);
  if (!checkpoint || checkpoint.sessionId !== sessionId)
    throw new Error(`Context checkpoint ${checkpointId} does not belong to session ${sessionId}`);
  if (sha256(checkpoint.summary) !== checkpoint.summaryDigest)
    throw new Error(`Context checkpoint ${checkpointId} failed summary verification`);
  const notebook = resolveContextNotebook(lineage, contextNotebookTokenBudget(contextTokenBudget));
  if (!notebook || notebook.activeCheckpoint.checkpointId !== checkpointId)
    throw new Error(`Context checkpoint ${checkpointId} did not resolve an active notebook`);
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze({
    checkpointId,
    checkpointRef: Object.freeze({
      kind: "database_row" as const,
      table: "context_checkpoints" as const,
      rowId: checkpointId,
    }),
    summary: notebook.content,
    summaryDigest: notebook.contentDigest,
    sourceDigest: notebook.sourceDigest,
    sensitivity: notebook.sensitivity,
    createdAt: checkpoint.createdAt,
    notes: Object.freeze(
      notebook.selectedCheckpoints.map((note) =>
        Object.freeze({
          checkpointId: note.checkpointId,
          checkpointRef: Object.freeze({
            kind: "database_row" as const,
            table: "context_checkpoints" as const,
            rowId: note.checkpointId,
          }),
          summaryKind: note.summaryKind,
          summary: note.summary,
          summaryDigest: note.summaryDigest,
          sourceDigest: note.sourceDigest,
          sensitivity: note.sensitivity,
          createdAt: note.createdAt,
        }),
      ),
    ),
    omittedNoteCount: notebook.omittedCheckpointCount,
  });
}
interface ContextDocumentLine {
  readonly occurredAt: string;
  readonly stableId: string;
  readonly kindOrder: number;
  readonly value: import("@noesis/domain").JsonValue;
}
function optionalJsonFields(
  value: Readonly<Record<string, import("@noesis/domain").JsonValue | undefined>>,
): Readonly<Record<string, import("@noesis/domain").JsonValue>> {
  const present: Record<string, import("@noesis/domain").JsonValue> = {};
  for (const [key, item] of Object.entries(value)) if (item !== undefined) present[key] = item;
  return Object.freeze(present);
}
function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
async function freezeContextDocument(
  workspace: NoesisWorkspaceStore,
  sessionId: string,
): Promise<FrozenContextDocument> {
  const [session, messages, toolCalls, codeExecutions, modelCalls, workflowRuns] = await Promise.all([
    workspace.operational.sessions.get(sessionId),
    workspace.operational.messages.listForSession(sessionId),
    workspace.operational.toolCalls.listForSession(sessionId),
    workspace.operational.codeExecutions.listForSession(sessionId),
    workspace.operational.modelCalls.listForSession(sessionId),
    workspace.operational.workflows.listRunsForSession(sessionId),
  ]);
  const lines: ContextDocumentLine[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    lines.push(
      Object.freeze({
        occurredAt: message.createdAt,
        stableId: message.messageId,
        kindOrder: 0,
        value: toJsonValue({
          type: "message",
          messageId: message.messageId,
          sessionId,
          role: message.role,
          content: message.content,
          sensitivity: message.sensitivity,
          createdAt: message.createdAt,
          ...optionalJsonFields({
            timelineSequence: message.timelineSequence,
            turnId: message.metadata["turnId"],
          }),
        }),
      }),
    );
  }
  for (const call of toolCalls)
    lines.push(
      Object.freeze({
        occurredAt: call.createdAt,
        stableId: call.toolCallId,
        kindOrder: 1,
        value: toJsonValue({
          type: "tool_call",
          toolCallId: call.toolCallId,
          sessionId,
          toolName: call.toolName,
          request: toJsonValue(call.request),
          status: call.status,
          sensitivity: call.sensitivity,
          createdAt: call.createdAt,
          ...optionalJsonFields({
            turnId: call.turnId,
            messageId: call.messageId,
            parentToolCallId: call.parentToolCallId,
            executionId: call.executionId,
            sequence: call.sequence,
            timelineSequence: call.timelineSequence,
            update: call.update === undefined ? undefined : toJsonValue(call.update),
            response: call.response === undefined ? undefined : toJsonValue(call.response),
            completedAt: call.completedAt,
          }),
        }),
      }),
    );
  for (const execution of codeExecutions)
    lines.push(
      Object.freeze({
        occurredAt: execution.startedAt,
        stableId: execution.executionId,
        kindOrder: 2,
        value: toJsonValue({
          type: "code_execution",
          executionId: execution.executionId,
          logicalExecutionId: execution.logicalExecutionId,
          sessionId,
          catalogId: execution.catalogId,
          catalogDigest: execution.catalogDigest,
          sourceDigest: execution.sourceDigest,
          status: execution.status,
          callCount: execution.callCount,
          startedAt: execution.startedAt,
          ...optionalJsonFields({
            parentExecutionId: execution.parentExecutionId,
            turnId: execution.turnId,
            sourceArtifactId: execution.sourceArtifactId,
            stdoutArtifactId: execution.stdoutArtifactId,
            stderrArtifactId: execution.stderrArtifactId,
            result: execution.result,
            error: execution.error,
            completedAt: execution.completedAt,
          }),
        }),
      }),
    );
  for (const call of modelCalls)
    lines.push(
      Object.freeze({
        occurredAt: call.startedAt,
        stableId: call.modelCallId,
        kindOrder: 3,
        value: toJsonValue({
          type: "model_call",
          modelCallId: call.modelCallId,
          parentExecutionId: call.parentExecutionId,
          sessionId,
          provider: call.provider,
          model: call.model,
          thinkingLevel: call.thinkingLevel,
          requestArtifactId: call.requestArtifactId,
          contextRefs: call.contextRefs,
          status: call.status,
          startedAt: call.startedAt,
          ...optionalJsonFields({
            turnId: call.turnId,
            contextArtifactId: call.contextArtifactId,
            outputArtifactId: call.outputArtifactId,
            usage: call.usage ? toJsonValue(call.usage) : undefined,
            latencyMs: call.latencyMs,
            error: call.error,
            completedAt: call.completedAt,
          }),
        }),
      }),
    );
  for (const run of workflowRuns)
    lines.push(
      Object.freeze({
        occurredAt: run.createdAt,
        stableId: run.runId,
        kindOrder: 4,
        value: toJsonValue({
          type: "workflow_run",
          runId: run.runId,
          workflowName: run.workflowName,
          workflowRevision: run.workflowRevision,
          definitionRevisionId: run.definitionRevisionId,
          sessionId,
          status: run.status,
          currentPhase: run.currentPhase,
          input: run.input,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          ...optionalJsonFields({
            projectId: run.projectId,
            turnId: run.turnId,
            output: run.output,
            error: run.error,
            completedAt: run.completedAt,
          }),
        }),
      }),
    );
  lines.sort(
    (left, right) =>
      compareCodePoints(left.occurredAt, right.occurredAt) ||
      left.kindOrder - right.kindOrder ||
      compareCodePoints(left.stableId, right.stableId),
  );
  const content = lines.length === 0 ? "" : `${lines.map((line) => canonicalJson(line.value)).join("\n")}\n`;
  const bytes = new TextEncoder().encode(content);
  const contentDigest = sha256(bytes);
  if (!session) throw new Error(`Context document requires session ${sessionId}`);
  const artifact = await workspace.artifacts.writeArtifact({
    path: `context-documents/${sha256(sessionId).slice(0, 32)}/${contentDigest}.jsonl`,
    mediaType: "application/x-ndjson",
    bytes,
    actor: Object.freeze({ actorId: "turn-context", kind: "system" as const }),
    relationshipRefs: Object.freeze([
      Object.freeze({ kind: "database_row" as const, table: "sessions" as const, rowId: sessionId }),
    ]),
  });
  if (artifact.mediaType !== "application/x-ndjson")
    throw new Error(
      `Context document artifact ${artifact.artifactId} has unexpected media type ${artifact.mediaType}`,
    );
  return Object.freeze({
    documentId: `context_document_${contentDigest}`,
    artifact: Object.freeze({ ...artifact, mediaType: artifact.mediaType }),
    format: "noesis-session-context-v1",
    characterLength: content.length,
    byteLength: bytes.length,
    contentDigest,
  });
}
export interface TurnIntelligencePlanner {
  readonly planAndAdmit: (request: TurnPlanningRequest) => Promise<FrozenTurnPlan>;
}
/** The total guidance that always-active Capabilities may add to one prompt. */
export const ALWAYS_GUIDANCE_ALLOWANCE_CHARACTERS = 6_000;
export interface TurnRoutingHistoryMessage {
  readonly attachments?: readonly ComposerAttachment[];
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly createdAt: string;
  readonly turnStatus?: "completed" | "failed" | "aborted";
}
export interface TurnIntelligencePlannerOptions {
  readonly workspace: NoesisWorkspaceStore;
  readonly protectedRuntime: ProtectedWorkspaceRuntime;
  /** Canonical host-derived active directory identity, resolved once at startup. */
  readonly project: ProjectRef;
  readonly basePermissionManifest?: PermissionManifest;
  readonly now?: () => string;
  readonly createPlanId?: (turnId: string) => string;
}
export {
  MAX_FROZEN_CONVERSATION_HISTORY_ENTRY_CHARACTERS,
  MAX_FROZEN_CONVERSATION_HISTORY_MESSAGES,
  MAX_FROZEN_CONVERSATION_HISTORY_TOTAL_CHARACTERS,
} from "@noesis/agent-types";
async function freezeConversationHistory(
  workspace: NoesisWorkspaceStore,
  sessionId: string,
  messages: readonly TurnRoutingHistoryMessage[],
): Promise<NonNullable<FrozenTurnPlan["conversationHistory"]>> {
  if (messages.length > MAX_FROZEN_CONVERSATION_HISTORY_MESSAGES)
    throw new Error(
      `Turn history has ${messages.length} messages; maximum is ${MAX_FROZEN_CONVERSATION_HISTORY_MESSAGES}`,
    );
  const seen = new Set<string>();
  let totalCharacters = 0;
  const frozen: NonNullable<FrozenTurnPlan["conversationHistory"]>[number][] = [];
  for (const message of messages) {
    if (seen.has(message.messageId)) throw new Error(`Turn history repeats message ${message.messageId}`);
    seen.add(message.messageId);
    if (message.content.length > MAX_FROZEN_CONVERSATION_HISTORY_ENTRY_CHARACTERS)
      throw new Error(`Turn history message ${message.messageId} exceeds the per-entry character bound`);
    totalCharacters += message.content.length;
    if (totalCharacters > MAX_FROZEN_CONVERSATION_HISTORY_TOTAL_CHARACTERS)
      throw new Error("Turn history exceeds the total character bound");
    const durable = await workspace.operational.messages.get(message.messageId);
    if (
      !durable ||
      durable.sessionId !== sessionId ||
      durable.role !== message.role ||
      durable.content !== message.content ||
      durable.createdAt !== message.createdAt
    )
      throw new Error(`Turn history message ${message.messageId} does not match authoritative SQLite state`);
    const attachments = ComposerAttachmentsSchema.parse(durable.metadata["attachments"] ?? []);
    if (canonicalJson(attachments) !== canonicalJson(message.attachments ?? []))
      throw new Error(`Turn history message ${message.messageId} has stale attachments`);
    if (attachments.length > 0 && message.role !== "user")
      throw new Error(`Turn history message ${message.messageId} attaches files to a non-user message`);
    if (message.turnStatus !== undefined) {
      const turnId = durable.metadata["turnId"];
      if (typeof turnId !== "string" || turnId.length === 0)
        throw new Error(`Turn history message ${message.messageId} has no durable turn identity`);
      const turn = await workspace.operational.foregroundTurns.get(turnId);
      if (!turn || turn.sessionId !== sessionId || turn.status !== message.turnStatus)
        throw new Error(`Turn history message ${message.messageId} has a stale terminal turn status`);
    }
    const attachmentText = renderComposerAttachmentText("", attachments, workspace.paths.root);
    const renderedLength = renderFrozenConversationHistoryContent({ ...message, attachmentText }).length;
    totalCharacters += renderedLength - message.content.length;
    if (renderedLength > MAX_FROZEN_CONVERSATION_HISTORY_ENTRY_CHARACTERS)
      throw new Error(`Turn history message ${message.messageId} exceeds the per-entry character bound`);
    if (totalCharacters > MAX_FROZEN_CONVERSATION_HISTORY_TOTAL_CHARACTERS)
      throw new Error("Turn history exceeds the total character bound");
    const imageDigests = [];
    for (const attachment of attachments)
      if (attachment.mimeType.startsWith("image/")) {
        const metadata = await workspace.reads.inspectArtifact(attachment.artifact);
        imageDigests.push({
          artifactId: attachment.artifact.artifactId,
          contentDigest: metadata.contentDigest,
        });
      }
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    frozen.push(
      Object.freeze(
        createConditionalObject({
          messageId: message.messageId,
          messageRef: Object.freeze({
            kind: "database_row" as const,
            table: "messages" as const,
            rowId: message.messageId,
          }),
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          contentDigest: sha256(message.content),
        } as const)
          .addOptional(!(message.turnStatus === undefined) ? { turnStatus: message.turnStatus } : undefined)
          .addOptional(
            attachments.length > 0
              ? {
                  attachments,
                  attachmentText,
                  imageDigests,
                }
              : undefined,
          )
          .finish(),
      ),
    );
  }
  return Object.freeze(frozen);
}
async function materialize(
  workspace: NoesisWorkspaceStore,
  reference: FileRevisionRef,
): Promise<FrozenRevisionMaterial> {
  const bytes = await workspace.reads.readRevision(reference);
  return Object.freeze({ revision: reference, content: decoder.decode(bytes) });
}
const NO_PERMISSIONS: PermissionManifest = Object.freeze({
  effects: Object.freeze([]),
  resourcePatterns: Object.freeze([]),
  credentialRefs: Object.freeze([]),
});
export function createTurnIntelligencePlanner(
  options: TurnIntelligencePlannerOptions,
): TurnIntelligencePlanner {
  const now = options.now ?? (() => new Date().toISOString());
  const createPlanId = options.createPlanId ?? ((turnId) => `turn_plan_${turnId}`);
  const planAndAdmitOnce = async (request: TurnPlanningRequest): Promise<FrozenTurnPlan> => {
    const bindings = await options.workspace.capabilities.listEligibleBindings({
      project: options.project,
      sessionId: request.sessionId,
    });
    const [conversationHistory, contextCheckpoint, contextDocument] = await Promise.all([
      freezeConversationHistory(options.workspace, request.sessionId, request.priorHistory ?? []),
      freezeContextCheckpoint(
        options.workspace,
        request.sessionId,
        request.contextCheckpointId,
        request.contextTokenBudget,
      ),
      freezeContextDocument(options.workspace, request.sessionId),
    ]);
    const definitions = new Map(
      (
        await options.workspace.capabilities.getDefinitions(bindings.map((binding) => binding.capabilityId))
      ).map((definition) => [definition.capabilityId, definition] as const),
    );
    const resolved = await Promise.all(
      bindings.map(async (binding) => {
        const definition = definitions.get(binding.capabilityId);
        const lifecycle = await options.workspace.capabilities.getRevision(binding.revision);
        if (!definition || !lifecycle)
          throw new Error(
            `Active capability ${binding.revision.capabilityRevisionId} cannot be read from immutable state`,
          );
        return Object.freeze({ binding, definition, revision: lifecycle.revision });
      }),
    );
    // `always` Capabilities go in the prompt. `relevant` Capabilities are listed by name and "when"
    // text, the same way skills are. The foreground model chooses which to load, so planning makes
    // no separate routing model call.
    const ordered = [
      ...resolved.filter((item) => item.binding.activationMode === "always"),
      ...resolved.filter((item) => item.binding.activationMode === "relevant"),
    ];
    const selections = await Promise.all(
      ordered.map(async ({ binding, definition, revision }): Promise<FrozenCapabilitySelection> => {
        const effects = validateCapabilityEffects(revision.effects);
        assertCapabilityEffectsEligible({ effects, scope: binding.scope, project: options.project });
        const frozenEffects = await Promise.all(
          effects.map(async (effect) =>
            effect.kind === "instruction"
              ? Object.freeze({
                  kind: "instruction" as const,
                  material: await materialize(options.workspace, effect.material),
                })
              : Object.freeze({
                  kind: "program" as const,
                  mode: effect.program.mode,
                  name: effect.program.name,
                  project: Object.freeze({ ...effect.program.project }),
                  definition: await materialize(options.workspace, effect.program.definitionRevision),
                }),
          ),
        );
        const always = binding.activationMode === "always";
        return Object.freeze({
          capabilityId: definition.capabilityId,
          name: definition.name,
          description: definition.description,
          applicability: definition.applicability,
          selectionReason: always ? "always active" : "listed for the model to load when relevant",
          delivery: always ? ("prompt" as const) : ("on_demand" as const),
          revision: binding.revision,
          effects: Object.freeze(frozenEffects),
        });
      }),
    );
    // Always-active guidance shares one allowance. A Capability past it is listed on demand for
    // this turn instead of growing every prompt.
    let alwaysCharacters = 0;
    const deliveredSelections = selections.map((selection) => {
      if (selection.delivery !== "prompt") return selection;
      const characters = selection.effects
        .flatMap((effect) =>
          effect.kind === "instruction" ? [capabilityGuidance(effect.material.content)] : [],
        )
        .reduce((total, guidance) => total + guidance.length, 0);
      if (alwaysCharacters + characters <= ALWAYS_GUIDANCE_ALLOWANCE_CHARACTERS) {
        alwaysCharacters += characters;
        return selection;
      }
      return Object.freeze({
        ...selection,
        delivery: "on_demand" as const,
        selectionReason: "always active, listed on demand because always guidance exceeded its allowance",
      });
    });
    const promptLayers = deliveredSelections.flatMap((selection) =>
      selection.delivery === "on_demand"
        ? []
        : selection.effects.flatMap((effect) =>
            effect.kind === "instruction" ? [capabilityGuidance(effect.material.content).trim()] : [],
          ),
    );
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const unsigned = Object.freeze(
      createConditionalObject({
        schemaVersion: 2 as const,
        planId: createPlanId(request.turnId),
        sessionId: request.sessionId,
        turnId: request.turnId,
        project: options.project,
        selectedCapabilities: Object.freeze(deliveredSelections),
        conversationHistory,
        contextDocument,
      } as const)
        .addOptional(contextCheckpoint ? { contextCheckpoint } : undefined)
        .addOptional(
          !(request.contextTokenBudget === undefined)
            ? {
                contextTokenBudget: request.contextTokenBudget,
              }
            : undefined,
        )
        .addOptional(
          !(request.requestTokenBudget === undefined)
            ? {
                requestTokenBudget: request.requestTokenBudget,
              }
            : undefined,
        )
        .addOptional(
          !(request.subAgentDefaults === undefined)
            ? { subAgentDefaults: Object.freeze({ ...request.subAgentDefaults }) }
            : undefined,
        )
        .add({
          renderedSystemPrompt: [request.baseSystemPrompt.trim(), ...promptLayers]
            .filter((layer): layer is string => Boolean(layer))
            .join("\n\n"),
          provider: request.provider,
          model: request.model,
          thinkingLevel: request.thinkingLevel,
          permissionSnapshot: options.basePermissionManifest ?? NO_PERMISSIONS,
          retrievalCitations: Object.freeze([...(request.retrievalCitations ?? [])]),
          createdAt: now(),
        } as const)
        .finish(),
    );
    const plan = validateFrozenTurnPlan(
      Object.freeze({ ...unsigned, canonicalDigest: frozenTurnPlanDigest(unsigned) }),
    );
    return await options.protectedRuntime.turnPlans.admit(plan);
  };
  const planAndAdmit = async (request: TurnPlanningRequest): Promise<FrozenTurnPlan> => {
    try {
      return await planAndAdmitOnce(request);
    } catch (error) {
      if (!isCapabilityBindingAdmissionConflictError(error)) throw error;
      return await planAndAdmitOnce(request);
    }
  };
  return Object.freeze({ planAndAdmit });
}
