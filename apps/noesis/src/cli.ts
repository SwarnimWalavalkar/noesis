#!/usr/bin/env node
import { createConditionalObject } from "@noesis/domain";
// Imported first so the filter is installed before any module can emit a load-time warning.
import "./process-warnings.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
  createPiMcpSamplingPort,
  createPiSubAgentRunner,
  createPiModelServices,
  createPiSkillLibrary,
  NOESIS_PROVIDER_IDS,
  preparePiModelSelection,
  type PiAuthOperations,
} from "@noesis/runtime-pi";
import {
  OnboardingInterruptedError,
  createTuiMcpInteractionBridge,
  type OnboardingSurface,
  runNoesisOnboardingTui,
  startNoesisTui,
} from "@noesis/tui";
import { createBrowserUrlOpener } from "./browser-auth.ts";
import { renderNoesisOAuthCallbackPage } from "./oauth-callback-page.ts";
import { runFirstLaunchOnboarding, shouldAutoOnboard } from "./onboarding.ts";
import { createSurfaceAuthCallbacks, promptsFromSurface } from "./prompt-surface.ts";
import {
  type ApplicationRuntime,
  type ApplicationRuntimeCompositionOptions,
  createApplicationRuntimeComposition,
  resolveActiveProject,
} from "./runtime-composition.ts";
import { createApplicationMcpIntegration } from "./mcp-integration.ts";
import { NOESIS_BUILT_IN_SKILLS } from "./noesis-skill.ts";
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
const COMMANDS = new Set(["tui", "onboard", "inspect", "rebuild", "config", "auth", "skills", "help"]);
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
  --provider ID              openai-codex, anthropic, openrouter, or opencode
                             Pair with --model when changing providers
  --model ID                 Model (Codex default: gpt-5.6-sol)
  --thinking-level LEVEL     Reasoning level (default: high)

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
    readonly enableMcp: boolean;
  },
): Promise<
  Readonly<{
    runtime: ApplicationRuntime;
    mcpInteractionBridge: ReturnType<typeof createTuiMcpInteractionBridge>;
  }>
