import type { NoesisAgentRuntime } from "@noesis/agent-types";
import { compileContext } from "@noesis/context";
import {
  compareTrailRecency,
  SESSION_PICKER_LIMIT,
  type NoesisRuntime,
  type RuntimeTranscriptEntry,
  type TrailState,
  type TrailSummary,
} from "@noesis/runtime";

export interface TestNoesisRuntime extends NoesisRuntime {
  readonly resumedTrailIds: readonly string[];
  readonly failedTurnCount: number;
}

interface StoredTrail {
  state: TrailState;
  readonly createdAt: string;
  updatedAt: string;
}

export function createInMemoryTestRuntime(agent: NoesisAgentRuntime): TestNoesisRuntime {
  const trails = new Map<string, StoredTrail>();
  const resumedTrailIds: string[] = [];
  let sequence = 0;
  let failedTurnCount = 0;
  const timestamp = (): string => new Date(Date.now() + sequence).toISOString();
  const getStored = (trailId: string): StoredTrail => {
    const trail = trails.get(trailId);
    if (!trail) throw new Error(`Trail not found: ${trailId}`);
    return trail;
  };
  const replaceState = (stored: StoredTrail, state: TrailState): TrailState => {
    stored.state = Object.freeze(state);
    stored.updatedAt = timestamp();
    return stored.state;
  };
  const startTrail: NoesisRuntime["startTrail"] = async (input) => {
    sequence += 1;
    const trailId = `trail_test_${String(sequence).padStart(4, "0")}`;
    const createdAt = timestamp();
    const state: TrailState = Object.freeze({
      trailId,
      title: input.title,
      status: "idle",
      provider: input.provider ?? "test-provider",
      model: input.model ?? "test-model",
      runtime: agent.name,
      capabilityVersions: Object.freeze({}),
      turns: Object.freeze([]),
    });
    trails.set(trailId, { state, createdAt, updatedAt: createdAt });
    return state;
  };
  const listTrails = (): readonly TrailState[] =>
    Object.freeze([...trails.values()].map(({ state }) => state));
  const getTrail = (trailId: string): TrailState => getStored(trailId).state;
  const getTranscript = async (trailId: string): Promise<readonly RuntimeTranscriptEntry[]> => {
    const stored = getStored(trailId);
    return Object.freeze(
      stored.state.turns.flatMap((turn, index): readonly RuntimeTranscriptEntry[] => {
        const turnId = `${trailId}:turn:${String(index)}`;
        return [
          Object.freeze({
            kind: "message",
            messageId: `${turnId}:user`,
            turnId,
            role: "user",
            text: turn.input,
            createdAt: stored.createdAt,
          }),
          Object.freeze({
            kind: "message",
            messageId: `${turnId}:assistant`,
            turnId,
            role: "assistant",
            text: turn.output,
            createdAt: stored.updatedAt,
          }),
        ];
      }),
    );
  };
  const listTrailSummaries = (): readonly TrailSummary[] =>
    Object.freeze(
      [...trails.values()]
        .map(({ state, createdAt, updatedAt }) =>
          Object.freeze({
            trailId: state.trailId,
            ...(state.parentTrailId === undefined ? {} : { parentTrailId: state.parentTrailId }),
            title: state.title,
            status: state.status,
            provider: state.provider,
            model: state.model,
            runtime: state.runtime,
            createdAt,
            updatedAt,
            turnCount: state.turns.length,
            messageCount: state.turns.length * 2,
            preview: state.turns.at(-1)?.input ?? "",
          }),
        )
        .sort(compareTrailRecency)
        .slice(0, SESSION_PICKER_LIMIT),
    );
  const resumeTrail: NoesisRuntime["resumeTrail"] = async (trailId) => {
    const stored = getStored(trailId);
    if (stored.state.status === "running")
      throw new Error(`Session ${trailId} is already running and cannot be resumed`);
    resumedTrailIds.push(trailId);
    stored.updatedAt = timestamp();
    return stored.state;
  };
  const forkTrail: NoesisRuntime["forkTrail"] = async (trailId, title) => {
    const parent = getStored(trailId).state;
    const forked = await startTrail({
      title: title ?? `${parent.title} (fork)`,
      provider: parent.provider,
      model: parent.model,
    });
    const stored = getStored(forked.trailId);
    return replaceState(
      stored,
      Object.freeze({
        ...forked,
        parentTrailId: parent.trailId,
        turns: Object.freeze([...parent.turns]),
      }),
    );
  };
  const runTurn: NoesisRuntime["runTurn"] = async (trailId, input, options = {}) => {
    const stored = getStored(trailId);
    if (stored.state.status === "running") throw new Error(`Session ${trailId} is already running`);
    replaceState(stored, Object.freeze({ ...stored.state, status: "running" }));
    const context = compileContext(
      [
        {
          id: `${trailId}:user`,
          kind: "user",
          content: input,
          provenance: ["test"],
          priority: 100,
        },
      ],
      stored.state.capabilityVersions,
      { maxTokens: 4_000, maxFragmentTokens: 4_000 },
    );
    const result = await (async () => {
      try {
        return await agent.run(
          {
            trailId,
            provider: stored.state.provider,
            model: stored.state.model,
            thinkingLevel: options.thinkingLevel ?? "off",
            systemPrompt: "",
            prompt: input,
            activeCapabilities: [],
          },
          (event) => options.onEvent?.(event),
        );
      } catch (error) {
        replaceState(stored, Object.freeze({ ...stored.state, status: "idle" }));
        throw error;
      }
    })();
    if (result.outcome === "failed") {
      failedTurnCount += 1;
      replaceState(stored, Object.freeze({ ...stored.state, status: "failed" }));
      throw new Error(result.error);
    }
    if (result.outcome === "aborted") {
      replaceState(stored, Object.freeze({ ...stored.state, status: "idle" }));
      return Object.freeze({
        outcome: "aborted",
        output: result.text,
        context,
        usedCapabilities: Object.freeze({}),
        ...(result.contextUsage === undefined ? {} : { contextUsage: result.contextUsage }),
      });
    }
    replaceState(
      stored,
      Object.freeze({
        ...stored.state,
        status: "idle",
        contextSnapshotId: context.snapshotId,
        context,
        turns: Object.freeze([...stored.state.turns, Object.freeze({ input, output: result.text })]),
      }),
    );
    return Object.freeze({
      outcome: "completed",
      output: result.text,
      context,
      usedCapabilities: Object.freeze({}),
      ...(result.contextUsage === undefined ? {} : { contextUsage: result.contextUsage }),
    });
  };

  return Object.freeze({
    agentDefaults: Object.freeze({
      provider: "test-provider",
      model: "test-model",
      thinkingLevel: "off",
    }),
    startTrail,
    listTrails,
    listTrailSummaries,
    getTrail,
    getTranscript,
    resumeTrail,
    forkTrail,
    runTurn,
    steer: agent.steer,
    followUp: agent.followUp,
    abort: agent.abort,
    compact: async () => undefined,
    get resumedTrailIds() {
      return Object.freeze([...resumedTrailIds]);
    },
    get failedTurnCount() {
      return failedTurnCount;
    },
  });
}
