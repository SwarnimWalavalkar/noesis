# Noesis

Noesis is a local-first personal agent runtime whose durable unit is an inspectable trail. Pi executes model turns; Noesis owns meaning, history, context, learning, permissions, promotion, recovery, scheduling, and the terminal experience.

This repository implements the first complete compounding loop: useful work creates evidence-linked memory, knowledge, and workflow proposals; a workflow becomes a permissioned candidate skill; source and held-out replay govern promotion; a later trail pins and uses the promoted version; monitoring can roll it back; and the same execution path can run under a smaller scheduler grant.

## Commands

Requirements: Node >= 22.19 and pnpm 10.

```sh
pnpm install
pnpm check
pnpm demo
# First interactive launch walks through provider, model, reasoning, and authentication:
pnpm start -- tui --home ./.noesis
# Every plain launch creates a new independent trail/session:
pnpm start -- --home ./.noesis
# Choose a prior session in the TUI, most recently active first:
pnpm start -- --resume --home ./.noesis
# Resume one exact session without opening the picker:
pnpm start -- --resume trail_01234567-89ab-cdef-0123-456789abcdef --home ./.noesis
# Resume the single most recently active session without opening the picker:
pnpm start -- --continue --home ./.noesis
# The same flow can be run explicitly without starting the TUI:
pnpm start -- onboard --home ./.noesis
# `--` is accepted and discarded by the CLI before command parsing:
pnpm start -- inspect --home ./.noesis-demo
pnpm start -- rebuild --home ./.noesis-demo
pnpm start -- tui --home ./.noesis --runtime fake
```

The fake runtime and `demo` command are deterministic and need no credentials. A real Pi-backed trail uses the generic `AgentHarness` and the provider-owned authentication exposed by Pi 0.80.6:

```sh
# ChatGPT Plus/Pro OAuth (interactive; opens no browser automatically)
pnpm start -- auth login openai-codex --home ./.noesis
pnpm start -- tui --home ./.noesis --runtime pi --provider openai-codex --model gpt-5.5

# OpenRouter via the environment (never written to config.json)
OPENROUTER_API_KEY=... pnpm start -- tui --home ./.noesis --runtime pi \
  --provider openrouter --model anthropic/claude-sonnet-4.5
```

Noesis does not register direct `OPENAI_API_KEY` authentication. Use `openai-codex` for Codex OAuth or `openrouter` for an OpenRouter key.

The TUI is built directly with `@earendil-works/pi-tui`. A plain `noesis`, `noesis tui`, or `pnpm start` creates a fresh trail every time and never inherits an earlier conversation. `--continue` non-interactively resumes the single most recently active trail; it never creates a trail and fails actionably when none exists. `--resume` opens a keyboard-navigable session picker; `--resume <session-id>` resumes that exact trail directly. The picker and `--continue` use the same deterministic ordering: last activity descending, then full trail ID ascending when timestamps tie. The picker shows at most the 100 most recent sessions, with a shortened stable ID, time, status, provider/model, turn/message count, and a deterministic preview from the first user message. The cap cannot affect `--continue` because the authoritative newest row is always first. Direct lookup is not capped, so a known full ID can resume an older session omitted from the picker. Escape or Ctrl+C cancels the picker cleanly. Historical single-trail homes remain resumable through the same commands and are no longer auto-resumed.

Resume is compare-and-append safe against concurrent ledger activity. A trail still marked `running` is never inferred dead from replay alone and is never changed to idle during startup. Exact resume and `--continue` fail closed with guidance to wait for an in-flight turn to finish. If the executor was actually interrupted, this build deliberately leaves the trail running because it has no durable executor-ownership lease proving recovery is safe; explicit recovery remains a future control-plane primitive. `--continue` does not fall back to an older idle trail. Plain startup may create a separate new trail without changing the running trail.

The CLI grammar is strict across every command: unknown options, duplicate startup flags, `--continue` values, `--continue`/`--resume` conflicts, and trailing operands fail with an actionable error. `--continue` and `--resume` are valid only for the TUI and are mutually exclusive.

The normal TUI supports streamed turns and `/model provider/model`, `/context`, `/capabilities`, `/fork`, `/compact`, `/abort`, `/learn`, `/evaluate`, `/promote`, `/rollback`, and `/job prompt`. Use `/quit` or Ctrl+C to exit cleanly. Runtime selection remains a process-level control because changing the execution adapter inside a live trail would invalidate its provenance. A resumed trail keeps its original provider/model; if it was created under another runtime, relaunch with the actionable `--runtime` value reported by Noesis.

### Terminal experience

The TUI is a responsive thinking shell rather than a persistent diagnostics panel. Wide and normal terminals with enough height show the hand-owned `NOESIS` ASCII wordmark and the subdued line `think · learn · create · grow`. Narrow or shorter terminals use a single-line wordmark; extremely constrained terminals omit branding so the transcript, focused input, and exit hint remain usable. `NO_COLOR` and `TERM=dumb` disable Noesis styling. The session picker uses the compact wordmark at every size.

