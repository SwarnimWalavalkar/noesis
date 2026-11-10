import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  FolderProgramManifestSchema,
  ProgramManifestSchema,
  type FolderProgramManifest,
  ProgramPromotionSchema,
  ScriptProgramManifestSchema as ScriptManifestSchema,
  type ScriptProgramManifest as ScriptManifest,
  WorkflowProgramManifestSchema as WorkflowManifestSchema,
  type WorkflowProgramManifest as WorkflowManifest,
} from "@noesis/agent-types";
import {
  canonicalJson,
  createConditionalObject,
  type ActorRef,
  type EvidenceRef,
  type FileRevisionRef,
  type ProgramMode,
  type ProjectRef,
  sha256,
} from "@noesis/domain";
import type { CapabilityProgramLibrary } from "@noesis/learning";
import type { NoesisWorkspaceStore } from "@noesis/workspace";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf8", { fatal: true });

/** Who owns a Program: one project or the global library. It decides where the Program is stored. */
export type ProgramOwner =
  | Readonly<{ kind: "global" }>
  | Readonly<{ kind: "project"; project: ProjectRef }>
  /** A skill or Capability folder. Its Programs are reachable only once that folder is loaded. */
  | Readonly<{ kind: "folder"; folderId: string; skillName: string }>;
export const GLOBAL_PROGRAM_OWNER = Object.freeze({ kind: "global" as const });
export function projectProgramOwner(project: ProjectRef) {
  return Object.freeze({ kind: "project" as const, project });
}
export type ProgramScopeName = ProgramOwner["kind"];
export interface StoredScriptProgram {
  readonly manifest: ScriptManifest;
  readonly definitionRevision: FileRevisionRef;
  readonly owner: ProgramOwner;
}
export interface StoredWorkflowProgram {
  readonly manifest: WorkflowManifest;
  readonly definitionRevision: FileRevisionRef;
  readonly owner: ProgramOwner;
}
interface SavedDefinitionScope {
  readonly namespace: string;
  readonly workingRoot: string;
}
export function programDefinitionScope(kind: ProgramMode, owner: ProgramOwner): SavedDefinitionScope {
  if (owner.kind === "global")
    return Object.freeze({ namespace: `program:global:${kind}`, workingRoot: `programs/global/${kind}` });
  // A folder's working files stay in the folder. These are the exact definitions compiled from them.
  if (owner.kind === "folder")
    return Object.freeze({
      namespace: `program:folder:${owner.folderId}:${kind}`,
      workingRoot: `programs/folders/${owner.folderId}/${kind}`,
    });
  return Object.freeze({
    namespace: `program:${owner.project.projectId}:${kind}`,
    workingRoot: `programs/projects/${owner.project.projectId}/${kind}`,
  });
}
async function currentDefinition(
  workspace: NoesisWorkspaceStore,
  kind: "script" | "workflow",
  owner: ProgramOwner,
  name: string,
) {
  const scope = programDefinitionScope(kind, owner);
  const metadata = await workspace.definitionMetadata.getCurrent(scope.namespace, name);
  return metadata ? Object.freeze({ metadata, scope }) : undefined;
}
export async function readStoredScriptDefinition(
  workspace: NoesisWorkspaceStore,
  owner: ProgramOwner,
  name: string,
): Promise<
  | {
      readonly manifest: ScriptManifest;
      readonly definitionRevision: FileRevisionRef;
    }
  | undefined
> {
  const current = await currentDefinition(workspace, "script", owner, name);
  if (!current) return undefined;
  return Object.freeze({
    manifest: ScriptManifestSchema.parse(
      JSON.parse(decoder.decode(await workspace.reads.readRevision(current.metadata.definitionRevision))),
    ),
    definitionRevision: current.metadata.definitionRevision,
  });
}
export async function readStoredScriptRevision(
  workspace: NoesisWorkspaceStore,
  owner: ProgramOwner,
  name: string,
  revisionId: string,
): Promise<
  | {
      readonly manifest: ScriptManifest;
      readonly definitionRevision: FileRevisionRef;
    }
  | undefined
