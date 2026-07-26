# Noesis

Noesis is a personal thinking and creation partner that aims to improve through use. It helps a person produce useful work now. When the evidence supports it, Noesis also preserves a selective and inspectable advantage for related work later.

The ambitious problem is that most agents optimize one transaction at a time. Even systems that retain history often collect more material without showing that earlier work made later work better. Noesis aims to keep thought and action connected across time without flooding the present with old context or hiding how the system changed.

The primary user is a compounding practitioner. This person moves between thought and action around one body of work. At times, the person also studies how the collaboration itself can improve. These are working orientations, not required modes.

## Product loop

The intended loop is:

> intent → exploration → synthesis → creation → reflection → selective durable learning → return

Noesis defaults toward working with the user when intellectual work is ambiguous. It defaults toward doing the work when the requested outcome and scope are clear. The user can change that posture in normal conversation.

Useful work comes first. Reflection happens after the foreground result and may correctly choose `no_change`. A durable learning must cite evidence, begin at the narrowest plausible scope, and name an anticipated future use. Generated content may propose a change. Protected source code retains authority over changes to behavior and permission, including activation and rollback. Every active adaptation should remain open to inspection, correction, and revert.

Read the short product documents for the full reasoning:

- [Product thesis](docs/product-thesis.md)
- [Product experience](docs/product-experience.md)

## Research preview status

Noesis is a local research preview. Its first causal compounding loop now runs end to end, while the broader collaboration experience remains active research.

What works now:

- The CLI and TUI support new and resumed sessions. They also support continue, fork, compact, and abort operations.
- Pi AgentHarness is the only production turn executor behind `packages/runtime-pi`. Tests drive the same adapter with credential-free controlled Pi providers.
- Provider setup supports OpenAI Codex OAuth, OpenRouter, and the Anthropic provider exposed through Pi.
- `WorkspaceStore` provides SQLite operational records and editable definitions. It also provides immutable revisions, evidence, artifacts, search, durable jobs, activation state, feedback state, integrity checks, and backups.
- Every foreground turn admits one digest-validated `FrozenTurnPlan` before execution. The exact immutable capability bytes, routing decision, permissions, provider, model, reasoning level, and baseline lineage delivered to Pi are the bytes recorded in SQLite.
- A fresh workspace bootstraps an immutable general-collaboration baseline. Ambient reflection can author and evaluate a narrow new capability, activate it, serve it only on related work, and restore the complete prior activation after feedback.
- Credential-free application acceptance tests exercise correction, reflection, authorship, protected evaluation, atomic activation, related serving, unrelated abstention, and protected revert through Pi AgentHarness.
- Effect-free paired replay and compounding read models measure served-revision wins, scope leakage, context tax, correction recurrence, exclusions, and evidence coverage under durable call, token, and cost budgets.
- Pi sees four stable foreground tools: `inspect_self`, `remember`, `adapt`, and `execute`. Broad work tools remain progressively discoverable inside `execute` as a JavaScript SDK rather than consuming the model context directly.
- The frozen Tool Broker provides file, shell, web, artifact, history, skill, script, and workflow operations through the same protected effect path. Codemode runs ordinary local Node.js with cancellation, bounds, nested-call lineage, and authoritative execution records.
- Standard Agent Skills can be installed from local, Git, URL, or package sources at personal or workspace scope through Pi’s package manager. Only compact skill metadata enters the prompt; full instructions load on demand.
- Successful code can be saved as a typed, editable script and rerun from an immutable revision. Typed multi-phase workflows persist run and phase state, pause on failure or correction, and resume without repeating completed phases.

The research preview deliberately remains incomplete:

- Collaboration posture, anticipated future use, adaptation history, and conversational contest or revert are not yet productized in the TUI.
- Ambient paired replay has an implementation and durable store, but its post-settlement scheduling policy is not yet wired into ordinary use.
- Workflow execution is foreground and sequential in this iteration. Background scheduling, named `map` fan-out, and nested agent phases remain future work.

The completed [high-leverage correction plan](plans/noesis-high-leverage-correction-plan.html) removed unproven scope, made the compounding claim measurable, closed the minimal causal loop, and moved foreground and protected operational authority to SQLite. The [product loop plan](plans/compounding-partnership-product-loop.html) is next: it adds collaboration posture and selective learning with anticipated future use, serves exact active revisions and tools, exposes adaptation history and conversational controls, and proves the complete path with a credential-free controlled Pi provider.

## Quick start

You need Node 22.19 or newer and pnpm 10.