The transcript is followed by one live status line. Fields are removed by priority as width shrinks: execution state and provider/model remain first, then context usage, reasoning level, short session ID, turn count, exact token ratio, and active capability count. A wide example is:

```text
● IDLE       · openai-codex/gpt-5.6-sol · xhigh · ctx  28% · 32k/114k · session 69b186a1 ·  12 turns
```

`IDLE`, `THINKING`, `STREAMING`, `TOOL`, `COMPACTING`, `ABORTING`, and `ERROR` reflect the current TUI/runtime lifecycle. Enter `?` or `/help` to reveal every command; the persistent hint stays limited to `? help · /quit exit · Ctrl+C stop`. Normal views show only the stable eight-character session suffix. `noesis inspect` remains the source for full trail IDs and durable details.

For Pi turns, the percentage uses the most recent provider-reported total token usage and the selected model's `contextWindow` metadata from Pi 0.80.6. The fake runtime marks its deterministic character estimate with `~`. Before the first reported turn, after `/compact` or `/model`, and after resume when historical usage was not stored, the TUI shows `ctx —`. The next completed turn refreshes it. This pass deliberately does not change schema version 1 or persist new usage fields, so a resumed process cannot claim historical token precision that the ledger does not contain.

## Configuration

The user configuration is `<NOESIS_HOME>/config.json` (normally `.noesis/config.json`). It is strict, typed, and contains preferences only—never API keys or OAuth tokens.

When an interactive TUI starts without a config file or explicit agent flags, Noesis automatically runs first-launch onboarding. The flow chooses Codex OAuth or OpenRouter, model, and reasoning level; confirms the complete setup; authenticates through Pi; and then creates `config.json` in one exclusive write. OAuth tokens and API keys remain in the separate protected `auth.json` store. Cancellation or authentication failure leaves `config.json` absent, and onboarding refuses to overwrite an existing config. Use `config set` and `auth login` to change an existing setup.

For automation, explicit CLI/environment settings bypass onboarding. A non-interactive first launch fails with an actionable message rather than waiting for input; use `config init` or `config set` in that case.

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

Valid runtimes are `fake` and `pi`. Valid thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. During current development, all additions to this file remain `schemaVersion: 1`. Do not bump the version or add migration machinery yet; this build applies v1 defaults and rejects every unsupported version.

Precedence is deterministic for every agent setting:

1. CLI flags: `--runtime`, `--provider`, `--model`, `--thinking-level`
2. Environment: `NOESIS_RUNTIME`, `NOESIS_PROVIDER`, `NOESIS_MODEL`, `NOESIS_THINKING_LEVEL`
3. `config.json`
4. Built-in defaults: `fake`, `fake`, `noesis-fake-1`, `off`

`--home` overrides `NOESIS_HOME`, which overrides `.noesis`. Explicit `off` and `low` values are preserved.

```sh
pnpm start -- config init --home ./.noesis
pnpm start -- config show --home ./.noesis
pnpm start -- config set --home ./.noesis \
  --runtime pi --provider openai-codex --model gpt-5.5 --thinking-level medium
```

`config init` uses exclusive creation and refuses to overwrite an existing file. `config set` is the explicit update operation and fails if the file changes concurrently. Invalid JSON, unknown fields, invalid values, and unsupported versions fail with the config path and an actionable error.

## Provider authentication

Pi credentials are stored separately at `<NOESIS_HOME>/auth.json` through Pi's `CredentialStore` contract. Noesis creates the home with mode `0700`, writes credentials atomically with mode `0600`, and serializes the full read-modify-write across cooperating processes. Pi owns the provider login/refresh logic; `Models` refreshes an expired OAuth credential under that store lock and persists rotated credentials. No credential is copied into `config.json`, ledger events, SQLite, Markdown, logs, or test fixtures.

```sh
# Codex OAuth lifecycle
pnpm start -- auth login openai-codex --home ./.noesis
pnpm start -- auth status openai-codex --home ./.noesis
pnpm start -- auth logout openai-codex --home ./.noesis

# OpenRouter: use the environment when no stored Pi credential exists, or store a key through Pi
OPENROUTER_API_KEY=... pnpm start -- auth status openrouter --home ./.noesis
pnpm start -- auth login openrouter --home ./.noesis
pnpm start -- auth logout openrouter --home ./.noesis
```

For OpenRouter, Pi 0.80.6 resolves a stored `auth.json` provider credential before
`OPENROUTER_API_KEY`. The environment key is used only when no OpenRouter credential is stored;
`auth logout openrouter` removes the stored credential so the environment key becomes active.

`auth status` never prints credentials. For stored OAuth it reports whether the current token is expired without refreshing it; refresh occurs only on a real model request. Missing credentials fail before `AgentHarness` execution with the exact login command or environment variable needed.

## Architecture

