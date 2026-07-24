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
- [Compounding partnership product loop build plan](plans/compounding-partnership-product-loop.md)

## Research preview status

Noesis is a local research preview. The repository has substantial foundations, but it does not yet deliver the complete product loop above.

What works now:

- The CLI and TUI support new and resumed sessions. They also support continue, fork, compact, and abort operations.
- Pi executes model turns behind `packages/runtime-pi`. A deterministic fake runtime supports tests and demos without credentials.
- Provider setup supports OpenAI Codex OAuth, OpenRouter, and the Anthropic provider exposed through Pi.
- `WorkspaceStore` provides SQLite operational records and editable definitions. It also provides immutable revisions, evidence, artifacts, search, durable jobs, activation state, feedback state, integrity checks, and backups.
- The learning and evaluation packages implement tested reflection, candidate, and comparison parts. Other tested packages cover capabilities, generated tools, protected authority, activation, and feedback.

The current application is still in transition:

- Foreground turns still run through the legacy JSONL trail, memory, capability, policy, and scheduler path.
- The application also records sessions, messages, outcomes, activation, learning, evaluation, and feedback data through `WorkspaceStore`. This is a temporary split authority path.
- A pinned workspace activation does not yet determine the prompt and tools served to the foreground model.
- Fresh workspaces do not yet enter the complete ambient learning loop.
- The TUI still exposes the manual `/learn`, `/evaluate`, `/promote`, and `/rollback` workflow. Collaboration posture, adaptation history, and conversational contest or revert are planned work.

The [next product loop plan](plans/compounding-partnership-product-loop.md) first moves foreground and protected operational authority to SQLite. Later work adds collaboration posture and selective learning with anticipated future use. It then serves exact active revisions and tools, exposes adaptation history and conversational controls, and proves the complete path with the fake runtime.

## Quick start

You need Node 22.19 or newer and pnpm 10.

```sh
pnpm install
pnpm check

# Run the deterministic demo without credentials.
pnpm demo

# Start the TUI with a local home.
pnpm start -- tui --home ./.noesis

# Run the TUI with the deterministic fake runtime.
pnpm start -- tui --home ./.noesis --runtime fake
```

An interactive first launch with no config and no explicit agent settings starts onboarding. It asks for the provider, model, reasoning level, and authentication. You can run the same flow directly:

```sh
pnpm start -- onboard --home ./.noesis
```

Noninteractive use does not wait for onboarding. Initialize or set the config first:

```sh
pnpm start -- config init --home ./.noesis
pnpm start -- config show --home ./.noesis
pnpm start -- config set --home ./.noesis \
  --runtime pi --provider openai-codex --model gpt-5.5 --thinking-level medium
```

## Provider authentication

OpenAI Codex OAuth and OpenRouter are the two onboarding choices.

```sh
# OpenAI Codex OAuth
pnpm start -- auth login openai-codex --home ./.noesis
pnpm start -- tui --home ./.noesis \
  --runtime pi --provider openai-codex --model gpt-5.5

# OpenRouter through the environment
OPENROUTER_API_KEY=... pnpm start -- tui --home ./.noesis \
  --runtime pi --provider openrouter --model anthropic/claude-sonnet-4.5
```

Noesis does not register direct `OPENAI_API_KEY` authentication. Use `openai-codex` for Codex OAuth or `openrouter` for an OpenRouter key.

Pi credentials live in `<NOESIS_HOME>/auth.json`, separate from user preferences. Noesis requires mode `0700` for the credential directory. It requires mode `0600` for the credential file. Noesis never copies credentials into config, durable state, logs, or test fixtures.

Use these commands to inspect or change provider credentials:

```sh
pnpm start -- auth status openai-codex --home ./.noesis
pnpm start -- auth logout openai-codex --home ./.noesis
pnpm start -- auth login openrouter --home ./.noesis
pnpm start -- auth logout openrouter --home ./.noesis
```

For OpenRouter, a stored credential takes precedence over `OPENROUTER_API_KEY`. Remove the stored credential to use the environment key. `auth status` does not print credentials or refresh an expired OAuth token.

## Sessions and the TUI

A plain `noesis`, `noesis tui`, or `pnpm start` creates a new independent session. It does not inherit a prior conversation.

```sh
# Choose a saved session.
pnpm start -- --resume --home ./.noesis

# Resume one exact session.
pnpm start -- --resume trail_01234567-89ab-cdef-0123-456789abcdef --home ./.noesis

# Resume the most recently active session.
pnpm start -- --continue --home ./.noesis
```

