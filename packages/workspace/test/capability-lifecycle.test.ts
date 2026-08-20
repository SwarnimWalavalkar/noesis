import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CapabilityLifecycleRevision,
  type CapabilityRevision,
  capabilityRevisionRef,
  type FileRevisionRef,
} from "@noesis/domain";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkspaceStore, type NoesisWorkspaceStore } from "../src/index.ts";

const opened: { readonly root: string; readonly workspace: NoesisWorkspaceStore }[] = [];

afterEach(async () => {
  for (const item of opened.splice(0)) {
    item.workspace.close();
    await rm(item.root, { recursive: true, force: true });
  }
});

function lifecycleRevision(
  capabilityRevisionId: string,
  prompt: FileRevisionRef,
  router: FileRevisionRef,
  predecessorRevisionId?: string,
  capabilityId = "capability_concise_research",
): CapabilityLifecycleRevision {
  const revision: CapabilityRevision = Object.freeze({
    capabilityRevisionId,
    capabilityId,
    ...(predecessorRevisionId ? { predecessorRevisionId } : {}),
    promptModules: Object.freeze([prompt]),
    skills: Object.freeze([]),
    tools: Object.freeze([]),
    toolset: Object.freeze({
      toolRevisionIds: Object.freeze([]),
      routerRevision: router,
      strategyId: "semantic-capability-router-v1",
    }),
    activationPolicy: Object.freeze({ mode: "automatic_low_risk", scope: "general" }),
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
  return Object.freeze({
    revision,
    reference: capabilityRevisionRef(revision),
    summary: `Concise research ${capabilityRevisionId}`,
    rationale: "The user asked for a more concise research style.",
    anticipatedEffect: "Research answers become shorter without losing primary evidence.",
    createdAt:
      capabilityRevisionId === "revision-1" ? "2026-08-18T00:00:00.000Z" : "2026-08-18T01:00:00.000Z",
  });
}

describe("Capability lifecycle store", () => {
  test("keeps saved program effects bound to their authoritative project", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-capability-program-scope-"));
    const workspace = await createWorkspaceStore(root);
    opened.push({ root, workspace });
    const actor = Object.freeze({ actorId: "capability-test", kind: "system" as const });
    const project = Object.freeze({ projectId: "project-a", root: "/a" });
    const materials: readonly (readonly [string, string])[] = Object.freeze([
      ["capabilities/program/instructions.md", "instructions"],
      ["capabilities/program/router.json", '{"strategy":"central"}'],
      ["workflows/evidence-synthesis/workflow.json", '{"name":"evidence-synthesis"}'],
    ]);
    const [prompt, router, workflow] = await Promise.all(
      materials.map(
        async ([workingPath, content]) =>
          await workspace.definitions.recordWorkingDefinition({
            workingPath,
            bytes: new TextEncoder().encode(content),
            actor,
            reason: "Capability program scope fixture",
            provenanceRefs: Object.freeze([]),
          }),
      ),
    );
    if (!prompt || !router || !workflow) throw new Error("Capability fixture revisions are missing");
    const base = lifecycleRevision("revision-program", prompt, router);
    const revision: CapabilityRevision = Object.freeze({
      ...base.revision,
      effects: Object.freeze([
        Object.freeze({
          kind: "workflow" as const,
          name: "evidence-synthesis",
          project,
          definitionRevision: workflow,
        }),
      ]),
    });
    const lifecycle = Object.freeze({ ...base, revision, reference: capabilityRevisionRef(revision) });
    const definition = Object.freeze({
      capabilityId: revision.capabilityId,
      name: "Evidence synthesis",
      description: "Run the saved evidence synthesis workflow.",
      applicability: "Evidence synthesis requests.",
      createdAt: base.createdAt,
    });

    await expect(
      workspace.capabilities.create({
        definition,
        revision: lifecycle,
        binding: Object.freeze({
          capabilityId: revision.capabilityId,
          revision: lifecycle.reference,
          scope: Object.freeze({ kind: "global" as const }),
          activationMode: "relevant",
          state: "active",
        }),
      }),
    ).rejects.toThrow("must remain bound to project project-a");

    const binding = await workspace.capabilities.create({
      definition,
      revision: lifecycle,
      binding: Object.freeze({
        capabilityId: revision.capabilityId,
        revision: lifecycle.reference,
        scope: Object.freeze({ kind: "project" as const, project }),
        activationMode: "relevant",
        state: "active",
      }),
    });
    await expect(
      workspace.capabilities.updateBinding({
        capabilityId: binding.capabilityId,
        expectedRevisionNumber: binding.revisionNumber,
        scope: Object.freeze({ kind: "global" as const }),
      }),
    ).rejects.toThrow("must remain bound to project project-a");
    expect(await workspace.capabilities.getBinding(binding.capabilityId)).toEqual(binding);
  });

  test("owns immutable revisions, scoped activation, feedback, gates, and CAS updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-capability-lifecycle-"));
    const workspace = await createWorkspaceStore(root);
    opened.push({ root, workspace });
    await workspace.operational.sessions.put({
      sessionId: "session-a",
      title: "Capability feedback",
      status: "idle",
      provider: "fake",
      model: "fake",
      runtime: "fake",
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    await workspace.operational.messages.put({
      messageId: "message-feedback",
      sessionId: "session-a",
      role: "user",
      content: "This is easier to scan.",
      sensitivity: "normal",
      createdAt: "2026-08-18T02:00:00.000Z",
      metadata: Object.freeze({}),
    });
    const actor = Object.freeze({ actorId: "capability-test", kind: "system" as const });
    const recordMaterial = async (revisionId: string) =>
      await Promise.all([
        workspace.definitions.recordWorkingDefinition({
          workingPath: `capabilities/${revisionId}/instructions.md`,
          bytes: new TextEncoder().encode(`instructions for ${revisionId}`),
          actor,
          reason: "Capability lifecycle test fixture",
          provenanceRefs: Object.freeze([]),
        }),
        workspace.definitions.recordWorkingDefinition({
          workingPath: `capabilities/${revisionId}/router.json`,
          bytes: new TextEncoder().encode(`{"revision":"${revisionId}"}`),
          actor,
          reason: "Capability lifecycle test fixture",
          provenanceRefs: Object.freeze([]),
        }),
      ]);
    const firstMaterial = await recordMaterial("revision-1");
    const first = lifecycleRevision("revision-1", firstMaterial[0], firstMaterial[1]);
    const binding = await workspace.capabilities.create({
      definition: Object.freeze({
        capabilityId: first.reference.capabilityId,
        name: "Concise research",
        kind: "instruction",
        description: "Answer research questions concisely.",
        applicability: "Research and source synthesis requests.",
        createdAt: first.createdAt,
      }),
      revision: first,
      binding: Object.freeze({
        capabilityId: first.reference.capabilityId,
        revision: first.reference,
        scope: Object.freeze({ kind: "global" as const }),
        activationMode: "relevant",
        state: "active",
      }),
    });

    expect(
      await workspace.capabilities.listEligibleBindings({
        project: Object.freeze({ projectId: "project-a", root: "/a" }),
        sessionId: "session-a",
      }),
    ).toEqual([binding]);

    const secondMaterial = await recordMaterial("revision-2");
    const second = lifecycleRevision(
      "revision-2",
      secondMaterial[0],
      secondMaterial[1],
      first.reference.capabilityRevisionId,
    );
    await workspace.capabilities.addRevision(second);
    const updated = await workspace.capabilities.updateBinding({
      capabilityId: binding.capabilityId,
      expectedRevisionNumber: binding.revisionNumber,
      revision: second.reference,
      scope: Object.freeze({
        kind: "project" as const,
        project: Object.freeze({ projectId: "project-a", root: "/a" }),
      }),
      activationMode: "always",
    });
    expect(updated).toMatchObject({ status: "updated", binding: { revisionNumber: 2 } });
    expect(
      await workspace.capabilities.updateBinding({
        capabilityId: binding.capabilityId,
        expectedRevisionNumber: 1,
        state: "paused",
      }),
    ).toMatchObject({ status: "stale", binding: { revisionNumber: 2 } });
    expect(
      await workspace.capabilities.listEligibleBindings({
        project: Object.freeze({ projectId: "project-b", root: "/b" }),
        sessionId: "session-b",
      }),
    ).toEqual([]);

    await workspace.capabilities.addFeedback(
      Object.freeze({
        feedbackId: "feedback-1",
        capabilityId: binding.capabilityId,
        revision: second.reference,
        evidenceRefs: Object.freeze([
          Object.freeze({
            kind: "database_row" as const,
            table: "messages" as const,
            rowId: "message-feedback",
          }),
        ]),
        interpretation: "The revised behavior is easier to scan.",
        disposition: "positive",
        createdAt: "2026-08-18T02:00:00.000Z",
      }),
    );
    await workspace.capabilities.createGate(
      Object.freeze({
        gateRequestId: "gate-1",
        capabilityId: binding.capabilityId,
        revision: second.reference,
        expectedBindingRevision: 2,
        proposedScope: Object.freeze({ kind: "global" as const }),
        proposedActivationMode: "relevant",
        consequence: "This would alter recovery control.",
        status: "pending",
        createdAt: "2026-08-18T03:00:00.000Z",
      }),
    );
    expect(await workspace.capabilities.listFeedback(binding.capabilityId)).toHaveLength(1);
    expect(await workspace.capabilities.listPendingGates()).toHaveLength(1);
    expect(
      await workspace.capabilities.decideGate({ gateRequestId: "gate-1", decision: "approve" }),
    ).toMatchObject({
      status: "updated",
      gate: { status: "approved" },
      binding: {
        revisionNumber: 3,
        scope: { kind: "global" },
        activationMode: "relevant",
      },
    });
    expect(await workspace.capabilities.listPendingGates()).toEqual([]);
    expect(await workspace.capabilities.listRevisions(binding.capabilityId)).toEqual([first, second]);

    expect(await workspace.capabilities.getDefinitions([binding.capabilityId])).toEqual([
      await workspace.capabilities.getDefinition(binding.capabilityId),
    ]);
    expect(await workspace.capabilities.getBindings([binding.capabilityId])).toEqual([
      await workspace.capabilities.getBinding(binding.capabilityId),
    ]);

    const otherMaterial = await recordMaterial("other-revision-1");
    const other = lifecycleRevision(
      "other-revision-1",
      otherMaterial[0],
      otherMaterial[1],
      undefined,
      "capability_other",
    );
    await workspace.capabilities.create({
      definition: Object.freeze({
        capabilityId: other.reference.capabilityId,
        name: "Other capability",
        kind: "instruction",
        description: "Another capability for gate isolation.",
        applicability: "Other work.",
        createdAt: other.createdAt,
      }),
      revision: other,
      binding: Object.freeze({
        capabilityId: other.reference.capabilityId,
        revision: other.reference,
        scope: Object.freeze({ kind: "global" as const }),
        activationMode: "relevant",
        state: "paused",
      }),
      gate: Object.freeze({
        gateRequestId: "other-gate",
        capabilityId: other.reference.capabilityId,
        revision: other.reference,
        expectedBindingRevision: 1,
        proposedScope: Object.freeze({ kind: "global" as const }),
        proposedActivationMode: "relevant",
        consequence: "Other consequence",
        status: "pending",
        createdAt: "2026-08-18T04:00:00.000Z",
      }),
    });

    const thirdMaterial = await recordMaterial("revision-3");
    const third = lifecycleRevision(
      "revision-3",
      thirdMaterial[0],
      thirdMaterial[1],
      second.reference.capabilityRevisionId,
    );
    await expect(
      workspace.capabilities.stageGatedRevision({
        revision: third,
        supersedeGateRequestId: "other-gate",
        gate: Object.freeze({
          gateRequestId: "gate-2",
          capabilityId: binding.capabilityId,
          revision: third.reference,
          expectedBindingRevision: 3,
          proposedScope: Object.freeze({ kind: "global" as const }),
          proposedActivationMode: "relevant",
          consequence: "A replacement must remain capability-local.",
          status: "pending",
          createdAt: "2026-08-18T05:00:00.000Z",
        }),
      }),
    ).rejects.toThrow("cannot supersede another capability's request");
    expect(await workspace.capabilities.getGate("other-gate")).toMatchObject({ status: "pending" });
    expect(await workspace.capabilities.getGate("gate-2")).toBeUndefined();

    await workspace.capabilities.createGate(
      Object.freeze({
        gateRequestId: "stale-gate",
        capabilityId: binding.capabilityId,
        revision: second.reference,
        expectedBindingRevision: 3,
        proposedScope: Object.freeze({ kind: "global" as const }),
        proposedActivationMode: "relevant",
        consequence: "This request will become stale.",
        status: "pending",
        createdAt: "2026-08-18T05:30:00.000Z",
      }),
    );
    expect(
      await workspace.capabilities.updateBinding({
        capabilityId: binding.capabilityId,
        expectedRevisionNumber: 3,
        state: "paused",
      }),
    ).toMatchObject({ status: "updated", binding: { state: "paused", revisionNumber: 4 } });
    await expect(
      workspace.capabilities.stageGatedRevision({
        revision: third,
        supersedeGateRequestId: "stale-gate",
        gate: Object.freeze({
          gateRequestId: "gate-after-stale",
          capabilityId: binding.capabilityId,
          revision: third.reference,
          expectedBindingRevision: 4,
          proposedScope: Object.freeze({ kind: "global" as const }),
          proposedActivationMode: "relevant",
          consequence: "A stale request cannot replace a newer binding.",
          status: "pending",
          createdAt: "2026-08-18T05:45:00.000Z",
        }),
      }),
    ).rejects.toThrow("cannot supersede a request for a stale binding");
    expect(await workspace.capabilities.getGate("stale-gate")).toMatchObject({ status: "pending" });
    expect(await workspace.capabilities.getGate("gate-after-stale")).toBeUndefined();
    expect(
      await workspace.capabilities.applyRevision({
        revision: third,
        feedback: Object.freeze({
          feedbackId: "feedback-2",
          capabilityId: binding.capabilityId,
          revision: second.reference,
          evidenceRefs: Object.freeze([
            Object.freeze({
              kind: "database_row" as const,
              table: "messages" as const,
              rowId: "message-feedback",
            }),
          ]),
          interpretation: "Revise the instructions without resuming the paused capability.",
          disposition: "correction",
          createdAt: "2026-08-18T06:00:00.000Z",
        }),
        expectedBindingRevision: 4,
        scope: Object.freeze({ kind: "global" as const }),
        activationMode: "relevant",
      }),
    ).toMatchObject({ status: "updated", binding: { state: "paused", revisionNumber: 5 } });
  });
});
