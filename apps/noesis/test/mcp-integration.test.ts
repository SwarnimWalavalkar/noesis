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

function createTestMcpIntegration(
  input: Parameters<typeof createApplicationMcpIntegration>[0],
): ReturnType<typeof createApplicationMcpIntegration> {
  const integration = createApplicationMcpIntegration(input);
  integration.setLifecycleAuthorizer(async ({ execute }) => await execute());
  return integration;
}

describe("application MCP integration", () => {
  test("fails closed before launching a server when lifecycle authority is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-lifecycle-authority-"));
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
          controlled: {
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
      workspaceTrusted: true,
    });

    await integration.start();

    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(integration.host.inspectServer("controlled")).toMatchObject({
      status: "failed",
      lastError: "MCP lifecycle authority is not available",
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await integration.close();
  });

  test("does not write MCP configuration when lifecycle authority denies the operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-config-authority-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const projectDirectory = join(root, "project");
    await Promise.all([mkdir(home, { recursive: true }), mkdir(projectDirectory, { recursive: true })]);
    const integration = createApplicationMcpIntegration({
      home,
      projectDirectory,
      sampling,
      interactions: createTuiMcpInteractionBridge(),
      openUrl: async () => undefined,
      workspaceTrusted: true,
    });
    integration.setLifecycleAuthorizer(async () => {
      throw new Error("denied by controlled authority");
    });

    await expect(
      integration.mutateMcp({
        type: "add-local",
        scope: "global",
        name: "blocked",
        command: [process.execPath, controlledServerFixture],
      }),
    ).rejects.toThrow("denied by controlled authority");
    await expect(readFile(join(home, "mcp.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await integration.close();
  });

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
    const integration = createTestMcpIntegration({
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
    const integration = createTestMcpIntegration({
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

  test("uses the trust-filtered global server for events and live mutations under a project shadow", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-untrusted-shadow-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const projectDirectory = join(root, "project");
    const projectMarker = join(root, "project-started");
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(join(projectDirectory, ".noesis"), { recursive: true }),
    ]);
    await writeFile(
      join(home, "mcp.json"),
      JSON.stringify({
        servers: {
          shared: { type: "local", command: process.execPath, args: [controlledServerFixture] },
          broken: { type: "local", command: "/missing-trusted-global" },
        },
      }),
    );
    await writeFile(
      join(projectDirectory, ".noesis", "mcp.json"),
      JSON.stringify({
        servers: {
          shared: {
            type: "local",
            command: process.execPath,
            args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(projectMarker)}, "started")`],
          },
          broken: { type: "local", command: "/missing-blocked-project" },
        },
      }),
    );
    const integration = createTestMcpIntegration({
      home,
      projectDirectory,
      sampling,
      interactions: createTuiMcpInteractionBridge(),
      openUrl: async () => undefined,
      workspaceTrusted: false,
    });
    await integration.start();

    await expect(
      integration.mutateMcp({ type: "reconnect", scope: "global", name: "shared" }),
    ).resolves.toMatchObject({ message: "Reconnected shared." });
    await expect(readFile(projectMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const globalErrors = (await integration.inspectMcpServer("global", "broken"))?.recentErrors ?? [];
    expect(globalErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("missing-trusted-global"),
          occurredAt: expect.any(String),
        }),
      ]),
    );
    expect(globalErrors.some((entry) => entry.message.includes("missing-blocked-project"))).toBe(false);
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
    const integration = createTestMcpIntegration({
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

  test("rejects non-HTTP remote URLs for both add and edit", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-remote-url-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const projectDirectory = join(root, "project");
    await Promise.all([mkdir(home, { recursive: true }), mkdir(projectDirectory, { recursive: true })]);
    await writeFile(
      join(home, "mcp.json"),
      JSON.stringify({
        servers: { remote: { type: "remote", url: "https://valid.example.test/mcp", enabled: false } },
      }),
    );
    const integration = createTestMcpIntegration({
      home,
      projectDirectory,
      sampling,
      interactions: createTuiMcpInteractionBridge(),
      openUrl: async () => undefined,
      workspaceTrusted: true,
    });

    await expect(
      integration.mutateMcp({
        type: "add-remote",
        scope: "project",
        name: "added",
        url: "file:///tmp/server.sock",
        oauth: false,
      }),
    ).rejects.toThrow("must use http:// or https://");
    await expect(
      integration.mutateMcp({
        type: "edit-remote",
        scope: "global",
        name: "remote",
        url: "ftp://invalid.example.test/mcp",
        oauth: false,
      }),
    ).rejects.toThrow("must use http:// or https://");
    expect(JSON.parse(await readFile(join(home, "mcp.json"), "utf8"))).toMatchObject({
      servers: { remote: { url: "https://valid.example.test/mcp" } },
    });
    await integration.close();
  });

  test("keeps error history scoped and rotates it when a server definition changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-mcp-error-history-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const projectDirectory = join(root, "project");
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(join(projectDirectory, ".noesis"), { recursive: true }),
    ]);
    await writeFile(
      join(home, "mcp.json"),
      JSON.stringify({ servers: { broken: { type: "local", command: "/missing-global-server" } } }),
    );
    const integration = createTestMcpIntegration({
      home,
      projectDirectory,
      sampling,
      interactions: createTuiMcpInteractionBridge(),
      openUrl: async () => undefined,
      workspaceTrusted: true,
    });
    await integration.start();
    expect((await integration.inspectMcpServer("global", "broken"))?.recentErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("missing-global-server") }),
      ]),
    );

    await integration.mutateMcp({
      type: "add-local",
      scope: "project",
      name: "broken",
      command: ["/missing-project-server"],
    });
    const projectErrors = (await integration.inspectMcpServer("project", "broken"))?.recentErrors ?? [];
    expect(projectErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("missing-project-server") }),
      ]),
    );
    expect(projectErrors.some((entry) => entry.message.includes("missing-global-server"))).toBe(false);

    await integration.mutateMcp({
      type: "edit-local",
      scope: "project",
      name: "broken",
      command: ["/missing-replacement-server"],
    });
    const replacementErrors = (await integration.inspectMcpServer("project", "broken"))?.recentErrors ?? [];
    expect(replacementErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("missing-replacement-server") }),
      ]),
    );
    expect(replacementErrors.some((entry) => entry.message.includes("missing-project-server"))).toBe(false);
    await integration.close();
  });
});
