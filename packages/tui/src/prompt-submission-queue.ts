export interface PromptSubmissionQueue {
  readonly gate: (text: string) => "ready" | "queued" | "blocked";
  readonly runExclusive: (
    work: Promise<void>,
    options: Readonly<{
      canDrain: () => boolean;
      submit: (text: string) => Promise<void>;
      onCommandFailure: (error: unknown) => void;
      onPromptFailure: (error: unknown) => void;
    }>,
  ) => void;
  readonly activeWork: () => Promise<void> | undefined;
  readonly clear: () => void;
}

type ExclusivePromptOptions = Parameters<PromptSubmissionQueue["runExclusive"]>[1];

/** Serializes prompts that arrive while a session-changing command owns the TUI. */
export function createPromptSubmissionQueue(): PromptSubmissionQueue {
  const pending: string[] = [];
  let drainPromise: Promise<void> | undefined;
  let activeWork: Promise<void> | undefined;

  const drain = async (
    submit: (text: string) => Promise<void>,
    onFailure: (error: unknown) => void,
  ): Promise<void> => {
    if (drainPromise) return drainPromise;
    drainPromise = (async () => {
      while (pending.length > 0) {
        const text = pending.shift();
        if (text === undefined) continue;
        try {
          await submit(text);
        } catch (error) {
          onFailure(error);
        }
      }
    })().finally(() => {
      drainPromise = undefined;
    });
    return drainPromise;
  };

  return Object.freeze({
    gate: (text: string) => {
      if (!activeWork && !drainPromise && pending.length === 0) return "ready";
      const command = text.trim();
      if (command === "?" || command.startsWith("/")) return "blocked";
      pending.push(text);
      return "queued";
    },
    runExclusive: (work: Promise<void>, options: ExclusivePromptOptions) => {
      if (activeWork) throw new Error("An exclusive command is already active.");
      const settled = work.catch(options.onCommandFailure).finally(async () => {
        activeWork = undefined;
        if (options.canDrain()) await drain(options.submit, options.onPromptFailure);
      });
      activeWork = settled;
      void settled;
    },
    activeWork: () => activeWork,
    clear: () => pending.splice(0),
  });
}
