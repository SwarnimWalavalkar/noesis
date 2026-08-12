import type { TuiMcpServerDetail, TuiMcpServerSummary } from "./runtime-port.ts";
import { ANSI, safeTerminalText } from "./theme.ts";

export interface McpCapabilityItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly lines: readonly string[];
}

function encodeJson(value: unknown): string {
  try {
    return JSON.stringify(value, undefined, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function safeMcpLines(lines: readonly string[]): readonly string[] {
  return lines.flatMap((line) => safeTerminalText(line).split("\n"));
}

export function safeMcpScalar(text: string): string {
  return safeTerminalText(text).replaceAll("\t", " ").replaceAll("\n", " ");
}

export function mcpStatusGlyph(status: TuiMcpServerSummary["status"]): string {
  if (status === "connected") return "●";
  if (status === "connecting") return "◐";
  if (status === "auth_required") return "!";
  if (status === "failed") return "×";
  return "○";
}

export function mcpStatusColor(status: TuiMcpServerSummary["status"]): string {
  if (status === "connected") return ANSI.green;
  if (status === "connecting") return ANSI.cyan;
  if (status === "auth_required") return ANSI.yellow;
  if (status === "failed") return ANSI.red;
  return ANSI.dim;
}

export function mcpServerIdentity(server: Pick<TuiMcpServerSummary, "scope" | "name">): string {
  return `${server.scope}:${server.name}`;
}

export function parseMcpArguments(
  value: string,
): { readonly ok: true; readonly value: readonly string[] } | { readonly ok: false; readonly error: string } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: Object.freeze([]) };
  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: 'Arguments must be a JSON array of strings, for example ["-y", "server"].' };
  }
  if (!Array.isArray(decoded) || !decoded.every((entry) => typeof entry === "string"))
    return { ok: false, error: "Arguments must be a JSON array containing only strings." };
  return { ok: true, value: Object.freeze([...decoded]) };
}

export function validateMcpRemoteUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return "Server URL must use http:// or https://.";
    return undefined;
  } catch {
    return "Server URL must be a valid http:// or https:// URL.";
  }
}

export function mcpToolItems(detail: TuiMcpServerDetail): readonly McpCapabilityItem[] {
  return detail.tools.map((tool) => ({
    id: tool.name,
    label: safeMcpScalar(tool.name),
    ...(tool.description ? { description: safeMcpScalar(tool.description) } : {}),
    lines: safeMcpLines([
      ...(tool.description ? [tool.description, ""] : []),
      "Input schema",
      encodeJson(tool.inputSchema),
      ...(tool.outputSchema === undefined ? [] : ["", "Output schema", encodeJson(tool.outputSchema)]),
    ]),
  }));
}

export function mcpPromptItems(detail: TuiMcpServerDetail): readonly McpCapabilityItem[] {
  return detail.prompts.map((prompt) => ({
    id: prompt.name,
    label: safeMcpScalar(prompt.name),
    ...(prompt.description ? { description: safeMcpScalar(prompt.description) } : {}),
    lines: safeMcpLines([
      ...(prompt.description ? [prompt.description, ""] : []),
      `Arguments · ${String(prompt.arguments?.length ?? 0)}`,
      ...(prompt.arguments ?? []).map(
        (argument) =>
          `${argument.required ? "*" : "·"} ${argument.name}${argument.description ? ` — ${argument.description}` : ""}`,
      ),
    ]),
  }));
}

export function mcpResourceItems(detail: TuiMcpServerDetail): readonly McpCapabilityItem[] {
  return detail.resources.map((resource) => ({
    id: resource.uri,
    label: safeMcpScalar(resource.name ?? resource.uri),
    ...(resource.description ? { description: safeMcpScalar(resource.description) } : {}),
    lines: safeMcpLines([
      `URI · ${resource.uri}`,
      ...(resource.mimeType ? [`Media type · ${resource.mimeType}`] : []),
      ...(resource.description ? ["", resource.description] : []),
    ]),
  }));
}

export function mcpTemplateItems(detail: TuiMcpServerDetail): readonly McpCapabilityItem[] {
  return detail.resourceTemplates.map((template) => ({
    id: template.uriTemplate,
    label: safeMcpScalar(template.name ?? template.uriTemplate),
    ...(template.description ? { description: safeMcpScalar(template.description) } : {}),
    lines: safeMcpLines([
      `URI template · ${template.uriTemplate}`,
      ...(template.mimeType ? [`Media type · ${template.mimeType}`] : []),
      ...(template.description ? ["", template.description] : []),
    ]),
  }));
}

