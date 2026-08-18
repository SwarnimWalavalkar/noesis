import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtomicCapabilityRegistry } from "@noesis/capabilities";
import type { FileRevisionRef } from "@noesis/domain";
import { sha256 } from "@noesis/domain";
import type { HistoryPort } from "@noesis/intelligence";
import { createWorkspaceStore, type NoesisWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import { createCapabilityLearningModule } from "../src/capability-loop.ts";
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
    const inference = createScriptedLearningInferencePort({
      steps: [
        Object.freeze({
          role: "reflector",
          value: Object.freeze({
            decision: "create",
            proposal: Object.freeze({
              name: "Concise research",
              kind: "instruction",
              description: "Keep research answers concise without dropping primary evidence.",
              applicability: "Research and source-synthesis requests.",
              summary: "Prefer concise, evidence-dense research answers.",
              rationale: "The user explicitly asked for concise future research answers.",
              anticipatedEffect: "Research responses become easier to scan.",
              instruction: "Prefer concise synthesis. Preserve exact primary-source citations.",
              scope: "global",
              activationMode: "relevant",
              consequence: "ordinary",
              consequenceDescription: "Only model instructions change.",
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
            instruction: "Never recover automatically. Explain the fallback before acting.",
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
      registry: createAtomicCapabilityRegistry(),
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
    const result = await module.reflectSettledTurn(
      Object.freeze({
        turn: Object.freeze({
          sessionId: "session-1",
          turnId: "turn-1",
          userMessage: "Keep future research answers concise.",
          assistantMessage: "Understood.",
          outcome: "accepted",
          servedWorkingAdjustmentOutcomes: [],
          scope: "general",
          sensitivity: "normal",
          evidenceRefs: [
            Object.freeze({
              kind: "database_row" as const,
              table: "messages" as const,
              rowId: "turn-1:user",
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
    expect(inference.requests()[0]?.messages.map((message) => message.name)).toEqual([
      "settled_turn",
      "current_capabilities",
      "evidence",
    ]);

    const binding = await workspace.capabilities.getBinding("capability-1");
    if (!binding) throw new Error("Expected the reflected Capability binding");
    await workspace.capabilities.createGate({
      gateRequestId: "gate-original",
      capabilityId: binding.capabilityId,
      revision: binding.revision,
      expectedBindingRevision: binding.revisionNumber,
      proposedScope: binding.scope,
      proposedActivationMode: binding.activationMode,
      consequence: "This changes recovery control behavior.",
      status: "pending",
      createdAt: "2026-08-18T01:00:00.000Z",
    });
    const changed = await module.manage(
      {
        type: "change",
        gateRequestId: "gate-original",
        instruction: "Keep recovery manual and explain the fallback.",
      },
      new AbortController().signal,
    );
    expect(changed).toMatchObject({ status: "pending", capabilityId: "capability-1" });
    expect(await workspace.capabilities.getGate("gate-original")).toMatchObject({
      status: "superseded",
      instruction: "Keep recovery manual and explain the fallback.",
    });
    expect(await workspace.capabilities.listPendingGates()).toMatchObject([
      {
        gateRequestId: "gate-1",
        capabilityId: "capability-1",
        revision: { capabilityRevisionId: "revision-2" },
        instruction: "Keep recovery manual and explain the fallback.",
      },
    ]);
    expect(await workspace.capabilities.listRevisions("capability-1")).toHaveLength(2);
  });
});
