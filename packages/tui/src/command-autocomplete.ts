import {
  type AutocompleteItem,
  type AutocompleteProvider,
  CombinedAutocompleteProvider,
  type SlashCommand,
} from "@earendil-works/pi-tui";

const MODEL_PROVIDER_COMPLETIONS: readonly AutocompleteItem[] = [
  {
    value: "openai-codex/",
    label: "openai-codex/",
    description: "Codex OAuth · enter a model ID after the slash",
  },
  {
    value: "openrouter/",
    label: "openrouter/",
    description: "OpenRouter · enter a provider/model ID after the slash",
  },
];

const completeModelProvider = (argumentPrefix: string): AutocompleteItem[] => {
  const normalizedPrefix = argumentPrefix.trim().toLowerCase();
  if (!normalizedPrefix) return [...MODEL_PROVIDER_COMPLETIONS];
  return MODEL_PROVIDER_COMPLETIONS.filter((item) => item.value.includes(normalizedPrefix));
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
    name: "model",
    description: "Start a session with a different model",
    argumentHint: "<provider>/<model>",
    getArgumentCompletions: completeModelProvider,
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
    name: "scripts",
    description: "List reusable scripts",
  },
  {
    name: "script",
    description: "Inspect one reusable script",
    argumentHint: "<name>",
  },
  {
    name: "workflows",
    description: "List multi-phase workflows",
  },
  {
    name: "workflow",
    description: "Inspect one workflow",
    argumentHint: "<name>",
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
): AutocompleteProvider {
  const builtInNames = new Set<string>(NOESIS_SLASH_COMMANDS.map((command) => command.name));
  const seenSkillNames = new Set<string>();
  const skillCommands: SlashCommand[] = skills.flatMap((skill) => {
    if (seenSkillNames.has(skill.name)) return [];
    seenSkillNames.add(skill.name);
    return [
      {
        name: builtInNames.has(skill.name) ? `skill:${skill.name}` : skill.name,
        description: `Skill · ${skill.description}${skill.disableModelInvocation ? " · explicit only" : ""}`,
        argumentHint: "[instructions]",
      },
    ];
  });
  const provider = new CombinedAutocompleteProvider(
    [...NOESIS_SLASH_COMMANDS, ...skillCommands],
    process.cwd(),
  );

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
