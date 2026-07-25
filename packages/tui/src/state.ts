import type { ContextSnapshot } from "@noesis/context";
import type { RuntimeAgentDefaults, TrailState } from "@noesis/runtime";

export type Pane = "trail" | "context" | "capabilities";

export interface TuiMessage {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
}

export type ExecutionState = "idle" | "thinking" | "streaming" | "tool" | "compacting" | "aborting" | "error";

export interface TuiContextUsage {
  readonly usedTokens: number;
  readonly contextWindow: number;
  readonly accuracy: "reported" | "estimated";
}

export interface NoesisTuiState {
  readonly trailId?: string;
  readonly title: string;
  readonly execution: ExecutionState;
  readonly provider: string;
  readonly model: string;
  readonly reasoningLevel: RuntimeAgentDefaults["thinkingLevel"];
  readonly runtime: string;
  readonly pane: Pane;
  readonly messages: readonly TuiMessage[];
  readonly context?: ContextSnapshot;
  readonly contextUsage?: TuiContextUsage;
  readonly turnCount: number;
  readonly capabilityVersions: Readonly<Record<string, number>>;
  readonly colorEnabled: boolean;
  readonly activeTool?: string;
  readonly error?: string;
}

export type NoesisTuiAction =
  | { readonly type: "trail-selected"; readonly trail: TrailState }
  | { readonly type: "prompt-submitted"; readonly text: string }
  | { readonly type: "stream-delta"; readonly text: string }
  | { readonly type: "stream-reconciled"; readonly text: string }
  | { readonly type: "tool-started"; readonly name: string }
  | { readonly type: "tool-ended" }
  | { readonly type: "execution-changed"; readonly execution: ExecutionState }
  | {
      readonly type: "model-metadata";
      readonly provider: string;
      readonly model: string;
      readonly contextWindow: number;
    }
  | ({ readonly type: "usage-updated" } & TuiContextUsage)
  | {
      readonly type: "turn-completed";
      readonly context: ContextSnapshot;
      readonly capabilityVersions: Readonly<Record<string, number>>;
      readonly turnCount: number;
      readonly contextUsage?: TuiContextUsage;
    }
  | { readonly type: "turn-aborted" }
  | { readonly type: "compacted" }
  | { readonly type: "pane-selected"; readonly pane: Pane }
  | { readonly type: "failed"; readonly error: string }
  | { readonly type: "system-message"; readonly text: string };

export const initialTuiState = (
  runtime: string,
  options: {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningLevel?: RuntimeAgentDefaults["thinkingLevel"];
    readonly colorEnabled?: boolean;
  } = {},
): NoesisTuiState => ({
  title: "Noesis session",
  execution: "idle",
  provider: options.provider ?? "fake",
  model: options.model ?? "noesis-fake-1",
  reasoningLevel: options.reasoningLevel ?? "off",
  runtime,
  pane: "trail",
  messages: [],
  turnCount: 0,
  capabilityVersions: {},
  colorEnabled: options.colorEnabled ?? false,
});

export function reduceTui(state: NoesisTuiState, action: NoesisTuiAction): NoesisTuiState {
  switch (action.type) {
    case "trail-selected": {
      const {
        activeTool: _activeTool,
        context: _context,
        contextUsage: _contextUsage,
        error: _error,
        ...rest
      } = state;
      return {
        ...rest,
        trailId: action.trail.trailId,
        title: action.trail.title,
        provider: action.trail.provider,
        model: action.trail.model,
        messages: action.trail.turns.flatMap((turn) => [
          { role: "user" as const, text: turn.input },
          { role: "assistant" as const, text: turn.output },
        ]),
        ...(action.trail.context ? { context: action.trail.context } : {}),
        capabilityVersions: { ...action.trail.capabilityVersions },
        turnCount: action.trail.turns.length,
        execution: "idle",
      };
    }
    case "prompt-submitted": {
      const { error: _error, ...rest } = state;
      return {
        ...rest,
        execution: "thinking",
        messages: [...state.messages, { role: "user", text: action.text }, { role: "assistant", text: "" }],
      };
    }
    case "stream-delta": {
      const messages = [...state.messages];
      const last = messages.at(-1);
      if (last?.role === "assistant")
        messages[messages.length - 1] = { ...last, text: last.text + action.text };
      return { ...state, execution: "streaming", messages };
    }
    case "stream-reconciled": {
      const messages = [...state.messages];
      const last = messages.at(-1);
      if (last?.role === "assistant") messages[messages.length - 1] = { ...last, text: action.text };
      return { ...state, messages };
    }
    case "tool-started":
      return { ...state, execution: "tool", activeTool: action.name };
    case "tool-ended": {
      const { activeTool: _activeTool, ...rest } = state;
      return {
        ...rest,
        execution: state.messages.at(-1)?.text ? "streaming" : "thinking",
      };
    }
    case "execution-changed": {
      const { activeTool: _activeTool, ...rest } = state;
      return { ...rest, execution: action.execution };
    }
    case "model-metadata":
      return { ...state, provider: action.provider, model: action.model };
    case "usage-updated":
      return {
        ...state,
        contextUsage: {
          usedTokens: action.usedTokens,
          contextWindow: action.contextWindow,
          accuracy: action.accuracy,
        },
      };
    case "turn-completed": {
      const { contextUsage: _contextUsage, ...rest } = state;
      return {
        ...rest,
        execution: "idle",
        context: action.context,
        turnCount: action.turnCount,
        ...(action.contextUsage ? { contextUsage: action.contextUsage } : {}),
        capabilityVersions: { ...action.capabilityVersions },
      };
    }
    case "turn-aborted": {
      const messages = [...state.messages];
      if (messages.at(-1)?.role === "assistant" && !messages.at(-1)?.text) messages.pop();
      return { ...state, execution: "idle", messages };
    }
    case "compacted": {
      const { contextUsage: _contextUsage, ...rest } = state;
      return { ...rest, execution: "idle" };
    }
    case "pane-selected":
      return { ...state, pane: action.pane };
    case "failed":
      return { ...state, execution: "error", error: action.error };
    case "system-message":
      return { ...state, messages: [...state.messages, { role: "system", text: action.text }] };
  }
}
