import {
  EvidenceRefSchema,
  FileRevisionRefSchema,
  canonicalJson,
  createId,
  databaseRowRefSchema,
  err,
  ok,
  sha256,
  type ActorRef,
  type CapabilityRevisionRef,
  type DefinitionWriteRequest,
  type DefinitionMetadataRecord,
  type EvidenceRef,
  type FileRevisionRef,
  type Result,
  type WorkspaceStore,
} from "@noesis/domain";
import { z } from "zod";

export const CriterionSourceSchema = z.enum(["explicit_statement", "correction", "expert_command"]);
export type CriterionSource = z.infer<typeof CriterionSourceSchema>;

export const CriterionPromptOwnershipSchema = z.strictObject({
  owner: z.literal("user"),
  layer: z.enum(["user_constitution", "learned_profile"]),
});
export type CriterionPromptOwnership = Readonly<z.infer<typeof CriterionPromptOwnershipSchema>>;

export interface UserCriterionDefinition {
  readonly kind: "user_evaluation_criterion";
  readonly criterionId: string;
  readonly revision: number;
  readonly status: "active" | "retired";
  readonly source: CriterionSource;
  readonly scope: string;
  readonly evaluatorInstruction: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly promptOwnership: CriterionPromptOwnership;
  readonly pinned: boolean;
}

export const UserCriterionDefinitionSchema: z.ZodType<UserCriterionDefinition> = z.strictObject({
  kind: z.literal("user_evaluation_criterion"),
  criterionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  revision: z.number().int().positive(),
  status: z.enum(["active", "retired"]),
  source: CriterionSourceSchema,
  scope: z.string().min(1),
  evaluatorInstruction: z.string().min(1),
  evidenceRefs: z.array(EvidenceRefSchema),
  promptOwnership: CriterionPromptOwnershipSchema,
  pinned: z.boolean(),
});

export const CriterionRevisionMetadataSchema = z.strictObject({
  criterionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  revision: z.number().int().positive(),
  definitionRevision: FileRevisionRefSchema,
  fileRevisionRow: databaseRowRefSchema("file_revisions"),
  activityRow: databaseRowRefSchema("activity_log"),
  predecessorRevisionId: z.string().min(1).optional(),
});
export type CriterionRevisionMetadata = Readonly<z.infer<typeof CriterionRevisionMetadataSchema>>;

export interface CriterionRevisionCommitRequest {
  readonly criterionId: string;
  readonly revision: number;
  readonly definitionRevision: FileRevisionRef;
  readonly expectedCurrentRevisionId?: string;
  readonly activity: {
    readonly kind: "created" | "revised" | "retired" | "pinned" | "unpinned";
    readonly actor: ActorRef;
    readonly reason?: string;
  };
}

export interface CriterionMetadataConflict {
  readonly code: "conflict";
  readonly message: string;
}

/** SQLite-backed implementations validate and commit the revision pointer and activity row together. */
export interface UserCriterionMetadataPort {
  readonly getCurrent: (criterionId: string) => Promise<unknown | undefined>;
  readonly listCurrent: () => Promise<readonly unknown[]>;
  readonly listRevisions: (criterionId: string) => Promise<readonly unknown[]>;
  readonly commitRevision?: (
    request: CriterionRevisionCommitRequest,
  ) => Promise<Result<unknown, CriterionMetadataConflict>>;
}

/** Compatible with WorkspaceStore definition and revision reads without owning workspace persistence. */
export interface UserCriterionDefinitionPort {
  readonly recordWorkingDefinition: (request: DefinitionWriteRequest) => Promise<FileRevisionRef>;
  readonly readRevision: (ref: FileRevisionRef) => Promise<Uint8Array>;
}

export interface UserCriterionPublicationPort {
  readonly publishRevision: (
    request: Omit<CriterionRevisionCommitRequest, "definitionRevision"> & {
      readonly workingPath: string;
      readonly bytes: Uint8Array;
      readonly evidenceRefs: readonly EvidenceRef[];
    },
  ) => Promise<Result<unknown, CriterionMetadataConflict>>;
}

export type UserCriterionErrorCode =
  | "already_exists"
  | "conflict"
  | "invalid_definition"
  | "invalid_metadata"
  | "not_found"
  | "pinned"
  | "storage_error";

