import { describe, expect, test } from "vitest";
import { sha256 } from "@noesis/domain";
import {
  frozenTurnPlanDigest,
  validateFrozenTurnPlan,
  type AgentRuntimeEvent,
  type AgentRuntimeRequest,
  type FrozenTurnPlan,
} from "@noesis/agent-types";
import { createPiAgentRuntime } from "../src/index.ts";
import { requestContextComponents } from "../src/context-inspection.ts";
import { imageSafeJson } from "../src/image-input.ts";
import { createPiRequestBudgetProjector } from "../src/context-budget.ts";
import {
  CONTROLLED_PI_MODEL,
  CONTROLLED_PI_PROVIDER,
  createControlledPiModels,
} from "./support/controlled-pi-models.ts";

const image = {
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=",
};
const attachment = {
  name: "pixel.png",
  mimeType: image.mimeType,
  artifact: {
    kind: "artifact_file" as const,
    artifactId: "pixel",
    path: ".noesis/artifacts/pixel.png",
    mediaType: image.mimeType,
  },
};
const request: AgentRuntimeRequest = {
  trailId: "image-test",
  provider: CONTROLLED_PI_PROVIDER,
  model: CONTROLLED_PI_MODEL,
  thinkingLevel: "off",
  systemPrompt: "Inspect the image.",
  prompt: "Current image",
  activeCapabilities: [],
};
function plan(): FrozenTurnPlan {
  const unsigned: Omit<FrozenTurnPlan, "canonicalDigest"> = {
    schemaVersion: 1,
    planId: "image-plan",
    sessionId: request.trailId,
    turnId: "image-turn",
    activationId: "image-activation",
    activationRevision: 1,
    selectedCapabilities: [],
    renderedSystemPrompt: request.systemPrompt,
    provider: request.provider,
    model: request.model,
    thinkingLevel: request.thinkingLevel,
    permissionSnapshot: { effects: [], resourcePatterns: [], credentialRefs: [] },
    retrievalCitations: [],
    routing: { strategyId: "baseline", reason: "test" },
    createdAt: "2026-01-01T00:00:00.000Z",
    conversationHistory: [
      {
        messageId: "prior",
        messageRef: { kind: "database_row", table: "messages", rowId: "prior" },
        role: "user",
        content: "Previous image",
        createdAt: "2026-01-01T00:00:00.000Z",
        contentDigest: sha256("Previous image"),
        attachments: [attachment],
        attachmentText: "Attached file: /workspace/.noesis/artifacts/pixel.png",
        imageDigests: [
          {
            artifactId: attachment.artifact.artifactId,
            contentDigest: sha256(Buffer.from(image.data, "base64")),
          },
        ],
      },
    ],
  };
  return { ...unsigned, canonicalDigest: frozenTurnPlanDigest(unsigned) };
}

