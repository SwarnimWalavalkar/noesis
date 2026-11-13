import type { FrozenTurnPlan } from "@noesis/agent-types";
import {
  CapabilityBindingSchema,
  CapabilityRevisionRefSchema,
  type CapabilityDefinition,
  type CapabilityEffect,
  type CapabilityFeedback,
  type CapabilityGateRequest,
  type CapabilityLifecycleRevision,
  CapabilityScopeSchema,
  capabilityDocumentInFolderFormat,
  EvidenceRefSchema,
  FileRevisionRefSchema,
  ProjectRefSchema,
  type ProjectRef,
} from "@noesis/domain";
import { mkdir, open as openFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  capabilityDocumentRevision,
  capabilityFolderFiles,
  capabilityWorkingDocumentPath,
  capabilityWorkingFolderPath,
  CapabilityDecisionSchema,
  CapabilityPublicationResultSchema,
  type CapabilityProgramLibrary,
  type CapabilityPublisher,
} from "@noesis/learning";
import { defineTool, type ToolDefinition } from "@noesis/tools";
import { folderProgramFilesForExport } from "./program-library.ts";
import type { CapabilityLifecyclePageCursor, NoesisWorkspaceStore } from "@noesis/workspace";
import { z } from "zod";

const decoder = new TextDecoder("utf8", { fatal: true });
const DEFAULT_INSPECTION_PAGE_SIZE = 10;
const MAX_INSPECTION_PAGE_SIZE = 25;
const DEFAULT_MATERIAL_CHARACTERS = 8_000;
const MAX_MATERIAL_CHARACTERS = 16_000;
const PaginationInputFields = {
  cursor: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(MAX_INSPECTION_PAGE_SIZE).optional(),
};
const PaginationOutputFields = {
  total: z.number().int().nonnegative(),
  cursor: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  nextCursor: z.number().int().nonnegative().nullable(),
};
const LifecyclePaginationInputFields = {
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_INSPECTION_PAGE_SIZE).optional(),
};
const LifecyclePaginationOutputFields = {
  total: z.number().int().nonnegative(),
  cursor: z.string().nullable(),
  limit: z.number().int().positive(),
  nextCursor: z.string().nullable(),
};
const CapabilityRevisionSummarySchema = z.strictObject({
  reference: CapabilityRevisionRefSchema,
  summary: z.string(),
  rationale: z.string(),
  anticipatedEffect: z.string(),
  effectKinds: z.array(z.enum(["instruction", "program"])),
  createdAt: z.string(),
});

const CapabilityEffectInspectionSchema = z.strictObject({
  effectIndex: z.number().int().nonnegative(),
  kind: z.enum(["instruction", "program"]),
  name: z.string().nullable(),
  /** Null for an instruction and for a global Program. */
  project: ProjectRefSchema.nullable(),
  programScope: z.enum(["project", "global"]).nullable(),
  mode: z.enum(["script", "workflow"]).nullable(),
  revision: FileRevisionRefSchema,
});

const CapabilityRevisionInspectionSchema = z.strictObject({
  reference: CapabilityRevisionRefSchema,
  predecessorRevisionId: z.string().nullable(),
  summary: z.string(),
  rationale: z.string(),
  anticipatedEffect: z.string(),
  effects: z.array(CapabilityEffectInspectionSchema),
  evidenceRefs: z.array(EvidenceRefSchema),
  createdAt: z.string(),
});

const CapabilityFeedbackInspectionSchema = z.strictObject({
  feedbackId: z.string(),
  capabilityId: z.string(),
  revision: CapabilityRevisionRefSchema,
  evidenceRefs: z.array(EvidenceRefSchema),
  interpretation: z.string(),
  disposition: z.enum([
    "positive",
    "correction",
    "regression",
    "scope_change",
    "activation_change",
    "restore_request",
  ]),
  createdAt: z.string(),
});

const CapabilityGateInspectionSchema = z.strictObject({
  gateRequestId: z.string(),
  capabilityId: z.string(),
  revision: CapabilityRevisionRefSchema,
  expectedBindingRevision: z.number().int().positive(),
  proposedScope: CapabilityScopeSchema,
  proposedActivationMode: z.enum(["relevant", "always"]),
  consequence: z.string(),
  status: z.enum(["pending", "approved", "denied", "superseded"]),
  instruction: z.string().nullable(),
  createdAt: z.string(),
  settledAt: z.string().nullable(),
});

