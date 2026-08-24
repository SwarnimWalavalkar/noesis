import type {
  CoordinatorEvidenceRef,
  InteractionCommand,
  InteractionDispatchResult,
  InteractionSnapshot,
  NoesisRuntime,
  TurnInteractionEvent,
} from "@noesis/runtime";

export type TuiInteractionCommand = InteractionCommand;
export type TuiInteractionSnapshot = InteractionSnapshot;
export type TuiInteractionEvent = TurnInteractionEvent;
export type TuiInteractionResult = InteractionDispatchResult;

export const stopVisibleInteraction = (turnId?: string): TuiInteractionCommand =>
  turnId ? { type: "interrupt", turnId } : { type: "pause-queue" };

export interface TuiSkillSummary {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly filePath: string;
  readonly contentDigest: string;
  readonly disableModelInvocation: boolean;
}

export interface TuiSkillDetail extends TuiSkillSummary {
  readonly content: string;
}

export interface TuiExecutionSummary {
  readonly kind: "codemode" | "workflow" | "subagent";
  readonly executionId: string;
  readonly label: string;
  readonly status: "running" | "paused" | "completed" | "failed" | "cancelled" | "interrupted";
  readonly toolNames: readonly string[];
  readonly callCount: number;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly program?: {
    readonly mode: "script";
    readonly projectId: string;
    readonly name: string;
    readonly revision: number;
    readonly definitionRevisionId: string;
  };
}

export interface TuiExecutionArtifact {
  readonly artifactId: string;
  readonly path: string;
  readonly mediaType: string;
  readonly preview: string;
  readonly truncated: boolean;
}

export interface TuiProgramSummary {
  readonly mode: "script" | "workflow";
  readonly name: string;
  readonly description: string;
  readonly revision: number;
  readonly definitionDigest: string;
  readonly workingPath: string;
  readonly sourceDigest?: string;
  readonly sourceWorkingPath?: string;
  readonly requiredTools: readonly string[];
  readonly phaseNames: readonly string[];
}

export interface TuiProgramDetail extends TuiProgramSummary {
  readonly inputSchema: string;
  readonly outputSchema: string;
  readonly source?: string;
  readonly phases?: readonly {
    readonly name: string;
    readonly description: string;
    readonly requiredTools: readonly string[];
    readonly source: string;
  }[];
}

export interface TuiExecutionDetail extends TuiExecutionSummary {
  readonly parentExecutionId?: string;
  readonly catalogDigest?: string;
  readonly sourceDigest?: string;
  readonly sourceArtifact?: TuiExecutionArtifact;
  readonly stdoutArtifact?: TuiExecutionArtifact;
  readonly stderrArtifact?: TuiExecutionArtifact;
  readonly result?: string;
  readonly error?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly systemPrompt?: string;
  readonly prompt?: string;
  readonly phases?: readonly {
    readonly index: number;
    readonly name: string;
    readonly status: string;
    readonly executionId?: string;
    readonly error?: string;
  }[];
}

export interface TuiLearningActivitySummary {
  readonly jobId: string;
  readonly stage: "reflection" | "authoring" | "preflight";
  readonly status:
    | "queued"
    | "running"
    | "completed"
    | "no_change"
    | "adjusted"
    | "activated"
    | "revised"
    | "pending"
    | "paused"
    | "restored"
    | "binding_changed"
    | "replaced"
    | "unapplied"
    | "stale"
    | "failed";
  readonly summary: string;
  readonly updatedAt: string;
  readonly turnId?: string;
  readonly experimentId?: string;
  readonly capabilityId?: string;
  readonly capabilityRevisionId?: string;
  readonly capabilityBundleDigest?: string;
  readonly projectId?: string;
  readonly adjustmentId?: string;
  readonly activeAdjustmentId?: string;
  readonly evidenceRefs?: readonly CoordinatorEvidenceRef[];
  readonly workingAdjustment?: TuiWorkingAdjustmentState;
  readonly failure?: string;
}

export interface TuiWorkingAdjustmentEvidenceSummary {
  readonly planId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly outcomeId: string;
  readonly outcome: "accepted" | "corrected" | "failed" | "unknown";
  readonly summary: string;
  readonly settledAt: string;
}

export interface TuiWorkingAdjustmentState {
  readonly adjustmentId: string;
  readonly projectId: string;
  readonly status: "active" | "inactive";
  readonly strategy: string;
  readonly successSignal: string;
  readonly servedEvidence: readonly TuiWorkingAdjustmentEvidenceSummary[];
}

export interface TuiLearningInspection {
  readonly activity: readonly TuiLearningActivitySummary[];
  readonly currentWorkingAdjustment?: TuiWorkingAdjustmentState;
}

export type TuiLearningPrimitiveKind =
  | "criterion"
  | "capability"
  | "capability_feedback"
  | "capability_gate"
  | "reflection"
  | "working_adjustment"
  | "experiment"
  | "capability_revision"
  | "preflight_plan"
  | "trial"
  | "evaluation"
  | "preflight_report"
  | "activation"
  | "approval"
  | "feedback_signal"
  | "observation"
  | "outcome_research"
  | "experiment_outcome"
  | "successor_lineage"
  | "job";

