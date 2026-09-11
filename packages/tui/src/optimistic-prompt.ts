import { createConditionalObject, type ComposerAttachment } from "@noesis/domain";
import type { TuiAttachmentLabel } from "./state.ts";
import type { NoesisView } from "./rendering.ts";
import type { TuiInteractionView } from "./state.ts";

export interface OptimisticPromptEcho {
  readonly echoIfIdle: (
    interaction: TuiInteractionView,
    trailId: string,
    text: string,
    attachments?: readonly TuiAttachmentLabel[],
  ) => string | undefined;
  readonly admit: (
    trailId: string,
    text: string,
    turnId: string,
    attachments?: readonly ComposerAttachment[],
  ) => boolean;
  readonly rejectForTrail: (trailId: string) => boolean;
  readonly reject: (localSubmissionId: string) => boolean;
  readonly hasPending: () => boolean;
  readonly clear: () => void;
}

interface OptimisticPrompt {
  readonly localSubmissionId: string;
  readonly trailId: string;
  readonly text: string;
}

/**
 * Echoes one idle prompt before durable admission, then reconciles that view-only entry with the
 * runtime event. Durable turns remain the transcript authority.
 */
export function createOptimisticPromptEcho(
  view: NoesisView,
  requestRender: () => void,
): OptimisticPromptEcho {
  let sequence = 0;
  const pending: OptimisticPrompt[] = [];
  const take = (matches: (prompt: OptimisticPrompt) => boolean): OptimisticPrompt | undefined => {
    const index = pending.findIndex(matches);
    return index >= 0 ? pending.splice(index, 1)[0] : undefined;
  };
  const rejectPrompt = (prompt: OptimisticPrompt | undefined): boolean => {
    if (!prompt) return false;
    view.dispatch({ type: "prompt-rejected", localSubmissionId: prompt.localSubmissionId });
    requestRender();
    return true;
  };

  return {
    echoIfIdle(interaction, trailId, text, attachments) {
      if (interaction.phase !== "idle" || interaction.queuedInputs.length > 0 || pending.length > 0)
        return undefined;
      sequence += 1;
      const prompt = {
        localSubmissionId: `tui_submission_${String(sequence)}`,
        trailId,
        text,
      };
      pending.push(prompt);
      view.dispatch(
        createConditionalObject({
          type: "prompt-submitted" as const,
          text,
          localSubmissionId: prompt.localSubmissionId,
        })
          .addOptional(
            attachments
              ? { attachments: attachments.map(({ name, mimeType }) => ({ name, mimeType })) }
              : undefined,
          )
          .finish(),
      );
      requestRender();
      return prompt.localSubmissionId;
    },
    admit(trailId, text, turnId, attachments) {
      const prompt = take((candidate) => candidate.trailId === trailId && candidate.text === text);
      if (!prompt) return false;
      view.dispatch(
        createConditionalObject({
          type: "prompt-admitted" as const,
          localSubmissionId: prompt.localSubmissionId,
          turnId,
        })
          .addOptional(attachments ? { attachments } : undefined)
          .finish(),
      );
      return true;
    },
    rejectForTrail: (trailId) => rejectPrompt(take((prompt) => prompt.trailId === trailId)),
    reject: (localSubmissionId) =>
      rejectPrompt(take((prompt) => prompt.localSubmissionId === localSubmissionId)),
    hasPending: () => pending.length > 0,
    clear: () => {
      pending.length = 0;
    },
  };
}