const CapabilityDefinitionInspectionSchema = z.strictObject({
  capabilityId: z.string(),
  name: z.string(),
  description: z.string(),
  applicability: z.string(),
  createdAt: z.string(),
});
const CapabilityLifecycleCursorSchema = z.strictObject({
  createdAt: z.string(),
  id: z.string().min(1),
});

const CapabilityInspectInputSchema = z.discriminatedUnion("view", [
  z.strictObject({
    view: z.literal("list"),
    ...PaginationInputFields,
  }),
  z.strictObject({
    view: z.literal("detail"),
    capabilityId: z.string().trim().min(1),
  }),
  z.strictObject({
    view: z.literal("revisions"),
    capabilityId: z.string().trim().min(1),
    ...LifecyclePaginationInputFields,
  }),
  z.strictObject({
    view: z.literal("feedback"),
    capabilityId: z.string().trim().min(1),
    ...LifecyclePaginationInputFields,
  }),
  z.strictObject({
    view: z.literal("gates"),
    capabilityId: z.string().trim().min(1),
    ...LifecyclePaginationInputFields,
  }),
  z.strictObject({
    view: z.literal("material"),
    capabilityId: z.string().trim().min(1),
    capabilityRevisionId: z.string().trim().min(1),
    effectIndex: z.number().int().nonnegative(),
    start: z.number().int().nonnegative().optional(),
    maxCharacters: z.number().int().min(1).max(MAX_MATERIAL_CHARACTERS).optional(),
  }),
  z.strictObject({
    view: z.literal("file"),
    capabilityId: z.string().trim().min(1),
    capabilityRevisionId: z.string().trim().min(1),
    path: z.string().min(1),
    start: z.number().int().nonnegative().optional(),
    maxCharacters: z.number().int().min(1).max(MAX_MATERIAL_CHARACTERS).optional(),
  }),
]);

const CapabilityInspectOutputSchema = z.discriminatedUnion("view", [
  z.strictObject({
    view: z.literal("list"),
    ...PaginationOutputFields,
    capabilities: z.array(
      z.strictObject({
        definition: CapabilityDefinitionInspectionSchema,
        binding: CapabilityBindingSchema.nullable(),
        currentRevision: CapabilityRevisionSummarySchema.nullable(),
      }),
    ),
  }),
  z.strictObject({
    view: z.literal("detail"),
    capability: z
      .strictObject({
        definition: CapabilityDefinitionInspectionSchema,
        binding: CapabilityBindingSchema.nullable(),
        currentRevision: CapabilityRevisionSummarySchema.nullable(),
        revisionCount: z.number().int().nonnegative(),
        feedbackCount: z.number().int().nonnegative(),
        gateCount: z.number().int().nonnegative(),
        /** The editable SKILL.md for this Capability. Direct edits apply from the next turn. */
        file: z.string().nullable(),
        /** The editable folder and what its current revision pins there. */
        folder: z
          .strictObject({
            path: z.string(),
            digest: z.string().nullable(),
            files: z.array(z.string()),
            programs: z.array(
              z.strictObject({
                mode: z.enum(["script", "workflow"]),
                name: z.string(),
                definitionRevisionId: z.string(),
              }),
            ),
          })
          .nullable(),
        /** How the current revision did in turns that used it, as judged by reflection. */
        trackRecord: z.strictObject({
          helped: z.number().int().nonnegative(),
          hurt: z.number().int().nonnegative(),
          unclear: z.number().int().nonnegative(),
        }),
        recentOutcomes: z.array(
          z.strictObject({
            capabilityRevisionId: z.string(),
            turnId: z.string(),
            result: z.enum(["helped", "hurt", "unclear"]),
            reason: z.string(),
            createdAt: z.string(),
            evidenceRefs: z.array(EvidenceRefSchema),
          }),
        ),
      })
      .nullable(),
  }),
  z.strictObject({
    view: z.literal("revisions"),
    ...LifecyclePaginationOutputFields,
    revisions: z.array(CapabilityRevisionInspectionSchema),
  }),
  z.strictObject({
    view: z.literal("feedback"),
    ...LifecyclePaginationOutputFields,
    feedback: z.array(CapabilityFeedbackInspectionSchema),
  }),
  z.strictObject({
    view: z.literal("gates"),
    ...LifecyclePaginationOutputFields,
    gates: z.array(CapabilityGateInspectionSchema),
  }),
  z.strictObject({
    view: z.literal("material"),
    material: z
      .strictObject({
        capabilityId: z.string(),
        capabilityRevisionId: z.string(),
        effectIndex: z.number().int().nonnegative(),
        kind: z.enum(["instruction", "program"]),
        name: z.string().nullable(),
        mode: z.enum(["script", "workflow"]).nullable(),
        revision: FileRevisionRefSchema,
        content: z.string(),
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        totalCharacters: z.number().int().nonnegative(),
        truncated: z.boolean(),
        nextStart: z.number().int().nonnegative().nullable(),
      })
      .nullable(),
  }),
  z.strictObject({
    view: z.literal("file"),
    file: z
      .strictObject({
        capabilityId: z.string(),
        capabilityRevisionId: z.string(),
        path: z.string(),
        revision: FileRevisionRefSchema,
        content: z.string(),
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        totalCharacters: z.number().int().nonnegative(),
        truncated: z.boolean(),
        nextStart: z.number().int().nonnegative().nullable(),
      })
      .nullable(),
  }),
]);