> {
  const revisions = await workspace.definitionMetadata.listRevisions(
    programDefinitionScope("script", owner).namespace,
    name,
  );
  const selected = revisions.find((candidate) => candidate.definitionRevision.revisionId === revisionId);
  if (!selected) return undefined;
  return Object.freeze({
    manifest: ScriptManifestSchema.parse(
      JSON.parse(decoder.decode(await workspace.reads.readRevision(selected.definitionRevision))),
    ),
    definitionRevision: selected.definitionRevision,
  });
}
export async function reconcileStoredScript(
  workspace: NoesisWorkspaceStore,
  owner: ProgramOwner,
  name: string,
): Promise<ScriptManifest | undefined> {
  const resolved = await currentDefinition(workspace, "script", owner, name);
  if (!resolved) return undefined;
  const { scope } = resolved;
  let current = resolved.metadata;
  let manifest = ScriptManifestSchema.parse(
    JSON.parse(decoder.decode(await workspace.reads.readRevision(current.definitionRevision))),
  );
  const workingManifest = await workspace.reads.readWorkingFile(current.definitionRevision.workingPath);
  if (workingManifest && sha256(workingManifest) !== current.definitionRevision.contentDigest) {
    const edited = ScriptManifestSchema.parse(JSON.parse(decoder.decode(workingManifest)));
    if (edited.name !== name) throw new Error(`Direct script edit cannot rename ${name} to ${edited.name}`);
    manifest = ScriptManifestSchema.parse({
      ...edited,
      revision: current.revision + 1,
      sourceRevision: manifest.sourceRevision,
      createdFrom: manifest.createdFrom,
    });
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const publication = await workspace.definitionPublications.publish({
      namespace: scope.namespace,
      definitionId: name,
      revision: manifest.revision,
      workingPath: current.definitionRevision.workingPath,
      bytes: encoder.encode(`${canonicalJson(manifest)}\n`),
      expectedCurrentRevisionId: current.definitionRevision.revisionId,
      provenanceRefs: Object.freeze([manifest.sourceRevision, current.definitionRevision]),
      activity: Object.freeze({
        kind: "script.manifest_direct_edit_recorded",
        actor: Object.freeze({ actorId: "workspace-user", kind: "user" as const }),
        reason: `Recorded direct manifest edit for ${name}`,
      }),
    });
    if (!publication.ok) throw new Error(publication.error.message);
    current = publication.value;
  }
  const workingSource = await workspace.reads.readWorkingFile(manifest.sourceRevision.workingPath);
  if (!workingSource || sha256(workingSource) === manifest.sourceRevision.contentDigest) return manifest;
  const sourceRevision = await workspace.recordDirectEdit(
    manifest.sourceRevision.workingPath,
    Object.freeze({ actorId: "workspace-user", kind: "user" }),
    `Direct edit to script ${name}`,
  );
  const updated = ScriptManifestSchema.parse({
    ...manifest,
    revision: current.revision + 1,
    sourceRevision,
  });
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const publication = await workspace.definitionPublications.publish({
    namespace: scope.namespace,
    definitionId: name,
    revision: updated.revision,
    workingPath: `${scope.workingRoot}/${name}/program.json`,
    bytes: encoder.encode(`${canonicalJson(updated)}\n`),
    expectedCurrentRevisionId: current.definitionRevision.revisionId,
    provenanceRefs: Object.freeze([sourceRevision]),
    activity: Object.freeze({
      kind: "script.direct_edit_recorded",
      actor: Object.freeze({ actorId: "workspace-user", kind: "user" as const }),
      reason: `Recorded direct source edit for ${name}`,
    }),
  });
  if (!publication.ok) throw new Error(publication.error.message);
  return updated;
}
export async function listStoredScripts(
  workspace: NoesisWorkspaceStore,
  owner: ProgramOwner,
): Promise<readonly ScriptManifest[]> {
  return Object.freeze((await listStoredScriptDefinitions(workspace, owner)).map(({ manifest }) => manifest));
}
export async function listStoredScriptDefinitions(
  workspace: NoesisWorkspaceStore,
  owner: ProgramOwner,
): Promise<
  readonly {
    readonly manifest: ScriptManifest;
    readonly definitionRevision: FileRevisionRef;
  }[]
> {
  const current = await workspace.definitionMetadata.listCurrent(
    programDefinitionScope("script", owner).namespace,
  );
  const names = [...new Set(current.map((metadata) => metadata.definitionId))];
  const scripts = await Promise.all(
    names.map(async (name) => await readStoredScriptDefinition(workspace, owner, name)),
  );
  return Object.freeze(
    scripts
      .flatMap((script) => (script ? [script] : []))
      .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name)),
  );
}
export async function reconcileStoredScripts(
  workspace: NoesisWorkspaceStore,
  owner: ProgramOwner,
): Promise<void> {
  const scripts = await listStoredScripts(workspace, owner);
  for (const script of scripts) await reconcileStoredScript(workspace, owner, script.name);
}
export async function readStoredWorkflow(
  workspace: NoesisWorkspaceStore,
  owner: ProgramOwner,
  name: string,
): Promise<
  | {
      readonly manifest: WorkflowManifest;
      readonly definitionRevision: FileRevisionRef;
    }
  | undefined
> {
  const current = await currentDefinition(workspace, "workflow", owner, name);
  if (!current) return undefined;
  return Object.freeze({
    manifest: WorkflowManifestSchema.parse(
      JSON.parse(decoder.decode(await workspace.reads.readRevision(current.metadata.definitionRevision))),
    ),
    definitionRevision: current.metadata.definitionRevision,
  });
}
export async function reconcileStoredWorkflow(
  workspace: NoesisWorkspaceStore,
  owner: ProgramOwner,
  name: string,
): Promise<
  | {
      readonly manifest: WorkflowManifest;
      readonly definitionRevision: FileRevisionRef;
    }
  | undefined
> {
  const current = await currentDefinition(workspace, "workflow", owner, name);
  if (!current) return undefined;
  const { metadata, scope } = current;
  const storedManifest = WorkflowManifestSchema.parse(
    JSON.parse(decoder.decode(await workspace.reads.readRevision(metadata.definitionRevision))),
  );
  const working = await workspace.reads.readWorkingFile(metadata.definitionRevision.workingPath);
  if (!working || sha256(working) === metadata.definitionRevision.contentDigest)
    return Object.freeze({
      manifest: storedManifest,
      definitionRevision: metadata.definitionRevision,
    });
  const edited = WorkflowManifestSchema.parse(JSON.parse(decoder.decode(working)));
  if (edited.name !== name) throw new Error(`Direct workflow edit cannot rename ${name} to ${edited.name}`);
  const manifest = WorkflowManifestSchema.parse({
    ...edited,
    revision: metadata.revision + 1,
    createdFrom: storedManifest.createdFrom,
  });
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const publication = await workspace.definitionPublications.publish({
    namespace: scope.namespace,
    definitionId: name,
    revision: manifest.revision,
    workingPath: metadata.definitionRevision.workingPath,
    bytes: encoder.encode(`${canonicalJson(manifest)}\n`),
    expectedCurrentRevisionId: metadata.definitionRevision.revisionId,
    provenanceRefs: Object.freeze([metadata.definitionRevision]),
    activity: Object.freeze({
      kind: "workflow.direct_edit_recorded",
      actor: Object.freeze({ actorId: "workspace-user", kind: "user" as const }),
      reason: `Recorded direct workflow edit for ${name}`,
    }),
  });
  if (!publication.ok) throw new Error(publication.error.message);
  return Object.freeze({
    manifest,
    definitionRevision: publication.value.definitionRevision,
  });
}
export async function readStoredWorkflowRevision(
  workspace: NoesisWorkspaceStore,
  owner: ProgramOwner,
  name: string,
  revisionId: string,
): Promise<
  | {
      readonly manifest: WorkflowManifest;
      readonly definitionRevision: FileRevisionRef;
    }
  | undefined
