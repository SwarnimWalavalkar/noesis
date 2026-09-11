import type { AgentRuntimeRequest, FrozenTurnPlan } from "@noesis/agent-types";
import { renderFrozenConversationHistoryContent } from "@noesis/agent-types";
import { COMPOSER_ATTACHMENT_LIMITS, createConditionalObject } from "@noesis/domain";
import { renderComposerAttachmentText, resolveComposerAttachmentImages } from "@noesis/runtime";
import type { NoesisWorkspaceStore } from "@noesis/workspace";

/** Resolve only retained image bytes, once per request. Frozen plans retain artifact references. */
export async function resolveAttachmentHistory(
  workspace: NoesisWorkspaceStore,
  plan: FrozenTurnPlan,
): Promise<NonNullable<AgentRuntimeRequest["history"]>> {
  const history: NonNullable<AgentRuntimeRequest["history"]>[number][] = [];
  if (plan.contextCheckpoint)
    history.push({
      role: "assistant",
      content: plan.contextCheckpoint.summary,
      createdAt: plan.contextCheckpoint.createdAt,
    });
  let imageBytes = 0;
  for (const entry of plan.conversationHistory ?? []) {
    const attachments = entry.attachments ?? [];
    const images = await resolveComposerAttachmentImages(workspace, attachments);
    imageBytes += images.reduce((total, image) => total + Buffer.byteLength(image.data, "base64"), 0);
    if (imageBytes > COMPOSER_ATTACHMENT_LIMITS.totalBytes)
      throw new Error("Retained images exceed 20 MiB. Run /compact before continuing.");
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
                images,
                attachmentText: renderComposerAttachmentText("", attachments, workspace.paths.root),
              }
            : undefined,
        )
        .finish(),
    );
  }
  return Object.freeze(history);
}