const CapabilityExportInputSchema = z.strictObject({
  capabilityId: z.string().trim().min(1),
  /** Defaults to the current revision. */
  capabilityRevisionId: z.string().trim().min(1).optional(),
  /** A new or empty directory. A relative path starts at the project root. */
  destination: z.string().trim().min(1),
});
const CapabilityExportOutputSchema = z.strictObject({
  destination: z.string(),
  capabilityRevisionId: z.string(),
  folderDigest: z.string().nullable(),
  files: z.array(z.string()),
});

export interface CreateCapabilityToolsOptions {
  readonly workspace: NoesisWorkspaceStore;
  /** The Noesis home, so inspection can name each Capability's editable file. */
  readonly home?: string;
  readonly project: ProjectRef;
  readonly plan: FrozenTurnPlan;
  readonly publisher: CapabilityPublisher;
  readonly programResolver: Pick<CapabilityProgramLibrary, "resolve">;
  readonly isSubAgentExecution: (executionId: string) => boolean;
}

function definitionInspection(definition: CapabilityDefinition) {
  return Object.freeze({
    capabilityId: definition.capabilityId,
    name: definition.name,
    description: definition.description,
    applicability: definition.applicability,
    createdAt: definition.createdAt,
  });
}

function effectInspection(effect: CapabilityEffect, effectIndex: number) {
  return Object.freeze({
    effectIndex,
    kind: effect.kind,
    name: effect.kind === "program" ? effect.program.name : null,
    project: effect.kind === "program" ? (effect.program.project ?? null) : null,
    programScope: effect.kind === "program" ? (effect.program.project ? "project" : "global") : null,
    mode: effect.kind === "program" ? effect.program.mode : null,
    revision: effect.kind === "instruction" ? effect.material : effect.program.definitionRevision,
  });
}

function revisionInspection(revision: CapabilityLifecycleRevision) {
  return Object.freeze({
    reference: revision.reference,
    predecessorRevisionId: revision.revision.predecessorRevisionId ?? null,
    summary: revision.summary,
    rationale: revision.rationale,
    anticipatedEffect: revision.anticipatedEffect,
    effects: revision.revision.effects.map(effectInspection),
    evidenceRefs: revision.revision.evidenceRefs,
    createdAt: revision.createdAt,
  });
}

function feedbackInspection(feedback: CapabilityFeedback) {
  return Object.freeze({ ...feedback });
}

function gateInspection(gate: CapabilityGateRequest) {
  return Object.freeze({
    ...gate,
    instruction: gate.instruction ?? null,
    settledAt: gate.settledAt ?? null,
  });
}

function encodeLifecycleCursor(cursor: CapabilityLifecyclePageCursor | undefined): string | null {
  return cursor
    ? Buffer.from(JSON.stringify(CapabilityLifecycleCursorSchema.parse(cursor)), "utf8").toString("base64url")
    : null;
}

function decodeLifecycleCursor(cursor: string | undefined): CapabilityLifecyclePageCursor | undefined {
  if (!cursor) return undefined;
  try {
    return CapabilityLifecycleCursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
  } catch {
    throw new Error("Invalid Capability lifecycle cursor");
  }
}

function lifecyclePageRequest(capabilityId: string, limit: number, cursor: string | undefined) {
  const after = decodeLifecycleCursor(cursor);
  return after ? Object.freeze({ capabilityId, limit, after }) : Object.freeze({ capabilityId, limit });
}

