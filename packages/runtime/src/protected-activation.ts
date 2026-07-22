import type {
  CapabilityRevisionRef,
  DatabaseRowRef,
  EvidenceRevisionRef,
  FileRevisionRef,
} from "@noesis/domain";
import { sameCapabilityRevisionRef } from "@noesis/domain";

export interface ActivationWriteRequest {
  readonly activationId: string;
  readonly expectedRevision: number;
  readonly capabilityRevision: CapabilityRevisionRef;
  readonly activeDefinitions: Readonly<Record<string, FileRevisionRef>>;
  readonly previousActivationId: string | null;
  readonly preflight: {
    readonly preflightId: string;
    readonly planId: string;
    readonly candidateRevision: CapabilityRevisionRef;
    readonly reportEvidence: EvidenceRevisionRef;
  };
}

export interface ProtectedActivationStatePort {
  readonly activate: (request: ActivationWriteRequest) => Promise<DatabaseRowRef>;
  readonly revert: (activationId: string, expectedRevision: number) => Promise<DatabaseRowRef>;
}

export function activationIsBoundToPreflight(request: ActivationWriteRequest): boolean {
  return sameCapabilityRevisionRef(request.capabilityRevision, request.preflight.candidateRevision);
}
