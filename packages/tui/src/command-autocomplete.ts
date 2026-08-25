import {
  type AutocompleteItem,
  type AutocompleteProvider,
  CombinedAutocompleteProvider,
  fuzzyFilter,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import type { TuiModelRoute } from "./runtime-port.ts";

const PROVIDER_COMPLETIONS: readonly AutocompleteItem[] = [
  {
    value: "openai-codex",
    label: "openai-codex",
    description: "OpenAI Codex OAuth",
  },
  {
    value: "anthropic",
    label: "anthropic",
    description: "Anthropic",
  },
  { value: "openrouter", label: "openrouter", description: "OpenRouter" },
  { value: "opencode", label: "opencode", description: "OpenCode Zen" },
  { value: "opencode-go", label: "opencode-go", description: "OpenCode Go" },
];

const completeProvider = (argumentPrefix: string): AutocompleteItem[] => {
  const normalizedPrefix = argumentPrefix.trim().toLowerCase();
  if (!normalizedPrefix) return [...PROVIDER_COMPLETIONS];
  return PROVIDER_COMPLETIONS.filter((item) => item.value.includes(normalizedPrefix));
};

const THINKING_COMPLETIONS: readonly AutocompleteItem[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
].map((value) => ({ value, label: value, description: "Reasoning effort" }));

const completeThinking = (argumentPrefix: string): AutocompleteItem[] => {
  const prefix = argumentPrefix.trim().toLowerCase();
  return THINKING_COMPLETIONS.filter((item) => !prefix || item.value.startsWith(prefix));
};

export interface TuiCommandAutocompleteContext {
  readonly listModelRoutes?: () => readonly TuiModelRoute[];
  readonly currentRoute?: () =>
    | {
        readonly provider: string;
        readonly model: string;
      }
    | undefined;
}

const completeModel = (
  argumentPrefix: string,
  context: TuiCommandAutocompleteContext,
): AutocompleteItem[] => {
  const current = context.currentRoute?.();
  if (!current) return [];
  const routes = (context.listModelRoutes?.() ?? [])
    .filter((route) => route.provider === current.provider)
    .sort((left, right) => {
      if (left.model === current.model) return -1;
      if (right.model === current.model) return 1;
      if (left.default !== right.default) return left.default ? -1 : 1;
      return left.model.localeCompare(right.model);
    });
  return fuzzyFilter(routes, argumentPrefix.trim(), (route) => `${route.model} ${route.name}`).map(
    (route) => ({
      value: route.model,
      label: route.model,
      description: `${route.name}${route.model === current.model ? " · current" : ""}`,
    }),
  );
};

const completeQueueCommand = (argumentPrefix: string): AutocompleteItem[] => {
  const normalizedPrefix = argumentPrefix.trim().toLowerCase();
  const item = {
    value: "resume",
    label: "resume",
    description: "Resume delivery of queued messages after reopening a session",
  };
  return !normalizedPrefix || item.value.startsWith(normalizedPrefix) ? [item] : [];
};

export interface SkillSlashCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly disableModelInvocation?: boolean;
}

/** Skill discovery enriches autocomplete but must never gate TUI startup. */
export async function loadSkillSlashCommands(
  discover?: () => Promise<readonly SkillSlashCommand[]>,
): Promise<readonly SkillSlashCommand[]> {
  if (!discover) return Object.freeze([]);
  try {
    return await discover();
  } catch {
    return Object.freeze([]);
  }
}

// SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
export const NOESIS_SLASH_COMMANDS = [
  {
    name: "help",
    description: "Show commands and usage",
  },
  {
    name: "provider",
    description: "Start a fresh session with another provider",
    argumentHint: "[provider]",
    getArgumentCompletions: completeProvider,
  },
  {
    name: "model",
    description: "Pick a model or start a fresh session inline",
    argumentHint: "[model]",
  },
  {
    name: "reasoning",
    description: "Pick reasoning effort or change it inline",
    argumentHint: "[level]",
    getArgumentCompletions: completeThinking,
  },
  {
    name: "context",
    description: "Inspect the current context",
  },
  {
    name: "capabilities",
    description: "Inspect active capabilities",
  },
  {
    name: "skills",
    description: "List installed and discoverable skills",
  },
  {
    name: "skill",
    description: "Inspect one skill",
    argumentHint: "<name>",
  },
  {
    name: "programs",
    description: "List saved Programs",
  },
  {
    name: "program",
    description: "Inspect one Program",
    argumentHint: "<script|workflow> <name>",
  },
  {
    name: "runs",
    description: "List recent codemode and workflow runs",
  },
  {
    name: "run",
    description: "Inspect one run",
    argumentHint: "<execution-id>",
  },
  {
    name: "learning",
    description: "Inspect ambient reflection and learning activity",
  },
  {
    name: "mcp",
    description: "Manage MCP servers and inspect their capabilities",
  },
  {
    name: "fork",
    description: "Fork the current session",
  },
  {
    name: "resume",
    description: "Resume a saved session",
  },
  {
    name: "compact",
    description: "Compact the current context",
  },
  {
    name: "steer",
    description: "Redirect active work, or promote the newest queued message",
    argumentHint: "[message]",
  },
  {
    name: "queue",
    description: "Control pending messages",
    argumentHint: "<resume>",
    getArgumentCompletions: completeQueueCommand,
  },
  {
    name: "abort",
    description: "Interrupt active work",
  },
  {
    name: "quit",
    description: "Exit Noesis",
  },
] as const satisfies readonly SlashCommand[];

export function createNoesisCommandAutocompleteProvider(
  skills: readonly SkillSlashCommand[] = [],
  context: TuiCommandAutocompleteContext = {},
): AutocompleteProvider {
  const builtInNames = new Set<string>(NOESIS_SLASH_COMMANDS.map((command) => command.name));
  const seenSkillNames = new Set<string>();
  const skillCommands: SlashCommand[] = skills.flatMap((skill) => {
    return [skill.name, ...(skill.aliases ?? [])].flatMap((name) => {
      if (seenSkillNames.has(name)) return [];
      seenSkillNames.add(name);
      return [
        {
          name: builtInNames.has(name) ? `skill:${name}` : name,
          description: `${name === skill.name ? "Skill" : `Alias for ${skill.name}`} · ${skill.description}${skill.disableModelInvocation ? " · explicit only" : ""}`,
          argumentHint: "[instructions]",
        },
      ];
    });
  });
  const builtInCommands: SlashCommand[] = NOESIS_SLASH_COMMANDS.map((command) =>
    command.name === "model"
      ? {
          ...command,
          getArgumentCompletions: (argumentPrefix) => completeModel(argumentPrefix, context),
        }
      : command,
  );
  const provider = new CombinedAutocompleteProvider([...builtInCommands, ...skillCommands], process.cwd());

  return {
    getSuggestions: (lines, cursorLine, cursorCol, options) => {
      const currentLine = lines[cursorLine] ?? "";
      const beforeCursor = currentLine.slice(0, cursorCol);
      if (!beforeCursor.startsWith("/")) return Promise.resolve(null);

      // Pi's combined provider interprets a forced request as file completion. For Noesis,
      // Tab inside a slash command should complete the command or its static argument form.
      return provider.getSuggestions(lines, cursorLine, cursorCol, {
        ...options,
        force: false,
      });
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
    shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) => {
      const currentLine = lines[cursorLine] ?? "";
      return currentLine.slice(0, cursorCol).startsWith("/");
    },
  };
}
