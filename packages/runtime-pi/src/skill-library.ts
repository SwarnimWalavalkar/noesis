import { readFile } from "node:fs/promises";
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createConditionalObject,
  type EvidenceRevisionRef,
  type FileRevisionRef,
  sha256,
} from "@noesis/domain";
export interface PiSkillResource {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly filePath: string;
  readonly contentDigest: string;
  readonly admittedRevision?: EvidenceRevisionRef<"input">;
  /** Exact immutable Capability material; already pinned by the FrozenTurnPlan. */
  readonly capabilityRevision?: FileRevisionRef;
  readonly disableModelInvocation: boolean;
}
export interface PiSkillDiagnostic {
  readonly type: "warning" | "error" | "collision";
  readonly message: string;
  readonly path?: string;
}
export interface PiSkillSnapshot {
  readonly skills: readonly PiSkillResource[];
  readonly diagnostics: readonly PiSkillDiagnostic[];
}
export interface PiSkillLibrary {
  /** Live inspection load; callers may wait for newly discovered resources. */
  readonly snapshot: (signal?: AbortSignal) => Promise<PiSkillSnapshot>;
  /**
   * Turn admission never waits behind an opportunistic inspection load. It pins the last settled
   * snapshot, or an explicitly diagnosed empty snapshot, until that inspection settles.
   */
  readonly pinSnapshot: (
    key: string,
    signal?: AbortSignal,
    admit?: (snapshot: PiSkillSnapshot) => Promise<PiSkillSnapshot>,
  ) => Promise<PiSkillSnapshot>;
  readonly claimPinnedSnapshot: (key: string) => PiSkillSnapshot | undefined;
  readonly discardPinnedSnapshot: (key: string) => void;
  readonly install: (source: string, scope: "personal" | "workspace") => Promise<void>;
  readonly remove: (source: string, scope: "personal" | "workspace") => Promise<boolean>;
  readonly update: (source: string | undefined, scope: "personal" | "workspace") => Promise<void>;
  readonly configured: () => readonly {
    readonly source: string;
    readonly scope: "personal" | "workspace";
    readonly installedPath?: string;
  }[];
}
type SkillLoadOwner = "snapshot" | "admission";
interface InFlightSkillLoad {
  readonly owner: SkillLoadOwner;
  readonly promise: Promise<PiSkillSnapshot>;
}
interface InFlightSkillPin {
  readonly token: object;
  readonly promise: Promise<PiSkillSnapshot>;
}
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function compareSkillResources(left: PiSkillResource, right: PiSkillResource): number {
  return compareText(left.name, right.name) || compareText(left.filePath, right.filePath);
}
export function createPiSkillLibrary(input: {
  readonly cwd: string;
  readonly agentDirectory: string;
  readonly workspaceTrusted?: boolean;
  readonly readSkillFile?: (path: string) => Promise<string>;
}): PiSkillLibrary {
  const workspaceTrusted = input.workspaceTrusted ?? false;
  const settings = SettingsManager.create(input.cwd, input.agentDirectory, {
    projectTrusted: workspaceTrusted,
  });
  const packages = new DefaultPackageManager({
    cwd: input.cwd,
    agentDir: input.agentDirectory,
    settingsManager: settings,
  });
  const loader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDirectory,
    settingsManager: settings,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  let loading: InFlightSkillLoad | undefined;
  let lastSettledSnapshot: PiSkillSnapshot | undefined;
  const pinned = new Map<string, PiSkillSnapshot>();
  const pinning = new Map<string, InFlightSkillPin>();
  const readSkillFile = input.readSkillFile ?? (async (path: string) => await readFile(path, "utf8"));
  const awaitWithSignal = <Value>(promise: Promise<Value>, signal?: AbortSignal): Promise<Value> => {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new Error("Skill loading was cancelled"));
    return new Promise<Value>((resolve, reject) => {
      const abort = (): void => {
        cleanup();
        reject(new Error("Skill loading was cancelled"));
      };
      const cleanup = (): void => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (cause: unknown) => {
          cleanup();
          reject(cause);
        },
      );
    });
  };
  const loadSnapshot = (owner: SkillLoadOwner): Promise<PiSkillSnapshot> => {
    if (!loading) {
      const current = (async () => {
        await loader.reload();
        const loaded = loader.getSkills();
        const resources = await Promise.all(
          loaded.skills.map(async (skill) => {
            try {
              const content = await readSkillFile(skill.filePath);
              // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
              return Object.freeze({
                kind: "skill" as const,
                value: Object.freeze({
                  name: skill.name,
                  description: skill.description,
                  content,
                  filePath: skill.filePath,
                  contentDigest: sha256(content),
                  disableModelInvocation: skill.disableModelInvocation ?? false,
                }),
              });
            } catch (error) {
              // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
              return Object.freeze({
                kind: "diagnostic" as const,
                value: Object.freeze({
                  type: "error" as const,
                  message: `Failed to read skill ${skill.name}: ${error instanceof Error ? error.message : String(error)}`,
                  path: skill.filePath,
                }),
              });
            }
          }),
        );
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        const captured = Object.freeze({
          skills: Object.freeze(
            resources
              .flatMap((resource) => (resource.kind === "skill" ? [resource.value] : []))
              .sort(compareSkillResources),
          ),
          diagnostics: Object.freeze([
            ...loaded.diagnostics.map((diagnostic) =>
              Object.freeze(
                createConditionalObject({
                  type: diagnostic.type,
                  message: diagnostic.message,
                } as const)
                  .addOptional(diagnostic.path ? { path: diagnostic.path } : undefined)
                  .finish(),
              ),
            ),
            ...resources.flatMap((resource) => (resource.kind === "diagnostic" ? [resource.value] : [])),
          ]),
        });
        lastSettledSnapshot = captured;
        return captured;
      })().finally(() => {
        if (loading?.promise === current) loading = undefined;
      });
      loading = Object.freeze({ owner, promise: current });
    }
    return loading.promise;
  };
  const snapshot = (signal?: AbortSignal): Promise<PiSkillSnapshot> =>
    awaitWithSignal(loadSnapshot("snapshot"), signal);
  const admissionSnapshot = (): Promise<PiSkillSnapshot> => {
    if (loading?.owner !== "snapshot") return loadSnapshot("admission");
    const settled = lastSettledSnapshot;
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const diagnostic = Object.freeze({
      type: "warning" as const,
      message: settled
        ? "Skill discovery is still in progress; this turn uses the last settled skill snapshot and omits skills that have not finished loading."
        : "Skill discovery is still in progress; this turn uses no skills and omits skills that have not finished loading.",
    });
    return Promise.resolve(
      Object.freeze({
        skills: settled?.skills ?? Object.freeze([]),
        diagnostics: Object.freeze([...(settled?.diagnostics ?? []), diagnostic]),
      }),
    );
  };
  const pinSnapshot: PiSkillLibrary["pinSnapshot"] = async (key, signal, admit) => {
    const existing = pinned.get(key);
    if (existing) return existing;
    if (signal?.aborted) throw new Error("Skill loading was cancelled");
    let inFlight = pinning.get(key);
    if (!inFlight) {
      const token = Object.freeze({});
      const admission = (async (): Promise<PiSkillSnapshot> => {
        const captured = await admissionSnapshot();
        const existingAfterLoad = pinned.get(key);
        if (pinning.get(key)?.token === token && existingAfterLoad) return existingAfterLoad;
        const admitted = admit ? await admit(captured) : captured;
        const existingAfterAdmission = pinned.get(key);
        if (pinning.get(key)?.token !== token) return admitted;
        if (existingAfterAdmission) return existingAfterAdmission;
        pinned.set(key, admitted);
        return admitted;
      })();
      const promise = admission.finally(() => {
        if (pinning.get(key)?.token === token) pinning.delete(key);
      });
      inFlight = Object.freeze({ token, promise });
      pinning.set(key, inFlight);
    }
    return await awaitWithSignal(inFlight.promise, signal);
  };
  const workspaceOption = (scope: "personal" | "workspace") =>
    scope === "workspace" ? Object.freeze({ local: true }) : undefined;
  const install: PiSkillLibrary["install"] = async (source, scope) => {
    if (scope === "workspace" && !workspaceTrusted)
      throw new Error("Workspace skill installation requires explicit workspace trust");
    await packages.installAndPersist(source, workspaceOption(scope));
    await settings.flush();
  };
  const remove: PiSkillLibrary["remove"] = async (source, scope) => {
    if (scope === "workspace" && !workspaceTrusted)
      throw new Error("Workspace skill removal requires explicit workspace trust");
    const removed = await packages.removeAndPersist(source, workspaceOption(scope));
    await settings.flush();
    return removed;
  };
  const update: PiSkillLibrary["update"] = async (source, scope) => {
    if (scope === "workspace" && !workspaceTrusted)
      throw new Error("Workspace skill updates require explicit workspace trust");
    const configured = packages
      .listConfiguredPackages()
      .filter((entry) => entry.scope === (scope === "workspace" ? "project" : "user"));
    const scopedSettings = SettingsManager.inMemory({}, { projectTrusted: workspaceTrusted });
    const sources = configured.map((entry) => entry.source);
    if (scope === "workspace") scopedSettings.setProjectPackages(sources);
    else scopedSettings.setPackages(sources);
    const scopedPackages = new DefaultPackageManager({
      cwd: input.cwd,
      agentDir: input.agentDirectory,
      settingsManager: scopedSettings,
    });
    await scopedPackages.update(source);
  };
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.freeze({
    snapshot,
    pinSnapshot,
    claimPinnedSnapshot: (key: string) => {
      const captured = pinned.get(key);
      pinned.delete(key);
      return captured;
    },
    discardPinnedSnapshot: (key: string) => {
      pinned.delete(key);
      pinning.delete(key);
    },
    install,
    remove,
    update,
    configured: () =>
      Object.freeze(
        packages.listConfiguredPackages().map((configured) =>
          Object.freeze(
            createConditionalObject({
              source: configured.source,
              scope: configured.scope === "project" ? ("workspace" as const) : ("personal" as const),
            } as const)
              .addOptional(configured.installedPath ? { installedPath: configured.installedPath } : undefined)
              .finish(),
          ),
        ),
      ),
  });
}