- `apps/noesis`: CLI and acceptance demo.
- `packages/config`: strict schema-v1 user preferences, precedence resolution, and guarded file updates.
- `packages/domain`: versioned Zod contracts, IDs, principals, JSON values, results, and checksums.
- `packages/ledger`: single-writer, process-locked, fsynced append-only JSONL; checksum recovery; node:sqlite projections/FTS; migrations; and content-addressed artifacts. Projection rebuilds replay JSONL into a fresh temporary SQLite database and atomically replace the old file; session-index reads are checked against the authoritative capped JSONL view so corrupt, stale, incomplete, or misordered SQLite cannot hide or select the wrong session.
- `packages/runtime-pi`: the only Pi runtime import boundary; real `AgentHarness` and deterministic fake implementations share `NoesisAgentRuntime`.
- `packages/runtime`: trail lifecycle, frozen turn context, orchestration, crash recovery, and scheduler leases/budgets.
- `packages/context`: pure, provenance-aware, hard-bounded context compilation.
- `packages/memory`: typed evidence records, supersession, and Markdown projection.
- `packages/capabilities`: declarative skill packages, permissions, versions, use records, promotion, and rollback.
- `packages/learning`: isolated reflection that can propose but cannot promote.
- `packages/evals`: canonical candidate replay against author-provided source cases and a separately owned protected held-out suite, with digest-bound reports and retained negative results.
- `packages/policy`: the operation-shaped authority boundary, durable grants/reservations/usage/costs/results, fail-closed ambiguous effects, and idempotent replay.
- `packages/tui`: immutable reducer/read-model rendering and the Noesis-owned Pi TUI application. It never owns durable state.

The one intentional package-boundary compression from the plan is that the artifact store lives in `packages/ledger`: both are integrity/storage primitives with the same root and no independent policy. Its public API remains separate as `ArtifactStore`.

First-party services are exposed as readonly structural interfaces created by `create*` factories. Mutable runtime state stays inside each factory closure. The only remaining first-party classes are native error categories whose identity is used for typed handling or `instanceof` checks:

- `OnboardingCancelledError` distinguishes a user cancellation from setup failures.
- `NoesisConfigError` carries the failing config path and cause through the typed config result.
- `LedgerIntegrityError` distinguishes durable corruption and recovery failures.
- `LedgerConflictError` drives safe retry of compare-and-append conflicts.

## Storage

For a home such as `.noesis/`:

```text
config.json                     typed schema-v1 user preferences; no secrets
auth.json                       Pi credentials, mode 0600; never projected
ledger/events.jsonl             source of truth; checksum chained
projections/noesis.sqlite       rebuildable read models and FTS5
artifacts/sha256/ab/<hash>      immutable content-addressed outputs
views/memory.md                 inspectable human-readable projection
```

SQLite and Markdown are never authoritative. `noesis rebuild` recreates both from JSONL. Startup verifies sequence, schema, checksum, and chain continuity. A checksum-valid final event missing only its newline is preserved; a torn tail is truncated. Appends and explicit replay refreshes are queued in-process and take `ledger/events.jsonl.writer.lock` across the complete operation. A dead-owner PID lock is reclaimed; a live owner is never stolen. Ambiguous interrupted turns remain durably running until a future explicit executor-ownership recovery primitive can resolve them safely, and reserved effects without a durable outcome are not replayed automatically.

## Threat boundaries

Reflection runs as `reflector` and can write proposals/candidates with source cases only. Evaluation, the protected held-out suite, ledger integrity, authority issuance, promotion, and rollback are ordinary protected source code, not generated behavior. TUI actions call runtime operations that reserve authority before changing protected state; callers cannot install grants or construct valid receipts. Scheduler grants are issued only from an authorized scheduling receipt and remain principal-, job-, expiry-, use-, and cost-scoped. Effect reservations consume use and cost before execution and are reconstructed from JSONL after restart. Generated capabilities are declarative data; future generated code must run out of process behind the effect gateway.

## Current limitations

- The real Pi adapter registers OpenAI Codex OAuth, OpenRouter, and the existing Anthropic provider, and exposes one frozen-snapshot inspection tool. It intentionally does not register direct OpenAI API-key authentication. External side-effecting tools are an extension seam and must be injected through the effect gateway.
- OAuth login is interactive and networked when explicitly invoked. Automated tests cover the same lifecycle with injected providers and credential stores; CI does not perform a login or model request.
- Pi compaction is not used as Noesis history truth; Noesis records its own deterministic compaction event while keeping the append-only source trail.
- Scheduler execution is restart-safe, budget-reserving, fenced, heartbeat-renewed, and terminal-state enforced, but this iteration exposes an explicit run operation rather than a resident cron daemon.
- Process locking assumes cooperating Noesis writers and a shared host PID namespace. It does not claim protection against a malicious process that edits the journal or lock file directly.
- Markdown currently projects accepted memory. Capability/evaluation/job inspection is available through SQLite, ledger events, CLI JSON, and the TUI rather than additional Markdown files.
- `node:sqlite` emits an experimental warning on Node 24 even though the API is built into the required Node line.
