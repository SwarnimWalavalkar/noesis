import {
  type CapabilityLifecycleRevision,
  createConditionalObject,
  type DurableJobRecord,
} from "@noesis/domain";
import { CAPABILITY_REFLECTION_JOB_KIND, SESSION_REVIEW_JOB_KIND } from "@noesis/runtime";
import type { NoesisWorkspaceStore } from "@noesis/workspace";
import { z } from "zod";

const UsageSchema = z.looseObject({ totalTokens: z.number(), estimatedCost: z.number() });
const ReflectionResultSchema = z.looseObject({ status: z.string(), usage: UsageSchema.optional() });
const ReviewResultSchema = z.looseObject({
  status: z.string(),
  usage: UsageSchema.optional(),
  results: z.array(z.looseObject({ status: z.string() })).optional(),
});
const JOB_PAGE_LIMIT = 1000;
const ADOPTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type EvidenceKind = NonNullable<CapabilityLifecycleRevision["evidence"]>["kind"];

export interface LearningReportCapability {
  readonly capabilityId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly state: "active" | "paused";
  readonly activationMode: "relevant" | "always";
  readonly evidenceKind?: EvidenceKind;
  readonly revisions: number;
  /** Judged outcomes in the window, across all of the Capability's revisions. */
  readonly helped: number;
  readonly hurt: number;
  readonly unclear: number;
  /** True when a turn used the Capability within 30 days of its creation. */
  readonly usedWithin30Days: boolean;
  readonly automaticPauses: number;
  readonly restores: number;
}

/** Counts read from SQLite. Models made each judgment; the report only counts and divides. */
export interface LearningReport {
  /** The start of the window, or undefined for all recorded history. */
  readonly since?: string;
  readonly reflections: {
    readonly total: number;
    readonly waitingForReply: number;
    readonly failed: number;
    /** Completed reflections by their publication status, e.g. no_change or activated. */
    readonly results: Readonly<Record<string, number>>;
    readonly tokens: number;
    readonly estimatedCost: number;
  };
  readonly sessionReviews: {
    readonly completed: number;
    readonly publications: number;
    readonly tokens: number;
    readonly estimatedCost: number;
  };
  /** Capabilities created in the window, by the kind of evidence their first revision named. */
  readonly evidenceKinds: Readonly<Partial<Record<EvidenceKind | "not recorded", number>>>;
  readonly capabilities: readonly LearningReportCapability[];
}

const within = (timestamp: string, since: string | undefined): boolean =>
  since === undefined || timestamp >= since;

/** Every job of a kind in the window, newest first, read page by page. */
async function listJobs(
  workspace: NoesisWorkspaceStore,
  kind: string,
  since: string | undefined,
): Promise<readonly DurableJobRecord[]> {
  const jobs: DurableJobRecord[] = [];
  let page = await workspace.jobs.listPage({ kind, order: "newest", limit: JOB_PAGE_LIMIT });
  for (;;) {
    const inWindow = page.records.filter((job) => within(job.createdAt, since));
    jobs.push(...inWindow);
    if (page.exhausted || !page.nextCursor || inWindow.length < page.records.length) return jobs;
    page = await workspace.jobs.listPage({
      kind,
      order: "newest",
      limit: JOB_PAGE_LIMIT,
      after: page.nextCursor,
    });
  }
}

