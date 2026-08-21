import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { withMcpFileLock } from "./file-lock.ts";

export type McpConfigScope = "global" | "project";

const ServerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/u);
/** Map a child variable or HTTP header name to a source process-environment variable name. */
const EnvironmentReferenceSchema = z.record(z.string().min(1), z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u));

export const McpOAuthConfigSchema = z.union([
  z.boolean(),
  z.strictObject({
    clientId: z.string().min(1).optional(),
    clientSecretEnvironment: z.string().min(1).optional(),
    scope: z.string().min(1).optional(),
    callbackPort: z.number().int().min(1).max(65_535).optional(),
    redirectUri: z.url().optional(),
  }),
]);
export type McpOAuthConfig = Readonly<z.infer<typeof McpOAuthConfigSchema>>;

export const McpLocalServerConfigSchema = z.strictObject({
  type: z.literal("local"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  description: z.string().trim().min(1).optional(),
  cwd: z.string().min(1).optional(),
  environment: EnvironmentReferenceSchema.optional(),
  timeout: z.number().int().positive().optional(),
});
export type McpLocalServerConfig = Readonly<z.infer<typeof McpLocalServerConfigSchema>>;

export type McpLocalServerInput = Omit<McpLocalServerConfig, "command" | "args"> &
  Readonly<{
    /** A command and optional arguments. Array form is accepted as a convenient authoring shorthand. */
    command: string | readonly [string, ...string[]];
    args?: readonly string[];
  }>;

export function normalizeMcpLocalServerConfig(input: McpLocalServerInput): McpLocalServerConfig {
  if (typeof input.command === "string") {
    return McpLocalServerConfigSchema.parse({ ...input, command: input.command, args: input.args });
  }
  const [command, ...args] = input.command;
  return McpLocalServerConfigSchema.parse({ ...input, command, args });
}

export const McpRemoteServerConfigSchema = z.strictObject({
  type: z.literal("remote"),
  url: z.url(),
  enabled: z.boolean().optional(),
  description: z.string().trim().min(1).optional(),
  headers: EnvironmentReferenceSchema.optional(),
  oauth: McpOAuthConfigSchema.optional(),
  transport: z.enum(["auto", "streamable_http", "sse"]).optional(),
  timeout: z.number().int().positive().optional(),
});
export type McpRemoteServerConfig = Readonly<z.infer<typeof McpRemoteServerConfigSchema>>;

const McpLocalServerArrayConfigSchema = z
  .strictObject({
    type: z.literal("local"),
    command: z.tuple([z.string().min(1)], z.string()),
    enabled: z.boolean().optional(),
    description: z.string().trim().min(1).optional(),
    cwd: z.string().min(1).optional(),
    environment: EnvironmentReferenceSchema.optional(),
    timeout: z.number().int().positive().optional(),
  })
  .transform(({ command: [command, ...args], ...config }) => ({ ...config, command, args }));

export const McpServerConfigSchema = z.union([
  McpLocalServerConfigSchema,
  McpLocalServerArrayConfigSchema,
  McpRemoteServerConfigSchema,
]);
export type McpServerConfig = Readonly<z.infer<typeof McpServerConfigSchema>>;

export const McpConfigSchema = z.strictObject({
  servers: z.record(ServerNameSchema, McpServerConfigSchema).default({}),
});
export type McpConfig = Readonly<z.infer<typeof McpConfigSchema>>;

export interface ScopedMcpServer {
  readonly name: string;
  readonly scope: McpConfigScope;
  readonly sourcePath: string;
  readonly config: McpServerConfig;
}

export interface InstalledMcpServer extends ScopedMcpServer {
  readonly shadowed: boolean;
}

export interface LoadedMcpConfig {
  readonly global: McpConfig;
  readonly project: McpConfig;
  /** Effective definitions. A project definition shadows a global definition with the same name. */
  readonly servers: ReadonlyMap<string, ScopedMcpServer>;
  readonly installed: readonly InstalledMcpServer[];
}

export interface McpConfigError extends Error {
  readonly name: "McpConfigError";
  readonly path: string;
}

export function createMcpConfigError(
  path: string,
  message: string,
  options?: Readonly<{ cause?: unknown }>,
): McpConfigError {
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return Object.assign(new Error(`${path}: ${message}`, options), {
    name: "McpConfigError" as const,
    path,
  });
}

export const globalMcpConfigPath = (home: string): string => join(home, "mcp.json");
export const projectMcpConfigPath = (projectDirectory: string): string =>
  join(projectDirectory, ".noesis", "mcp.json");

function issueLocation(issue: z.core.$ZodIssue | undefined): string {
  if (!issue || issue.path.length === 0) return "";
  return ` at /${issue.path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

export async function readMcpConfig(path: string): Promise<McpConfig> {
  return (await readMcpConfigSnapshot(path)).config;
}

export async function loadMcpConfig(input: {
  readonly home: string;
  readonly projectDirectory: string;
}): Promise<LoadedMcpConfig> {
  const globalPath = globalMcpConfigPath(input.home);
  const projectPath = projectMcpConfigPath(input.projectDirectory);
  const [global, project] = await Promise.all([readMcpConfig(globalPath), readMcpConfig(projectPath)]);
  const servers = new Map<string, ScopedMcpServer>();
  for (const [name, config] of Object.entries(global.servers)) {
    servers.set(name, Object.freeze({ name, scope: "global", sourcePath: globalPath, config }));
  }
  for (const [name, config] of Object.entries(project.servers)) {
    servers.set(name, Object.freeze({ name, scope: "project", sourcePath: projectPath, config }));
  }
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const installed = Object.freeze([
    ...Object.entries(global.servers).map(([name, config]) =>
      Object.freeze({
        name,
        scope: "global" as const,
        sourcePath: globalPath,
        config,
        shadowed: Object.hasOwn(project.servers, name),
      }),
    ),
    ...Object.entries(project.servers).map(([name, config]) =>
      Object.freeze({
        name,
        scope: "project" as const,
        sourcePath: projectPath,
        config,
        shadowed: false,
      }),
    ),
  ]);
  return Object.freeze({ global, project, servers, installed });
}

interface McpConfigSnapshot {
  readonly config: McpConfig;
  /** Exact bytes observed before a read-modify-write mutation. Null means the file did not exist. */
  readonly raw: string | null;
}

const configMutationTails = new Map<string, Promise<void>>();
const MAX_CONFIG_MUTATION_ATTEMPTS = 8;

async function readMcpConfigSnapshot(path: string): Promise<McpConfigSnapshot> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { config: { servers: {} }, raw: null };
    }
    throw createMcpConfigError(path, "could not read MCP configuration", { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw createMcpConfigError(path, "invalid JSON", { cause: error });
  }
  const parsed = McpConfigSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw createMcpConfigError(
      path,
      `invalid MCP configuration${issueLocation(first)}: ${first?.message ?? "unknown error"}`,
    );
  }
  return { config: parsed.data, raw };
}

async function readRawConfig(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw createMcpConfigError(path, "could not verify MCP configuration before writing", {
      cause: error,
    });
  }
}

async function writeMcpConfigIfUnchanged(
  path: string,
  config: McpConfig,
  expectedRaw: string | null,
): Promise<boolean> {
  const parsed = McpConfigSchema.parse(config);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Let file watchers and editors finish any write that was already in flight before the CAS check.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if ((await readRawConfig(path)) !== expectedRaw) {
      await unlink(temporaryPath).catch(() => undefined);
      return false;
    }
    await rename(temporaryPath, path);
    const directoryHandle = await open(
      dirname(path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return true;
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw createMcpConfigError(path, "could not write MCP configuration", { cause: error });
  }
}

async function serializeConfigMutation<T>(path: string, mutation: () => Promise<T>): Promise<T> {
  const previous = configMutationTails.get(path) ?? Promise.resolve();
  const result = previous.then(mutation, mutation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  configMutationTails.set(path, tail);
  return result.finally(() => {
    if (configMutationTails.get(path) === tail) configMutationTails.delete(path);
  });
}

async function mutateMcpConfig(path: string, mutation: (current: McpConfig) => McpConfig): Promise<void> {
  await serializeConfigMutation(path, async () => {
    await withMcpFileLock(path, async () => {
      for (let attempt = 0; attempt < MAX_CONFIG_MUTATION_ATTEMPTS; attempt += 1) {
        const snapshot = await readMcpConfigSnapshot(path);
        const next = mutation(snapshot.config);
        if (await writeMcpConfigIfUnchanged(path, next, snapshot.raw)) return;
      }
      throw createMcpConfigError(
        path,
        `configuration kept changing during ${String(MAX_CONFIG_MUTATION_ATTEMPTS)} write attempts`,
      );
    });
  });
}

function pathForScope(input: {
  readonly home: string;
  readonly projectDirectory: string;
  readonly scope: McpConfigScope;
}): string {
  return input.scope === "global"
    ? globalMcpConfigPath(input.home)
    : projectMcpConfigPath(input.projectDirectory);
}

export async function writeMcpServer(input: {
  readonly home: string;
  readonly projectDirectory: string;
  readonly scope: McpConfigScope;
  readonly name: string;
  readonly config: McpServerConfig;
}): Promise<void> {
  const name = ServerNameSchema.parse(input.name);
  const path = pathForScope(input);
  await mutateMcpConfig(path, (current) => ({
    servers: { ...current.servers, [name]: input.config },
  }));
}

export async function removeMcpServer(input: {
  readonly home: string;
  readonly projectDirectory: string;
  readonly scope: McpConfigScope;
  readonly name: string;
}): Promise<void> {
  const name = ServerNameSchema.parse(input.name);
  const path = pathForScope(input);
  await mutateMcpConfig(path, (current) => {
    const servers = { ...current.servers };
    delete servers[name];
    return { servers };
  });
}

export async function setMcpServerEnabled(input: {
  readonly home: string;
  readonly projectDirectory: string;
  readonly scope: McpConfigScope;
  readonly name: string;
  readonly enabled: boolean;
}): Promise<void> {
  const name = ServerNameSchema.parse(input.name);
  const path = pathForScope(input);
  await mutateMcpConfig(path, (current) => {
    const server = Object.hasOwn(current.servers, name) ? current.servers[name] : undefined;
    if (!server) throw createMcpConfigError(path, `server ${JSON.stringify(name)} does not exist`);
    return {
      servers: { ...current.servers, [name]: { ...server, enabled: input.enabled } },
    };
  });
}
