import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNoesisConfig } from "@noesis/config";
import { createPiAgentRuntime, createPiSubAgentTaskRunner } from "@noesis/runtime-pi";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  controlledToolCallResponse,
  createControlledPiModels,
  type ControlledPiPrompt,
} from "../../../packages/runtime-pi/test/support/controlled-pi-models.ts";
import { createScriptedAgentRoleRunner } from "../../../packages/runtime-pi/test/support/scripted-role-runner.ts";
import { createApplicationRuntimeComposition } from "../src/runtime-composition.ts";

const roots: string[] = [];
const RESPONSE_BUDGET = 400;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

type Context = ControlledPiPrompt["context"];
type AssistantMessage = ReturnType<typeof controlledToolCallResponse>;

const toolNames = (context: Context): readonly string[] => (context.tools ?? []).map((tool) => tool.name);

/**
 * Run one foreground `execute` program against a controlled provider and return its value. `child`
 * answers every subagent request; the foreground runs `source` once and then ends its turn.
 */
async function runProgram(
  source: string,
  child: (prompt: ControlledPiPrompt) => string | AssistantMessage | Promise<string | AssistantMessage>,
): Promise<{ readonly value: unknown; readonly error: string | undefined }> {
  const home = await mkdtemp(join(tmpdir(), "noesis-subagent-exact-tools-"));
  roots.push(home);
  const config = await resolveNoesisConfig({
    home,
    env: Object.freeze({}),
    cli: Object.freeze({ provider: CONTROLLED_PI_PROVIDER, model: CONTROLLED_PI_MODEL }),
  });
  let value: unknown;
  let error: string | undefined;
  const controlled = createControlledPiModels({
    responseBudget: RESPONSE_BUDGET,
    respond: async (prompt) => {
      if (prompt.systemPrompt.includes("subagent inside Noesis")) return await child(prompt);
      const last = prompt.context.messages.at(-1);
      if (last?.role !== "toolResult")
        return controlledToolCallResponse("execute", { source }, "call-foreground-program");
      const content = last.content[0];
      const text = content?.type === "text" ? content.text : "";
      if (last.isError) error = text;
      else value = z.object({ value: z.unknown() }).parse(JSON.parse(text)).value;
      return "Foreground settled.";
    },
  });
  const runtime = await createApplicationRuntimeComposition({
    config,
    subAgentTaskRunner: createPiSubAgentTaskRunner(process.cwd(), controlled.models),
    createAgent: (codeExecution) => createPiAgentRuntime(process.cwd(), controlled.models, { codeExecution }),
    createRoleRunner: (configurations) =>
      createScriptedAgentRoleRunner({
        variants: configurations,
        respond: () => ({
          text: '{"observation":{"kind":"other","reason":"Controlled fixture."},"decision":"no_change","reason":"disabled"}',
        }),
      }),
  });
  try {
    const trail = await runtime.startTrail({ title: "Subagent exact tools" });
    await runtime.debug.runTurn(trail.trailId, "Run the program.");
    return { value, error };
  } finally {
    await runtime.shutdown();
  }
}

const SAFE_SCHEMA = `{ type: "object", properties: { safe: { type: "boolean" } }, required: ["safe"] }`;
const JUDGMENT = `
  const task = await agents.wait(await agents.spawn({ prompt: "Is this safe?", tools: [], output: ${SAFE_SCHEMA} }));
  return { status: task.status, result: task.result, error: task.error };
`;

