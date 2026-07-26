import type { JsonValue } from "@noesis/domain";
import type { AuthorityBoundary, EffectDecision } from "@noesis/policy";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createToolBroker, defineTool, type ToolDefinition } from "../src/index.ts";

const permission = Object.freeze({
  effects: Object.freeze(["read"]),
  resourcePatterns: Object.freeze(["test:"]),
  credentialRefs: Object.freeze([]),
});

function foregroundAuthority(): Pick<AuthorityBoundary, "runForeground"> {
  return Object.freeze({
    runForeground: async <T extends JsonValue>(
      request: Parameters<AuthorityBoundary["runForeground"]>[0],
    ): Promise<EffectDecision<T>> =>
      Object.freeze({
        ok: true,
        value: (await request.execute({
          effect: request.effect,
          resource: request.resource,
          operationId: request.operationId,
        })) as T,
        replayed: false,
      }),
  });
}

function echo(description = "Return the provided value"): ToolDefinition {
  return defineTool({
    name: "test.echo",
    label: "Echo",
    description,
    visibility: "codemode_only",
    inputSchema: z.strictObject({ value: z.string() }),
    outputSchema: z.strictObject({ value: z.string() }),
    effect: () => Object.freeze({ effect: "read", resource: "test:echo", estimatedCost: 0 }),
    execute: async (input) => input,
  });
}

describe("tool broker", () => {
  it("freezes discovery identity and validates calls", async () => {
    const definitions: ToolDefinition[] = [echo()];
    const broker = createToolBroker({ definitions, authority: foregroundAuthority(), permission });
    definitions.push(echo("mutated later"));

    expect(broker.list()).toHaveLength(1);
    expect(broker.search("echo")[0]?.name).toBe("test.echo");
    const result = await broker.invoke(
      "test.echo",
      { value: "hello" },
      {
        executionId: "execution-1",
        sessionId: "session-1",
        signal: new AbortController().signal,
      },
    );
    expect(result).toMatchObject({ ok: true, value: { value: "hello" } });
    expect(
      await broker.invoke(
        "test.echo",
        { value: 1 },
        {
          executionId: "execution-1",
          sessionId: "session-1",
          signal: new AbortController().signal,
        },
      ),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("gives equal definitions byte-stable revision and catalog identities", () => {
    const first = createToolBroker({
      definitions: [echo()],
      authority: foregroundAuthority(),
      permission,
    });
    const second = createToolBroker({
      definitions: [echo()],
      authority: foregroundAuthority(),
      permission,
    });
    expect(first.catalogDigest).toBe(second.catalogDigest);
    expect(first.describe("test.echo")?.revisionId).toBe(second.describe("test.echo")?.revisionId);
  });

  it("changes catalog identity when executable behavior identity changes", () => {
    const changed = defineTool({
      name: "test.echo",
      label: "Echo",
      description: "Return the provided value",
      visibility: "codemode_only",
      identityMaterial: { adapterRevision: "echo-v2" },
      inputSchema: z.strictObject({ value: z.string() }),
      outputSchema: z.strictObject({ value: z.string() }),
      effect: () => Object.freeze({ effect: "read", resource: "test:echo", estimatedCost: 0 }),
      execute: async ({ value }) => ({ value }),
    });
    const original = createToolBroker({
      definitions: [echo()],
      authority: foregroundAuthority(),
      permission,
    });
    const revised = createToolBroker({
      definitions: [changed],
      authority: foregroundAuthority(),
      permission,
    });

    expect(revised.catalogDigest).not.toBe(original.catalogDigest);
    expect(revised.describe("test.echo")?.implementationDigest).not.toBe(
      original.describe("test.echo")?.implementationDigest,
    );
  });

  it("binds effect idempotency to the stable logical call instead of a physical execution", async () => {
    const idempotencyKeys: string[] = [];
    const broker = createToolBroker({
      definitions: [echo()],
      permission,
      authority: Object.freeze({
        runForeground: async <T extends JsonValue>(
          request: Parameters<AuthorityBoundary["runForeground"]>[0],
        ): Promise<EffectDecision<T>> => {
          idempotencyKeys.push(request.idempotencyKey);
          return Object.freeze({
            ok: true,
            value: (await request.execute({
              effect: request.effect,
              resource: request.resource,
              operationId: request.operationId,
            })) as T,
            replayed: false,
          });
        },
      }),
    });
    const signal = new AbortController().signal;

    await broker.invoke(
      "test.echo",
      { value: "hello" },
      {
        executionId: "physical-1",
        logicalExecutionId: "logical-1",
        callId: "logical-call-1",
        sessionId: "session-1",
        signal,
      },
    );
    await broker.invoke(
      "test.echo",
      { value: "hello" },
      {
        executionId: "physical-2",
        logicalExecutionId: "logical-1",
        callId: "logical-call-1",
        sessionId: "session-1",
        signal,
      },
    );

    expect(idempotencyKeys).toHaveLength(2);
    expect(idempotencyKeys[0]).toBe(idempotencyKeys[1]);
  });
});
