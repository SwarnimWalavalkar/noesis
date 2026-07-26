import process from "node:process";

const pending = new Map();
let sequence = 0;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_STORE_VALUE_BYTES = 64 * 1024;

function send(message) {
  if (typeof process.send !== "function") throw new Error("Codemode IPC channel is unavailable");
  process.send(message);
}

function jsonSafe(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function boundedJsonSafe(value, maximum, label) {
  const serialized = JSON.stringify(value === undefined ? null : value);
  if (Buffer.byteLength(serialized, "utf8") > maximum) {
    throw new Error(`${label} exceeds ${maximum} bytes`);
  }
  return JSON.parse(serialized);
}

function delegate(kind, payload) {
  const requestId = `sdk_${++sequence}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    send({ type: "sdk-call", requestId, kind, ...payload });
  });
}

const toolNamespaces = new Map();
const tools = new Proxy(
  {},
  {
    get(_target, family) {
      if (typeof family !== "string") return undefined;
      const existing = toolNamespaces.get(family);
      if (existing) return existing;
      const namespace = new Proxy(
        {},
        {
          get(_namespaceTarget, operation) {
            if (typeof operation !== "string") return undefined;
            return async (input = {}) =>
              await delegate("invoke", { name: `${family}.${operation}`, input: jsonSafe(input) });
          },
        },
      );
      toolNamespaces.set(family, namespace);
      return namespace;
    },
  },
);

const noesis = Object.freeze({
  search: async (query, limit) =>
    await delegate("search", { query: String(query), ...(limit === undefined ? {} : { limit }) }),
  describe: async (name) => await delegate("describe", { name: String(name) }),
  invoke: async (name, input = {}) =>
    await delegate("invoke", { name: String(name), input: jsonSafe(input) }),
});

process.on("message", async (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "sdk-result" && typeof message.requestId === "string") {
    const waiter = pending.get(message.requestId);
    if (!waiter) return;
    pending.delete(message.requestId);
    if (message.ok) waiter.resolve(message.value);
    else waiter.reject(new Error(typeof message.error === "string" ? message.error : "SDK call failed"));
    return;
  }
  if (message.type !== "run" || typeof message.source !== "string") return;
  const sessionStore = new Map(Array.isArray(message.storeEntries) ? message.storeEntries : []);
  const emit = (value) => send({ type: "progress", value: jsonSafe(value) });
  const notify = emit;
  const store = (key, value) => {
    sessionStore.set(String(key), boundedJsonSafe(value, MAX_STORE_VALUE_BYTES, "Codemode store value"));
  };
  const load = (key) => sessionStore.get(String(key));
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const execute = new AsyncFunction(
      "tools",
      "noesis",
      "emit",
      "notify",
      "store",
      "load",
      "input",
      `"use strict";\n${message.source}`,
    );
    const value = await execute(tools, noesis, emit, notify, store, load, message.input ?? null);
    send({
      type: "result",
      value: boundedJsonSafe(value, MAX_RESULT_BYTES, "Codemode result"),
      storeEntries: [...sessionStore.entries()],
    });
  } catch (error) {
    send({
      type: "failure",
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error && typeof error.stack === "string" ? error.stack : undefined,
    });
  }
});

send({ type: "ready" });
