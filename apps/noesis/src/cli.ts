#!/usr/bin/env node
import { Writable } from "node:stream";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import {
  initializeNoesisConfig,
  readNoesisConfig,
  resolveNoesisConfig,
  type ConfigOverrides,
  type ResolvedNoesisConfig,
  updateNoesisConfig,
} from "@noesis/config";
import {
  CapabilityRevisionRefSchema,
  EvidenceRefSchema,
  type CapabilityRevisionRef,
  type EvidenceRef,
} from "@noesis/domain";
import { createNoesisRuntime } from "@noesis/runtime";
import {
  createFakeAgentRoleRunner,
  createPiModelServices,
  createFakeAgentRuntime,
  createPiAgentRuntime,
  createPiAgentRoleRunner,
  type NoesisAuthEvent,
  type NoesisAuthLoginCallbacks,
  type NoesisAuthPrompt,
  type PiAuthOperations,
} from "@noesis/runtime-pi";
import { startNoesisTui } from "@noesis/tui";
import { z } from "zod";
import {
  type OnboardingChoice,
  type OnboardingPrompts,
  runFirstLaunchOnboarding,
  shouldAutoOnboard,
} from "./onboarding.ts";
import { createApplicationRuntimeComposition, type ApplicationRuntime } from "./runtime-composition.ts";

interface CliInput {
  readonly args: readonly string[];
  readonly command: string;
  readonly subcommand?: string;
  readonly authProvider?: string;
  readonly home: string;
  readonly overrides: ConfigOverrides;
  readonly session:
    | { readonly mode: "new" }
    | { readonly mode: "pick" }
    | { readonly mode: "continue" }
    | { readonly mode: "resume"; readonly trailId: string };
}

type SessionStartup = CliInput["session"];

const COMMANDS = new Set(["tui", "onboard", "demo", "inspect", "rebuild", "config", "auth", "help"]);
const CONFIG_COMMANDS = new Set(["show", "init", "set"]);
const AUTH_COMMANDS = new Set(["status", "login", "logout"]);
const AGENT_OPTIONS = ["--runtime", "--provider", "--model", "--thinking-level"] as const;
const VALUE_OPTIONS = ["--home", ...AGENT_OPTIONS] as const;

const FakeRolePromptSchema = z.object({
  role: z.enum(["reflector", "revision_author", "revision_agent", "case_generator", "trial", "judge_critic"]),
  messages: z.array(
    z.object({
      name: z.string().optional(),
      content: z.string(),
    }),
  ),
  capabilityRevisions: z.array(CapabilityRevisionRefSchema),
});

type FakeRolePrompt = Readonly<z.infer<typeof FakeRolePromptSchema>>;

function parseFakeRolePrompt(prompt: string): FakeRolePrompt {
  return FakeRolePromptSchema.parse(JSON.parse(prompt));
}

function namedFakeMessage(prompt: FakeRolePrompt, name: string): string {
  const message = prompt.messages.find((candidate) => candidate.name === name);
  if (!message) throw new Error(`Fake ${prompt.role} role is missing message ${name}`);
  return message.content;
}

function parsedFakeMessage(prompt: FakeRolePrompt, name: string): unknown {
  return JSON.parse(namedFakeMessage(prompt, name));
}

function fakeSourceEvidence(prompt: FakeRolePrompt): EvidenceRef {
  const cases = z
    .array(z.object({ evidenceRefs: z.array(EvidenceRefSchema).min(1) }))
    .min(1)
    .parse(parsedFakeMessage(prompt, "evidence"));
  const reference = cases[0]?.evidenceRefs[0];
  if (!reference) throw new Error("Fake case generator received no source evidence");
  return reference;
}

function fakeTrialRevision(prompt: FakeRolePrompt): CapabilityRevisionRef {
  const revision = prompt.capabilityRevisions[0];
  if (!revision) throw new Error("Fake trial received no pinned capability revision");
  return revision;
}

