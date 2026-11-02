import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCapabilityDocument } from "@noesis/domain";
import { createWorkspaceStore, type NoesisWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import {
  CapabilityProposalSchema,
  capabilityWorkingDocumentPath,
  createCapabilityPublisher,
  type CapabilityDecision,
} from "../src/capability-publisher.ts";

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
              kind: "instruction",
              content: "Inspect the exact diff, trace consumers, and report only actionable findings.",
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
    const initialEffects = initial.revision.effects;
    // Every instruction draft becomes the guidance of one readable Capability file.
    expect(initialEffects.map((effect) => effect.kind)).toEqual(["instruction"]);
    const instruction = initialEffects[0];
    if (instruction?.kind !== "instruction") throw new Error("Expected an instruction effect");
    expect(capabilityWorkingDocumentPath(instruction.material)).toMatch(
      /^definitions\/capabilities\/evidence-led-review-[a-f0-9]{6}\.md$/u,
    );
    const document = new TextDecoder().decode(await workspace.reads.readRevision(instruction.material));
    const parsed = parseCapabilityDocument(document);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.content).toMatchObject({ name: "Evidence-led review" });
    expect(parsed.content.guidance).toContain("Ground review findings in exact repository evidence.");
    expect(parsed.content.guidance).toContain(
      "Inspect the exact diff, trace consumers, and report only actionable findings.",
    );
    expect(document).toContain("## Why");
    // The working file is the same document, so the user can open and edit it.
    expect(
      new TextDecoder().decode(
        await workspace.reads.readWorkingFile(capabilityWorkingDocumentPath(instruction.material)),
      ),
    ).toBe(document);

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
            description: "Review changes against direct evidence and trace consumers.",
            applicability: "Repository reviews, implementation audits, and pull request checks.",
            summary: "Widen when the review method applies.",
            rationale: "The method also helped on pull request checks.",
            anticipatedEffect: "Pull request checks also use the method.",
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
    await expect(workspace.capabilities.getDefinition("capability-foreground")).resolves.toMatchObject({
      name: "Evidence-led review",
      applicability: "Repository reviews, implementation audits, and pull request checks.",
    });

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
    expect(await workspace.capabilities.listRevisions("capability-foreground")).toHaveLength(3);
  });

  test("a global Program leaves the Capability's scope free, and a project Program pins it", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-capability-global-program-"));
    const workspace = await createWorkspaceStore(root);
    opened.push({ root, workspace });
    const actor = Object.freeze({ actorId: "foreground-capability-author", kind: "noesis" as const });
    const definitionRevision = await workspace.definitions.recordWorkingDefinition({
      workingPath: "programs/global/script/shared/program.json",
      bytes: new TextEncoder().encode('{"revision":1}\n'),
      actor,
      reason: "Global fixture",
    });
    const project = Object.freeze({ projectId: "project-global-program", root });
    const effect = (name: string) =>
      Object.freeze({
        kind: "program" as const,
        program:
          name === "shared"
            ? Object.freeze({ mode: "script" as const, name, definitionRevision })
            : Object.freeze({ mode: "script" as const, name, project, definitionRevision }),
      });
    let identity = 0;
    const publisher = createCapabilityPublisher({
      workspace,
      store: workspace.capabilities,
      programs: Object.freeze({
        list: async () => Object.freeze([]),
        resolve: async (_mode: "script" | "workflow", name: string) => effect(name),
      }),
      nextId: (prefix) => `${prefix}-${String((identity += 1))}`,
    });
    const decision = (
      name: string,
      scope?: "global" | "current_project" | "current_session",
    ): CapabilityDecision => ({
      decision: "create",
      proposal: {
        name: `Uses ${name} ${scope ?? "default"}`,
        description: "Run the saved script.",
        applicability: "Saved script work.",
        summary: "Attach a saved script.",
        rationale: "The turn showed it helps.",
        anticipatedEffect: "The script is available.",
        effects: [{ kind: "program", mode: "script", name }],
        scope,
        consequence: "ordinary",
        consequenceDescription: "This references a reversible saved program.",
      },
    });
    const context = Object.freeze({
      project,
      sessionId: "session-global-program",
      evidenceRefs: Object.freeze([definitionRevision]),
      actor,
    });
    const signal = new AbortController().signal;
    const scopeOf = async (result: Awaited<ReturnType<typeof publisher.publish>>) => {
      if (result.status !== "activated") throw new Error(`Expected activation, got ${result.status}`);
      return (await workspace.capabilities.getBinding(result.capabilityId))?.scope;
    };

    expect(await scopeOf(await publisher.publish(decision("shared"), context, signal))).toEqual({
      kind: "global",
    });
    expect(await scopeOf(await publisher.publish(decision("shared", "global"), context, signal))).toEqual({
      kind: "global",
    });
    expect(
      await scopeOf(await publisher.publish(decision("shared", "current_session"), context, signal)),
    ).toEqual({ kind: "session", sessionId: "session-global-program" });
    expect(await scopeOf(await publisher.publish(decision("local"), context, signal))).toEqual({
      kind: "project",
      project,
    });
    await expect(publisher.publish(decision("local", "global"), context, signal)).rejects.toThrow(
      /requires current-project scope/u,
    );

    // A later binding change obeys the same rule.
    const local = await publisher.publish(decision("local", "current_project"), context, signal);
    if (local.status !== "activated") throw new Error("Expected activation");
    await expect(
      publisher.publish(
        {
          decision: "change_binding",
          capabilityId: local.capabilityId,
          expectedBindingRevision: 1,
          scope: "global",
          activationMode: "relevant",
          reason: "Try it everywhere.",
        },
        context,
        signal,
      ),
    ).rejects.toThrow(/must remain bound to project/u);
    await expect(
      publisher.promoteProgram(
        { mode: "script", name: "local", reason: "No library in this fixture." },
        context,
        signal,
      ),
    ).rejects.toThrow(/no Program library/u);
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
    expect(lifecycle.revision.effects).toMatchObject([
      { kind: "instruction" },
      {
        kind: "program",
        program: { mode: "script", name: "pinned-script", definitionRevision: frozenDefinition },
      },
    ]);
  });
});
