import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const taskStore = new InMemoryTaskStore();
const subscriptions = new Set();
const startupMarker = process.env.CONTROLLED_STARTUP_MARKER;
if (startupMarker) writeFileSync(startupMarker, `${String(process.pid)}\n`, { flag: "a" });
const startupDelay = Number(process.env.CONTROLLED_STARTUP_DELAY ?? "0");
if (Number.isFinite(startupDelay) && startupDelay > 0) {
  await new Promise((resolve) => setTimeout(resolve, startupDelay));
}
const server = new McpServer(
  { name: "noesis-controlled-mcp", version: "1.0.0" },
  {
    capabilities: {
      logging: {},
      resources: { subscribe: true, listChanged: true },
      tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
    },
    taskStore,
  },
);

server.registerTool(
  "echo/tool",
  {
    description: "Echo a value and report progress",
    inputSchema: { value: z.string() },
    outputSchema: { echoed: z.string() },
  },
  async ({ value }, extra) => {
    if (extra._meta?.progressToken !== undefined) {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: extra._meta.progressToken, progress: 1, total: 1, message: "done" },
      });
    }
    await server.sendLoggingMessage({ level: "info", data: "echoed" });
    return { content: [{ type: "text", text: value }], structuredContent: { echoed: value } };
  },
);

server.registerTool("failing", { description: "Return a structured MCP tool failure" }, async () => ({
  content: [{ type: "text", text: "controlled failure payload" }],
  structuredContent: { reason: "controlled" },
  isError: true,
}));

server.registerTool(
  "environment",
  { description: "Read a controlled child environment variable" },
  async () => ({
    content: [{ type: "text", text: process.env.CONTROLLED_SECRET ?? "missing" }],
  }),
);

server.registerTool("sample", { description: "Use client sampling" }, async () => {
  const result = await server.server.createMessage({
    messages: [{ role: "user", content: { type: "text", text: "Say hello" } }],
    maxTokens: 20,
  });
  return { content: [{ type: "text", text: result.content.type === "text" ? result.content.text : "" }] };
});

server.registerTool("roots", { description: "Read client roots" }, async () => {
  const result = await server.server.listRoots();
  return { content: [{ type: "text", text: result.roots[0]?.uri ?? "missing" }] };
});

server.registerTool("elicit", { description: "Ask for a name" }, async () => {
  const result = await server.server.elicitInput({
    message: "Your name?",
    requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  });
  return { content: [{ type: "text", text: String(result.content?.name ?? result.action) }] };
});

server.registerTool("elicit-url", { description: "Open a URL interaction" }, async () => {
  const result = await server.server.elicitInput({
    mode: "url",
    message: "Complete authentication",
    elicitationId: "controlled-url",
    url: "https://example.test/authorize",
  });
  return { content: [{ type: "text", text: result.action }] };
});

server.registerTool("slow", { description: "Wait until cancelled" }, async (_args, extra) => {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    extra.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
  return { content: [{ type: "text", text: extra.signal.aborted ? "cancelled" : "complete" }] };
});

server.registerTool("subscriptions", { description: "List active controlled subscriptions" }, async () => ({
  content: [{ type: "text", text: JSON.stringify([...subscriptions].sort()) }],
}));

server.registerTool("disconnect-once", { description: "Exit once for reconnect testing" }, async () => {
  const marker = process.env.CONTROLLED_DISCONNECT_MARKER;
  if (marker && !existsSync(marker)) {
    writeFileSync(marker, "disconnected\n", { flag: "wx" });
    setTimeout(() => process.exit(0), 25);
  }
  return { content: [{ type: "text", text: "disconnecting" }] };
});

const catalogMarker = process.env.CONTROLLED_CATALOG_MARKER;
if (catalogMarker && existsSync(catalogMarker)) {
  server.registerTool("catalog-v2", { description: "Change the discovery identity" }, async () => ({
    content: [{ type: "text", text: "v2" }],
  }));
}

const dynamicCatalogMarker = process.env.CONTROLLED_DYNAMIC_CATALOG_MARKER;
const discoveryBlockMarker = process.env.CONTROLLED_DISCOVERY_BLOCK_MARKER;
if (dynamicCatalogMarker && discoveryBlockMarker) {
  server.registerTool("mark-catalog-dirty", { description: "Mark discovery as dirty" }, async () => {
    const nextVersion = String(Number(readFileSync(dynamicCatalogMarker, "utf8")) + 1);
    writeFileSync(dynamicCatalogMarker, nextVersion);
    setTimeout(() => {
      void server.sendToolListChanged();
    }, 10);
    return { content: [{ type: "text", text: "dirty" }] };
  });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const version = readFileSync(dynamicCatalogMarker, "utf8").trim();
    try {
      if (version === "2" && existsSync(discoveryBlockMarker)) {
        writeFileSync(`${discoveryBlockMarker}.claimed`, `${String(process.pid)}\n`, { flag: "wx" });
        while (existsSync(discoveryBlockMarker)) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    } catch {
      // A newer connection must remain free to publish its discovery snapshot.
    }
    return {
      tools: [
        { name: "mark-catalog-dirty", inputSchema: { type: "object" } },
        { name: `catalog-v${version}`, inputSchema: { type: "object" } },
      ],
    };
  });
}

server.experimental.tasks.registerToolTask(
  "task-tool",
  { description: "Complete through MCP tasks", execution: { taskSupport: "required" } },
  {
    createTask: async (extra) => {
      const task = await extra.taskStore.createTask({ ttl: 60_000, pollInterval: 1 });
      await extra.taskStore.storeTaskResult(task.taskId, "completed", {
        content: [{ type: "text", text: "task complete" }],
      });
      return { task: await extra.taskStore.getTask(task.taskId) };
    },
    getTask: async (extra) => await extra.taskStore.getTask(extra.taskId),
    getTaskResult: async (extra) => await extra.taskStore.getTaskResult(extra.taskId),
  },
);

server.registerPrompt(
  "greet",
  {
    description: "Build a greeting",
    argsSchema: { name: z.string() },
  },
  ({ name }) => ({ messages: [{ role: "user", content: { type: "text", text: `Hello ${name}` } }] }),
);

server.registerResource(
  "readme",
  "test://readme",
  { description: "A test resource", mimeType: "text/plain" },
  async (uri) => ({ contents: [{ uri: uri.href, text: "resource body", mimeType: "text/plain" }] }),
);
server.registerResource(
  "item",
  new ResourceTemplate("test://item/{id}", { list: undefined }),
  { description: "A test template", mimeType: "text/plain" },
  async (uri) => ({ contents: [{ uri: uri.href, text: "template body", mimeType: "text/plain" }] }),
);

server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
  subscriptions.add(request.params.uri);
  return {};
});
server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
  subscriptions.delete(request.params.uri);
  return {};
});

if (process.env.CONTROLLED_TOOL_CATALOG === "malformed") {
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "environment", inputSchema: { type: "object", additionalProperties: false } },
      {
        name: "malformed",
        inputSchema: { type: "object", properties: { value: { type: "not-a-json-schema-type" } } },
      },
    ],
  }));
}

if (process.env.CONTROLLED_TOOL_CATALOG === "canonical-names") {
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "plain", inputSchema: { type: "object" } },
      { name: "a+b", inputSchema: { type: "object" } },
      { name: "a b", inputSchema: { type: "object" } },
      { name: "a".repeat(180), inputSchema: { type: "object" } },
    ],
  }));
}

await server.connect(new StdioServerTransport());
