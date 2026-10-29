import type { CapabilityLifecycleRevision } from "@noesis/domain";
import { CAPABILITY_REFLECTION_JOB_KIND } from "@noesis/runtime";
import type { NoesisWorkspaceStore } from "@noesis/workspace";
import { z } from "zod";

const ReflectionResultSchema = z.looseObject({ status: z.string() });
const REFLECTION_PAGE_LIMIT = 1000;

export interface LearningReportCapability {
  readonly capabilityId: string;
  readonly name: string;
  readonly state: "active" | "paused";
  readonly activationMode: "relevant" | "always";
  readonly evidenceKind?: NonNullable<CapabilityLifecycleRevision["evidence"]>["kind"];
  readonly revisions: number;
  readonly helped: number;
  readonly hurt: number;
  readonly unclear: number;
  readonly automaticPauses: number;
  readonly restores: number;
}

/** Counts read from SQLite. The model's own judgments supply the outcomes; this only counts them. */
export interface LearningReport {
  readonly reflections: {
    readonly total: number;
    readonly waitingForReply: number;
    readonly failed: number;
    /** Completed reflections by their publication status, e.g. no_change or activated. */
    readonly results: Readonly<Record<string, number>>;
  };
  readonly capabilities: readonly LearningReportCapability[];
}

export async function computeLearningReport(workspace: NoesisWorkspaceStore): Promise<LearningReport> {
  const jobs = await workspace.jobs.list({
    kind: CAPABILITY_REFLECTION_JOB_KIND,
    order: "newest",
    limit: REFLECTION_PAGE_LIMIT,
  });
  const results: Record<string, number> = {};
  for (const job of jobs) {
    if (job.status !== "completed") continue;
    const parsed = ReflectionResultSchema.safeParse(job.result);
    const status = parsed.success ? parsed.data.status : "unknown";
    results[status] = (results[status] ?? 0) + 1;
  }
  const definitions = await workspace.capabilities.listDefinitions();
  const bindings = await workspace.capabilities.getBindings(
    definitions.map((definition) => definition.capabilityId),
  );
  const bindingById = new Map(bindings.map((binding) => [binding.capabilityId, binding] as const));
  const records = await workspace.capabilities.trackRecords(
    bindings.map((binding) => binding.revision.capabilityRevisionId),
  );
  const capabilities = await Promise.all(
    definitions.flatMap((definition) => {
      const binding = bindingById.get(definition.capabilityId);
      if (!binding) return [];
      return [
        (async (): Promise<LearningReportCapability> => {
          const [revisions, current, feedback] = await Promise.all([
            workspace.capabilities.listRevisions(definition.capabilityId),
            workspace.capabilities.getRevision(binding.revision),
            workspace.capabilities.listFeedback(definition.capabilityId),
          ]);
          const record = records.get(binding.revision.capabilityRevisionId);
          const report: LearningReportCapability = {
            capabilityId: definition.capabilityId,
            name: definition.name,
            state: binding.state,
            activationMode: binding.activationMode,
            revisions: revisions.length,
            helped: record?.helped ?? 0,
            hurt: record?.hurt ?? 0,
            unclear: record?.unclear ?? 0,
            automaticPauses: feedback.filter((item) => item.disposition === "regression").length,
            restores: feedback.filter((item) => item.disposition === "restore_request").length,
          };
          return current?.evidence ? { ...report, evidenceKind: current.evidence.kind } : report;
        })(),
      ];
    }),
  );
  return Object.freeze({
    reflections: Object.freeze({
      total: jobs.length,
      waitingForReply: jobs.filter((job) => job.status === "scheduled").length,
      failed: jobs.filter((job) => job.status === "failed" || job.status === "budget_exhausted").length,
      results: Object.freeze(results),
    }),
    capabilities: Object.freeze(capabilities),
  });
}

const percent = (part: number, whole: number): string =>
  whole === 0 ? "n/a" : `${String(Math.round((part / whole) * 100))}%`;

export function formatLearningReport(report: LearningReport): string {
  const completed = Object.values(report.reflections.results).reduce((total, count) => total + count, 0);
  const noChange = report.reflections.results["no_change"] ?? 0;
  const created = report.reflections.results["activated"] ?? 0;
  const revised = report.reflections.results["revised"] ?? 0;
  const judged = report.capabilities.reduce(
    (total, capability) => total + capability.helped + capability.hurt + capability.unclear,
    0,
  );
  const hurt = report.capabilities.reduce((total, capability) => total + capability.hurt, 0);
  const helped = report.capabilities.reduce((total, capability) => total + capability.helped, 0);
  const neverJudged = report.capabilities.filter(
    (capability) => capability.helped + capability.hurt + capability.unclear === 0,
  ).length;
  const lines = [
    "Noesis learning report",
    "",
    "Reflections",
    `  ${String(report.reflections.total)} recorded, ${String(report.reflections.waitingForReply)} waiting for a reply, ${String(report.reflections.failed)} failed`,
    `  ${String(noChange)} no change (${percent(noChange, completed)}), ${String(created)} created, ${String(revised)} revised`,
    `  Capabilities created per 100 completed reflections: ${completed === 0 ? "n/a" : ((created / completed) * 100).toFixed(1)}`,
    "",
    "Capabilities",
    `  ${String(report.capabilities.length)} learned, ${String(report.capabilities.filter((capability) => capability.state === "active").length)} active, ${String(report.capabilities.filter((capability) => capability.state === "paused").length)} paused`,
    `  ${String(neverJudged)} never judged in use`,
    `  Judged uses of current revisions: ${String(judged)}. Helped ${String(helped)} (${percent(helped, judged)}), hurt ${String(hurt)} (${percent(hurt, judged)})`,
    "",
  ];
  for (const capability of report.capabilities) {
    lines.push(
      `  ${capability.name}`,
      `    ${capability.state}, ${capability.activationMode}, ${String(capability.revisions)} revision(s), evidence: ${capability.evidenceKind ?? "not recorded"}`,
      `    helped ${String(capability.helped)}, hurt ${String(capability.hurt)}, unclear ${String(capability.unclear)}, automatic pauses ${String(capability.automaticPauses)}, restores ${String(capability.restores)}`,
    );
  }
  return lines.join("\n");
}
