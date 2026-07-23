import { canonicalJson, sha256, type WorkspaceStore } from "@noesis/domain";
import type { GeneratedToolArtifactSink } from "./contracts.ts";

export type ToolRuntimeWorkspacePorts = Pick<WorkspaceStore, "artifacts" | "evidence">;

/** AC-00 WorkspaceStore adapter; source, lock, and trace bytes retain one canonical artifact authority. */
export function createWorkspaceToolArtifactSink(
  workspace: ToolRuntimeWorkspacePorts,
): GeneratedToolArtifactSink {
  const recordSource: GeneratedToolArtifactSink["recordSource"] = async (request) => {
    const runDirectory = sha256(canonicalJson({ runId: request.runId, toolId: request.toolId })).slice(0, 24);
    const [source] = await Promise.all([
      workspace.artifacts.writeArtifact({
        path: `generated-tools/${runDirectory}/source.mjs`,
        mediaType: "text/javascript",
        bytes: request.source,
        actor: request.actor,
        relationshipRefs: [],
      }),
      workspace.artifacts.writeArtifact({
        path: `generated-tools/${runDirectory}/pnpm-lock.yaml`,
        mediaType: "application/yaml",
        bytes: request.dependencyLock,
        actor: request.actor,
        relationshipRefs: [],
      }),
    ]);
    return source;
  };

  const recordTrace: GeneratedToolArtifactSink["recordTrace"] = async (request) => {
    const runDirectory = sha256(canonicalJson({ runId: request.runId, toolId: request.toolId })).slice(0, 24);
    return await workspace.evidence.appendEvidence({
      workingPath: `generated-tools/${runDirectory}/trace.json`,
      bytes: request.trace,
      actor: request.actor,
      reason: `Generated tool trace for ${request.toolId}`,
      evidenceKind: "tool_trace",
    });
  };

  return Object.freeze({ recordSource, recordTrace });
}
