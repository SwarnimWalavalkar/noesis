import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createConditionalObject, err, ok, type Result } from "@noesis/domain";
import { z } from "zod";
// SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
export const NOESIS_CONFIG_SCHEMA_VERSION = 1 as const;
export const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;
export const AgentConfigSchema = z.strictObject({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
});
export type AgentConfig = Readonly<z.infer<typeof AgentConfigSchema>>;
export const ContextConfigSchema = z.strictObject({
  tokenBudget: z.number().int().positive().max(1000000).optional(),
  autoCompact: z.boolean().optional(),
});
export type ContextConfig = Readonly<z.infer<typeof ContextConfigSchema>>;
/** The model that names a session after its first message. Unset provider and model use the session's own. */
export const TitlesConfigSchema = AgentConfigSchema.extend({ enabled: z.boolean().optional() });
export type TitlesConfig = Readonly<z.infer<typeof TitlesConfigSchema>>;
/**
 * The model that reflects on each exchange after the user reacts. Unset provider and model use the
 * foreground route. `idleMinutes` is how long a turn waits for the user's reply before reflection.
 */
export const ReflectionConfigSchema = AgentConfigSchema.extend({
  idleMinutes: z.number().int().min(0).max(1440).optional(),
});
export type ReflectionConfig = Readonly<z.infer<typeof ReflectionConfigSchema>>;
export const NoesisConfigSchema = z.strictObject({
  schemaVersion: z.literal(NOESIS_CONFIG_SCHEMA_VERSION),
  agent: AgentConfigSchema,
  /** Default route for retained subagents. Unspecified fields inherit the foreground agent route. */
  agents: AgentConfigSchema.optional(),
  context: ContextConfigSchema.optional(),
  titles: TitlesConfigSchema.optional(),
  reflection: ReflectionConfigSchema.optional(),
});
/** Earlier builds accepted these sections but never applied them. Files containing them still load. */
const StoredNoesisConfigSchema = NoesisConfigSchema.extend({
  learning: z.unknown().optional(),
  autonomy: z.unknown().optional(),
  experiments: z.unknown().optional(),
}).transform(({ learning: _learning, autonomy: _autonomy, experiments: _experiments, ...config }) => config);
/** A partial configuration change. `null` removes a field so its default or inherited value applies. */
export const NoesisConfigPatchSchema = z.strictObject({
  agent: z
    .strictObject({
      provider: z.string().min(1).nullable().optional(),
      model: z.string().min(1).nullable().optional(),
      thinkingLevel: ThinkingLevelSchema.nullable().optional(),
    })
    .optional(),
  agents: z
    .strictObject({
      provider: z.string().min(1).nullable().optional(),
      model: z.string().min(1).nullable().optional(),
      thinkingLevel: ThinkingLevelSchema.nullable().optional(),
    })
    .optional(),
  context: z
    .strictObject({
      tokenBudget: z.number().int().positive().max(1000000).nullable().optional(),
      autoCompact: z.boolean().nullable().optional(),
    })
    .optional(),
  titles: z
    .strictObject({
      enabled: z.boolean().nullable().optional(),
      provider: z.string().min(1).nullable().optional(),
      model: z.string().min(1).nullable().optional(),
      thinkingLevel: ThinkingLevelSchema.nullable().optional(),
    })
    .optional(),
  reflection: z
    .strictObject({
      provider: z.string().min(1).nullable().optional(),
      model: z.string().min(1).nullable().optional(),
      thinkingLevel: ThinkingLevelSchema.nullable().optional(),
      idleMinutes: z.number().int().min(0).max(1440).nullable().optional(),
    })
    .optional(),
});
export type NoesisConfigPatch = Readonly<z.infer<typeof NoesisConfigPatchSchema>>;
export type NoesisConfig = Readonly<z.infer<typeof NoesisConfigSchema>>;
export interface ResolvedAgentConfig {
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
}
/** The session titler. An absent provider or model means the session's own. */
export interface ResolvedTitlesConfig {
  readonly enabled: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel: ThinkingLevel;
}
/** The exchange reflector. An absent provider or model means the foreground route. */
export interface ResolvedReflectionConfig {
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly idleMinutes: number;
}
export type ConfigSource = "cli" | "environment" | "config" | "default";
export type AgentDefaultSource = "configured" | "foreground";
export interface ResolvedNoesisConfig {
  readonly schemaVersion: typeof NOESIS_CONFIG_SCHEMA_VERSION;
  readonly home: string;
  readonly configPath: string;
  readonly agent: ResolvedAgentConfig;
  readonly agents: ResolvedAgentConfig;
  /** Whether each effective subagent default was explicit or inherited from the foreground route. */
  readonly agentsSources: Readonly<Record<keyof ResolvedAgentConfig, AgentDefaultSource>>;
  readonly context: Required<ContextConfig>;
  readonly titles: ResolvedTitlesConfig;
  readonly reflection: ResolvedReflectionConfig;
  readonly sources: Readonly<Record<keyof ResolvedAgentConfig, ConfigSource>>;
}
export interface ConfigOverrides {
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
}
export interface ResolveConfigInput {
  readonly home: string;
  readonly cli?: ConfigOverrides;
  readonly env?: Readonly<Record<string, string | undefined>>;
}
export class NoesisConfigError extends Error {
  readonly path: string;
  constructor(
    path: string,
    message: string,
    options?: {
      cause?: unknown;
    },
  ) {
    super(`${path}: ${message}`, options);
    this.name = "NoesisConfigError";
    this.path = path;
  }
}
export const BUILT_IN_AGENT_DEFAULTS: ResolvedAgentConfig = {
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  thinkingLevel: "high",
};
export const BUILT_IN_CONTEXT_DEFAULTS: Required<ContextConfig> = {
  tokenBudget: 160000,
  autoCompact: true,
};
/** Titles need no reasoning, so the titler runs without it unless configured. */
export const BUILT_IN_TITLES_DEFAULTS = {
  enabled: true,
  thinkingLevel: "off",
} as const satisfies Pick<ResolvedTitlesConfig, "enabled" | "thinkingLevel">;
/** Most exchanges teach nothing, so reflection runs with little reasoning unless configured. */
export const BUILT_IN_REFLECTION_DEFAULTS = {
  thinkingLevel: "low",
  idleMinutes: 10,
} as const satisfies Pick<ResolvedReflectionConfig, "thinkingLevel" | "idleMinutes">;
export const DEFAULT_NOESIS_CONFIG: NoesisConfig = {
  schemaVersion: NOESIS_CONFIG_SCHEMA_VERSION,
  agent: { ...BUILT_IN_AGENT_DEFAULTS },
  context: { ...BUILT_IN_CONTEXT_DEFAULTS },
};
/** Environment variables that override the configured foreground route. */
export const AGENT_ENVIRONMENT_VARIABLES = {
  provider: "NOESIS_PROVIDER",
  model: "NOESIS_MODEL",
  thinkingLevel: "NOESIS_THINKING_LEVEL",
} as const satisfies Readonly<Record<keyof ResolvedAgentConfig, string>>;
export const noesisConfigPath = (home: string): string => join(home, "config.json");
const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
function issuePath(issue: z.ZodIssue): string {
  const path = [...issue.path];
  if (issue.code === "unrecognized_keys" && issue.keys[0] !== undefined) path.push(issue.keys[0]);
  return path.length === 0
    ? ""
    : `/${path.map((segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}
// BOUNDARY: Config files are untrusted JSON; the preliminary representation check preserves the
// dedicated schema-version diagnostic before the complete config schema is applied below.
function decodeConfig(path: string, value: unknown): Result<NoesisConfig, NoesisConfigError> {
  if (
    value !== null &&
    typeof value === "object" &&
    "schemaVersion" in value &&
    value.schemaVersion !== NOESIS_CONFIG_SCHEMA_VERSION
  ) {
    return err(
      new NoesisConfigError(
        path,
        `unsupported schemaVersion ${String(value.schemaVersion)}; this build accepts only schemaVersion ${String(NOESIS_CONFIG_SCHEMA_VERSION)}. Remove ${path} and rerun onboarding to regenerate it`,
      ),
    );
  }
  const parsed = StoredNoesisConfigSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const pointer = first ? issuePath(first) : "";
    const location = pointer ? ` at ${pointer}` : "";
    const detail = first?.message ?? "value does not match the schema";
    return err(new NoesisConfigError(path, `invalid schema${location}: ${detail}`));
  }
  return ok(parsed.data);
}
export async function readNoesisConfig(home: string): Promise<
  Result<
    {
      readonly config?: NoesisConfig;
      readonly raw?: string;
    },
    NoesisConfigError
  >
> {
  const path = noesisConfigPath(home);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return ok({});
    return err(new NoesisConfigError(path, "could not read config", { cause: error }));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return err(new NoesisConfigError(path, "invalid JSON", { cause: error }));
  }
  const decoded = decodeConfig(path, parsed);
  return decoded.ok ? ok({ config: decoded.value, raw }) : decoded;
}
function validateAgentValue<K extends keyof ResolvedAgentConfig>(
  path: string,
  key: K,
  value: string,
): ResolvedAgentConfig[K] {
  if (key === "thinkingLevel") {
    if (!ThinkingLevelSchema.safeParse(value).success)
      throw new NoesisConfigError(
        path,
        `agent.thinkingLevel must be off, minimal, low, medium, high, xhigh, or max; received ${JSON.stringify(value)}`,
      );
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return value as ResolvedAgentConfig[K];
  }
  if (value.length === 0) throw new NoesisConfigError(path, `agent.${key} must be a non-empty string`);
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return value as ResolvedAgentConfig[K];
}
function pick<K extends keyof ResolvedAgentConfig>(
  path: string,
  key: K,
  cli: ConfigOverrides,
  env: Readonly<Record<string, string | undefined>>,
  file: AgentConfig,
  envName: string,
): readonly [ResolvedAgentConfig[K], ConfigSource] {
  const cliValue = cli[key];
  if (cliValue !== undefined) return [validateAgentValue(path, key, cliValue), "cli"];
  const envValue = env[envName];
  if (envValue !== undefined) return [validateAgentValue(envName, key, envValue), "environment"];
  const fileValue = file[key];
  if (fileValue !== undefined) {
    // SAFETY: K selects the same field from both AgentConfig and ResolvedAgentConfig.
    return [fileValue as ResolvedAgentConfig[K], "config"];
  }
  return [BUILT_IN_AGENT_DEFAULTS[key], "default"];
}
export async function resolveNoesisConfig(input: ResolveConfigInput): Promise<ResolvedNoesisConfig> {
  const loaded = await readNoesisConfig(input.home);
  if (!loaded.ok) throw loaded.error;
  const path = noesisConfigPath(input.home);
  const cli = input.cli ?? {};
  const env = input.env ?? process.env;
  const file = loaded.value.config?.agent ?? {};
  const configuredAgents = loaded.value.config?.agents ?? {};
  const context = loaded.value.config?.context ?? {};
  const titles = loaded.value.config?.titles ?? {};
  const reflection = loaded.value.config?.reflection ?? {};
  const [provider, providerSource] = pick(
    path,
    "provider",
    cli,
    env,
    file,
    AGENT_ENVIRONMENT_VARIABLES.provider,
  );
  const [model, modelSource] = pick(path, "model", cli, env, file, AGENT_ENVIRONMENT_VARIABLES.model);
  const [thinkingLevel, thinkingLevelSource] = pick(
    path,
    "thinkingLevel",
    cli,
    env,
    file,
    AGENT_ENVIRONMENT_VARIABLES.thinkingLevel,
  );
  return {
    schemaVersion: NOESIS_CONFIG_SCHEMA_VERSION,
    home: input.home,
    configPath: path,
    agent: { provider, model, thinkingLevel },
    agents: {
      provider: configuredAgents.provider ?? provider,
      model: configuredAgents.model ?? model,
      thinkingLevel: configuredAgents.thinkingLevel ?? thinkingLevel,
    },
    agentsSources: {
      provider: configuredAgents.provider === undefined ? "foreground" : "configured",
      model: configuredAgents.model === undefined ? "foreground" : "configured",
      thinkingLevel: configuredAgents.thinkingLevel === undefined ? "foreground" : "configured",
    },
    context: {
      tokenBudget: context.tokenBudget ?? BUILT_IN_CONTEXT_DEFAULTS.tokenBudget,
      autoCompact: context.autoCompact ?? BUILT_IN_CONTEXT_DEFAULTS.autoCompact,
    },
    titles: createConditionalObject({
      enabled: titles.enabled ?? BUILT_IN_TITLES_DEFAULTS.enabled,
      thinkingLevel: titles.thinkingLevel ?? BUILT_IN_TITLES_DEFAULTS.thinkingLevel,
    } as const)
      .addOptional(titles.provider !== undefined ? { provider: titles.provider } : undefined)
      .addOptional(titles.model !== undefined ? { model: titles.model } : undefined)
      .finish(),
    reflection: createConditionalObject({
      thinkingLevel: reflection.thinkingLevel ?? BUILT_IN_REFLECTION_DEFAULTS.thinkingLevel,
      idleMinutes: reflection.idleMinutes ?? BUILT_IN_REFLECTION_DEFAULTS.idleMinutes,
    } as const)
      .addOptional(reflection.provider !== undefined ? { provider: reflection.provider } : undefined)
      .addOptional(reflection.model !== undefined ? { model: reflection.model } : undefined)
      .finish(),
    sources: {
      provider: providerSource,
      model: modelSource,
      thinkingLevel: thinkingLevelSource,
    },
  };
}
async function writeExclusive(path: string, content: string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function acquireConfigWriterLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.writer.lock`;
  const token = randomUUID();
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
          const current = JSON.parse(await readFile(lockPath, "utf8")) as {
            token?: unknown;
          };
          if (current.token === token) await unlink(lockPath);
        } catch {
          // Release is best effort and token-bound so another writer's lock is never removed.
        }
      };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      try {
        // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
        const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
          pid?: unknown;
        };
        if (typeof lock.pid === "number") {
          try {
            process.kill(lock.pid, 0);
          } catch (probeError) {
            if (probeError instanceof Error && "code" in probeError && probeError.code === "ESRCH") {
              await unlink(lockPath).catch(() => undefined);
              continue;
            }
          }
        }
      } catch {
        // A newly created lock may be temporarily unreadable. Retry without stealing it.
      }
      await delay(10);
    }
  }
  throw new NoesisConfigError(lockPath, "timed out waiting for the config writer lock");
}
async function withConfigWriter<T>(home: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const release = await acquireConfigWriterLock(noesisConfigPath(home));
  try {
    return await operation();
  } finally {
    await release();
  }
}
async function persistConfig(home: string, config: NoesisConfig): Promise<void> {
  const path = noesisConfigPath(home);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeExclusive(temporary, renderConfig(config));
    await rename(temporary, path);
    await syncDirectory(home);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
const renderConfig = (config: NoesisConfig): string => `${JSON.stringify(config, null, 2)}\n`;
export async function initializeNoesisConfig(
  home: string,
  config: NoesisConfig = DEFAULT_NOESIS_CONFIG,
): Promise<string> {
  const path = noesisConfigPath(home);
  const decoded = decodeConfig(path, config);
  if (!decoded.ok) throw decoded.error;
  await withConfigWriter(home, async () => {
    const loaded = await readNoesisConfig(home);
    if (!loaded.ok) throw loaded.error;
    if (loaded.value.raw !== undefined)
      throw new NoesisConfigError(path, "already exists; refusing to overwrite it");
    try {
      await writeExclusive(path, renderConfig(decoded.value));
      await syncDirectory(home);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        throw new NoesisConfigError(path, "already exists; refusing to overwrite it");
      throw new NoesisConfigError(path, "could not initialize config", { cause: error });
    }
  });
  return path;
}
const AGENT_CONFIG_KEYS = ["provider", "model", "thinkingLevel"] as const;
/**
 * Rereads config.json for a running process. Command-line and environment overrides that applied
 * at startup keep their values and sources.
 */
export async function reloadNoesisConfig(previous: ResolvedNoesisConfig): Promise<ResolvedNoesisConfig> {
  const cli: Record<string, string> = {};
  const env: Record<string, string> = {};
  for (const key of AGENT_CONFIG_KEYS) {
    if (previous.sources[key] === "cli") cli[key] = previous.agent[key];
    else if (previous.sources[key] === "environment")
      env[AGENT_ENVIRONMENT_VARIABLES[key]] = previous.agent[key];
  }
  return await resolveNoesisConfig({ home: previous.home, cli, env });
}
/** `undefined` keeps the current value; `null` removes it. */
const patched = <V>(current: V | undefined, change: V | null | undefined): V | undefined =>
  change === undefined ? current : (change ?? undefined);
const nonEmpty = <T extends object>(section: T): T | undefined =>
  Object.values(section).some((value) => value !== undefined) ? section : undefined;
/** Applies one validated patch to config.json under the writer lock and returns the stored config. */
export async function updateNoesisConfig(home: string, patch: unknown): Promise<NoesisConfig> {
  const parsed = NoesisConfigPatchSchema.safeParse(patch);
  const path = noesisConfigPath(home);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const pointer = first ? issuePath(first) : "";
    throw new NoesisConfigError(
      path,
      `invalid config update${pointer ? ` at ${pointer}` : ""}: ${first?.message ?? "value does not match the schema"}`,
    );
  }
  const changes = parsed.data;
  if (
    [changes.agent, changes.agents, changes.context, changes.titles, changes.reflection].every(
      (section) => section === undefined || Object.values(section).every((value) => value === undefined),
    )
  )
    throw new NoesisConfigError(
      path,
      "config update requires at least one agent, agents, context, titles, or reflection field",
    );
  return await withConfigWriter(home, async () => {
    const loaded = await readNoesisConfig(home);
    if (!loaded.ok) throw loaded.error;
    // A missing file stays minimal so unchanged fields keep following built-in defaults.
    const current: NoesisConfig = loaded.value.config ?? {
      schemaVersion: NOESIS_CONFIG_SCHEMA_VERSION,
      agent: {},
    };
    const agents = nonEmpty({
      provider: patched(current.agents?.provider, changes.agents?.provider),
      model: patched(current.agents?.model, changes.agents?.model),
      thinkingLevel: patched(current.agents?.thinkingLevel, changes.agents?.thinkingLevel),
    });
    const context = nonEmpty({
      tokenBudget: patched(current.context?.tokenBudget, changes.context?.tokenBudget),
      autoCompact: patched(current.context?.autoCompact, changes.context?.autoCompact),
    });
    const titles = nonEmpty({
      enabled: patched(current.titles?.enabled, changes.titles?.enabled),
      provider: patched(current.titles?.provider, changes.titles?.provider),
      model: patched(current.titles?.model, changes.titles?.model),
      thinkingLevel: patched(current.titles?.thinkingLevel, changes.titles?.thinkingLevel),
    });
    const reflection = nonEmpty({
      provider: patched(current.reflection?.provider, changes.reflection?.provider),
      model: patched(current.reflection?.model, changes.reflection?.model),
      thinkingLevel: patched(current.reflection?.thinkingLevel, changes.reflection?.thinkingLevel),
      idleMinutes: patched(current.reflection?.idleMinutes, changes.reflection?.idleMinutes),
    });
    // JSON rendering drops fields left undefined by the patch.
    const decoded = decodeConfig(
      path,
      createConditionalObject({
        schemaVersion: NOESIS_CONFIG_SCHEMA_VERSION,
        agent: {
          provider: patched(current.agent.provider, changes.agent?.provider),
          model: patched(current.agent.model, changes.agent?.model),
          thinkingLevel: patched(current.agent.thinkingLevel, changes.agent?.thinkingLevel),
        },
      } as const)
        .addOptional(agents ? { agents } : undefined)
        .addOptional(context ? { context } : undefined)
        .addOptional(titles ? { titles } : undefined)
        .addOptional(reflection ? { reflection } : undefined)
        .finish(),
    );
    if (!decoded.ok) throw decoded.error;
    await persistConfig(home, decoded.value);
    return decoded.value;
  });
}
export * from "./criteria.ts";
