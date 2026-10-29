import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CapabilityRevision, capabilityRevisionRef, type FileRevisionRef, sha256 } from "@noesis/domain";
import { createWorkspaceStore, type NoesisWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkspaceRuntimeInternals } from "../../workspace/src/protected-runtime.ts";
import { createTurnIntelligencePlanner } from "../src/index.ts";

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
  test("admits exact immutable material and lists a relevant Capability for the model to load", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-turn-plan-"));
    const workspace = await createWorkspaceStore(root);
    const protectedRuntime = createWorkspaceRuntimeInternals(workspace).protectedRuntime;
    homes.push({ root, workspace });
    const makeRevision = async (capabilityId: string, promptContent: string): Promise<CapabilityRevision> => {
      const prompt = await definition(
        workspace,
        `${capabilityId}-prompt`,
        `capabilities/${capabilityId}.md`,
        promptContent,
      );
      return Object.freeze({
        capabilityRevisionId: `${capabilityId}-v1`,
        capabilityId,
        effects: Object.freeze([Object.freeze({ kind: "instruction" as const, material: prompt })]),
        evidenceRefs: Object.freeze([]),
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
      const revision = await makeRevision(capability.capabilityId, prompt);
      const reference = capabilityRevisionRef(revision);
      // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
      await workspace.capabilities.create({
        definition: Object.freeze({
          capabilityId: capability.capabilityId,
          name: capability.name,
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
          activationMode: capability.capabilityId === "general" ? "always" : "relevant",
          state: "active",
        }),
      });
    }
    const planner = createTurnIntelligencePlanner({
      workspace,
      protectedRuntime,
      project: PROJECT,
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
    await workspace.operational.sessions.put({
      sessionId: "session-unrelated",
      title: "Unrelated routing fixture",
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
    expect(related.selectedCapabilities.map((item) => item.delivery)).toEqual(["prompt", "on_demand"]);
    // The model loads an on-demand Capability as a skill, so its text stays out of the prompt.
    expect(related.renderedSystemPrompt).toContain("GENERAL PROMPT");
    expect(related.renderedSystemPrompt).not.toContain("NARROW RESEARCH PROMPT");
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
    expect(await protectedRuntime.turnPlans.get("session-related", "turn-related")).toEqual(related);

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
    expect(await protectedRuntime.turnPlans.get("session-related", "turn-tampered-history")).toBeUndefined();

    const unrelated = await planner.planAndAdmit({
      sessionId: "session-unrelated",
      turnId: "turn-unrelated",
      userInput: "Explain monads with a tiny example",
      provider: "fake",
      model: "fake",
      thinkingLevel: "off",
      baseSystemPrompt: "BASE",
    });
    // Every turn lists the same relevant Capability. The model decides whether to load it.
    expect(unrelated.selectedCapabilities.map((item) => item.capabilityId)).toEqual([
      "general",
      "research-brief",
    ]);
    expect(unrelated.renderedSystemPrompt).not.toContain("NARROW RESEARCH PROMPT");
  });

  test("admits a turn once without any Capability in the prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-turn-plan-general-"));
    const workspace = await createWorkspaceStore(root);
    const protectedRuntime = createWorkspaceRuntimeInternals(workspace).protectedRuntime;
    homes.push({ root, workspace });
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
    await workspace.operational.sessions.put(session("session-general"));
    let admissionAttempts = 0;
    const observingProtectedRuntime = Object.freeze({
      ...protectedRuntime,
      turnPlans: Object.freeze({
        ...protectedRuntime.turnPlans,
        admit: async (plan: Parameters<typeof protectedRuntime.turnPlans.admit>[0]) => {
          admissionAttempts += 1;
          return await protectedRuntime.turnPlans.admit(plan);
        },
      }),
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const planner = createTurnIntelligencePlanner({
      workspace,
      protectedRuntime: observingProtectedRuntime,
      project: PROJECT,
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

    expect(admissionAttempts).toBe(1);
    expect(plan.selectedCapabilities).toEqual([]);
    expect(plan.project).toEqual(PROJECT);
    expect(plan.renderedSystemPrompt).toBe("BASE");
    expect(await protectedRuntime.turnPlans.admit(plan)).toEqual(plan);
  });
});