function scriptedFakeRoleResponse(request: { readonly systemPrompt: string; readonly prompt: string }): {
  readonly text: string;
} {
  const prompt = parseFakeRolePrompt(request.prompt);
  if (request.systemPrompt.includes("role: outcome_judge")) {
    const comparisonMessage = prompt.messages.some((message) => message.name === "outcome_comparison")
      ? "outcome_comparison"
      : "relevant_traces";
    const observationIds = [
      ...namedFakeMessage(prompt, comparisonMessage).matchAll(/"observationId"\s*:\s*"([^"]+)"/gu),
    ].flatMap((match) => (match[1] ? [match[1]] : []));
    if (observationIds.length === 0)
      throw new Error("Fake outcome judge received no experiment observations");
    return Object.freeze({
      text: JSON.stringify({
        proposal: "revert",
        citedObservationIds: [...new Set(observationIds)],
        summary: "The scripted correction evidence requests a protected revert.",
      }),
    });
  }
  if (prompt.role === "reflector")
    return Object.freeze({
      text: JSON.stringify({
        decision: "experiment",
        title: "Evidence-grounded research briefs",
        hypothesis: "Research briefs improve when cited evidence is separated from inference",
        scope: "research brief",
        capabilityName: "Research brief evidence",
        capabilityIntent: "Separate cited evidence from inference in research briefs",
        sourceCases: [
          {
            title: "Prepare an evidence-grounded brief",
            input: "Prepare a research brief about the current question.",
            expectedBehavior: "Clearly separate cited evidence from inference.",
          },
        ],
      }),
    });
  if (prompt.role === "revision_author" || prompt.role === "revision_agent")
    return Object.freeze({
      text: JSON.stringify({
        promptModules: [
          {
            path: "evidence.md",
            content: "For research briefs, clearly label sourced evidence and distinguish it from inference.",
          },
        ],
        skills: [
          {
            path: "SKILL.md",
            content: "Produce concise research briefs with explicit evidence, inference, and uncertainty.",
          },
        ],
        tools: [
          {
            path: "research-brief.mjs",
            content: "export const formatResearchBrief = (evidence, inference) => ({ evidence, inference });",
          },
        ],
        router: {
          path: "router.json",
          content: JSON.stringify({ allTerms: ["research", "brief"] }),
          strategyId: "research-brief-scope-v1",
        },
        activationPolicy: {
          mode: "automatic_low_risk",
          scope: "research brief",
        },
        permissionManifest: {
          effects: [],
          resourcePatterns: [],
          credentialRefs: [],
        },
        sourceEvaluationDefinitions: [
          {
            path: "source-case.json",
            content: JSON.stringify({
              behavior: "Separate cited evidence from inference in a research brief",
            }),
          },
        ],
        requestedPermissionDelta: {
          addedEffects: [],
          widenedResources: [],
          addedCredentialRefs: [],
        },
      }),
    });
  if (prompt.role === "case_generator")
    return Object.freeze({
      text: JSON.stringify({
        cases: [
          {
            caseId: "research-brief-transfer",
            kind: "generated_transfer",
            instruction: "Transfer the evidence/inference distinction to another research brief.",
            input: "Prepare a research brief on a related topic.",
            sourceEvidenceRefs: [fakeSourceEvidence(prompt)],
            criterionRefs: [],
          },
        ],
      }),
    });
  if (prompt.role === "trial") {
    const revision = fakeTrialRevision(prompt);
    const candidate = revision.capabilityId.startsWith("learned-");
    return Object.freeze({
      text: JSON.stringify({
        content: candidate
          ? "Candidate adaptation: cited evidence is separate from explicit inference."
          : "Baseline response: a concise research summary.",
        valid: true,
        invalidArtifacts: [],
        unexpectedEffects: [],
        sourceAssertions: [
          {
            assertionId: "evidence-inference-separation",
            passed: true,
            evidence: candidate
              ? "The candidate explicitly separates evidence and inference."
              : "The baseline remains a valid comparison artifact.",
          },
        ],
        identity: {
          capabilityId: revision.capabilityId,
          capabilityRevisionId: revision.capabilityRevisionId,
          bundleDigest: revision.bundleDigest,
        },
      }),
    });
  }
  if (prompt.role === "judge_critic") {
    const armA = z.object({ content: z.string() }).parse(parsedFakeMessage(prompt, "arm_A"));
    const rubric = z
      .object({
        criteria: z.array(
          z.object({
            criterionId: z.string().min(1),
            revision: z.number().int().positive(),
          }),
        ),
      })
      .parse(parsedFakeMessage(prompt, "rubric"));
    return Object.freeze({
      text: JSON.stringify({
        winner: armA.content.startsWith("Candidate adaptation:") ? "A" : "B",
        confidence: 0.99,
        reasons: ["The candidate explicitly satisfies the bounded behavioral objective."],
        violations: [],
        appliedCriteria: rubric.criteria.map(({ criterionId, revision }) => ({
          criterionId,
          revision,
        })),
      }),
    });
  }
  throw new Error(`No scripted fake response for role ${prompt.role}`);
}

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
      `Unknown command ${command}. Use tui, onboard, demo, inspect, rebuild, config, auth, or help.`,
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
  const operands = args.filter((argument, index) => !consumed.has(index) && !argument.startsWith("--"));
  const unknownOption = args.find((argument, index) => !consumed.has(index) && argument.startsWith("--"));
  if (unknownOption) throw new Error(`Unknown ${command} option ${unknownOption}`);

  let subcommand: string | undefined;
  let authProvider: string | undefined;
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
  }
  const startupOption =
    startup.session.mode === "new" ? [] : startup.session.mode === "continue" ? ["--continue"] : ["--resume"];
  for (const name of [...optionValues.keys(), ...startupOption]) {
    if (!allowedOptions.has(name)) {
      const scope = subcommand ? `${command} ${subcommand}` : command;
      throw new Error(`${name} is not valid for ${scope}`);
    }
  }
  const home = resolve(optionValues.get("--home") ?? process.env["NOESIS_HOME"] ?? ".noesis");
  const runtime = optionValues.get("--runtime");
  const provider = optionValues.get("--provider");
  const model = optionValues.get("--model");
  const thinkingLevel = optionValues.get("--thinking-level");
  return {
    args,
    command,
    ...(subcommand ? { subcommand } : {}),
    ...(authProvider ? { authProvider } : {}),
    home,
    session: startup.session,
    overrides: {
      ...(runtime !== undefined ? { runtime } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    },
  };
}

