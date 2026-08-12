import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiMcpSamplingPort } from "@noesis/runtime-pi";
import { createTuiMcpInteractionBridge } from "@noesis/tui";
import { afterEach, describe, expect, test } from "vitest";
import { createApplicationMcpIntegration } from "../src/mcp-integration.ts";

const temporaryDirectories: string[] = [];
const controlledServerFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/mcp/test/fixtures/server.mjs",
);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true })));
});

const sampling: PiMcpSamplingPort = Object.freeze({
  async sample() {
    throw new Error("Sampling is not expected in this test");
  },
});

describe("application MCP integration", () => {
  test("rejects reverse sampling unless it is bound to an authorized foreground invocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-sampling-authority-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const projectDirectory = join(root, "project");
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(join(projectDirectory, ".noesis"), { recursive: true }),
    ]);
    await writeFile(
      join(projectDirectory, ".noesis", "mcp.json"),
      JSON.stringify({
        servers: {
          controlled: {
            type: "local",
            command: process.execPath,
            args: [controlledServerFixture],
          },
        },
      }),
    );
    const controlledSampling: PiMcpSamplingPort = Object.freeze({
      sample: async () => ({
        role: "assistant" as const,
        model: "controlled",
        content: { type: "text" as const, text: "authorized sample" },
      }),
    });
    const integration = createApplicationMcpIntegration({
      home,
      projectDirectory,
      sampling: controlledSampling,
      interactions: createTuiMcpInteractionBridge(),
      openUrl: async () => undefined,
      workspaceTrusted: true,
    });
    await integration.start();

    await expect(integration.host.callTool("mcp.controlled.sample", {})).resolves.toMatchObject({
      isError: true,
      content: [
        expect.objectContaining({
          text: expect.stringContaining("allowed only during an admitted foreground invocation"),
        }),
      ],
    });
    integration.setSamplingAuthorizer(async ({ execute }) => await execute());
    await expect(
      integration.host.callTool(
        "mcp.controlled.sample",
        {},
        {
          invocation: {
            route: { provider: "controlled", model: "controlled", reasoning: "off" },
            sessionId: "session",
            turnId: "turn",
            executionId: "execution",
            logicalExecutionId: "logical",
            callId: "call",
          },
        },
      ),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "authorized sample" }] });
    await integration.close();
  });

  test("does not start project MCP servers before the workspace is trusted", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-untrusted-project-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const projectDirectory = join(root, "project");
    const marker = join(root, "started");
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(join(projectDirectory, ".noesis"), { recursive: true }),
    ]);
    await writeFile(
      join(projectDirectory, ".noesis", "mcp.json"),
      JSON.stringify({
        servers: {
          hostile: {
            type: "local",
            command: process.execPath,
            args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`],
          },
        },
      }),
    );
    const integration = createApplicationMcpIntegration({
      home,
      projectDirectory,
      sampling,
      interactions: createTuiMcpInteractionBridge(),
      openUrl: async () => undefined,
      workspaceTrusted: false,
    });

    await integration.start();

    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(integration.listMcpServers()).resolves.toEqual([
      expect.objectContaining({
        name: "hostile",
        scope: "project",
        enabled: false,
        status: "disabled",
        lastError: "Project MCP servers require a trusted workspace.",
      }),
    ]);
    await integration.close();
  });

  test("preserves structured OAuth metadata until the user explicitly changes OAuth mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-integration-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const projectDirectory = join(root, "project");
    await Promise.all([mkdir(home, { recursive: true }), mkdir(projectDirectory, { recursive: true })]);
    await writeFile(
      join(home, "mcp.json"),
      JSON.stringify({
        servers: {
          remote: {
            type: "remote",
            url: "https://old.example.test/mcp",
            enabled: false,
            oauth: {
              clientId: "client-id",
              clientSecretEnvironment: "MCP_CLIENT_SECRET",
              scope: "read write",
              callbackPort: 4567,
            },
          },
        },
      }),
    );
    const integration = createApplicationMcpIntegration({
      home,
      projectDirectory,
      sampling,
      interactions: createTuiMcpInteractionBridge(),
      openUrl: async () => undefined,
      workspaceTrusted: true,
    });

    await integration.mutateMcp({
      type: "edit-remote",
      scope: "global",
      name: "remote",
      url: "https://new.example.test/mcp",
      oauth: true,
    });
    expect(JSON.parse(await readFile(join(home, "mcp.json"), "utf8"))).toMatchObject({
      servers: {
        remote: {
          url: "https://new.example.test/mcp",
          oauth: {
            clientId: "client-id",
            clientSecretEnvironment: "MCP_CLIENT_SECRET",
            scope: "read write",
            callbackPort: 4567,
          },
        },
      },
    });

    await integration.mutateMcp({
      type: "edit-remote",
      scope: "global",
      name: "remote",
      url: "https://new.example.test/mcp",
      oauth: false,
    });
    expect(JSON.parse(await readFile(join(home, "mcp.json"), "utf8"))).toMatchObject({
      servers: { remote: { oauth: false } },
    });

    await integration.mutateMcp({
      type: "edit-remote",
      scope: "global",
      name: "remote",
      url: "https://new.example.test/mcp",
      oauth: true,
    });
    expect(JSON.parse(await readFile(join(home, "mcp.json"), "utf8"))).toMatchObject({
      servers: { remote: { oauth: true } },
    });
    await integration.close();
  });
});