export type TuiLearningPrimitiveGroup =
  | "capabilities"
  | "memory"
  | "reflection"
  | "history"
  | "evaluation"
  | "activation"
  | "feedback"
  | "operations";

export type TuiCapabilityKind =
  | "instruction"
  | "skill"
  | "tool"
  | "workflow"
  | "router"
  | "model_configuration"
  | "harness_configuration"
  | "core_update"
  | "composite";

/** Exact mechanisms produced by the current Capability revision. */
export type TuiCapabilityFacet = "instruction" | "skill" | "program";

export interface TuiLearningRelation {
  readonly label: string;
  readonly targetId: string;
  readonly targetTitle?: string;
}

export interface TuiLearningDetailEntry {
  readonly label?: string;
  readonly value: string;
}

export interface TuiLearningDetailSection {
  readonly title: string;
  readonly entries: readonly TuiLearningDetailEntry[];
}

export interface TuiLearningEvidencePreview {
  readonly identity: string;
  readonly label: string;
  readonly excerpt: string;
  readonly occurredAt?: string;
  readonly redacted: boolean;
}

export interface TuiLearningPrimitive {
  readonly id: string;
  readonly kind: TuiLearningPrimitiveKind;
  readonly group: TuiLearningPrimitiveGroup;
  readonly status: string;
  readonly tone: "neutral" | "positive" | "active" | "pending" | "negative";
  readonly title: string;
  readonly summary: string;
  readonly occurredAt?: string;
  readonly sessionId?: string;
  readonly projectId?: string;
  readonly experimentId?: string;
  readonly capabilityId?: string;
  readonly capabilityRevisionId?: string;
  readonly capabilityBundleDigest?: string;
  readonly capabilityBindingRevision?: number;
  readonly capabilityFacets?: readonly TuiCapabilityFacet[];
  /** Historical authoring label. Current records use capabilityFacets. */
  readonly capabilityKind?: TuiCapabilityKind;
  readonly capabilityState?: "active" | "paused";
  readonly capabilityActivationMode?: "relevant" | "always";
  readonly capabilityScope?: "global" | "project" | "session";
  readonly gateRequestId?: string;
  readonly evidence: readonly string[];
  readonly evidencePreviews: readonly TuiLearningEvidencePreview[];
  readonly consideredEvidenceCount: number;
  readonly consideredEvidencePreviews: readonly TuiLearningEvidencePreview[];
  readonly relations: readonly TuiLearningRelation[];
  readonly detailSections: readonly TuiLearningDetailSection[];
  /** Bounded, sensitivity-aware projection of the authoritative record. */
  readonly rawJson: string;
}

export interface TuiLearningAuditSnapshot {
  readonly projectId: string;
  readonly sessionId: string;
  readonly generatedAt: string;
  readonly activeAdjustmentId?: string;
  readonly activeActivationId?: string;
  readonly primitives: readonly TuiLearningPrimitive[];
}

export type TuiCapabilityManagementIntent =
  | { readonly type: "pause"; readonly capabilityId: string; readonly expectedBindingRevision: number }
  | { readonly type: "resume"; readonly capabilityId: string; readonly expectedBindingRevision: number }
  | {
      readonly type: "set-activation-mode";
      readonly capabilityId: string;
      readonly mode: "relevant" | "always";
      readonly expectedBindingRevision: number;
    }
  | {
      readonly type: "set-scope";
      readonly capabilityId: string;
      readonly scope: "global" | "project";
      readonly expectedBindingRevision: number;
    }
  | {
      readonly type: "set-scope";
      readonly capabilityId: string;
      readonly scope: "session";
      readonly sessionId: string;
      readonly expectedBindingRevision: number;
    }
  | {
      readonly type: "restore";
      readonly capabilityId: string;
      readonly target: {
        readonly kind: "capability_revision";
        readonly capabilityId: string;
        readonly capabilityRevisionId: string;
        readonly bundleDigest: string;
      };
      readonly expectedBindingRevision: number;
    }
  | { readonly type: "approve"; readonly gateRequestId: string }
  | { readonly type: "deny"; readonly gateRequestId: string }
  | { readonly type: "change"; readonly gateRequestId: string; readonly instruction: string };

export interface TuiCapabilityManagementResult {
  readonly status: "activated" | "revised" | "pending" | "paused" | "restored" | "binding_changed" | "stale";
  readonly capabilityId: string;
  readonly message: string;
}

export type TuiMcpScope = "global" | "project";
export type TuiMcpServerStatus =
  | "disabled"
  | "connecting"
  | "connected"
  | "auth_required"
  | "failed"
  | "overridden";

export interface TuiMcpCapabilityCounts {
  readonly tools: number;
  readonly prompts: number;
  readonly resources: number;
  readonly resourceTemplates: number;
}

