import { createConditionalObject } from "@noesis/domain";
import { createHash } from "node:crypto";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { JsonValue } from "@noesis/domain";
import { type AuthorityBoundary, type EffectDecision, inspectEffectExecutionFailure } from "@noesis/policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalWorkTools,
  createToolBroker,
  MAX_TOOL_TEXT_BYTES,
  type ToolDefinition,
  type ToolExecutionContext,
} from "../src/index.ts";
const permission = Object.freeze({
  effects: Object.freeze(["read", "write", "execute", "network"]),
  resourcePatterns: Object.freeze([
    "file-read:*",
    "file:*",
    "directory:*",
    "search:*",
    "shell:*",
    "url:*",
    "artifact:*",
  ]),
  credentialRefs: Object.freeze([]),
});
function authority(): Pick<AuthorityBoundary, "runForeground"> {
  return Object.freeze({
    runForeground: async <T extends JsonValue>(
      request: Parameters<AuthorityBoundary["runForeground"]>[0],
    ): Promise<EffectDecision<T>> => {
      try {
        // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
        return Object.freeze({
          ok: true,
          value: (await request.execute(
            Object.freeze({
              effect: request.effect,
              resource: request.resource,
              operationId: request.operationId,
            }),
          )) as T,
          replayed: false,
        });
      } catch (error) {
        const failure = inspectEffectExecutionFailure(error);
        // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
        return Object.freeze({
          ok: false,
          code: failure?.code ?? ("failed" as const),
          reason: failure?.message ?? (error instanceof Error ? error.message : String(error)),
        });
      }
    },
  });
}
function context(signal = new AbortController().signal): ToolExecutionContext {
  return Object.freeze({
    executionId: "execution-builtins",
    logicalExecutionId: "logical-builtins",
    callId: "call-builtins",
    sessionId: "session-builtins",
    signal,
  });
}
function tool(definitions: readonly ToolDefinition[], name: string): ToolDefinition {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Missing ${name}`);
  return definition;
}
function toolsAt(cwd: string, searchCommand?: string): readonly ToolDefinition[] {
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  return createLocalWorkTools(
    createConditionalObject({
      cwd,
    } as const)
      .addOptional(searchCommand ? { searchCommand } : undefined)
      .add({
        writeArtifact: async ({ path, content }: { readonly path: string; readonly content: string }) => ({
          path,
          bytes: Buffer.byteLength(content, "utf8"),
          contentDigest: createHash("sha256").update(content).digest("hex"),
        }),
        importArtifact: async ({
          path,
          sourcePath,
        }: {
          readonly path: string;
          readonly sourcePath: string;
        }) => {
          const destination = join(cwd, ".noesis", "artifacts", path);
          await mkdir(resolve(destination, ".."), { recursive: true });
          await copyFile(sourcePath, destination);
          return { path: destination };
        },
      } as const)
      .finish(),
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("local work tools", () => {
  it("streams a bounded file read while hashing the complete file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-read-"));
    const content = `${"abcdefghij\n".repeat(Math.ceil(MAX_TOOL_TEXT_BYTES / 10) + 100)}tail`;
    const path = join(cwd, "large.txt");
    await writeFile(path, content, "utf8");
    const result = await tool(toolsAt(cwd), "files.read").execute(
      { path: "large.txt", startLine: 1 },
      context(),
    );
    expect(result).toMatchObject({
      path,
      truncated: true,
      contentDigest: createHash("sha256").update(content).digest("hex"),
    });
    if (
      typeof result !== "object" ||
      result === null ||
      !("content" in result) ||
      typeof result["content"] !== "string"
    )
      throw new Error("files.read returned an unexpected value");
    expect(Buffer.byteLength(result["content"], "utf8")).toBeLessThanOrEqual(MAX_TOOL_TEXT_BYTES);
  });
  it("uses a read-only resource namespace distinct from file writes", () => {
    const read = tool(toolsAt("/workspace"), "files.read");
    const write = tool(toolsAt("/workspace"), "files.write");
    expect(read.effect({ path: "/outside/notes.md" }, context())).toMatchObject({
      effect: "read",
      resource: "file-read:/outside/notes.md",
    });
    expect(write.effect({ path: "/outside/notes.md", content: "changed" }, context())).toMatchObject({
      effect: "write",
      resource: "file:/outside/notes.md",
    });
  });
  it("does not invent a trailing line for newline-terminated or empty files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-lines-"));
    await writeFile(join(cwd, "terminated.txt"), "alpha\nbeta\n", "utf8");
    await writeFile(join(cwd, "empty.txt"), "", "utf8");
    const read = tool(toolsAt(cwd), "files.read");
    await expect(read.execute({ path: "terminated.txt" }, context())).resolves.toMatchObject({
      content: "alpha\nbeta",
      endLine: 2,
      totalLines: 2,
      truncated: false,
    });
    await expect(read.execute({ path: "empty.txt" }, context())).resolves.toMatchObject({
      content: "",
      endLine: 0,
      totalLines: 0,
      truncated: false,
    });
  });
  it("does not spawn a pre-aborted shell command", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-abort-"));
    const marker = join(cwd, "should-not-exist");
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool(toolsAt(cwd), "shell.run").execute(
        { command: `touch ${JSON.stringify(marker)}`, timeoutMs: 1000 },
        context(controller.signal),
      ),
    ).rejects.toSatisfy((cause: unknown) => inspectEffectExecutionFailure(cause)?.code === "cancelled");
    await expect(access(marker)).rejects.toThrow();
  });
  it("terminates shell descendants when a command is cancelled", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-tree-"));
    const marker = join(cwd, "descendant-survived");
    const childScript = [
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 700)`,
      "setTimeout(() => {}, 5_000)",
    ].join(";");
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childScript)} & wait`;
    const controller = new AbortController();
    const execution = tool(toolsAt(cwd), "shell.run").execute(
      { command, timeoutMs: 5000 },
      context(controller.signal),
    );
    setTimeout(() => controller.abort(), 100);
    await expect(execution).rejects.toSatisfy(
      (cause: unknown) => inspectEffectExecutionFailure(cause)?.code === "cancelled",
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 850));
    await expect(access(marker)).rejects.toThrow();
  });
  it("kills a descendant group on timeout after the direct shell has exited", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-timeout-tree-"));
    const marker = join(cwd, "timed-out-descendant-survived");
    const childScript = [
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 700)`,
      "setTimeout(() => {}, 5_000)",
    ].join(";");
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childScript)} & exit 0`;
    const startedAt = Date.now();
    await expect(
      tool(toolsAt(cwd), "shell.run").execute({ command, timeoutMs: 150 }, context()),
    ).rejects.toThrow("Process timed out after 150ms");
    expect(Date.now() - startedAt).toBeLessThan(2000);
    await new Promise((resolveWait) => setTimeout(resolveWait, 850));
    await expect(access(marker)).rejects.toThrow();
  });
  it("decodes split UTF-8 sequences from stdout and stderr without replacement characters", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-utf8-"));
    const script = [
      "process.stdout.write(Buffer.from([0xe2]))",
      "process.stderr.write(Buffer.from([0xf0, 0x9f]))",
      "setTimeout(() => {",
      "process.stdout.write(Buffer.from([0x82, 0xac]))",
      "process.stderr.write(Buffer.from([0x98, 0x80]))",
      "}, 50)",
    ].join(";");
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    await expect(
      tool(toolsAt(cwd), "shell.run").execute({ command, timeoutMs: 2000 }, context()),
    ).resolves.toMatchObject({
      exitCode: 0,
      output: "€😀",
      fullOutputLength: 3,
      truncated: false,
    });
  });
  it("bounds decoded UTF-8 output when invalid or incomplete bytes expand during decoding", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-utf8-bounds-"));
    const shell = tool(toolsAt(cwd), "shell.run");
    const invalidCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.stdout.write(Buffer.alloc(${MAX_TOOL_TEXT_BYTES}, 0xff))`)}`;
    const boundaryCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.stdout.write(Buffer.concat([Buffer.alloc(${MAX_TOOL_TEXT_BYTES - 1}, 0x61), Buffer.from([0xe2])]))`)}`;
    const invalid = await shell.execute({ command: invalidCommand, timeoutMs: 2000 }, context());
    const boundary = await shell.execute({ command: boundaryCommand, timeoutMs: 2000 }, context());
    for (const result of [invalid, boundary]) {
      if (
        typeof result !== "object" ||
        result === null ||
        !("output" in result) ||
        typeof result["output"] !== "string"
      )
        throw new Error("shell.run returned an unexpected value");
      expect(Buffer.byteLength(result["output"], "utf8")).toBeLessThanOrEqual(MAX_TOOL_TEXT_BYTES);
      expect(result).toMatchObject({ truncated: true, fullOutputPath: expect.any(String) });
    }
    if (
      typeof boundary !== "object" ||
      boundary === null ||
      !("output" in boundary) ||
      typeof boundary["output"] !== "string" ||
      !("fullOutputPath" in boundary) ||
      typeof boundary["fullOutputPath"] !== "string"
    )
      throw new Error("shell.run returned an unexpected boundary value");
    expect(boundary["output"]).toMatch(/\ufffd$/u);
    const savedBoundary = await readFile(boundary["fullOutputPath"]);
    expect(savedBoundary).toHaveLength(MAX_TOOL_TEXT_BYTES);
    expect(savedBoundary.at(-1)).toBe(0xe2);
  });
  it("saves complete oversized shell output for ordinary filesystem inspection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-shell-output-"));
    const fullOutputLength = MAX_TOOL_TEXT_BYTES + 100;
    const script = `process.stdout.write("x".repeat(${String(fullOutputLength - 4)})); setTimeout(() => process.stderr.write("tail"), 50)`;
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    const result = await tool(toolsAt(cwd), "shell.run").execute({ command, timeoutMs: 2000 }, context());
    expect(result).toMatchObject({
      exitCode: 0,
      output: expect.stringMatching(/tail$/u),
      fullOutputLength,
      truncated: true,
      fullOutputPath: expect.any(String),
    });
    if (
      typeof result !== "object" ||
      result === null ||
      !("fullOutputPath" in result) ||
      typeof result["fullOutputPath"] !== "string"
    )
      throw new Error("shell.run did not return a full output path");
    const saved = await readFile(result["fullOutputPath"], "utf8");
    expect(saved).toHaveLength(fullOutputLength);
    expect(saved.endsWith("tail")).toBe(true);
  });
  it("uses literal search semantics in the primary ripgrep execution path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-primary-search-"));
    const searchCommand = join(cwd, "literal-rg.mjs");
    await writeFile(
      searchCommand,
      [
        `#!${process.execPath}`,
        'if (!process.argv.includes("--fixed-strings")) {',
        '  process.stderr.write("missing --fixed-strings");',
        "  process.exit(2);",
        "}",
        'process.stdout.write("src/example.txt:2:[a-z]+ literal\\n");',
      ].join("\n"),
      "utf8",
    );
    await chmod(searchCommand, 0o755);
    await expect(
      tool(toolsAt(cwd, searchCommand), "files.search").execute(
        { query: "[a-z]+", path: "src", maxMatches: 10 },
        context(),
      ),
    ).resolves.toEqual({
      matches: [{ path: join(cwd, "src", "example.txt"), line: 2, text: "[a-z]+ literal" }],
      truncated: false,
    });
  });
  it("falls back to an in-process search when ripgrep is unavailable", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-search-"));
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "first.ts"), "const needle = true;\n", "utf8");
    await writeFile(join(cwd, "src", "second.txt"), "needle\n", "utf8");
    const result = await tool(toolsAt(cwd, "noesis-rg-does-not-exist"), "files.search").execute(
      { query: "needle", path: "src", glob: "**/*.ts", maxMatches: 10 },
      context(),
    );
    expect(result).toEqual({
      matches: [{ path: join(cwd, "src", "first.ts"), line: 1, text: "const needle = true;" }],
      truncated: false,
    });
  });
  it("keeps fallback search literal and bounded while skipping hidden, dependency, and binary data", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-search-bounds-"));
    await mkdir(join(cwd, "src"));
    await mkdir(join(cwd, "node_modules"));
    await mkdir(join(cwd, ".hidden"));
    await writeFile(join(cwd, "node_modules", "ignored.txt"), "[a-z]+\n", "utf8");
    await writeFile(join(cwd, ".hidden", "ignored.txt"), "[a-z]+\n", "utf8");
    await writeFile(join(cwd, "src", "binary.dat"), Buffer.from([0, 91, 97, 45, 122, 93, 43]));
    await writeFile(join(cwd, "src", "a-regex-looking.txt"), "letters only\n[a-z]+ literal\n", "utf8");
    const hugeLines = Array.from(
      { length: 100 },
      (_, index) => `[a-z]+ match ${String(index)} ${"x".repeat(5000)}`,
    ).join("\n");
    await writeFile(join(cwd, "src", "huge.txt"), hugeLines, "utf8");
    const result = await tool(toolsAt(cwd, "noesis-rg-does-not-exist"), "files.search").execute(
      { query: "[a-z]+", path: ".", maxMatches: 1000 },
      context(),
    );
    expect(result).toMatchObject({ truncated: true });
    if (
      typeof result !== "object" ||
      result === null ||
      !("matches" in result) ||
      !Array.isArray(result["matches"])
    )
      throw new Error("files.search returned an unexpected value");
    expect(result["matches"]).not.toContainEqual(expect.objectContaining({ text: "letters only" }));
    expect(result["matches"]).toContainEqual(expect.objectContaining({ text: "[a-z]+ literal" }));
    expect(JSON.stringify(result)).not.toContain("ignored.txt");
    expect(JSON.stringify(result)).not.toContain("binary.dat");
    expect(
      result["matches"].every(
        (match) =>
          typeof match === "object" &&
          match !== null &&
          "text" in match &&
          typeof match["text"] === "string" &&
          Buffer.byteLength(match["text"], "utf8") <= 4 * 1024,
      ),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(96 * 1024);
  });
  it("continues fallback search after truncating one oversized file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-search-oversized-file-"));
    await writeFile(join(cwd, "a-oversized.log"), "x".repeat(3 * 1024 * 1024), "utf8");
    await writeFile(join(cwd, "z-match.ts"), "const laterNeedle = true;\n", "utf8");
    const result = await tool(toolsAt(cwd, "noesis-rg-does-not-exist"), "files.search").execute(
      { query: "laterNeedle", path: ".", maxMatches: 10 },
      context(),
    );
    expect(result).toEqual({
      matches: [{ path: join(cwd, "z-match.ts"), line: 1, text: "const laterNeedle = true;" }],
      truncated: true,
    });
  });
  it("retains a partial-line match found at the fallback per-file byte cap", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-search-partial-line-"));
    const query = "boundaryNeedle";
    const perFileLimit = 2 * 1024 * 1024;
    await writeFile(
      join(cwd, "oversized.log"),
      `${"x".repeat(perFileLimit - query.length)}${query}ignored`,
      "utf8",
    );
    const result = await tool(toolsAt(cwd, "noesis-rg-does-not-exist"), "files.search").execute(
      { query, path: ".", maxMatches: 10 },
      context(),
    );
    expect(result).toEqual({
      matches: [
        {
          path: join(cwd, "oversized.log"),
          line: 1,
          text: `${"x".repeat(4 * 1024 - 3)}...`,
        },
      ],
      truncated: true,
    });
  });
  it("does not invent a replacement-character match when the byte cap splits UTF-8", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-search-split-utf8-"));
    const perFileLimit = 2 * 1024 * 1024;
    await writeFile(
      join(cwd, "oversized.log"),
      Buffer.concat([Buffer.alloc(perFileLimit - 1, "x"), Buffer.from("€ignored", "utf8")]),
    );
    const result = await tool(toolsAt(cwd, "noesis-rg-does-not-exist"), "files.search").execute(
      { query: "\ufffd", path: ".", maxMatches: 10 },
      context(),
    );
    expect(result).toEqual({ matches: [], truncated: true });
  });
  it("does not follow redirects and bounds streamed response bodies", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("redirect", {
          status: 302,
          headers: { location: "https://unauthorized.example/private" },
        }),
      )
      .mockResolvedValueOnce(new Response("x".repeat(MAX_TOOL_TEXT_BYTES + 100)));
    vi.stubGlobal("fetch", fetchMock);
    const fetchTool = tool(toolsAt(process.cwd()), "web.fetch");
    const redirect = await fetchTool.execute({ url: "https://allowed.example/start" }, context());
    const large = await fetchTool.execute({ url: "https://allowed.example/large" }, context());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    expect(redirect).toMatchObject({ status: 302, body: "redirect", truncated: false });
    expect(large).toMatchObject({ truncated: true });
    if (
      typeof large !== "object" ||
      large === null ||
      !("body" in large) ||
      typeof large["body"] !== "string"
    )
      throw new Error("web.fetch returned an unexpected value");
    expect(Buffer.byteLength(large["body"], "utf8")).toBe(MAX_TOOL_TEXT_BYTES);
  });
  it("binds the catalog identity to the resolved working directory", () => {
    const firstCwd = resolve(process.cwd());
    const secondCwd = resolve(process.cwd(), "packages");
    const first = createToolBroker({
      definitions: toolsAt(firstCwd),
      authority: authority(),
      permission,
    });
    const equivalent = createToolBroker({
      definitions: toolsAt(join(firstCwd, ".")),
      authority: authority(),
      permission,
    });
    const second = createToolBroker({
      definitions: toolsAt(secondCwd),
      authority: authority(),
      permission,
    });
    expect(equivalent.catalogDigest).toBe(first.catalogDigest);
    expect(second.catalogDigest).not.toBe(first.catalogDigest);
  });
});
