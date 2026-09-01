import { JsonValueSchema, isJsonObject, type JsonObject } from "@noesis/domain";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";

const StoredModelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    api: z.string(),
    provider: z.string(),
    baseUrl: z.string(),
    reasoning: z.boolean(),
    input: z.array(z.enum(["text", "image"])),
    cost: z
      .object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number(),
        cacheWrite: z.number(),
      })
      .passthrough(),
    contextWindow: z.number(),
    maxTokens: z.number(),
  })
  .passthrough();

const ModelsStoreEntrySchema = z
  .object({
    models: z.array(StoredModelSchema),
    lastModified: z.number().optional(),
    checkedAt: z.number().optional(),
    etag: z.string().optional(),
  })
  .strict();

function decodeModelsStore(path: string, raw: string): JsonObject {
  let value;
  try {
    value = JsonValueSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`${path}: invalid Pi model catalog cache`, { cause: error });
  }
  if (!isJsonObject(value)) throw new Error(`${path}: expected a provider-indexed model catalog cache`);
  return value;
}

function parseEntry(path: string, providerId: string, value: unknown): ModelsStoreEntry {
  const parsed = ModelsStoreEntrySchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`${path}: invalid cached model catalog for provider ${providerId}`, {
      cause: parsed.error,
    });
  // SAFETY: The schema validates Pi's persisted model and catalog-entry fields;
  // passthrough preserves API-specific compatibility metadata byte-for-byte.
  return parsed.data as ModelsStoreEntry;
}

export function createNoesisPiModelsStore(
  path: string,
  supportsProvider: (providerId: string) => boolean,
): ModelsStore {
  let queue: Promise<void> = Promise.resolve();

  const transact = async <T>(operation: () => Promise<T>): Promise<T> => {
    const prior = queue;
    let release: (() => void) | undefined;
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
    }
  };

  const readAll = async (): Promise<JsonObject> => {
    try {
      return decodeModelsStore(path, await readFile(path, "utf8"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
      throw error;
    }
  };

  const persist = async (entries: JsonObject): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, path);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  };

  const assertSupported = (providerId: string): void => {
    if (!supportsProvider(providerId))
      throw new Error(`Noesis does not manage cached models for unsupported Pi provider ${providerId}`);
  };

  return Object.freeze({
    read: async (providerId) => {
      if (!supportsProvider(providerId)) return undefined;
      return await transact(async () => {
        const value = (await readAll())[providerId];
        return value === undefined ? undefined : parseEntry(path, providerId, value);
      });
    },
    write: async (providerId, entry) => {
      assertSupported(providerId);
      await transact(async () => {
        const entries = await readAll();
        const encoded = JsonValueSchema.parse(JSON.parse(JSON.stringify(entry)));
        await persist({ ...entries, [providerId]: encoded });
      });
    },
    delete: async (providerId) => {
      assertSupported(providerId);
      await transact(async () => {
        const entries = await readAll();
        if (!(providerId in entries)) return;
        const next = { ...entries };
        delete next[providerId];
        await persist(next);
      });
    },
  } satisfies ModelsStore);
}