export interface UserCriterionError {
  readonly code: UserCriterionErrorCode;
  readonly message: string;
  readonly criterionId?: string;
  readonly revision?: number;
}

export interface UserCriterionReadModel {
  readonly definition: UserCriterionDefinition;
  readonly metadata: CriterionRevisionMetadata;
}

export interface CreateUserCriterionInput {
  readonly criterionId?: string;
  readonly source: CriterionSource;
  readonly scope: string;
  readonly evaluatorInstruction: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly promptOwnership?: CriterionPromptOwnership;
  readonly pinned?: boolean;
  readonly actor: ActorRef;
  readonly reason?: string;
}

export interface ReviseUserCriterionInput {
  readonly criterionId: string;
  readonly scope?: string;
  readonly evaluatorInstruction?: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly promptOwnership?: CriterionPromptOwnership;
  readonly actor: ActorRef;
  readonly reason?: string;
}

export interface CriterionRelevanceSnapshotInput {
  readonly snapshotId: string;
  readonly scope: string;
  readonly candidateRevision?: CapabilityRevisionRef;
  readonly selectedCriterionIds?: readonly string[];
}

export interface RelevantCriterionSnapshot {
  readonly criterionId: string;
  readonly revision: number;
  readonly scope: string;
  readonly evaluatorInstruction: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly promptOwnership: CriterionPromptOwnership;
  readonly definitionRevision: FileRevisionRef;
}

export interface CriterionRelevanceSnapshot {
  readonly snapshotId: string;
  readonly scope: string;
  readonly candidateRevision?: CapabilityRevisionRef;
  readonly selectedCriterionIds: readonly string[];
  readonly criteria: readonly RelevantCriterionSnapshot[];
  readonly snapshotDigest: string;
}

export interface UserCriterionRepository {
  readonly create: (
    input: CreateUserCriterionInput,
  ) => Promise<Result<UserCriterionReadModel, UserCriterionError>>;
  readonly list: () => Promise<Result<readonly UserCriterionReadModel[], UserCriterionError>>;
  readonly inspect: (
    criterionId: string,
    revision?: number,
  ) => Promise<Result<UserCriterionReadModel, UserCriterionError>>;
  readonly revise: (
    input: ReviseUserCriterionInput,
  ) => Promise<Result<UserCriterionReadModel, UserCriterionError>>;
  readonly retire: (
    criterionId: string,
    actor: ActorRef,
    reason?: string,
  ) => Promise<Result<UserCriterionReadModel, UserCriterionError>>;
  readonly pin: (
    criterionId: string,
    pinned: boolean,
    actor: ActorRef,
    reason?: string,
  ) => Promise<Result<UserCriterionReadModel, UserCriterionError>>;
  readonly snapshotRelevant: (
    input: CriterionRelevanceSnapshotInput,
  ) => Promise<Result<CriterionRelevanceSnapshot, UserCriterionError>>;
}

export interface UserCriterionRepositoryOptions {
  readonly definitions: UserCriterionDefinitionPort;
  readonly metadata: UserCriterionMetadataPort;
  readonly publications?: UserCriterionPublicationPort;
  readonly nextCriterionId?: () => string;
}

const USER_CRITERION_NAMESPACE = "user_criterion";

function criterionMetadataFromStored(record: DefinitionMetadataRecord): CriterionRevisionMetadata {
  return {
    criterionId: record.definitionId,
    revision: record.revision,
    definitionRevision: record.definitionRevision,
    fileRevisionRow: record.fileRevisionRow,
    activityRow: record.activityRow,
    ...(record.predecessorRevisionId === undefined
      ? {}
      : { predecessorRevisionId: record.predecessorRevisionId }),
  };
}

