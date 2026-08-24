import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityEffects, createAtomicCapabilityRegistry } from "@noesis/capabilities";
import { createWorkspaceStore, type NoesisWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import { CapabilityProposalSchema, createCapabilityPublisher } from "../src/capability-publisher.ts";

const opened: { readonly root: string; readonly workspace: NoesisWorkspaceStore }[] = [];

afterEach(async () => {
  for (const item of opened.splice(0)) {
    item.workspace.close();
    await rm(item.root, { recursive: true, force: true });
  }
});

describe("Capability publisher", () => {
  test("rejects more than one Program attachment in a Capability proposal", () => {
    const parsed = CapabilityProposalSchema.safeParse({
      name: "Ambiguous program bundle",
      description: "Attempts to attach two Programs.",
      applicability: "Never valid.",
      summary: "Two Programs.",
      rationale: "Exercise the typed boundary.",
      anticipatedEffect: "Rejected before publication.",
      effects: [
        { kind: "program", mode: "script", name: "first" },
        { kind: "program", mode: "workflow", name: "second" },
      ],
      consequence: "ordinary",
      consequenceDescription: "No protected consequence.",
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toContain("at most one Program");
  });

  test("publishes exact foreground decisions and rejects a stale successor without authoring it", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-capability-publisher-"));
    const workspace = await createWorkspaceStore(root);
    opened.push({ root, workspace });
    await workspace.operational.sessions.put({
      sessionId: "session-foreground",
      title: "Foreground refinement",
      status: "idle",
      provider: "controlled",
      model: "controlled",
      runtime: "controlled",
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    await workspace.operational.messages.put({
      messageId: "turn-foreground:user",
      sessionId: "session-foreground",
      role: "user",
      content: "Preserve this review method for future work.",
      sensitivity: "normal",
      createdAt: "2026-08-24T00:00:00.000Z",
      metadata: Object.freeze({ turnId: "turn-foreground" }),
    });
    let revision = 0;
    let feedback = 0;
    const publisher = createCapabilityPublisher({
      workspace,
      store: workspace.capabilities,
      registry: createAtomicCapabilityRegistry(),
      now: () => "2026-08-24T00:01:00.000Z",
      nextId: (prefix) => {
        if (prefix === "capability") return "capability-foreground";
        if (prefix === "capability_revision") {
          revision += 1;
          return `capability-foreground-r${String(revision)}`;
        }
        if (prefix === "capability_feedback") {
          feedback += 1;
          return `capability-foreground-feedback-${String(feedback)}`;
        }
        return `${prefix}-foreground`;
      },
    });
    const context = Object.freeze({
      project: Object.freeze({ projectId: "project-foreground", root }),
      sessionId: "session-foreground",
      evidenceRefs: Object.freeze([
        Object.freeze({
          kind: "database_row" as const,
          table: "messages" as const,
          rowId: "turn-foreground:user",
        }),
      ]),
      actor: Object.freeze({ actorId: "foreground-capability-author", kind: "noesis" as const }),
    });
    const createResult = await publisher.publish(
      {
        decision: "create",
        proposal: {
          name: "Evidence-led review",
          description: "Review changes against direct evidence before recommending action.",
          applicability: "Repository reviews and implementation audits.",
          summary: "Add an evidence-led review method.",
          rationale: "The user explicitly asked to preserve the method.",
          anticipatedEffect: "Future reviews distinguish verified facts from inference.",
          effects: [
            { kind: "instruction", content: "Ground review findings in exact repository evidence." },
            {
              kind: "skill",
              name: "evidence-led-review",
              description: "Perform a bounded evidence-led review.",
              instructions: "Inspect the exact diff, trace consumers, and report only actionable findings.",
            },
          ],
          consequence: "ordinary",
          consequenceDescription: "This changes only reversible agent guidance.",
        },
      },
      context,
      new AbortController().signal,
    );

    expect(createResult).toEqual({
      status: "activated",
      capabilityId: "capability-foreground",
      message: "Add an evidence-led review method.",
    });
    const initialBinding = await workspace.capabilities.getBinding("capability-foreground");
    expect(initialBinding).toMatchObject({
      scope: { kind: "global" },
      activationMode: "relevant",
      state: "active",
      revisionNumber: 1,
    });
    if (!initialBinding) throw new Error("Expected a foreground Capability binding");
    const initial = await workspace.capabilities.getRevision(initialBinding.revision);
    if (!initial) throw new Error("Expected the exact foreground Capability revision");
    const initialEffects = capabilityEffects(initial.revision);
    expect(initialEffects.map((effect) => effect.kind)).toEqual(["instruction", "skill"]);
    const instruction = initialEffects[0];
    if (instruction?.kind !== "instruction") throw new Error("Expected an instruction effect");
    expect(new TextDecoder().decode(await workspace.reads.readRevision(instruction.material))).toBe(
      "Ground review findings in exact repository evidence.\n",
    );

    await expect(
      publisher.publish(
        {
          decision: "revise",
          capabilityId: "capability-foreground",
          expectedBindingRevision: 1,
          proposal: {
            name: "Evidence-led review",
            description: "Review changes against direct evidence before recommending action.",
            applicability: "Repository reviews and implementation audits.",
            summary: "Require consumer tracing.",
            rationale: "The live collaboration identified a missing consumer check.",
            anticipatedEffect: "Reviews catch integration defects instead of isolated type defects.",
            effects: [
              {
                kind: "instruction",
                content: "Ground review findings in exact evidence and trace every changed consumer.",
              },
            ],
            consequence: "ordinary",
            consequenceDescription: "This changes only reversible agent guidance.",
          },
        },
        context,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "revised", capabilityId: "capability-foreground" });

    await expect(
      publisher.publish(
        {
          decision: "revise",
          capabilityId: "capability-foreground",
          expectedBindingRevision: 2,
          proposal: {
            name: "Evidence-led review",
            description: "Silently changed definition metadata.",
            applicability: "Repository reviews and implementation audits.",
            summary: "Attempt to change stable metadata.",
            rationale: "The revision boundary must reject this mismatch.",
            anticipatedEffect: "No revision should be authored.",
            effects: [{ kind: "instruction", content: "Unreachable content." }],
            consequence: "ordinary",
            consequenceDescription: "This must remain unapplied.",
          },
        },
        context,
        new AbortController().signal,
      ),
    ).rejects.toThrow("definition fields are immutable");

    await expect(
      publisher.publish(
        {
          decision: "revise",
          capabilityId: "capability-foreground",
          expectedBindingRevision: 1,
          proposal: {
            name: "Evidence-led review",
            description: "Stale overwrite.",
            applicability: "Any task.",
            summary: "Overwrite newer state.",
            rationale: "This decision used an old binding.",
            anticipatedEffect: "It must not apply.",
            effects: [{ kind: "instruction", content: "Stale content." }],
            consequence: "ordinary",
            consequenceDescription: "This must remain unapplied.",
          },
        },
        context,
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      status: "stale",
      capabilityId: "capability-foreground",
      message: "Capability changed concurrently",
    });
    expect(await workspace.capabilities.listRevisions("capability-foreground")).toHaveLength(2);
  });

  test("uses the foreground turn's exact saved-program resolver instead of the live library", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-capability-program-pin-"));
    const workspace = await createWorkspaceStore(root);
    opened.push({ root, workspace });
    const actor = Object.freeze({ actorId: "foreground-capability-author", kind: "noesis" as const });
    const [frozenDefinition, liveDefinition] = await Promise.all([
      workspace.definitions.recordWorkingDefinition({
        workingPath: "programs/projects/project-program-pin/script/pinned/script-v1.json",
        bytes: new TextEncoder().encode('{"revision":1}\n'),
        actor,
        reason: "Frozen turn fixture",
      }),
      workspace.definitions.recordWorkingDefinition({
        workingPath: "programs/projects/project-program-pin/script/pinned/script-v2.json",
        bytes: new TextEncoder().encode('{"revision":2}\n'),
        actor,
        reason: "Concurrent live fixture",
      }),
    ]);
    const project = Object.freeze({ projectId: "project-program-pin", root });
    const effect = (definitionRevision: typeof frozenDefinition) =>
      Object.freeze({
        kind: "program" as const,
        program: Object.freeze({
          mode: "script" as const,
          name: "pinned-script",
          project,
          definitionRevision,
        }),
      });
    const publisher = createCapabilityPublisher({
      workspace,
      store: workspace.capabilities,
      registry: createAtomicCapabilityRegistry(),
      programs: Object.freeze({
        list: async () => Object.freeze([]),
        resolve: async () => effect(liveDefinition),
      }),
      nextId: (prefix) => `${prefix}-program-pin`,
    });
    const result = await publisher.publish(
      {
        decision: "create",
        proposal: {
          name: "Pinned program",
          description: "Run the exact script revision visible to this turn.",
          applicability: "Pinned program work.",
          summary: "Attach a frozen script.",
          rationale: "The foreground turn selected this exact revision.",
          anticipatedEffect: "Concurrent edits cannot alter the published behavior.",
          effects: [{ kind: "program", mode: "script", name: "pinned-script" }],
          consequence: "ordinary",
          consequenceDescription: "This references a reversible saved program.",
        },
      },
      {
        project,
        sessionId: "session-program-pin",
        evidenceRefs: Object.freeze([frozenDefinition]),
        actor,
        programResolver: Object.freeze({ resolve: async () => effect(frozenDefinition) }),
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ status: "activated" });
    if (result.status !== "activated") throw new Error("Expected a pinned Capability activation");
    const binding = await workspace.capabilities.getBinding(result.capabilityId);
    if (!binding) throw new Error("Expected a pinned Capability binding");
    const lifecycle = await workspace.capabilities.getRevision(binding.revision);
    if (!lifecycle) throw new Error("Expected a pinned Capability revision");
    expect(capabilityEffects(lifecycle.revision)).toMatchObject([
      {
        kind: "program",
        program: { mode: "script", name: "pinned-script", definitionRevision: frozenDefinition },
      },
    ]);
  });
});
