/**
 * The SKILL.md of a Capability folder. It is a standard skill: `name` is the folder's name and
 * `description` says what it does, while Noesis keeps the readable title and the "when" text under
 * `metadata`. The frontmatter and guidance are the editable content. Noesis writes the notes below
 * the marker from the Capability's recorded history.
 */
export const CAPABILITY_NOTES_MARKER =
  "<!-- Noesis writes everything below this line from the Capability's history. Edits below it are ignored. -->";

const FOLDER_FIELDS = ["name", "description", "metadata"] as const;
const LEGACY_FIELDS = ["name", "when", "description"] as const;

export interface CapabilityDocumentContent {
  /** The Capability's readable name. In the file it is `metadata.title`, because `name` is the folder. */
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
/** One YAML value. A plain value is easy to read; anything YAML could misread becomes a JSON string. */
function yamlValue(value: string): string {
  const line = singleLine(value);
  return /^[A-Za-z0-9][A-Za-z0-9 ,.()/'_-]*$/u.test(line) && !line.endsWith(" ")
    ? line
    : JSON.stringify(line);
}
function unquoted(value: string): string | undefined {
  if (!value.startsWith('"')) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The frontmatter that makes a Capability folder a valid standard skill. */
function folderFrontmatter(
  folderName: string,
  content: Pick<CapabilityDocumentContent, "name" | "when" | "description">,
): readonly string[] {
  return [
    "---",
    `name: ${folderName}`,
    `description: ${yamlValue(content.description)}`,
    "metadata:",
    `  title: ${yamlValue(content.name)}`,
    `  when: ${yamlValue(content.when)}`,
    "---",
  ];
}

export function renderCapabilityDocument(
  folderName: string,
  content: CapabilityDocumentContent,
  notes: CapabilityDocumentNotes,
): string {
  const lines = [
    ...folderFrontmatter(folderName, content),
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

/**
 * A single-file Capability's text in the folder format. Only the frontmatter changes, so the
 * guidance and the notes keep their exact bytes.
 */
export function capabilityDocumentInFolderFormat(folderName: string, text: string): string {
  const normalized = text.replaceAll("\r\n", "\n");
  const close = normalized.indexOf("\n---\n", 3);
  const parsed = parseCapabilityDocument(normalized);
  if (!parsed.ok || close < 0) return text;
  return `${folderFrontmatter(folderName, parsed.content).join("\n")}\n${normalized.slice(close + 5)}`;
}

function parseFrontmatter(
  block: string,
):
  | { readonly ok: true; readonly fields: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly error: string } {
  const fields = new Map<string, string>();
  let section: string | undefined;
  for (const line of block.split("\n")) {
    if (line.trim().length === 0) continue;
    const separator = line.indexOf(":");
    if (separator < 0)
      return { ok: false, error: `Frontmatter line "${line.trim()}" needs a colon after its field name` };
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (/^\s/u.test(line)) {
      if (!section)
        return { ok: false, error: `Frontmatter line "${line.trim()}" is indented with nothing above it` };
      fields.set(`${section}.${key}`, value);
      continue;
    }
    section = value.length === 0 ? key : undefined;
    fields.set(key, value);
  }
  return { ok: true, fields };
}

/** Reads the editable part of a Capability file, in either format. This checks syntax only. */
export function parseCapabilityDocument(text: string): CapabilityDocumentParseResult {
  const normalized = text.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n"))
    return { ok: false, error: "The file must start with a --- line that opens the frontmatter" };
  const close = normalized.indexOf("\n---\n", 3);
  if (close < 0) return { ok: false, error: "The frontmatter needs a closing --- line" };
  const frontmatter = parseFrontmatter(normalized.slice(4, close));
  if (!frontmatter.ok) return frontmatter;
  const { fields } = frontmatter;
  const folderFormat = fields.has("metadata");
  const allowed: readonly string[] = folderFormat ? FOLDER_FIELDS : LEGACY_FIELDS;
  for (const key of fields.keys()) {
    const top = key.split(".")[0] ?? key;
    if (!allowed.includes(top))
      return {
        ok: false,
        error: `Unknown frontmatter field "${key}". Use ${
          folderFormat ? "name, description, and metadata" : "name, when, and description"
        }`,
      };
  }
  const read = (key: string) => {
    const value = fields.get(key);
    return value === undefined ? undefined : unquoted(value);
  };
  const name = folderFormat ? (read("metadata.title") ?? read("name")) : read("name");
  const when = folderFormat ? read("metadata.when") : read("when");
  const description = read("description");
  if (!name) return { ok: false, error: "The frontmatter needs a name" };
  if (!when) return { ok: false, error: "The frontmatter needs a when line" };
  if (!description) return { ok: false, error: "The frontmatter needs a description" };
  const rest = normalized.slice(close + 5);
  // The notes start at the marker on a line of its own; guidance may quote the marker text.
  const lines = rest.split("\n");
  const markerLine = lines.findIndex((line) => line.trim() === CAPABILITY_NOTES_MARKER);
  const guidance = (markerLine < 0 ? rest : lines.slice(0, markerLine).join("\n")).trim();
  if (guidance.length === 0) return { ok: false, error: "The guidance below the frontmatter is empty" };
  return { ok: true, content: { name, when, description, guidance } };
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