describe("Pi image input", () => {
  test("projects current and frozen replay images through a real credential-free AgentHarness", async () => {
    let calls = 0;
    const controlled = createControlledPiModels({
      imageInput: true,
      respond: ({ context }) => {
        calls++;
        const users = context.messages.filter((message) => message.role === "user");
        expect(users).toHaveLength(2);
        for (const user of users) expect(user.content).toContainEqual({ type: "image", ...image });
        expect(JSON.stringify(users[0])).toContain("/workspace/.noesis/artifacts/pixel.png");
        expect(JSON.stringify(users[0])).not.toContain("injected override");
        return "Saw both images";
      },
    });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models);
    const frozen = plan();
    expect(validateFrozenTurnPlan(frozen).conversationHistory?.[0]?.attachments).toEqual([attachment]);
    expect(JSON.stringify(frozen)).not.toContain(image.data);
    const events: AgentRuntimeEvent[] = [];
    const result = await runtime.run(
      {
        ...request,
        images: [image],
        frozenTurnPlan: frozen,
        history: [
          {
            role: "user",
            content: "Previous image\nAttached file: /workspace/.noesis/artifacts/pixel.png",
            createdAt: frozen.createdAt,
            attachments: [attachment],
            images: [image],
            attachmentText: "injected override",
          },
        ],
      },
      (event) => events.push(event),
    );
    expect(result).toMatchObject({ outcome: "completed", text: "Saw both images" });
    expect(calls).toBe(1);
    expect(JSON.stringify(events)).not.toContain(image.data);
  });

  test("rejects missing images and altered frozen artifact references", async () => {
    const runtime = createPiAgentRuntime(
      process.cwd(),
      createControlledPiModels({ imageInput: true }).models,
    );
    await expect(runtime.run({ ...request, frozenTurnPlan: plan() }, () => {})).rejects.toThrow(
      "history images do not match",
    );
    await expect(
      runtime.run(
        {
          ...request,
          frozenTurnPlan: plan(),
          history: [
            {
              role: "user",
              content: "Previous image\nAttached file: /workspace/.noesis/artifacts/pixel.png",
              createdAt: plan().createdAt,
              attachments: [{ ...attachment, name: "changed.png" }],
              images: [image],
            },
          ],
        },
        () => {},
      ),
    ).rejects.toThrow("history does not match");
    await expect(
      runtime.run(
        {
          ...request,
          frozenTurnPlan: plan(),
          history: [
            {
              role: "user",
              content: "Previous image\nAttached file: /workspace/.noesis/artifacts/pixel.png",
              createdAt: plan().createdAt,
              attachments: [attachment],
              images: [{ ...image, data: Buffer.from("different same-MIME bytes").toString("base64") }],
            },
          ],
        },
        () => {},
      ),
    ).rejects.toThrow("history images do not match");
    const tampered = {
      ...plan(),
      conversationHistory: plan().conversationHistory?.map((entry) => ({
        ...entry,
        attachments: [{ ...attachment, name: "changed.png" }],
      })),
    };
    expect(() => validateFrozenTurnPlan(tampered)).toThrow("canonical digest");
  });

  test("rejects text-only routes explicitly for current, replay, and pre-admission", async () => {
    const controlled = createControlledPiModels();
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models);
    expect(() => runtime.validateImages?.(request.provider, request.model, [image])).toThrow(
      "does not support image input",
    );
    for (const extra of [
      { images: [image] },
      { history: [{ role: "user" as const, content: "Prior", images: [image] }] },
    ]) {
      await expect(runtime.run({ ...request, ...extra }, () => {})).rejects.toThrow(
        "does not support image input",
      );
    }
  });

  test("delivers steering image blocks, acknowledging consumption rather than queue acceptance", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const controlled = createControlledPiModels({
      imageInput: true,
      respond: async ({ context }) => {
        if (++calls === 1) {
          started.resolve();
          await release.promise;
          return "Initial answer";
        }
        const last = context.messages.filter((message) => message.role === "user").at(-1);
        expect(last?.content).toContainEqual({ type: "image", ...image });
        return "Steering image received";
      },
    });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models);
    const running = runtime.run(request, () => {});
    await started.promise;
    const receipt = runtime.steer(request.trailId, "Inspect this instead", [image]);
    release.resolve();
    expect(await running).toMatchObject({
      outcome: "completed",
      text: expect.stringContaining("Steering image received"),
    });
    expect(await receipt).toMatchObject({ status: "consumed" });
    expect(calls).toBe(2);
  });

  test("rejects unsupported steering images before insertion into the active queue", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controlled = createControlledPiModels({
      respond: async () => {
        started.resolve();
        await release.promise;
        return "Text only";
      },
    });
    const runtime = createPiAgentRuntime(process.cwd(), controlled.models);
    const running = runtime.run(request, () => {});
    await started.promise;
    await expect(runtime.steer(request.trailId, "Image", [image])).rejects.toThrow(
      "does not support image input",
    );
    release.resolve();
    expect(await running).toMatchObject({ outcome: "completed", text: "Text only" });
  });

  test("redacts bytes without imposing a provider-neutral image token allowance", () => {
    const message = { role: "user" as const, content: [{ type: "image" as const, ...image }], timestamp: 0 };
    const larger = {
      ...message,
      content: [{ type: "image" as const, ...image, data: image.data.repeat(1000) }],
    };
    expect(imageSafeJson(message)).toBe(imageSafeJson(larger));
    const budget = {
      systemPrompt: "",
      activeToolMaterial: "",
      activeToolCount: 0,
      tokenBudget: 10000,
      planId: "image-budget",
    };
    const smallProjection = createPiRequestBudgetProjector().project({ ...budget, messages: [message] });
    const largeProjection = createPiRequestBudgetProjector().project({ ...budget, messages: [larger] });
    expect(largeProjection.estimatedTokens).toBe(smallProjection.estimatedTokens);
    expect(largeProjection.messages[0]).toEqual(larger);
    const highResolution = Buffer.from(image.data, "base64");
    highResolution.writeUInt32BE(1024, 16);
    highResolution.writeUInt32BE(1024, 20);
    expect(() =>
      createPiRequestBudgetProjector().project({
        ...budget,
        messages: [
          { ...message, content: [{ type: "image", ...image, data: highResolution.toString("base64") }] },
        ],
      }),
    ).not.toThrow();
    expect(smallProjection.estimatedTokens).toBeLessThan(1024);
    const components = requestContextComponents({
      systemPrompt: "",
      skillsPrompt: "",
      tools: "",
      messages: [larger],
    });
    expect(JSON.stringify(components)).not.toContain(image.data);
    expect(JSON.stringify(components)).toContain("image tokens not estimated");
  });
});

test.each([1, 2])("repeated frozen image references support %i occurrence omissions", async (count) => {
  const controlled = createControlledPiModels({ imageInput: true });
  const runtime = createPiAgentRuntime(process.cwd(), controlled.models);
  const { canonicalDigest: _digest, ...base } = plan();
  const unsigned = {
    ...base,
    conversationHistory: (base.conversationHistory ?? []).map((entry) => ({
      ...entry,
      attachments: [attachment, attachment],
    })),
  };
  const frozen = { ...unsigned, canonicalDigest: frozenTurnPlanDigest(unsigned) };
  const result = await runtime.run(
    {
      ...request,
      frozenTurnPlan: frozen,
      history: [
        {
          role: "user",
          content: "Previous image\nAttached file: /workspace/.noesis/artifacts/pixel.png",
          createdAt: frozen.createdAt,
          attachments: [attachment, attachment],
          images: count === 1 ? [image] : [],
          omittedImageArtifactIds: Array.from({ length: count }, () => attachment.artifact.artifactId),
        },
      ],
    },
    () => {},
  );
  expect(result.outcome).toBe("completed");
});

test("model input does not inherit thumbnail byte or dimension bounds", () => {
  const runtime = createPiAgentRuntime(process.cwd(), createControlledPiModels({ imageInput: true }).models);
  // Header-only transport fixtures. Format/decode acceptance belongs to the provider.
  const bytes = Buffer.alloc(11 * 1024 * 1024);
  Buffer.from(image.data, "base64").copy(bytes);
  bytes.writeUInt32BE(20_000, 16);
  bytes.writeUInt32BE(20_000, 20);
  expect(() =>
    runtime.validateImages?.(request.provider, request.model, [{ ...image, data: bytes.toString("base64") }]),
  ).not.toThrow();
});
