/**
 * One readable Markdown file per Capability. The frontmatter and guidance are the editable
 * content. Noesis writes the notes below the marker from the Capability's recorded history.
 */
export const CAPABILITY_NOTES_MARKER =
  "<!-- Noesis writes everything below this line from the Capability's history. Edits below it are ignored. -->";

const FIELDS = ["name", "when", "description"] as const;
type DocumentField = (typeof FIELDS)[number];

export interface CapabilityDocumentContent {
  readonly name: string;
  readonly when: string;
  readonly description: string;
  readonly guidance: string;
}

export interface CapabilityDocumentNotes {
  readonly evidence?: {
    readonly label: string;
    readonly quote: string;
    readonly wouldOtherwise: string;
  };
  readonly rationale: string;
  /** Newest first, starting with this revision. */
  readonly history: readonly { readonly date: string; readonly summary: string }[];
}

export type CapabilityDocumentParseResult =
  | { readonly ok: true; readonly content: CapabilityDocumentContent }
  | { readonly ok: false; readonly error: string };

const singleLine = (value: string): string => value.replaceAll(/\s+/gu, " ").trim();

export function renderCapabilityDocument(
  content: CapabilityDocumentContent,
  notes: CapabilityDocumentNotes,
): string {
  const lines = [
    "---",
    `name: ${singleLine(content.name)}`,
    `when: ${singleLine(content.when)}`,
    `description: ${singleLine(content.description)}`,
    "---",
    "",
    content.guidance.trim(),
    "",
    CAPABILITY_NOTES_MARKER,
    "",
    "## Why",
    "",
  ];
  if (notes.evidence)
    lines.push(
      `- Evidence: ${singleLine(notes.evidence.label)}`,
      `- In their words: "${singleLine(notes.evidence.quote)}"`,
      `- Without it: ${singleLine(notes.evidence.wouldOtherwise)}`,
    );
  lines.push(`- Reason: ${singleLine(notes.rationale)}`, "", "## History", "");
  for (const entry of notes.history) lines.push(`- ${entry.date}: ${singleLine(entry.summary)}`);
  return `${lines.join("\n")}\n`;
}

/** Reads the editable part of a Capability file. This checks syntax only. */
export function parseCapabilityDocument(text: string): CapabilityDocumentParseResult {
  const normalized = text.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n"))
    return { ok: false, error: "The file must start with a --- line that opens the frontmatter" };
  const close = normalized.indexOf("\n---\n", 3);
  if (close < 0) return { ok: false, error: "The frontmatter needs a closing --- line" };
  const fields = new Map<DocumentField, string>();
  for (const line of normalized.slice(4, close).split("\n")) {
    if (line.trim().length === 0) continue;
    const separator = line.indexOf(":");
    const key = separator < 0 ? line.trim() : line.slice(0, separator).trim();
    const field = FIELDS.find((candidate) => candidate === key);
    if (!field)
      return { ok: false, error: `Unknown frontmatter field "${key}". Use name, when, and description` };
    fields.set(field, line.slice(separator + 1).trim());
  }
  const name = fields.get("name");
  const when = fields.get("when");
  if (!name) return { ok: false, error: "The frontmatter needs a name" };
  if (!when) return { ok: false, error: "The frontmatter needs a when line" };
  const rest = normalized.slice(close + 5);
  const marker = rest.indexOf(CAPABILITY_NOTES_MARKER);
  const guidance = (marker < 0 ? rest : rest.slice(0, marker)).trim();
  if (guidance.length === 0) return { ok: false, error: "The guidance below the frontmatter is empty" };
  return { ok: true, content: { name, when, description: fields.get("description") || when, guidance } };
}

/**
 * The guidance the model receives. Older Capability materials are plain guidance with no
 * frontmatter, so anything that is not a Capability file is returned unchanged.
 */
export function capabilityGuidance(text: string): string {
  const parsed = parseCapabilityDocument(text);
  return parsed.ok ? parsed.content.guidance : text;
}

/** A plain sentence for each kind of evidence a Capability can rest on. */
export function capabilityEvidenceLabel(
  kind: "explicit_request" | "user_correction" | "repeated_across_sessions" | "verified_method",
): string {
  if (kind === "explicit_request") return "The user asked for this";
  if (kind === "user_correction") return "The user corrected Noesis";
  if (kind === "repeated_across_sessions") return "The same need came up in several sessions";
  return "A method that worked and was accepted";
}
