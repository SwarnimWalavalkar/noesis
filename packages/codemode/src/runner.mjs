import { createConditionalObject } from "@noesis/domain";
import { parse } from "acorn";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
const pending = new Map();
const successfulCallIds = new Set();
let sequence = 0;
const MAX_SDK_INPUT_BYTES = 256 * 1024;
const MAX_STORE_VALUE_BYTES = 64 * 1024;
const MAX_STORE_BYTES = 256 * 1024;
const MAX_STORE_ENTRIES = 256;
const MAX_PROGRESS_VALUE_BYTES = 64 * 1024;
const MAX_PROGRESS_BYTES = 256 * 1024;
const MAX_CHILD_FRAME_BYTES = 1024 * 1024;
const MAX_FAILURE_MESSAGE_BYTES = 32 * 1024;
const MAX_FAILURE_STACK_BYTES = 96 * 1024;
function rawSend(message) {
  if (typeof process.send !== "function") throw new Error("Codemode IPC channel is unavailable");
  process.send(message);
}
function send(message) {
  const serialized = JSON.stringify(message);
  const frameBytes = Buffer.byteLength(serialized, "utf8");
  const terminalResultFrame = message?.type === "result";
  if (!terminalResultFrame && frameBytes > MAX_CHILD_FRAME_BYTES) {
    throw new Error(`Codemode IPC frame exceeds ${MAX_CHILD_FRAME_BYTES} bytes`);
  }
  rawSend(message);
}
function truncateUtf8(value, maximumBytes) {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let accepted = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    accepted += character;
    bytes += characterBytes;
  }
  return accepted;
}
function sendFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : undefined;
  rawSend(
    createConditionalObject({
      type: "failure",
      error: truncateUtf8(message, MAX_FAILURE_MESSAGE_BYTES),
    })
      .addOptional(
        !(stack === undefined) ? { stack: truncateUtf8(stack, MAX_FAILURE_STACK_BYTES) } : undefined,
      )
      .finish(),
  );
}
function boundedJsonSafe(value, maximum, label) {
  const serialized = JSON.stringify(value === undefined ? null : value);
  if (Buffer.byteLength(serialized, "utf8") > maximum) {
    throw new Error(`${label} exceeds ${maximum} bytes`);
  }
  return JSON.parse(serialized);
}
function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}
async function flushOutput() {
  const flushed = await Promise.allSettled(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise((resolve, reject) => stream.write("", (error) => (error ? reject(error) : resolve()))),
    ),
  );
  return flushed.every((result) => result.status === "fulfilled");
}
function sourceWithLastExpressionCompletion(source) {
  const prefix = "async function __noesis_execute__() {\n";
  const program = parse(`${prefix}${source}\n}`, {
    ecmaVersion: "latest",
    sourceType: "script",
  });
  const functionBody = program.body[0]?.body;
  const finalStatement = functionBody?.type === "BlockStatement" ? functionBody.body.at(-1) : undefined;
  if (finalStatement?.type !== "ExpressionStatement") return source;
  const statementStart = finalStatement.start - prefix.length;
  const expressionStart = finalStatement.expression.start - prefix.length;
  const expressionEnd = finalStatement.expression.end - prefix.length;
  const statementEnd = finalStatement.end - prefix.length;
  return `${source.slice(0, statementStart)}return (${source.slice(
    expressionStart,
    expressionEnd,
  )});${source.slice(statementEnd)}`;
}
function delegate(kind, payload) {
  const requestId = `sdk_${++sequence}`;
  const result = new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    try {
      const safePayload = boundedJsonSafe(payload, MAX_SDK_INPUT_BYTES, "Codemode SDK request");
      send({
        type: "sdk-call",
        requestId,
        kind,
        causallyPriorCallIds: [...successfulCallIds],
        ...safePayload,
      });
    } catch (error) {
      pending.delete(requestId);
      reject(error);
    }
  });
  const consume = () =>
    result.then(({ value, callId }) => {
      successfulCallIds.add(callId);
      return value;
    });
  return Object.freeze({
    // oxlint-disable-next-line unicorn/no-thenable -- awaiting is the observation boundary we must track.
    then: (onFulfilled, onRejected) => consume().then(onFulfilled, onRejected),
    catch: (onRejected) => consume().catch(onRejected),
    finally: (onFinally) => consume().finally(onFinally),
    [Symbol.toStringTag]: "Promise",
  });
}
function createTools(names) {
  const families = new Map();
  const tools = new Map();
  for (const name of names) {
    const invoke = (input = {}) => delegate("invoke", { name, input });
    const separator = name.indexOf(".");
    if (separator < 0) {
      tools.set(name, invoke);
      continue;
    }
    const family = name.slice(0, separator);
    const operation = name.slice(separator + 1);
    const members = families.get(family) ?? [];
    members.push([operation, invoke]);
    families.set(family, members);
  }
  const namespace = (entries, target = Object.create(null)) =>
    Object.freeze(
      Object.defineProperties(
        Object.setPrototypeOf(target, null),
        Object.fromEntries([...entries].map(([name, value]) => [name, { value, enumerable: true }])),
      ),
    );
  for (const [family, members] of families) tools.set(family, namespace(members, tools.get(family)));
  return namespace(tools);
}
const noesis = Object.freeze({
  search: (query, limit) =>
    delegate(
      "search",
      createConditionalObject({
        query: String(query),
      })
        .addOptional(!(limit === undefined) ? { limit } : undefined)
        .finish(),
    ),
  describe: (name) => delegate("describe", { name: String(name) }),
  invoke: (name, input = {}) =>
    delegate("invoke", {
      name: String(name),
      input,
    }),
});
function normalizeSliceIndex(value, length, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (Number.isNaN(number)) return 0;
  if (number === Infinity) return length;
  if (number === -Infinity) return 0;
  const integer = Math.trunc(number);
  return integer < 0 ? Math.max(length + integer, 0) : Math.min(integer, length);
}
function createContextView(document, start = 0, end = document.characterLength) {
  const viewStart = normalizeSliceIndex(start, document.characterLength, 0);
  const viewEnd = Math.max(
    viewStart,
    normalizeSliceIndex(end, document.characterLength, document.characterLength),
  );
  const view = {
    get length() {
      return viewEnd - viewStart;
    },
    slice(nextStart, nextEnd) {
      const length = viewEnd - viewStart;
      const relativeStart = normalizeSliceIndex(nextStart, length, 0);
      const relativeEnd = Math.max(relativeStart, normalizeSliceIndex(nextEnd, length, length));
      return createContextView(document, viewStart + relativeStart, viewStart + relativeEnd);
    },
    async text() {
      const content = await document.read();
      return content.slice(viewStart, viewEnd);
    },
    toJSON() {
      return {
        __noesisContext: {
          documentId: document.documentId,
          start: viewStart,
          end: viewEnd,
        },
      };
    },
  };
  return Object.freeze(view);
}
function createContextDocument(raw) {
  if (!raw || typeof raw !== "object") {
    return Object.freeze({
      documentId: "context_document_empty",
      characterLength: 0,
      read: async () => "",
    });
  }
  let cached;
  const read = async () => {
    if (!cached) {
      cached = readFile(raw.path, "utf8").then((content) => {
        const digest = createHash("sha256").update(content, "utf8").digest("hex");
        if (digest !== raw.contentDigest) throw new Error("Frozen context document failed verification");
        if (content.length !== raw.characterLength)
          throw new Error("Frozen context document character length changed");
        if (Buffer.byteLength(content, "utf8") !== raw.byteLength)
          throw new Error("Frozen context document byte length changed");
        return content;
      });
    }
    return await cached;
  };
  return Object.freeze({
    documentId: String(raw.documentId),
    characterLength: Number(raw.characterLength),
    read,
  });
}
function encodeAgentPrompt(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(encodeAgentPrompt);
  if (value && typeof value === "object" && typeof value.toJSON === "function") return value.toJSON();
  throw new TypeError("agents.spawn prompt must be a string, ContextView, or an array of them");
}
process.on("message", async (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "sdk-result" && typeof message.requestId === "string") {
    const waiter = pending.get(message.requestId);
    if (!waiter) return;
    pending.delete(message.requestId);
    if (message.ok) {
      waiter.resolve({ value: message.value, callId: message.callId });
    } else waiter.reject(new Error(typeof message.error === "string" ? message.error : "SDK call failed"));
    return;
  }
  if (message.type !== "run" || typeof message.source !== "string") return;
  const tools = createTools(message.toolNames);
  const sessionStore = new Map(Array.isArray(message.storeEntries) ? message.storeEntries : []);
  const storeMutations = new Map();
  let progressBytes = 0;
  const emit = (value) => {
    const serialized = JSON.stringify(value === undefined ? null : value);
    const valueBytes = Buffer.byteLength(serialized, "utf8");
    if (valueBytes > MAX_PROGRESS_VALUE_BYTES || progressBytes + valueBytes > MAX_PROGRESS_BYTES) return;
    const safeValue = JSON.parse(serialized);
    progressBytes += valueBytes;
    send({ type: "progress", value: safeValue });
  };
  const notify = emit;
  const store = (key, value) => {
    const normalizedKey = String(key);
    const safeValue = boundedJsonSafe(value, MAX_STORE_VALUE_BYTES, "Codemode store value");
    const hadPrevious = sessionStore.has(normalizedKey);
    const previousValue = sessionStore.get(normalizedKey);
    sessionStore.set(normalizedKey, safeValue);
    if (
      sessionStore.size > MAX_STORE_ENTRIES ||
      Buffer.byteLength(JSON.stringify([...sessionStore.entries()]), "utf8") > MAX_STORE_BYTES
    ) {
      if (hadPrevious) sessionStore.set(normalizedKey, previousValue);
      else sessionStore.delete(normalizedKey);
      throw new Error(`Codemode store exceeds ${MAX_STORE_BYTES} bytes or ${MAX_STORE_ENTRIES} entries`);
    }
    storeMutations.set(normalizedKey, safeValue);
  };
  const load = (key) => sessionStore.get(String(key));
  const context = createContextView(createContextDocument(message.contextDocument));
  const agentContext =
    message.agentContext && typeof message.agentContext === "object" ? message.agentContext : undefined;
  const agentMembers = {
    spawn: (intent) => {
      if (!intent || typeof intent !== "object" || Array.isArray(intent))
        throw new TypeError("agents.spawn requires an intent object");
      return delegate("invoke", {
        name: "agents.spawn",
        input: {
          ...intent,
          prompt: encodeAgentPrompt(intent.prompt),
        },
      });
    },
    send: (input) => delegate("invoke", { name: "agents.send", input }),
    list: (filter = {}) => delegate("invoke", { name: "agents.list", input: filter }),
    inspect: (input) => delegate("invoke", { name: "agents.inspect", input }),
    wait: (input) => delegate("invoke", { name: "agents.wait", input }),
    cancel: (input) => delegate("invoke", { name: "agents.cancel", input }),
    close: (input) => delegate("invoke", { name: "agents.close", input }),
  };
  if (agentContext) agentMembers.self = Object.freeze({ ...agentContext.self });
  if (agentContext?.parent) agentMembers.parent = Object.freeze({ ...agentContext.parent });
  const agents = Object.freeze(agentMembers);
  try {
    const executableSource =
      message.completionMode === "last-expression"
        ? sourceWithLastExpressionCompletion(message.source)
        : message.source;
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const execute = new AsyncFunction(
      "tools",
      "noesis",
      "emit",
      "notify",
      "store",
      "load",
      "input",
      "context",
      "agents",
      `"use strict";\nreturn await (async function () {\n${executableSource}\n})();`,
    );
    const value = await execute(
      tools,
      noesis,
      emit,
      notify,
      store,
      load,
      message.input ?? null,
      context,
      agents,
    );
    const logsComplete = await flushOutput();
    send({
      type: "result",
      value: jsonSafe(value),
      logsTruncated: !logsComplete,
      storeMutations: [...storeMutations.entries()],
    });
  } catch (error) {
    await flushOutput();
    sendFailure(error);
  }
});
send({ type: "ready" });
