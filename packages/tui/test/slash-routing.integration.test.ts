import { createPiAgentRuntime } from "@noesis/runtime-pi";
import { describe, expect, test, vi } from "vitest";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  createControlledPiModels,
  type ControlledPiPrompt,
} from "../../runtime-pi/test/support/controlled-pi-models.ts";
import { startNoesisTui } from "../src/index.ts";
import type { NoesisTuiRuntime } from "../src/runtime-port.ts";
import { createInMemoryTestRuntime } from "./support/in-memory-runtime.ts";
import { createTestTerminal } from "./support/test-terminal.ts";

function userMessages(prompt: ControlledPiPrompt): string[] {
  return prompt.context.messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
    );
}

function fixture(
  options: {
    readonly respond?: (prompt: ControlledPiPrompt) => Promise<string>;
    readonly decorate?: (runtime: ReturnType<typeof createInMemoryTestRuntime>) => NoesisTuiRuntime;
  } = {},
) {
  // Only persistence/inspection is in memory: every model turn and steer uses Pi AgentHarness.
  // Snapshot at request time because the live Pi conversation can grow after a response.
  const requests: string[][] = [];
  const contexts: string[] = [];
  const controlled = createControlledPiModels({
    tokensPerSecond: 100_000,
    respond: async (prompt) => {
      requests.push(userMessages(prompt));
      contexts.push(JSON.stringify(prompt.context));
      return options.respond ? await options.respond(prompt) : "Controlled reply";
    },
  });
  const base = createInMemoryTestRuntime(createPiAgentRuntime(process.cwd(), controlled.models));
  const runtime = options.decorate?.(base) ?? base;
  const terminal = createTestTerminal();
  const running = startNoesisTui(
    runtime,
    { provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL },
    terminal,
    () => Promise.resolve(),
  );
  const sessionId = (): string => {
    const trail = base.listTrails()[0];
    if (!trail) throw new Error("Expected an initial TUI session");
    return trail.trailId;
  };
  return {
    base,
    terminal,
    requests,
    contexts,
    sessionId,
    ready: async () => await vi.waitFor(() => expect(terminal.output).toContain("● IDLE")),
    idle: async (id = sessionId()) => {
      await vi.waitFor(async () => {
        const interaction = await base.inspectInteraction(id);
        expect(interaction.phase).toBe("idle");
        expect(interaction.pending).toEqual([]);
      });
    },
    feedback: async (command: string, expected: string) => {
      const offset = terminal.output.length;
      terminal.type(`${command}\r`);
      await vi.waitFor(() => expect(terminal.output.slice(offset)).toContain(expected));
    },
    close: async () => {
      terminal.send("\u0003");
      await running;
    },
  };
}

const localCommands = [
  { input: "/skill", feedback: "Usage: /skill <name>" },
  { input: "/program", feedback: "Usage: /program <script|workflow> <name>" },
  { input: "/program script", feedback: "Usage: /program <script|workflow> <name>" },
  { input: "/program invalid example", feedback: "Usage: /program <script|workflow> <name>" },
  { input: "/run", feedback: "Usage: /run <execution-id>" },
  { input: "/queue invalid", feedback: "Use /queue resume." },
  { input: "/skills", feedback: "Skill inspection is unavailable" },
  { input: "/programs", feedback: "Program inspection is unavailable" },
  { input: "/runs", feedback: "Run inspection is unavailable" },
];