function revisionSummary(revision: CapabilityLifecycleRevision | undefined) {
  return revision
    ? Object.freeze({
        reference: revision.reference,
        summary: revision.summary,
        rationale: revision.rationale,
        anticipatedEffect: revision.anticipatedEffect,
        effectKinds: revision.revision.effects.map((effect) => effect.kind),
        createdAt: revision.createdAt,
      })
    : null;
}

/**
 * The real directory an export writes to. Symbolic links in existing ancestors are resolved, so the
 * path that is authorized is the path that is written.
 */
function exportDestination(project: ProjectRef, destination: string): string {
  const requested = isAbsolute(destination) ? resolve(destination) : resolve(project.root, destination);
  let existing = requested;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return resolve(realpathSync(existing), relative(existing, requested));
}

/** A Capability revision as a self-contained folder. A folder holds its Programs, so copy any pinned one in. */
async function capabilityExportFiles(
  workspace: NoesisWorkspaceStore,
  lifecycle: CapabilityLifecycleRevision,
): Promise<readonly { readonly path: string; readonly bytes: Uint8Array }[]> {
  const document = capabilityDocumentRevision(lifecycle);
  const folderName = capabilityWorkingFolderPath(document).split("/").at(-1) ?? "capability";
  const pinned = await Promise.all(
    capabilityFolderFiles(lifecycle).map(async ({ path, revision }) => {
      const stored = await workspace.reads.readRevision(revision);
      return Object.freeze({
        path,
        bytes:
          lifecycle.revision.folder || path !== "SKILL.md"
            ? stored
            : new TextEncoder().encode(capabilityDocumentInFolderFormat(folderName, decoder.decode(stored))),
      });
    }),
  );
  const paths = new Set(pinned.map((file) => file.path));
  const attached = await Promise.all(
    lifecycle.revision.effects.map(async (effect) =>
      effect.kind === "program"
        ? await folderProgramFilesForExport(workspace, effect.program.definitionRevision)
        : [],
    ),
  );
  const copied = attached.flat();
  const collision = copied.find((file) => paths.has(file.path));
  if (collision)
    throw new Error(`The folder already has ${collision.path}, so the attached Program cannot be copied in`);
  return Object.freeze([...pinned, ...copied]);
}