```sh
pnpm install
pnpm check

# Start the TUI. Noesis uses ~/.noesis by default.
pnpm start -- tui
```

An interactive first launch with no config and no explicit agent settings starts onboarding. It asks for the provider, model, reasoning level, and authentication. You can run the same flow directly:

```sh
pnpm start -- onboard
```

Noninteractive use does not wait for onboarding. Initialize or set the config first:

```sh
pnpm start -- config init
pnpm start -- config show
pnpm start -- config set \
  --provider openai-codex --model gpt-5.6-sol --thinking-level high
```

## Provider authentication

OpenAI Codex OAuth and OpenRouter are the two onboarding choices.

```sh
# OpenAI Codex OAuth
pnpm start -- auth login openai-codex
pnpm start -- tui \
  --provider openai-codex --model gpt-5.6-sol

# OpenRouter through the environment
OPENROUTER_API_KEY=... pnpm start -- tui \
  --provider openrouter --model anthropic/claude-sonnet-4.5
```

Noesis does not register direct `OPENAI_API_KEY` authentication. Use `openai-codex` for Codex OAuth or `openrouter` for an OpenRouter key.

Pi credentials live in `<NOESIS_HOME>/auth.json`, separate from user preferences. Noesis requires mode `0700` for the credential directory. It requires mode `0600` for the credential file. Noesis never copies credentials into config, durable state, logs, or test fixtures.

Use these commands to inspect or change provider credentials:

```sh
pnpm start -- auth status openai-codex
pnpm start -- auth logout openai-codex
pnpm start -- auth login openrouter
pnpm start -- auth logout openrouter
```

For OpenRouter, a stored credential takes precedence over `OPENROUTER_API_KEY`. Remove the stored credential to use the environment key. `auth status` does not print credentials or refresh an expired OAuth token.

## Sessions and the TUI

A plain `noesis`, `noesis tui`, or `pnpm start` creates a new independent session. It does not inherit a prior conversation.

```sh
# Choose a saved session.
pnpm start -- --resume

# Resume one exact session.
pnpm start -- --resume trail_01234567-89ab-cdef-0123-456789abcdef

# Resume the most recently active session.
pnpm start -- --continue
```

`--resume` opens a picker that you can control with the keyboard. `--continue` selects the single most recently active session. Both fail closed if the selected session is still marked `running`. This build has no durable executor ownership lease, so it cannot safely recover a session whose process ended during a turn. Start a separate session or wait until explicit recovery is available.

The TUI uses `@earendil-works/pi-tui` directly. It streams turns and supports:

```text
/model provider/model  /context       /capabilities
/skills                /scripts       /workflows       /runs
/skill NAME             /script NAME   /workflow NAME   /run ID
/fork                   /compact       /abort           /quit
```

Enter `?` or `/help` to see the command list. Use `/quit` or Ctrl+C to exit. `NO_COLOR` and `TERM=dumb` disable styling.

## Tools, skills, scripts, and workflows

Noesis deliberately separates instruction from execution:

- A **tool** is one atomic host capability. The model discovers tools with `noesis.search()` and composes them through `tools.<family>.<operation>()` inside `execute`.
- A **skill** is portable instructional context using the standard Agent Skills format. It may teach Noesis when and how to use tools or workflows, but installing a skill does not silently register executable extensions.
- A **script** is one reusable JavaScript program with JSON-schema-validated input and output plus an exact required-tool manifest.
- A **workflow** is a durable ordered set of typed JavaScript phases. Completed phase outputs are reused on resume, and a correction can become the next incomplete phase’s input.

Codemode is trusted local execution, not a sandbox. Generated JavaScript runs on the user’s machine with Node.js and can import installed packages. SDK tool calls still pass through the Tool Broker, `AuthorityBoundary`, and `EffectGateway`, bound to the admitted turn’s frozen permission snapshot. Direct Node operations carry the authority of the local user running Noesis.

Each turn freezes the visible skill bytes and the current script/workflow revisions into its tool-catalog identity. An edit made while a turn is running is therefore visible on the next turn, never midway through the current one. Workflow retries reuse stable logical call identities; an unresolved external effect fails closed instead of being guessed safe to repeat.

Manage standard skills from the CLI:

```sh
pnpm start -- skills list
pnpm start -- skills install ./path/to/skill --workspace
pnpm start -- skills update
pnpm start -- skills remove ./path/to/skill --workspace
```

Inside the TUI, `/skills`, `/scripts`, `/workflows`, and `/runs` show the corresponding libraries. Singular commands inspect exact content, source, schemas, revisions, nested calls, and phase state.

