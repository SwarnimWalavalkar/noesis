import type { AgentRuntimeRequest, FrozenTurnPlan } from "@noesis/agent-types";
import { renderFrozenConversationHistoryContent } from "@noesis/agent-types";
import { createConditionalObject } from "@noesis/domain";
import { projectComposerAttachmentImages } from "@noesis/runtime";
import type { NoesisWorkspaceStore } from "@noesis/workspace";

/** Resolve only retained image bytes, once per request. Frozen plans retain artifact references. */
export async function resolveAttachmentHistory(
  workspace: NoesisWorkspaceStore,
  plan: FrozenTurnPlan,
  validateImages?: (images: readonly { mimeType: string; data: string }[]) => void,
): Promise<NonNullable<AgentRuntimeRequest["history"]>> {
  const history: NonNullable<AgentRuntimeRequest["history"]>[number][] = [];
  if (plan.contextCheckpoint)
    history.push({
      role: "assistant",
      content: plan.contextCheckpoint.summary,
      createdAt: plan.contextCheckpoint.createdAt,
    });
  for (const entry of plan.conversationHistory ?? []) {
    const attachments = entry.attachments ?? [];
    const projection = await projectComposerAttachmentImages(workspace, attachments, validateImages);
    history.push(
      createConditionalObject({
        role: entry.role,
        content: renderFrozenConversationHistoryContent(entry),
        createdAt: entry.createdAt,
      })
        .addOptional(
          attachments.length > 0
            ? {
                attachments,
                images: projection.images,
                omittedImageArtifactIds: projection.omittedArtifactIds,
              }
            : undefined,
        )
        .finish(),
    );
  }
  return Object.freeze(history);
}