describe("exact subagent tools", () => {
  test("no tools is one plain model call that returns a validated value", async () => {
    const requests: Context[] = [];
    const { value } = await runProgram(JUDGMENT, ({ context }) => {
      requests.push(context);
      return '{"safe":true}';
    });
    expect(value).toEqual({ status: "completed", result: { safe: true }, error: null });
    expect(requests).toHaveLength(1);
    expect(toolNames(requests[0] ?? { messages: [] })).toEqual([]);
    expect(requests[0]?.systemPrompt).toContain("You have no tools");
    expect(requests[0]?.systemPrompt).toContain('"safe"');
  });

  test("text is returned when output is absent", async () => {
    const { value } = await runProgram(
      `return (await agents.wait(await agents.spawn({ prompt: "Say hi.", tools: [] }))).result;`,
      () => "hi",
    );
    expect(value).toBe("hi");
  });

  test("a tool call from a provider that was offered no tools still ends after one answer", async () => {
    let calls = 0;
    const { value } = await runProgram(JUDGMENT, () => {
      calls += 1;
      const call = controlledToolCallResponse("execute", { source: "1" }, "call-invented");
      return { ...call, content: [{ type: "text", text: '{"safe":true}' }, ...call.content] };
    });
    expect(calls).toBe(1);
    expect(value).toMatchObject({ status: "completed", result: { safe: true } });
  });

  test("an invalid answer gets one repair request", async () => {
    const requests: ControlledPiPrompt[] = [];
    const { value } = await runProgram(JUDGMENT, (prompt) => {
      requests.push(prompt);
      return requests.length === 1 ? "Probably safe." : '{"safe":false}';
    });
    expect(value).toEqual({ status: "completed", result: { safe: false }, error: null });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.lastUserText).toContain("did not satisfy");
    expect(toolNames(requests[1]?.context ?? { messages: [] })).toEqual([]);
  });

  test("a second invalid answer fails the task with the validation problem", async () => {
    let calls = 0;
    const { value } = await runProgram(JUDGMENT, () => {
      calls += 1;
      return '{"safe":"maybe"}';
    });
    expect(calls).toBe(2);
    expect(value).toMatchObject({
      status: "failed",
      result: null,
      error: expect.stringContaining("does not match its output schema"),
    });
  });

  test("an answer wrapped in prose goes to repair", async () => {
    const requests: ControlledPiPrompt[] = [];
    const { value } = await runProgram(JUDGMENT, (prompt) => {
      requests.push(prompt);
      return requests.length === 1 ? 'Here is my answer: {"safe":true}' : '{"safe":false}';
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.lastUserText).toContain("not exactly one JSON value");
    expect(value).toEqual({ status: "completed", result: { safe: false }, error: null });
  });

  test("a schema default cannot fill in a value the answer left out", async () => {
    const { value } = await runProgram(
      `const task = await agents.wait(await agents.spawn({ prompt: "Pick.", tools: [], output: { type: "object", properties: { x: { type: "integer", default: 1 } }, required: ["x"] } }));
       return { status: task.status, result: task.result };`,
      () => "{}",
    );
    expect(value).toEqual({ status: "failed", result: null });
  });

  test("required names outside properties and draft-7 dependencies are enforced", async () => {
    const { value } = await runProgram(
      `const required = await agents.wait(await agents.spawn({ prompt: "Required.", tools: [], output: { type: "object", required: ["safe"] } }));
       const dependent = await agents.wait(await agents.spawn({ prompt: "Dependent.", tools: [], output: { type: "object", dependencies: { a: ["b"] } } }));
       return [required.status, dependent.status];`,
      ({ context }) => (JSON.stringify(context.messages).includes("Dependent.") ? '{"a":1}' : "{}"),
    );
    expect(value).toEqual(["failed", "failed"]);
  });

  test("an answer with only tool calls to a request without tools fails instead of returning nothing", async () => {
    let calls = 0;
    const { value } = await runProgram(
      `const task = await agents.wait(await agents.spawn({ prompt: "Say hi.", tools: [] }));
       return { status: task.status, error: task.error };`,
      () => {
        calls += 1;
        return controlledToolCallResponse("execute", { source: "1" }, "call-invented");
      },
    );
    expect(calls).toBe(1);
    expect(value).toEqual({ status: "failed", error: expect.stringContaining("only with tool calls") });
  });

  test("the validated value survives past the task's text preview", async () => {
    const long = "x".repeat(20_000);
    const { value } = await runProgram(
      `return (await agents.wait(await agents.spawn({ prompt: "Long.", tools: [], output: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }))).result.text.length;`,
      () => JSON.stringify({ text: long }),
    );
    expect(value).toBe(20_000);
  });

  test("a repair after tool use keeps definitions but cannot run a tool", async () => {
    const requests: Context[] = [];
    const { value } = await runProgram(
      `return await agents.wait(await agents.spawn({ prompt: "Read then judge.", tools: ["files.read"], output: ${SAFE_SCHEMA} }));`,
      ({ context }) => {
        requests.push(context);
        if (requests.length === 1)
          return controlledToolCallResponse("file_read", { path: "package.json" }, "call-read");
        if (requests.length === 2) return "Not JSON.";
        // The provider ignores the instruction; the guard removes the call and keeps the answer.
        const call = controlledToolCallResponse("file_read", { path: "package.json" }, "call-again");
        return { ...call, content: [{ type: "text", text: '{"safe":true}' }, ...call.content] };
      },
    );
    expect(requests).toHaveLength(3);
    expect(toolNames(requests[2] ?? { messages: [] })).toHaveLength(1);
    expect(value).toMatchObject({ status: "completed", result: { safe: true } });
  });

  test("an exact list offers only those tools, adding execute only when needed", async () => {
    const seen = new Map<string, readonly string[]>();
    const { value } = await runProgram(
      `const spawned = await Promise.all([
         agents.spawn({ name: "direct", prompt: "direct", tools: ["files.read"] }),
         agents.spawn({ name: "brokered", prompt: "brokered", tools: ["history.search_sessions"] }),
         agents.spawn({ name: "default", prompt: "default" }),
       ]);
       return (await Promise.all(spawned.map((handle) => agents.wait(handle)))).map((task) => task.status);`,
      ({ context, lastUserText }) => {
        for (const name of ["direct", "brokered", "default"])
          if (lastUserText.includes(name)) seen.set(name, toolNames(context));
        return "done";
      },
    );
    expect(value).toEqual(["completed", "completed", "completed"]);
    expect(seen.get("direct")).toHaveLength(1);
    expect(seen.get("direct")).not.toContain("execute");
    expect(seen.get("brokered")).toEqual(["execute"]);
    expect(seen.get("default")).toHaveLength(4);
    expect(seen.get("default")).toContain("execute");
  });

  test("a brokered exact list limits what code can reach", async () => {
    const { value } = await runProgram(
      `const task = await agents.wait(await agents.spawn({ prompt: "Inspect", tools: ["agents.list"] })); return task.result;`,
      ({ context }) => {
        const last = context.messages.at(-1);
        if (last?.role !== "toolResult")
          return controlledToolCallResponse(
            "execute",
            {
              source: `return { families: Object.keys(tools), operations: Object.keys(tools.agents), shell: await noesis.invoke("shell.run", { command: "true" }).then(() => "ran", (cause) => cause.message) };`,
            },
            "call-inspect-catalog",
          );
        const content = last.content[0];
        return content?.type === "text" ? content.text : "";
      },
    );
    const inspected = z
      .object({
        value: z.object({
          families: z.array(z.string()),
          operations: z.array(z.string()),
          shell: z.string(),
        }),
      })
      .parse(JSON.parse(z.string().parse(value)));
    expect(inspected.value.families).toEqual(["agents"]);
    expect(inspected.value.operations).toEqual(["list"]);
    expect(inspected.value.shell).not.toBe("ran");
  });

  test.each([
    ["a name outside the catalog", `tools: ["nonexistent.tool"]`, "unavailable in this turn"],
    ["execute by name", `tools: ["execute"]`, "unavailable in this turn"],
    ["a repeated name", `tools: ["files.read", "files.read"]`, "must be unique"],
    ["an unusable schema", `tools: [], output: { type: "nonsense" }`, "not a usable JSON Schema"],
  ])("rejects %s at admission", async (_label, intent, message) => {
    const { error } = await runProgram(`return await agents.spawn({ prompt: "x", ${intent} });`, () => {
      throw new Error("A rejected spawn must not reach the provider");
    });
    expect(error).toContain(message);
  });

  test("a child of a narrowed subagent cannot receive more than its parent holds", async () => {
    const seen = new Map<string, readonly string[]>();
    const { value } = await runProgram(
      `return (await agents.wait(await agents.spawn({ name: "parent", prompt: "parent", tools: ["agents.spawn", "agents.wait", "files.read"] }))).status;`,
      ({ context, lastUserText }) => {
        if (lastUserText.includes("grandchild")) {
          seen.set("grandchild", toolNames(context));
          return "done";
        }
        if (context.messages.at(-1)?.role === "toolResult") return "parent done";
        return controlledToolCallResponse(
          "execute",
          {
            source: `return (await agents.wait(await agents.spawn({ prompt: "grandchild" }))).status;`,
          },
          "call-spawn-grandchild",
        );
      },
    );
    expect(value).toBe("completed");
    // The grandchild keeps the default tools its parent holds: file read and agents.wait.
    expect(seen.get("grandchild")).toEqual(["execute", "file_read"]);
  });

  test("a message to a running task with no tools waits for a later task", async () => {
    const prompts: string[] = [];
    const { value } = await runProgram(
      `const delay = () => new Promise((resolve) => setTimeout(resolve, 5));
       const handle = await agents.spawn({ prompt: "first request", tools: [] });
       const tasks = async () => (await agents.inspect({ agentId: handle.agentId })).tasks;
       while ((await tasks())[0].status !== "running") await delay();
       await agents.send({ to: handle.agentId, message: "second request" });
       const first = await agents.wait(handle);
       while ((await tasks()).length < 2) await delay();
       const second = await agents.wait({ taskId: (await tasks())[1].taskId });
       return [first.result, second.result];`,
      async ({ lastUserText }) => {
        prompts.push(lastUserText);
        await new Promise((resolve) => setTimeout(resolve, 100));
        return lastUserText.includes("second request") ? "second answer" : "first answer";
      },
    );
    expect(value).toEqual(["first answer", "second answer"]);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("second request");
  });
});

