import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "@noesis/domain";
import { z } from "zod";

export const NOESIS_CONFIG_SCHEMA_VERSION = 1 as const;

export const AgentRuntimeSchema = z.enum(["fake", "pi"]);
export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;

export const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

export const AgentConfigSchema = z.strictObject({
  runtime: AgentRuntimeSchema.optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
});
export type AgentConfig = Readonly<z.infer<typeof AgentConfigSchema>>;
type MutableAgentConfig = { -readonly [Key in keyof AgentConfig]: AgentConfig[Key] };

export const NoesisConfigSchema = z.strictObject({
  schemaVersion: z.literal(NOESIS_CONFIG_SCHEMA_VERSION),
  agent: AgentConfigSchema,
});
export type NoesisConfig = Readonly<z.infer<typeof NoesisConfigSchema>>;

export interface ResolvedAgentConfig {
  readonly runtime: AgentRuntime;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
}

export type ConfigSource = "cli" | "environment" | "config" | "default";

export interface ResolvedNoesisConfig {
  readonly schemaVersion: 1;
  readonly home: string;
  readonly configPath: string;
  readonly agent: ResolvedAgentConfig;
  readonly sources: Readonly<Record<keyof ResolvedAgentConfig, ConfigSource>>;
}

export interface ConfigOverrides {
  readonly runtime?: string;
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

  constructor(path: string, message: string, options?: { cause?: unknown }) {
    super(`${path}: ${message}`, options);
    this.name = "NoesisConfigError";
    this.path = path;
  }
}

export const BUILT_IN_AGENT_DEFAULTS: ResolvedAgentConfig = {
  runtime: "fake",
  provider: "fake",
  model: "noesis-fake-1",
  thinkingLevel: "off",
};

export const DEFAULT_NOESIS_CONFIG: NoesisConfig = {
  schemaVersion: NOESIS_CONFIG_SCHEMA_VERSION,
  agent: { ...BUILT_IN_AGENT_DEFAULTS },
};

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
        `unsupported schemaVersion ${String(value.schemaVersion)}; this build accepts only schemaVersion 1`,
      ),
    );
  }
  const parsed = NoesisConfigSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const pointer = first ? issuePath(first) : "";
    const location = pointer ? ` at ${pointer}` : "";
    const detail = first?.message ?? "value does not match the schema";
    return err(new NoesisConfigError(path, `invalid schema${location}: ${detail}`));
  }
  return ok(parsed.data);
}

export async function readNoesisConfig(
  home: string,
): Promise<Result<{ readonly config?: NoesisConfig; readonly raw?: string }, NoesisConfigError>> {
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
  if (key === "runtime") {
    if (value !== "fake" && value !== "pi")
      throw new NoesisConfigError(
        path,
        `agent.runtime must be "fake" or "pi"; received ${JSON.stringify(value)}`,
      );
    return value as ResolvedAgentConfig[K];
  }
  if (key === "thinkingLevel") {
    if (!ThinkingLevelSchema.safeParse(value).success)
      throw new NoesisConfigError(
        path,
        `agent.thinkingLevel must be off, minimal, low, medium, high, xhigh, or max; received ${JSON.stringify(value)}`,
      );
    return value as ResolvedAgentConfig[K];
  }
  if (value.length === 0) throw new NoesisConfigError(path, `agent.${key} must be a non-empty string`);
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
  if (fileValue !== undefined) return [fileValue as ResolvedAgentConfig[K], "config"];
  return [BUILT_IN_AGENT_DEFAULTS[key], "default"];
}

export async function resolveNoesisConfig(input: ResolveConfigInput): Promise<ResolvedNoesisConfig> {
  const loaded = await readNoesisConfig(input.home);
  if (!loaded.ok) throw loaded.error;
  const path = noesisConfigPath(input.home);
  const cli = input.cli ?? {};
  const env = input.env ?? process.env;
  const file = loaded.value.config?.agent ?? {};
  const [runtime, runtimeSource] = pick(path, "runtime", cli, env, file, "NOESIS_RUNTIME");
  const [provider, providerSource] = pick(path, "provider", cli, env, file, "NOESIS_PROVIDER");
  const [model, modelSource] = pick(path, "model", cli, env, file, "NOESIS_MODEL");
  const [thinkingLevel, thinkingLevelSource] = pick(
    path,
    "thinkingLevel",
    cli,
    env,
    file,
    "NOESIS_THINKING_LEVEL",
  );
  return {
    schemaVersion: NOESIS_CONFIG_SCHEMA_VERSION,
    home: input.home,
    configPath: path,
    agent: { runtime, provider, model, thinkingLevel },
    sources: {
      runtime: runtimeSource,
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
          const current = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
          if (current.token === token) await unlink(lockPath);
        } catch {
          // Release is best effort and token-bound so another writer's lock is never removed.
        }
      };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      try {
        const lock = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
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

export async function updateNoesisConfig(home: string, patch: ConfigOverrides): Promise<NoesisConfig> {
  if (Object.values(patch).every((value) => value === undefined))
    throw new NoesisConfigError(noesisConfigPath(home), "config set requires at least one agent option");
  return await withConfigWriter(home, async () => {
    const loaded = await readNoesisConfig(home);
    if (!loaded.ok) throw loaded.error;
    const path = noesisConfigPath(home);
    const current = loaded.value.config ?? DEFAULT_NOESIS_CONFIG;
    const nextAgent: MutableAgentConfig = { ...current.agent };
    if (patch.runtime !== undefined) nextAgent.runtime = validateAgentValue(path, "runtime", patch.runtime);
    if (patch.provider !== undefined)
      nextAgent.provider = validateAgentValue(path, "provider", patch.provider);
    if (patch.model !== undefined) nextAgent.model = validateAgentValue(path, "model", patch.model);
    if (patch.thinkingLevel !== undefined)
      nextAgent.thinkingLevel = validateAgentValue(path, "thinkingLevel", patch.thinkingLevel);
    const next: NoesisConfig = { schemaVersion: NOESIS_CONFIG_SCHEMA_VERSION, agent: nextAgent };
    await persistConfig(home, next);
    return next;
  });
}
