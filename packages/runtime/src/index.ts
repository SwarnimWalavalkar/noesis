import type {
  AgentContextUsage,
  AgentRuntimeEvent,
  AgentThinkingLevel,
  FrozenTurnPlan,
} from "@noesis/agent-types";
import type { ContextSnapshot } from "@noesis/context";
import type { JsonValue, TrailStatus } from "@noesis/domain";

export * from "./coordinator-contracts.ts";
export * from "./coordinator.ts";
export * from "./coordinator-composition.ts";
export * from "./preflight-policy.ts";
export * from "./atomic-activation.ts";
export * from "./protected-activation.ts";
export * from "./continuous-feedback.ts";
export * from "./compounding-metrics.ts";
export * from "./control-plane.ts";
export * from "./turn-intelligence.ts";
export * from "./turn-settlement.ts";
export * from "./transcript.ts";
export * from "./scheduled-execution.ts";

export interface RuntimeTranscriptMessage {
  readonly kind: "message";
  readonly messageId: string;
  readonly turnId?: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly createdAt: string;
}

export interface RuntimeTranscriptAction {
  readonly kind: "action";
  readonly actionId: string;
  /** Monotonic session-local order assigned when the action is first persisted. */
  readonly sequence?: number;
  readonly turnId?: string;
  readonly parentActionId?: string;
  readonly executionId?: string;
  readonly name: string;
  readonly status: "running" | "completed" | "failed" | "denied" | "ambiguous" | "cancelled" | "interrupted";
  readonly input?: JsonValue;
  readonly update?: JsonValue;
  readonly output?: JsonValue;
  readonly startedAt: string;
  readonly completedAt?: string;
}

export type RuntimeTranscriptEntry = RuntimeTranscriptMessage | RuntimeTranscriptAction;

export interface TrailState {
  readonly trailId: string;
  readonly parentTrailId?: string;
  readonly title: string;
  readonly status: TrailStatus;
  readonly provider: string;
  readonly model: string;
  readonly runtime: string;
  readonly contextSnapshotId?: string;
  readonly context?: ContextSnapshot;
  readonly capabilityVersions: Readonly<Record<string, number>>;
  readonly turns: readonly { readonly input: string; readonly output: string }[];
}

export interface TrailSummary {
  readonly trailId: string;
  readonly parentTrailId?: string;
  readonly title: string;
  readonly status: TrailStatus;
  readonly provider: string;
  readonly model: string;
  readonly runtime: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turnCount: number;
  readonly messageCount: number;
  readonly preview: string;
}

export interface TrailRecency {
  readonly trailId: string;
  readonly updatedAt: string;
}

/** Newest activity first, with a stable trail-ID tie-break. */
export function compareTrailRecency(left: TrailRecency, right: TrailRecency): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.trailId.localeCompare(right.trailId);
}

/** Maximum number of recent sessions returned for interactive selection. */
export const SESSION_PICKER_LIMIT = 100;

export interface StartTrailInput {
  readonly title: string;
  readonly provider?: string;
  readonly model?: string;
}

export interface RunTurnOptions {
  readonly onEvent?: (event: AgentRuntimeEvent) => void;
  readonly thinkingLevel?: AgentThinkingLevel;
}

export interface RuntimeAgentDefaults {
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: AgentThinkingLevel;
}

export interface TurnResult {
  readonly outcome: "completed" | "aborted";
  readonly output: string;
  readonly context: ContextSnapshot;
  readonly usedCapabilities: Readonly<Record<string, number>>;
  readonly contextUsage?: AgentContextUsage;
  readonly frozenTurnPlan?: FrozenTurnPlan;
}

/**
 * Adapter-neutral product runtime interface. The application composition root provides the only
 * production implementation; tests may supply narrow in-memory adapters at this seam.
 */
export interface NoesisRuntime {
  readonly agentDefaults: RuntimeAgentDefaults;
  readonly startTrail: (input: StartTrailInput) => Promise<TrailState>;
  readonly listTrails: () => readonly TrailState[];
  /** Returns at most SESSION_PICKER_LIMIT sessions, newest activity first. */
  readonly listTrailSummaries: () => readonly TrailSummary[];
  readonly getTrail: (trailId: string) => TrailState;
  /** Loads the SQLite-authoritative conversation and action projection for this session. */
  readonly getTranscript: (trailId: string) => Promise<readonly RuntimeTranscriptEntry[]>;
  readonly resumeTrail: (trailId: string) => Promise<TrailState>;
  readonly forkTrail: (trailId: string, title?: string) => Promise<TrailState>;
  readonly runTurn: (trailId: string, input: string, options?: RunTurnOptions) => Promise<TurnResult>;
  readonly steer: (trailId: string, text: string) => Promise<void>;
  readonly followUp: (trailId: string, text: string) => Promise<void>;
  readonly abort: (trailId: string) => Promise<void>;
  readonly compact: (trailId: string) => Promise<void>;
}
