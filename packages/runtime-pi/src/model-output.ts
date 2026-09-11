import { sha256 } from "@noesis/domain";

export const MODEL_OUTPUT_BYTES = 32 * 1024;

/** Project once at ingestion; the complete result remains available through file_read. */
export async function presentModelOutput(
  text: string,
  save: ((text: string) => Promise<string>) | undefined,
): Promise<string> {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MODEL_OUTPUT_BYTES || !save) return text;
  const path = await save(text);
  return JSON.stringify({
    truncated: true,
    originalBytes: bytes,
    contentDigest: sha256(text),
    fullOutputPath: path,
    recovery:
      "Read fullOutputPath with file_read and bounded line ranges, or use shell to extract bounded byte ranges for long JSON lines. This preview is incomplete evidence.",
    head: text.slice(0, 3000),
    tail: text.slice(-1000),
  });
}