describe("TUI slash routing through a credential-free Pi provider", () => {
  test.each(["idle", "active"])(
    "local feedback remains visible while %s and never reaches provider messages",
    async (phase) => {
      const release = Promise.withResolvers<void>();
      const app = fixture({
        respond: async () => {
          if (phase === "active") await release.promise;
          return "Controlled reply";
        },
      });
      try {
        await app.ready();
        if (phase === "active") {
          app.terminal.type("hold the current turn\r");
          await vi.waitFor(() => expect(app.requests).toHaveLength(1));
          expect((await app.base.inspectInteraction(app.sessionId())).phase).toBe("running");
        }
        for (const command of localCommands) {
          await app.feedback(command.input, command.feedback);
          expect(app.requests).toHaveLength(phase === "active" ? 1 : 0);
          expect((await app.base.inspectInteraction(app.sessionId())).pending).toEqual([]);
        }
        release.resolve();
        await app.idle();
        app.terminal.type("ordinary follow-up\r");
        await vi.waitFor(() => expect(app.requests).toHaveLength(phase === "active" ? 2 : 1));
        await app.idle();
        // Check full provider histories, not merely whether a command initiated a request.
        for (const messages of app.requests) {
          for (const message of messages) {
            expect(["hold the current turn", "ordinary follow-up"]).toContain(message);
          }
        }
        for (const context of app.contexts) {
          for (const command of localCommands) expect(context).not.toContain(command.feedback);
        }
        expect(app.requests.at(-1)?.at(-1)).toBe("ordinary follow-up");
        expect(app.base.failedTurnCount).toBe(0);
      } finally {
        release.resolve();
        await app.close();
      }
    },
  );

  test("unknown slash prefixes, command mentions in prose, and skill invocation spellings pass unchanged", async () => {
    const app = fixture();
    const inputs = [
      "/help explain this rather than opening help",
      "Please discuss /skill, /program, and /run without invoking them.",
      "  /unrecognized preserve outer spaces  ",
      "/refine preserve this instruction",
      "/skill:run explicit command-name collision",
    ];
    try {
      await app.ready();
      for (const [index, input] of inputs.entries()) {
        app.terminal.type(`${input}\r`);
        await vi.waitFor(() => expect(app.requests).toHaveLength(index + 1));
        expect(app.requests.at(-1)?.at(-1)).toBe(input);
        await app.idle();
      }
      expect(app.requests.map((messages) => messages.at(-1))).toEqual(inputs);
      expect(app.base.failedTurnCount).toBe(0);
    } finally {
      await app.close();
    }
  });

  test("delayed local inspection feedback survives queued slash prompts and other local commands during a turn", async () => {
    const releaseResponse = Promise.withResolvers<void>();
    const inspectionStarted = Promise.withResolvers<void>();
    const releaseInspection = Promise.withResolvers<void>();
    const app = fixture({
      respond: async () => {
        await releaseResponse.promise;
        return "Controlled reply";
      },
      decorate: (base) => ({
        ...base,
        inspectSkill: async () => {
          inspectionStarted.resolve();
          await releaseInspection.promise;
          return undefined;
        },
      }),
    });
    const inputs = ["/unknown queued during turn", "Please explain /run in prose."];
    try {
      await app.ready();
      app.terminal.type("hold active work\r");
      await vi.waitFor(() => expect(app.requests).toHaveLength(1));
      app.terminal.type("/skill missing-routing-fixture\r");
      await inspectionStarted.promise;
      for (const input of inputs) app.terminal.type(`${input}\r`);
      await app.feedback("/run", "Usage: /run <execution-id>");
      await vi.waitFor(async () => {
        const snapshot = await app.base.inspectInteraction(app.sessionId());
        expect(snapshot.phase).toBe("running");
        expect(snapshot.pending.map((intent) => intent.text)).toEqual(inputs);
      });
      const offset = app.terminal.output.length;
      releaseInspection.resolve();
      await vi.waitFor(() =>
        expect(app.terminal.output.slice(offset)).toContain("Unknown skill: missing-routing-fixture"),
      );
      expect(app.requests).toEqual([["hold active work"]]);
      releaseResponse.resolve();
      await vi.waitFor(() => expect(app.requests).toHaveLength(3));
      await app.idle();
      expect(app.requests.map((messages) => messages.at(-1))).toEqual(["hold active work", ...inputs]);
      for (const messages of app.requests) {
        for (const message of messages) expect(["hold active work", ...inputs]).toContain(message);
      }
      expect(app.base.failedTurnCount).toBe(0);
    } finally {
      releaseInspection.resolve();
      releaseResponse.resolve();
      await app.close();
    }
  });

  test.each(["explicit", "queued"])(
    "/steer injects only its %s payload into the active Pi conversation",
    async (mode) => {
      const release = Promise.withResolvers<void>();
      let responses = 0;
      const interactions = vi.fn<NoesisTuiRuntime["interact"]>();
      const app = fixture({
        respond: async () => {
          responses += 1;
          if (responses === 1) await release.promise;
          return "Controlled reply";
        },
        decorate: (base) => {
          interactions.mockImplementation(base.interact);
          return { ...base, interact: interactions };
        },
      });
      try {
        await app.ready();
        app.terminal.type("begin active work\r");
        await vi.waitFor(() => expect(app.requests).toHaveLength(1));
        if (mode === "queued") {
          app.terminal.type("change direction with /run mentioned literally\r");
          await vi.waitFor(async () =>
            expect((await app.base.inspectInteraction(app.sessionId())).pending).toHaveLength(1),
          );
          app.terminal.type("/steer\r");
        } else app.terminal.type("/steer change direction with /run mentioned literally\r");
        await vi.waitFor(() =>
          expect(interactions).toHaveBeenCalledWith(
            app.sessionId(),
            mode === "queued"
              ? { type: "steer" }
              : { type: "steer", text: "change direction with /run mentioned literally" },
            expect.anything(),
          ),
        );
        release.resolve();
        await vi.waitFor(() => expect(app.requests).toHaveLength(2));
        await app.idle();
        expect(app.requests[0]).toEqual(["begin active work"]);
        expect(app.requests[1]).toEqual([
          "begin active work",
          "change direction with /run mentioned literally",
        ]);
        expect(app.base.getTrail(app.sessionId()).turns).toHaveLength(1);
        expect(app.base.failedTurnCount).toBe(0);
      } finally {
        release.resolve();
        await app.close();
      }
    },
  );

  test.each(["/compact", "/fork"])(
    "local commands run during %s while unknown slash prompts wait for the correct session",
    async (exclusive) => {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const app = fixture({
        decorate: (base) => ({
          ...base,
          compact: async (...args) => {
            started.resolve();
            await release.promise;
            return await base.compact(...args);
          },
          forkTrail: async (...args) => {
            started.resolve();
            await release.promise;
            return await base.forkTrail(...args);
          },
        }),
      });
      const inputs = ["/unknown queued  verbatim", "/skill:run queued skill instructions"];
      try {
        await app.ready();
        const sourceId = app.sessionId();
        app.terminal.type(`${exclusive}\r`);
        await started.promise;
        await app.feedback("/skill", "Usage: /skill <name>");
        await app.feedback("/program", "Usage: /program <script|workflow> <name>");
        await app.feedback("/run", "Usage: /run <execution-id>");
        await app.feedback("/queue resume", "A command is active.");
        for (const input of inputs) app.terminal.type(`${input}\r`);
        await vi.waitFor(async () => {
          const snapshot = await app.base.inspectInteraction(sourceId);
          expect(snapshot.queuePaused).toBe(true);
          expect(snapshot.pending.map((intent) => intent.text)).toEqual(inputs);
        });
        expect(app.requests).toEqual([]);
        release.resolve();
        await vi.waitFor(() => expect(app.requests).toHaveLength(inputs.length));
        const destination =
          exclusive === "/fork"
            ? app.base.listTrails().find((trail) => trail.parentTrailId === sourceId)
            : app.base.getTrail(sourceId);
        if (!destination) throw new Error("Expected the command's destination session");
        await app.idle(destination.trailId);
        expect(app.requests.map((messages) => messages.at(-1))).toEqual(inputs);
        expect(app.base.getTrail(destination.trailId).turns.map((turn) => turn.input)).toEqual(inputs);
        for (const messages of app.requests) {
          for (const message of messages) expect(inputs).toContain(message);
        }
        expect(app.base.failedTurnCount).toBe(0);
      } finally {
        release.resolve();
        await app.close();
      }
    },
  );
});
