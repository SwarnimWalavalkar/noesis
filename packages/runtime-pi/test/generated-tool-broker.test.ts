import { describe, expect, test } from "vitest";
import { createGeneratedToolBrokerClient } from "../src/index.ts";

const brokerRequest = {
  requestId: "request-1",
  operationId: "operation-1",
  toolName: "candidate-tool",
  input: { value: 7 },
};

describe("generated-tool broker seam", () => {
  test("validates request and response without exposing execution or authority", async () => {
    let transported: unknown;
    const client = createGeneratedToolBrokerClient({
      exchange(request) {
        transported = request.payload;
        return Promise.resolve({
          ok: true,
          requestId: "request-1",
          output: { doubled: 14 },
          evidenceRefs: ["evidence-1"],
        });
      },
    });

    const result = await client.invoke(brokerRequest);

    expect(result).toEqual({
      ok: true,
      requestId: "request-1",
      output: { doubled: 14 },
      evidenceRefs: ["evidence-1"],
    });
    expect(transported).not.toHaveProperty("authority");
    expect(transported).not.toHaveProperty("grant");
  });

  test("fails closed on a mismatched response identity", async () => {
    const client = createGeneratedToolBrokerClient({
      exchange: async () => ({
        ok: false,
        requestId: "another-request",
        code: "failed",
        reason: "wrong response",
      }),
    });

    await expect(client.invoke(brokerRequest)).rejects.toThrow("response mismatch");
  });

  test("honors cancellation before invoking an injected transport", async () => {
    let invoked = false;
    const client = createGeneratedToolBrokerClient({
      exchange: async () => {
        invoked = true;
        return { ok: true, requestId: "request-1", output: null, evidenceRefs: [] };
      },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(client.invokeWithOptions(brokerRequest, { signal: controller.signal })).rejects.toThrow(
      "aborted",
    );
    expect(invoked).toBe(false);
  });
});
