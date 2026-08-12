import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OpenIdProviderDiscoveryMetadataSchema,
  OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import { withMcpFileLock } from "./file-lock.ts";
import type { McpOAuthCredential, McpOAuthCredentialStore } from "./oauth.ts";

const DiscoverySchema = z.looseObject({
  authorizationServerUrl: z.string().min(1),
  authorizationServerMetadata: z
    .union([OAuthMetadataSchema, OpenIdProviderDiscoveryMetadataSchema])
    .optional(),
  resourceMetadata: OAuthProtectedResourceMetadataSchema.optional(),
  resourceMetadataUrl: z.string().optional(),
});
const CredentialSchema = z.strictObject({
  serverUrl: z.url(),
  authIdentityDigest: z.string().min(1).optional(),
  clientInformation: z.union([OAuthClientInformationSchema, OAuthClientInformationFullSchema]).optional(),
  tokens: OAuthTokensSchema.optional(),
  codeVerifier: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  discovery: DiscoverySchema.optional(),
});
const CredentialFileSchema = z.record(z.string().min(1), CredentialSchema);

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwned(path: string, metadata: Stats): void {
  const uid = currentUid();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`${path}: refusing MCP credentials owned by uid ${String(metadata.uid)}`);
  }
}

export const mcpCredentialPath = (home: string): string => join(home, "mcp-auth.json");

export function createSecureMcpOAuthCredentialStore(path: string): McpOAuthCredentialStore {
  let queue: Promise<void> = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
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
  };

  const secureDirectory = async (): Promise<void> => {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`${directory}: MCP credential parent must be a real directory`);
    }
    assertOwned(directory, metadata);
    if ((metadata.mode & 0o777) !== 0o700)
      await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).then(
        async (handle) => {
          try {
            await handle.chmod(0o700);
          } finally {
            await handle.close();
          }
        },
      );
  };

  const readAll = async (): Promise<Record<string, McpOAuthCredential>> => {
    await secureDirectory();
    let metadata: Stats;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (isCode(error, "ENOENT")) return {};
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
      throw new Error(`${path}: unsafe MCP credential file`);
    }
    assertOwned(path, metadata);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
        throw new Error(`${path}: MCP credential file changed while opening`);
      }
      if ((opened.mode & 0o777) !== 0o600) await handle.chmod(0o600);
      const raw: unknown = JSON.parse(await handle.readFile("utf8"));
      const parsed = CredentialFileSchema.parse(raw);
      const credentials: Record<string, McpOAuthCredential> = {};
      for (const [key, credential] of Object.entries(parsed)) {
        const discovery = credential.discovery
          ? {
              authorizationServerUrl: credential.discovery.authorizationServerUrl,
              ...(credential.discovery.authorizationServerMetadata
                ? { authorizationServerMetadata: credential.discovery.authorizationServerMetadata }
                : {}),
              ...(credential.discovery.resourceMetadata
                ? { resourceMetadata: credential.discovery.resourceMetadata }
                : {}),
              ...(credential.discovery.resourceMetadataUrl
                ? { resourceMetadataUrl: credential.discovery.resourceMetadataUrl }
                : {}),
            }
          : undefined;
        credentials[key] = {
          serverUrl: credential.serverUrl,
          ...(credential.authIdentityDigest ? { authIdentityDigest: credential.authIdentityDigest } : {}),
          ...(credential.clientInformation ? { clientInformation: credential.clientInformation } : {}),
          ...(credential.tokens ? { tokens: credential.tokens } : {}),
          ...(credential.codeVerifier ? { codeVerifier: credential.codeVerifier } : {}),
          ...(credential.state ? { state: credential.state } : {}),
          ...(discovery ? { discovery } : {}),
        };
      }
      return credentials;
    } finally {
      await handle.close();
    }
  };

  const persist = async (credentials: Readonly<Record<string, McpOAuthCredential>>): Promise<void> => {
    await secureDirectory();
    CredentialFileSchema.parse(credentials);
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      const existing = await lstat(path).catch((error: unknown) => {
        if (isCode(error, "ENOENT")) return undefined;
        throw error;
      });
      if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1)) {
        throw new Error(`${path}: refusing to replace unsafe MCP credential file`);
      }
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  };

  const store: McpOAuthCredentialStore = {
    read: (key: string) => enqueue(async () => (await readAll())[key]),
    write: (key: string, credential: McpOAuthCredential) =>
      enqueue(async () => {
        await secureDirectory();
        await withMcpFileLock(path, async () => {
          const current = await readAll();
          await persist({ ...current, [key]: credential });
        });
      }),
    update: (key, update) =>
      enqueue(async () => {
        await secureDirectory();
        await withMcpFileLock(path, async () => {
          const current = await readAll();
          await persist({ ...current, [key]: update(current[key]) });
        });
      }),
    delete: (key: string) =>
      enqueue(async () => {
        await secureDirectory();
        await withMcpFileLock(path, async () => {
          const current = await readAll();
          if (!(key in current)) return;
          const next = { ...current };
          delete next[key];
          await persist(next);
        });
      }),
  };
  return Object.freeze(store);
}
