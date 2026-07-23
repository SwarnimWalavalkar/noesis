import type {
  DatabaseRowRef,
  EvidenceRevisionRef,
  JsonValue,
  StableEffectOperationAttempt,
} from "@noesis/domain";

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