> {
  const revisions = await workspace.definitionMetadata.listRevisions(
    programDefinitionScope("workflow", owner).namespace,
    name,
  );
  const selected = revisions.find((candidate) => candidate.definitionRevision.revisionId === revisionId);
  if (!selected) return undefined;
  return Object.freeze({
    manifest: WorkflowManifestSchema.parse(
      JSON.parse(decoder.decode(await workspace.reads.readRevision(selected.definitionRevision))),
    ),
    definitionRevision: selected.definitionRevision,
  });
}
export async function listStoredWorkflows(
  workspace: NoesisWorkspaceStore,
  owner: ProgramOwner,
): Promise<
  readonly {
    readonly manifest: WorkflowManifest;
    readonly definitionRevision: FileRevisionRef;
  }[]
> {
  const current = await workspace.definitionMetadata.listCurrent(
    programDefinitionScope("workflow", owner).namespace,
  );
  const names = [...new Set(current.map((metadata) => metadata.definitionId))];
  const workflows = await Promise.all(
    names.map(async (name) => await readStoredWorkflow(workspace, owner, name)),
  );
  return Object.freeze(
    workflows
      .flatMap((workflow) => (workflow ? [workflow] : []))
      .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name)),
  );
}
export async function reconcileStoredWorkflows(
  workspace: NoesisWorkspaceStore,
  owner: ProgramOwner,
): Promise<void> {
  const workflows = await listStoredWorkflows(workspace, owner);
  for (const workflow of workflows) await reconcileStoredWorkflow(workspace, owner, workflow.manifest.name);
}
/** Both owners a turn in this project can see, nearest first. */
function ownersNearestFirst(project: ProjectRef): readonly Exclude<ProgramOwner, { kind: "folder" }>[] {
  return Object.freeze([projectProgramOwner(project), GLOBAL_PROGRAM_OWNER]);
}
async function ownedScripts(
  workspace: NoesisWorkspaceStore,
  owner: ProgramOwner,
): Promise<readonly StoredScriptProgram[]> {
  return Object.freeze(
    (await listStoredScriptDefinitions(workspace, owner)).map((stored) =>
      Object.freeze({ ...stored, owner }),
    ),
  );
}
async function ownedWorkflows(
  workspace: NoesisWorkspaceStore,
  owner: ProgramOwner,
): Promise<readonly StoredWorkflowProgram[]> {
  return Object.freeze(
    (await listStoredWorkflows(workspace, owner)).map((stored) => Object.freeze({ ...stored, owner })),
  );
}
/** Every Program a turn in this project can reach, nearest owner first for each name. */
export async function listVisibleScripts(
  workspace: NoesisWorkspaceStore,
  project: ProjectRef,
): Promise<readonly StoredScriptProgram[]> {
  return Object.freeze(
    (
      await Promise.all(
        ownersNearestFirst(project).map(async (owner) => await ownedScripts(workspace, owner)),
      )
    ).flat(),
  );
}
export async function listVisibleWorkflows(
  workspace: NoesisWorkspaceStore,
  project: ProjectRef,
): Promise<readonly StoredWorkflowProgram[]> {
  return Object.freeze(
    (
      await Promise.all(
        ownersNearestFirst(project).map(async (owner) => await ownedWorkflows(workspace, owner)),
      )
    ).flat(),
  );
}
export async function findScriptRevision(
  workspace: NoesisWorkspaceStore,
  project: ProjectRef,
  name: string,
  revisionId: string,
  scope?: ProgramScopeName,
): Promise<StoredScriptProgram | undefined> {
  for (const owner of ownersNearestFirst(project).filter((owner) => !scope || owner.kind === scope)) {
    const stored = await readStoredScriptRevision(workspace, owner, name, revisionId);
    if (stored) return Object.freeze({ ...stored, owner });
  }
  return undefined;
}
export async function findWorkflowRevision(
  workspace: NoesisWorkspaceStore,
  project: ProjectRef,
  name: string,
  revisionId: string,
  scope?: ProgramScopeName,
): Promise<StoredWorkflowProgram | undefined> {
  for (const owner of ownersNearestFirst(project).filter((owner) => !scope || owner.kind === scope)) {
    const stored = await readStoredWorkflowRevision(workspace, owner, name, revisionId);
    if (stored) return Object.freeze({ ...stored, owner });
  }
  return undefined;
}
/**
 * Finds a saved or folder workflow revision by its pin. Only a recorded run may use this: a new run
 * reaches a folder's Programs only once its folder is loaded.
 */
