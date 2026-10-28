import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_IN_AGENT_DEFAULTS, initializeNoesisConfig, resolveNoesisConfig } from "@noesis/config";
import { afterEach, expect, test } from "vitest";
import { routesAfter } from "../src/config-tools.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const FILE = { provider: "stored-provider", model: "stored-model", thinkingLevel: "low" } as const;

const configured = async (cli: { readonly provider?: string; readonly model?: string } = {}) => {
  const home = await mkdtemp(join(tmpdir(), "noesis-config-tools-"));
  roots.push(home);
  await initializeNoesisConfig(home, {
    schemaVersion: 1,
    agent: FILE,
    agents: { provider: "sub-provider", model: "sub-model" },
  });
  return await resolveNoesisConfig({ home, env: {}, cli });
};

const session = { provider: "session-provider", model: "session-model", thinkingLevel: "off" } as const;

test("cleared foreground fields resolve to the built-in default unless an override still wins", async () => {
  const before = await configured({ provider: "cli-provider" });
  const { agent } = routesAfter(
    before,
    { agent: { provider: null, model: null, thinkingLevel: "high" } },
    session,
    FILE,
  );
  expect(agent).toEqual({
    provider: "cli-provider",
    model: BUILT_IN_AGENT_DEFAULTS.model,
    thinkingLevel: "high",
  });
});

test("clearing only the provider keeps the stored model, so the changed route is validated", async () => {
  const before = await configured();
  const { agent } = routesAfter(before, { agent: { provider: null } }, session, FILE);
  expect(agent).toEqual({
    provider: BUILT_IN_AGENT_DEFAULTS.provider,
    model: "stored-model",
    thinkingLevel: "low",
  });
  expect(agent).not.toEqual(before.agent);
});

test("inherited and cleared subagent fields follow the current session route", async () => {
  const before = await configured();
  const reasoningOnly = routesAfter(before, { agents: { thinkingLevel: "minimal" } }, session, FILE);
  expect(reasoningOnly.agentsBefore).toEqual({
    provider: "sub-provider",
    model: "sub-model",
    thinkingLevel: "off",
  });
  expect(reasoningOnly.agents).toEqual({
    provider: "sub-provider",
    model: "sub-model",
    thinkingLevel: "minimal",
  });
  expect(
    routesAfter(
      before,
      { agent: { model: "new-model" }, agents: { provider: null, model: null } },
      session,
      FILE,
    ).agents,
  ).toEqual(session);
});

test("command-line overrides keep winning, so subagents inherit the overridden session route", async () => {
  const before = await configured({ provider: "openai-codex", model: "codex-model" });
  const running = { provider: "openai-codex", model: "codex-model", thinkingLevel: "low" } as const;
  const routes = routesAfter(
    before,
    {
      agent: { provider: "anthropic", model: "claude" },
      agents: { provider: null, model: "claude" },
    },
    running,
    FILE,
  );
  expect(routes.stored).toEqual({ provider: "anthropic", model: "claude", thinkingLevel: "low" });
  expect(routes.agent).toEqual(running);
  expect(routes.agents).toEqual({ provider: "openai-codex", model: "claude", thinkingLevel: "low" });
});
