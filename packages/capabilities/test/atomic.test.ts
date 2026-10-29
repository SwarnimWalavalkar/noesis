import { createConditionalObject } from "@noesis/domain";
import type {
  Capability,
  CapabilityActivationReadModel,
  capabilityRevisionRef,
  FileRevisionRef,
} from "@noesis/domain";
import { createWorkspaceStore } from "@noesis/workspace";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type CapabilityRevisionConstruction,
  createAtomicCapabilityRegistry,
  createInMemoryCapabilityControlStore,
  createWorkspaceCapabilityControlStore,
} from "../src/index.ts";
const capability: Capability = {
  capabilityId: "source-research",
  name: "Source research",
  scope: "research",
  intent: "Find and cite primary evidence",
};
const fileRef = (name: string, byte: string): FileRevisionRef => ({
  kind: "file_revision",
  revisionId: name,
  workingPath: `definitions/candidates/${name}`,
  snapshotPath: `revisions/${name}`,
  contentDigest: byte.repeat(64),
});
// SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
const construction = (
  capabilityRevisionId: string,
  bytes: {
    readonly prompt: string;
    readonly tool: string;
    readonly router: string;
  },
  predecessorRevisionId?: string,
): CapabilityRevisionConstruction =>
  createConditionalObject({
    definitionState: "candidate",
    capabilityRevisionId,
    capabilityId: capability.capabilityId,
  } as const)
    .addOptional(predecessorRevisionId ? { predecessorRevisionId } : undefined)
    .add({
      promptModules: [fileRef("prompt.md", bytes.prompt)],
      skills: [fileRef("skill.md", "b")],
      tools: [fileRef("tool.mjs", bytes.tool)],
      routerRevision: fileRef("router.json", bytes.router),
      routerStrategyId: "research-router",
      activationPolicy: { mode: "automatic_low_risk", scope: "research" },
      permissionManifest: { effects: ["read"], resourcePatterns: ["workspace:"], credentialRefs: [] },
      evidenceRefs: [],
      sourceEvaluationDefinitions: [fileRef("eval.json", "e")],
      requestedPermissionDelta: { addedEffects: [], widenedResources: [], addedCredentialRefs: [] },
    } as const)
    .finish();
