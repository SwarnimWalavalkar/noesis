#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import {
  type ConfigOverrides,
  initializeNoesisConfig,
  type ResolvedNoesisConfig,
  readNoesisConfig,
  resolveNoesisConfig,
  updateNoesisConfig,
} from "@noesis/config";
import {
  createPiAgentRoleRunner,
  createPiAgentRuntime,
  createPiModelServices,
  createPiSkillLibrary,
  type NoesisAuthEvent,
  type NoesisAuthLoginCallbacks,
  type NoesisAuthPrompt,
  type PiAuthOperations,
} from "@noesis/runtime-pi";
import { startNoesisTui } from "@noesis/tui";
import {
  type OnboardingChoice,
  type OnboardingPrompts,
  runFirstLaunchOnboarding,
  shouldAutoOnboard,
} from "./onboarding.ts";
import { type ApplicationRuntime, createApplicationRuntimeComposition } from "./runtime-composition.ts";

interface CliInput {
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
    | { readonly mode: "new" }
    | { readonly mode: "pick" }
    | { readonly mode: "continue" }
    | { readonly mode: "resume"; readonly trailId: string };
}

type SessionStartup = CliInput["session"];

const COMMANDS = new Set(["tui", "onboard", "inspect", "rebuild", "config", "auth", "skills", "help"]);
const CONFIG_COMMANDS = new Set(["show", "init", "set"]);
const AUTH_COMMANDS = new Set(["status", "login", "logout"]);
const SKILL_COMMANDS = new Set(["list", "install", "update", "remove"]);
const AGENT_OPTIONS = ["--provider", "--model", "--thinking-level"] as const;
const VALUE_OPTIONS = ["--home", ...AGENT_OPTIONS] as const;

function parseSessionStartup(
  args: readonly string[],
  command: string,
): { readonly session: SessionStartup; readonly consumed: ReadonlySet<number> } {
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

function parseArgs(argv: readonly string[]): CliInput {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const command = args[0] === undefined || args[0].startsWith("--") ? "tui" : args[0];
  if (!COMMANDS.has(command))
    throw new Error(
      `Unknown command ${command}. Use tui, onboard, inspect, rebuild, config, auth, skills, or help.`,
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
  if (command !== "help") allowedOptions.add("--home");
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
  return {
    args,
    command,
    ...(subcommand ? { subcommand } : {}),
    ...(authProvider ? { authProvider } : {}),
    ...(skillSource ? { skillSource } : {}),
    ...(command === "skills"
      ? { skillScope: workspaceIndexes[0] === undefined ? ("personal" as const) : ("workspace" as const) }
      : {}),
    workspaceTrusted: trustWorkspaceIndexes[0] !== undefined,
    home,
    session: startup.session,
    overrides: {
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    },
  };
}

const CLI_HELP = `Noesis

Usage:
  noesis [tui] [--home PATH] [--trust-workspace] [agent options]
  noesis [tui] --continue [--home PATH] [agent options]
  noesis [tui] --resume [SESSION_ID] [--home PATH] [agent options]
  noesis onboard [--home PATH]
  noesis inspect|rebuild [--home PATH] [agent options]
  noesis config init [--home PATH]
  noesis config show|set [--home PATH] [agent options]
  noesis auth status|login|logout [PROVIDER] [--home PATH]
  noesis skills list [--workspace] [--trust-workspace] [--home PATH]
  noesis skills install|remove SOURCE [--workspace] [--trust-workspace] [--home PATH]
  noesis skills update [SOURCE] [--workspace] [--trust-workspace] [--home PATH]
  noesis help

Session startup:
  noesis                       Start a new independent session
  noesis --continue            Resume the single most recently active session
  noesis --resume              Choose a prior session interactively
  noesis --resume SESSION_ID   Resume that exact prior session

Agent options:
  --provider ID  --model ID  --thinking-level LEVEL

Home:
  Defaults to ~/.noesis.
  --home PATH overrides NOESIS_HOME.

Workspace trust:
  --trust-workspace  Allow this command to load or mutate workspace-selected skills.

The latest session is ordered by last activity, then full trail ID ascending on ties.
A session still marked running is not recovered or resumed automatically.
Unknown options, conflicting startup arguments, and trailing operands are rejected.`;

async function createRuntime(
  config: ResolvedNoesisConfig,
  options: {
    readonly recoverInterruptedOperations: boolean;
    readonly workspaceTrusted: boolean;
  },
): Promise<ApplicationRuntime> {
  const services = createPiModelServices(config.home);
  const skills = createPiSkillLibrary({
    cwd: process.cwd(),
    agentDirectory: join(config.home, "agent"),
    workspaceTrusted: options.workspaceTrusted,
  });
  return await createApplicationRuntimeComposition({
    config,
    skills,
    recoverInterruptedOperations: options.recoverInterruptedOperations,
    createAgent: (_sessionTools, codeExecution, selfTools, skillLibrary) =>
      createPiAgentRuntime(process.cwd(), services.models, {
        codeExecution,
        selfTools,
        requirePinnedSkillSnapshot: true,
        ...(skillLibrary ? { skills: skillLibrary } : {}),
      }),
    createRoleRunner: (configurations) =>
      createPiAgentRoleRunner(process.cwd(), services.models, configurations),
  });
}

function visiblePrompt(message: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolveAnswer, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const abort = () => {
      rl.close();
      reject(new Error("Authentication prompt cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    rl.question(`${message}: `, (answer) => {
      signal?.removeEventListener("abort", abort);
      rl.close();
      resolveAnswer(answer);
    });
  });
}

function secretPrompt(message: string, signal?: AbortSignal): Promise<string> {
  if (!process.stdin.isTTY) return visiblePrompt(message, signal);
  return new Promise((resolveAnswer, reject) => {
    let muted = false;
    const output = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) process.stdout.write(chunk, encoding);
        callback();
      },
    });
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    const abort = () => {
      rl.close();
      reject(new Error("Authentication prompt cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    rl.question(`${message}: `, (answer) => {
      signal?.removeEventListener("abort", abort);
      rl.close();
      process.stdout.write("\n");
      resolveAnswer(answer);
    });
    muted = true;
  });
}

