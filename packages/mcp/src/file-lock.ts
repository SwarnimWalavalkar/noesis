import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";

interface FileLockRecord {
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly createdAt: number;
}

const DEFAULT_LOCK_TIMEOUT = 5_000;
const DEFAULT_STALE_AFTER = 30_000;
const LOCK_RETRY_DELAY = 20;

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isCode(error, "ESRCH");
  }
}

async function readLockRecord(path: string): Promise<FileLockRecord | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("token" in value) ||
      typeof value.token !== "string" ||
      !("pid" in value) ||
      typeof value.pid !== "number" ||
      !("hostname" in value) ||
      typeof value.hostname !== "string" ||
      !("createdAt" in value) ||
      typeof value.createdAt !== "number"
    )
      return undefined;
    return {
      token: value.token,
      pid: value.pid,
      hostname: value.hostname,
      createdAt: value.createdAt,
    };
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    return undefined;
  }
}

async function removeStaleLock(path: string, staleAfter: number): Promise<void> {
  const reaperPath = `${path}.reap`;
  let reaper: Awaited<ReturnType<typeof open>>;
  try {
    reaper = await open(reaperPath, "wx", 0o600);
  } catch (error) {
    if (isCode(error, "EEXIST")) return;
    throw error;
  }
  try {
    let metadata: Stats;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`${path}: MCP lock path must be a regular file`);
    }
    if (Date.now() - metadata.mtimeMs <= staleAfter) return;
    const record = await readLockRecord(path);
    if (record?.hostname === hostname() && processIsAlive(record.pid)) return;
    await unlink(path).catch((error: unknown) => {
      if (!isCode(error, "ENOENT")) throw error;
    });
  } finally {
    await reaper.close();
    await unlink(reaperPath).catch((error: unknown) => {
      if (!isCode(error, "ENOENT")) throw error;
    });
  }
}

async function hasActiveReaper(path: string, staleAfter: number): Promise<boolean> {
  const reaperPath = `${path}.reap`;
  try {
    const metadata = await lstat(reaperPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`${path}.reap: MCP lock reaper path must be a regular file`);
    }
    if (Date.now() - metadata.mtimeMs <= staleAfter) return true;
    await unlink(reaperPath).catch((error: unknown) => {
      if (!isCode(error, "ENOENT")) throw error;
    });
    return false;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

/** Serialize a short read-modify-write transaction across Noesis processes. */
export async function withMcpFileLock<T>(
  targetPath: string,
  operation: () => Promise<T>,
  options: Readonly<{ timeout?: number; staleAfter?: number }> = {},
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const timeout = options.timeout ?? DEFAULT_LOCK_TIMEOUT;
  const staleAfter = options.staleAfter ?? DEFAULT_STALE_AFTER;
  const deadline = Date.now() + timeout;
  const record: FileLockRecord = {
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    createdAt: Date.now(),
  };
  await mkdir(dirname(targetPath), { recursive: true });

  while (true) {
    if (await hasActiveReaper(lockPath, staleAfter)) {
      if (Date.now() >= deadline) throw new Error(`${targetPath}: timed out waiting for MCP file lock`);
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY));
      continue;
    }
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`);
        await handle.sync();
      } catch (error) {
        await unlink(lockPath).catch(() => undefined);
        throw error;
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      await removeStaleLock(lockPath, staleAfter);
      if (Date.now() >= deadline) throw new Error(`${targetPath}: timed out waiting for MCP file lock`);
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY));
    }
  }

  try {
    return await operation();
  } finally {
    const current = await readLockRecord(lockPath);
    if (current?.token === record.token) {
      await unlink(lockPath).catch((error: unknown) => {
        if (!isCode(error, "ENOENT")) throw error;
      });
    }
  }
}
