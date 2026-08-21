import type { FrozenTurnPlan } from "@noesis/agent-types";
import {
  createConditionalObject,
  sha256,
  type CapabilityRevisionRef,
  type CompoundingReplayRecord,
  type DataSensitivity,
  type EvidenceRef,
  type EvidenceRevisionRef,
  type JsonValue,
  toJsonValue,
} from "@noesis/domain";
import { describe, expect, test } from "vitest";
import {
  createForegroundReplayCoordinator,
  type EffectFreeForegroundReplayRequest,
  type EffectFreeForegroundReplayResult,
  type ForegroundReplayInput,
  type ForegroundReplayPersistencePort,
  type BlindJudgment,
} from "../src/index.ts";
const fileRef = (name: string): EvidenceRef => ({
  kind: "file_revision",
  revisionId: `revision-${name}`,
  workingPath: `definitions/${name}.md`,
  snapshotPath: `revisions/${name}/content`,
  contentDigest: sha256(name),
});
const servedRevision: CapabilityRevisionRef = {
  kind: "capability_revision",
  capabilityId: "cap-research",
  capabilityRevisionId: "cap-research-r2",
  bundleDigest: sha256("served"),
};
const baselineRevision: CapabilityRevisionRef = {
  kind: "capability_revision",
  capabilityId: "cap-research",
  capabilityRevisionId: "cap-research-r1",
  bundleDigest: sha256("baseline"),
};
const promptRef = fileRef("served-prompt");
const routerRef = fileRef("router");
const messageRef = fileRef("message");
const toolRef = fileRef("tool-call");
function plan(): FrozenTurnPlan {
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  return {
    schemaVersion: 1,
    planId: "plan-1",
    sessionId: "session-1",
    turnId: "turn-1",
    activationId: "activation-1",
    activationRevision: 1,
    selectedCapabilities: [
      {
        capabilityId: "cap-research",
        name: "research",
        scope: "research",
        selectionReason: "Related research work",
        revision: servedRevision,
        baseline: {
          kind: "capability_revision",
          experimentId: "experiment-1",
          revision: baselineRevision,
        },
        promptModules: [
          {
            revision: promptRef as Extract<
              EvidenceRef,
              {
                kind: "file_revision";
              }
            >,
            content: "serve",
          },
        ],
        skills: [],
        tools: [],
        router: {
          revision: routerRef as Extract<
            EvidenceRef,
            {
              kind: "file_revision";
            }
          >,
          content: "{}",
        },
        permissionManifest: { effects: [], resourcePatterns: [], credentialRefs: [] },
      },
    ],
    renderedSystemPrompt: "served system",
    provider: "fake",
    model: "fake-1",
    thinkingLevel: "off",
    permissionSnapshot: { effects: [], resourcePatterns: [], credentialRefs: [] },
    retrievalCitations: [],
    routing: { strategyId: "scope-v1", reason: "research" },
    createdAt: "2026-07-25T00:00:00.000Z",
    canonicalDigest: "a".repeat(64),
  };
}
function fakePersistence(log: string[]) {
  const evidence = new Map<string, JsonValue>();
  const records: CompoundingReplayRecord[] = [];
  let sequence = 0;
  const append = <Kind extends "output" | "judgment">(
    kind: Kind,
    value: EffectFreeForegroundReplayResult | BlindJudgment,
  ): EvidenceRevisionRef<Kind> => {
    sequence += 1;
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const ref = {
      kind: "evidence_revision" as const,
      revisionId: `evidence-${sequence}`,
      workingPath: `evidence/${sequence}`,
      snapshotPath: `evidence/${sequence}/content`,
      contentDigest: sha256(JSON.stringify(value)),
      evidenceKind: kind,
    };
    evidence.set(ref.revisionId, toJsonValue(value));
    return ref;
  };
  const port: ForegroundReplayPersistencePort = {
    putBudget: async () => {
      log.push("budget");
    },
    beginReplay: async () => {
      log.push("begin");
    },
    reserveRole: async ({ role }) => {
      log.push(`reserve:${role}`);
      return { status: "reserved" };
    },
    completeRole: async ({ operationId }) => {
      log.push(`complete:${operationId.includes("replay_role_") ? "role" : "unknown"}`);
    },
    failRole: async (_operationId, failure) => {
      log.push(`fail:${failure}`);
    },
    appendOutputEvidence: async ({ role, value }) => {
      log.push(`evidence:${role}`);
      return append("output", value);
    },
    appendJudgmentEvidence: async ({ value }) => {
      log.push("evidence:judge");
      return append("judgment", value);
    },
    readEvidence: async (ref) => {
      const value = evidence.get(ref.revisionId);
      if (value === undefined) throw new Error(`Missing controlled evidence ${ref.revisionId}`);
      return value;
    },
    record: async (record) => {
      records.push(record);
      log.push(`record:${record.status}`);
    },
  };
  return { port, records };
}
function input(sensitivity: DataSensitivity = "normal"): ForegroundReplayInput {
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  return createConditionalObject({
    replayId: "replay-1",
    plan: plan(),
    outcome: "corrected",
    occurredAt: "2026-07-25T01:00:00.000Z",
    scope: "research",
    scopeRelated: true,
    modelCohort: "fake/fake-1/off",
    messages: [{ role: "user", content: "help", sourceRef: messageRef, sensitivity }],
    toolResults: [
      {
        toolCallId: "tool-1",
        toolName: "inspect",
        request: { path: "notes.md" },
        response: { text: "recorded result" },
        status: "completed",
        sourceRef: toolRef,
        sensitivity,
      },
    ],
    provenance: [promptRef, routerRef, messageRef, toolRef].map((ref) => ({ ref, sensitivity })),
  } as const)
    .addOptional(
      sensitivity === "private"
        ? {
            privateAuthorization: {
              policyId: "private-fake-v1",
              allowsPrivateReplay: true,
              authorizedProviders: ["fake"],
            },
          }
        : undefined,
    )
    .add({
      served: {
        systemPrompt: "served system",
        capabilityRevisions: [servedRevision],
        immutableRefs: [promptRef, routerRef],
        inputTokens: 120,
        promptLayerBytes: 800,
        injectedContextTokens: 20,
      },
      baseline: {
        systemPrompt: "baseline system",
        capabilityRevisions: [baselineRevision],
        immutableRefs: [],
        inputTokens: 100,
        promptLayerBytes: 600,
        injectedContextTokens: 0,
      },
      correctionExposures: [],
      budget: {
        budgetId: "budget-1",
        maximumCalls: 3,
        maximumTokens: 3000,
        maximumCost: 1,
        roles: {
          served_arm: { maximumTokens: 1000, maximumCost: 0.3 },
          baseline_arm: { maximumTokens: 1000, maximumCost: 0.3 },
          judge: { maximumTokens: 1000, maximumCost: 0.4 },
        },
      },
    } as const)
    .finish();
}
describe("effect-free foreground replay", () => {
  test("fails closed on secret provenance without invoking any role", async () => {
    const log: string[] = [];
    const persistence = fakePersistence(log);
    const coordinator = createForegroundReplayCoordinator({
      replay: { run: async () => Promise.reject(new Error("must not run")) },
      judge: { judge: async () => Promise.reject(new Error("must not judge")) },
      persistence: persistence.port,
    });
    const result = await coordinator.consider(input("secret"));
    expect(result.ok && result.value).toMatchObject({
      status: "excluded",
      exclusionReason: "secret_data",
    });
    expect(log).toEqual(["budget", "begin", "record:excluded"]);
  });
  test("requires complete provenance and explicit private-provider authorization", async () => {
    const log: string[] = [];
    const persistence = fakePersistence(log);
    const coordinator = createForegroundReplayCoordinator({
      replay: { run: async () => Promise.reject(new Error("must not run")) },
      judge: { judge: async () => Promise.reject(new Error("must not judge")) },
      persistence: persistence.port,
    });
    const value = input("private");
    const { privateAuthorization: _privateAuthorization, ...withoutPolicy } = value;
    const missingClassification = { ...input(), provenance: input().provenance.slice(1) };
    const privateResult = await coordinator.consider(withoutPolicy);
    expect(privateResult.ok && privateResult.value).toMatchObject({
      exclusionReason: "private_data_unauthorized",
    });
    const missingResult = await coordinator.consider({
      ...missingClassification,
      replayId: "replay-2",
    });
    expect(missingResult.ok && missingResult.value).toMatchObject({
      exclusionReason: "missing_provenance_classification",
    });
  });
  test("reserves every role before calling it and reuses only recorded tool results", async () => {
    const log: string[] = [];
    const persistence = fakePersistence(log);
    const requests: EffectFreeForegroundReplayRequest[] = [];
    const coordinator = createForegroundReplayCoordinator({
      replay: {
        run: async (request) => {
          log.push(`run:${request.arm}`);
          requests.push(request);
          return {
            text: request.arm === "served" ? "better" : "worse",
            provider: "fake",
            model: "fake-1",
            inputTokens: 100,
            outputTokens: 10,
            estimatedCost: 0,
            unexpectedEffects: [],
          };
        },
      },
      judge: {
        judge: async ({ arms }) => {
          log.push("run:judge");
          return {
            judgment: {
              winner: arms.A.text === "better" ? "A" : "B",
              confidence: 0.9,
              reasons: ["More useful"],
              violations: [],
              appliedCriteria: [],
            },
            provider: "fake",
            model: "fake-1",
            inputTokens: 50,
            outputTokens: 10,
            estimatedCost: 0,
          };
        },
      },
      persistence: persistence.port,
    });
    const result = await coordinator.consider(input("private"));
    expect(result.ok && result.value).toMatchObject({ status: "paired", winner: "served" });
    expect(log.indexOf("reserve:served_arm")).toBeLessThan(log.indexOf("run:served"));
    expect(log.indexOf("reserve:baseline_arm")).toBeLessThan(log.indexOf("run:baseline"));
    expect(log.indexOf("reserve:judge")).toBeLessThan(log.indexOf("run:judge"));
    expect(requests).toHaveLength(2);
    expect(requests[0]?.recordedToolResults).toEqual([
      {
        toolCallId: "tool-1",
        toolName: "inspect",
        request: { path: "notes.md" },
        response: { text: "recorded result" },
      },
    ]);
    expect(requests.every((request) => !("availableTools" in request))).toBe(true);
  });
});