const CLI_HELP = `Noesis

Usage:
  noesis [tui] [--home PATH] [agent options]
  noesis [tui] --continue [--home PATH] [agent options]
  noesis [tui] --resume [SESSION_ID] [--home PATH] [agent options]
  noesis onboard [--home PATH]
  noesis demo [--home PATH]
  noesis inspect|rebuild [--home PATH] [agent options]
  noesis config init [--home PATH]
  noesis config show|set [--home PATH] [agent options]
  noesis auth status|login|logout [PROVIDER] [--home PATH]
  noesis help

Session startup:
  noesis                       Start a new independent session
  noesis --continue            Resume the single most recently active session
  noesis --resume              Choose a prior session interactively
  noesis --resume SESSION_ID   Resume that exact prior session

Agent options:
  --runtime fake|pi  --provider ID  --model ID  --thinking-level LEVEL

The latest session is ordered by last activity, then full trail ID ascending on ties.
A session still marked running is not recovered or resumed automatically.
Unknown options, conflicting startup arguments, and trailing operands are rejected.`;

async function createRuntime(config: ResolvedNoesisConfig, forceFake = false): Promise<ApplicationRuntime> {
  const settings = forceFake
    ? { provider: "fake", model: "noesis-fake-1", thinkingLevel: "off" as const }
    : config.agent;
  if (forceFake || config.agent.runtime === "fake") {
    const runtime = await createNoesisRuntime(config.home, createFakeAgentRuntime(), settings);
    return await createApplicationRuntimeComposition({
      config,
      runtime,
      createRoleRunner: (configurations) =>
        createFakeAgentRoleRunner({
          variants: configurations,
          respond: scriptedFakeRoleResponse,
        }),
    });
  }
  const services = createPiModelServices(config.home);
  const runtime = await createNoesisRuntime(
    config.home,
    createPiAgentRuntime(process.cwd(), services.models),
    settings,
  );
  return await createApplicationRuntimeComposition({
    config,
    runtime,
    createRoleRunner: (configurations) =>
      createPiAgentRoleRunner(process.cwd(), services.models, configurations),
  });
}

