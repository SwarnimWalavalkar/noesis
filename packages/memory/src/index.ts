import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createId, toJsonValue } from "@noesis/domain";
import type { ExperienceLedger } from "@noesis/ledger";
import { z } from "zod";

export type MemoryKind = "claim" | "preference" | "goal" | "commitment" | "relationship" | "fact" | "model";

export interface MemoryEvidence {
  readonly eventId: string;
  readonly excerpt: string;
  readonly confidence: number;
}

const MemoryRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  memoryId: z.string(),
  kind: z.enum(["claim", "preference", "goal", "commitment", "relationship", "fact", "model"]),
  content: z.string(),
  scope: z.string(),
  evidence: z.array(
    z
      .object({
        eventId: z.string(),
        excerpt: z.string(),
        confidence: z.number().min(0).max(1),
      })
      .passthrough(),
  ),
  supersedes: z.string().optional(),
  validUntil: z.string().optional(),
});
export interface MemoryRecord {
  readonly schemaVersion: 1;
  readonly memoryId: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly scope: string;
  readonly evidence: readonly MemoryEvidence[];
  readonly supersedes?: string | undefined;
  readonly validUntil?: string | undefined;
}
export type MemoryRecordInput = Omit<MemoryRecord, "schemaVersion" | "memoryId">;

export interface MemoryRepository {
  readonly listActive: () => readonly MemoryRecord[];
  readonly record: (input: MemoryRecordInput) => Promise<MemoryRecord>;
  readonly writeMarkdownProjection: () => Promise<void>;
}

export function createMemoryRepository(ledger: ExperienceLedger): MemoryRepository {
  const listActive = (): readonly MemoryRecord[] => {
    const records = new Map<string, MemoryRecord>();
    const superseded = new Set<string>();
    for (const event of ledger.readAll()) {
      if (event.type === "memory.recorded") {
        const payload = event.payload;
        const record = MemoryRecordSchema.parse({
          schemaVersion: 1,
          memoryId: String(payload["memoryId"]),
          kind: payload["kind"],
          content: String(payload["content"]),
          scope: String(payload["scope"]),
          evidence: payload["evidence"] ?? [],
          ...(typeof payload["supersedes"] === "string" ? { supersedes: payload["supersedes"] } : {}),
          ...(typeof payload["validUntil"] === "string" ? { validUntil: payload["validUntil"] } : {}),
        });
        records.set(record.memoryId, record);
        if (record.supersedes) superseded.add(record.supersedes);
      }
    }
    return [...records.values()].filter((record) => !superseded.has(record.memoryId));
  };

  const record = async (input: MemoryRecordInput): Promise<MemoryRecord> => {
    const record: MemoryRecord = { ...input, schemaVersion: 1, memoryId: createId("mem") };
    if (input.supersedes && !listActive().some((candidate) => candidate.memoryId === input.supersedes)) {
      throw new Error(`Cannot supersede missing or inactive memory ${input.supersedes}`);
    }
    if (input.supersedes) {
      await ledger.append({
        type: "memory.superseded",
        principal: "foreground",
        payload: { memoryId: input.supersedes, replacementId: record.memoryId },
      });
    }
    await ledger.append({
      type: "memory.recorded",
      principal: "foreground",
      payload: {
        schemaVersion: record.schemaVersion,
        memoryId: record.memoryId,
        kind: record.kind,
        content: record.content,
        scope: record.scope,
        evidence: toJsonValue(record.evidence),
        ...(record.supersedes ? { supersedes: record.supersedes } : {}),
        ...(record.validUntil ? { validUntil: record.validUntil } : {}),
      },
    });
    await writeMarkdownProjection();
    return record;
  };

  const writeMarkdownProjection = async (): Promise<void> => {
    const body = listActive()
      .map((memory) =>
        [
          `## ${memory.kind}: ${memory.content}`,
          `- id: \`${memory.memoryId}\``,
          `- scope: \`${memory.scope}\``,
          `- evidence: ${memory.evidence.map((item) => `\`${item.eventId}\` (${item.confidence})`).join(", ")}`,
          memory.validUntil ? `- valid until: ${memory.validUntil}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n");
    await writeFile(join(ledger.paths.views, "memory.md"), `# Noesis memory\n\n${body}\n`, "utf8");
  };

  return Object.freeze({ listActive, record, writeMarkdownProjection });
}
