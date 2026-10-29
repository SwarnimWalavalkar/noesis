import type { AgentMessage, AgentUsage, StructuredInferencePort } from "@noesis/agent-types";
import {
  type CapabilityBinding,
  type CapabilityDefinition,
  canonicalJson,
  createConditionalObject,
  createId,
  type EvidenceRef,
  type ProjectRef,
  sha256,
} from "@noesis/domain";
import type { ExactCitation, HistoryPort } from "@noesis/intelligence";
import type { CapabilityLifecycleStore, NoesisWorkspaceStore } from "@noesis/workspace";
import { z } from "zod";
import { CapabilityReflectionProposalSchema, citedEvidence, publicationProposal } from "./capability-loop.ts";
import {
  CapabilityScopeDecisionSchema,
  type CapabilityDecision,
  type CapabilityPublicationResult,
  type CapabilityPublisher,
} from "./capability-publisher.ts";
import type { LearningRoleConfiguration } from "./schemas.ts";

const MESSAGE_MAX_CHARACTERS = 10_000;
const SESSION_REQUESTS = 40;
const REQUEST_EXCERPT_CHARACTERS = 600;
const SEARCHED_REQUESTS = 6;
const HITS_PER_REQUEST = 3;
const HISTORY_EXCERPT_CHARACTERS = 400;
const MATERIAL_EXCERPT_CHARACTERS = 600;
const MAX_DECISIONS = 3;

const SessionReviewDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("create"), proposal: CapabilityReflectionProposalSchema }),
  z.strictObject({
    decision: z.literal("revise"),
    capabilityId: z.string().min(1),
    proposal: CapabilityReflectionProposalSchema,
  }),
  z.strictObject({
    decision: z.literal("pause"),
    capabilityId: z.string().min(1),
    reason: z.string().min(1).max(2048),
  }),
  z.strictObject({
    decision: z.literal("change_binding"),
    capabilityId: z.string().min(1),
    scope: CapabilityScopeDecisionSchema,
    activationMode: z.enum(["relevant", "always"]),
    reason: z.string().min(1).max(2048),
  }),
]);
export const SessionReviewOutputSchema = z.strictObject({
  summary: z.string().min(1).max(2048).describe("What the review found, in one or two sentences"),
  decisions: z
    .array(SessionReviewDecisionSchema)
    .max(MAX_DECISIONS)
    .describe("At most three changes. An empty list is the normal result."),
});

export interface SessionReviewRequest {
  readonly sessionId: string;
  readonly project: ProjectRef;
  /** The turn whose settlement scheduled this review. Later activity supersedes it. */
  readonly turnId: string;
  readonly occurredAt: string;
}

export type SessionReviewResult =
  | { readonly status: "skipped"; readonly reason: string }
  | {
      readonly status: "reviewed";
      readonly summary: string;
      /** The review model's token usage. */
      readonly usage: AgentUsage;
      readonly results: readonly CapabilityPublicationResult[];
    };

