import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CapabilityRevision,
  capabilityRevisionRef,
  type EvidenceRef,
  type Experiment,
  type FileRevisionRef,
  sameCapabilityRevisionRef,
  sha256,
} from "@noesis/domain";
import { createWorkspaceStore } from "@noesis/workspace";
import { afterEach, describe, expect, test } from "vitest";
import {
  createWorkspaceExperimentBriefStore,
  createWorkspaceLearningCandidateManifestStore,
  type ExperimentBrief,
} from "../src/index.ts";

describe("durable automatic-learning handoff", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  test("rehydrates a deduped brief and exact candidate identity after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "noesis-durable-learning-"));
    roots.push(root);
    let workspace = await createWorkspaceStore(root);
    await workspace.operational.sessions.put({
      sessionId: "session-learning",
      title: "Learning source",
      status: "completed",
      provider: "fake",
      model: "fake",
      runtime: "fake",
      createdAt: "2026-07-22T10:00:00.000Z",
      updatedAt: "2026-07-22T10:00:00.000Z",
      metadata: {},
    });
    await workspace.operational.messages.put({
      messageId: "message-correction",
      sessionId: "session-learning",
      role: "user",
      content: "Always cite the source.",
      sensitivity: "private",
      createdAt: "2026-07-22T10:00:00.000Z",
      metadata: {},
    });
    const evidence: EvidenceRef = {
      kind: "database_row",
      table: "messages",
      rowId: "message-correction",
    };
    const baseline = capabilityRevisionRef(revision("capability-r1", fileRef("baseline"), [evidence]));
    const brief: ExperimentBrief = Object.freeze({
      experimentId: "experiment-durable",
      title: "Cite sources",
      hypothesis: "Citations reduce corrections",
      hypothesisDedupeKey: "dedupe-citations",
      scope: "research",
      capability: Object.freeze({
        capabilityId: "capability-research",
        name: "Research",
        scope: "research",
        intent: "Produce grounded research",
      }),
      baselineRevision: baseline,
      evidenceRefs: Object.freeze([evidence]),
      feedbackSignalIds: Object.freeze([]),
      citations: Object.freeze([]),
      recurrenceCitations: Object.freeze([]),
      sourceCases: Object.freeze([
        Object.freeze({
          caseId: "source-1",
          title: "Correction",
          scope: "research",
          input: "Draft a summary",
          expectedBehavior: "Cite the source",
          evidenceRefs: Object.freeze([evidence]),
          citations: Object.freeze([]),
        }),
      ]),
      recurrenceCount: 1,
    });
    const briefs = createWorkspaceExperimentBriefStore(workspace);
    await briefs.put(brief);
    const candidateRevision = revision("capability-r2", fileRef("candidate"), [evidence]);
    const candidateRef = capabilityRevisionRef(candidateRevision);
    const manifests = createWorkspaceLearningCandidateManifestStore(workspace);
    const manifestRevision = await manifests.persist({
      brief,
      revision: candidateRevision,
      revisionRef: candidateRef,
    });
    const experiment: Experiment = Object.freeze({
      experimentId: brief.experimentId,
      hypothesis: brief.hypothesis,
      scope: brief.scope,
      evidenceRefs: Object.freeze([evidence, manifestRevision]),
      baselineRevision: baseline,
      candidateRevisions: Object.freeze([candidateRef]),
      feedbackSignalIds: Object.freeze([]),
      status: "authoring",
    });
    await workspace.research.experiments.putExperiment(experiment);
    workspace.close();

    workspace = await createWorkspaceStore(root);
    const restartedBriefs = createWorkspaceExperimentBriefStore(workspace);
    expect(await restartedBriefs.findByDedupeKey(brief.hypothesisDedupeKey)).toEqual(brief);
    await expect(
      restartedBriefs.put(Object.freeze({ ...brief, experimentId: "duplicate-after-restart" })),
    ).rejects.toThrow("publication collision");
    expect((await restartedBriefs.findByDedupeKey(brief.hypothesisDedupeKey))?.experimentId).toBe(
      brief.experimentId,
    );
    const restartedManifests = createWorkspaceLearningCandidateManifestStore(workspace);
    const rehydrated = await restartedManifests.rehydrate(brief.experimentId);
    expect(rehydrated?.manifestRevision).toEqual(manifestRevision);
    expect(rehydrated?.revision).toEqual(candidateRevision);
    expect(rehydrated ? sameCapabilityRevisionRef(rehydrated.revisionRef, candidateRef) : false).toBe(true);
    const repeatedManifest = await restartedManifests.persist({
      brief,
      revision: candidateRevision,
      revisionRef: candidateRef,
    });
    expect(repeatedManifest).toEqual(manifestRevision);
    workspace.close();
  });
});

function fileRef(label: string): FileRevisionRef {
  return Object.freeze({
    kind: "file_revision",
    revisionId: `revision-${label}`,
    workingPath: `definitions/${label}.json`,
    snapshotPath: `revisions/${label}.json`,
    contentDigest: sha256(label),
  });
}

function revision(
  capabilityRevisionId: string,
  component: FileRevisionRef,
  evidenceRefs: readonly EvidenceRef[],
): CapabilityRevision {
  return Object.freeze({
    capabilityRevisionId,
    capabilityId: "capability-research",
    promptModules: Object.freeze([component]),
    skills: Object.freeze([]),
    tools: Object.freeze([]),
    toolset: Object.freeze({
      toolRevisionIds: Object.freeze([]),
      routerRevision: component,
      strategyId: "static-v1",
    }),
    activationPolicy: Object.freeze({ mode: "automatic_low_risk", scope: "research" }),
    permissionManifest: Object.freeze({
      effects: Object.freeze(["read"]),
      resourcePatterns: Object.freeze(["workspace:research/**"]),
      credentialRefs: Object.freeze([]),
    }),
    evidenceRefs: Object.freeze([...evidenceRefs]),
    sourceEvaluationDefinitions: Object.freeze([component]),
    requestedPermissionDelta: Object.freeze({
      addedEffects: Object.freeze([]),
      widenedResources: Object.freeze([]),
      addedCredentialRefs: Object.freeze([]),
    }),
  });
}