export async function computeLearningReport(
  workspace: NoesisWorkspaceStore,
  options: { readonly sinceDays?: number; readonly now?: Date } = {},
): Promise<LearningReport> {
  const now = options.now ?? new Date();
  const since =
    options.sinceDays === undefined
      ? undefined
      : new Date(now.getTime() - options.sinceDays * DAY_MS).toISOString();
  const [reflections, reviews] = await Promise.all([
    listJobs(workspace, CAPABILITY_REFLECTION_JOB_KIND, since),
    listJobs(workspace, SESSION_REVIEW_JOB_KIND, since),
  ]);
  const results: Record<string, number> = {};
  let reflectionTokens = 0;
  let reflectionCost = 0;
  for (const job of reflections) {
    if (job.status !== "completed") continue;
    const parsed = ReflectionResultSchema.safeParse(job.result);
    const status = parsed.success ? parsed.data.status : "unknown";
    results[status] = (results[status] ?? 0) + 1;
    reflectionTokens += parsed.success ? (parsed.data.usage?.totalTokens ?? 0) : 0;
    reflectionCost += parsed.success ? (parsed.data.usage?.estimatedCost ?? 0) : 0;
  }
  let reviewsCompleted = 0;
  let reviewPublications = 0;
  let reviewTokens = 0;
  let reviewCost = 0;
  for (const job of reviews) {
    if (job.status !== "completed") continue;
    const parsed = ReviewResultSchema.safeParse(job.result);
    if (!parsed.success || parsed.data.status !== "reviewed") continue;
    reviewsCompleted += 1;
    reviewPublications += (parsed.data.results ?? []).filter(
      (result) => result.status !== "no_change" && result.status !== "stale",
    ).length;
    reviewTokens += parsed.data.usage?.totalTokens ?? 0;
    reviewCost += parsed.data.usage?.estimatedCost ?? 0;
  }

  const definitions = await workspace.capabilities.listDefinitions();
  const bindings = await workspace.capabilities.getBindings(
    definitions.map((definition) => definition.capabilityId),
  );
  const bindingById = new Map(bindings.map((binding) => [binding.capabilityId, binding] as const));
  const evidenceKinds: Partial<Record<EvidenceKind | "not recorded", number>> = {};
  const capabilities = await Promise.all(
    definitions.flatMap((definition) => {
      const binding = bindingById.get(definition.capabilityId);
      if (!binding) return [];
      return [
        (async (): Promise<LearningReportCapability> => {
          const [revisions, current, feedback, counts] = await Promise.all([
            workspace.capabilities.listRevisions(definition.capabilityId),
            workspace.capabilities.getRevision(binding.revision),
            workspace.capabilities.listFeedback(definition.capabilityId),
            workspace.capabilities.outcomeCounts(definition.capabilityId, since),
          ]);
          // listRevisions without a limit returns the oldest revision first.
          const first = revisions[0];
          if (within(definition.createdAt, since)) {
            const kind = first?.evidence?.kind ?? "not recorded";
            evidenceKinds[kind] = (evidenceKinds[kind] ?? 0) + 1;
          }
          const adoptionEnd = new Date(
            Date.parse(definition.createdAt) + ADOPTION_DAYS * DAY_MS,
          ).toISOString();
          const report: LearningReportCapability = {
            capabilityId: definition.capabilityId,
            name: definition.name,
            createdAt: definition.createdAt,
            state: binding.state,
            activationMode: binding.activationMode,
            revisions: revisions.length,
            helped: counts.helped,
            hurt: counts.hurt,
            unclear: counts.unclear,
            usedWithin30Days: counts.firstAt !== undefined && counts.firstAt <= adoptionEnd,
            automaticPauses: feedback.filter(
              (item) => item.disposition === "regression" && within(item.createdAt, since),
            ).length,
            restores: feedback.filter(
              (item) => item.disposition === "restore_request" && within(item.createdAt, since),
            ).length,
          };
          return current?.evidence ? { ...report, evidenceKind: current.evidence.kind } : report;
        })(),
      ];
    }),
  );
  return Object.freeze(
    createConditionalObject({} as const)
      .addOptional(since === undefined ? undefined : { since })
      .add({
        reflections: Object.freeze({
          total: reflections.length,
          waitingForReply: reflections.filter((job) => job.status === "scheduled").length,
          failed: reflections.filter((job) => job.status === "failed" || job.status === "budget_exhausted")
            .length,
          results: Object.freeze(results),
          tokens: reflectionTokens,
          estimatedCost: reflectionCost,
        }),
        sessionReviews: Object.freeze({
          completed: reviewsCompleted,
          publications: reviewPublications,
          tokens: reviewTokens,
          estimatedCost: reviewCost,
        }),
        evidenceKinds: Object.freeze(evidenceKinds),
        capabilities: Object.freeze(capabilities),
      } as const)
      .finish(),
  );
}

