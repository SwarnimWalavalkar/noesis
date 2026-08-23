import type { AgentRole, AgentRunRequest, AgentUsage } from "@noesis/agent-types";
import type { CapabilityRevisionRef, ExperimentVariantRef, FileRevisionRef } from "@noesis/domain";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createAgentRoleRunner,
  createBlindedJudgeFixture,
  createComparableRoleVariantFixture,
  createDefaultRoleContextPolicy,
  createRestrictedRoleContextPolicy,
  createStructuredInferencePort,
  applyRoleContextPolicy,
  isRoleRunError,
  type RoleBackendRequest,
  type RoleStopReason,
  type RoleVariantConfiguration,
  type RuntimePiAgentRunRequest,
} from "../src/index.ts";
import {
  createScriptedAgentRoleRunner,
  createScriptedRoleModelBackend,
} from "./support/scripted-role-runner.ts";

const promptRevision = (revisionId: string): FileRevisionRef => ({
  kind: "file_revision",
  revisionId,
  workingPath: `prompts/${revisionId}.md`,
  snapshotPath: `.noesis/revisions/${revisionId}.md`,
  contentDigest: revisionId.padEnd(64, "0").slice(0, 64),
});

const roleVariant = (variantId: string): ExperimentVariantRef => ({
  variantId,
  axis: "role",
  configurationRefs: [promptRevision(`prompt-${variantId}`)],
});

const capabilityRevision: CapabilityRevisionRef = {
  kind: "capability_revision",
  capabilityId: "capability-writing",
  capabilityRevisionId: "revision-7",
  bundleDigest: "7".repeat(64),
};

const usage = (inputTokens: number, outputTokens: number, estimatedCost: number): AgentUsage => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
  estimatedCost,
});

function configuration(role: AgentRole, variantId: string): RoleVariantConfiguration {
  return {
    variant: roleVariant(variantId),
    role,
    provider: "scripted-provider",
    model: `scripted-${variantId}`,
    reasoning: "medium",
    systemPrompt: `${role} system prompt`,
    contextPolicy: createDefaultRoleContextPolicy(role),
    timeoutMs: 5_000,
    maxRetries: 0,
  };
}

function request(
  role: AgentRole,
  variantId: string,
  messages: AgentRunRequest["messages"],
): RuntimePiAgentRunRequest {
  return {
    runId: `run-${role}-${variantId}`,
    role,
    variant: roleVariant(variantId),
    messages,
    evidenceRefs: [
      {
        kind: "evidence_revision",
        revisionId: "evidence-1",
        workingPath: "evidence/output.json",
        snapshotPath: ".noesis/revisions/evidence-1.json",
        contentDigest: "e".repeat(64),
        evidenceKind: "output",
      },
    ],
    availableTools: [
      {
        name: "generated_tool",
        description: "must stay unavailable to isolated roles",
        inputSchemaId: "input-v1",
        outputSchemaId: "output-v1",
        permissionManifestRef: "permissions-v1",
      },
    ],
    capabilityRevisions: [capabilityRevision],
  };
}