> {
  const services = createPiModelServices(config.home);
  preparePiModelSelection(services.models, config.agent);
  preparePiModelSelection(services.models, config.agents);
  const project = await resolveActiveProject(process.cwd());
  const skills = createPiSkillLibrary({
    cwd: project.root,
    agentDirectory: join(config.home, "agent"),
    workspaceTrusted: options.workspaceTrusted,
    builtInSkills: NOESIS_BUILT_IN_SKILLS,
  });
  const mcpInteractionBridge = createTuiMcpInteractionBridge();
  const mcp = options.enableMcp
    ? createApplicationMcpIntegration({
        home: config.home,
        projectDirectory: project.root,
        sampling: createPiMcpSamplingPort({
          models: services.models,
          provider: config.agent.provider,
          model: config.agent.model,
          reasoning: config.agent.thinkingLevel,
        }),
        interactions: mcpInteractionBridge,
        workspaceTrusted: options.workspaceTrusted,
        openUrl: async (url) => {
          openAuthUrl(url);
        },
      })
    : undefined;
  try {
    // SAFETY: The surrounding typed boundary establishes this representation before it is consumed.
    const runtime = await createApplicationRuntimeComposition(
      createConditionalObject({
        config,
        project,
        skills,
      } as const)
        .addOptional(mcp ? { mcp } : undefined)
        .add({
          recoverInterruptedOperations: options.recoverInterruptedOperations,
          createAgent: (_sessionTools, codeExecution, selfTools, skillLibrary) =>
            createPiAgentRuntime(
              project.root,
              services.models,
              createConditionalObject({
                codeExecution,
                selfTools,
                requirePinnedSkillSnapshot: true,
              } as const)
                .addOptional(skillLibrary ? { skills: skillLibrary } : undefined)
                .finish(),
            ),
          createRoleRunner: (configurations) =>
            createPiAgentRoleRunner(project.root, services.models, configurations),
          subAgent: createPiSubAgentRunner(project.root, services.models),
          resolveModelContext: (provider, model) => {
            preparePiModelSelection(services.models, Object.freeze({ provider, model }));
            const selected = services.models.getModel(provider, model);
            if (!selected) throw new Error(`Unknown Pi model ${provider}/${model}`);
            return Object.freeze({
              contextWindow: selected.contextWindow,
              maxOutputTokens: selected.maxTokens,
            });
          },
        } satisfies Pick<
          ApplicationRuntimeCompositionOptions,
          | "recoverInterruptedOperations"
          | "createAgent"
          | "createRoleRunner"
          | "subAgent"
          | "resolveModelContext"
        >)
        .finish(),
    );
    return Object.freeze({ runtime, mcpInteractionBridge });
  } catch (error) {
    await mcp?.close().catch(() => undefined);
    throw error;
  }
}
const openAuthUrl = createBrowserUrlOpener({
  enabled: process.env["NOESIS_DISABLE_BROWSER_OPEN"] !== "1",
});
function surfaceAuthCallbacks(surface: OnboardingSurface) {
  return createSurfaceAuthCallbacks(surface, {
    openUrl: openAuthUrl,
    renderOAuthCallbackPage: renderNoesisOAuthCallbackPage,
  });
}
function requireInteractiveTerminal(message: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(message);
}
async function runSetupSurface<T>(
  run: (surface: OnboardingSurface) => Promise<T>,
  options: {
    readonly subtitle: string;
    readonly cancelMessage: string;
    readonly requiresTerminal: string;
  },
): Promise<T> {
  requireInteractiveTerminal(options.requiresTerminal);
  try {
    return await runNoesisOnboardingTui(run, { subtitle: options.subtitle });
  } catch (error) {
    if (!(error instanceof OnboardingInterruptedError)) throw error;
    console.error(options.cancelMessage);
    // The setup terminal is in raw mode, so Ctrl+C arrives as input rather than SIGINT. An
    // interrupted sign-in can leave its local OAuth listener holding the event loop open.
    process.exit(1);
  }
}
function hasExplicitAgentSettings(input: CliInput): boolean {
  return (
    Object.values(input.overrides).some((value) => value !== undefined) ||
    ["NOESIS_PROVIDER", "NOESIS_MODEL", "NOESIS_THINKING_LEVEL"].some(
      (name) => process.env[name] !== undefined,
    )
  );
}
async function runOnboarding(input: CliInput): Promise<void> {
  const services = createPiModelServices(input.home);
  await runSetupSurface(
    async (surface) =>
      await runFirstLaunchOnboarding({
        home: input.home,
        prompts: promptsFromSurface(surface),
        auth: services.auth,
        authCallbacks: surfaceAuthCallbacks(surface),
        validateModelSelection: (selection) => preparePiModelSelection(services.models, selection),
      }),
    {
      subtitle: "first-launch setup",
      cancelMessage: "Setup cancelled; no configuration was written.",
      requiresTerminal:
        "First-launch onboarding requires an interactive terminal. Run `noesis config init` for non-interactive setup.",
    },
  );
}
async function runAuth(input: CliInput, auth: PiAuthOperations): Promise<void> {
  const action = input.subcommand ?? "status";
  const provider = input.authProvider;
  if (action === "status") {
    const providers = provider ? [provider] : NOESIS_PROVIDER_IDS;
    console.log(JSON.stringify(await Promise.all(providers.map((id) => auth.status(id))), null, 2));
    return;
  }
  const selected = provider ?? "openai-codex";
  if (action === "login") {
    await runSetupSurface(
      async (surface) => {
        const status = await auth.login(selected, surfaceAuthCallbacks(surface));
        surface.note(`Authenticated ${status.provider} via ${status.source}.`);
        return status;
      },
      {
        subtitle: "sign in",
        cancelMessage: "Sign-in cancelled; no credentials were written.",
        requiresTerminal: "Authentication requires an interactive terminal.",
      },
    );
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
    if (Object.values(input.overrides).some((value) => value !== undefined)) {
      const current = await resolveNoesisConfig({ home: input.home, env: {} });
      const selection = {
        provider: input.overrides.provider ?? current.agent.provider,
        model: input.overrides.model ?? current.agent.model,
      };
      preparePiModelSelection(createPiModelServices(input.home).models, selection);
    }
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
    builtInSkills: NOESIS_BUILT_IN_SKILLS,
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
  const config = await resolveNoesisConfig({
    home: input.home,
    cli: input.overrides,
  });
  const created = await createRuntime(config, {
    recoverInterruptedOperations: input.command === "tui",
    workspaceTrusted: input.workspaceTrusted,
    enableMcp: input.command === "tui",
  });
  const runtime = created.runtime;
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
        mcpInteractionBridge: created.mcpInteractionBridge,
        openUrl: async (url) => {
          openAuthUrl(url);
        },
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
await main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
});
