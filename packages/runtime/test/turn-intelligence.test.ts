import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrozenBaselineRef } from "@noesis/agent-types";
import {
  type Capability,
  type CapabilityRevision,
  type CapabilityRevisionRef,
  capabilityRevisionRef,
  type FileRevisionRef,
  sha256,
} from "@noesis/domain";
import { createWorkspaceStore, type NoesisWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkspaceRuntimeInternals } from "../../workspace/src/protected-runtime.ts";
import {
  createTurnIntelligencePlanner,
  type TurnCapabilityResolver,
  type TurnCapabilityRoutingRequest,
} from "../src/index.ts";

const homes: { readonly root: string; readonly workspace: NoesisWorkspaceStore }[] = [];
const encoder = new TextEncoder();
const PROJECT = Object.freeze({ projectId: "project_test", root: "/workspace/noesis" });

afterEach(async () => {
  for (const item of homes.splice(0)) {
    item.workspace.close();
    await rm(item.root, { recursive: true, force: true });
  }
});

async function definition(
  workspace: NoesisWorkspaceStore,
  id: string,
  path: string,
  content: string,
): Promise<FileRevisionRef> {
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  const published = await workspace.definitionPublications.publish({
    namespace: "turn-plan-fixture",
    definitionId: id,
    revision: 1,
    workingPath: path,
    bytes: encoder.encode(content),
    activity: Object.freeze({
      kind: "fixture.published",
      actor: Object.freeze({ actorId: "test", kind: "system" as const }),
    }),
  });
  if (!published.ok) throw new Error(published.error.message);
  return published.value.definitionRevision;
}