/** The complete progressively disclosed Capability surface for one frozen foreground turn. */
export function createCapabilityTools(options: CreateCapabilityToolsOptions): readonly ToolDefinition[] {
  const capabilityFile = (revision: CapabilityLifecycleRevision | undefined): string | null => {
    if (!revision) return null;
    const path = capabilityWorkingDocumentPath(capabilityDocumentRevision(revision));
    return options.home ? join(options.home, path) : path;
  };
  const folderInspection = (revision: CapabilityLifecycleRevision | undefined) => {
    if (!revision) return null;
    const path = capabilityWorkingFolderPath(capabilityDocumentRevision(revision));
    return {
      path: options.home ? join(options.home, path) : path,
      digest: revision.revision.folder?.digest ?? null,
      files: capabilityFolderFiles(revision).map((file) => file.path),
      programs: (revision.revision.folder?.programs ?? []).map((program) => ({
        mode: program.mode,
        name: program.name,
        definitionRevisionId: program.definitionRevision.revisionId,
      })),
    };
  };
  const inspect = defineTool({
    name: "capabilities.inspect",
    label: "Inspect Capabilities",
    description:
      "Inspect current Capability definitions and bindings, then progressively load one lifecycle or exact effect material.",
    inputSchema: CapabilityInspectInputSchema,
    outputSchema: CapabilityInspectOutputSchema,
    effect: (input) => ({
      effect: "read",
      resource: input.view === "list" ? "capability:index" : `capability:${input.capabilityId}`,
      estimatedCost: 0,
    }),
    execute: async (input) => {
      if (input.view === "list") {
        const cursor = input.cursor ?? 0;
        const limit = input.limit ?? DEFAULT_INSPECTION_PAGE_SIZE;
        const definitions = [...(await options.workspace.capabilities.listDefinitions())].sort(
          (left, right) =>
            left.name.localeCompare(right.name) || left.capabilityId.localeCompare(right.capabilityId),
        );
        const page = definitions.slice(cursor, cursor + limit);
        const bindings = await options.workspace.capabilities.getBindings(
          page.map((definition) => definition.capabilityId),
        );
        const bindingById = new Map(bindings.map((binding) => [binding.capabilityId, binding] as const));
        const capabilities = await Promise.all(
          page.map(async (definition) => {
            const binding = bindingById.get(definition.capabilityId);
            const lifecycle = binding
              ? await options.workspace.capabilities.getRevision(binding.revision)
              : undefined;
            return {
              definition: definitionInspection(definition),
              binding: binding ?? null,
              currentRevision: revisionSummary(lifecycle),
            };
          }),
        );
        return CapabilityInspectOutputSchema.parse({
          view: "list",
          total: definitions.length,
          cursor,
          limit,
          nextCursor: cursor + page.length < definitions.length ? cursor + page.length : null,
          capabilities,
        });
      }
      if (input.view === "detail") {
        const definition = await options.workspace.capabilities.getDefinition(input.capabilityId);
        if (!definition) return CapabilityInspectOutputSchema.parse({ view: "detail", capability: null });
        const [binding, counts] = await Promise.all([
          options.workspace.capabilities.getBinding(input.capabilityId),
          options.workspace.capabilities.countLifecycle(input.capabilityId),
        ]);
        const currentRevision = binding
          ? await options.workspace.capabilities.getRevision(binding.revision)
          : undefined;
        const [records, recentOutcomes] = await Promise.all([
          options.workspace.capabilities.trackRecords(binding ? [binding.revision.capabilityRevisionId] : []),
          options.workspace.capabilities.listOutcomes(input.capabilityId, 10),
        ]);
        const record = binding ? records.get(binding.revision.capabilityRevisionId) : undefined;
        return CapabilityInspectOutputSchema.parse({
          view: "detail",
          capability: {
            definition: definitionInspection(definition),
            binding: binding ?? null,
            currentRevision: revisionSummary(currentRevision),
            revisionCount: counts.revisions,
            feedbackCount: counts.feedback,
            gateCount: counts.gates,
            file: capabilityFile(currentRevision),
            folder: folderInspection(currentRevision),
            trackRecord: {
              helped: record?.helped ?? 0,
              hurt: record?.hurt ?? 0,
              unclear: record?.unclear ?? 0,
            },
            recentOutcomes: recentOutcomes.map((outcome) => ({
              capabilityRevisionId: outcome.capabilityRevisionId,
              turnId: outcome.turnId,
              result: outcome.result,
              reason: outcome.reason,
              createdAt: outcome.createdAt,
              evidenceRefs: [...outcome.evidenceRefs],
            })),
          },
        });
      }
      if (input.view === "revisions") {
        const limit = input.limit ?? DEFAULT_INSPECTION_PAGE_SIZE;
        const [page, counts] = await Promise.all([
          options.workspace.capabilities.listRevisionPage(
            lifecyclePageRequest(input.capabilityId, limit, input.cursor),
          ),
          options.workspace.capabilities.countLifecycle(input.capabilityId),
        ]);
        return CapabilityInspectOutputSchema.parse({
          view: "revisions",
          total: counts.revisions,
          cursor: input.cursor ?? null,
          limit,
          nextCursor: encodeLifecycleCursor(page.nextCursor),
          revisions: page.items.map(revisionInspection),
        });
      }
      if (input.view === "feedback") {
        const limit = input.limit ?? DEFAULT_INSPECTION_PAGE_SIZE;
        const [page, counts] = await Promise.all([
          options.workspace.capabilities.listFeedbackPage(
            lifecyclePageRequest(input.capabilityId, limit, input.cursor),
          ),
          options.workspace.capabilities.countLifecycle(input.capabilityId),
        ]);
        return CapabilityInspectOutputSchema.parse({
          view: "feedback",
          total: counts.feedback,
          cursor: input.cursor ?? null,
          limit,
          nextCursor: encodeLifecycleCursor(page.nextCursor),
          feedback: page.items.map(feedbackInspection),
        });
      }
      if (input.view === "gates") {
        const limit = input.limit ?? DEFAULT_INSPECTION_PAGE_SIZE;
        const [page, counts] = await Promise.all([
          options.workspace.capabilities.listGatePage(
            lifecyclePageRequest(input.capabilityId, limit, input.cursor),
          ),
          options.workspace.capabilities.countLifecycle(input.capabilityId),
        ]);
        return CapabilityInspectOutputSchema.parse({
          view: "gates",
          total: counts.gates,
          cursor: input.cursor ?? null,
          limit,
          nextCursor: encodeLifecycleCursor(page.nextCursor),
          gates: page.items.map(gateInspection),
        });
      }
      const lifecycle = await options.workspace.capabilities.getRevisionById(
        input.capabilityId,
        input.capabilityRevisionId,
      );
      if (input.view === "file") {
        const pinned = lifecycle
          ? capabilityFolderFiles(lifecycle).find((file) => file.path === input.path)
          : undefined;
        if (!pinned) return CapabilityInspectOutputSchema.parse({ view: "file", file: null });
        const bytes = await options.workspace.reads.readRevision(pinned.revision);
        let content: string;
        try {
          content = decoder.decode(bytes);
        } catch {
          throw new Error(
            `Capability file ${pinned.path} is not UTF-8 text (${String(bytes.byteLength)} bytes), so it cannot be shown as text`,
          );
        }
        const start = Math.min(input.start ?? 0, content.length);
        const end = Math.min(start + (input.maxCharacters ?? DEFAULT_MATERIAL_CHARACTERS), content.length);
        return CapabilityInspectOutputSchema.parse({
          view: "file",
          file: {
            capabilityId: input.capabilityId,
            capabilityRevisionId: input.capabilityRevisionId,
            path: pinned.path,
            revision: pinned.revision,
            content: content.slice(start, end),
            start,
            end,
            totalCharacters: content.length,
            truncated: end < content.length,
            nextStart: end < content.length ? end : null,
          },
        });
      }
      const effect = lifecycle?.revision.effects[input.effectIndex];
      if (!lifecycle || !effect)
        return CapabilityInspectOutputSchema.parse({ view: "material", material: null });
      const revision = effect.kind === "instruction" ? effect.material : effect.program.definitionRevision;
      const content = decoder.decode(await options.workspace.reads.readRevision(revision));
      const start = Math.min(input.start ?? 0, content.length);
      const end = Math.min(start + (input.maxCharacters ?? DEFAULT_MATERIAL_CHARACTERS), content.length);
      return CapabilityInspectOutputSchema.parse({
        view: "material",
        material: {
          capabilityId: input.capabilityId,
          capabilityRevisionId: input.capabilityRevisionId,
          effectIndex: input.effectIndex,
          kind: effect.kind,
          name: effect.kind === "program" ? effect.program.name : null,
          mode: effect.kind === "program" ? effect.program.mode : null,
          revision,
          content: content.slice(start, end),
          start,
          end,
          totalCharacters: content.length,
          truncated: end < content.length,
          nextStart: end < content.length ? end : null,
        },
      });
    },
  });

  const refine = defineTool({
    name: "capabilities.refine",
    label: "Refine Capability",
    description:
      "Publish one complete foreground Capability decision exactly as authored. The host supplies authoritative turn evidence and performs immutable recording, stale-write checks, gating, and binding updates without another model call.",
    inputSchema: CapabilityDecisionSchema,
    outputSchema: CapabilityPublicationResultSchema,
    effect: (decision) => ({
      effect: decision.decision === "no_change" ? "read" : "write",
      resource:
        decision.decision === "create" || decision.decision === "no_change"
          ? "capability:new"
          : `capability:${decision.capabilityId}`,
      estimatedCost: decision.decision === "no_change" ? 0 : 1,
    }),
    execute: async (decision, context) => {
      if (options.isSubAgentExecution(context.executionId))
        throw new Error("Subagents may inspect and advise, but cannot publish Capability changes");
      const currentCall = await options.workspace.operational.toolCalls.get(context.callId);
      if (
        !currentCall ||
        currentCall.sessionId !== options.plan.sessionId ||
        currentCall.turnId !== options.plan.turnId ||
        currentCall.executionId !== context.executionId ||
        currentCall.sequence === undefined
      )
        throw new Error("Foreground Capability publication requires its durable tool-call identity");
      const currentSequence = currentCall.sequence;
      const turnCalls = await options.workspace.operational.toolCalls.listForTurn(
        options.plan.sessionId,
        options.plan.turnId,
      );
      const refinementCalls = turnCalls
        .filter((call) => call.toolName === "capabilities.refine")
        .sort(
          (left, right) =>
            (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER),
        );
      if (refinementCalls[0]?.toolCallId !== context.callId)
        throw new Error("Only one foreground Capability decision may be published per turn");
      const userMessage = await options.workspace.operational.messages.get(`${options.plan.turnId}:user`);
      if (
        !userMessage ||
        userMessage.sessionId !== options.plan.sessionId ||
        userMessage.sensitivity !== "normal"
      )
        throw new Error("Foreground Capability publication requires normal-sensitivity turn evidence");
      const causallyPriorCallIds = new Set(context.causallyPriorCallIds ?? []);
      const priorCalls = (await options.workspace.operational.toolCalls.listForExecution(context.executionId))
        .filter(
          (call) =>
            causallyPriorCallIds.has(call.toolCallId) &&
            call.sessionId === options.plan.sessionId &&
            call.turnId === options.plan.turnId &&
            call.sequence !== undefined &&
            call.sequence < currentSequence &&
            call.sensitivity === "normal" &&
            call.status === "completed",
        )
        .sort(
          (left, right) =>
            (left.sequence ?? 0) - (right.sequence ?? 0) || left.createdAt.localeCompare(right.createdAt),
        )
        .slice(-31);
      const evidenceRefs = Object.freeze([
        Object.freeze({
          kind: "database_row" as const,
          table: "messages" as const,
          rowId: `${options.plan.turnId}:user`,
        }),
        ...priorCalls.map((call) =>
          Object.freeze({
            kind: "database_row" as const,
            table: "tool_calls" as const,
            rowId: call.toolCallId,
          }),
        ),
      ]);
      const interpretation =
        decision.decision === "create" || decision.decision === "revise"
          ? decision.proposal.rationale
          : decision.reason;
      return await options.publisher.publish(
        decision,
        {
          project: options.project,
          sessionId: options.plan.sessionId,
          evidenceRefs,
          actor: Object.freeze({
            actorId: "foreground-capability-author",
            kind: "noesis" as const,
          }),
          interpretation,
          programResolver: options.programResolver,
        },
        context.signal,
      );
    },
  });

  const exportFolder = defineTool({
    name: "capabilities.export",
    label: "Export Capability",
    description:
      "Copy one exact Capability revision to a new folder as a standard skill. Its pinned files keep their recorded bytes, and an attached saved Program is copied into programs/, so the folder needs nothing else. Only the copy changes; the Capability does not.",
    inputSchema: CapabilityExportInputSchema,
    outputSchema: CapabilityExportOutputSchema,
    effect: ({ destination }) => {
      const target = exportDestination(options.project, destination);
      return { effect: "write", resource: `file:${target}/*`, estimatedCost: 1 };
    },
    execute: async ({ capabilityId, capabilityRevisionId, destination }) => {
      const binding = await options.workspace.capabilities.getBinding(capabilityId);
      const lifecycle = capabilityRevisionId
        ? await options.workspace.capabilities.getRevisionById(capabilityId, capabilityRevisionId)
        : binding
          ? await options.workspace.capabilities.getRevision(binding.revision)
          : undefined;
      if (!lifecycle) throw new Error(`Unknown Capability revision for ${capabilityId}`);
      const target = exportDestination(options.project, destination);
      const existing = await readdir(target).catch(() => undefined);
      if (existing && existing.length > 0) throw new Error(`Export destination ${target} is not empty`);
      if (!existing && (await stat(target).catch(() => undefined)))
        throw new Error(`Export destination ${target} is not a directory`);
      const files = await capabilityExportFiles(options.workspace, lifecycle);
      const written: string[] = [];
      try {
        for (const file of files) {
          const absolute = join(target, file.path);
          await mkdir(dirname(absolute), { recursive: true });
          const handle = await openFile(absolute, "wx", 0o644);
          try {
            await handle.writeFile(file.bytes);
          } finally {
            await handle.close();
          }
          written.push(file.path);
        }
      } catch (error) {
        // A partial copy is not a usable skill, so leave nothing behind. The destination was empty or
        // absent, so everything in it is ours; a directory that already existed stays.
        if (existing)
          for (const entry of await readdir(target).catch(() => []))
            await rm(join(target, entry), { recursive: true, force: true });
        else await rm(target, { recursive: true, force: true });
        throw error;
      }
      return {
        destination: target,
        capabilityRevisionId: lifecycle.revision.capabilityRevisionId,
        folderDigest: lifecycle.revision.folder?.digest ?? null,
        files: written,
      };
    },
  });

  return Object.freeze([inspect, refine, exportFolder]);
}
