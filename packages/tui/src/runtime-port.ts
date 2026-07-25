import type { NoesisRuntime } from "@noesis/runtime";

export type NoesisTuiRuntime = Pick<
  NoesisRuntime,
  | "agentDefaults"
  | "startTrail"
  | "listTrailSummaries"
  | "getTrail"
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
};
