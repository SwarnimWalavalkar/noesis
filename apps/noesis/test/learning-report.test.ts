import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtomicCapabilityRegistry } from "@noesis/capabilities";
import { createCapabilityPublisher } from "@noesis/learning";
import { createWorkspaceStore } from "@noesis/workspace";
import { expect, test } from "vitest";
import { parseArgs } from "../src/cli-args.ts";
import { computeLearningReport, formatLearningReport } from "../src/learning-report.ts";

test("parses the learning report command", () => {
  expect(parseArgs(["learning", "report"])).toMatchObject({ command: "learning", subcommand: "report" });
  expect(() => parseArgs(["learning", "purge"])).toThrow("Use learning report");
  expect(parseArgs(["learning", "report", "--days", "7"])).toMatchObject({ sinceDays: 7 });
  expect(() => parseArgs(["learning", "report", "--days", "0"])).toThrow("--days");
});

test("counts each Capability's judged outcomes and evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "noesis-learning-report-"));
  const workspace = await createWorkspaceStore(root);
  try {
    await workspace.operational.sessions.put({
      sessionId: "session-report",
      title: "Report",
      status: "idle",
      provider: "fake",
      model: "fake",
      runtime: "fake",
      createdAt: "2026-10-29T10:00:00.000Z",
      updatedAt: "2026-10-29T10:00:00.000Z",
      metadata: Object.freeze({}),
    });
    const message = await workspace.operational.messages.put({
      messageId: "turn-report:user",
      sessionId: "session-report",
      role: "user",
      content: "From now on, use pnpm here.",
      sensitivity: "normal",
      createdAt: "2026-10-29T10:00:00.000Z",
      metadata: Object.freeze({ turnId: "turn-report" }),
    });
    const publisher = createCapabilityPublisher({
      workspace,
      store: workspace.capabilities,
      registry: createAtomicCapabilityRegistry(),
    });
    const published = await publisher.publish(
      {
        decision: "create",
        proposal: {
          name: "Use pnpm",
          description: "Use pnpm for package commands.",
          applicability: "Package commands in this repository.",
          summary: "Use pnpm.",
          rationale: "The user asked for pnpm.",
          anticipatedEffect: "Package commands use pnpm.",
          effects: [{ kind: "instruction", content: "Use pnpm for package commands." }],
          consequence: "ordinary",
          consequenceDescription: "Only model instructions change.",
          evidence: {
            kind: "explicit_request",
            quote: "From now on, use pnpm here.",
            wouldOtherwise: "The user would correct npm usage again.",
          },
        },
      },
      {
        project: Object.freeze({ projectId: "project-report", root }),
        sessionId: "session-report",
        evidenceRefs: [message],
        actor: Object.freeze({ actorId: "test", kind: "noesis" as const }),
      },
      new AbortController().signal,
    );
    if (published.status !== "activated") throw new Error("Expected the Capability to activate");
    const binding = await workspace.capabilities.getBinding(published.capabilityId);
    if (!binding) throw new Error("Expected a binding");
    await workspace.capabilities.recordOutcomes(
      (["helped", "helped", "hurt"] as const).map((result, index) => ({
        outcomeId: `outcome-${String(index)}`,
        capabilityId: published.capabilityId,
        capabilityRevisionId: binding.revision.capabilityRevisionId,
        sessionId: "session-report",
        turnId: `turn-${String(index)}`,
        result,
        reason: "fixture",
        evidenceRefs: [message],
        createdAt: "2026-10-29T11:00:00.000Z",
      })),
    );

    const report = await computeLearningReport(workspace);
    expect(report.capabilities).toEqual([
      expect.objectContaining({
        name: "Use pnpm",
        state: "active",
        evidenceKind: "explicit_request",
        helped: 2,
        hurt: 1,
        unclear: 0,
      }),
    ]);
    const text = formatLearningReport(report);
    expect(text).toContain("Helped 2 (67%), hurt 1 (33%)");
    expect(text).toContain("Corrections after learning");
    expect(text).toContain("explicit_request: 1");
    // A window that ends before the outcomes were judged counts none of them.
    const windowed = await computeLearningReport(workspace, {
      sinceDays: 1,
      now: new Date("2026-11-30T00:00:00.000Z"),
    });
    expect(windowed.capabilities[0]).toMatchObject({ helped: 0, hurt: 0, usedWithin30Days: true });
  } finally {
    workspace.close();
    await rm(root, { recursive: true, force: true });
  }
});
