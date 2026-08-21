import { createConditionalObject } from "@noesis/domain";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
const pending = new Map();
let sequence = 0;
const MAX_SDK_INPUT_BYTES = 256 * 1024;
const MAX_STORE_VALUE_BYTES = 64 * 1024;
const MAX_STORE_BYTES = 256 * 1024;
const MAX_STORE_ENTRIES = 256;
const MAX_PROGRESS_VALUE_BYTES = 64 * 1024;
const MAX_PROGRESS_BYTES = 256 * 1024;
const MAX_CHILD_FRAME_BYTES = 1024 * 1024;
const MAX_CHILD_IPC_BYTES = 8 * 1024 * 1024;
const MAX_FAILURE_MESSAGE_BYTES = 32 * 1024;
const MAX_FAILURE_STACK_BYTES = 96 * 1024;
let childIpcBytes = 0;
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
  if (!terminalResultFrame && childIpcBytes + frameBytes > MAX_CHILD_IPC_BYTES) {
    throw new Error(`Codemode IPC output exceeds ${MAX_CHILD_IPC_BYTES} bytes`);
  }
  if (!terminalResultFrame) childIpcBytes += frameBytes;
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
function delegate(kind, payload) {
  const requestId = `sdk_${++sequence}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    try {
      const safePayload = boundedJsonSafe(payload, MAX_SDK_INPUT_BYTES, "Codemode SDK request");
      send({ type: "sdk-call", requestId, kind, ...safePayload });
    } catch (error) {
      pending.delete(requestId);
      reject(error);
    }
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
              await delegate("invoke", {
                name: `${family}.${operation}`,
                input,
              });
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
    await delegate(
      "search",
      createConditionalObject({
        query: String(query),
      })
        .addOptional(!(limit === undefined) ? { limit } : undefined)
        .finish(),
    ),
  describe: async (name) => await delegate("describe", { name: String(name) }),
  invoke: async (name, input = {}) =>
    await delegate("invoke", {
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
function encodeModelContext(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(encodeModelContext);
  if (value && typeof value === "object" && typeof value.toJSON === "function") return value.toJSON();
  throw new TypeError("models.query context must be a string, ContextView, or an array of them");
}
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
  const storeMutations = new Map();
  let progressBytes = 0;
  const emit = (value) => {
    const safeValue = boundedJsonSafe(value, MAX_PROGRESS_VALUE_BYTES, "Codemode progress value");
    progressBytes += Buffer.byteLength(JSON.stringify(safeValue), "utf8");
    if (progressBytes > MAX_PROGRESS_BYTES) {
      throw new Error(`Codemode progress exceeds ${MAX_PROGRESS_BYTES} bytes`);
    }
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
  const models = Object.freeze({
    query: async (prompt, queryContext) => {
      if (typeof prompt !== "string" || prompt.trim().length === 0)
        throw new TypeError("models.query prompt must be a non-empty string");
      const input =
        queryContext === undefined ? { prompt } : { prompt, context: encodeModelContext(queryContext) };
      return await delegate("invoke", { name: "models.query", input });
    },
  });
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
      "context",
      "models",
      `"use strict";\n${message.source}`,
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
      models,
    );
    send({
      type: "result",
      value: jsonSafe(value),
      storeMutations: [...storeMutations.entries()],
    });
  } catch (error) {
    sendFailure(error);
  }
});
send({ type: "ready" });
