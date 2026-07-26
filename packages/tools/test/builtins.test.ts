import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { JsonValue } from "@noesis/domain";
import { inspectEffectExecutionFailure, type AuthorityBoundary, type EffectDecision } from "@noesis/policy";
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
  resourcePatterns: Object.freeze(["file:*", "directory:*", "search:*", "shell:*", "url:*", "artifact:*"]),
  credentialRefs: Object.freeze([]),
});

function authority(): Pick<AuthorityBoundary, "runForeground"> {
  return Object.freeze({
    runForeground: async <T extends JsonValue>(
      request: Parameters<AuthorityBoundary["runForeground"]>[0],
    ): Promise<EffectDecision<T>> => {
      try {
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
  return createLocalWorkTools({
    cwd,
    ...(searchCommand ? { searchCommand } : {}),
    writeArtifact: async ({ path, content }) => ({
      path,
      bytes: Buffer.byteLength(content, "utf8"),
      contentDigest: createHash("sha256").update(content).digest("hex"),
    }),
  });
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

  it("does not spawn a pre-aborted shell command", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "noesis-tools-abort-"));
    const marker = join(cwd, "should-not-exist");
    const controller = new AbortController();
    controller.abort();

    await expect(
      tool(toolsAt(cwd), "shell.run").execute(
        { command: `touch ${JSON.stringify(marker)}`, timeoutMs: 1_000 },
        context(controller.signal),
      ),
    ).rejects.toSatisfy((error: unknown) => inspectEffectExecutionFailure(error)?.code === "cancelled");
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
      { command, timeoutMs: 5_000 },
      context(controller.signal),
    );
    setTimeout(() => controller.abort(), 100);

    await expect(execution).rejects.toSatisfy(
      (error: unknown) => inspectEffectExecutionFailure(error)?.code === "cancelled",
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 850));
    await expect(access(marker)).rejects.toThrow();
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