describe("turn intelligence", () => {
  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test("admits exact immutable material while a narrow adaptation abstains from unrelated work", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-turn-plan-"));
    const workspace = await createWorkspaceStore(root);
    const protectedRuntime = createWorkspaceRuntimeInternals(workspace).protectedRuntime;
    homes.push({ root, workspace });
    const capabilities = new Map<string, Capability>();
    const revisions = new Map<string, CapabilityRevision>();
    const makeRevision = async (
      capability: Capability,
      promptContent: string,
    ): Promise<CapabilityRevision> => {
      const [prompt, skill, router] = await Promise.all([
        definition(
          workspace,
          `${capability.capabilityId}-prompt`,
          `prompts/${capability.capabilityId}.md`,
          promptContent,
        ),
        definition(
          workspace,
          `${capability.capabilityId}-skill`,
          `skills/${capability.capabilityId}.md`,
          `# ${capability.name}`,
        ),
        definition(
          workspace,
          `${capability.capabilityId}-router`,
          `capabilities/${capability.capabilityId}-router.json`,
          "{}",
        ),
      ]);
      // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
      return Object.freeze({
        capabilityRevisionId: `${capability.capabilityId}-v1`,
        capabilityId: capability.capabilityId,
        promptModules: Object.freeze([prompt]),
        skills: Object.freeze([skill]),
        tools: Object.freeze([]),
        toolset: Object.freeze({
          toolRevisionIds: Object.freeze([]),
          routerRevision: router,
          strategyId: "fixture",
        }),
        activationPolicy: Object.freeze({
          mode: "automatic_low_risk" as const,
          scope: capability.scope,
        }),
        permissionManifest: Object.freeze({
          effects: Object.freeze([]),
          resourcePatterns: Object.freeze([]),
          credentialRefs: Object.freeze([]),
        }),
        evidenceRefs: Object.freeze([]),
        sourceEvaluationDefinitions: Object.freeze([]),
        requestedPermissionDelta: Object.freeze({
          addedEffects: Object.freeze([]),
          widenedResources: Object.freeze([]),
          addedCredentialRefs: Object.freeze([]),
        }),
      });
    };
    const general = Object.freeze({
      capabilityId: "general",
      name: "General",
      scope: "general",
      intent: "baseline",
    });
    const research = Object.freeze({
      capabilityId: "research-brief",
      name: "Research brief",
      scope: "research brief",
      intent: "keep research briefs concise",
    });
    for (const [capability, prompt] of [
      [general, "GENERAL PROMPT"],
      [research, "NARROW RESEARCH PROMPT"],
    ] as const) {
      const revision = await makeRevision(capability, prompt);
      const reference = capabilityRevisionRef(revision);
      capabilities.set(capability.capabilityId, capability);
      revisions.set(reference.capabilityRevisionId, revision);
      const promptRevision = revision.promptModules[0];
      const skillRevision = revision.skills[0];
      if (!promptRevision || !skillRevision) throw new Error("Fixture revision is incomplete");
      if (capability.capabilityId === "general")
        await protectedRuntime.activations.bootstrapGenesis({
          capabilityRevision: reference,
          activeDefinitions: Object.freeze({
            [`${capability.capabilityId}:prompt`]: promptRevision,
            [`${capability.capabilityId}:skill`]: skillRevision,
            [`${capability.capabilityId}:router`]: revision.toolset.routerRevision,
          }),
        });
      else
        // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
        await workspace.capabilities.create({
          definition: Object.freeze({
            capabilityId: capability.capabilityId,
            name: capability.name,
            kind: "instruction",
            description: capability.intent,
            applicability: capability.scope,
            createdAt: "2026-07-24T00:00:00.000Z",
          }),
          revision: Object.freeze({
            revision,
            reference,
            summary: "Keep research briefs concise",
            rationale: "The user corrected overly broad research output",
            anticipatedEffect: "Shorter research briefs",
            createdAt: "2026-07-24T00:00:00.000Z",
          }),
          binding: Object.freeze({
            capabilityId: capability.capabilityId,
            revision: reference,
            scope: Object.freeze({ kind: "global" as const }),
            activationMode: "relevant",
            state: "active",
          }),
        });
    }
    const resolver: TurnCapabilityResolver = Object.freeze({
      resolveCapability: async (capabilityId: string) => capabilities.get(capabilityId),
      resolveRevision: async (reference: CapabilityRevisionRef) =>
        revisions.get(reference.capabilityRevisionId),
      resolveBaseline: async (reference: CapabilityRevisionRef): Promise<FrozenBaselineRef> => {
        if (reference.capabilityId === "general") return Object.freeze({ kind: "genesis" });
        const baseline = revisions.get("general-v1");
        if (!baseline) throw new Error("Fixture baseline is missing");
        return Object.freeze({
          kind: "capability_revision",
          experimentId: "experiment-research-brief",
          revision: capabilityRevisionRef(baseline),
        });
      },
    });
    const routingRequests: unknown[] = [];
    const routingDecisions = [
      Object.freeze({
        selections: Object.freeze([
          Object.freeze({
            capabilityId: "research-brief",
            reason: "The prior conversation establishes that review-only refers to the research brief",
          }),
        ]),
        learningAttribution: Object.freeze({
          capabilityId: "research-brief",
          reason: "This capability is the primary behavioral context for the follow-up",
        }),
      }),
      Object.freeze({ selections: Object.freeze([]) }),
    ];
    const planner = createTurnIntelligencePlanner({
      workspace,
      protectedRuntime,
      project: PROJECT,
      capabilities: resolver,
      capabilityRouter: Object.freeze({
        route: async (request: TurnCapabilityRoutingRequest) => {
          routingRequests.push(request);
          const decision = routingDecisions.shift();
          if (!decision) throw new Error("Unexpected semantic routing call");
          return Object.freeze({
            strategyId: "controlled-semantic-router-v1",
            reason:
              decision.selections.length === 0
                ? "No narrow capability applies"
                : "A narrow capability applies",
            ...decision,
          });
        },
      }),
      basePermissionManifest: Object.freeze({
        effects: Object.freeze(["read", "execute"]),
        resourcePatterns: Object.freeze(["*"]),
        credentialRefs: Object.freeze([]),
      }),
      now: () => "2026-07-25T00:00:00.000Z",
    });

    await workspace.operational.sessions.put({
      sessionId: "session-related",
      title: "Contextual routing fixture",
      status: "idle",
      provider: "fake",
      model: "fake",
      runtime: "fake",
      createdAt: "2026-07-24T23:58:00.000Z",
      updatedAt: "2026-07-24T23:58:00.000Z",
      metadata: Object.freeze({}),
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const priorHistory = Object.freeze([
      Object.freeze({
        messageId: "history-user",
        role: "user" as const,
        content: "Prepare a research brief about the current repository",
        createdAt: "2026-07-24T23:59:00.000Z",
      }),
      Object.freeze({
        messageId: "history-assistant",
        role: "assistant" as const,
        content: "I will implement the proposed changes.",
        createdAt: "2026-07-24T23:59:30.000Z",
      }),
    ]);
    const priorUser = priorHistory[0];
    const priorAssistant = priorHistory[1];
    if (!priorUser || !priorAssistant) throw new Error("Contextual routing fixture is incomplete");
    for (const message of priorHistory)
      await workspace.operational.messages.put({
        ...message,
        sessionId: "session-related",
        sensitivity: "normal",
        metadata: Object.freeze({}),
      });

    const related = await planner.planAndAdmit({
      sessionId: "session-related",
      turnId: "turn-related",
      userInput: "No, keep it review-only",
      priorHistory,
      provider: "fake",
      model: "fake",
      thinkingLevel: "off",
      baseSystemPrompt: "BASE",
    });
    expect(related.selectedCapabilities.map((item) => item.capabilityId)).toEqual([
      "general",
      "research-brief",
    ]);
    expect(related.selectedCapabilities[1]?.selectionReason).toBe(
      "The prior conversation establishes that review-only refers to the research brief",
    );
    expect(related.routing).toEqual({
      strategyId: "controlled-semantic-router-v1",
      reason: "A narrow capability applies",
      learningAttribution: {
        capabilityId: "research-brief",
        reason: "This capability is the primary behavioral context for the follow-up",
      },
    });
    expect(related.renderedSystemPrompt).toContain("NARROW RESEARCH PROMPT");
    expect(related.conversationHistory).toEqual([
      {
        ...priorUser,
        messageRef: {
          kind: "database_row",
          table: "messages",
          rowId: "history-user",
        },
        contentDigest: sha256(priorUser.content),
      },
      {
        ...priorAssistant,
        messageRef: {
          kind: "database_row",
          table: "messages",
          rowId: "history-assistant",
        },
        contentDigest: sha256(priorAssistant.content),
      },
    ]);
    const contextDocument = related.contextDocument;
    if (!contextDocument) throw new Error("Expected a frozen context document");
    const contextText = new TextDecoder().decode(
      await workspace.reads.readArtifact(contextDocument.artifact),
    );
    expect(contextDocument).toMatchObject({
      documentId: `context_document_${sha256(contextText)}`,
      format: "noesis-session-context-v1",
      characterLength: contextText.length,
      byteLength: Buffer.byteLength(contextText, "utf8"),
      contentDigest: sha256(contextText),
    });
    expect(contextText).toContain("Prepare a research brief about the current repository");
    expect(contextText).toContain("I will implement the proposed changes.");
    expect(contextText).not.toContain("No, keep it review-only");
    expect(related.permissionSnapshot).toEqual({
      effects: ["read", "execute"],
      resourcePatterns: ["*"],
      credentialRefs: [],
    });
    expect(await protectedRuntime.activations.getTurnPlan("session-related", "turn-related")).toEqual(
      related,
    );

    await expect(
      planner.planAndAdmit({
        sessionId: "session-related",
        turnId: "turn-tampered-history",
        userInput: "Continue",
        priorHistory: Object.freeze([Object.freeze({ ...priorUser, content: "Tampered history" })]),
        provider: "fake",
        model: "fake",
        thinkingLevel: "off",
        baseSystemPrompt: "BASE",
      }),
    ).rejects.toThrow("does not match authoritative SQLite state");
    expect(
      await protectedRuntime.activations.getTurnPlan("session-related", "turn-tampered-history"),
    ).toBeUndefined();

    const unrelated = await planner.planAndAdmit({
      sessionId: "session-unrelated",
      turnId: "turn-unrelated",
      userInput: "Explain monads with a tiny example",
      provider: "fake",
      model: "fake",
      thinkingLevel: "off",
      baseSystemPrompt: "BASE",
    });
    expect(unrelated.selectedCapabilities.map((item) => item.capabilityId)).toEqual(["general"]);
    expect(unrelated.renderedSystemPrompt).not.toContain("NARROW RESEARCH PROMPT");
    expect(routingRequests).toEqual([
      {
        sessionId: "session-related",
        turnId: "turn-related",
        userInput: "No, keep it review-only",
        priorConversation: [
          {
            messageId: "history-user",
            role: "user",
            content: "Prepare a research brief about the current repository",
            createdAt: "2026-07-24T23:59:00.000Z",
          },
          {
            messageId: "history-assistant",
            role: "assistant",
            content: "I will implement the proposed changes.",
            createdAt: "2026-07-24T23:59:30.000Z",
          },
        ],
        candidates: [research],
      },
      {
        sessionId: "session-unrelated",
        turnId: "turn-unrelated",
        userInput: "Explain monads with a tiny example",
        priorConversation: [],
        candidates: [research],
      },
    ]);

    const invalidPlanner = createTurnIntelligencePlanner({
      workspace,
      protectedRuntime,
      project: PROJECT,
      capabilities: resolver,
      capabilityRouter: Object.freeze({
        route: async () =>
          Object.freeze({
            strategyId: "controlled-semantic-router-v1",
            reason: "Invalid fixture decision",
            selections: Object.freeze([
              Object.freeze({ capabilityId: "not-active", reason: "Invalid fixture selection" }),
            ]),
            learningAttribution: Object.freeze({
              capabilityId: "not-active",
              reason: "Invalid fixture attribution",
            }),
          }),
      }),
    });
    await expect(
      invalidPlanner.planAndAdmit({
        sessionId: "session-invalid",
        turnId: "turn-invalid",
        userInput: "Try an invalid route",
        provider: "fake",
        model: "fake",
        thinkingLevel: "off",
        baseSystemPrompt: "BASE",
      }),
    ).rejects.toThrow("selected inactive capability not-active");
    expect(await protectedRuntime.activations.getTurnPlan("session-invalid", "turn-invalid")).toBeUndefined();

    const duplicatePlanner = createTurnIntelligencePlanner({
      workspace,
      protectedRuntime,
      project: PROJECT,
      capabilities: resolver,
      capabilityRouter: Object.freeze({
        route: async () =>
          Object.freeze({
            strategyId: "controlled-semantic-router-v1",
            reason: "Duplicate fixture decision",
            selections: Object.freeze([
              Object.freeze({ capabilityId: "research-brief", reason: "First selection" }),
              Object.freeze({ capabilityId: "research-brief", reason: "Second selection" }),
            ]),
            learningAttribution: Object.freeze({
              capabilityId: "research-brief",
              reason: "Duplicate fixture attribution",
            }),
          }),
      }),
    });
    await expect(
      duplicatePlanner.planAndAdmit({
        sessionId: "session-duplicate",
        turnId: "turn-duplicate",
        userInput: "Try a duplicate route",
        provider: "fake",
        model: "fake",
        thinkingLevel: "off",
        baseSystemPrompt: "BASE",
      }),
    ).rejects.toThrow("selected capability research-brief more than once");
    expect(
      await protectedRuntime.activations.getTurnPlan("session-duplicate", "turn-duplicate"),
    ).toBeUndefined();

    const misattributedPlanner = createTurnIntelligencePlanner({
      workspace,
      protectedRuntime,
      project: PROJECT,
      capabilities: resolver,
      capabilityRouter: Object.freeze({
        route: async () =>
          Object.freeze({
            strategyId: "controlled-semantic-router-v1",
            reason: "Misattributed fixture decision",
            selections: Object.freeze([
              Object.freeze({ capabilityId: "research-brief", reason: "Selected fixture" }),
            ]),
            learningAttribution: Object.freeze({
              capabilityId: "not-active",
              reason: "Invalid primary capability",
            }),
          }),
      }),
    });
    await expect(
      misattributedPlanner.planAndAdmit({
        sessionId: "session-misattributed",
        turnId: "turn-misattributed",
        userInput: "Try a misattributed route",
        provider: "fake",
        model: "fake",
        thinkingLevel: "off",
        baseSystemPrompt: "BASE",
      }),
    ).rejects.toThrow("attributed learning to unselected capability not-active");
    expect(
      await protectedRuntime.activations.getTurnPlan("session-misattributed", "turn-misattributed"),
    ).toBeUndefined();
  });

  test("keeps the protected genesis baseline without spending a semantic routing call", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-turn-plan-general-"));
    const workspace = await createWorkspaceStore(root);
    const protectedRuntime = createWorkspaceRuntimeInternals(workspace).protectedRuntime;
    homes.push({ root, workspace });
    const routerRevision = await definition(
      workspace,
      "general-router",
      "capabilities/general-router.json",
      "{}",
    );
    const capability: Capability = Object.freeze({
      capabilityId: "general",
      name: "General",
      scope: "general",
      intent: "baseline",
    });
    const revision: CapabilityRevision = Object.freeze({
      capabilityRevisionId: "general-v1",
      capabilityId: capability.capabilityId,
      promptModules: Object.freeze([]),
      skills: Object.freeze([]),
      tools: Object.freeze([]),
      toolset: Object.freeze({
        toolRevisionIds: Object.freeze([]),
        routerRevision,
        strategyId: "fixture",
      }),
      activationPolicy: Object.freeze({ mode: "automatic_low_risk", scope: capability.scope }),
      permissionManifest: Object.freeze({
        effects: Object.freeze([]),
        resourcePatterns: Object.freeze([]),
        credentialRefs: Object.freeze([]),
      }),
      evidenceRefs: Object.freeze([]),
      sourceEvaluationDefinitions: Object.freeze([]),
      requestedPermissionDelta: Object.freeze({
        addedEffects: Object.freeze([]),
        widenedResources: Object.freeze([]),
        addedCredentialRefs: Object.freeze([]),
      }),
    });
    const reference = capabilityRevisionRef(revision);
    await protectedRuntime.activations.bootstrapGenesis({
      capabilityRevision: reference,
      activeDefinitions: Object.freeze({ router: routerRevision }),
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const session = (sessionId: string) =>
      Object.freeze({
        sessionId,
        title: "General turn fixture",
        status: "idle" as const,
        provider: "fake",
        model: "fake",
        runtime: "fake",
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:00.000Z",
        metadata: Object.freeze({}),
      });
    await workspace.operational.sessions.put(session("session-observation"));
    await workspace.operational.sessions.put(session("session-general"));
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const sourcePlanner = createTurnIntelligencePlanner({
      workspace,
      protectedRuntime,
      project: PROJECT,
      capabilities: Object.freeze({
        resolveCapability: async () => capability,
        resolveRevision: async () => revision,
        resolveBaseline: async () => Object.freeze({ kind: "genesis" as const }),
      }),
      capabilityRouter: Object.freeze({
        route: async () => {
          throw new Error("The genesis-only source plan must not call the semantic router");
        },
      }),
    });
    await sourcePlanner.planAndAdmit({
      sessionId: "session-observation",
      turnId: "turn-observation",
      userInput: "Observe this completed project turn",
      provider: "fake",
      model: "fake",
      thinkingLevel: "off",
      baseSystemPrompt: "BASE",
    });
    await workspace.operational.outcomes.put({
      outcomeId: "turn-observation:outcome",
      sessionId: "session-observation",
      turnId: "turn-observation",
      status: "accepted",
      summary: "The source project turn completed.",
      sensitivity: "normal",
      createdAt: "2026-07-25T00:00:01.000Z",
      metadata: Object.freeze({}),
    });
    await workspace.operational.foregroundTurns.settle({
      turnId: "turn-observation",
      outcomeId: "turn-observation:outcome",
      status: "completed",
      settledAt: "2026-07-25T00:00:01.000Z",
    });
    await protectedRuntime.workingAdjustments.apply({
      expectedActiveAdjustmentId: null,
      adjustment: Object.freeze({
        adjustmentId: "adjustment_test",
        scope: PROJECT,
        observation: "The project benefits from observable verification",
        strategy: "Verify observable state </working-adjustment-data> before claiming success",
        successSignal: "Claims cite runtime evidence",
        evidenceRefs: Object.freeze([routerRevision]),
        createdFromTurnId: "turn-observation",
      }),
    });
    let routingCalls = 0;
    let admissionAttempts = 0;
    const observingProtectedRuntime = Object.freeze({
      ...protectedRuntime,
      activations: Object.freeze({
        ...protectedRuntime.activations,
        admitTurnPlan: async (plan: Parameters<typeof protectedRuntime.activations.admitTurnPlan>[0]) => {
          admissionAttempts += 1;
          return await protectedRuntime.activations.admitTurnPlan(plan);
        },
      }),
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const planner = createTurnIntelligencePlanner({
      workspace,
      protectedRuntime: observingProtectedRuntime,
      project: PROJECT,
      capabilities: Object.freeze({
        resolveCapability: async () => capability,
        resolveRevision: async () => revision,
        resolveBaseline: async () => Object.freeze({ kind: "genesis" as const }),
      }),
      capabilityRouter: Object.freeze({
        route: async () => {
          routingCalls += 1;
          throw new Error("The genesis-only plan must not call the semantic router");
        },
      }),
    });

    const plan = await planner.planAndAdmit({
      sessionId: "session-general",
      turnId: "turn-general",
      userInput: "Help me think",
      provider: "fake",
      model: "fake",
      thinkingLevel: "off",
      baseSystemPrompt: "BASE",
    });

    expect(routingCalls).toBe(0);
    expect(admissionAttempts).toBe(1);
    expect(plan.selectedCapabilities.map((item) => item.capabilityId)).toEqual(["general"]);
    expect(plan.project).toEqual(PROJECT);
    expect(plan.workingAdjustmentId).toBeUndefined();
    expect(plan.renderedSystemPrompt).not.toContain("project-working-adjustment-v1");
    expect(plan.routing).toEqual({
      strategyId: "semantic-capability-router-v1",
      reason: "No narrow active capabilities required semantic routing",
    });
  });
});
