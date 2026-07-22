import type { CapabilityRevision, DatabaseRowRef } from "@noesis/domain";
import {
  CapabilityRevisionSchema,
  PreflightReportSchema,
  capabilityRevisionRef,
  sameCapabilityRevisionRef,
} from "@noesis/domain";

export interface ActivationWriteRequest {
  readonly activationId: string;
  readonly expectedRevision: number;
  readonly materializedRevision: CapabilityRevision;
  readonly previousActivationId: string | null;
  readonly preflightReportRef: DatabaseRowRef<"preflight_reports">;
}

export interface ProtectedActivationStatePort {
  readonly activate: (request: ActivationWriteRequest) => Promise<DatabaseRowRef<"activation_pointers">>;
  readonly revert: (
    activationId: string,
    expectedRevision: number,
  ) => Promise<DatabaseRowRef<"activation_pointers">>;
}

export interface RecordedPreflightReportReadPort {
  readonly readPreflightReport: (ref: DatabaseRowRef<"preflight_reports">) => Promise<unknown | undefined>;
}

export async function activationIsBoundToPreflight(
  request: ActivationWriteRequest,
  preflights: RecordedPreflightReportReadPort,
): Promise<boolean> {
  const recordedReport = await preflights.readPreflightReport(request.preflightReportRef);
  const revision = CapabilityRevisionSchema.safeParse(request.materializedRevision);
  const report = PreflightReportSchema.safeParse(recordedReport);
  if (!revision.success || !report.success) return false;

  return (
    request.preflightReportRef.table === "preflight_reports" &&
    request.preflightReportRef.rowId === report.data.preflightId &&
    report.data.decision === "pass" &&
    sameCapabilityRevisionRef(
      capabilityRevisionRef(request.materializedRevision),
      report.data.candidateRevision,
    )
  );
}
