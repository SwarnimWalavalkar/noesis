import { sha256 } from "@noesis/domain";
import { z } from "zod";

export type ContextKind = "system" | "trail" | "memory" | "knowledge" | "capability" | "user";

export interface ContextFragment {
  readonly id: string;
  readonly kind: ContextKind;
  readonly content: string;
  readonly provenance: readonly string[];
  readonly priority: number;
  readonly staleAt?: string;
  readonly sensitive?: boolean;
}

export interface CompiledFragment extends ContextFragment {
  readonly tokens: number;
  readonly truncated: boolean;
}

const ContextKindSchema = z.enum(["system", "trail", "memory", "knowledge", "capability", "user"]);

const CompiledFragmentSchema = z.strictObject({
  id: z.string(),
  kind: ContextKindSchema,
  content: z.string(),
  provenance: z.array(z.string()),
  priority: z.number(),
  staleAt: z.string().optional(),
  sensitive: z.boolean().optional(),
  tokens: z.number().int().min(0),
  truncated: z.boolean(),
});

export const ContextSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  snapshotId: z.string(),
  createdAt: z.string(),
  maxTokens: z.number().int().min(0),
  usedTokens: z.number().int().min(0),
  fragments: z.array(CompiledFragmentSchema),
  capabilityVersions: z.record(z.string(), z.number().int().min(1)),
});
export type ContextSnapshot = Readonly<z.infer<typeof ContextSnapshotSchema>>;

export const decodeContextSnapshot = (value: unknown): ContextSnapshot | undefined => {
  const parsed = ContextSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export interface ContextCompilerOptions {
  readonly maxTokens: number;
  readonly maxFragmentTokens: number;
  readonly now?: Date;
  readonly redact?: (fragment: ContextFragment) => string;
}

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

export function compileContext(
  fragments: readonly ContextFragment[],
  capabilityVersions: Readonly<Record<string, number>>,
  options: ContextCompilerOptions,
): ContextSnapshot {
  const now = options.now ?? new Date();
  let remaining = options.maxTokens;
  const compiled: CompiledFragment[] = [];
  const ordered = [...fragments].sort(
    (left, right) => right.priority - left.priority || left.id.localeCompare(right.id),
  );
  for (const fragment of ordered) {
    if (remaining <= 0 || (fragment.staleAt && new Date(fragment.staleAt) <= now)) continue;
    const redacted = fragment.sensitive ? (options.redact?.(fragment) ?? "[redacted]") : fragment.content;
    const allowed = Math.min(remaining, options.maxFragmentTokens);
    const initialTokens = estimateTokens(redacted);
    const content =
      initialTokens <= allowed ? redacted : redacted.slice(0, Math.max(0, allowed * 4 - 1)) + "…";
    const tokens = Math.min(estimateTokens(content), allowed);
    compiled.push({ ...fragment, content, tokens, truncated: initialTokens > allowed });
    remaining -= tokens;
  }
  const usedTokens = options.maxTokens - remaining;
  const identity = JSON.stringify({ fragments: compiled, capabilityVersions, maxTokens: options.maxTokens });
  return {
    schemaVersion: 1,
    snapshotId: `ctx_${sha256(identity).slice(0, 24)}`,
    createdAt: now.toISOString(),
    maxTokens: options.maxTokens,
    usedTokens,
    fragments: compiled.map((fragment) => ({ ...fragment, provenance: [...fragment.provenance] })),
    capabilityVersions: { ...capabilityVersions },
  };
}

export function renderContext(snapshot: ContextSnapshot): string {
  return snapshot.fragments
    .map(
      (fragment) =>
        `<${fragment.kind} source="${fragment.provenance.join(",")}">\n${fragment.content}\n</${fragment.kind}>`,
    )
    .join("\n\n");
}