describe("maxRounds", () => {
  const lastUser = (context: Context): string => JSON.stringify(context.messages.at(-1) ?? null);
  const readCall = (id: string) => controlledToolCallResponse("file_read", { path: "package.json" }, id);

  test("a task with tools does tool work, then answers on its last round", async () => {
    const requests: Context[] = [];
    const { value } = await runProgram(
      `return await agents.wait(await agents.spawn({ prompt: "Explore.", tools: ["files.read"], maxRounds: 2 }));`,
      ({ context }) => {
        requests.push(context);
        if (requests.length === 1) return readCall("call-explore");
        // The provider ignores the request not to call tools; the answer still ends the task.
        const call = readCall("call-too-many");
        return { ...call, content: [{ type: "text", text: "Found it." }, ...call.content] };
      },
    );
    expect(requests).toHaveLength(2);
    expect(toolNames(requests[1] ?? { messages: [] })).toHaveLength(1);
    expect(lastUser(requests[1] ?? { messages: [] })).toContain("last model request");
    expect(lastUser(requests[0] ?? { messages: [] })).not.toContain("last model request");
    expect(value).toMatchObject({ status: "completed", result: "Found it." });
  });

  test("maxRounds 1 is a plain model call even when tools are listed", async () => {
    const requests: Context[] = [];
    const { value } = await runProgram(
      `return (await agents.wait(await agents.spawn({ prompt: "Answer.", tools: ["files.read"], maxRounds: 1 }))).result;`,
      ({ context }) => {
        requests.push(context);
        return "Answered.";
      },
    );
    expect(value).toBe("Answered.");
    expect(requests).toHaveLength(1);
    expect(toolNames(requests[0] ?? { messages: [] })).toEqual([]);
  });

  test("a task that finishes early is unaffected", async () => {
    let calls = 0;
    const { value } = await runProgram(
      `return (await agents.wait(await agents.spawn({ prompt: "Answer.", maxRounds: 5 }))).result;`,
      ({ context }) => {
        calls += 1;
        expect(lastUser(context)).not.toContain("last model request");
        return "Early answer.";
      },
    );
    expect(value).toBe("Early answer.");
    expect(calls).toBe(1);
  });

  test("the repair request does not count against the limit", async () => {
    const requests: Context[] = [];
    const { value } = await runProgram(
      `return await agents.wait(await agents.spawn({ prompt: "Explore.", tools: ["files.read"], maxRounds: 2, output: ${SAFE_SCHEMA} }));`,
      ({ context }) => {
        requests.push(context);
        if (requests.length === 1) return readCall("call-explore");
        return requests.length === 2 ? "Not JSON." : '{"safe":true}';
      },
    );
    expect(requests).toHaveLength(3);
    expect(lastUser(requests[2] ?? { messages: [] })).toContain("did not satisfy");
    expect(lastUser(requests[2] ?? { messages: [] })).not.toContain("last model request");
    expect(value).toMatchObject({ status: "completed", result: { safe: true } });
  });

  test("a follow-up task gets a fresh count", async () => {
    let calls = 0;
    const { value } = await runProgram(
      `const handle = await agents.spawn({ prompt: "first", tools: ["files.read"], maxRounds: 2 });
       const first = await agents.wait(handle);
       const sent = await agents.send({ to: handle.agentId, message: "second" });
       const second = await agents.wait({ taskId: sent.taskId });
       return [first.result, second.result];`,
      ({ context }) => {
        calls += 1;
        return context.messages.at(-1)?.role === "toolResult" ||
          lastUser(context).includes("last model request")
          ? `answer ${String(calls)}`
          : readCall(`call-${String(calls)}`);
      },
    );
    expect(calls).toBe(4);
    expect(value).toEqual(["answer 2", "answer 4"]);
  });

  test("an answerless last round fails instead of returning an empty result", async () => {
    const { value } = await runProgram(
      `return await agents.wait(await agents.spawn({ prompt: "Explore.", tools: ["files.read"], maxRounds: 2 }));`,
      () => readCall("call-always"),
    );
    expect(value).toMatchObject({
      status: "failed",
      error: expect.stringContaining("round limit without an answer"),
    });
  });

  test("an empty answer before the limit is not reported as reaching it", async () => {
    let calls = 0;
    const { value } = await runProgram(
      `const task = await agents.wait(await agents.spawn({ prompt: "Explore.", tools: ["files.read"], maxRounds: 2 }));
       return { status: task.status, result: task.result };`,
      () => {
        calls += 1;
        return "";
      },
    );
    expect(calls).toBe(1);
    expect(value).toEqual({ status: "completed", result: "" });
  });

  test.each(["0", "-1", "1.5"])("rejects maxRounds %s at admission", async (maxRounds) => {
    const { error } = await runProgram(
      `return await agents.spawn({ prompt: "x", maxRounds: ${maxRounds} });`,
      () => {
        throw new Error("A rejected spawn must not reach the provider");
      },
    );
    expect(error).toContain("maxRounds");
  });
});

