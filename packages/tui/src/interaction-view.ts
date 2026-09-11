import { createConditionalObject } from "@noesis/domain";
import type { TuiInteractionSnapshot } from "./runtime-port.ts";
import type { TuiInteractionView } from "./state.ts";

export function interactionViewFromSnapshot(snapshot: TuiInteractionSnapshot): TuiInteractionView {
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return createConditionalObject({
    phase: snapshot.phase,
    queuePaused: snapshot.queuePaused,
  } as const)
    .addOptional(snapshot.active ? { active: { ...snapshot.active } } : undefined)
    .add({
      queuedInputs: snapshot.pending.map((input) =>
        createConditionalObject({
          queueId: input.intentId,
          text: input.text,
          createdAt: input.createdAt,
          status: input.status,
        })
          .addOptional(input.attachments ? { attachments: input.attachments } : undefined)
          .finish(),
      ),
    } as const)
    .finish();
}