export async function findPinnedWorkflowRevision(
  workspace: NoesisWorkspaceStore,
  project: ProjectRef,
  name: string,
  revisionId: string,
): Promise<StoredWorkflowProgram | undefined> {
  const saved = await findWorkflowRevision(workspace, project, name, revisionId);
  if (saved) return saved;
  // A paused run from a folder resumes from its pin, whichever folders this turn has loaded.
  const metadata = await workspace.definitionMetadata.getByRevisionId(revisionId);
  const folderId = metadata?.namespace.match(/^program:folder:(.+):workflow$/u)?.[1];
  if (!metadata || !folderId) return undefined;
  const manifest = WorkflowManifestSchema.parse(
    JSON.parse(decoder.decode(await workspace.reads.readRevision(metadata.definitionRevision))),
  );
  if (manifest.name !== name) return undefined;
  return Object.freeze({
    manifest,
    definitionRevision: metadata.definitionRevision,
    owner: Object.freeze({ kind: "folder" as const, folderId, skillName: folderId }),
  });
}
export interface ProgramEditProblem {
  readonly mode: ProgramMode;
  readonly name: string;
  readonly error: string;
}
/**
 * Records direct edits to global Program files. A global file is shared by every project, so an edit
 * that cannot be read is reported and leaves the last revision current rather than failing a turn.
 */
export async function reconcileGlobalPrograms(
  workspace: NoesisWorkspaceStore,
): Promise<readonly ProgramEditProblem[]> {
  const problems: ProgramEditProblem[] = [];
  const attempt = async (mode: ProgramMode, name: string, operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      problems.push({ mode, name, error: error instanceof Error ? error.message : String(error) });
    }
  };
  for (const { manifest } of await listStoredScriptDefinitions(workspace, GLOBAL_PROGRAM_OWNER))
    await attempt(
      "script",
      manifest.name,
      async () => void (await reconcileStoredScript(workspace, GLOBAL_PROGRAM_OWNER, manifest.name)),
    );
  for (const { manifest } of await listStoredWorkflows(workspace, GLOBAL_PROGRAM_OWNER))
    await attempt(
      "workflow",
      manifest.name,
      async () => void (await reconcileStoredWorkflow(workspace, GLOBAL_PROGRAM_OWNER, manifest.name)),
    );
  return Object.freeze(problems);
}

function scopedKey(owner: ProgramOwner, name: string): string {
  return `${owner.kind}:${name}`;
}
function nameOrder<Program extends { readonly manifest: { readonly name: string } }>(
  programs: Iterable<Program>,
): readonly Program[] {
  return Object.freeze(
    [...programs].sort((left, right) => left.manifest.name.localeCompare(right.manifest.name)),
  );
}

export interface TurnProgramLibrary {
  /** Every Program the turn can reach, including those a nearer Program shadows. */
  readonly scripts: () => readonly StoredScriptProgram[];
  readonly workflows: () => readonly StoredWorkflowProgram[];
  /**
   * Resolves a name nearest scope first: a loaded folder, then the project, then global. A caller
   * may name one scope or one loaded skill. A name in two loaded folders is an error, not a guess.
   */
  readonly script: (name: string, lookup?: ProgramLookup) => StoredScriptProgram | undefined;
  readonly workflow: (name: string, lookup?: ProgramLookup) => StoredWorkflowProgram | undefined;
  readonly isShadowed: (mode: ProgramMode, owner: ProgramOwner, name: string) => boolean;
  readonly recordScript: (stored: StoredScriptProgram) => void;
  readonly recordWorkflow: (stored: StoredWorkflowProgram) => void;
  /** Makes one folder's Programs reachable. Before this, they are not listed or resolved. */
  readonly loadFolder: (programs: {
    readonly scripts: readonly StoredScriptProgram[];
    readonly workflows: readonly StoredWorkflowProgram[];
  }) => void;
  /** Pins the whole visible library for workflow resume. Project entries keep their earlier shape. */
  readonly dependenciesDigest: () => string;
}
/**
 * The Program library as one turn sees it: frozen when the turn starts, plus what this turn saved.
 * Later saves elsewhere cannot change which revision a name resolves to during the turn.
 */
