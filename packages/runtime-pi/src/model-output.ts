import { sha256 } from "@noesis/domain";

export const MODEL_OUTPUT_BYTES = 32 * 1024;

// Keep the existing UTF-16 budgets without cutting a surrogate pair or copying the full result.
function previewSlice(text: string, start: number, end: number): string {
  const splitsPair = (index: number) =>
    text.charCodeAt(index - 1) >= 0xd800 &&
    text.charCodeAt(index - 1) <= 0xdbff &&
    text.charCodeAt(index) >= 0xdc00 &&
    text.charCodeAt(index) <= 0xdfff;
  return text.slice(splitsPair(start) ? start + 1 : start, splitsPair(end) ? end - 1 : end);
}

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
    head: previewSlice(text, 0, 3000),
    tail: previewSlice(text, text.length - 1000, text.length),
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
      "For JSON, use execute: const file = await tools.files.read({ path: fullOutputPath }); const data = JSON.parse(file.content); return only selected fields or a bounded slice of data. Do not return or log the whole file. Direct file_read can truncate a single long JSON line again. For multiline text, use file_read with bounded line ranges, or extract a bounded section with shell. This preview is incomplete evidence. Do not repeat the completed tool call to recover output.",
  });
}