describe("atomic capability registry", () => {
  test("binds every coupled prompt, tool, and router byte into revision identity", () => {
    const byteVariants: readonly {
      readonly prompt: string;
      readonly tool: string;
      readonly router: string;
    }[] = [
      { prompt: "1", tool: "2", router: "3" },
      { prompt: "4", tool: "2", router: "3" },
      { prompt: "1", tool: "4", router: "3" },
      { prompt: "1", tool: "2", router: "4" },
    ];
    const refs = byteVariants.map((bytes) => {
      const registry = createAtomicCapabilityRegistry();
      registry.registerCapability(capability);
      return registry.constructRevision(construction("revision-1", bytes));
    });
    expect(new Set(refs.map((ref) => ref.bundleDigest)).size).toBe(byteVariants.length);
  });
  test("preserves predecessor lineage and rejects cross-capability predecessors", () => {
    const registry = createAtomicCapabilityRegistry({ controlStore: createInMemoryCapabilityControlStore() });
    registry.registerCapability(capability);
    const first = registry.constructRevision(
      construction("revision-1", { prompt: "1", tool: "2", router: "3" }),
    );
    const second = registry.constructRevision(
      construction("revision-2", { prompt: "4", tool: "2", router: "3" }, first.capabilityRevisionId),
    );
    expect(registry.getRevision(second)?.predecessorRevisionId).toBe(first.capabilityRevisionId);
    expect(registry.listRevisionLineage(capability.capabilityId)).toEqual([first, second]);
    expect(() =>
      registry.constructRevision(
        construction("revision-3", { prompt: "5", tool: "2", router: "3" }, "missing"),
      ),
    ).toThrow("predecessor");
  });
  test("freezes the recorded revision bundle and rejects identity reuse", () => {
    const registry = createAtomicCapabilityRegistry();
    registry.registerCapability(capability);
    const ref = registry.constructRevision(
      construction("revision-1", { prompt: "1", tool: "2", router: "3" }),
    );
    const revision = registry.getRevision(ref);
    expect(Object.isFrozen(revision)).toBe(true);
    expect(Object.isFrozen(revision?.promptModules)).toBe(true);
    expect(Object.isFrozen(revision?.promptModules[0])).toBe(true);
    expect(Object.isFrozen(revision?.toolset)).toBe(true);
    expect(Object.isFrozen(revision?.toolset.routerRevision)).toBe(true);
    expect(Object.isFrozen(revision?.permissionManifest.effects)).toBe(true);
    expect(Object.isFrozen(revision?.requestedPermissionDelta)).toBe(true);
    expect(() =>
      registry.constructRevision(construction("revision-1", { prompt: "9", tool: "2", router: "3" })),
    ).toThrow("identity collision");
  });
  test("keeps candidate definitions separate from externally owned active state", async () => {
    let externallyActive: ReturnType<typeof capabilityRevisionRef> | null = null;
    const registry = createAtomicCapabilityRegistry({
      activationReader: {
        read: async (stableCapability): Promise<CapabilityActivationReadModel> => ({
          capability: stableCapability,
          activeRevision: externallyActive,
          activationPointer: externallyActive
            ? { kind: "database_row", table: "activation_pointers", rowId: "active-1" }
            : null,
        }),
      },
    });
    registry.registerCapability(capability);
    const candidate = registry.constructRevision(
      construction("revision-1", { prompt: "1", tool: "2", router: "3" }),
    );
    const before = await registry.read(capability.capabilityId);
    expect(before?.candidateRevisions[0]?.definitionState).toBe("candidate");
    expect(before?.activation.activeRevision).toBeNull();
    externallyActive = candidate;
    const after = await registry.read(capability.capabilityId);
    expect(after?.candidateRevisions[0]?.definitionState).toBe("candidate");
    expect(after?.activation.activeRevision).toEqual(candidate);
    expect("activate" in registry).toBe(false);
  });
  test("tracks pin and predecessor-rooted veto metadata without mutating activation", async () => {
    const registry = createAtomicCapabilityRegistry({
      controlStore: createInMemoryCapabilityControlStore(),
    });
    registry.registerCapability(capability);
    const first = registry.constructRevision(
      construction("revision-1", { prompt: "1", tool: "2", router: "3" }),
    );
    registry.constructRevision(
      construction("revision-2", { prompt: "4", tool: "2", router: "3" }, first.capabilityRevisionId),
    );
    await registry.pin({ capabilityId: capability.capabilityId, revision: first, reason: "user pin" });
    await registry.veto({
      capabilityId: capability.capabilityId,
      rootRevision: first,
      reason: "user veto",
    });
    const readModel = await registry.read(capability.capabilityId);
    expect(readModel?.candidateRevisions.map(({ pinned, vetoed }) => ({ pinned, vetoed }))).toEqual([
      { pinned: true, vetoed: true },
      { pinned: false, vetoed: true },
    ]);
    expect(readModel?.controls).toEqual({
      capabilityId: capability.capabilityId,
      pin: { capabilityId: capability.capabilityId, revision: first, reason: "user pin" },
      vetoes: [{ capabilityId: capability.capabilityId, rootRevision: first, reason: "user veto" }],
    });
    expect("activate" in ((await registry.readControls(capability.capabilityId)) ?? {})).toBe(false);
  });
  test("binds pin and veto controls to the canonical capability revision digest", async () => {
    const registry = createAtomicCapabilityRegistry({ controlStore: createInMemoryCapabilityControlStore() });
    registry.registerCapability(capability);
    const revision = registry.constructRevision(
      construction("revision-1", { prompt: "1", tool: "2", router: "3" }),
    );
    const digestMismatch = { ...revision, bundleDigest: "f".repeat(64) };
    expect(
      await registry.pin({
        capabilityId: capability.capabilityId,
        revision: digestMismatch,
        reason: "bad pin",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_control" } });
    expect(
      await registry.veto({
        capabilityId: capability.capabilityId,
        rootRevision: digestMismatch,
        reason: "bad veto",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_control" } });
    expect(await registry.readControls(capability.capabilityId)).toEqual({
      capabilityId: capability.capabilityId,
      pin: null,
      vetoes: [],
    });
  });
  test("reloads canonical-file pin and veto controls through WorkspaceStore revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-capability-controls-"));
    try {
      const firstWorkspace = await createWorkspaceStore(root);
      const firstRegistry = createAtomicCapabilityRegistry({
        controlStore: createWorkspaceCapabilityControlStore(firstWorkspace),
      });
      firstRegistry.registerCapability(capability);
      const firstRevision = firstRegistry.constructRevision(
        construction("revision-1", { prompt: "1", tool: "2", router: "3" }),
      );
      await expect(
        firstRegistry.pin({
          capabilityId: capability.capabilityId,
          revision: firstRevision,
          reason: "durable user pin",
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        firstRegistry.veto({
          capabilityId: capability.capabilityId,
          rootRevision: firstRevision,
          reason: "durable lineage veto",
        }),
      ).resolves.toMatchObject({ ok: true });
      firstWorkspace.close();
      const secondWorkspace = await createWorkspaceStore(root);
      const secondRegistry = createAtomicCapabilityRegistry({
        controlStore: createWorkspaceCapabilityControlStore(secondWorkspace),
      });
      secondRegistry.registerCapability(capability);
      secondRegistry.constructRevision(construction("revision-1", { prompt: "1", tool: "2", router: "3" }));
      expect(await secondRegistry.readControls(capability.capabilityId)).toEqual({
        capabilityId: capability.capabilityId,
        pin: {
          capabilityId: capability.capabilityId,
          revision: firstRevision,
          reason: "durable user pin",
        },
        vetoes: [
          {
            capabilityId: capability.capabilityId,
            rootRevision: firstRevision,
            reason: "durable lineage veto",
          },
        ],
      });
      expect(
        await secondWorkspace.definitionMetadata.listRevisions("capability_control", capability.capabilityId),
      ).toHaveLength(2);
      secondWorkspace.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