export type ProgramLookup = Readonly<{ scope?: ProgramScopeName; skill?: string }>;
export function createTurnProgramLibrary(frozen: {
  readonly scripts: readonly StoredScriptProgram[];
  readonly workflows: readonly StoredWorkflowProgram[];
}): TurnProgramLibrary {
  const scripts = new Map(
    frozen.scripts.map((stored) => [scopedKey(stored.owner, stored.manifest.name), stored] as const),
  );
  const workflows = new Map(
    frozen.workflows.map((stored) => [scopedKey(stored.owner, stored.manifest.name), stored] as const),
  );
  const folderScripts: StoredScriptProgram[] = [];
  const folderWorkflows: StoredWorkflowProgram[] = [];
  const resolve = <
    Program extends { readonly owner: ProgramOwner; readonly manifest: { readonly name: string } },
  >(
    programs: ReadonlyMap<string, Program>,
    folders: readonly Program[],
    name: string,
    lookup: ProgramLookup | undefined,
  ): Program | undefined => {
    const scope = lookup?.scope;
    const inFolders = folders.filter(
      ({ owner, manifest }) =>
        manifest.name === name &&
        owner.kind === "folder" &&
        (lookup?.skill === undefined || owner.skillName === lookup.skill),
    );
    if (lookup?.skill !== undefined) return inFolders[0];
    if (scope === "project" || scope === "global") return programs.get(`${scope}:${name}`);
    if (inFolders.length > 1)
      throw new Error(
        `Program ${name} is in more than one loaded skill (${inFolders
          .map(({ owner }) => (owner.kind === "folder" ? owner.skillName : ""))
          .join(", ")}). Pass skill to choose one.`,
      );
    if (inFolders[0]) return inFolders[0];
    return scope === "folder"
      ? undefined
      : (programs.get(`project:${name}`) ?? programs.get(`global:${name}`));
  };
  const library: TurnProgramLibrary = {
    scripts: () => nameOrder([...folderScripts, ...scripts.values()]),
    workflows: () => nameOrder([...folderWorkflows, ...workflows.values()]),
    script: (name, lookup) => resolve(scripts, folderScripts, name, lookup),
    workflow: (name, lookup) => resolve(workflows, folderWorkflows, name, lookup),
    isShadowed: (mode, owner, name) => {
      if (owner.kind === "folder") return false;
      const folder = mode === "script" ? folderScripts : folderWorkflows;
      if (folder.some(({ manifest }) => manifest.name === name)) return true;
      return owner.kind === "global" && (mode === "script" ? scripts : workflows).has(`project:${name}`);
    },
    loadFolder: (programs) => {
      const known = (
        stored: { readonly definitionRevision: FileRevisionRef },
        list: readonly { readonly definitionRevision: FileRevisionRef }[],
      ) => list.some((item) => item.definitionRevision.revisionId === stored.definitionRevision.revisionId);
      for (const stored of programs.scripts) if (!known(stored, folderScripts)) folderScripts.push(stored);
      for (const stored of programs.workflows)
        if (!known(stored, folderWorkflows)) folderWorkflows.push(stored);
    },
    recordScript: (stored) => void scripts.set(scopedKey(stored.owner, stored.manifest.name), stored),
    recordWorkflow: (stored) => void workflows.set(scopedKey(stored.owner, stored.manifest.name), stored),
    dependenciesDigest: () =>
      sha256(
        canonicalJson({
          scripts: nameOrder(scripts.values()).map(({ manifest, owner }) =>
            createConditionalObject({
              name: manifest.name,
              revision: manifest.revision,
              sourceRevisionId: manifest.sourceRevision.revisionId,
              sourceDigest: manifest.sourceRevision.contentDigest,
            } as const)
              .addOptional(owner.kind === "global" ? { scope: "global" as const } : undefined)
              .finish(),
          ),
          workflows: nameOrder(workflows.values()).map(({ manifest, definitionRevision, owner }) =>
            createConditionalObject({
              name: manifest.name,
              revision: manifest.revision,
              definitionRevisionId: definitionRevision.revisionId,
              definitionDigest: definitionRevision.contentDigest,
            } as const)
              .addOptional(owner.kind === "global" ? { scope: "global" as const } : undefined)
              .finish(),
          ),
        }),
      ),
  };
  return Object.freeze(library);
}

export interface PromoteProgramInput {
  readonly mode: ProgramMode;
  readonly name: string;
  readonly reason: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly actor: ActorRef;
  /** Required to replace a different global Program that already has this name. */
  readonly expectedGlobalRevisionId?: string;
}
export type PromotedProgram = Readonly<{
  definitionRevision: FileRevisionRef;
  revision: number;
  unchanged: boolean;
}>;
function replaceGuard(
  name: string,
  current: FileRevisionRef | undefined,
  expected: string | undefined,
): void {
  if (current && current.revisionId !== expected)
    throw new Error(
      `A different global Program named ${name} exists at revision ${current.revisionId}. Pass it as expectedGlobalRevisionId to replace it.`,
    );
}
/**
 * Copies a project Program into the global library as a new revision whose provenance names the
 * exact source revision. The project Program and its revisions do not change.
 */
