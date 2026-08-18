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

function fileRevision(name: string, byte: string): FileRevisionRef {
  return Object.freeze({
    kind: "file_revision",
    revisionId: name,
    workingPath: `capabilities/${name}`,
    snapshotPath: `revisions/${name}`,
    contentDigest: byte.repeat(64),
  });
}

function lifecycleRevision(
  capabilityRevisionId: string,
  predecessorRevisionId?: string,
): CapabilityLifecycleRevision {
  const capabilityId = "capability_concise_research";
  const revision: CapabilityRevision = Object.freeze({
    capabilityRevisionId,
    capabilityId,
    ...(predecessorRevisionId ? { predecessorRevisionId } : {}),
    promptModules: Object.freeze([fileRevision(`${capabilityRevisionId}-prompt`, "a")]),
    skills: Object.freeze([]),
    tools: Object.freeze([]),
    toolset: Object.freeze({
      toolRevisionIds: Object.freeze([]),
      routerRevision: fileRevision(`${capabilityRevisionId}-router`, "b"),
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
    const first = lifecycleRevision("revision-1");
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

    const second = lifecycleRevision("revision-2", first.reference.capabilityRevisionId);
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
        consequence: "This would alter recovery control.",
        status: "pending",
        createdAt: "2026-08-18T03:00:00.000Z",
      }),
    );
    expect(await workspace.capabilities.listFeedback(binding.capabilityId)).toHaveLength(1);
    expect(await workspace.capabilities.listPendingGates()).toHaveLength(1);
    await workspace.capabilities.settleGate({ gateRequestId: "gate-1", status: "denied" });
    expect(await workspace.capabilities.listPendingGates()).toEqual([]);
    expect(await workspace.capabilities.listRevisions(binding.capabilityId)).toEqual([first, second]);
  });
});