/** Connects the criterion repository to WorkspaceStore's file bytes and SQLite current pointers. */
export function createWorkspaceUserCriterionPorts(
  workspace: Pick<WorkspaceStore, "definitions" | "definitionMetadata" | "definitionPublications" | "reads">,
): Pick<UserCriterionRepositoryOptions, "definitions" | "metadata" | "publications"> {
  return Object.freeze({
    definitions: Object.freeze({
      recordWorkingDefinition: workspace.definitions.recordWorkingDefinition,
      readRevision: workspace.reads.readRevision,
    }),
    publications: Object.freeze({
      publishRevision: async (
        request: Omit<CriterionRevisionCommitRequest, "definitionRevision"> & {
          readonly workingPath: string;
          readonly bytes: Uint8Array;
          readonly evidenceRefs: readonly EvidenceRef[];
        },
      ) => {
        const committed = await workspace.definitionPublications.publish({
          namespace: USER_CRITERION_NAMESPACE,
          definitionId: request.criterionId,
          revision: request.revision,
          workingPath: request.workingPath,
          bytes: request.bytes,
          ...(request.expectedCurrentRevisionId === undefined
            ? {}
            : { expectedCurrentRevisionId: request.expectedCurrentRevisionId }),
          sensitivity: "normal",
          provenanceRefs: request.evidenceRefs,
          activity: {
            kind: `criterion.${request.activity.kind}`,
            actor: request.activity.actor,
            ...(request.activity.reason === undefined ? {} : { reason: request.activity.reason }),
          },
        });
        return committed.ok
          ? ok(criterionMetadataFromStored(committed.value))
          : err({ code: "conflict" as const, message: committed.error.message });
      },
    }),
    metadata: Object.freeze({
      getCurrent: async (criterionId: string) => {
        const record = await workspace.definitionMetadata.getCurrent(USER_CRITERION_NAMESPACE, criterionId);
        return record === undefined ? undefined : criterionMetadataFromStored(record);
      },
      listCurrent: async () =>
        (await workspace.definitionMetadata.listCurrent(USER_CRITERION_NAMESPACE)).map(
          criterionMetadataFromStored,
        ),
      listRevisions: async (criterionId: string) =>
        (await workspace.definitionMetadata.listRevisions(USER_CRITERION_NAMESPACE, criterionId)).map(
          criterionMetadataFromStored,
        ),
    }),
  });
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf8", { fatal: true });

function criterionError(
  code: UserCriterionErrorCode,
  message: string,
  criterionId?: string,
  revision?: number,
): UserCriterionError {
  return {
    code,
    message,
    ...(criterionId ? { criterionId } : {}),
    ...(revision === undefined ? {} : { revision }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderDefinition(definition: UserCriterionDefinition): Uint8Array {
  return textEncoder.encode(`${JSON.stringify(definition, null, 2)}\n`);
}

function freezeDefinition(definition: UserCriterionDefinition): UserCriterionDefinition {
  return Object.freeze({
    ...definition,
    evidenceRefs: Object.freeze(definition.evidenceRefs.map((ref) => Object.freeze({ ...ref }))),
    promptOwnership: Object.freeze({ ...definition.promptOwnership }),
  });
}

function freezeMetadata(metadata: CriterionRevisionMetadata): CriterionRevisionMetadata {
  return Object.freeze({
    ...metadata,
    definitionRevision: Object.freeze({ ...metadata.definitionRevision }),
    fileRevisionRow: Object.freeze({ ...metadata.fileRevisionRow }),
    activityRow: Object.freeze({ ...metadata.activityRow }),
  });
}

function decodeMetadata(
  value: unknown,
  criterionId?: string,
): Result<CriterionRevisionMetadata, UserCriterionError> {
  const parsed = CriterionRevisionMetadataSchema.safeParse(value);
  if (parsed.success) return ok(freezeMetadata(parsed.data));
  return err(
    criterionError(
      "invalid_metadata",
      `Invalid criterion revision metadata: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
      criterionId,
    ),
  );
}

function decodeDefinition(
  bytes: Uint8Array,
  metadata: CriterionRevisionMetadata,
): Result<UserCriterionDefinition, UserCriterionError> {
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(bytes));
  } catch (error) {
    return err(
      criterionError(
        "invalid_definition",
        `Criterion revision ${metadata.definitionRevision.revisionId} is not valid UTF-8 JSON: ${errorMessage(error)}`,
        metadata.criterionId,
        metadata.revision,
      ),
    );
  }
  const parsed = UserCriterionDefinitionSchema.safeParse(value);
  if (!parsed.success) {
    return err(
      criterionError(
        "invalid_definition",
        `Criterion revision ${metadata.definitionRevision.revisionId} has an invalid definition: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
        metadata.criterionId,
        metadata.revision,
      ),
    );
  }
  if (
    parsed.data.criterionId !== metadata.criterionId ||
    parsed.data.revision !== metadata.revision ||
    !isCriterionWorkingPath(metadata.definitionRevision.workingPath, metadata.criterionId)
  ) {
    return err(
      criterionError(
        "invalid_definition",
        "Criterion definition identity does not match its authoritative revision metadata",
        metadata.criterionId,
        metadata.revision,
      ),
    );
  }
  return ok(freezeDefinition(parsed.data));
}

function criterionWorkingPath(criterionId: string): string {
  return `config/criteria/${criterionId}.json`;
}

function isCriterionWorkingPath(workingPath: string, criterionId: string): boolean {
  const expected = criterionWorkingPath(criterionId);
  return workingPath === expected || workingPath === `definitions/${expected}`;
}

function sameFileRevision(left: FileRevisionRef, right: FileRevisionRef): boolean {
  return (
    left.revisionId === right.revisionId &&
    left.workingPath === right.workingPath &&
    left.snapshotPath === right.snapshotPath &&
    left.contentDigest === right.contentDigest
  );
}

function isRelevant(criterionScope: string, targetScope: string): boolean {
  return (
    criterionScope === "*" || criterionScope === targetScope || targetScope.startsWith(`${criterionScope}/`)
  );
}

export function createUserCriterionRepository(
  options: UserCriterionRepositoryOptions,
): UserCriterionRepository {
  const loadModel = async (
    metadataValue: unknown,
    expectedCriterionId?: string,
  ): Promise<Result<UserCriterionReadModel, UserCriterionError>> => {
    const decodedMetadata = decodeMetadata(metadataValue, expectedCriterionId);
    if (!decodedMetadata.ok) return decodedMetadata;
    if (expectedCriterionId !== undefined && decodedMetadata.value.criterionId !== expectedCriterionId) {
      return err(
        criterionError(
          "invalid_metadata",
          "Criterion metadata points to a different criterion",
          expectedCriterionId,
        ),
      );
    }
    try {
      const bytes = await options.definitions.readRevision(decodedMetadata.value.definitionRevision);
      const decodedDefinition = decodeDefinition(bytes, decodedMetadata.value);
      if (!decodedDefinition.ok) return decodedDefinition;
      return ok(Object.freeze({ definition: decodedDefinition.value, metadata: decodedMetadata.value }));
    } catch (error) {
      return err(
        criterionError(
          "storage_error",
          `Could not read criterion revision: ${errorMessage(error)}`,
          decodedMetadata.value.criterionId,
          decodedMetadata.value.revision,
        ),
      );
    }
  };

  const inspect = async (
    criterionId: string,
    revision?: number,
  ): Promise<Result<UserCriterionReadModel, UserCriterionError>> => {
    try {
      const metadataValue =
        revision === undefined
          ? await options.metadata.getCurrent(criterionId)
          : (await options.metadata.listRevisions(criterionId)).find((value) => {
              const parsed = CriterionRevisionMetadataSchema.safeParse(value);
              return parsed.success && parsed.data.revision === revision;
            });
      if (metadataValue === undefined) {
        return err(
          criterionError(
            "not_found",
            revision === undefined
              ? `Criterion ${criterionId} was not found`
              : `Criterion ${criterionId} revision ${revision} was not found`,
            criterionId,
            revision,
          ),
        );
      }
      return await loadModel(metadataValue, criterionId);
    } catch (error) {
      return err(
        criterionError(
          "storage_error",
          `Could not inspect criterion metadata: ${errorMessage(error)}`,
          criterionId,
          revision,
        ),
      );
    }
  };

  const writeRevision = async (
    definition: UserCriterionDefinition,
    predecessor: UserCriterionReadModel | undefined,
    actor: ActorRef,
    activityKind: CriterionRevisionCommitRequest["activity"]["kind"],
    reason?: string,
  ): Promise<Result<UserCriterionReadModel, UserCriterionError>> => {
    const validated = UserCriterionDefinitionSchema.safeParse(definition);
    if (!validated.success) {
      return err(
        criterionError(
          "invalid_definition",
          `Invalid criterion definition: ${validated.error.issues[0]?.message ?? "unknown error"}`,
          definition.criterionId,
          definition.revision,
        ),
      );
    }
    let definitionRevision: FileRevisionRef | undefined;
    let committed: Result<unknown, CriterionMetadataConflict>;
    try {
      if (options.publications) {
        committed = await options.publications.publishRevision({
          criterionId: definition.criterionId,
          revision: definition.revision,
          workingPath: criterionWorkingPath(definition.criterionId),
          bytes: renderDefinition(validated.data),
          evidenceRefs: definition.evidenceRefs,
          ...(predecessor
            ? { expectedCurrentRevisionId: predecessor.metadata.definitionRevision.revisionId }
            : {}),
          activity: { kind: activityKind, actor, ...(reason ? { reason } : {}) },
        });
      } else {
        if (!options.metadata.commitRevision)
          throw new Error("Criterion storage does not provide a coordinated publication port");
        definitionRevision = await options.definitions.recordWorkingDefinition({
          workingPath: criterionWorkingPath(definition.criterionId),
          bytes: renderDefinition(validated.data),
          actor,
          provenanceRefs: definition.evidenceRefs,
          ...(reason ? { reason } : {}),
          ...(predecessor
            ? { predecessorRevisionId: predecessor.metadata.definitionRevision.revisionId }
            : {}),
        });
        committed = await options.metadata.commitRevision({
          criterionId: definition.criterionId,
          revision: definition.revision,
          definitionRevision,
          ...(predecessor
            ? { expectedCurrentRevisionId: predecessor.metadata.definitionRevision.revisionId }
            : {}),
          activity: { kind: activityKind, actor, ...(reason ? { reason } : {}) },
        });
      }
    } catch (error) {
      return err(
        criterionError(
          "storage_error",
          `Could not publish criterion definition: ${errorMessage(error)}`,
          definition.criterionId,
          definition.revision,
        ),
      );
    }

    if (!committed.ok) {
      return err(
        criterionError("conflict", committed.error.message, definition.criterionId, definition.revision),
      );
    }
    const decoded = decodeMetadata(committed.value, definition.criterionId);
    if (!decoded.ok) return decoded;
    if (definitionRevision && !sameFileRevision(decoded.value.definitionRevision, definitionRevision)) {
      return err(
        criterionError(
          "invalid_metadata",
          "Committed criterion metadata does not point to the recorded immutable revision",
          definition.criterionId,
          definition.revision,
        ),
      );
    }
    return await loadModel(decoded.value, definition.criterionId);
  };

  const create = async (
    input: CreateUserCriterionInput,
  ): Promise<Result<UserCriterionReadModel, UserCriterionError>> => {
    const criterionId = input.criterionId ?? options.nextCriterionId?.() ?? createId("criterion");
    try {
      if ((await options.metadata.getCurrent(criterionId)) !== undefined) {
        return err(criterionError("already_exists", `Criterion ${criterionId} already exists`, criterionId));
      }
    } catch (error) {
      return err(
        criterionError(
          "storage_error",
          `Could not check criterion metadata: ${errorMessage(error)}`,
          criterionId,
        ),
      );
    }
    return await writeRevision(
      {
        kind: "user_evaluation_criterion",
        criterionId,
        revision: 1,
        status: "active",
        source: input.source,
        scope: input.scope,
        evaluatorInstruction: input.evaluatorInstruction,
        evidenceRefs: [...input.evidenceRefs],
        promptOwnership: input.promptOwnership ?? { owner: "user", layer: "learned_profile" },
        pinned: input.pinned ?? false,
      },
      undefined,
      input.actor,
      "created",
      input.reason,
    );
  };

  const list = async (): Promise<Result<readonly UserCriterionReadModel[], UserCriterionError>> => {
    let values: readonly unknown[];
    try {
      values = await options.metadata.listCurrent();
    } catch (error) {
      return err(
        criterionError("storage_error", `Could not list criterion metadata: ${errorMessage(error)}`),
      );
    }
    const models: UserCriterionReadModel[] = [];
    for (const value of values) {
      const model = await loadModel(value);
      if (!model.ok) return model;
      models.push(model.value);
    }
    return ok(
      Object.freeze(
        models.sort((left, right) => left.definition.criterionId.localeCompare(right.definition.criterionId)),
      ),
    );
  };

  const revise = async (
    input: ReviseUserCriterionInput,
  ): Promise<Result<UserCriterionReadModel, UserCriterionError>> => {
    const current = await inspect(input.criterionId);
    if (!current.ok) return current;
    if (current.value.definition.pinned && input.actor.kind !== "user") {
      return err(
        criterionError(
          "pinned",
          `Criterion ${input.criterionId} is pinned and cannot be silently superseded`,
          input.criterionId,
          current.value.definition.revision,
        ),
      );
    }
    return await writeRevision(
      {
        ...current.value.definition,
        revision: current.value.definition.revision + 1,
        scope: input.scope ?? current.value.definition.scope,
        evaluatorInstruction: input.evaluatorInstruction ?? current.value.definition.evaluatorInstruction,
        evidenceRefs: input.evidenceRefs ? [...input.evidenceRefs] : current.value.definition.evidenceRefs,
        promptOwnership: input.promptOwnership ?? current.value.definition.promptOwnership,
      },
      current.value,
      input.actor,
      "revised",
      input.reason,
    );
  };

  const retire = async (
    criterionId: string,
    actor: ActorRef,
    reason?: string,
  ): Promise<Result<UserCriterionReadModel, UserCriterionError>> => {
    const current = await inspect(criterionId);
    if (!current.ok) return current;
    if (current.value.definition.pinned && actor.kind !== "user") {
      return err(
        criterionError(
          "pinned",
          `Criterion ${criterionId} is pinned and cannot be silently retired`,
          criterionId,
          current.value.definition.revision,
        ),
      );
    }
    if (current.value.definition.status === "retired") return current;
    return await writeRevision(
      {
        ...current.value.definition,
        revision: current.value.definition.revision + 1,
        status: "retired",
      },
      current.value,
      actor,
      "retired",
      reason,
    );
  };

  const pin = async (
    criterionId: string,
    pinned: boolean,
    actor: ActorRef,
    reason?: string,
  ): Promise<Result<UserCriterionReadModel, UserCriterionError>> => {
    const current = await inspect(criterionId);
    if (!current.ok) return current;
    if (current.value.definition.pinned && !pinned && actor.kind !== "user") {
      return err(
        criterionError(
          "pinned",
          `Criterion ${criterionId} is pinned and cannot be silently unpinned`,
          criterionId,
          current.value.definition.revision,
        ),
      );
    }
    if (current.value.definition.pinned === pinned) return current;
    return await writeRevision(
      {
        ...current.value.definition,
        revision: current.value.definition.revision + 1,
        pinned,
      },
      current.value,
      actor,
      pinned ? "pinned" : "unpinned",
      reason,
    );
  };

  const snapshotRelevant = async (
    input: CriterionRelevanceSnapshotInput,
  ): Promise<Result<CriterionRelevanceSnapshot, UserCriterionError>> => {
    if (input.snapshotId.length === 0 || input.scope.length === 0) {
      return err(criterionError("invalid_definition", "A relevance snapshot requires an ID and scope"));
    }
    const listed = await list();
    if (!listed.ok) return listed;
    const selected = new Set(input.selectedCriterionIds ?? []);
    const criteria = listed.value
      .filter(
        ({ definition }) =>
          definition.status === "active" &&
          isRelevant(definition.scope, input.scope) &&
          (selected.size === 0 || selected.has(definition.criterionId)),
      )
      .map(
        ({ definition, metadata }): RelevantCriterionSnapshot =>
          Object.freeze({
            criterionId: definition.criterionId,
            revision: definition.revision,
            scope: definition.scope,
            evaluatorInstruction: definition.evaluatorInstruction,
            evidenceRefs: Object.freeze(definition.evidenceRefs.map((ref) => Object.freeze({ ...ref }))),
            promptOwnership: Object.freeze({ ...definition.promptOwnership }),
            definitionRevision: Object.freeze({ ...metadata.definitionRevision }),
          }),
      );
    const selectedCriterionIds = Object.freeze(criteria.map((criterion) => criterion.criterionId));
    const digestInput = {
      snapshotId: input.snapshotId,
      scope: input.scope,
      ...(input.candidateRevision ? { candidateRevision: input.candidateRevision } : {}),
      criteria,
    };
    return ok(
      Object.freeze({
        snapshotId: input.snapshotId,
        scope: input.scope,
        ...(input.candidateRevision
          ? { candidateRevision: Object.freeze({ ...input.candidateRevision }) }
          : {}),
        selectedCriterionIds,
        criteria: Object.freeze(criteria),
        snapshotDigest: sha256(canonicalJson(digestInput)),
      }),
    );
  };

  return Object.freeze({ create, list, inspect, revise, retire, pin, snapshotRelevant });
}
