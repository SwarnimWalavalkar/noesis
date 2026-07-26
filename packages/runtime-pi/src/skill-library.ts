import {
  DefaultPackageManager,
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { sha256 } from "@noesis/domain";

export interface PiSkillResource {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly filePath: string;
  readonly contentDigest: string;
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
  readonly install: (source: string, scope: "personal" | "workspace") => Promise<void>;
  readonly remove: (source: string, scope: "personal" | "workspace") => Promise<boolean>;
  readonly update: (source?: string) => Promise<void>;
  readonly configured: () => readonly {
    readonly source: string;
    readonly scope: "personal" | "workspace";
    readonly installedPath?: string;
  }[];
}

export function createPiSkillLibrary(input: {
  readonly cwd: string;
  readonly agentDirectory: string;
}): PiSkillLibrary {
  const settings = SettingsManager.create(input.cwd, input.agentDirectory, { projectTrusted: true });
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
  const snapshot = (signal?: AbortSignal): Promise<PiSkillSnapshot> => {
    if (signal?.aborted) return Promise.reject(new Error("Skill loading was cancelled"));
    if (loading) return loading;
    const current = (async () => {
      await loader.reload();
      if (signal?.aborted) throw new Error("Skill loading was cancelled");
      const loaded = loader.getSkills();
      return Object.freeze({
        skills: Object.freeze(
          (
            await Promise.all(
              loaded.skills.map(async (skill) => {
                const content = await readFile(skill.filePath, "utf8");
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
    return current;
  };
  const workspaceOption = (scope: "personal" | "workspace") =>
    scope === "workspace" ? Object.freeze({ local: true }) : undefined;
  const install: PiSkillLibrary["install"] = async (source, scope) => {
    await packages.installAndPersist(source, workspaceOption(scope));
    await settings.flush();
  };
  const remove: PiSkillLibrary["remove"] = async (source, scope) => {
    const removed = await packages.removeAndPersist(source, workspaceOption(scope));
    await settings.flush();
    return removed;
  };
  const update: PiSkillLibrary["update"] = async (source) => {
    await packages.update(source);
    await settings.flush();
  };
  return Object.freeze({
    snapshot,
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
