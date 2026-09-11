import { imageSafeJson } from "./image-input.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { brokerToolAlias, FOREGROUND_DIRECT_TOOL_NAMES, piBrokerToolDefinition } from "./broker-tools.ts";
import { piExecuteToolDefinition, type PiFrozenToolCatalog } from "./execute-tool.ts";
import {
  estimateInputTokens,
  type AgentContextComponent,
  type AgentContextInspection,
} from "@noesis/agent-types";

export function foregroundToolContext(
  tools: readonly Pick<
    PiFrozenToolCatalog["tools"][number],
    "name" | "label" | "description" | "inputSchema" | "outputSchema"
  >[],
): string {
  const direct = FOREGROUND_DIRECT_TOOL_NAMES.map((name) => {
    const descriptor = tools.find((tool) => tool.name === name);
    if (!descriptor) throw new Error(`Missing foreground tool contract: ${name}`);
    return piBrokerToolDefinition(descriptor, brokerToolAlias(name));
  });
  return JSON.stringify(
    [piExecuteToolDefinition({ tools }), ...direct].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    })),
  );
}

/** Use Pi's normalized token accounting; zero cache reads are a valid result. */
export function inspectCacheUsage(usage: {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}): AgentContextInspection["cache"] {
  const values = [usage.input, usage.cacheRead, usage.cacheWrite];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return undefined;
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) return undefined;
  return { inputTokens, readTokens: usage.cacheRead, writeTokens: usage.cacheWrite };
}

export function contextComponent(label: string, content: string): AgentContextComponent {
  return { label, tokens: content.length === 0 ? 0 : estimateInputTokens(content), content };
}

/** Count complete projected material; retain only a bounded, labelled inspection preview. */
export function requestContextComponents(input: {
  readonly systemPrompt: string;
  readonly skillsPrompt: string;
  readonly tools: string;
  readonly messages: readonly AgentMessage[];
}): readonly AgentContextComponent[] {
  const groups = new Map<string, string[]>([
    ["System & Capability instructions", [input.systemPrompt]],
    ["Skill catalog", [input.skillsPrompt]],
    ["Tools", [input.tools]],
    ["User messages & context notes", []],
    ["Assistant messages & reasoning", []],
    ["Tool results & loaded skills", []],
  ]);
  for (const message of input.messages) {
    const label =
      message.role === "user"
        ? "User messages & context notes"
        : message.role === "assistant"
          ? "Assistant messages & reasoning"
          : "Tool results & loaded skills";
    groups.get(label)?.push(imageSafeJson("content" in message ? message.content : message));
  }
  return [...groups].map(([label, parts]) => {
    const content = parts.join("\n\n");
    const component = contextComponent(label, content);
    return {
      ...component,
      content:
        content.length > 16000
          ? `${content.slice(0, 16000)}\n\n[Inspection preview truncated; token estimate includes the complete component.]`
          : content,
    };
  });
}
