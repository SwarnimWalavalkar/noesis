import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ConfigOverrides } from "@noesis/config";
import { createConditionalObject } from "@noesis/domain";

export interface CliInput {
  readonly args: readonly string[];
  readonly command: string;
  readonly subcommand?: string;
  readonly authProvider?: string;
  readonly skillSource?: string;
  readonly skillScope?: "personal" | "workspace";
  readonly workspaceTrusted: boolean;
  readonly home: string;
  readonly overrides: ConfigOverrides;
  readonly session:
    | {
        readonly mode: "new";
      }
    | {
        readonly mode: "pick";
      }
    | {
        readonly mode: "continue";
      }
    | {
        readonly mode: "resume";
        readonly trailId: string;
      };
}
type SessionStartup = CliInput["session"];
const COMMANDS = new Set([
  "tui",
  "onboard",
  "inspect",
  "rebuild",
  "config",
  "auth",
  "skills",
  "update",
  "help",
]);
const CONFIG_COMMANDS = new Set(["show", "init", "set"]);
const AUTH_COMMANDS = new Set(["status", "login", "logout"]);
const SKILL_COMMANDS = new Set(["list", "install", "update", "remove"]);
// SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
const AGENT_OPTIONS = ["--provider", "--model", "--thinking-level"] as const;
// SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
const VALUE_OPTIONS = ["--home", ...AGENT_OPTIONS] as const;
function parseSessionStartup(
  args: readonly string[],
  command: string,
): {
  readonly session: SessionStartup;
  readonly consumed: ReadonlySet<number>;
} {
  if (args.some((argument) => argument.startsWith("--resume=")))
    throw new Error("Use --resume <session-id>, with a space before the session ID");
  if (args.some((argument) => argument.startsWith("--continue=")))
    throw new Error("--continue does not accept a value");
  const resumeIndexes = args.flatMap((argument, index) => (argument === "--resume" ? [index] : []));
  const continueIndexes = args.flatMap((argument, index) => (argument === "--continue" ? [index] : []));
  if (resumeIndexes.length > 1) throw new Error("--resume may be specified only once");
  if (continueIndexes.length > 1) throw new Error("--continue may be specified only once");
  if (resumeIndexes.length > 0 && continueIndexes.length > 0)
    throw new Error("--continue and --resume are mutually exclusive");
  if (resumeIndexes.length > 0 && command !== "tui")
    throw new Error("--resume is available only with the tui command");
  if (continueIndexes.length > 0 && command !== "tui")
    throw new Error("--continue is available only with the tui command");
  const consumed = new Set<number>();
  const continueIndex = continueIndexes[0];
  if (continueIndex !== undefined) {
    const value = args[continueIndex + 1];
    if (value !== undefined && !value.startsWith("--"))
      throw new Error("--continue does not accept a value or trailing operand");
    consumed.add(continueIndex);
    return { session: { mode: "continue" }, consumed };
  }
  const resumeIndex = resumeIndexes[0];
  const resumeValue = resumeIndex === undefined ? undefined : args[resumeIndex + 1];
  const resumeId = resumeValue && !resumeValue.startsWith("--") ? resumeValue.trim() : undefined;
  if (resumeValue !== undefined && !resumeValue.startsWith("--") && !resumeId)
    throw new Error("--resume session ID must not be empty");
  if (resumeIndex !== undefined) {
    consumed.add(resumeIndex);
    if (resumeId) consumed.add(resumeIndex + 1);
  }
  return {
    session:
      resumeIndex === undefined
        ? { mode: "new" }
        : resumeId
          ? { mode: "resume", trailId: resumeId }
          : { mode: "pick" },
    consumed,
  };
}
export function parseArgs(argv: readonly string[]): CliInput {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const command = args[0] === undefined || args[0].startsWith("--") ? "tui" : args[0];
  if (!COMMANDS.has(command))
    throw new Error(
      `Unknown command ${command}. Use tui, onboard, inspect, rebuild, config, auth, skills, update, or help.`,
    );
  const commandIndex = command === "tui" && args[0]?.startsWith("--") ? -1 : 0;
  const consumed = new Set<number>();
  if (commandIndex === 0) consumed.add(0);
  const optionValues = new Map<string, string>();
  for (const name of VALUE_OPTIONS) {
    const indexes = args.flatMap((argument, index) => (argument === name ? [index] : []));
    if (indexes.length > 1) throw new Error(`${name} may be specified only once`);
    const index = indexes[0];
    if (index === undefined) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
    consumed.add(index);
    consumed.add(index + 1);
    optionValues.set(name, value);
  }
  const startup = parseSessionStartup(args, command);
  for (const index of startup.consumed) consumed.add(index);
  const helpIndexes = args.flatMap((argument, index) => (argument === "--help" ? [index] : []));
  if (helpIndexes.length > 1) throw new Error("--help may be specified only once");
  if (helpIndexes[0] !== undefined) consumed.add(helpIndexes[0]);
  const workspaceIndexes = args.flatMap((argument, index) => (argument === "--workspace" ? [index] : []));
  if (workspaceIndexes.length > 1) throw new Error("--workspace may be specified only once");
  if (workspaceIndexes[0] !== undefined) consumed.add(workspaceIndexes[0]);
  const trustWorkspaceIndexes = args.flatMap((argument, index) =>
    argument === "--trust-workspace" ? [index] : [],
  );
  if (trustWorkspaceIndexes.length > 1) throw new Error("--trust-workspace may be specified only once");
  if (trustWorkspaceIndexes[0] !== undefined) consumed.add(trustWorkspaceIndexes[0]);
  const operands = args.filter((argument, index) => !consumed.has(index) && !argument.startsWith("--"));
  const unknownOption = args.find((argument, index) => !consumed.has(index) && argument.startsWith("--"));
  if (unknownOption) throw new Error(`Unknown ${command} option ${unknownOption}`);
  let subcommand: string | undefined;
  let authProvider: string | undefined;
  let skillSource: string | undefined;
  if (command === "config") {
    subcommand = operands[0] ?? "show";
    if (!CONFIG_COMMANDS.has(subcommand))
      throw new Error("Unknown config command. Use config show, config init, or config set.");
    if (operands[1]) throw new Error(`Unexpected config argument ${operands[1]}`);
  } else if (command === "auth") {
    subcommand = operands[0] ?? "status";
    if (!AUTH_COMMANDS.has(subcommand))
      throw new Error("Unknown auth command. Use auth login, auth status, or auth logout.");
    authProvider = operands[1];
    if (operands[2]) throw new Error(`Unexpected auth argument ${operands[2]}`);
  } else if (command === "skills") {
    subcommand = operands[0] ?? "list";
    if (!SKILL_COMMANDS.has(subcommand))
      throw new Error("Unknown skills command. Use skills list, install, update, or remove.");
    skillSource = operands[1];
    if ((subcommand === "install" || subcommand === "remove") && !skillSource)
      throw new Error(`skills ${subcommand} requires a package, Git, URL, or local path source`);
    if (operands[2]) throw new Error(`Unexpected skills argument ${operands[2]}`);
  } else if (operands[0]) {
    throw new Error(`Unexpected ${command} argument ${operands[0]}`);
  }
  const allowedOptions = new Set<string>(["--help"]);
  if (command !== "help" && command !== "update") allowedOptions.add("--home");
  if (command === "tui" || command === "inspect" || command === "rebuild")
    for (const name of AGENT_OPTIONS) allowedOptions.add(name);
  if (command === "config" && (subcommand === "show" || subcommand === "set"))
    for (const name of AGENT_OPTIONS) allowedOptions.add(name);
  if (command === "tui") {
    allowedOptions.add("--resume");
    allowedOptions.add("--continue");
    allowedOptions.add("--trust-workspace");
  }
  if (command === "skills") {
    allowedOptions.add("--workspace");
    allowedOptions.add("--trust-workspace");
  }
  if (workspaceIndexes[0] !== undefined && !allowedOptions.has("--workspace"))
    throw new Error("--workspace is valid only for skills commands");
  if (trustWorkspaceIndexes[0] !== undefined && !allowedOptions.has("--trust-workspace"))
    throw new Error("--trust-workspace is valid only for the tui or skills command");
  const startupOption =
    startup.session.mode === "new" ? [] : startup.session.mode === "continue" ? ["--continue"] : ["--resume"];
  for (const name of [...optionValues.keys(), ...startupOption]) {
    if (!allowedOptions.has(name)) {
      const scope = subcommand ? `${command} ${subcommand}` : command;
      throw new Error(`${name} is not valid for ${scope}`);
    }
  }
  const home = resolve(
    optionValues.get("--home") ?? process.env["NOESIS_HOME"] ?? join(homedir(), ".noesis"),
  );
  const provider = optionValues.get("--provider");
  const model = optionValues.get("--model");
  const thinkingLevel = optionValues.get("--thinking-level");
  // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
  return createConditionalObject({
    args,
    command,
  } as const)
    .addOptional(subcommand ? { subcommand } : undefined)
    .addOptional(authProvider ? { authProvider } : undefined)
    .addOptional(skillSource ? { skillSource } : undefined)
    .addOptional(
      command === "skills"
        ? {
            skillScope: workspaceIndexes[0] === undefined ? ("personal" as const) : ("workspace" as const),
          }
        : undefined,
    )
    .add({
      workspaceTrusted: trustWorkspaceIndexes[0] !== undefined,
      home,
      session: startup.session,
      overrides: createConditionalObject({} as const)
        .addOptional(provider !== undefined ? { provider } : undefined)
        .addOptional(model !== undefined ? { model } : undefined)
        .addOptional(thinkingLevel !== undefined ? { thinkingLevel } : undefined)
        .finish(),
    } as const)
    .finish();
}
