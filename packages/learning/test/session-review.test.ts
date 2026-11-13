import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, type FileRevisionRef } from "@noesis/domain";
import type { HistoryPort } from "@noesis/intelligence";
import { createWorkspaceStore } from "@noesis/workspace";
import { expect, test } from "vitest";
import { createCapabilityPublisher } from "../src/capability-publisher.ts";
import { createSessionReview } from "../src/session-review.ts";
import { createScriptedLearningInferencePort } from "./support/scripted-learning-inference.ts";

const promptRevision: FileRevisionRef = Object.freeze({
  kind: "file_revision",
  revisionId: "session-reviewer-prompt",
  workingPath: "prompts/control-plane/session_reviewer.md",
  snapshotPath: "revisions/session-reviewer-prompt",
  contentDigest: sha256("session_reviewer"),
});

test("creates a Capability from a need repeated across sessions and skips superseded reviews", async () => {
  const root = await mkdtemp(join(tmpdir(), "noesis-session-review-"));
  const workspace = await createWorkspaceStore(root);
  try {
    for (const sessionId of ["session-earlier", "session-current"])
      await workspace.operational.sessions.put({
        sessionId,
        title: sessionId,
        status: "idle",
        provider: "fake",
        model: "fake",
        runtime: "fake",
        createdAt: "2026-10-20T10:00:00.000Z",
        updatedAt: "2026-10-20T10:00:00.000Z",
        metadata: Object.freeze({}),
      });
    const earlier = await workspace.operational.messages.put({
      messageId: "turn-earlier:user",
      sessionId: "session-earlier",
      role: "user",
      content: "Write the release notes from the merged pull requests, grouped by area.",
      sensitivity: "normal",
      createdAt: "2026-10-20T10:00:00.000Z",
      metadata: Object.freeze({ turnId: "turn-earlier" }),
    });
    await workspace.operational.messages.put({
      messageId: "turn-current:user",
      sessionId: "session-current",
      role: "user",
      content: "Release notes again please, grouped by area like last time.",
      sensitivity: "normal",
      createdAt: "2026-10-29T10:00:00.000Z",
      metadata: Object.freeze({ turnId: "turn-current" }),
    });
    const earlierText = "Write the release notes from the merged pull requests, grouped by area.";
    const searchedScopes: unknown[] = [];
    const searchedQueries: string[] = [];
    let rebuilds = 0;
    const history: Pick<HistoryPort, "search" | "rebuild"> = Object.freeze({
      rebuild: async () => {
        rebuilds += 1;
        return Object.freeze({ documents: 1 });
      },
      search: async (request) => {
        searchedScopes.push(request.sessionScope);
        searchedQueries.push(request.query);
        return Object.freeze({
          query: request.query,
          hits: Object.freeze([
            Object.freeze({
              citation: Object.freeze({
                source: Object.freeze({
                  kind: "database_row" as const,
                  table: "messages" as const,
                  rowId: earlier.rowId,
                  field: "content",
                }),
                occurredAt: "2026-10-20T10:00:00.000Z",
                excerpt: "Write the release notes from the merged pull requests, grouped by area.",
                startOffset: 0,
                endOffset: earlierText.length,
                contentDigest: sha256(earlierText),
              }),
              score: 1,
            }),
          ]),
          candidateCount: 1,
        });
      },
    });
    const inference = createScriptedLearningInferencePort({
      steps: [
        Object.freeze({
          role: "session_reviewer",
          value: Object.freeze({ queries: ["release notes", '"grouped by area"', "release notes"] }),
        }),
        Object.freeze({
          role: "session_reviewer",
          value: Object.freeze({
            summary: "The user asked for release notes grouped by area in two sessions.",
            decisions: [
              {
                decision: "create",
                proposal: {
                  name: "Release notes by area",
                  description: "Write release notes from merged pull requests, grouped by area.",
                  applicability: "Writing release notes for this project.",
                  summary: "Group release notes by area.",
                  rationale: "The same request appeared in two sessions.",
                  anticipatedEffect: "Release notes follow the user's format without asking.",
                  effects: [
                    {
                      kind: "instruction",
                      content: "List merged pull requests since the last tag and group them by area.",
                    },
                  ],
                  consequence: "ordinary",
                  consequenceDescription: "Only model guidance changes.",
                  evidence: {
                    kind: "repeated_across_sessions",
                    quote: "Release notes again please, grouped by area like last time.",
                    wouldOtherwise: "The user would explain the format in every session.",
                  },
                  evidenceCitationIndexes: [0, 1],
                },
              },
            ],
          }),
        }),
      ],
    });
    const review = createSessionReview({
      workspace,
      store: workspace.capabilities,
      history,
      inference,
      publisher: createCapabilityPublisher({
        workspace,
        store: workspace.capabilities,
      }),
      reviewer: Object.freeze({
        variant: Object.freeze({
          variantId: "session-reviewer-v1",
          axis: "role" as const,
          configurationRefs: Object.freeze([promptRevision]),
        }),
        promptRevision,
        model: "fake",
        reasoning: "low" as const,
      }),
    });
    const project = Object.freeze({ projectId: "project-review", root });

    // A review scheduled by an earlier turn is superseded by later activity in the session.
    await expect(
      review(
        {
          sessionId: "session-current",
          project,
          turnId: "turn-older",
          occurredAt: "2026-10-29T09:00:00.000Z",
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "skipped" });
    expect(inference.requests()).toHaveLength(0);

    await expect(
      review(
        {
          sessionId: "session-current",
          project,
          turnId: "turn-current",
          occurredAt: "2026-10-29T10:00:00.000Z",
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      status: "reviewed",
      queries: ["release notes", '"grouped by area"'],
      results: [{ status: "activated" }],
    });
    // The model writes the searches. They run on a fresh index over earlier sessions only.
    expect(searchedQueries).toEqual(["release notes", '"grouped by area"']);
    expect(rebuilds).toBe(1);
    expect(new Set(searchedScopes.map((scope) => JSON.stringify(scope)))).toEqual(
      new Set([JSON.stringify({ kind: "previous", currentSessionId: "session-current" })]),
    );
    const [writeQueries, decide] = inference.requests();
    expect(writeQueries?.messages.map((message) => message.name)).toEqual([
      "session_review",
      "current_capabilities",
      "write_search_queries",
    ]);
    expect(decide?.messages.map((message) => message.name)).toEqual([
      "session_review",
      "current_capabilities",
      "related_history",
    ]);
    expect(decide?.messages.at(-1)?.content).toContain(earlierText);
    expect(writeQueries?.availableTools).toEqual([]);
    expect(decide?.availableTools).toEqual([]);
    const [definition] = await workspace.capabilities.listDefinitions();
    expect(definition?.name).toBe("Release notes by area");
    const binding = definition ? await workspace.capabilities.getBinding(definition.capabilityId) : undefined;
    const revision = binding ? await workspace.capabilities.getRevision(binding.revision) : undefined;
    expect(revision?.evidence?.kind).toBe("repeated_across_sessions");
    expect(revision?.revision.evidenceRefs).toEqual([
      { kind: "database_row", table: "messages", rowId: "turn-current:user" },
      { kind: "database_row", table: "messages", rowId: "turn-earlier:user" },
    ]);
  } finally {
    workspace.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a session review with no queries skips the search and still decides", async () => {
  const root = await mkdtemp(join(tmpdir(), "noesis-session-review-no-queries-"));
  const workspace = await createWorkspaceStore(join(root, "workspace"));
  try {
    await workspace.operational.sessions.put({
      sessionId: "session-only",
      title: "Only",
      status: "idle",
      provider: "fake",
      model: "fake",
      runtime: "fake",
      createdAt: "2026-10-29T09:00:00.000Z",
      updatedAt: "2026-10-29T10:00:00.000Z",
      metadata: {},
    });
    await workspace.operational.messages.put({
      messageId: "turn-only:user",
      sessionId: "session-only",
      role: "user",
      content: "Rename this variable.",
      sensitivity: "normal",
      createdAt: "2026-10-29T10:00:00.000Z",
      metadata: {},
    });
    const history: Pick<HistoryPort, "search" | "rebuild"> = Object.freeze({
      rebuild: async () => {
        throw new Error("Nothing to search, so the index must not be rebuilt");
      },
      search: async () => {
        throw new Error("The model wrote no queries, so nothing may be searched");
      },
    });
    const inference = createScriptedLearningInferencePort({
      steps: [
        Object.freeze({ role: "session_reviewer", value: Object.freeze({ queries: [] }) }),
        Object.freeze({
          role: "session_reviewer",
          value: Object.freeze({ summary: "Nothing repeats.", decisions: [] }),
        }),
      ],
    });
    const review = createSessionReview({
      workspace,
      store: workspace.capabilities,
      history,
      inference,
      publisher: createCapabilityPublisher({ workspace, store: workspace.capabilities }),
      reviewer: Object.freeze({
        variant: Object.freeze({
          variantId: "session-reviewer-v1",
          axis: "role" as const,
          configurationRefs: Object.freeze([promptRevision]),
        }),
        promptRevision,
        model: "fake",
        reasoning: "low" as const,
      }),
    });

    await expect(
      review(
        {
          sessionId: "session-only",
          project: Object.freeze({ projectId: "project-review", root }),
          turnId: "turn-only",
          occurredAt: "2026-10-29T10:00:00.000Z",
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "reviewed", summary: "Nothing repeats.", results: [] });
    expect(inference.remaining()).toBe(0);
  } finally {
    workspace.close();
    await rm(root, { recursive: true, force: true });
  }
});