describe("adapter-neutral role runner", () => {
  test("repairs structured output once and combines usage, latency, and complete revision identity", async () => {
    const responses = [
      { text: '{"answer":"almost",}', usage: usage(10, 3, 0.01) },
      { text: '```json\n{"answer":"repaired"}\n```', usage: usage(12, 4, 0.02) },
    ];
    const prompts: string[] = [];
    const runner = createScriptedAgentRoleRunner({
      respond(backendRequest) {
        prompts.push(backendRequest.prompt);
        const response = responses.shift();
        if (!response) throw new Error("Unexpected repair attempt");
        return response;
      },
      variants: [configuration("reflector", "reflect-v1")],
    });
    const structured = createStructuredInferencePort({ runner, maxRepairAttempts: 1 });

    const result = await structured.run(
      request("reflector", "reflect-v1", [{ role: "user", name: "signals", content: "signal one" }]),
      z.strictObject({ answer: z.string() }),
    );

    expect(result.value).toEqual({ answer: "repaired" });
    expect(result.trace.usage).toEqual(usage(22, 7, 0.03));
    expect(result.trace.telemetry).toMatchObject({ attempts: 2, repairAttempts: 1, status: "completed" });
    expect(result.capabilityRevisions).toEqual([capabilityRevision]);
    expect(result.trace.capabilityRevisions).toEqual([capabilityRevision]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Repair the following malformed model output");
  });

  test("retains failure telemetry when output stays malformed", async () => {
    const backend = createScriptedRoleModelBackend({ respond: () => ({ text: "not json" }) });
    const runner = createAgentRoleRunner({
      backend,
      variants: [configuration("case_generator", "cases-v1")],
    });
    const structured = createStructuredInferencePort({ runner, maxRepairAttempts: 1 });

    let failure: unknown;
    try {
      await structured.run(
        request("case_generator", "cases-v1", [
          { role: "user", name: "behavioral_objective", content: "preserve voice" },
        ]),
        z.strictObject({ cases: z.array(z.string()) }),
      );
    } catch (error) {
      failure = error;
    }

    expect(isRoleRunError(failure)).toBe(true);
    if (!isRoleRunError(failure)) return;
    expect(failure.code).toBe("malformed_output");
    expect(failure.trace?.telemetry).toMatchObject({
      stopReason: "stop",
      status: "failed",
      attempts: 2,
      repairAttempts: 1,
      failure: { code: "malformed_output" },
    });
  });

  test.each(["stop", "length", "toolUse"] satisfies readonly RoleStopReason[])(
    "preserves successful %s stop reason and reported usage",
    async (stopReason) => {
      const reportedUsage = usage(30, 9, 0.42);
      const backend = createScriptedRoleModelBackend({
        respond: () => ({ text: "done", stopReason, usage: reportedUsage }),
      });
      const runner = createAgentRoleRunner({
        backend,
        variants: [configuration("foreground", `foreground-${stopReason}`)],
      });

      const result = await runner.run(
        request("foreground", `foreground-${stopReason}`, [
          { role: "user", content: "complete foreground work" },
        ]),
      );

      expect(result.text).toBe("done");
      expect(result.trace.usage).toEqual(reportedUsage);
      expect(result.trace.telemetry).toMatchObject({ stopReason, status: "completed" });
    },
  );

  test("surfaces provider errors with stop, usage, and failure telemetry", async () => {
    const reportedUsage = usage(6, 2, 0.04);
    const backend = createScriptedRoleModelBackend({
      respond: () => ({ text: "", stopReason: "error", usage: reportedUsage, error: "rate limited" }),
    });
    const runner = createAgentRoleRunner({
      backend,
      variants: [configuration("foreground", "foreground-error")],
    });

    let failure: unknown;
    try {
      await runner.run(request("foreground", "foreground-error", [{ role: "user", content: "run" }]));
    } catch (error) {
      failure = error;
    }

    expect(isRoleRunError(failure)).toBe(true);
    if (!isRoleRunError(failure)) return;
    expect(failure.code).toBe("backend");
    expect(failure.trace?.usage).toEqual(reportedUsage);
    expect(failure.trace?.telemetry).toMatchObject({
      stopReason: "error",
      status: "failed",
      failure: { code: "backend", message: "rate limited" },
    });
  });

  test("aborts an active isolated role through the closure-owned run handle", async () => {
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const backend = createScriptedRoleModelBackend({
      respond: async (backendRequest) => {
        started?.();
        await new Promise<void>((resolve) => {
          if (backendRequest.signal.aborted) resolve();
          else backendRequest.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { text: "partial" };
      },
    });
    const runner = createAgentRoleRunner({
      backend,
      variants: [configuration("reflector", "reflect-abort")],
    });
    const roleRequest = request("reflector", "reflect-abort", [
      { role: "user", name: "signals", content: "bounded signal" },
    ]);

    const pending = runner.run(roleRequest);
    await startedPromise;
    await runner.abort(roleRequest.runId);

    await expect(pending).rejects.toMatchObject({
      code: "aborted",
      trace: { telemetry: { stopReason: "aborted", status: "aborted" } },
    });
  });

  test("runs comparable variants against identical bounded inputs", async () => {
    const prompts: RoleBackendRequest[] = [];
    const backend = createScriptedRoleModelBackend({
      respond(backendRequest) {
        prompts.push(backendRequest);
        return { text: JSON.stringify({ model: backendRequest.model }) };
      },
    });
    const runner = createAgentRoleRunner({
      backend,
      variants: [
        configuration("reflector", "reflect-baseline"),
        configuration("reflector", "reflect-candidate"),
      ],
    });
    const fixture = createComparableRoleVariantFixture({
      request: {
        runId: "comparison-run",
        role: "reflector",
        messages: [{ role: "user", name: "signals", content: "same observed correction" }],
        evidenceRefs: [],
        availableTools: [],
      },
      baselineVariant: roleVariant("reflect-baseline"),
      candidateVariant: roleVariant("reflect-candidate"),
      capabilityRevisions: [capabilityRevision],
    });

    const [baseline, candidate] = await Promise.all([
      runner.run({ ...fixture.baseline, runId: "comparison-baseline" }),
      runner.run({ ...fixture.candidate, runId: "comparison-candidate" }),
    ]);

    expect(fixture.baseline.messages).toEqual(fixture.candidate.messages);
    expect(fixture.baseline.evidenceRefs).toEqual(fixture.candidate.evidenceRefs);
    expect(fixture.baseline.capabilityRevisions).toEqual(fixture.candidate.capabilityRevisions);
    expect(prompts.map((entry) => JSON.parse(entry.prompt).messages)).toEqual([
      fixture.baseline.messages,
      fixture.candidate.messages,
    ]);
    expect([baseline.trace.variant.variantId, candidate.trace.variant.variantId]).toEqual([
      "reflect-baseline",
      "reflect-candidate",
    ]);
  });

  test("runs one two-variant fixture through swappable scripted trial and judge roles with stable capability identity", async () => {
    const runner = createScriptedAgentRoleRunner({
      variants: [
        configuration("trial", "trial-baseline"),
        configuration("trial", "trial-candidate"),
        configuration("judge_critic", "judge-comparison"),
      ],
      respond: (backendRequest) => ({
        text: backendRequest.model.includes("judge")
          ? JSON.stringify({ winner: "B", reason: "more cited evidence" })
          : JSON.stringify({ answer: backendRequest.model, citations: ["source-1"] }),
      }),
    });
    const fixture = createComparableRoleVariantFixture({
      request: {
        runId: "research-comparison",
        role: "trial",
        messages: [
          { role: "user", name: "case", content: "Research the same bounded fixture." },
          { role: "user", name: "arm", content: "Apply the configured role variant." },
        ],
        evidenceRefs: [],
        availableTools: [],
      },
      baselineVariant: roleVariant("trial-baseline"),
      candidateVariant: roleVariant("trial-candidate"),
      capabilityRevisions: [capabilityRevision],
    });
    const [baseline, candidate] = await Promise.all([
      runner.run({ ...fixture.baseline, runId: "research-baseline" }),
      runner.run({ ...fixture.candidate, runId: "research-candidate" }),
    ]);
    const blinded = createBlindedJudgeFixture({
      first: JSON.parse(baseline.text),
      second: JSON.parse(candidate.text),
      swap: false,
      rubric: "Prefer the answer with stronger cited evidence.",
    });
    const judgment = await runner.run(request("judge_critic", "judge-comparison", blinded.messages));

    expect(fixture.baseline.messages).toEqual(fixture.candidate.messages);
    expect(baseline.capabilityRevisions).toEqual(fixture.capabilityRevisions);
    expect(candidate.capabilityRevisions).toEqual(fixture.capabilityRevisions);
    expect(baseline.trace.capabilityRevisions).toEqual(candidate.trace.capabilityRevisions);
    expect(judgment.capabilityRevisions).toEqual(fixture.capabilityRevisions);
    expect(JSON.parse(judgment.text)).toEqual({ winner: "B", reason: "more cited evidence" });
  });
});

describe("research role isolation", () => {
  test("admits the compaction input and output contract but rejects a third message", () => {
    const policy = createDefaultRoleContextPolicy("session_compactor");
    const messages = [
      { role: "user" as const, name: "compaction_input", content: "compact this session" },
      { role: "user" as const, name: "output_contract", content: "return the summary schema" },
    ];

    expect(policy.maxMessages).toBe(2);
    expect(
      applyRoleContextPolicy(request("session_compactor", "compact-v1", messages), policy).messages,
    ).toEqual(messages);
    expect(() =>
      applyRoleContextPolicy(
        request("session_compactor", "compact-v1", [
          ...messages,
          { role: "user", name: "output_contract", content: "unexpected third message" },
        ]),
        policy,
      ),
    ).toThrow("rejects messages beyond its message bound");
  });

  test("restricts capability routing to the current turn payload", () => {
    const policy = createRestrictedRoleContextPolicy("capability_router");

    expect(policy.allowedMessageNames).toEqual(["turn", "prior_conversation", "output_contract"]);
    expect(policy.maxTools).toBe(0);
  });

  test("derives custom isolated-role policies without weakening the default whitelist", () => {
    const policy = createRestrictedRoleContextPolicy("judge_critic", {
      policyId: "application-judge-v1",
      maxMessages: 12,
    });

    expect(policy.allowedMessageNames).toEqual([
      "rubric",
      "arm_A",
      "arm_B",
      "relevant_traces",
      "output_contract",
    ]);
    expect(policy.includeCapabilityRevisions).toBe(false);
    expect(policy.maxMessages).toBe(12);
    expect(() =>
      createRestrictedRoleContextPolicy("judge_critic", {
        maxTotalCharacters: 65_000,
      }),
    ).toThrow("cannot widen maxTotalCharacters");
    expect(() =>
      createRestrictedRoleContextPolicy("judge_critic", {
        allowedMessageNames: ["rubric", "candidate_identity"],
      }),
    ).toThrow("cannot add undeclared message names");
    expect(() =>
      createRestrictedRoleContextPolicy("judge_critic", {
        includeCapabilityRevisions: true,
      }),
    ).toThrow("cannot expose capability revisions");
  });

  test("preserves long structured router context as valid JSON and rejects overflow instead of slicing", async () => {
    let capturedPrompt = "";
    const backend = createScriptedRoleModelBackend({
      respond(backendRequest) {
        capturedPrompt = backendRequest.prompt;
        return { text: "{}" };
      },
    });
    const runner = createAgentRoleRunner({
      backend,
      variants: [configuration("capability_router", "router-context-v1")],
    });
    const longContent = "x".repeat(12_000);
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const messages = [
      Object.freeze({
        role: "user" as const,
        name: "turn",
        content: JSON.stringify({ userInput: "Continue", candidates: [] }),
      }),
      Object.freeze({
        role: "user" as const,
        name: "prior_conversation",
        content: JSON.stringify({
          messageId: "history-long",
          role: "user",
          content: longContent,
          createdAt: "2026-07-25T00:00:00.000Z",
        }),
      }),
    ];

    await runner.run(request("capability_router", "router-context-v1", messages));
    const rendered = z
      .object({ messages: z.array(z.object({ name: z.string(), content: z.string() })) })
      .parse(JSON.parse(capturedPrompt));
    expect(rendered.messages.map((message) => JSON.parse(message.content))).toMatchObject([
      { userInput: "Continue", candidates: [] },
      { messageId: "history-long", content: longContent },
    ]);

    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    await expect(
      runner.run(
        request("capability_router", "router-context-v1", [
          Object.freeze({
            role: "user" as const,
            name: "prior_conversation",
            content: "x".repeat(16_001),
          }),
        ]),
      ),
    ).rejects.toThrow("beyond its character bound");
  });

  test("passes only declared bounded reflector inputs and strips tools", async () => {
    let capturedPrompt = "";
    const backend = createScriptedRoleModelBackend({
      respond(backendRequest) {
        capturedPrompt = backendRequest.prompt;
        return { text: "ok" };
      },
    });
    const runner = createAgentRoleRunner({
      backend,
      variants: [configuration("reflector", "reflect-isolated")],
    });
    const roleRequest = {
      ...request("reflector", "reflect-isolated", [
        { role: "user", name: "signals", content: "one correction" },
      ]),
      authority: { promote: true },
      hiddenCases: ["protected-case"],
    };

    const result = await runner.run(roleRequest);
    const rendered = JSON.parse(capturedPrompt);

    expect(rendered.availableTools).toEqual([]);
    expect(rendered).not.toHaveProperty("authority");
    expect(rendered).not.toHaveProperty("hiddenCases");
    expect(result.trace.capabilityRevisions).toEqual([capabilityRevision]);
  });

  test("reserves reflector headroom for a large structured-output contract", async () => {
    let capturedPrompt = "";
    const backend = createScriptedRoleModelBackend({
      respond(backendRequest) {
        capturedPrompt = backendRequest.prompt;
        return { text: '{"answer":"ok"}' };
      },
    });
    const base = configuration("reflector", "reflect-contract-v1");
    const runner = createAgentRoleRunner({
      backend,
      variants: [
        {
          ...base,
          contextPolicy: createRestrictedRoleContextPolicy("reflector", {
            policyId: "reflector-contract-bounded-v1",
            maxMessages: 12,
            maxCharactersPerMessage: 12_000,
            maxTotalCharacters: 64_000,
          }),
        },
      ],
    });
    const structured = createStructuredInferencePort({ runner, maxRepairAttempts: 0 });
    const evidence = "e".repeat(10_000);

    await expect(
      structured.run(
        request("reflector", "reflect-contract-v1", [
          { role: "user", name: "settled_turn", content: "s".repeat(10_000) },
          { role: "user", name: "current_capabilities", content: "c".repeat(10_000) },
          { role: "user", name: "foreground_capability_surface", content: "f".repeat(10_000) },
          { role: "user", name: "current_capability_materials", content: "m".repeat(10_000) },
          { role: "user", name: "available_saved_programs", content: "p".repeat(7_000) },
          { role: "user", name: "evidence", content: evidence },
        ]),
        z.strictObject({ answer: z.string().describe("x".repeat(5_000)) }),
      ),
    ).resolves.toMatchObject({ value: { answer: "ok" } });

    const rendered = z
      .object({ messages: z.array(z.object({ name: z.string(), content: z.string() })) })
      .parse(JSON.parse(capturedPrompt));
    expect(rendered.messages.at(-2)).toEqual({ name: "evidence", content: evidence });
    expect(rendered.messages.at(-1)).toMatchObject({ name: "output_contract" });
    expect(rendered.messages.at(-1)?.content).toContain("Return JSON only");
  });

  test("rejects undeclared revision-author context", async () => {
    const backend = createScriptedRoleModelBackend({ respond: () => ({ text: "unused" }) });
    const runner = createAgentRoleRunner({
      backend,
      variants: [configuration("revision_author", "author-v1")],
    });

    await expect(
      runner.run(
        request("revision_author", "author-v1", [
          { role: "user", name: "judgment_evidence", content: "judge preferred arm A" },
        ]),
      ),
    ).rejects.toThrow("rejects undeclared message judgment_evidence");
  });

  test("blinds judge arm labels and excludes capability identity from model context", async () => {
    let capturedPrompt = "";
    const backend = createScriptedRoleModelBackend({
      respond(backendRequest) {
        capturedPrompt = backendRequest.prompt;
        return { text: '{"winner":"A"}' };
      },
    });
    const runner = createAgentRoleRunner({
      backend,
      variants: [configuration("judge_critic", "judge-v1")],
    });
    const blinded = createBlindedJudgeFixture({
      first: { answer: "one" },
      second: { answer: "two" },
      swap: true,
      rubric: "Prefer the clearer answer.",
    });

    const result = await runner.run(request("judge_critic", "judge-v1", blinded.messages));
    const rendered = JSON.parse(capturedPrompt);

    expect(rendered.messages.map((message: { name: string }) => message.name)).toEqual([
      "rubric",
      "arm_A",
      "arm_B",
    ]);
    expect(capturedPrompt).not.toContain(capabilityRevision.capabilityId);
    expect(capturedPrompt).not.toMatch(/baseline|candidate|authority|promotion/i);
    expect(blinded.labels).toEqual({ A: "second", B: "first" });
    expect(result.trace.capabilityRevisions).toEqual([capabilityRevision]);
    expect(result.capabilityRevisions).toEqual([capabilityRevision]);
  });
});
