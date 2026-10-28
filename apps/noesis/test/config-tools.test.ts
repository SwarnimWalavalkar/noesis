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

const configured = async (cli: { readonly provider?: string } = {}) => {
  const home = await mkdtemp(join(tmpdir(), "noesis-config-tools-"));
  roots.push(home);
  await initializeNoesisConfig(home, {
    schemaVersion: 1,
    agent: { provider: "stored-provider", model: "stored-model", thinkingLevel: "low" },
    agents: { provider: "sub-provider", model: "sub-model" },
  });
  return await resolveNoesisConfig({ home, env: {}, cli });
};

test("cleared foreground fields validate against the built-in default unless an override still wins", async () => {
  const before = await configured({ provider: "cli-provider" });
  const { agent } = routesAfter(before, { agent: { provider: null, model: null, thinkingLevel: "high" } });
  expect(agent).toEqual({
    provider: "cli-provider",
    model: BUILT_IN_AGENT_DEFAULTS.model,
    thinkingLevel: "high",
  });
});

test("cleared subagent fields inherit the patched foreground route", async () => {
  const before = await configured();
  const { agent, agents } = routesAfter(before, {
    agent: { model: "new-model" },
    agents: { provider: null, model: null },
  });
  expect(agent).toEqual({ provider: "stored-provider", model: "new-model", thinkingLevel: "low" });
  expect(agents).toEqual({ provider: "stored-provider", model: "new-model", thinkingLevel: "low" });
  expect(routesAfter(before, { agent: { model: "new-model" } }).agents).toEqual({
    provider: "sub-provider",
    model: "sub-model",
    thinkingLevel: "low",
  });
});
