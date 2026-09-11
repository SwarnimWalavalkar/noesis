import { sha256 } from "@noesis/domain";

export const MODEL_OUTPUT_BYTES = 32 * 1024;

/** Project completed results once; presentation failure must never invite effect retries. */
export async function presentModelOutput(
  text: string,
  save: ((text: string) => Promise<string>) | undefined,
): Promise<string> {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MODEL_OUTPUT_BYTES) return text;
  const preview = {
    executionCompleted: true,
    truncated: true,
    originalBytes: bytes,
    contentDigest: sha256(text),
    head: text.slice(0, 3000),
    tail: text.slice(-1000),
  };
  const unavailable = (reason: "not_configured" | "persistence_failed" | "invalid_recovery_path") =>
    JSON.stringify({
      ...preview,
      recoveryAvailable: false,
      recoveryFailure: reason,
      recovery:
        "The tool call completed. Do not repeat it to recover output. Exact output recovery is unavailable through this preview; omitted content is unknown, not absent.",
    });
  if (!save) return unavailable("not_configured");
  let path: string;
  try {
    path = await save(text);
  } catch {
    return unavailable("persistence_failed");
  }
  // Leave enough room for JSON escaping even when an embedder supplies an unusual path.
  if (!path || Buffer.byteLength(path, "utf8") > 1024) return unavailable("invalid_recovery_path");
  return JSON.stringify({
    ...preview,
    recoveryAvailable: true,
    fullOutputPath: path,
    recovery:
      "Read fullOutputPath with file_read and bounded line ranges, or use shell to extract bounded byte ranges for long JSON lines. This preview is incomplete evidence. Do not repeat the completed tool call to recover output.",
  });
}