export async function promoteProgram(
  workspace: NoesisWorkspaceStore,
  project: ProjectRef,
  input: PromoteProgramInput,
): Promise<PromotedProgram> {
  const owner = projectProgramOwner(project);
  const { namespace, workingRoot } = programDefinitionScope(input.mode, GLOBAL_PROGRAM_OWNER);
  // Promote what the file says now, so an unrecorded edit is not lost or left behind.
  if (input.mode === "script") await reconcileStoredScript(workspace, owner, input.name);
  else await reconcileStoredWorkflow(workspace, owner, input.name);
  const current = await workspace.definitionMetadata.getCurrent(namespace, input.name);
  const nextRevision = (current?.revision ?? 0) + 1;
  const expectedCurrent = current
    ? { expectedCurrentRevisionId: current.definitionRevision.revisionId }
    : undefined;
  const actor = input.actor;
  const reason = `Promoted to global: ${input.reason}`;
  if (input.mode === "script") {
    const source = await readStoredScriptDefinition(workspace, owner, input.name);
    if (!source) throw new Error(`Project has no script-mode Program ${input.name} to promote`);
    const sourceBytes = await workspace.reads.readRevision(source.manifest.sourceRevision);
    const existing = await readStoredScriptDefinition(workspace, GLOBAL_PROGRAM_OWNER, input.name);
    if (
      existing &&
      existing.manifest.sourceRevision.contentDigest === source.manifest.sourceRevision.contentDigest &&
      canonicalJson(executableScriptFields(existing.manifest)) ===
        canonicalJson(executableScriptFields(source.manifest))
    )
      return Object.freeze({
        definitionRevision: existing.definitionRevision,
        revision: existing.manifest.revision,
        unchanged: true,
      });
    replaceGuard(input.name, existing?.definitionRevision, input.expectedGlobalRevisionId);
    const sourceRevision = await workspace.definitions.recordWorkingDefinition(
      createConditionalObject({
        workingPath: `${workingRoot}/${input.name}/index.mjs`,
        bytes: sourceBytes,
        actor,
        reason,
        provenanceRefs: Object.freeze([source.manifest.sourceRevision]),
      } as const)
        .addOptional(
          existing ? { predecessorRevisionId: existing.manifest.sourceRevision.revisionId } : undefined,
        )
        .finish(),
    );
    const manifest = ScriptManifestSchema.parse({
      ...source.manifest,
      revision: nextRevision,
      sourceRevision,
      promotedFrom: ProgramPromotionSchema.parse({
        projectId: project.projectId,
        revision: source.manifest.revision,
        definitionRevisionId: source.definitionRevision.revisionId,
        definitionDigest: source.definitionRevision.contentDigest,
      }),
    });
    const publication = await workspace.definitionPublications.publish(
      createConditionalObject({
        namespace,
        definitionId: input.name,
        revision: nextRevision,
        workingPath: `${workingRoot}/${input.name}/program.json`,
        bytes: encoder.encode(`${canonicalJson(manifest)}\n`),
      } as const)
        .addOptional(expectedCurrent)
        .add({
          provenanceRefs: Object.freeze([sourceRevision, source.definitionRevision, ...input.evidenceRefs]),
          activity: Object.freeze({ kind: "program.promoted", actor, reason }),
        } as const)
        .finish(),
    );
    if (!publication.ok) throw new Error(publication.error.message);
    return Object.freeze({
      definitionRevision: publication.value.definitionRevision,
      revision: nextRevision,
      unchanged: false,
    });
  }
  const source = await readStoredWorkflow(workspace, owner, input.name);
  if (!source) throw new Error(`Project has no workflow-mode Program ${input.name} to promote`);
  const existing = await readStoredWorkflow(workspace, GLOBAL_PROGRAM_OWNER, input.name);
  if (
    existing &&
    canonicalJson(executableWorkflowFields(existing.manifest)) ===
      canonicalJson(executableWorkflowFields(source.manifest))
  )
    return Object.freeze({
      definitionRevision: existing.definitionRevision,
      revision: existing.manifest.revision,
      unchanged: true,
    });
  replaceGuard(input.name, existing?.definitionRevision, input.expectedGlobalRevisionId);
  const manifest = WorkflowManifestSchema.parse({
    ...source.manifest,
    revision: nextRevision,
    promotedFrom: ProgramPromotionSchema.parse({
      projectId: project.projectId,
      revision: source.manifest.revision,
      definitionRevisionId: source.definitionRevision.revisionId,
      definitionDigest: source.definitionRevision.contentDigest,
    }),
  });
  const publication = await workspace.definitionPublications.publish(
    createConditionalObject({
      namespace,
      definitionId: input.name,
      revision: nextRevision,
      workingPath: `${workingRoot}/${input.name}/program.json`,
      bytes: encoder.encode(`${canonicalJson(manifest)}\n`),
    } as const)
      .addOptional(expectedCurrent)
      .add({
        provenanceRefs: Object.freeze([source.definitionRevision, ...input.evidenceRefs]),
        activity: Object.freeze({ kind: "program.promoted", actor, reason }),
      } as const)
      .finish(),
  );
  if (!publication.ok) throw new Error(publication.error.message);
  return Object.freeze({
    definitionRevision: publication.value.definitionRevision,
    revision: nextRevision,
    unchanged: false,
  });
}
/** What a script does, without where and when it was recorded. Equal fields mean equal behavior. */
function executableScriptFields(manifest: ScriptManifest) {
  return {
    description: manifest.description,
    inputSchema: manifest.inputSchema,
    outputSchema: manifest.outputSchema,
    requiredTools: manifest.requiredTools,
  };
}
function executableWorkflowFields(manifest: WorkflowManifest) {
  return {
    description: manifest.description,
    inputSchema: manifest.inputSchema,
    outputSchema: manifest.outputSchema,
    phases: manifest.phases,
  };
}

/**
 * The Capability view of the library. A name resolves nearest scope first unless the caller names a
 * scope, and the list includes a global Program a project one shadows so it can still be chosen.
 */