export interface TuiMcpServerSummary {
  readonly name: string;
  readonly scope: TuiMcpScope;
  readonly sourcePath: string;
  readonly enabled: boolean;
  readonly type: "local" | "remote";
  readonly status: TuiMcpServerStatus;
  readonly capabilityCounts: TuiMcpCapabilityCounts;
  /** True when this row is hidden by a project entry with the same name. */
  readonly shadowed?: boolean;
  readonly lastError?: string;
}

export interface TuiMcpToolDetail {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
}

export interface TuiMcpPromptDetail {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly required?: boolean;
  }[];
}

export interface TuiMcpResourceDetail {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface TuiMcpResourceTemplateDetail {
  readonly uriTemplate: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface TuiMcpRecentError {
  readonly message: string;
  readonly occurredAt?: string;
  readonly operation?: string;
}

export type TuiMcpServerConfig =
  | {
      readonly type: "local";
      readonly command: readonly string[];
      readonly cwd?: string;
      readonly environmentReferences?: Readonly<Record<string, string>>;
    }
  | {
      readonly type: "remote";
      readonly url: string;
      readonly oauth: boolean;
      readonly headers?: Readonly<Record<string, string>>;
    };

export interface TuiMcpServerDetail extends TuiMcpServerSummary {
  readonly config: TuiMcpServerConfig;
  readonly instructions?: string;
  readonly negotiatedCapabilities: readonly string[];
  readonly tools: readonly TuiMcpToolDetail[];
  readonly prompts: readonly TuiMcpPromptDetail[];
  readonly resources: readonly TuiMcpResourceDetail[];
  readonly resourceTemplates: readonly TuiMcpResourceTemplateDetail[];
  readonly recentErrors: readonly TuiMcpRecentError[];
}

export type TuiMcpMutationIntent =
  | {
      readonly type: "add-local";
      readonly scope: TuiMcpScope;
      readonly name: string;
      readonly command: readonly string[];
    }
  | {
      readonly type: "add-remote";
      readonly scope: TuiMcpScope;
      readonly name: string;
      readonly url: string;
      readonly oauth: boolean;
    }
  | {
      readonly type: "edit-local";
      readonly scope: TuiMcpScope;
      readonly name: string;
      readonly command: readonly string[];
    }
  | {
      readonly type: "edit-remote";
      readonly scope: TuiMcpScope;
      readonly name: string;
      readonly url: string;
      readonly oauth: boolean;
    }
  | {
      readonly type: "authenticate" | "logout" | "reconnect" | "remove";
      readonly scope: TuiMcpScope;
      readonly name: string;
    }
  | {
      readonly type: "set-enabled";
      readonly scope: TuiMcpScope;
      readonly name: string;
      readonly enabled: boolean;
    }
  | { readonly type: "reload" };

export interface TuiMcpMutationResult {
  readonly message: string;
  /** The runtime may already open this URL; the TUI still renders it as a copyable fallback. */
  readonly browserUrl?: string;
}

export type NoesisTuiRuntime = Pick<
  NoesisRuntime,
  | "agentDefaults"
  | "startTrail"
  | "listTrailSummaries"
  | "getTrail"
  | "getTranscript"
  | "interact"
  | "inspectInteraction"
  | "resumeTrail"
  | "forkTrail"
  | "compact"
> & {
  readonly home?: string;
  readonly agentName?: string;
  readonly listSkills?: () => Promise<readonly TuiSkillSummary[]>;
  readonly inspectSkill?: (name: string) => Promise<TuiSkillDetail | undefined>;
  readonly listPrograms?: () => Promise<readonly TuiProgramSummary[]>;
  readonly inspectProgram?: (
    mode: "script" | "workflow",
    name: string,
  ) => Promise<TuiProgramDetail | undefined>;
  readonly listExecutions?: (sessionId: string) => Promise<readonly TuiExecutionSummary[]>;
  readonly inspectExecution?: (
    sessionId: string,
    executionId: string,
  ) => Promise<TuiExecutionDetail | undefined>;
  readonly listLearningActivity?: (sessionId: string) => Promise<readonly TuiLearningActivitySummary[]>;
  readonly inspectLearning?: (sessionId: string) => Promise<TuiLearningInspection>;
  readonly inspectLearningAudit?: (sessionId: string) => Promise<TuiLearningAuditSnapshot>;
  readonly manageCapability?: (
    intent: TuiCapabilityManagementIntent,
  ) => Promise<TuiCapabilityManagementResult>;
  readonly waitForLearningActivity?: (
    sessionId: string,
    jobId: string,
  ) => Promise<TuiLearningActivitySummary | undefined>;
  readonly listMcpServers?: () => Promise<readonly TuiMcpServerSummary[]>;
  readonly inspectMcpServer?: (scope: TuiMcpScope, name: string) => Promise<TuiMcpServerDetail | undefined>;
  readonly mutateMcp?: (intent: TuiMcpMutationIntent, signal?: AbortSignal) => Promise<TuiMcpMutationResult>;
};