async function handleAuthPrompt(prompt: NoesisAuthPrompt): Promise<string> {
  if (prompt.type === "select") {
    console.log(prompt.message);
    for (const item of prompt.options) console.log(`  ${item.id}: ${item.label}`);
    return await visiblePrompt("Selection", prompt.signal);
  }
  const message = `${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}`;
  return prompt.type === "secret"
    ? await secretPrompt(message, prompt.signal)
    : await visiblePrompt(message, prompt.signal);
}

function notifyAuth(event: NoesisAuthEvent): void {
  if (event.type === "auth_url") {
    console.log(`Open this URL in your browser:\n${event.url}`);
    if (event.instructions) console.log(event.instructions);
  } else if (event.type === "device_code") {
    console.log(`Open ${event.verificationUri} and enter code ${event.userCode}.`);
  } else console.log(event.message);
}

const interactiveAuthCallbacks: NoesisAuthLoginCallbacks = {
  prompt: handleAuthPrompt,
  notify: notifyAuth,
};

async function chooseOnboardingOption(
  message: string,
  choices: readonly OnboardingChoice[],
  defaultId: string,
): Promise<string> {
  for (;;) {
    console.log(`\n${message}`);
    choices.forEach((choice, index) => {
      const detail = choice.description ? ` — ${choice.description}` : "";
      console.log(`  ${index + 1}. ${choice.label}${detail}`);
    });
    const defaultChoice = choices.find((choice) => choice.id === defaultId);
    const answer = (
      await visiblePrompt(`Selection${defaultChoice ? ` [${defaultChoice.label}]` : ""}`)
    ).trim();
    if (answer.length === 0) return defaultId;
    const numbered = Number(answer);
    if (Number.isInteger(numbered) && numbered >= 1 && numbered <= choices.length)
      return choices[numbered - 1]?.id ?? defaultId;
    const direct = choices.find((choice) => choice.id === answer);
    if (direct) return direct.id;
    console.log("Choose one of the listed numbers or IDs.");
  }
}

const terminalOnboardingPrompts: OnboardingPrompts = {
  choose: chooseOnboardingOption,
  text: async (message, defaultValue) => {
    const answer = (await visiblePrompt(`${message} [${defaultValue}]`)).trim();
    return answer.length === 0 ? defaultValue : answer;
  },
  confirm: async (message, defaultValue) => {
    for (;;) {
      const hint = defaultValue ? "Y/n" : "y/N";
      const answer = (await visiblePrompt(`${message} [${hint}]`)).trim().toLowerCase();
      if (answer.length === 0) return defaultValue;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      console.log("Answer yes or no.");
    }
  },
  note: (message) => console.log(message),
};

function hasExplicitAgentSettings(input: CliInput): boolean {
  return (
    Object.values(input.overrides).some((value) => value !== undefined) ||
    ["NOESIS_PROVIDER", "NOESIS_MODEL", "NOESIS_THINKING_LEVEL"].some(
      (name) => process.env[name] !== undefined,
    )
  );
}

async function runOnboarding(input: CliInput): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "First-launch onboarding requires an interactive terminal. Run `noesis config init` for non-interactive setup.",
    );
  await runFirstLaunchOnboarding({
    home: input.home,
    prompts: terminalOnboardingPrompts,
    auth: createPiModelServices(input.home).auth,
    authCallbacks: interactiveAuthCallbacks,
  });
}