export function mcpConnectionLines(detail: TuiMcpServerDetail): readonly string[] {
  const common = [
    `Name · ${detail.name}`,
    `Scope · ${detail.scope}`,
    `Status · ${detail.status.replaceAll("_", " ")}`,
    `Enabled · ${detail.enabled ? "yes" : "no"}`,
    `Source · ${detail.sourcePath}`,
    `Negotiated · ${detail.negotiatedCapabilities.join(", ") || "none"}`,
  ];
  const lines =
    detail.config.type === "local"
      ? [
          ...common,
          "Transport · local stdio",
          `Command · ${detail.config.command.join(" ")}`,
          ...(detail.config.cwd ? [`Working directory · ${detail.config.cwd}`] : []),
          `Environment references · ${Object.keys(detail.config.environmentReferences ?? {}).join(", ") || "none"}`,
        ]
      : [
          ...common,
          "Transport · remote HTTP",
          `URL · ${detail.config.url}`,
          `OAuth · ${detail.config.oauth ? "enabled" : "disabled"}`,
          `Header references · ${Object.keys(detail.config.headers ?? {}).join(", ") || "none"}`,
        ];
  return safeMcpLines(lines);
}

export function mcpOAuthActionsAvailable(detail: TuiMcpServerDetail, mutationsEnabled: boolean): boolean {
  return mutationsEnabled && !detail.shadowed && detail.config.type === "remote" && detail.config.oauth;
}

export function mcpLiveActionsAvailable(detail: TuiMcpServerDetail, mutationsEnabled: boolean): boolean {
  return mutationsEnabled && !detail.shadowed && detail.enabled;
}

export function mcpManagerHint(input: {
  readonly screenKind: "list" | "server" | "collection" | "text" | "input" | "choice" | "confirm";
  readonly detail?: TuiMcpServerDetail;
  readonly mutationsEnabled: boolean;
  readonly busy: boolean;
  readonly cancellable: boolean;
}): string {
  if (input.busy)
    return input.cancellable
      ? "Please wait · Esc cancel operation"
      : "Please wait for the operation to finish";
  if (!input.mutationsEnabled) return "Read-only while the active turn finishes · Esc back";
  if (input.screenKind === "list")
    return "↑/↓ select · Enter open · l local · r remote · g reload · Esc close";
  if (input.screenKind === "server") {
    if (input.detail && mcpOAuthActionsAvailable(input.detail, true))
      return "↑/↓ select · Enter open · a auth · l logout · e enable/disable · r reconnect · d edit · x remove · Esc back";
    return input.detail?.shadowed || input.detail?.enabled === false
      ? "↑/↓ select · Enter open · e enable/disable · d edit · x remove · Esc back"
      : "↑/↓ select · Enter open · e enable/disable · r reconnect · d edit · x remove · Esc back";
  }
  if (input.screenKind === "collection") return "↑/↓ select · Enter inspect · Esc back";
  if (input.screenKind === "text") return "↑/↓ scroll · PgUp/PgDn scroll · Esc back";
  if (input.screenKind === "input") return "Enter continue · Esc back";
  if (input.screenKind === "choice") return "↑/↓ select · 1-9 jump · Enter continue · Esc back";
  return "Enter / y confirm · Esc / n cancel";
}

export function mcpServerOptions(
  detail: TuiMcpServerDetail,
  mutationsEnabled = true,
): readonly McpCapabilityItem[] {
  const oauthActionsAvailable = mcpOAuthActionsAvailable(detail, mutationsEnabled);
  const liveActionsAvailable = mcpLiveActionsAvailable(detail, mutationsEnabled);
  return [
    {
      id: "tools",
      label: `Tools (${String(detail.tools.length)})`,
      description: "Names, descriptions, and schemas",
      lines: [],
    },
    {
      id: "prompts",
      label: `Prompts (${String(detail.prompts.length)})`,
      description: "Prompt arguments and metadata",
      lines: [],
    },
    {
      id: "resources",
      label: `Resources (${String(detail.resources.length)})`,
      description: "URIs and media types",
      lines: [],
    },
    {
      id: "templates",
      label: `Resource templates (${String(detail.resourceTemplates.length)})`,
      description: "URI templates and metadata",
      lines: [],
    },
    { id: "instructions", label: "Server instructions", lines: [] },
    { id: "connection", label: "Connection details", lines: [] },
    {
      id: "errors",
      label: `Recent errors (${String(detail.recentErrors.length)})`,
      lines: [],
    },
    ...(oauthActionsAvailable
      ? [
          {
            id: "authenticate",
            label: "Authenticate",
            description: "Start or refresh MCP OAuth",
            lines: [],
          },
          { id: "logout", label: "Log out", description: "Remove stored MCP OAuth credentials", lines: [] },
        ]
      : []),
    ...(mutationsEnabled
      ? [
          {
            id: "toggle",
            label: detail.enabled ? "Disable" : "Enable",
            description: detail.shadowed ? "Update this overridden definition" : "Applies to future turns",
            lines: [],
          },
          ...(liveActionsAvailable
            ? [
                {
                  id: "reconnect",
                  label: "Reconnect",
                  description: "Refresh connection and discovery",
                  lines: [],
                },
              ]
            : []),
          { id: "edit", label: "Edit", description: safeMcpScalar(detail.sourcePath), lines: [] },
          { id: "remove", label: "Remove", description: `Delete the ${detail.scope} entry`, lines: [] },
        ]
      : []),
  ];
}
