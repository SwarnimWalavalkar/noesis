/** Syntactic routing only. Unknown slash text, including skill invocations, belongs to the runtime. */
export type SubmissionRoute =
  | { readonly kind: "prompt" }
  | {
      readonly kind: "local" | "control" | "composer";
      readonly name: string;
      readonly command: string;
    }
  | {
      readonly kind: "exclusive";
      readonly name: string;
      readonly command: string;
      readonly scope: "current-session" | "resulting-session";
    };

type CommandDefinition = {
  readonly name: string;
  readonly arguments?: boolean;
} & (
  | { readonly kind: "local" | "control" | "composer" }
  | { readonly kind: "exclusive"; readonly scope: "current-session" | "resulting-session" }
);

// Match the command's grammar, not merely its first slash-prefixed word. For example,
// `/help explain this` is prose, while `/skill NAME` is an inspection command.
const COMMANDS: readonly CommandDefinition[] = [
  ...["help", "context", "capabilities", "mcp", "skills", "programs", "runs", "learning"].map(
    (name): CommandDefinition => ({ name, kind: "local" }),
  ),
  ...["skill", "program", "run"].map((name): CommandDefinition => ({ name, kind: "local", arguments: true })),
  ...["quit", "abort"].map((name): CommandDefinition => ({ name, kind: "control" })),
  ...["steer", "queue"].map((name): CommandDefinition => ({ name, kind: "control", arguments: true })),
  ...["attach", "attachments", "detach"].map((name): CommandDefinition => ({
    name,
    kind: "composer",
    arguments: true,
  })),
  ...["compact", "reasoning"].map((name): CommandDefinition => ({
    name,
    kind: "exclusive",
    scope: "current-session",
    arguments: true,
  })),
  ...["model", "provider"].map((name): CommandDefinition => ({
    name,
    kind: "exclusive",
    scope: "resulting-session",
    arguments: true,
  })),
  ...["resume", "fork"].map((name): CommandDefinition => ({
    name,
    kind: "exclusive",
    scope: "resulting-session",
  })),
];

/** Preserve prompt bytes at the caller. Only a recognized command consumes the submitted text. */
export function routeSubmission(text: string): SubmissionRoute {
  const command = text.trim();
  if (command === "?") return { kind: "local", name: "help", command: "/help" };
  // Retain the existing column-zero escape for the learning explorer.
  if (command === "/learning" && text !== text.trimStart()) return { kind: "prompt" };
  const definition = COMMANDS.find(
    (entry) => command === `/${entry.name}` || (entry.arguments && command.startsWith(`/${entry.name} `)),
  );
  if (!definition) return { kind: "prompt" };
  if (definition.kind === "exclusive")
    return { kind: definition.kind, name: definition.name, command, scope: definition.scope };
  return { kind: definition.kind, name: definition.name, command };
}