export function createCapabilityProgramLibrary(
  workspace: NoesisWorkspaceStore,
  activeProject: ProjectRef,
): CapabilityProgramLibrary {
  const assertActiveProject = (project: ProjectRef): void => {
    if (project.projectId !== activeProject.projectId || project.root !== activeProject.root)
      throw new Error(`Capability program library cannot cross project ${activeProject.projectId}`);
  };
  return Object.freeze({
    list: async (project: ProjectRef) => {
      assertActiveProject(project);
      const [scripts, workflows] = await Promise.all([
        listVisibleScripts(workspace, project),
        listVisibleWorkflows(workspace, project),
      ]);
      const library = createTurnProgramLibrary({ scripts, workflows });
      return Object.freeze([
        ...library.scripts().map(({ manifest, definitionRevision, owner }) =>
          Object.freeze({
            mode: "script" as const,
            scope: owner.kind === "global" ? ("global" as const) : ("project" as const),
            shadowed: library.isShadowed("script", owner, manifest.name),
            name: manifest.name,
            description: manifest.description,
            revision: manifest.revision,
            definitionRevision,
          }),
        ),
        ...library.workflows().map(({ manifest, definitionRevision, owner }) =>
          Object.freeze({
            mode: "workflow" as const,
            scope: owner.kind === "global" ? ("global" as const) : ("project" as const),
            shadowed: library.isShadowed("workflow", owner, manifest.name),
            name: manifest.name,
            description: manifest.description,
            revision: manifest.revision,
            definitionRevision,
          }),
        ),
      ]);
    },
    resolve: async (mode: ProgramMode, name: string, project: ProjectRef, scope?: ProgramScopeName) => {
      assertActiveProject(project);
      // A named scope selects that owner even when a project Program shadows the global one.
      for (const owner of ownersNearestFirst(project).filter((owner) => !scope || owner.kind === scope)) {
        const stored =
          mode === "script"
            ? await readStoredScriptDefinition(workspace, owner, name)
            : await readStoredWorkflow(workspace, owner, name);
        if (!stored) continue;
        if (stored.manifest.name !== name) throw new Error(`Saved ${mode} ${name} has mismatched identity`);
        return programEffect(mode, name, owner, stored.definitionRevision);
      }
      return undefined;
    },
    promote: async (project: ProjectRef, input: PromoteProgramInput) => {
      assertActiveProject(project);
      return await promoteProgram(workspace, project, input);
    },
    compileFolderPrograms: async (input: {
      readonly capabilityId: string;
      readonly sessionId: string;
      readonly files: readonly {
        readonly path: string;
        readonly bytes: Uint8Array;
        readonly revision: FileRevisionRef;
      }[];
    }) => await compileCapabilityFolderPrograms(workspace, input),
  });
}
/** The stored form of a folder's Program files. It only reads; `publish` writes the revision. */
interface FolderProgramFiles {
  readonly name: string;
  readonly manifest: FolderProgramManifest;
  readonly source?: string;
}
/** Reads every `programs/<name>/program.json` in a folder. Syntax and shape only. */
export function readFolderProgramFiles(
  files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
): readonly FolderProgramFiles[] {
  const byPath = new Map(files.map((file) => [file.path, file.bytes] as const));
  return Object.freeze(
    files.flatMap((file) => {
      const match = file.path.match(/^programs\/([^/]+)\/program\.json$/u);
      const name = match?.[1];
      if (!name) return [];
      const parsed = FolderProgramManifestSchema.safeParse(JSON.parse(decoder.decode(file.bytes)));
      if (!parsed.success)
        throw new Error(
          `${file.path}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "file"} ${issue.message}`).join("; ")}`,
        );
      if (parsed.data.name !== name) throw new Error(`${file.path} names Program ${parsed.data.name}`);
      if (parsed.data.mode === "workflow") {
        const program: FolderProgramFiles = Object.freeze({ name, manifest: parsed.data });
        return [program];
      }
      const source = byPath.get(`programs/${name}/index.mjs`);
      if (!source) throw new Error(`Script-mode Program ${name} needs programs/${name}/index.mjs`);
      if (source.length > 128 * 1024) throw new Error(`Program ${name} source is too long`);
      const program: FolderProgramFiles = Object.freeze({
        name,
        manifest: parsed.data,
        source: decoder.decode(source),
      });
      return [program];
    }),
  );
}
/**
 * Publishes one folder Program as an exact revision, reusing the current one when nothing changed.
 * The folder's own files stay the editable source; this is what a turn pins and runs.
 */
async function compileFolderProgram(
  workspace: NoesisWorkspaceStore,
  owner: Extract<ProgramOwner, { kind: "folder" }>,
  program: FolderProgramFiles,
  sessionId: string,
  sourceRevision: FileRevisionRef | undefined,
): Promise<FileRevisionRef> {
  const { manifest: file, name } = program;
  const { namespace, workingRoot } = programDefinitionScope(file.mode, owner);
  const current = await workspace.definitionMetadata.getCurrent(namespace, name);
  const revision = (current?.revision ?? 0) + 1;
  const createdFrom = { sessionId, turnId: `folder:${owner.folderId}`, planId: `folder:${owner.folderId}` };
  const provenance = sourceRevision ? [sourceRevision] : [];
  const manifest =
    file.mode === "script"
      ? ScriptManifestSchema.parse({
          kind: "noesis_program",
          ...file,
          revision,
          sourceRevision,
          createdFrom,
        })
      : WorkflowManifestSchema.parse({ kind: "noesis_program", ...file, revision, createdFrom });
  if (current) {
    const stored = ProgramManifestSchema.parse(
      JSON.parse(decoder.decode(await workspace.reads.readRevision(current.definitionRevision))),
    );
    const comparable = (value: ScriptManifest | WorkflowManifest) => {
      const { revision: _revision, createdFrom: _from, ...rest } = value;
      return rest;
    };
    if (canonicalJson(comparable(stored)) === canonicalJson(comparable(manifest)))
      return current.definitionRevision;
  }
  const publication = await workspace.definitionPublications.publish(
    createConditionalObject({
      namespace,
      definitionId: name,
      revision,
      workingPath: `${workingRoot}/${name}/program.json`,
      bytes: encoder.encode(`${canonicalJson(manifest)}\n`),
    } as const)
      .addOptional(current ? { expectedCurrentRevisionId: current.definitionRevision.revisionId } : undefined)
      .add({
        provenanceRefs: Object.freeze(provenance),
        activity: Object.freeze({
          kind: "program.folder_compiled",
          actor: Object.freeze({ actorId: "noesis-program-library", kind: "noesis" as const }),
          reason: `Program ${name} from folder ${owner.folderId}`,
        }),
      } as const)
      .finish(),
  );
  if (!publication.ok) throw new Error(publication.error.message);
  return publication.value.definitionRevision;
}
/** Compiles a Capability folder's Programs from files the Capability revision also pins. */
export async function compileCapabilityFolderPrograms(
  workspace: NoesisWorkspaceStore,
  input: {
    readonly capabilityId: string;
    readonly sessionId: string;
    readonly files: readonly {
      readonly path: string;
      readonly bytes: Uint8Array;
      readonly revision: FileRevisionRef;
    }[];
  },
) {
  const owner = Object.freeze({
    kind: "folder" as const,
    folderId: input.capabilityId,
    skillName: input.capabilityId,
  });
  const programs = readFolderProgramFiles(input.files);
  return Object.freeze(
    await Promise.all(
      programs.map(async (program) => {
        const source = input.files.find((file) => file.path === `programs/${program.name}/index.mjs`);
        return Object.freeze({
          mode: program.manifest.mode,
          name: program.name,
          definitionRevision: await compileFolderProgram(
            workspace,
            owner,
            program,
            input.sessionId,
            program.manifest.mode === "script" ? source?.revision : undefined,
          ),
        });
      }),
    ),
  );
}
/**
 * Compiles the Programs of a standard skill's folder when the skill is loaded. The skill's files live
 * outside the workspace, so their bytes are recorded here and this is the exact revision that runs.
 */
export async function compileSkillFolderPrograms(
  workspace: NoesisWorkspaceStore,
  input: {
    readonly skillName: string;
    readonly skillFilePath: string;
    readonly sessionId: string;
  },
): Promise<{
  readonly scripts: readonly StoredScriptProgram[];
  readonly workflows: readonly StoredWorkflowProgram[];
}> {
  const root = dirname(input.skillFilePath);
  const programsRoot = join(root, "programs");
  const entries = await readdir(programsRoot, { withFileTypes: true }).catch(() => []);
  const files: { path: string; bytes: Uint8Array }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const fileName of ["program.json", "index.mjs"]) {
      const path = join(programsRoot, entry.name, fileName);
      const details = await lstat(path).catch(() => undefined);
      if (!details?.isFile()) continue;
      // Refuse an oversized file before reading it. The compiler applies the exact Program limits.
      if (details.size > 1024 * 1024)
        throw new Error(
          `Skill ${input.skillName} Program file programs/${entry.name}/${fileName} is too large`,
        );
      files.push({ path: `programs/${entry.name}/${fileName}`, bytes: await readFile(path) });
    }
  }
  if (files.length === 0) return Object.freeze({ scripts: Object.freeze([]), workflows: Object.freeze([]) });
  const owner = Object.freeze({
    kind: "folder" as const,
    folderId: `skill_${sha256(root).slice(0, 32)}`,
    skillName: input.skillName,
  });
  const scripts: StoredScriptProgram[] = [];
  const workflows: StoredWorkflowProgram[] = [];
  for (const program of readFolderProgramFiles(files)) {
    const { workingRoot } = programDefinitionScope(program.manifest.mode, owner);
    const sourceRevision =
      program.source === undefined
        ? undefined
        : await workspace.definitions.recordCandidateDefinition({
            workingPath: `${workingRoot}/${program.name}/index.mjs`,
            bytes: encoder.encode(program.source),
            actor: Object.freeze({ actorId: "noesis-program-library", kind: "noesis" as const }),
            reason: `Program ${program.name} from skill ${input.skillName}`,
          });
    const definitionRevision = await compileFolderProgram(
      workspace,
      owner,
      program,
      input.sessionId,
      sourceRevision,
    );
    const manifest = JSON.parse(decoder.decode(await workspace.reads.readRevision(definitionRevision)));
    if (program.manifest.mode === "script")
      scripts.push(
        Object.freeze({ manifest: ScriptManifestSchema.parse(manifest), definitionRevision, owner }),
      );
    else
      workflows.push(
        Object.freeze({ manifest: WorkflowManifestSchema.parse(manifest), definitionRevision, owner }),
      );
  }
  return Object.freeze({ scripts: Object.freeze(scripts), workflows: Object.freeze(workflows) });
}
/** A pinned Program as files a folder can hold, so an export needs nothing outside itself. */
export async function folderProgramFilesForExport(
  workspace: NoesisWorkspaceStore,
  definitionRevision: FileRevisionRef,
): Promise<readonly { readonly path: string; readonly bytes: Uint8Array }[]> {
  const stored = JSON.parse(decoder.decode(await workspace.reads.readRevision(definitionRevision)));
  if (stored.mode === "script") {
    const manifest = ScriptManifestSchema.parse(stored);
    return Object.freeze([
      {
        path: `programs/${manifest.name}/program.json`,
        bytes: encoder.encode(
          `${JSON.stringify(
            FolderProgramManifestSchema.parse({
              mode: "script",
              name: manifest.name,
              description: manifest.description,
              inputSchema: manifest.inputSchema,
              outputSchema: manifest.outputSchema,
              requiredTools: manifest.requiredTools,
            }),
            null,
            2,
          )}\n`,
        ),
      },
      {
        path: `programs/${manifest.name}/index.mjs`,
        bytes: await workspace.reads.readRevision(manifest.sourceRevision),
      },
    ]);
  }
  const manifest = WorkflowManifestSchema.parse(stored);
  return Object.freeze([
    {
      path: `programs/${manifest.name}/program.json`,
      bytes: encoder.encode(
        `${JSON.stringify(
          FolderProgramManifestSchema.parse({
            mode: "workflow",
            name: manifest.name,
            description: manifest.description,
            inputSchema: manifest.inputSchema,
            outputSchema: manifest.outputSchema,
            phases: manifest.phases,
          }),
          null,
          2,
        )}\n`,
      ),
    },
  ]);
}
/** A Capability's pin on one exact Program revision. A global Program names no project. */
export function programEffect(
  mode: ProgramMode,
  name: string,
  owner: Exclude<ProgramOwner, { kind: "folder" }>,
  definitionRevision: FileRevisionRef,
) {
  return Object.freeze({
    kind: "program" as const,
    program: Object.freeze(
      createConditionalObject({ mode, name } as const)
        .addOptional(owner.kind === "project" ? { project: Object.freeze({ ...owner.project }) } : undefined)
        .add({ definitionRevision } as const)
        .finish(),
    ),
  });
}
