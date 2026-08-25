export type ExclusiveCommandScope = "current-session" | "resulting-session";

type BarrierInteractionCommand =
  | { readonly type: "enqueue"; readonly text: string }
  | {
      readonly type: "reroute-pending";
      readonly sourceSessionId: string;
      readonly intentIds: readonly string[];
    }
  | { readonly type: "pause-queue" }
  | { readonly type: "resume-queue" };

interface BarrierInteractionResult {
  readonly intentId?: string;
  readonly queueWasHeld?: boolean;
}

interface ActiveExclusiveCommand {
  readonly sourceSessionId: string;
  readonly scope: ExclusiveCommandScope;
  readonly queuedIntentIds: string[];
  reroutedIntentCount: number;
  destinationSessionId?: string;
  promptTail: Promise<void>;
  work: Promise<void>;
}

export interface ExclusiveCommandBarrier {
  readonly routeSubmission: (text: string) => "idle" | "queued" | "blocked";
  readonly start: (request: {
    readonly sourceSessionId: string;
    readonly scope: ExclusiveCommandScope;
    readonly execute: () => Promise<void>;
    readonly onCommandFailure: (cause: unknown) => void;
  }) => void;
  readonly prepareDestination: (sessionId: string) => Promise<void>;
  readonly activeWork: () => Promise<void> | undefined;
}

type ExclusiveCommandStart = Parameters<ExclusiveCommandBarrier["start"]>[0];

/**
 * Serializes session-changing commands while routing accepted prompts through the durable turn
 * queue. A resulting-session command first records prompts in its paused source queue, then
 * atomically reroutes those exact intents after the destination session exists.
 */
export function createExclusiveCommandBarrier(options: {
  readonly currentSessionId: () => string | undefined;
  readonly canDeliver: () => boolean;
  readonly interact: (
    sessionId: string,
    command: BarrierInteractionCommand,
  ) => Promise<BarrierInteractionResult>;
  readonly onPromptFailure: (cause: unknown) => void;
  readonly discardSessionIfEmpty?: (sessionId: string) => Promise<boolean>;
}): ExclusiveCommandBarrier {
  let active: ActiveExclusiveCommand | undefined;

  const reportPromptFailure = (cause: unknown): void => {
    try {
      options.onPromptFailure(cause);
    } catch {
      // Presentation failures never own later prompt delivery.
    }
  };

  const enqueueOnSource = (state: ActiveExclusiveCommand, text: string): void => {
    state.promptTail = state.promptTail
      .then(async () => {
        const result = await options.interact(state.sourceSessionId, { type: "enqueue", text });
        if (result.intentId === undefined) throw new Error("The durable queue did not identify its intent");
        state.queuedIntentIds.push(result.intentId);
      })
      .catch(reportPromptFailure);
  };

  const enqueueOnDestination = (state: ActiveExclusiveCommand, text: string): void => {
    const sessionId = state.destinationSessionId;
    if (!sessionId) throw new Error("The destination session has not been prepared");
    state.promptTail = state.promptTail
      .then(async () => {
        await options.interact(sessionId, { type: "enqueue", text });
      })
      .catch(reportPromptFailure);
  };

  return Object.freeze({
    routeSubmission: (text: string) => {
      const state = active;
      if (!state) return "idle";
      const command = text.trim();
      if (command === "?" || command.startsWith("/")) return "blocked";
      if (state.destinationSessionId) enqueueOnDestination(state, text);
      else enqueueOnSource(state, text);
      return "queued";
    },
    start: (request: ExclusiveCommandStart) => {
      if (active) throw new Error("An exclusive command is already active");
      const state: ActiveExclusiveCommand = {
        sourceSessionId: request.sourceSessionId,
        scope: request.scope,
        queuedIntentIds: [],
        reroutedIntentCount: 0,
        promptTail: Promise.resolve(),
        work: Promise.resolve(),
      };
      active = state;
      state.work = (async () => {
        let commandFailure: unknown;
        let sourceQueueWasHeld = false;
        try {
          const paused = await options.interact(request.sourceSessionId, { type: "pause-queue" });
          sourceQueueWasHeld = paused.queueWasHeld === true;
          try {
            await request.execute();
          } catch (error) {
            commandFailure = error;
          }

          while (true) {
            const tail = state.promptTail;
            await tail;
            if (tail !== state.promptTail) continue;
            break;
          }

          const releases: Promise<BarrierInteractionResult>[] = [];
          if (!sourceQueueWasHeld && options.canDeliver())
            releases.push(options.interact(request.sourceSessionId, { type: "resume-queue" }));
          if (state.destinationSessionId && options.canDeliver())
            releases.push(options.interact(state.destinationSessionId, { type: "resume-queue" }));
          if (active === state) active = undefined;
          await Promise.all(releases);
          if (state.destinationSessionId) await options.discardSessionIfEmpty?.(state.sourceSessionId);
        } catch (error) {
          if (commandFailure === undefined) commandFailure = error;
        } finally {
          if (active === state) active = undefined;
        }
        if (commandFailure !== undefined) throw commandFailure;
      })();
      void state.work.then(undefined, (cause: unknown) => {
        try {
          request.onCommandFailure(cause);
        } catch {
          // Presentation failures never own the serialized command lifecycle.
        }
      });
    },
    prepareDestination: async (sessionId: string) => {
      const state = active;
      if (
        !state ||
        state.scope !== "resulting-session" ||
        sessionId === state.sourceSessionId ||
        state.destinationSessionId === sessionId
      )
        return;
      await options.interact(sessionId, { type: "pause-queue" });
      while (true) {
        const tail = state.promptTail;
        await tail;
        const intentIds = state.queuedIntentIds.slice(state.reroutedIntentCount);
        if (intentIds.length > 0) {
          await options.interact(sessionId, {
            type: "reroute-pending",
            sourceSessionId: state.sourceSessionId,
            intentIds: Object.freeze(intentIds),
          });
          state.reroutedIntentCount += intentIds.length;
        }
        if (tail !== state.promptTail || state.reroutedIntentCount !== state.queuedIntentIds.length) continue;
        state.destinationSessionId = sessionId;
        return;
      }
    },
    activeWork: () => active?.work,
  });
}