async function runDemo(runtime: ApplicationRuntime): Promise<void> {
  const genesis = await runtime.debug.adaptations.activations.current();
  if (!genesis) throw new Error("Demo requires the immutable genesis activation");
  const correctionSession = await runtime.startTrail({ title: "Learning correction" });
  const correction = await runtime.runTurn(
    correctionSession.trailId,
    "No, for every research brief separate cited evidence from inference.",
  );
  await runtime.controlPlane.idle();
  const experiments = await runtime.debug.workspace.research.experiments.listExperiments({ limit: 100 });
  const experiment = experiments.find(
    (candidate) =>
      candidate.status === "observing" &&
      candidate.scope === "research brief" &&
      candidate.activatedRevision !== undefined,
  );
  if (!experiment?.activatedRevision)
    throw new Error("Fake application loop did not activate its research-brief experiment");
  const candidateRevision = experiment.activatedRevision;
  const activated = await runtime.debug.adaptations.activations.current();
  const activatedCandidate = activated?.activeCapabilityRevisions[candidateRevision.capabilityId];
  if (
    !activated ||
    activatedCandidate?.kind !== "capability_revision" ||
    activatedCandidate.bundleDigest !== candidateRevision.bundleDigest
  )
    throw new Error("Atomic activation did not publish the exact candidate revision");

  const relatedSession = await runtime.startTrail({ title: "Related return" });
  const related = await runtime.runTurn(
    relatedSession.trailId,
    "Prepare a research brief about continual learning.",
  );
  const relatedSelection = related.frozenTurnPlan?.selectedCapabilities.find(
    (selection) => selection.capabilityId === candidateRevision.capabilityId,
  );
  if (!relatedSelection || relatedSelection.revision.bundleDigest !== candidateRevision.bundleDigest)
    throw new Error("Related turn did not serve the exact activated revision");

  const unrelatedSession = await runtime.startTrail({ title: "Unrelated return" });
  const unrelated = await runtime.runTurn(unrelatedSession.trailId, "Draft a meeting agenda.");
  if (
    unrelated.frozenTurnPlan?.selectedCapabilities.some(
      (selection) => selection.capabilityId === candidateRevision.capabilityId,
    )
  )
    throw new Error("Unrelated turn received the scoped research-brief adaptation");

  for (const input of [
    "No, revise this research brief and keep evidence distinct from inference.",
    "No, undo that adaptation for this research brief.",
  ])
    await runtime.runTurn(relatedSession.trailId, input);
  await runtime.controlPlane.idle();
  const outcome = await runtime.debug.adaptations.feedback.getOutcome(experiment.experimentId);
  if (outcome?.decision !== "revert" || !outcome.restoredActivationId)
    throw new Error("Fake application loop did not complete a protected revert");
  const restored = await runtime.debug.adaptations.activations.current();
  if (
    !restored ||
    restored.activeCapabilityRevisions[candidateRevision.capabilityId] !== undefined ||
    JSON.stringify(restored.activeCapabilityRevisions) !== JSON.stringify(genesis.activeCapabilityRevisions)
  )
    throw new Error("Protected revert did not restore the full prior genesis activation");

  console.log(
    JSON.stringify(
      {
        home: runtime.home,
        correction: {
          sessionId: correctionSession.trailId,
          output: correction.output,
        },
        experiment: {
          experimentId: experiment.experimentId,
          scope: experiment.scope,
          candidateRevision,
          preflight: experiment.preflightRef,
        },
        activation: {
          activationId: activated.activationId,
          revision: activated.revision,
        },
        related: {
          sessionId: relatedSession.trailId,
          servedRevision: relatedSelection.revision,
          frozenTurnPlanId: related.frozenTurnPlan?.planId,
          frozenTurnPlanDigest: related.frozenTurnPlan?.canonicalDigest,
        },
        unrelated: {
          sessionId: unrelatedSession.trailId,
          selectedCapabilityIds:
            unrelated.frozenTurnPlan?.selectedCapabilities.map((selection) => selection.capabilityId) ?? [],
        },
        revert: {
          outcomeId: outcome.operationId,
          restoredActivationId: outcome.restoredActivationId,
          restoredRevision: restored.revision,
        },
      },
      null,
      2,
    ),
  );
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
    ["NOESIS_RUNTIME", "NOESIS_PROVIDER", "NOESIS_MODEL", "NOESIS_THINKING_LEVEL"].some(
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
  const runtime = await createRuntime(config, input.command === "demo");
  try {
    if (input.command === "demo") await runDemo(runtime);
    else if (input.command === "rebuild") {
      await runtime.debug.legacyReadOnly.ledger.rebuildProjection();
      console.log(`Rebuilt ${runtime.debug.legacyReadOnly.ledger.paths.projection}`);
    } else if (input.command === "inspect")
      console.log(
        JSON.stringify(
          {
            trails: runtime.listTrails(),
            activeCapabilities: runtime.debug.legacyReadOnly.capabilities.listActive(),
            events: runtime.debug.legacyReadOnly.ledger.readAll().length,
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
        `Unknown command ${input.command}. Use tui, onboard, demo, inspect, rebuild, config, or auth.`,
      );
  } finally {
    await runtime.shutdown();
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
