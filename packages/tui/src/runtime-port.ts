import type { NoesisRuntime } from "@noesis/runtime";

export interface TuiSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
  readonly contentDigest: string;
  readonly disableModelInvocation: boolean;
}

export interface TuiSkillDetail extends TuiSkillSummary {
  readonly content: string;
}

export interface TuiExecutionSummary {
  readonly kind: "codemode" | "workflow";
  readonly executionId: string;
  readonly label: string;
  readonly status: "running" | "paused" | "completed" | "failed" | "cancelled" | "interrupted";
  readonly toolNames: readonly string[];
  readonly callCount: number;
  readonly startedAt: string;
  readonly completedAt?: string;
}

export interface TuiExecutionArtifact {
  readonly artifactId: string;
  readonly path: string;
  readonly mediaType: string;
  readonly preview: string;
  readonly truncated: boolean;
}

export interface TuiWorkflowSummary {
  readonly name: string;
  readonly description: string;
  readonly revision: number;
  readonly phaseNames: readonly string[];
  readonly definitionDigest: string;
  readonly workingPath: string;
}

export interface TuiWorkflowDetail extends TuiWorkflowSummary {
  readonly inputSchema: string;
  readonly outputSchema: string;
  readonly phases: readonly {
    readonly name: string;
    readonly description: string;
    readonly requiredTools: readonly string[];
    readonly source: string;
  }[];
}

export interface TuiScriptSummary {
  readonly name: string;
  readonly description: string;
  readonly revision: number;
  readonly requiredTools: readonly string[];
  readonly sourceDigest: string;
  readonly workingPath: string;
}

export interface TuiScriptDetail extends TuiScriptSummary {
  readonly source: string;
  readonly inputSchema: string;
  readonly outputSchema: string;
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
  readonly phases?: readonly {
    readonly index: number;
    readonly name: string;
    readonly status: string;
    readonly executionId?: string;
    readonly error?: string;
  }[];
}

export type NoesisTuiRuntime = Pick<
  NoesisRuntime,
  | "agentDefaults"
  | "startTrail"
  | "listTrailSummaries"
  | "getTrail"
  | "getTranscript"
  | "resumeTrail"
  | "forkTrail"
  | "runTurn"
  | "steer"
  | "followUp"
  | "abort"
  | "compact"
> & {
  readonly home?: string;
  readonly agentName?: string;
  readonly listSkills?: () => Promise<readonly TuiSkillSummary[]>;
  readonly inspectSkill?: (name: string) => Promise<TuiSkillDetail | undefined>;
  readonly listScripts?: () => Promise<readonly TuiScriptSummary[]>;
  readonly inspectScript?: (name: string) => Promise<TuiScriptDetail | undefined>;
  readonly listWorkflows?: () => Promise<readonly TuiWorkflowSummary[]>;
  readonly inspectWorkflow?: (name: string) => Promise<TuiWorkflowDetail | undefined>;
  readonly listExecutions?: (sessionId: string) => Promise<readonly TuiExecutionSummary[]>;
  readonly inspectExecution?: (
    sessionId: string,
    executionId: string,
  ) => Promise<TuiExecutionDetail | undefined>;
};
