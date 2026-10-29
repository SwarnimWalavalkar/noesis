import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceRef, FileRevisionRef, ProjectRef } from "@noesis/domain";
import { learnedCapabilitySkillName, sha256 } from "@noesis/domain";
import type { HistoryPort } from "@noesis/intelligence";
import { createWorkspaceStore, type NoesisWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import { type CapabilityProgramLibrary, createCapabilityLearningModule } from "../src/capability-loop.ts";
import { createCapabilityPublisher } from "../src/capability-publisher.ts";
import { createScriptedLearningInferencePort } from "./support/scripted-learning-inference.ts";

const opened: { readonly root: string; readonly workspace: NoesisWorkspaceStore }[] = [];

afterEach(async () => {
  for (const item of opened.splice(0)) {
    item.workspace.close();
    await rm(item.root, { recursive: true, force: true });
  }
});

const promptRevision: FileRevisionRef = Object.freeze({
  kind: "file_revision",
  revisionId: "reflector-prompt",
  workingPath: "prompts/control-plane/reflector.md",
  snapshotPath: "revisions/reflector-prompt",
  contentDigest: sha256("reflector"),
});

const emptyHistory: Pick<HistoryPort, "search"> = Object.freeze({
  search: async (request) =>
    Object.freeze({
      query: request.query,
      hits: Object.freeze([]),
      candidateCount: 0,
      appliedBounds: Object.freeze({
        lexicalLimit: 0,
        semanticLimit: 0,
        rerankLimit: 0,
        resultLimit: request.limit ?? 8,
        maxExcerptChars: request.maxExcerptChars ?? 800,
      }),
    }),
});

describe("Capability learning loop", () => {
  test("does not reflect on a turn that failed before the model produced output", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-capability-loop-skip-"));
    const workspace = await createWorkspaceStore(root);
    opened.push({ root, workspace });
    const inference = createScriptedLearningInferencePort({ steps: [] });
    const module = createCapabilityLearningModule({
      workspace,
      store: workspace.capabilities,
      history: emptyHistory,
      inference,
      reflector: Object.freeze({
        variant: Object.freeze({
          variantId: "reflector-v1",
          axis: "role" as const,
          configurationRefs: Object.freeze([promptRevision]),
        }),
        promptRevision,
        model: "fake",
        reasoning: "off" as const,
      }),
    });
    const project: ProjectRef = Object.freeze({ projectId: "project-skip", root });
    await expect(
      module.reflectSettledTurn(
        Object.freeze({
          turn: Object.freeze({
            sessionId: "session-skip",
            turnId: "turn-provider-error",
            userMessage: "hey hey",
            outcome: "failed",
            cause: "failed_before_output",
            scope: "global",
            sensitivity: "normal",
            occurredAt: "2026-10-28T14:56:48.000Z",
            evidenceRefs: [
              Object.freeze({
                kind: "database_row" as const,
                table: "messages" as const,
                rowId: "turn-provider-error:user",
              }),
            ],
            telemetry: Object.freeze({ retryCount: 0, toolFailureCount: 0, aborted: false }),
          }),
          project,
          selectedCapabilities: [],
          promptCapabilityIds: [],
        }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "no_change" });
    expect(inference.requests()).toHaveLength(0);
  });

  test("creates a global relevant capability directly from one evidenced reflection", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-capability-loop-"));
    const workspace = await createWorkspaceStore(root);
    opened.push({ root, workspace });
    await workspace.operational.sessions.put({
      sessionId: "session-1",
      title: "Capability reflection",
      status: "idle",
      provider: "fake",
      model: "fake",
      runtime: "fake",
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    await workspace.operational.messages.put({
      messageId: "turn-1:user",
      sessionId: "session-1",
      role: "user",
      content: "Keep future research answers concise.",
      sensitivity: "normal",
      createdAt: "2026-08-18T00:00:00.000Z",
      metadata: Object.freeze({ turnId: "turn-1" }),
    });
    await workspace.operational.messages.put({
      messageId: "turn-1:assistant:1",
      sessionId: "session-1",
      role: "assistant",
      content: "I kept the research summary concise and cited the primary source.",
      sensitivity: "normal",
      createdAt: "2026-08-18T00:00:01.000Z",
      metadata: Object.freeze({ turnId: "turn-1" }),
    });
    await workspace.operational.toolCalls.put({
      toolCallId: "turn-1:tool:1",
      sessionId: "session-1",
      toolName: "web.search",
      request: Object.freeze({ query: "primary source" }),
      response: Object.freeze({ result: "official documentation" }),
      status: "completed",
      sensitivity: "normal",
      createdAt: "2026-08-18T00:00:00.500Z",
      completedAt: "2026-08-18T00:00:00.750Z",
    });
    await workspace.operational.messages.put({
      messageId: "turn-2:user",
      sessionId: "session-1",
      role: "user",
      content: "Teach recovery behavior, but do not apply it before I approve it.",
      sensitivity: "normal",
      createdAt: "2026-08-18T00:30:00.000Z",
      metadata: Object.freeze({ turnId: "turn-2" }),
    });
    const inference = createScriptedLearningInferencePort({
      steps: [
        Object.freeze({
          role: "reflector",
          value: Object.freeze({
            decision: "create",
            proposal: Object.freeze({
              name: "Concise research",
              description: "Keep research answers concise without dropping primary evidence.",
              applicability: "Research and source-synthesis requests.",
              summary: "Prefer concise, evidence-dense research answers.",
              rationale: "The user explicitly asked for concise future research answers.",
              anticipatedEffect: "Research responses become easier to scan.",
              effects: Object.freeze([
                Object.freeze({
                  kind: "instruction",
                  content: "Prefer concise synthesis.",
                }),
                Object.freeze({
                  kind: "instruction",
                  content: "Load primary evidence, retain exact citations, then compress the prose.",
                }),
              ]),
              scope: "global",
              activationMode: "relevant",
              consequence: "ordinary",
              consequenceDescription: "Only model instructions change.",
              evidence: Object.freeze({
                kind: "explicit_request",
                quote: "The user asked for this behavior in future work.",
                wouldOtherwise: "The user would have to repeat the request in later sessions.",
              }),
              evidenceCitationIndexes: Object.freeze([0, 1, 2]),
            }),
          }),
        }),
        Object.freeze({
          role: "reflector",
          value: Object.freeze({
            decision: "revise",
            capabilityId: "capability-1",
            proposal: Object.freeze({
              name: "Concise research",
              description: "Keep research answers concise without dropping primary evidence.",
              applicability: "Research and source-synthesis requests.",
              summary: "Add explicit recovery guidance.",
              rationale: "The user requested a recovery rule that requires approval.",
              anticipatedEffect: "Recovery remains deliberate.",
              effects: Object.freeze([
                Object.freeze({
                  kind: "instruction",
                  content: "Prefer concise synthesis and explain recovery before acting.",
                }),
              ]),
              scope: "global",
              activationMode: "relevant",
              consequence: "recovery_control",
              consequenceDescription: "This changes recovery control behavior.",
              evidence: Object.freeze({
                kind: "explicit_request",
                quote: "The user asked for this behavior in future work.",
                wouldOtherwise: "The user would have to repeat the request in later sessions.",
              }),
              evidenceCitationIndexes: Object.freeze([0]),
            }),
          }),
        }),
        Object.freeze({
          role: "reflector",
          value: Object.freeze({
            summary: "Keep recovery manual and explain the fallback.",
            rationale: "The user amended the pending recovery Capability.",
            anticipatedEffect: "Recovery remains explicit and understandable.",
            effects: Object.freeze([
              Object.freeze({
                kind: "instruction",
                content: "Never recover automatically. Explain the fallback before acting.",
              }),
            ]),
            consequence: "recovery_control",
            consequenceDescription: "This changes recovery control behavior.",
          }),
        }),
      ],
    });
    let revisionSequence = 0;
    let gateSequence = 0;
    let feedbackSequence = 0;
    const module = createCapabilityLearningModule({
      workspace,
      store: workspace.capabilities,
      history: emptyHistory,
      inference,
      reflector: Object.freeze({
        variant: Object.freeze({
          variantId: "reflector-v1",
          axis: "role",
          configurationRefs: Object.freeze([promptRevision]),
        }),
        promptRevision,
        model: "controlled",
        reasoning: "high",
      }),
      now: () => "2026-08-18T01:00:00.000Z",
      nextId: (prefix) => {
        if (prefix === "capability") return "capability-1";
        if (prefix === "capability_revision") {
          revisionSequence += 1;
          return `revision-${String(revisionSequence)}`;
        }
        if (prefix === "capability_gate") {
          gateSequence += 1;
          return `gate-${String(gateSequence)}`;
        }
        if (prefix === "capability_feedback") {
          feedbackSequence += 1;
          return `feedback-${String(feedbackSequence)}`;
        }
        return `${prefix}-1`;
      },
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const result = await module.reflectSettledTurn(
      Object.freeze({
        turn: Object.freeze({
          sessionId: "session-1",
          turnId: "turn-1",
          userMessage: "Keep future research answers concise.",
          assistantMessage: "Understood.",
          outcome: "accepted",
          scope: "general",
          sensitivity: "normal",
          evidenceRefs: [
            Object.freeze({
              kind: "database_row" as const,
              table: "messages" as const,
              rowId: "turn-1:user",
            }),
            Object.freeze({
              kind: "database_row" as const,
              table: "tool_calls" as const,
              rowId: "turn-1:tool:1",
            }),
            Object.freeze({
              kind: "database_row" as const,
              table: "messages" as const,
              rowId: "turn-1:assistant:1",
            }),
          ],
          telemetry: Object.freeze({
            retryCount: 0,
            toolFailureCount: 0,
            aborted: false,
          }),
          occurredAt: "2026-08-18T00:00:00.000Z",
        }),
        project: Object.freeze({ projectId: "project-1", root }),
        selectedCapabilities: Object.freeze([]),
        promptCapabilityIds: [],
      }),
      new AbortController().signal,
    );

    expect(result).toMatchObject({ status: "activated", capabilityId: "capability-1" });
    expect(await workspace.capabilities.getBinding("capability-1")).toMatchObject({
      scope: { kind: "global" },
      activationMode: "relevant",
      state: "active",
    });
    expect(await workspace.capabilities.listRevisions("capability-1")).toHaveLength(1);
    expect(await workspace.capabilities.getDefinition("capability-1")).not.toHaveProperty("kind");
    expect((await workspace.capabilities.listRevisions("capability-1"))[0]).toMatchObject({
      revision: {
        effects: [{ kind: "instruction" }],
        evidenceRefs: [
          { table: "messages", rowId: "turn-1:user" },
          { table: "tool_calls", rowId: "turn-1:tool:1" },
          { table: "messages", rowId: "turn-1:assistant:1" },
        ],
      },
    });
    expect(inference.requests()[0]?.messages.map((message) => message.name)).toEqual([
      "settled_turn",
      "current_capabilities",
      "foreground_capability_surface",
      "current_capability_materials",
      "available_saved_programs",
      "capabilities_in_use",
      "evidence",
    ]);
    // The next user message in the session is the reaction to the reflected turn.
    const settledTurn = JSON.parse(inference.requests()[0]?.messages[0]?.content ?? "{}");
    expect(settledTurn.reaction).toEqual({
      kind: "next_user_message",
      content: "Teach recovery behavior, but do not apply it before I approve it.",
    });
    expect(settledTurn.cause).toBe("unrecorded");
    expect(inference.requests()[0]?.messages.at(-1)?.content).toContain("turn-2:user");
    expect((await workspace.capabilities.listRevisions("capability-1"))[0]?.evidence).toEqual({
      kind: "explicit_request",
      quote: "The user asked for this behavior in future work.",
      wouldOtherwise: "The user would have to repeat the request in later sessions.",
    });
    expect(inference.requests()[0]?.messages.at(-1)?.content).toContain("web.search");
    expect(inference.requests()[0]?.messages.at(-1)?.content).toContain(
      "I kept the research summary concise",
    );

    const activeBinding = await workspace.capabilities.getBinding("capability-1");
    if (!activeBinding) throw new Error("Expected the reflected Capability to be active");
    await workspace.operational.toolCalls.put({
      toolCallId: "turn-2:skill-load",
      sessionId: "session-1",
      toolName: "skills.load",
      request: Object.freeze({
        executionId: "execution-turn-2",
        input: Object.freeze({ name: learnedCapabilitySkillName("capability-1", "Concise research") }),
      }),
      response: Object.freeze({
        output: Object.freeze({ name: learnedCapabilitySkillName("capability-1", "Concise research") }),
      }),
      status: "completed",
      sensitivity: "normal",
      createdAt: "2026-08-18T00:30:00.500Z",
      completedAt: "2026-08-18T00:30:00.750Z",
    });

    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const pending = await module.reflectSettledTurn(
      Object.freeze({
        turn: Object.freeze({
          sessionId: "session-1",
          turnId: "turn-2",
          userMessage: "Teach recovery behavior, but do not apply it before I approve it.",
          assistantMessage: "Understood.",
          outcome: "accepted",
          scope: "general",
          sensitivity: "normal",
          evidenceRefs: [
            Object.freeze({
              kind: "database_row" as const,
              table: "messages" as const,
              rowId: "turn-2:user",
            }),
            Object.freeze({
              kind: "database_row" as const,
              table: "tool_calls" as const,
              rowId: "turn-2:skill-load",
            }),
          ],
          telemetry: Object.freeze({ retryCount: 0, toolFailureCount: 0, aborted: false }),
          occurredAt: "2026-08-18T00:30:00.000Z",
        }),
        project: Object.freeze({ projectId: "project-1", root }),
        selectedCapabilities: Object.freeze([activeBinding.revision]),
        promptCapabilityIds: [],
      }),
      new AbortController().signal,
    );
    expect(pending).toMatchObject({ status: "pending", capabilityId: "capability-1" });
    const foregroundSurface =
      inference.requests()[1]?.messages.find((message) => message.name === "foreground_capability_surface")
        ?.content ?? "";
    expect(foregroundSurface).toContain('"initialForegroundExposure":"name_and_description_only"');
    expect(foregroundSurface).toContain('"fullBodyExposure":"after_completed_skills.load"');
    expect(foregroundSurface).toContain('"loadedDuringSettledTurn":true');
    expect(foregroundSurface).toContain('"omittedCount":0');
    const predecessorMaterials =
      inference.requests()[1]?.messages.find((message) => message.name === "current_capability_materials")
        ?.content ?? "";
    expect(predecessorMaterials).toContain("does not mean the foreground model received the material");
    const changed = await module.manage(
      {
        type: "change",
        gateRequestId: "gate-1",
        instruction: "Keep recovery manual and explain the fallback.",
      },
      new AbortController().signal,
    );
    expect(changed).toMatchObject({ status: "pending", capabilityId: "capability-1" });
    expect(await workspace.capabilities.getGate("gate-1")).toMatchObject({
      status: "superseded",
      instruction: "Keep recovery manual and explain the fallback.",
    });
    expect(await workspace.capabilities.listPendingGates()).toMatchObject([
      {
        gateRequestId: "gate-2",
        capabilityId: "capability-1",
        revision: { capabilityRevisionId: "revision-3" },
        instruction: "Keep recovery manual and explain the fallback.",
      },
    ]);
    expect(await workspace.capabilities.listRevisions("capability-1")).toHaveLength(3);
  });

  // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
  test("reflects a tool-dense turn within bounded messages and can attach the saved improvement", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-capability-dense-turn-"));
    const workspace = await createWorkspaceStore(root);
    opened.push({ root, workspace });
    const project = Object.freeze({ projectId: "project-dense", root });
    const occurredAt = "2026-08-20T19:45:00.000Z";
    await workspace.operational.sessions.put({
      sessionId: "session-dense",
      title: "Dense research turn",
      status: "idle",
      provider: "fake",
      model: "fake",
      runtime: "fake",
      createdAt: occurredAt,
      updatedAt: occurredAt,
      metadata: Object.freeze({}),
    });
    await workspace.operational.messages.put({
      messageId: "turn-dense:user",
      sessionId: "session-dense",
      role: "user",
      content: "Research several providers and improve how you perform this work next time.",
      sensitivity: "normal",
      createdAt: occurredAt,
      metadata: Object.freeze({ turnId: "turn-dense" }),
    });
    const assistantContent = `Research completed.\n${"evidence ".repeat(2_000)}`;
    await workspace.operational.messages.put({
      messageId: "turn-dense:assistant:1",
      sessionId: "session-dense",
      role: "assistant",
      content: assistantContent,
      sensitivity: "normal",
      createdAt: "2026-08-20T19:50:00.000Z",
      metadata: Object.freeze({ turnId: "turn-dense" }),
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const evidenceRefs: EvidenceRef[] = [
      Object.freeze({ kind: "database_row" as const, table: "messages" as const, rowId: "turn-dense:user" }),
      Object.freeze({
        kind: "database_row" as const,
        table: "messages" as const,
        rowId: "turn-dense:assistant:1",
      }),
    ];
    for (let index = 0; index < 40; index += 1) {
      const toolCallId = `turn-dense:search:${String(index)}`;
      await workspace.operational.toolCalls.put({
        toolCallId,
        sessionId: "session-dense",
        toolName: "mcp.exa.web_search_exa",
        request: Object.freeze({ query: `provider ${String(index)} ${"q".repeat(1_000)}` }),
        response: Object.freeze({
          results: [
            {
              title: `Source ${String(index)}`,
              text: "x".repeat(2_000),
              truncated: index === 1,
            },
          ],
          truncated: index === 0,
        }),
        status: "completed",
        sensitivity: "normal",
        createdAt: `2026-08-20T19:4${String(index % 10)}:00.000Z`,
        completedAt: `2026-08-20T19:4${String(index % 10)}:01.000Z`,
      });
      // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
      evidenceRefs.push(
        Object.freeze({ kind: "database_row" as const, table: "tool_calls" as const, rowId: toolCallId }),
      );
    }
    for (const [suffix, toolName] of [
      ["save", "programs.save"],
      ["run", "programs.run"],
    ] as const) {
      const toolCallId = `turn-dense:${suffix}`;
      await workspace.operational.toolCalls.put({
        toolCallId,
        sessionId: "session-dense",
        toolName,
        request: Object.freeze({ name: "comparative-research-scout" }),
        response: Object.freeze({ status: "completed", sources: 14 }),
        status: "completed",
        sensitivity: "normal",
        createdAt: suffix === "save" ? "2026-08-20T19:51:00.000Z" : "2026-08-20T19:52:00.000Z",
        completedAt: suffix === "save" ? "2026-08-20T19:51:01.000Z" : "2026-08-20T19:52:01.000Z",
      });
      // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
      evidenceRefs.push(
        Object.freeze({ kind: "database_row" as const, table: "tool_calls" as const, rowId: toolCallId }),
      );
    }
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const definitionRevision = await workspace.definitions.recordWorkingDefinition({
      workingPath: "programs/projects/project-dense/script/comparative-research-scout/index.mjs",
      bytes: new TextEncoder().encode("export default async function scout() { return []; }\n"),
      actor: Object.freeze({ actorId: "fixture", kind: "system" as const }),
      reason: "Saved research scout fixture",
    });
    const concurrentlyPublishedRevision = await workspace.definitions.recordWorkingDefinition({
      workingPath: "programs/projects/project-dense/script/comparative-research-scout/index.mjs",
      bytes: new TextEncoder().encode("export default async function scout() { return ['changed']; }\n"),
      actor: Object.freeze({ actorId: "fixture", kind: "system" as const }),
      reason: "Concurrent research scout fixture",
      predecessorRevisionId: definitionRevision.revisionId,
    });
    const inference = createScriptedLearningInferencePort({
      steps: [
        Object.freeze({
          role: "reflector",
          value: Object.freeze({
            decision: "create",
            proposal: Object.freeze({
              name: "Comparative research scout",
              description: "Reuse the saved comparative research scout.",
              applicability: "Broad comparisons that require several independent sources.",
              summary: "Attach the research scout proven in this turn.",
              rationale: "The saved scout completed the same research pattern successfully.",
              anticipatedEffect: "Future comparisons can reuse the working program.",
              effects: Object.freeze([
                Object.freeze({ kind: "program", mode: "script", name: "comparative-research-scout" }),
              ]),
              activationMode: "relevant",
              consequence: "ordinary",
              consequenceDescription: "This activates an existing saved project script.",
              evidence: Object.freeze({
                kind: "explicit_request",
                quote: "The user asked for this behavior in future work.",
                wouldOtherwise: "The user would have to repeat the request in later sessions.",
              }),
              evidenceCitationIndexes: Object.freeze([0]),
            }),
          }),
        }),
      ],
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    let liveResolveCalls = 0;
    const programs: CapabilityProgramLibrary = Object.freeze({
      list: async () =>
        Object.freeze([
          Object.freeze({
            mode: "script" as const,
            name: "comparative-research-scout",
            description: "Run bounded comparative research.",
            revision: 1,
            definitionRevision,
          }),
        ]),
      resolve: async (mode: "script" | "workflow", name: string, requestedProject: ProjectRef) =>
        (() => {
          liveResolveCalls += 1;
          return mode === "script" &&
            name === "comparative-research-scout" &&
            requestedProject.projectId === project.projectId
            ? Object.freeze({
                kind: "program" as const,
                program: Object.freeze({
                  mode,
                  name,
                  project,
                  definitionRevision: concurrentlyPublishedRevision,
                }),
              })
            : undefined;
        })(),
    });
    const module = createCapabilityLearningModule({
      workspace,
      store: workspace.capabilities,
      history: emptyHistory,
      inference,
      reflector: Object.freeze({
        variant: Object.freeze({
          variantId: "reflector-v1",
          axis: "role",
          configurationRefs: Object.freeze([promptRevision]),
        }),
        promptRevision,
        model: "controlled",
        reasoning: "high",
      }),
      programs,
      now: () => "2026-08-20T20:00:00.000Z",
      nextId: (prefix) => `${prefix}-dense`,
    });

    await expect(
      module.reflectSettledTurn(
        Object.freeze({
          turn: Object.freeze({
            sessionId: "session-dense",
            turnId: "turn-dense",
            userMessage: "Research several providers and improve how you perform this work next time.",
            assistantMessage: assistantContent,
            outcome: "accepted",
            scope: "global",
            sensitivity: "normal",
            evidenceRefs: [...evidenceRefs],
            telemetry: Object.freeze({ retryCount: 0, toolFailureCount: 0, aborted: false }),
            occurredAt,
          }),
          project,
          selectedCapabilities: Object.freeze([]),
          promptCapabilityIds: [],
        }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "activated" });

    const request = inference.requests()[0];
    expect(request?.messages.every((message) => message.content.length <= 10_000)).toBe(true);
    const evidence = request?.messages.find((message) => message.name === "evidence")?.content ?? "";
    expect(evidence).toContain('"count":40');
    expect(evidence).toContain('"truncatedResultCount":1');
    expect(evidence).toContain("resultTruncated");
    expect(evidence).toContain("programs.save");
    expect(evidence).toContain("programs.run");
    expect(evidence).toContain("mcp.exa.web_search_exa");
    expect((await workspace.capabilities.listRevisions("capability-dense"))[0]).toMatchObject({
      revision: {
        effects: [
          { kind: "instruction" },
          {
            kind: "program",
            program: { mode: "script", name: "comparative-research-scout", project, definitionRevision },
          },
        ],
      },
    });
    expect(liveResolveCalls).toBe(0);
  });

  test("attaches a saved workflow by its exact canonical revision instead of authoring a parallel workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-capability-workflow-"));
    const workspace = await createWorkspaceStore(root);
    opened.push({ root, workspace });
    const project = Object.freeze({ projectId: "project-workflow", root });
    await workspace.operational.sessions.put({
      sessionId: "session-workflow",
      title: "Workflow capability",
      status: "idle",
      provider: "fake",
      model: "fake",
      runtime: "fake",
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
      metadata: Object.freeze({}),
    });
    await workspace.operational.messages.put({
      messageId: "turn-workflow:user",
      sessionId: "session-workflow",
      role: "user",
      content: "Reuse the saved evidence synthesis workflow when this comes up again.",
      sensitivity: "normal",
      createdAt: "2026-08-18T00:00:00.000Z",
      metadata: Object.freeze({ turnId: "turn-workflow" }),
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const definitionRevision = await workspace.definitions.recordWorkingDefinition({
      workingPath: "programs/projects/project-workflow/workflow/evidence-synthesis/program.json",
      bytes: new TextEncoder().encode(
        '{"kind":"noesis_program","mode":"workflow","name":"evidence-synthesis"}\n',
      ),
      actor: Object.freeze({ actorId: "fixture", kind: "system" as const }),
      reason: "Saved workflow fixture",
    });
    const inference = createScriptedLearningInferencePort({
      steps: [
        Object.freeze({
          role: "reflector",
          value: Object.freeze({
            decision: "create",
            proposal: Object.freeze({
              name: "Evidence synthesis",
              description: "Reuse the saved evidence synthesis workflow.",
              applicability: "Requests that need the same evidence synthesis procedure.",
              summary: "Attach the saved evidence synthesis workflow.",
              rationale: "The user explicitly asked to reuse this saved program.",
              anticipatedEffect: "The proven procedure is available on relevant turns.",
              effects: Object.freeze([
                Object.freeze({ kind: "program", mode: "workflow", name: "evidence-synthesis" }),
              ]),
              activationMode: "relevant",
              consequence: "ordinary",
              consequenceDescription: "This activates an existing saved workflow.",
              evidence: Object.freeze({
                kind: "explicit_request",
                quote: "The user asked for this behavior in future work.",
                wouldOtherwise: "The user would have to repeat the request in later sessions.",
              }),
              evidenceCitationIndexes: Object.freeze([0]),
            }),
          }),
        }),
      ],
    });
    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    const programs: CapabilityProgramLibrary = Object.freeze({
      list: async () =>
        Object.freeze([
          Object.freeze({
            mode: "workflow" as const,
            name: "evidence-synthesis",
            description: "Synthesize evidence.",
            revision: 1,
            definitionRevision,
          }),
        ]),
      resolve: async (mode: "script" | "workflow", name: string, requestedProject: ProjectRef) =>
        mode === "workflow" &&
        name === "evidence-synthesis" &&
        requestedProject.projectId === project.projectId
          ? Object.freeze({
              kind: "program" as const,
              program: Object.freeze({ mode, name, project, definitionRevision }),
            })
          : undefined,
    });
    const module = createCapabilityLearningModule({
      workspace,
      store: workspace.capabilities,
      history: emptyHistory,
      inference,
      reflector: Object.freeze({
        variant: Object.freeze({
          variantId: "reflector-v1",
          axis: "role",
          configurationRefs: Object.freeze([promptRevision]),
        }),
        promptRevision,
        model: "controlled",
        reasoning: "high",
      }),
      programs,
      now: () => "2026-08-18T01:00:00.000Z",
      nextId: (prefix) => `${prefix}-workflow`,
    });

    // SAFETY: This test fixture intentionally supplies a controlled representation at this boundary.
    await expect(
      module.reflectSettledTurn(
        Object.freeze({
          turn: Object.freeze({
            sessionId: "session-workflow",
            turnId: "turn-workflow",
            userMessage: "Reuse the saved evidence synthesis workflow when this comes up again.",
            outcome: "accepted",
            scope: "general",
            sensitivity: "normal",
            evidenceRefs: [
              Object.freeze({
                kind: "database_row" as const,
                table: "messages" as const,
                rowId: "turn-workflow:user",
              }),
            ],
            telemetry: Object.freeze({ retryCount: 0, toolFailureCount: 0, aborted: false }),
            occurredAt: "2026-08-18T00:00:00.000Z",
          }),
          project,
          selectedCapabilities: Object.freeze([]),
          promptCapabilityIds: [],
        }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "activated" });

    const [binding] = await workspace.capabilities.listBindings({
      project,
      sessionId: "session-workflow",
      limit: 10,
    });
    expect(binding).toMatchObject({ scope: { kind: "project", project } });
    const current = binding ? await workspace.capabilities.getRevision(binding.revision) : undefined;
    expect(current?.revision.effects).toEqual([
      expect.objectContaining({ kind: "instruction" }),
      {
        kind: "program",
        program: { mode: "workflow", name: "evidence-synthesis", project, definitionRevision },
      },
    ]);
    expect(await workspace.definitionMetadata.listCurrent("program:project-workflow:workflow")).toEqual([]);
  });

  test("records how a used Capability did and pauses it after two harmful uses", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-capability-outcomes-"));
    const workspace = await createWorkspaceStore(root);
    opened.push({ root, workspace });
    const project: ProjectRef = Object.freeze({ projectId: "project-outcomes", root });
    await workspace.operational.sessions.put({
      sessionId: "session-outcomes",
      title: "Outcomes",
      status: "idle",
      provider: "fake",
      model: "fake",
      runtime: "fake",
      createdAt: "2026-10-29T10:00:00.000Z",
      updatedAt: "2026-10-29T10:00:00.000Z",
      metadata: Object.freeze({}),
    });
    const putUser = async (turnId: string, content: string, createdAt: string) =>
      await workspace.operational.messages.put({
        messageId: `${turnId}:user`,
        sessionId: "session-outcomes",
        role: "user",
        content,
        sensitivity: "normal",
        createdAt,
        metadata: Object.freeze({ turnId }),
      });
    const origin = await putUser(
      "turn-0",
      "Always run the formatter after edits.",
      "2026-10-29T10:00:00.000Z",
    );
    let sequence = 0;
    const nextId = (prefix: string) => {
      sequence += 1;
      return prefix === "capability" ? "capability-format" : `${prefix}-${String(sequence)}`;
    };
    const publisher = createCapabilityPublisher({
      workspace,
      store: workspace.capabilities,
      now: () => "2026-10-29T10:00:01.000Z",
      nextId,
    });
    await publisher.publish(
      {
        decision: "create",
        proposal: {
          name: "Format after edits",
          description: "Run the formatter after editing files.",
          applicability: "Editing source files in a repository.",
          summary: "Run the formatter after edits.",
          rationale: "The user asked for it.",
          anticipatedEffect: "Edits stay formatted.",
          effects: [{ kind: "instruction", content: "Run the formatter after every edit." }],
          consequence: "ordinary",
          consequenceDescription: "Only model instructions change.",
        },
      },
      {
        project,
        sessionId: "session-outcomes",
        evidenceRefs: [origin],
        actor: Object.freeze({ actorId: "test", kind: "noesis" as const }),
      },
      new AbortController().signal,
    );
    const binding = await workspace.capabilities.getBinding("capability-format");
    if (!binding) throw new Error("Expected the Capability to exist");
    const skillName = learnedCapabilitySkillName("capability-format", "Format after edits");
    const hurtJudgment = Object.freeze({
      decision: "no_change",
      reason: "The correction is about the Capability, which outcomes already record.",
      outcomes: [
        { capabilityId: "capability-format", result: "hurt", reason: "The user undid the formatting." },
        { capabilityId: "capability-unused", result: "helped", reason: "Not used, so ignored." },
      ],
    });
    const inference = createScriptedLearningInferencePort({
      steps: [
        Object.freeze({ role: "reflector", value: hurtJudgment }),
        Object.freeze({ role: "reflector", value: hurtJudgment }),
      ],
    });
    const module = createCapabilityLearningModule({
      workspace,
      store: workspace.capabilities,
      history: emptyHistory,
      inference,
      publisher,
      reflector: Object.freeze({
        variant: Object.freeze({
          variantId: "reflector-v1",
          axis: "role" as const,
          configurationRefs: Object.freeze([promptRevision]),
        }),
        promptRevision,
        model: "fake",
        reasoning: "off" as const,
      }),
      now: () => "2026-10-29T11:00:00.000Z",
      nextId,
    });
    const reflectOn = async (turnId: string, minute: number) => {
      const user = await putUser(turnId, "Fix the parser bug.", `2026-10-29T10:${String(minute)}0:00.000Z`);
      const load = await workspace.operational.toolCalls.put({
        toolCallId: `${turnId}:load`,
        sessionId: "session-outcomes",
        toolName: "skills.load",
        request: Object.freeze({ name: skillName }),
        response: Object.freeze({ content: "Run the formatter after every edit." }),
        status: "completed",
        sensitivity: "normal",
        createdAt: `2026-10-29T10:${String(minute)}0:01.000Z`,
        completedAt: `2026-10-29T10:${String(minute)}0:02.000Z`,
      });
      await putUser(
        `${turnId}-reaction`,
        "Stop reformatting files I did not touch.",
        `2026-10-29T10:${String(minute)}5:00.000Z`,
      );
      return await module.reflectSettledTurn(
        Object.freeze({
          turn: Object.freeze({
            sessionId: "session-outcomes",
            turnId,
            userMessage: "Fix the parser bug.",
            outcome: "unknown",
            cause: "completed",
            scope: "global",
            sensitivity: "normal",
            occurredAt: `2026-10-29T10:${String(minute)}0:00.000Z`,
            evidenceRefs: [user, load],
            telemetry: Object.freeze({ retryCount: 0, toolFailureCount: 0, aborted: false }),
          }),
          project,
          selectedCapabilities: [binding.revision],
          // The frozen plan delivered this Capability on demand, not in the prompt.
          promptCapabilityIds: [],
        }),
        new AbortController().signal,
      );
    };

    await expect(reflectOn("turn-1", 1)).resolves.toMatchObject({ status: "no_change" });
    const firstMessages = inference.requests()[0]?.messages ?? [];
    const inUse = JSON.parse(
      firstMessages.find((message) => message.name === "capabilities_in_use")?.content ?? "{}",
    );
    expect(inUse.capabilities).toEqual([
      {
        capabilityId: "capability-format",
        capabilityRevisionId: binding.revision.capabilityRevisionId,
        name: "Format after edits",
        how: "loaded_by_model",
        guidance: "Run the formatter after every edit.",
        trackRecord: { helped: 0, hurt: 0, unclear: 0 },
      },
    ]);
    expect((await workspace.capabilities.getBinding("capability-format"))?.state).toBe("active");

    // A mode change after the turn does not change how the turn used the Capability.
    const current = await workspace.capabilities.getBinding("capability-format");
    if (!current) throw new Error("Expected the Capability binding");
    await workspace.capabilities.updateBinding({
      capabilityId: "capability-format",
      expectedRevisionNumber: current.revisionNumber,
      activationMode: "always",
    });
    await expect(reflectOn("turn-2", 2)).resolves.toMatchObject({
      status: "paused",
      capabilityId: "capability-format",
    });
    expect((await workspace.capabilities.getBinding("capability-format"))?.state).toBe("paused");
    const secondInUse = JSON.parse(
      inference.requests()[1]?.messages.find((message) => message.name === "capabilities_in_use")?.content ??
        "{}",
    );
    expect(secondInUse.capabilities[0]?.how).toBe("loaded_by_model");
    const outcomes = await workspace.capabilities.listOutcomes("capability-format", 10);
    expect(outcomes.map((outcome) => [outcome.turnId, outcome.result])).toEqual([
      ["turn-2", "hurt"],
      ["turn-1", "hurt"],
    ]);
    // The judgment about a Capability the turn did not use is ignored.
    expect(await workspace.capabilities.listOutcomes("capability-unused", 10)).toEqual([]);
    expect(
      (await workspace.capabilities.listFeedback("capability-format")).some(
        (feedback) => feedback.disposition === "regression",
      ),
    ).toBe(true);
  });
});
