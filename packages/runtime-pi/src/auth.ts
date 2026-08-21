import {
  createConditionalObject,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  JsonValueSchema,
} from "@noesis/domain";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createModels,
  type AuthContext,
  type AuthLoginCallbacks,
  type Credential,
  type CredentialStore,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
type CredentialFile = Readonly<Record<string, Credential>>;
// SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
export const NOESIS_PROVIDER_IDS = Object.freeze([
  "openai-codex",
  "anthropic",
  "openrouter",
  "opencode",
] as const);
const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const isRecord = (value: JsonValue | undefined): value is JsonObject => isJsonObject(value);
function isCredential(value: JsonValue): boolean {
  if (!isRecord(value)) return false;
  if (value["type"] === "api_key") {
    if (value["key"] !== undefined && typeof value["key"] !== "string") return false;
    const env = value["env"];
    return (
      env === undefined || (isRecord(env) && Object.values(env).every((entry) => typeof entry === "string"))
    );
  }
  return (
    value["type"] === "oauth" &&
    typeof value["access"] === "string" &&
    typeof value["refresh"] === "string" &&
    typeof value["expires"] === "number" &&
    Number.isFinite(value["expires"])
  );
}
function decodeCredentialFile(path: string, raw: string) {
  let parsed: JsonValue;
  try {
    parsed = JsonValueSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`${path}: invalid credential JSON`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error(`${path}: invalid Pi credential store; expected a provider object`);
  const credentials: Record<string, Credential> = {};
  for (const [provider, value] of Object.entries(parsed)) {
    if (!isCredential(value)) throw new Error(`${path}: invalid typed credential for provider ${provider}`);
    // SAFETY: isCredential has validated the complete Pi credential discriminated union.
    credentials[provider] = value as Credential;
  }
  return credentials;
}
export const piAuthPath = (home: string): string => join(home, "auth.json");
interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}
function isCode(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}
function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}
function assertOwned(path: string, uid: number | undefined, actualUid: number): void {
  if (uid !== undefined && actualUid !== uid)
    throw new Error(`${path}: refusing to use a filesystem entry owned by uid ${actualUid}`);
}
export interface SecurePiCredentialStore {
  readonly path: string;
  readonly read: (providerId: string) => Promise<Credential | undefined>;
  readonly modify: (
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ) => Promise<Credential | undefined>;
  readonly delete: (providerId: string) => Promise<void>;
}
export function createSecurePiCredentialStore(path: string): SecurePiCredentialStore {
  let queue: Promise<void> = Promise.resolve();
  const read = async (providerId: string): Promise<Credential | undefined> => {
    return await enqueue(async () =>
      withProcessLock(async (directory) => (await readCredentials(directory))[providerId]),
    );
  };
  const modify = (
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> => {
    return enqueue(async () =>
      withProcessLock(async (directory) => {
        const current = await readCredentials(directory);
        const next = await fn(current[providerId]);
        if (next === undefined) return current[providerId];
        await persist({ ...current, [providerId]: next }, directory);
        return next;
      }),
    );
  };
  const remove = (providerId: string): Promise<void> => {
    return enqueue(async () =>
      withProcessLock(async (directory) => {
        const current = await readCredentials(directory);
        if (!(providerId in current)) return;
        const next = { ...current };
        delete next[providerId];
        await persist(next, directory);
      }),
    );
  };
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const prior = queue;
    let release: (() => void) | undefined;
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return (async () => {
      await prior.catch(() => undefined);
      try {
        return await operation();
      } finally {
        release?.();
      }
    })();
  }
  async function secureDirectory(): Promise<FileIdentity> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let metadata = await lstat(directory);
    if (metadata.isSymbolicLink())
      throw new Error(`${directory}: refusing to use a symbolic link as the Pi credential directory`);
    if (!metadata.isDirectory()) throw new Error(`${directory}: Pi credential parent is not a directory`);
    assertOwned(directory, currentUid(), metadata.uid);
    if ((metadata.mode & 0o777) !== 0o700) {
      const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      let tightened: Stats;
      try {
        const opened = await handle.stat();
        if (!opened.isDirectory() || opened.dev !== metadata.dev || opened.ino !== metadata.ino)
          throw new Error(`${directory}: credential directory changed before tightening permissions`);
        await handle.chmod(0o700);
        tightened = await handle.stat();
      } finally {
        await handle.close();
      }
      if (!tightened.isDirectory() || tightened.dev !== metadata.dev || tightened.ino !== metadata.ino)
        throw new Error(`${directory}: credential directory changed while tightening permissions`);
      assertOwned(directory, currentUid(), tightened.uid);
      if ((tightened.mode & 0o777) !== 0o700)
        throw new Error(`${directory}: could not tighten Pi credential directory permissions to 0700`);
      metadata = tightened;
    }
    return { dev: metadata.dev, ino: metadata.ino };
  }
  async function assertDirectoryIdentity(expected: FileIdentity): Promise<void> {
    const directory = dirname(path);
    const metadata = await lstat(directory);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.dev !== expected.dev ||
      metadata.ino !== expected.ino
    )
      throw new Error(`${directory}: credential directory changed during authentication storage access`);
    assertOwned(directory, currentUid(), metadata.uid);
    if ((metadata.mode & 0o777) !== 0o700)
      throw new Error(`${directory}: unsafe Pi credential directory permissions; expected 0700`);
  }
  async function secureCredentialFile(): Promise<FileIdentity | undefined> {
    let metadata: Stats;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (isCode(error, "ENOENT")) return undefined;
      throw error;
    }
    if (metadata.isSymbolicLink())
      throw new Error(`${path}: refusing to read or replace a symbolic link as Pi credentials`);
    if (!metadata.isFile()) throw new Error(`${path}: Pi credential path is not a regular file`);
    assertOwned(path, currentUid(), metadata.uid);
    if (metadata.nlink !== 1) throw new Error(`${path}: Pi credential file has an unsafe link count`);
    if ((metadata.mode & 0o777) !== 0o600) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let tightened: Stats;
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.dev !== metadata.dev ||
          opened.ino !== metadata.ino ||
          opened.nlink !== 1
        )
          throw new Error(`${path}: credential file changed before tightening permissions`);
        await handle.chmod(0o600);
        tightened = await handle.stat();
      } finally {
        await handle.close();
      }
      if (
        !tightened.isFile() ||
        tightened.dev !== metadata.dev ||
        tightened.ino !== metadata.ino ||
        tightened.nlink !== 1
      )
        throw new Error(`${path}: credential file changed while tightening permissions`);
      assertOwned(path, currentUid(), tightened.uid);
      if ((tightened.mode & 0o777) !== 0o600)
        throw new Error(`${path}: could not tighten Pi credential permissions to 0600`);
      metadata = tightened;
    }
    return { dev: metadata.dev, ino: metadata.ino };
  }
  async function readRegularFile(filePath: string): Promise<string> {
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }
  async function readCredentials(directory: FileIdentity): Promise<CredentialFile> {
    await assertDirectoryIdentity(directory);
    const identity = await secureCredentialFile();
    if (!identity) return {};
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.dev !== identity.dev || metadata.ino !== identity.ino)
        throw new Error(`${path}: credential file changed before it could be read safely`);
      return decodeCredentialFile(path, await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  }
  async function readLock(lockPath: string): Promise<{
    readonly token?: unknown;
    readonly pid?: unknown;
  }> {
    const metadata = await lstat(lockPath);
    if (metadata.isSymbolicLink() || !metadata.isFile())
      throw new Error(`${lockPath}: unsafe Pi credential lock entry`);
    assertOwned(lockPath, currentUid(), metadata.uid);
    if ((metadata.mode & 0o777) !== 0o600 || metadata.nlink !== 1)
      throw new Error(`${lockPath}: unsafe Pi credential lock permissions`);
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    return JSON.parse(await readRegularFile(lockPath)) as {
      token?: unknown;
      pid?: unknown;
    };
  }
  async function withProcessLock<T>(operation: (directory: FileIdentity) => Promise<T>): Promise<T> {
    const directory = await secureDirectory();
    const lockPath = `${path}.lock`;
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
        try {
          await assertDirectoryIdentity(directory);
          return await operation(directory);
        } finally {
          try {
            const current = await readLock(lockPath);
            if (current.token === token) await unlink(lockPath);
          } catch {
            // Unlock is best effort. The token check prevents removing another writer's lock.
          }
        }
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        try {
          const lock = await readLock(lockPath);
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
          // A new lock may not have been fully written yet. Retry without stealing it.
        }
        await delay(10);
      }
    }
    throw new Error(`${lockPath}: timed out waiting for the Pi credential writer lock`);
  }
  async function persist(credentials: CredentialFile, directoryIdentity: FileIdentity): Promise<void> {
    const directory = dirname(path);
    await assertDirectoryIdentity(directoryIdentity);
    await secureCredentialFile();
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    let temporaryIdentity: FileIdentity;
    try {
      await handle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`);
      await handle.sync();
      const metadata = await handle.stat();
      temporaryIdentity = { dev: metadata.dev, ino: metadata.ino };
    } finally {
      await handle.close();
    }
    try {
      await assertDirectoryIdentity(directoryIdentity);
      await rename(temporary, path);
      const installed = await lstat(path);
      if (
        !installed.isFile() ||
        installed.isSymbolicLink() ||
        installed.dev !== temporaryIdentity.dev ||
        installed.ino !== temporaryIdentity.ino ||
        installed.nlink !== 1 ||
        (installed.mode & 0o777) !== 0o600
      )
        throw new Error(`${path}: atomically installed credential file failed safety validation`);
      assertOwned(path, currentUid(), installed.uid);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  return Object.freeze({ path, read, modify, delete: remove });
}
export interface PiAuthStatus {
  readonly provider: string;
  readonly configured: boolean;
  readonly source: "oauth" | "stored-api-key" | "environment" | "none";
  readonly expired?: boolean;
}
export type NoesisAuthPrompt = {
  readonly signal?: AbortSignal;
} & (
  | {
      readonly type: "text";
      readonly message: string;
      readonly placeholder?: string;
    }
  | {
      readonly type: "secret";
      readonly message: string;
      readonly placeholder?: string;
    }
  | {
      readonly type: "select";
      readonly message: string;
      readonly options: readonly {
        readonly id: string;
        readonly label: string;
        readonly description?: string;
      }[];
    }
  | {
      readonly type: "manual_code";
      readonly message: string;
      readonly placeholder?: string;
    }
);
export type NoesisAuthEvent =
  | {
      readonly type: "auth_url";
      readonly url: string;
      readonly instructions?: string;
    }
  | {
      readonly type: "device_code";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly intervalSeconds?: number;
      readonly expiresInSeconds?: number;
    }
  | {
      readonly type: "progress";
      readonly message: string;
    };
export interface NoesisOAuthCallbackPage {
  readonly provider: "openai-codex";
  readonly status: "success";
}
export interface NoesisAuthLoginCallbacks {
  readonly signal?: AbortSignal;
  prompt(prompt: NoesisAuthPrompt): Promise<string>;
  notify(event: NoesisAuthEvent): void;
  renderOAuthCallbackPage?(page: NoesisOAuthCallbackPage): string;
}
export interface PiAuthManager {
  readonly login: (providerId: string, callbacks: NoesisAuthLoginCallbacks) => Promise<PiAuthStatus>;
  readonly status: (providerId: string) => Promise<PiAuthStatus>;
  readonly logout: (providerId: string) => Promise<void>;
}
export type PiAuthOperations = PiAuthManager;
export function createPiAuthManager(models: MutableModels, credentials: CredentialStore): PiAuthManager {
  const login = async (providerId: string, callbacks: NoesisAuthLoginCallbacks): Promise<PiAuthStatus> => {
    const provider = models.getProvider(providerId);
    if (!provider) throw new Error(`Unknown Pi provider ${providerId}`);
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const piCallbacks: AuthLoginCallbacks = createConditionalObject({} as const)
      .addOptional(callbacks.signal ? { signal: callbacks.signal } : undefined)
      .add({
        prompt: async (prompt: Parameters<AuthLoginCallbacks["prompt"]>[0]) => await callbacks.prompt(prompt),
        notify: (event: Parameters<AuthLoginCallbacks["notify"]>[0]) => callbacks.notify(event),
      } as const)
      .addOptional(
        callbacks.renderOAuthCallbackPage
          ? {
              renderOAuthCallbackPage: callbacks.renderOAuthCallbackPage,
            }
          : undefined,
      )
      .finish();
    const credential = provider.auth.oauth
      ? await provider.auth.oauth.login(piCallbacks)
      : provider.auth.apiKey?.login
        ? await provider.auth.apiKey.login(piCallbacks)
        : undefined;
    if (!credential) throw new Error(`Pi provider ${providerId} does not support interactive login`);
    await credentials.modify(providerId, async () => credential);
    return await status(providerId);
  };
  const status = async (providerId: string): Promise<PiAuthStatus> => {
    const provider = models.getProvider(providerId);
    if (!provider) throw new Error(`Unknown Pi provider ${providerId}`);
    const stored = await credentials.read(providerId);
    if (stored?.type === "oauth")
      return {
        provider: providerId,
        configured: true,
        source: "oauth",
        expired: Date.now() >= stored.expires,
      };
    if (stored?.type === "api_key")
      return { provider: providerId, configured: true, source: "stored-api-key" };
    const model = provider.getModels()[0];
    const ambient = model ? await models.getAuth(model) : undefined;
    return {
      provider: providerId,
      configured: ambient !== undefined,
      source: ambient === undefined ? "none" : "environment",
    };
  };
  const logout = async (providerId: string): Promise<void> => {
    if (!models.getProvider(providerId)) throw new Error(`Unknown Pi provider ${providerId}`);
    await credentials.delete(providerId);
  };
  return Object.freeze({ login, status, logout });
}
export interface PiModelServices {
  readonly models: MutableModels;
  readonly credentials: CredentialStore;
  readonly auth: PiAuthOperations;
}
export function createPiModelServices(
  home: string,
  options: {
    readonly credentials?: CredentialStore;
    readonly authContext?: AuthContext;
  } = {},
): PiModelServices {
  const credentials = options.credentials ?? createSecurePiCredentialStore(piAuthPath(home));
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  const models = createModels(
    createConditionalObject({
      credentials,
    } as const)
      .addOptional(options.authContext ? { authContext: options.authContext } : undefined)
      .finish(),
  );
  models.setProvider(openaiCodexProvider());
  models.setProvider(openrouterProvider());
  models.setProvider(anthropicProvider());
  models.setProvider(opencodeProvider());
  return Object.freeze({ models, credentials, auth: createPiAuthManager(models, credentials) });
}
export async function credentialFileMode(home: string): Promise<number | undefined> {
  try {
    const metadata = await lstat(piAuthPath(home));
    if (metadata.isSymbolicLink()) throw new Error(`${piAuthPath(home)}: credential path is a symbolic link`);
    return metadata.mode & 0o777;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
