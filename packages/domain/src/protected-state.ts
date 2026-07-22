import type { JsonValue, StableEffectOperationAttempt } from "./index.ts";
import type { DatabaseRowRef, EvidenceRevisionRef, FileRevisionRef } from "./research.ts";

export interface ActivationWriteRequest {
  readonly activationId: string;
  readonly expectedRevision: number;
  readonly activeDefinitions: Readonly<Record<string, FileRevisionRef>>;
  readonly previousActivationId: string | null;
  readonly preflightEvidence: EvidenceRevisionRef;
}

export interface ProtectedActivationStatePort {
  readonly activate: (request: ActivationWriteRequest) => Promise<DatabaseRowRef>;
  readonly revert: (activationId: string, expectedRevision: number) => Promise<DatabaseRowRef>;
}

export interface ProtectedAuthorityStatePort {
  readonly reserveEffect: (operation: StableEffectOperationAttempt) => Promise<DatabaseRowRef>;
  readonly completeEffect: (
    operationId: string,
    result: JsonValue,
    evidenceRefs: readonly EvidenceRevisionRef[],
  ) => Promise<void>;
  readonly failEffect: (
    operationId: string,
    reason: string,
    evidenceRefs: readonly EvidenceRevisionRef[],
  ) => Promise<void>;
}

/** Kept out of the root domain export so generated roles cannot receive protected mutation ports by accident. */
export interface ProtectedWorkspaceState {
  readonly activation: ProtectedActivationStatePort;
  readonly authority: ProtectedAuthorityStatePort;
}