describe("joining a task by its handle", () => {
  test("wait accepts the handle, with or without a timeout, and stays strict otherwise", async () => {
    const { value } = await runProgram(
      `const handle = await agents.spawn({ prompt: "x", tools: [] });
       const byHandle = await agents.wait(handle);
       const withTimeout = await agents.wait({ ...handle, timeoutMs: 60000 });
       const typo = await agents.wait({ taskId: handle.taskId, timeout: 1 }).then(() => "accepted", () => "rejected");
       const stray = await agents.wait({ ...handle, timeout: 1 }).then(() => "accepted", () => "rejected");
       return [byHandle.status, withTimeout.status, typo, stray];`,
      () => "answer",
    );
    expect(value).toEqual(["completed", "completed", "rejected", "rejected"]);
  });

  test("a wait on a fresh handle that discards its value is still rejected", async () => {
    const { error } = await runProgram(
      `await agents.wait(await agents.spawn({ prompt: "x", tools: [] }));\nreturn 1;`,
      () => {
        throw new Error("A rejected program must not reach the provider");
      },
    );
    expect(error).toContain("discards its result");
  });
});

describe("subagent concurrency", () => {
  const CAP = 8;
  const peakTracker = () => {
    let running = 0;
    let peak = 0;
    return {
      peak: () => peak,
      during: async <Value>(work: () => Value): Promise<Value> => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running -= 1;
        return work();
      },
    };
  };

  test("a fan-out above the cap queues and every task completes", async () => {
    const tracker = peakTracker();
    const { value } = await runProgram(
      `const results = await Promise.all(Array.from({ length: 40 }, async (_, index) =>
         agents.wait(await agents.spawn({ prompt: "Item " + index, tools: [], output: { type: "object", properties: { item: { type: "integer" } }, required: ["item"] } }))));
       return results.map((task) => task.result.item);`,
      async ({ lastUserText }) =>
        await tracker.during(() => JSON.stringify({ item: Number(/Item (\d+)/u.exec(lastUserText)?.[1]) })),
    );
    expect(value).toEqual(Array.from({ length: 40 }, (_, index) => index));
    expect(tracker.peak()).toBeGreaterThan(1);
    expect(tracker.peak()).toBeLessThanOrEqual(CAP);
  });

  test("parents waiting on children above the cap cannot deadlock", async () => {
    const tracker = peakTracker();
    const { value } = await runProgram(
      `const results = await Promise.all(Array.from({ length: ${String(CAP + 4)} }, async (_, index) =>
         agents.wait(await agents.spawn({ prompt: "Parent " + index, tools: ["agents.spawn", "agents.wait"] }))));
       return results.map((task) => task.status);`,
      async ({ context, lastUserText }) => {
        if (lastUserText.includes("Child")) return await tracker.during(() => "child answer");
        if (context.messages.at(-1)?.role === "toolResult") return "parent answer";
        return controlledToolCallResponse(
          "execute",
          {
            source: `return (await agents.wait(await agents.spawn({ prompt: "Child", tools: [] }))).result;`,
          },
          "call-spawn-child",
        );
      },
    );
    expect(value).toEqual(Array.from({ length: CAP + 4 }, () => "completed"));
    expect(tracker.peak()).toBeLessThanOrEqual(CAP);
  });

  test("a timed-out join resumes only once a slot frees, so the cap holds", async () => {
    const release = Promise.withResolvers<void>();
    const fallback = setTimeout(() => release.resolve(), 3_000);
    const events: string[] = [];
    try {
      const { value } = await runProgram(
        `const parent = await agents.spawn({ prompt: "Parent", tools: ["agents.spawn", "agents.wait"] });
         const held = await Promise.all(Array.from({ length: ${String(CAP - 1)} }, (_, index) => agents.spawn({ prompt: "Hold " + index, tools: [] })));
         const settled = await Promise.all([parent, ...held].map((handle) => agents.wait(handle)));
         return settled.map((task) => task.status);`,
        async ({ context, lastUserText }) => {
          if (lastUserText.includes("Child")) {
            // The child outlives the parent's deadline, and every other slot stays held.
            await new Promise((resolve) => setTimeout(resolve, 300));
            events.push("child finished");
            return "child answer";
          }
          if (lastUserText.includes("Hold")) {
            await release.promise;
            return "held answer";
          }
          const joinResult = context.messages.find((message) => message.role === "toolResult");
          if (!joinResult)
            return controlledToolCallResponse(
              "execute",
              {
                source: `const child = await agents.spawn({ prompt: "Child", tools: [] });
                         return await agents.wait({ ...child, timeoutMs: 100 }).then(() => "joined", () => "timed out");`,
              },
              "call-timed-join",
            );
          // The parent's next model call may open with the child's completion notice.
          events.push(`parent resumed: ${JSON.stringify(joinResult.content)}`);
          release.resolve();
          return "parent answer";
        },
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toBe("child finished");
      expect(events[1]).toContain("timed out");
      expect(value).toEqual(Array.from({ length: CAP }, () => "completed"));
    } finally {
      clearTimeout(fallback);
    }
  });

  test("a queued task can be cancelled and never starts", async () => {
    const release = Promise.withResolvers<void>();
    const prompts: string[] = [];
    const { value } = await runProgram(
      `const held = await Promise.all(Array.from({ length: ${String(CAP)} }, (_, index) => agents.spawn({ prompt: "Hold " + index, tools: [] })));
       const queued = await agents.spawn({ prompt: "Queued work", tools: [] });
       const pending = (await agents.inspect({ agentId: queued.agentId })).tasks[0].status;
       const cancelled = await agents.cancel({ taskId: queued.taskId });
       const agentStatus = (await agents.inspect({ agentId: queued.agentId })).status;
       const settled = await Promise.all(held.map((handle) => agents.wait(handle)));
       return { pending, cancelled: cancelled.status, agentStatus, held: settled.map((task) => task.status) };`,
      async ({ lastUserText }) => {
        prompts.push(lastUserText);
        if (prompts.length === CAP) setTimeout(() => release.resolve(), 200);
        await release.promise;
        return "held answer";
      },
    );
    expect(value).toEqual({
      pending: "pending",
      cancelled: "cancelled",
      agentStatus: "idle",
      held: Array.from({ length: CAP }, () => "completed"),
    });
    expect(prompts.some((prompt) => prompt.includes("Queued work"))).toBe(false);
  });
});