export interface CreateSessionReviewOptions {
  readonly workspace: NoesisWorkspaceStore;
  readonly store: CapabilityLifecycleStore;
  readonly history: Pick<HistoryPort, "search">;
  readonly inference: StructuredInferencePort;
  readonly reviewer: LearningRoleConfiguration;
  readonly publisher: CapabilityPublisher;
  readonly nextId?: (prefix: string) => string;
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

/**
 * Drops items until the encoded message fits its character budget. Session requests drop the
 * oldest first, so a long session keeps the newest needs that scheduled this review.
 */
function fitted<T>(
  items: readonly T[],
  encode: (items: readonly T[]) => string,
  drop: "oldest" | "last" = "last",
): string {
  const kept = [...items];
  for (;;) {
    const encoded = encode(kept);
    if (encoded.length <= MESSAGE_MAX_CHARACTERS || kept.length === 0) return encoded;
    if (drop === "oldest") kept.shift();
    else kept.pop();
  }
}

/**
 * Reviews a whole session once it has gone quiet. It looks for what one exchange cannot show: the
 * same need across sessions, overlapping Capabilities, and Capabilities that did not help.
 */
export function createSessionReview(options: CreateSessionReviewOptions) {
  const nextId = options.nextId ?? createId;
  return async (request: SessionReviewRequest, signal: AbortSignal): Promise<SessionReviewResult> => {
    signal.throwIfAborted();
    const messages = await options.workspace.operational.messages.listForSession(request.sessionId);
    if (messages.some((message) => message.role === "user" && message.createdAt > request.occurredAt))
      return Object.freeze({
        status: "skipped",
        reason: "A later turn in the session will be reviewed instead",
      });
    const requests = messages
      .filter(
        (message) =>
          message.role === "user" &&
          message.sensitivity === "normal" &&
          message.metadata["origin"] !== "collaboration",
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(-SESSION_REQUESTS);
    if (requests.length === 0)
      return Object.freeze({ status: "skipped", reason: "The session has no reviewable requests" });

    const citations: ExactCitation[] = [];
    const cite = (citation: ExactCitation): number => citations.push(citation) - 1;
    const sessionRequests = requests.map((message) => ({
      index: cite(
        Object.freeze({
          source: Object.freeze({
            kind: "database_row" as const,
            table: "messages" as const,
            rowId: message.messageId,
            field: "content",
          }),
          occurredAt: message.createdAt,
          excerpt: bounded(message.content, REQUEST_EXCERPT_CHARACTERS),
          startOffset: 0,
          endOffset: Math.min(message.content.length, REQUEST_EXCERPT_CHARACTERS),
          contentDigest: sha256(message.content),
        }),
      ),
      createdAt: message.createdAt,
      request: bounded(message.content, REQUEST_EXCERPT_CHARACTERS),
    }));
    const related = [];
    for (const message of requests.slice(-SEARCHED_REQUESTS)) {
      const found = await options.history.search({
        query: message.content,
        sessionScope: Object.freeze({ kind: "previous", currentSessionId: request.sessionId }),
        limit: HITS_PER_REQUEST,
        maxExcerptChars: HISTORY_EXCERPT_CHARACTERS,
        signal,
      });
      related.push({
        request: bounded(message.content, 200),
        matches: found.hits.map((hit) => ({
          index: cite(hit.citation),
          occurredAt: hit.citation.occurredAt,
          excerpt: hit.citation.excerpt,
        })),
      });
    }

    const bindings = await options.store.listBindings({
      project: request.project,
      sessionId: request.sessionId,
      limit: 1000,
    });
    const definitions = new Map(
      (await options.store.getDefinitions(bindings.map((binding) => binding.capabilityId))).map(
        (definition) => [definition.capabilityId, definition] as const,
      ),
    );
    const records = await options.store.trackRecords(
      bindings.map((binding) => binding.revision.capabilityRevisionId),
    );
    const capabilities = await Promise.all(
      bindings.map(async (binding) => {
        const definition = definitions.get(binding.capabilityId);
        const revision = await options.store.getRevision(binding.revision);
        const first = revision?.revision.effects[0];
        const material =
          first?.kind === "instruction"
            ? new TextDecoder().decode(await options.workspace.reads.readRevision(first.material))
            : undefined;
        const record = records.get(binding.revision.capabilityRevisionId);
        return createConditionalObject({
          capabilityId: binding.capabilityId,
          name: definition?.name ?? binding.capabilityId,
          applicability: definition?.applicability ?? "",
          state: binding.state,
          activationMode: binding.activationMode,
          scope: binding.scope.kind,
          evidence: revision?.evidence?.kind ?? "not recorded",
          trackRecord: {
            helped: record?.helped ?? 0,
            hurt: record?.hurt ?? 0,
            unclear: record?.unclear ?? 0,
          },
        } as const)
          .addOptional(material ? { material: bounded(material, MATERIAL_EXCERPT_CHARACTERS) } : undefined)
          .finish();
      }),
    );

    const reviewMessages: readonly AgentMessage[] = Object.freeze([
      Object.freeze({
        role: "user" as const,
        name: "session_review",
        content: fitted(
          sessionRequests,
          (items) => canonicalJson({ sessionId: request.sessionId, requests: items }),
          "oldest",
        ),
      }),
      Object.freeze({
        role: "user" as const,
        name: "current_capabilities",
        content: fitted(capabilities, (items) => canonicalJson({ capabilities: items })),
      }),
      Object.freeze({
        role: "user" as const,
        name: "related_history",
        content: fitted(related, (items) => canonicalJson({ earlierSessions: items })),
      }),
    ]);
    const inferred = await options.inference.run(
      Object.freeze({
        runId: nextId("review-session"),
        role: "session_reviewer" as const,
        variant: options.reviewer.variant,
        messages: reviewMessages,
        evidenceRefs: Object.freeze([]),
        availableTools: Object.freeze([]),
        signal,
      }),
      SessionReviewOutputSchema,
    );
    signal.throwIfAborted();
    const bindingById = new Map<string, CapabilityBinding>(
      bindings.map((binding) => [binding.capabilityId, binding] as const),
    );
    const results: CapabilityPublicationResult[] = [];
    for (const decision of inferred.value.decisions) {
      const published = await publishDecision(
        decision,
        bindingById,
        definitions,
        citations,
        sessionRequests.at(-1)?.index ?? 0,
        request,
        signal,
      );
      results.push(published);
    }
    return Object.freeze({
      status: "reviewed",
      summary: inferred.value.summary,
      usage: inferred.trace.usage,
      results: Object.freeze(results),
    });
  };

  async function publishDecision(
    decision: z.infer<typeof SessionReviewDecisionSchema>,
    bindingById: ReadonlyMap<string, CapabilityBinding>,
    definitions: ReadonlyMap<string, CapabilityDefinition>,
    citations: readonly ExactCitation[],
    latestRequestIndex: number,
    request: SessionReviewRequest,
    signal: AbortSignal,
  ): Promise<CapabilityPublicationResult> {
    const expected = (capabilityId: string) => {
      const binding = bindingById.get(capabilityId);
      if (!binding) throw new Error(`Session review named unknown capability ${capabilityId}`);
      return { expectedBindingRevision: binding.revisionNumber };
    };
    const publication: CapabilityDecision =
      decision.decision === "create"
        ? { decision: "create", proposal: publicationProposal(decision.proposal) }
        : decision.decision === "revise"
          ? {
              decision: "revise",
              capabilityId: decision.capabilityId,
              ...expected(decision.capabilityId),
              proposal: publicationProposal(decision.proposal),
            }
          : decision.decision === "pause"
            ? {
                decision: "pause",
                capabilityId: decision.capabilityId,
                ...expected(decision.capabilityId),
                reason: decision.reason,
              }
            : {
                decision: "change_binding",
                capabilityId: decision.capabilityId,
                ...expected(decision.capabilityId),
                scope: decision.scope,
                activationMode: decision.activationMode,
                reason: decision.reason,
              };
    const evidenceRefs: readonly EvidenceRef[] =
      decision.decision === "create" || decision.decision === "revise"
        ? citedEvidence(decision.proposal.evidenceCitationIndexes, citations)
        : citedEvidence([latestRequestIndex], citations);
    const interpretation =
      decision.decision === "create" || decision.decision === "revise"
        ? decision.proposal.rationale
        : decision.reason;
    const name =
      decision.decision === "create" ? decision.proposal.name : definitions.get(decision.capabilityId)?.name;
    return await options.publisher.publish(
      publication,
      {
        project: request.project,
        sessionId: request.sessionId,
        evidenceRefs,
        actor: Object.freeze({ actorId: "session-reviewer", kind: "noesis" as const }),
        interpretation: name ? `${name}: ${interpretation}` : interpretation,
      },
      signal,
    );
  }
}