async function runAuth(input: CliInput, auth: PiAuthOperations): Promise<void> {
  const action = input.subcommand ?? "status";
  const provider = input.authProvider;
  if (action === "status") {
    const providers = provider ? [provider] : ["openai-codex", "openrouter"];
    console.log(JSON.stringify(await Promise.all(providers.map((id) => auth.status(id))), null, 2));
    return;
  }
  const selected = provider ?? "openai-codex";
  if (action === "login") {
    const status = await auth.login(selected, interactiveAuthCallbacks);
    console.log(`Authenticated ${status.provider} via ${status.source}.`);
    return;
  }
  if (action === "logout") {
    await auth.logout(selected);
    console.log(`Removed stored credentials for ${selected}.`);
    return;
  }
  throw new Error("Unknown auth command. Use auth login, auth status, or auth logout.");
}

async function runConfig(input: CliInput): Promise<void> {
  const action = input.subcommand ?? "show";
  if (action === "show") {
    console.log(
      JSON.stringify(await resolveNoesisConfig({ home: input.home, cli: input.overrides }), null, 2),
    );
    return;
  }
  if (action === "init") {
    console.log(`Initialized ${await initializeNoesisConfig(input.home)}`);
    return;
  }
  if (action === "set") {
    console.log(JSON.stringify(await updateNoesisConfig(input.home, input.overrides), null, 2));
    return;
  }
  throw new Error("Unknown config command. Use config show, config init, or config set.");
}

async function runSkills(input: CliInput): Promise<void> {
  const library = createPiSkillLibrary({
    cwd: process.cwd(),
    agentDirectory: join(input.home, "agent"),
    workspaceTrusted: input.workspaceTrusted,
  });
  const action = input.subcommand ?? "list";
  if (action === "list") {
    const snapshot = await library.snapshot();
    console.log(
      JSON.stringify(
        {
          skills: snapshot.skills.map(({ content: _content, ...skill }) => skill),
          diagnostics: snapshot.diagnostics,
          packages: library.configured(),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (action === "install") {
    if (!input.skillSource) throw new Error("skills install requires a source");
    await library.install(input.skillSource, input.skillScope ?? "personal");
    console.log(`Installed ${input.skillSource} for ${input.skillScope ?? "personal"} use.`);
    return;
  }
  if (action === "remove") {
    if (!input.skillSource) throw new Error("skills remove requires a source");
    const removed = await library.remove(input.skillSource, input.skillScope ?? "personal");
    console.log(removed ? `Removed ${input.skillSource}.` : `${input.skillSource} was not configured.`);
    return;
  }
  if (action === "update") {
    await library.update(input.skillSource, input.skillScope ?? "personal");
    console.log(input.skillSource ? `Updated ${input.skillSource}.` : "Updated configured skill packages.");
    return;
  }
  throw new Error("Unknown skills command. Use skills list, install, update, or remove.");
}

async function main(): Promise<void> {
  const input = parseArgs(process.argv.slice(2));
  if (input.args.includes("--help") || input.command === "help") {
    console.log(CLI_HELP);
    return;
  }
  if (input.command === "config") {
    await runConfig(input);
    return;
  }
  if (input.command === "auth") {
    await runAuth(input, createPiModelServices(input.home).auth);
    return;
  }
  if (input.command === "skills") {
    await runSkills(input);
    return;
  }
  const loaded = await readNoesisConfig(input.home);
  if (!loaded.ok) throw loaded.error;
  const configExists = loaded.value.raw !== undefined;
  if (input.command === "onboard") {
    if (configExists)
      throw new Error(
        `${input.home}/config.json already exists. Use \`noesis config set\` and \`noesis auth login\` to change setup.`,
      );
    await runOnboarding(input);
    return;
  }
  const autoOnboard = shouldAutoOnboard({
    command: input.command,
    configExists,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    hasExplicitAgentSettings: hasExplicitAgentSettings(input),
  });
  if (autoOnboard) await runOnboarding(input);
  else if (
    input.command === "tui" &&
    !configExists &&
    !hasExplicitAgentSettings(input) &&
    (!process.stdin.isTTY || !process.stdout.isTTY)
  )
    throw new Error(
      "No Noesis config found. Run `noesis onboard` in an interactive terminal or `noesis config init` for non-interactive setup.",
    );
  const config = await resolveNoesisConfig({ home: input.home, cli: input.overrides });
  const runtime = await createRuntime(config, {
    recoverInterruptedOperations: input.command === "tui",
    workspaceTrusted: input.workspaceTrusted,
  });
  try {
    if (input.command === "rebuild") {
      const documents = await runtime.debug.workspace.search.rebuildDocuments();
      console.log(`Rebuilt ${documents.length} SQLite search documents`);
    } else if (input.command === "inspect")
      console.log(
        JSON.stringify(
          {
            trails: runtime.listTrails(),
            activation: await runtime.debug.adaptations.activations.current(),
          },
          null,
          2,
        ),
      );
    else if (input.command === "tui")
      await startNoesisTui(runtime, {
        provider: config.agent.provider,
        model: config.agent.model,
        thinkingLevel: config.agent.thinkingLevel,
        session: input.session,
      });
    else
      throw new Error(
        `Unknown command ${input.command}. Use tui, onboard, inspect, rebuild, config, auth, or skills.`,
      );
  } finally {
    await runtime.shutdown();
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