const percent = (part: number, whole: number): string =>
  whole === 0 ? "n/a" : `${String(Math.round((part / whole) * 100))}%`;
const perUnit = (amount: number, count: number, digits: number): string =>
  count === 0 ? "n/a" : (amount / count).toFixed(digits);

export function formatLearningReport(report: LearningReport, now: Date = new Date()): string {
  const completed = Object.values(report.reflections.results).reduce((total, count) => total + count, 0);
  const noChange = report.reflections.results["no_change"] ?? 0;
  const created = report.reflections.results["activated"] ?? 0;
  const revised = report.reflections.results["revised"] ?? 0;
  const sum = (pick: (capability: LearningReportCapability) => number): number =>
    report.capabilities.reduce((total, capability) => total + pick(capability), 0);
  const helped = sum((capability) => capability.helped);
  const hurt = sum((capability) => capability.hurt);
  const judged = helped + hurt + sum((capability) => capability.unclear);
  const adoptionCutoff = new Date(now.getTime() - ADOPTION_DAYS * DAY_MS).toISOString();
  const oldEnough = report.capabilities.filter((capability) => capability.createdAt <= adoptionCutoff);
  const changed = report.capabilities.filter(
    (capability) => capability.automaticPauses > 0 || capability.restores > 0,
  ).length;
  const lines = [
    `Noesis learning report · ${report.since ? `since ${report.since.slice(0, 10)}` : "all recorded history"}`,
    "",
    "Reflections",
    `  ${String(report.reflections.total)} recorded, ${String(report.reflections.waitingForReply)} waiting for a reply, ${String(report.reflections.failed)} failed`,
    `  ${String(noChange)} no change (${percent(noChange, completed)}), ${String(created)} created, ${String(revised)} revised`,
    `  Capabilities created per 100 completed reflections: ${perUnit(created * 100, completed, 1)}`,
    `  Tokens per reflection: ${perUnit(report.reflections.tokens, completed, 0)} · per creation: ${perUnit(report.reflections.tokens, created, 0)}`,
    `  Estimated cost: ${report.reflections.estimatedCost.toFixed(4)} total · ${perUnit(report.reflections.estimatedCost, completed, 4)} per reflection · ${perUnit(report.reflections.estimatedCost, created, 4)} per creation`,
    `  Session reviews: ${String(report.sessionReviews.completed)} completed, ${String(report.sessionReviews.publications)} changes, ${String(report.sessionReviews.tokens)} tokens, estimated cost ${report.sessionReviews.estimatedCost.toFixed(4)}`,
    "",
    "Evidence for Capabilities created in this period",
    ...Object.entries(report.evidenceKinds).map(([kind, count]) => `  ${kind}: ${String(count)}`),
    "",
    "Capabilities",
    `  ${String(report.capabilities.length)} learned, ${String(report.capabilities.filter((capability) => capability.state === "active").length)} active, ${String(report.capabilities.filter((capability) => capability.state === "paused").length)} paused`,
    `  Judged uses: ${String(judged)}. Helped ${String(helped)} (${percent(helped, judged)}), hurt ${String(hurt)} (${percent(hurt, judged)})`,
    `  Corrections after learning (hurt uses, where the user corrected behavior a Capability caused): ${percent(hurt, judged)}`,
    `  Paused automatically or restored: ${String(changed)} of ${String(report.capabilities.length)} (${percent(changed, report.capabilities.length)})`,
    `  Used within ${String(ADOPTION_DAYS)} days of creation: ${String(oldEnough.filter((capability) => capability.usedWithin30Days).length)} of ${String(oldEnough.length)} old enough to tell`,
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
