import { createNoesisPiModelsStore } from "../../src/models-store.ts";

const [path, providerId] = process.argv.slice(2);
if (!path || !providerId) throw new Error("Expected a model-store path and provider ID");

process.stdout.write("ready\n");
process.stdin.setEncoding("utf8");
process.stdin.once("data", () => {
  void (async () => {
    try {
      await createNoesisPiModelsStore(path, () => true).write(providerId, {
        models: [
          {
            id: `${providerId}-model`,
            name: `${providerId} model`,
            api: "openai-completions",
            provider: providerId,
            baseUrl: "https://example.test/v1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1_024,
            maxTokens: 256,
          },
        ],
      });
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    }
  })();
});
