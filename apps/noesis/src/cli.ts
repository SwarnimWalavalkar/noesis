#!/usr/bin/env node
import { createConditionalObject } from "@noesis/domain";
// Imported first so the filter is installed before any module can emit a load-time warning.
import "./process-warnings.ts";
import { join } from "node:path";
import {
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
  createPiSubAgentTaskRunner,
  createPiModelServices,
  createPiSkillLibrary,
  listPiModelRoutes,
  NOESIS_PROVIDER_IDS,
  preparePiModelSelection,
  type PiAuthOperations,
} from "@noesis/runtime-pi";
import {
  OnboardingInterruptedError,
  createTuiMcpInteractionBridge,
  type OnboardingSurface,
  pickStartupNote,
  runNoesisOnboardingTui,
  startNoesisTui,
} from "@noesis/tui";
import { createBrowserUrlOpener } from "./browser-auth.ts";
import { runFirstLaunchOnboarding, shouldAutoOnboard } from "./onboarding.ts";
import { createSurfaceAuthCallbacks, promptsFromSurface } from "./prompt-surface.ts";
import {
  type ApplicationRuntime,
  type ApplicationRuntimeCompositionOptions,
  createApplicationRuntimeComposition,
  resolveActiveProject,
} from "./runtime-composition.ts";
import { createApplicationMcpIntegration } from "./mcp-integration.ts";
import { prepareNoesisBuiltInSkills } from "./noesis-skill.ts";
import { checkForUpdate, updateNoesis } from "./update.ts";
import { type CliInput, parseArgs } from "./cli-args.ts";
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
  noesis update
  noesis help

Updates:
  noesis update               Install the newest release on your current npm channel globally
  NOESIS_NO_UPDATE_CHECK=1     Disable the background startup update check

Session startup:
  noesis                       Start a new independent session
  noesis --continue            Resume the single most recently active session
  noesis --resume              Choose a prior session interactively
  noesis --resume SESSION_ID   Resume that exact prior session

Agent options:
  --provider ID              openai-codex, anthropic, openrouter, opencode, or opencode-go
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
  const services = await createPiModelServices(config.home);
  preparePiModelSelection(services.catalog, config.agent);
  preparePiModelSelection(services.catalog, config.agents);
  const project = await resolveActiveProject(process.cwd());
  const skills = createPiSkillLibrary({
    cwd: project.root,
    agentDirectory: join(config.home, "agent"),
    workspaceTrusted: options.workspaceTrusted,
    builtInSkills: await prepareNoesisBuiltInSkills(config.home),
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
          createAgent: (_sessionTools, codeExecution, skillLibrary) =>
            createPiAgentRuntime(
              project.root,
              services.models,
              createConditionalObject({
                codeExecution,
                requirePinnedSkillSnapshot: true,
              } as const)
                .addOptional(skillLibrary ? { skills: skillLibrary } : undefined)
                .finish(),
            ),
          createRoleRunner: (configurations) =>
            createPiAgentRoleRunner(project.root, services.models, configurations),
          subAgentTaskRunner: createPiSubAgentTaskRunner(project.root, services.models),
          listModelRoutes: () => listPiModelRoutes(services.catalog),
          refreshModelRoutes: async (signal) => {
            await services.refresh(signal);
            return listPiModelRoutes(services.catalog);
          },
          providerAuthStatus: services.auth.status,
          authenticateProvider: services.auth.login,
          disconnectProvider: async (providerId) => {
            await services.auth.logout(providerId);
            return await services.auth.status(providerId);
          },
          resolveModelContext: (provider, model) => {
            const selected = services.catalog.getModel(provider, model);
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
          | "subAgentTaskRunner"
          | "listModelRoutes"
          | "refreshModelRoutes"
          | "providerAuthStatus"
          | "authenticateProvider"
          | "disconnectProvider"
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
    readonly startupNote?: string;
    readonly updateNotice?: Promise<string | undefined>;
  },
): Promise<T> {
  requireInteractiveTerminal(options.requiresTerminal);
  try {
    return await runNoesisOnboardingTui(
      run,
      createConditionalObject({ subtitle: options.subtitle })
        .addOptional(options.updateNotice ? { updateNotice: options.updateNotice } : undefined)
        .addOptional(options.startupNote ? { startupNote: options.startupNote } : undefined)
        .finish(),
    );
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
async function runOnboarding(
  input: CliInput,
  startupNote?: string,
  updateNotice?: Promise<string | undefined>,
): Promise<void> {
  const services = await createPiModelServices(input.home);
  await runSetupSurface(
    async (surface) =>
      await runFirstLaunchOnboarding({
        home: input.home,
        prompts: promptsFromSurface(surface),
        auth: services.auth,
        authCallbacks: surfaceAuthCallbacks(surface),
        modelRoutes: listPiModelRoutes(services.catalog),
        validateModelSelection: (selection) => preparePiModelSelection(services.catalog, selection),
      }),
    createConditionalObject({
      subtitle: "first-launch setup",
      cancelMessage: "Setup cancelled; no configuration was written.",
      requiresTerminal:
        "First-launch onboarding requires an interactive terminal. Run `noesis config init` for non-interactive setup.",
    })
      .addOptional(updateNotice ? { updateNotice } : undefined)
      .addOptional(startupNote ? { startupNote } : undefined)
      .finish(),
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
      const services = await createPiModelServices(input.home);
      preparePiModelSelection(services.catalog, selection);
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
    builtInSkills: await prepareNoesisBuiltInSkills(input.home),
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
  const startupNote = pickStartupNote();
  if (input.args.includes("--help") || input.command === "help") {
    console.log(CLI_HELP);
    return;
  }
  if (input.command === "update") {
    await updateNoesis();
    return;
  }
  if (input.command === "config") {
    await runConfig(input);
    return;
  }
  if (input.command === "auth") {
    const services = await createPiModelServices(input.home);
    await runAuth(input, services.auth);
    return;
  }
  if (input.command === "skills") {
    await runSkills(input);
    return;
  }
  const updateNotice =
    (input.command === "tui" || input.command === "onboard") && process.stdout.isTTY
      ? checkForUpdate()
      : Promise.resolve(undefined);
  const loaded = await readNoesisConfig(input.home);
  if (!loaded.ok) throw loaded.error;
  const configExists = loaded.value.raw !== undefined;
  if (input.command === "onboard") {
    if (configExists)
      throw new Error(
        `${input.home}/config.json already exists. Use \`noesis config set\` and \`noesis auth login\` to change setup.`,
      );
    await runOnboarding(input, startupNote, updateNotice);
    return;
  }
  const autoOnboard = shouldAutoOnboard({
    command: input.command,
    configExists,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    hasExplicitAgentSettings: hasExplicitAgentSettings(input),
  });
  if (autoOnboard) await runOnboarding(input, startupNote, updateNotice);
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
        startupNote,
        updateNotice,
        mcpInteractionBridge: created.mcpInteractionBridge,
        onShutdown: () => runtime.shutdown(),
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
