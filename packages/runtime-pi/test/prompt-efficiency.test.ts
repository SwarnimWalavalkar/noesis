import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { applyPromptCacheKey, promptCacheKey } from "../src/prompt-cache.ts";
import { MODEL_OUTPUT_BYTES, presentModelOutput } from "../src/model-output.ts";

describe("prompt efficiency boundaries", () => {
  test("isolates cache groups by workspace and logical scope without changing transport identity", () => {
    const key = promptCacheKey("/workspace", "foreground:one");
    expect(key).toBe(promptCacheKey("/workspace", "foreground:one"));
    expect(key).not.toBe(promptCacheKey("/other", "foreground:one"));
    expect(key).not.toBe(promptCacheKey("/workspace", "foreground:two"));
    for (const field of ["prompt_cache_key", "promptCacheKey"]) {
      const payload = { [field]: "ephemeral", sessionId: "transport-id" };
      expect(applyPromptCacheKey(payload, key)).toEqual({ ...payload, [field]: key });
      expect(payload[field]).toBe("ephemeral");
    }
    for (const payload of [null, [], "text", {}, { prompt_cache_key: undefined }]) {
      expect(applyPromptCacheKey(payload, key)).toBe(payload);
    }
  });

  test.each([
    ["ASCII", "a".repeat(40_000), "a".repeat(3000), "a".repeat(1000)],
    ["BMP", "界".repeat(40_000), "界".repeat(3000), "界".repeat(1000)],
    ["aligned pairs", "🧪".repeat(20_000), "🧪".repeat(1500), "🧪".repeat(500)],
    [
      "split pairs",
      "a".repeat(2999) + "🧪" + "b".repeat(40_000) + "🧪" + "z".repeat(999),
      "a".repeat(2999),
      "z".repeat(999),
    ],
  ])("keeps %s previews bounded and Unicode-safe with or without recovery", async (_, text, head, tail) => {
    for (const save of [undefined, async () => "/output.json"]) {
      const result = await presentModelOutput(text, save);
      expect(JSON.parse(result)).toMatchObject({ head, tail });
      expect(Buffer.byteLength(result)).toBeLessThan(MODEL_OUTPUT_BYTES);
    }
  });

  test.each(["/output.json", '/odd "quote"/back\\slash\n🧪.json'])(
    "guides executable JSON recovery for %s",
    async (path) => {
      const result = JSON.parse(await presentModelOutput("x".repeat(40_000), async () => path));
      expect(result.recovery).toContain(`tools.files.read({ path: ${JSON.stringify(path)} })`);
      const snippet = result.recovery.split("\n\n")[1];
      const recovered = await runInNewContext(`(async () => { ${snippet} return data.marker; })()`, {
        tools: {
          files: {
            read: async (input: { path: string }) => {
              expect(input.path).toBe(path);
              return { content: JSON.stringify({ marker: "recovered" }) };
            },
          },
        },
      });
      expect(recovered).toBe("recovered");
      expect(result.recovery).toContain("JSON.parse(file.content)");
      expect(result.recovery).toContain("return only selected fields or a bounded slice");
      expect(result.recovery).toContain("Do not return or log the whole file");
      expect(result.recovery).toContain("Do not repeat the completed tool call");
    },
  );

  test("persists exact Unicode output before returning a bounded recoverable preview", async () => {
    const directory = await mkdtemp(join(tmpdir(), "noesis-output-"));
    try {
      const path = join(directory, "output.json");
      const original = JSON.stringify({ value: "🧪".repeat(25_000), logsTruncated: true });
      const preview = await presentModelOutput(original, async (text) => {
        await writeFile(path, text);
        return path;
      });
      expect(Buffer.byteLength(preview)).toBeLessThan(MODEL_OUTPUT_BYTES);
      expect(JSON.parse(preview)).toMatchObject({
        truncated: true,
        fullOutputPath: path,
        originalBytes: Buffer.byteLength(original),
      });
      expect(await readFile(path, "utf8")).toBe(original);
      expect(
        await presentModelOutput("x".repeat(MODEL_OUTPUT_BYTES), async () => {
          throw new Error("must not persist");
        }),
      ).toHaveLength(MODEL_OUTPUT_BYTES);
      const failed = await presentModelOutput(original, async () => {
        throw new Error("disk full");
      });
      const missing = await presentModelOutput(original, undefined);
      const invalid = await presentModelOutput(original, async () => "x".repeat(40_000));
      for (const result of [failed, missing, invalid]) {
        expect(Buffer.byteLength(result)).toBeLessThan(MODEL_OUTPUT_BYTES);
        expect(JSON.parse(result)).toMatchObject({ executionCompleted: true, recoveryAvailable: false });
        expect(JSON.parse(result)).not.toHaveProperty("fullOutputPath");
        expect(result).toContain("Do not repeat");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
