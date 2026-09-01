import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject, JsonValueSchema } from "@noesis/domain";
import { describe, expect, test } from "vitest";

const writerPath = fileURLToPath(new URL("./fixtures/models-store-writer.ts", import.meta.url));

function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onData = (chunk: Buffer): void => {
      if (!chunk.toString("utf8").includes("ready")) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`Model-store writer exited before ready with ${code ?? signal}`));
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Model-store writer exited with ${code ?? signal}: ${stderr}`));
    });
  });
}

describe("Pi model catalog storage", () => {
  test("preserves concurrent updates from separate Noesis processes", async () => {
    const home = await mkdtemp(join(tmpdir(), "noesis-model-store-processes-"));
    const path = join(home, "models-store.json");
    const providerIds = Array.from({ length: 12 }, (_, index) => `provider-${index}`);
    const padding = "x".repeat(256 * 1_024);
    await writeFile(path, `${JSON.stringify({ unsupported: { padding } })}\n`);

    const children = providerIds.map((providerId) =>
      spawn(process.execPath, ["--import", "tsx", writerPath, path, providerId], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    const exits = children.map(waitForExit);
    for (const exit of exits) void exit.catch(() => undefined);
    try {
      await Promise.all(children.map(waitForReady));
      for (const child of children) child.stdin.end("write\n");
      await Promise.all(exits);
    } finally {
      for (const child of children) {
        child.stdin.destroy();
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
      await Promise.allSettled(exits);
    }

    const stored = JsonValueSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (!isJsonObject(stored)) throw new Error("Expected a provider-indexed model store");
    expect(stored["unsupported"]).toEqual({ padding });
    for (const providerId of providerIds)
      expect(stored[providerId]).toMatchObject({
        models: [{ provider: providerId, id: `${providerId}-model` }],
      });
  }, 20_000);
});
