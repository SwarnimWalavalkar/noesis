import { createConditionalObject } from "@noesis/domain";
import { createHash } from "node:crypto";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { JsonValue } from "@noesis/domain";
import { type AuthorityBoundary, type EffectDecision, inspectEffectExecutionFailure } from "@noesis/policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFileMutationCoordinator,
  createLocalWorkTools,
  createToolBroker,
  MAX_TOOL_TEXT_BYTES,
  type ToolDefinition,
  type ToolExecutionContext,
  type FileMutationCoordinator,
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
function toolsAt(
  cwd: string,
  searchCommand?: string,
  fileMutationCoordinator?: FileMutationCoordinator,
  maxShellOutputArtifactBytes?: number,
): readonly ToolDefinition[] {
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  return createLocalWorkTools(
    createConditionalObject({
      cwd,
    } as const)
      .addOptional(searchCommand ? { searchCommand } : undefined)
      .addOptional(fileMutationCoordinator ? { fileMutationCoordinator } : undefined)
      .addOptional(maxShellOutputArtifactBytes === undefined ? undefined : { maxShellOutputArtifactBytes })
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
  it("keeps unrestricted reads distinct from project-confined writes", () => {
    const cwd = tmpdir();
    const read = tool(toolsAt(cwd), "files.read");
    const write = tool(toolsAt(cwd), "files.write");
    expect(read.effect({ path: "/outside/notes.md" }, context())).toMatchObject({
      effect: "read",
      resource: "file-read:/outside/notes.md",
    });
    expect(() => write.effect({ path: "/outside/notes.md", content: "changed" }, context())).toThrow(
      "Path is outside the active project",
    );
  });
  it("creates parent directories by default and completely replaces existing files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-write-"));
    const write = tool(toolsAt(cwd), "files.write");
    const path = join(cwd, "notes", "result.txt");

    await expect(
      write.execute({ path: "notes/result.txt", content: "first" }, context()),
    ).resolves.toMatchObject({
      mode: "write",
      path,
      bytes: 5,
      contentDigest: createHash("sha256").update("first").digest("hex"),
    });
    await write.execute({ path: "notes/result.txt", content: "second" }, context());

    await expect(readFile(path, "utf8")).resolves.toBe("second");
  });
  it("applies several exact file replacements against one original and commits them together", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-replace-"));
    const path = join(cwd, "state.ts");
    await writeFile(path, "const alpha = 1;\nconst beta = 2;\n", "utf8");
    const write = tool(toolsAt(cwd), "files.write");

    await expect(
      write.execute(
        {
          mode: "replace",
          path: "state.ts",
          edits: [
            { oldText: "alpha = 1", newText: "alpha = 10" },
            { oldText: "beta = 2", newText: "beta = 20" },
          ],
        },
        context(),
      ),
    ).resolves.toMatchObject({
      mode: "replace",
      path,
      replacements: 2,
    });
    await expect(readFile(path, "utf8")).resolves.toBe("const alpha = 10;\nconst beta = 20;\n");
  });
  it("rejects ambiguous or overlapping file replacements without mutating the file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-replace-reject-"));
    const path = join(cwd, "state.txt");
    const original = "alpha alpha beta";
    await writeFile(path, original, "utf8");
    const write = tool(toolsAt(cwd), "files.write");

    await expect(
      write.execute(
        { mode: "replace", path: "state.txt", edits: [{ oldText: "alpha", newText: "gamma" }] },
        context(),
      ),
    ).rejects.toThrow("expected 1 occurrences but found 2");
    await expect(readFile(path, "utf8")).resolves.toBe(original);

    await expect(
      write.execute(
        {
          mode: "replace",
          path: "state.txt",
          edits: [
            { oldText: "alpha alpha", newText: "gamma" },
            { oldText: "alpha beta", newText: "delta" },
          ],
        },
        context(),
      ),
    ).rejects.toThrow("overlaps replacement");
    await expect(readFile(path, "utf8")).resolves.toBe(original);
  });
  it("exposes replacement as a mode of files.write rather than a second catalog tool", () => {
    const definitions = toolsAt(tmpdir());
    const write = tool(definitions, "files.write");

    expect(definitions.some((definition) => definition.name === "files.replace")).toBe(false);
    expect(
      write.inputSchema.safeParse({
        mode: "replace",
        path: "state.txt",
        content: "mixed shape",
        edits: [{ oldText: "old", newText: "new" }],
      }).success,
    ).toBe(false);
  });
  it("serializes mutations from independently prepared tool sets", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-shared-mutations-"));
    const path = join(cwd, "shared.txt");
    await writeFile(path, "alpha", "utf8");
    const coordinator = createFileMutationCoordinator();
    const first = toolsAt(cwd, undefined, coordinator);
    const second = toolsAt(cwd, undefined, coordinator);

    await Promise.all([
      tool(first, "files.write").execute({ path: "shared.txt", content: "beta" }, context()),
      tool(second, "files.write").execute(
        { mode: "replace", path: "shared.txt", edits: [{ oldText: "beta", newText: "gamma" }] },
        context(),
      ),
    ]);

    await expect(readFile(path, "utf8")).resolves.toBe("gamma");
  });
  it("rejects project paths that escape through symbolic links", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-symlink-project-"));
    const outside = await mkdtemp(join(tmpdir(), "noesis-tools-symlink-outside-"));
    const outsideFile = join(outside, "protected.txt");
    await writeFile(outsideFile, "protected", "utf8");
    await symlink(outside, join(cwd, "escape"), "dir");
    const definitions = toolsAt(cwd);

    expect(() =>
      tool(definitions, "files.write").effect(
        { path: "escape/protected.txt", content: "changed" },
        context(),
      ),
    ).toThrow("escapes the active project");
    await expect(
      tool(definitions, "files.write").execute(
        { path: "escape/protected.txt", content: "changed" },
        context(),
      ),
    ).rejects.toThrow("escapes the active project");
    await expect(
      tool(definitions, "files.write").execute(
        {
          mode: "replace",
          path: "escape/protected.txt",
          edits: [{ oldText: "protected", newText: "changed" }],
        },
        context(),
      ),
    ).rejects.toThrow("escapes the active project");
    await expect(tool(definitions, "files.list").execute({ path: "escape" }, context())).rejects.toThrow(
      "escapes the active project",
    );
    await expect(
      tool(definitions, "files.search").execute({ path: "escape", query: "protected" }, context()),
    ).rejects.toThrow("escapes the active project");
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("protected");
  });
  it("does not create a path for a pre-aborted file write", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-write-abort-"));
    const controller = new AbortController();
    controller.abort();

    await expect(
      tool(toolsAt(cwd), "files.write").execute(
        { path: "notes/result.txt", content: "never written" },
        context(controller.signal),
      ),
    ).rejects.toSatisfy((cause: unknown) => inspectEffectExecutionFailure(cause)?.code === "cancelled");
    await expect(access(join(cwd, "notes"))).rejects.toThrow();
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
      fullOutputComplete: true,
    });
  });
  it("saves valid decoded text when split pipe sequences interleave", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-utf8-artifact-"));
    const script = [
      `process.stdout.write("x".repeat(${String(MAX_TOOL_TEXT_BYTES)}))`,
      "process.stdout.write(Buffer.from([0xe2]))",
      "process.stderr.write(Buffer.from([0xf0, 0x9f]))",
      "setTimeout(() => {",
      "process.stdout.write(Buffer.from([0x82, 0xac]))",
      "process.stderr.write(Buffer.from([0x98, 0x80]))",
      "}, 50)",
    ].join(";");
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    const result = await tool(toolsAt(cwd), "shell.run").execute({ command, timeoutMs: 2000 }, context());
    expect(result).toMatchObject({
      output: expect.any(String),
      fullOutputLength: MAX_TOOL_TEXT_BYTES + 3,
      truncated: true,
      fullOutputComplete: true,
      fullOutputPath: expect.any(String),
    });
    if (
      typeof result !== "object" ||
      result === null ||
      !("output" in result) ||
      typeof result["output"] !== "string" ||
      !("fullOutputPath" in result) ||
      typeof result["fullOutputPath"] !== "string"
    )
      throw new Error("shell.run did not return a decoded output artifact");
    expect(result["output"]).toContain("€");
    expect(result["output"]).toContain("😀");
    const savedBytes = await readFile(result["fullOutputPath"]);
    const saved = new TextDecoder("utf8", { fatal: true }).decode(savedBytes);
    expect(saved).toHaveLength(MAX_TOOL_TEXT_BYTES + 3);
    expect(saved).toContain("€");
    expect(saved).toContain("😀");
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
    expect(() => new TextDecoder("utf8", { fatal: true }).decode(savedBoundary)).not.toThrow();
    expect(savedBoundary.toString("utf8")).toMatch(/\ufffd$/u);
  });
  it("saves complete oversized shell output for ordinary filesystem inspection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-shell-output-"));
    const fullOutputLength = MAX_TOOL_TEXT_BYTES + 100;
    const script = `process.stdout.write("x".repeat(${String(fullOutputLength - 4)})); setTimeout(() => process.stdout.write("tail"), 50)`;
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    const result = await tool(toolsAt(cwd), "shell.run").execute({ command, timeoutMs: 2000 }, context());
    expect(result).toMatchObject({
      exitCode: 0,
      output: expect.stringMatching(/tail$/u),
      fullOutputLength,
      truncated: true,
      fullOutputPath: expect.any(String),
      fullOutputComplete: true,
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
  it("keeps running after the shell artifact storage boundary and reports an incomplete artifact", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-shell-capped-output-"));
    const fullOutputLength = MAX_TOOL_TEXT_BYTES + 100;
    const artifactBytes = Math.floor(MAX_TOOL_TEXT_BYTES / 2);
    const script = `process.stdout.write("x".repeat(${String(fullOutputLength - 4)})); setTimeout(() => process.stdout.write("tail"), 50)`;
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    const result = await tool(toolsAt(cwd, undefined, undefined, artifactBytes), "shell.run").execute(
      { command, timeoutMs: 2000 },
      context(),
    );
    expect(result).toMatchObject({
      exitCode: 0,
      output: expect.stringMatching(/tail$/u),
      fullOutputLength,
      truncated: true,
      fullOutputPath: expect.any(String),
      fullOutputComplete: false,
    });
    if (
      typeof result !== "object" ||
      result === null ||
      !("fullOutputPath" in result) ||
      typeof result["fullOutputPath"] !== "string"
    )
      throw new Error("shell.run did not return a retained output path");
    const saved = await readFile(result["fullOutputPath"]);
    expect(saved.byteLength).toBe(artifactBytes);
  });
  it("reports an incomplete retained artifact even when the in-memory preview is complete", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-shell-capped-small-output-"));
    const fullOutputLength = 1000;
    const artifactBytes = 500;
    const script = `process.stdout.write("x".repeat(${String(fullOutputLength)}))`;
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
    const result = await tool(toolsAt(cwd, undefined, undefined, artifactBytes), "shell.run").execute(
      { command, timeoutMs: 2000 },
      context(),
    );
    expect(result).toMatchObject({
      exitCode: 0,
      output: "x".repeat(fullOutputLength),
      fullOutputLength,
      truncated: false,
      fullOutputPath: expect.any(String),
      fullOutputComplete: false,
    });
    if (
      typeof result !== "object" ||
      result === null ||
      !("fullOutputPath" in result) ||
      typeof result["fullOutputPath"] !== "string"
    )
      throw new Error("shell.run did not return its incomplete retained output path");
    expect((await readFile(result["fullOutputPath"])).byteLength).toBe(artifactBytes);
  });
  it("accepts explicit shell timeouts longer than ten minutes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-shell-long-timeout-"));
    const result = await tool(toolsAt(cwd), "shell.run").execute(
      { command: "true", timeoutMs: 3_600_000 },
      context(),
    );
    expect(result).toMatchObject({ exitCode: 0, truncated: false, fullOutputComplete: true });
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
