import { readFile } from "node:fs/promises";
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type EvidenceRevisionRef, sha256 } from "@noesis/domain";

export interface PiSkillResource {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly filePath: string;
  readonly contentDigest: string;
  readonly admittedRevision?: EvidenceRevisionRef<"input">;
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
  readonly snapshot: (signal?: AbortSignal) => Promise<PiSkillSnapshot>;
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
  let loading: Promise<PiSkillSnapshot> | undefined;
  const pinned = new Map<string, PiSkillSnapshot>();
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
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  };
  const snapshot = (signal?: AbortSignal): Promise<PiSkillSnapshot> => {
    if (!loading) {
      const current = (async () => {
        await loader.reload();
        const loaded = loader.getSkills();
        return Object.freeze({
          skills: Object.freeze(
            (
              await Promise.all(
                loaded.skills.map(async (skill) => {
                  const content = await readSkillFile(skill.filePath);
                  return Object.freeze({
                    name: skill.name,
                    description: skill.description,
                    content,
                    filePath: skill.filePath,
                    contentDigest: sha256(content),
                    disableModelInvocation: skill.disableModelInvocation ?? false,
                  });
                }),
              )
            ).sort((left, right) => left.name.localeCompare(right.name)),
          ),
          diagnostics: Object.freeze(
            loaded.diagnostics.map((diagnostic) =>
              Object.freeze({
                type: diagnostic.type,
                message: diagnostic.message,
                ...(diagnostic.path ? { path: diagnostic.path } : {}),
              }),
            ),
          ),
        });
      })().finally(() => {
        if (loading === current) loading = undefined;
      });
      loading = current;
    }
    return awaitWithSignal(loading, signal);
  };
  const pinSnapshot: PiSkillLibrary["pinSnapshot"] = async (key, signal, admit) => {
    const existing = pinned.get(key);
    if (existing) return existing;
    const captured = await snapshot(signal);
    const existingAfterLoad = pinned.get(key);
    if (existingAfterLoad) return existingAfterLoad;
    const admitted = admit ? await admit(captured) : captured;
    const existingAfterAdmission = pinned.get(key);
    if (existingAfterAdmission) return existingAfterAdmission;
    pinned.set(key, admitted);
    return admitted;
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
    },
    install,
    remove,
    update,
    configured: () =>
      Object.freeze(
        packages.listConfiguredPackages().map((configured) =>
          Object.freeze({
            source: configured.source,
            scope: configured.scope === "project" ? ("workspace" as const) : ("personal" as const),
            ...(configured.installedPath ? { installedPath: configured.installedPath } : {}),
          }),
        ),
      ),
  });
}