`--resume` opens a picker that you can control with the keyboard. `--continue` selects the single most recently active session. Both fail closed if the selected session is still marked `running`. This build has no durable executor ownership lease, so it cannot safely recover a session whose process ended during a turn. Start a separate session or wait until explicit recovery is available.

The TUI uses `@earendil-works/pi-tui` directly. It streams turns and supports:

```text
/model provider/model  /context       /capabilities  /fork
/compact               /abort         /learn         /evaluate
/promote               /rollback      /job prompt    /quit
```

Enter `?` or `/help` to see the command list. Use `/quit` or Ctrl+C to exit. `NO_COLOR` and `TERM=dumb` disable styling.

## Configuration

User preferences live in `<NOESIS_HOME>/config.json`. The file uses schema version 1 and never contains credentials.

```json
{
  "schemaVersion": 1,
  "agent": {
    "runtime": "pi",
    "provider": "openai-codex",
    "model": "gpt-5.5",
    "thinkingLevel": "medium"
  }
}
```

Agent settings use this precedence:

1. CLI flags
2. `NOESIS_RUNTIME`, `NOESIS_PROVIDER`, `NOESIS_MODEL`, and `NOESIS_THINKING_LEVEL`
3. `config.json`
4. Defaults in source code

`--home` overrides `NOESIS_HOME`, which overrides `.noesis`. Valid runtimes are `fake` and `pi`. Valid reasoning levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

## Architecture and storage

Pi executes turns. Noesis owns the product and control plane around those turns. Only `packages/runtime-pi` imports Pi agent and runtime types. The TUI renders runtime read models and never owns durable state.

The settled persistence model is:

- `WorkspaceStore` owns persistence boundaries.
- `<NOESIS_HOME>/database/noesis.sqlite` is authoritative for operational state that has moved to the workspace path.
- Ordinary files under `<NOESIS_HOME>/definitions/` are authoritative for editable definitions.
- Immutable snapshots under `revisions/` and `evidence/` preserve exact recorded bytes.
- Large outputs remain files under `artifacts/` with SQLite metadata.
- Search data and UI read models are rebuildable projections.

The current foreground path has not completed that move. It still uses `<NOESIS_HOME>/ledger/events.jsonl` for legacy trail and protected operational state, with `<NOESIS_HOME>/projections/noesis.sqlite` as its rebuildable projection. `noesis rebuild` rebuilds that legacy projection only. JSONL activity is provenance during the transition. It is not the universal authority in the target architecture, and new code must not treat it as a recovery journal for workspace operational state.

Important package boundaries include:

- `apps/noesis` owns the CLI and application composition.
- `packages/runtime` owns the turn lifecycle and protected coordination.
- `packages/workspace` owns SQLite, definitions, immutable revisions, evidence, artifacts, search indexes, and backups.
- `packages/runtime-pi` is the only Pi runtime boundary.
- `packages/intelligence`, `packages/learning`, and `packages/evals` own retrieval, reflection and candidate creation, and comparison evidence.
- `packages/policy` and `packages/capabilities` own protected effects and exact capability revisions.
- `packages/tool-runtime` runs generated tools in a separate process.
- `packages/tui` owns terminal rendering and input handling.

Generated reflection and candidate authorship never receive promotion authority. All protected promotion, rollback, scheduling, and external effects go through the authority and effect boundaries. A generated tool cannot approve or widen its own permissions.

## Development

The repository uses strict TypeScript ESM and exact direct dependency versions. Stateful services created in this repository use `create*` factories and keep mutable state inside closures. Domain code favors pure decisions and typed results.

Run the complete local gate with:

```sh
pnpm check
```

This runs formatting checks, lint, type checking, and tests. Tests and acceptance work use the fake runtime and do not require paid model calls.

## Current limitations

- The shipped foreground turn does not yet use one workspace backed intelligence plan. It can pin a workspace activation without serving that exact revision to the model.
- The Pi foreground runtime currently registers only immutable snapshot inspection. Session retrieval and generated tool adapters exist but are not wired into the application turn.
- Ambient learning does not start from an empty workspace activation. The shipped fake application reflection path only returns `no_change`.
- Collaboration posture, anticipated future use, adaptation history, and conversational contest or revert are not implemented in the TUI.
- Generated tools use a bounded local child process for research preview testing. This is not a production security boundary.
- A session left `running` after its executor ends cannot be recovered safely until Noesis has durable executor ownership evidence.