## Configuration

User preferences live in `<NOESIS_HOME>/config.json`. The file uses schema version 1 and never contains credentials.

```json
{
  "schemaVersion": 1,
  "agent": {
    "provider": "openai-codex",
    "model": "gpt-5.6-sol",
    "thinkingLevel": "high"
  }
}
```

Agent settings use this precedence:

1. CLI flags
2. `NOESIS_PROVIDER`, `NOESIS_MODEL`, and `NOESIS_THINKING_LEVEL`
3. `config.json`
4. Defaults in source code

Noesis stores its global state in `~/.noesis/` by default. `--home` overrides `NOESIS_HOME`, which overrides that default. Valid reasoning levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

## Architecture and storage

Pi executes turns. Noesis owns the product and control plane around those turns. Only `packages/runtime-pi` imports Pi agent and runtime types. The TUI renders runtime read models and never owns durable state.

Session and turn records retain the executor identity that originally produced them as immutable provenance. That durable field is not a user-selectable runtime mode. Existing schema-version-1 config files that contain the removed `agent.runtime` field are read without rewriting; the field is ignored and disappears on the next explicit config write. Sessions recorded by a different historical executor fail closed rather than being reinterpreted as Pi sessions.

The persistence model is:

- `WorkspaceStore` owns persistence boundaries.
- `<NOESIS_HOME>/database/noesis.sqlite` is authoritative for foreground sessions, turns, messages, outcomes, frozen plans, jobs, activation, evaluation, feedback, grants, reservations, budgets, effect outcomes, and idempotency.
- Ordinary files under `<NOESIS_HOME>/definitions/` are authoritative for editable definitions.
- Immutable snapshots under `revisions/` and `evidence/` preserve exact recorded bytes.
- Large outputs remain files under `artifacts/` with SQLite metadata.
- Search data and UI read models are rebuildable projections.

Existing `<NOESIS_HOME>/ledger/events.jsonl` data is strictly validated, backed up, and imported through a versioned cutover whose marker is written last. After cutover, production turns do not append operational state to JSONL. Compatibility code is limited to that import boundary; there is no legacy runtime, general ledger package, or second operational authority. The imported files remain read-only provenance artifacts, and `noesis rebuild` rebuilds WorkspaceStore search projections from authoritative SQLite and recorded revisions.

Important package boundaries include:

- `apps/noesis` owns the CLI and application composition.
- `packages/runtime` owns the turn lifecycle and protected coordination.
- `packages/workspace` owns SQLite, definitions, immutable revisions, evidence, artifacts, search indexes, and backups.
- `packages/runtime-pi` is the only Pi runtime boundary.
- `packages/tools` owns the canonical frozen Tool Catalog, Broker, and initial host adapters.
- `packages/codemode` owns the local Node child-process protocol and execution lifecycle without knowing what real tools do.
- `packages/intelligence`, `packages/learning`, and `packages/evals` own retrieval, reflection and candidate creation, and comparison evidence.
- `packages/policy` and `packages/capabilities` own protected effects and exact capability revisions.
- `packages/tui` owns terminal rendering and input handling.

There is no second production turn executor, operational ledger, memory repository, capability-promotion registry, or scheduler. Test adapters implement only narrow public seams and never become product composition roots.

Generated reflection and candidate authorship never receive promotion authority. All protected promotion, rollback, scheduling, and external effects go through the authority and effect boundaries. A generated tool cannot approve or widen its own permissions.

## Development

The repository uses strict TypeScript ESM and exact direct dependency versions. Stateful services created in this repository use `create*` factories and keep mutable state inside closures. Domain code favors pure decisions and typed results.

Run the complete local gate with:

```sh
pnpm check
```

This runs formatting checks, lint, type checking, and tests. Integration and acceptance work uses Pi AgentHarness with a credential-free controlled provider; narrow unit seams may use test-only scripted doubles. CI does not require credentials, network access, or paid model calls.

## Current limitations

- Collaboration posture, anticipated future use, adaptation history, and conversational contest or revert are not implemented in the TUI.
- Ambient compounding replay is not yet scheduled from ordinary post-settlement work.
- Workflows currently run sequentially in the foreground. Background job integration, bounded `map` fan-out, and nested agent phases are not implemented yet.
- Installed skill bytes are frozen for the active turn and bound into its catalog digest, but historical skill content is not yet copied into workspace-owned immutable snapshots.
- A session left `running` after its executor ends cannot be recovered safely until Noesis has durable executor ownership evidence.
