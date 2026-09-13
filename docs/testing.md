# Testing Noesis

For fast feedback on schemas, pure decisions, input handling, and rendering:

```sh
pnpm test:unit
pnpm test:watch
```

The unit command is an explicit subset and runs alongside static checks in normal CI. Watch mode uses the same subset and reruns affected tests as files change. Changes to persistence, runtime composition, providers, or process behavior also need their integration tests.

Run the tests for the changed behavior and its consumers while iterating:

```sh
pnpm test apps/noesis/test/cli-args.test.ts apps/noesis/test/cli.test.ts
```

Use `pnpm check` for formatting, lint, and typechecking; it does not run tests. `pnpm test` continues to run every test; process and acceptance coverage are not excluded from the default command. OAuth and MCP tests need permission to bind localhost listeners. Tests use controlled providers and require no paid model credentials.

## CI and release gates

- Pull requests and pushes to `main` install dependencies and run static checks and unit tests. The CI production dependency audit runs only on pull requests; releases retain their audit.
- Package smoke runs on Linux with the minimum supported Node and macOS with current Node when dependencies, packaging inputs, bundled skills or migrations, or release tooling change. The path list lives in `.github/workflows/package-smoke.yml`; add new packaging inputs there. It can also be run manually in Actions.
- Every release requires the package-smoke matrix, static checks, the full test suite, and a smoke test of the exact tarball that will be published. A failed check prevents npm publishing.

During development, run the affected integration tests and manually exercise the changed behavior. Ordinary source edits do not trigger the full suite or package-smoke matrix unless they touch a listed packaging input.

## Choosing coverage

Put a scenario at the lowest layer that exercises its contract. CLI grammar cases call the actual parser directly; a subprocess smoke test checks that parsing errors reach stderr with a failing exit status. Configuration, environment, persistence, and shutdown behavior still exercise the real CLI process.

Use the repository-wide AST checks in `packages/domain/test/architecture.test.ts` for package boundaries. Do not add parallel string-scanning tests for the same import rules. File length alone is not a behavioral contract.

Domain tests validate schemas and pure decisions. Persistence tests use `WorkspaceStore` and SQLite. A fake store that implements writes and then asserts its own reads adds maintenance without exercising persistence. Keep revision binding and malformed durable-data cases even when removing fake round-trip checks.

Keep controlled Pi AgentHarness journeys for integration coverage. Keep distinct cancellation, recovery, authority, rollback, and immutable-revision scenarios: similar setup does not make those failure modes equivalent. Before deleting an overlapping test, identify the retained test that detects the same regression.

### Coverage ownership

When a scenario already has a fixture at the appropriate boundary, add its related assertions there instead of repeating the setup in another suite. Keep scenarios separate when they exercise different failure paths or need different prerequisites.

| Contract                                                                                            | Retained coverage                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backspace, grapheme deletion, terminal resize, direct resume, and empty-session cleanup             | Real PTY journeys in `apps/noesis/test/quit.test.ts`                                                                                                      |
| Shutdown ordering, repeated quit signals, cancellation, and cleanup failures                        | `packages/tui/test/lifecycle.test.ts`; the gated closing test also checks that stop and drain happen once                                                 |
| Action transitions, nested action identity, duration, and navigation                                | `packages/tui/test/reducer.test.ts`; transition and cursor scenarios own these assertions                                                                 |
| Collapsed/expanded tool rows, selection width, nested indentation, and retained subagents           | `packages/tui/test/rendering.test.ts`; each representative tree is reused for its display states                                                          |
| Learning command opens a usable audit overlay                                                       | `packages/tui/test/learning-audit.test.ts`                                                                                                                |
| Criterion revision history, pin protection, scoped snapshots, retirement, and malformed definitions | `packages/config/test/workspace-criteria.test.ts`, using real SQLite and immutable files; concurrent publication and crash recovery remain separate cases |
| OpenCode provider isolation and credential precedence                                               | One environment-to-stored-credentials journey in `packages/runtime-pi/test/auth.test.ts`                                                                  |
| Preflight binding and rejected evidence variants                                                    | The request/report fixture in `packages/runtime/test/protected-activation.test.ts`                                                                        |

Consolidation should remove repeated fixtures and redundant assertions, while preserving assertions that distinguish a failure. A smaller test count alone is not evidence of a faster or better suite.

## Measuring runtime

Capture per-file and per-test durations with:

```sh
pnpm test --reporter=default --reporter=json --outputFile=/tmp/noesis-tests.json
```

Compare complete runs with the same permissions and machine conditions. A sandbox-induced OAuth timeout is not a useful performance baseline. The default caps workers at eight (or the available CPU count on smaller machines) to limit contention between SQLite fixtures and nested CLI/PTY processes. Override it with `--maxWorkers=N` when benchmarking another machine. Keep file isolation and production durability settings intact.

The PTY suite runs up to three independent terminal journeys concurrently. Each test owns its temporary homes and child-process cleanup. OAuth onboarding stays serial because the provider's localhost callback uses a fixed port. Other suites remain sequential within each file unless they explicitly opt into concurrency.

In-process tests replace Pi's native modifier-key probe so synthetic Enter events cannot become Shift+Enter when someone types on the host Mac. This narrow hardware stub does not load in real PTY subprocesses. Heartbeat cancellation tests advance interval timers explicitly while keeping SQLite operations real.

Prioritize repeated process startup, repeated repository scans, unnecessary fixture construction, and fixed sleeps before reducing useful cases. For timing-sensitive tests, replace sleeps with an observable completion condition where possible; retain real process deadlines when process termination is the contract.

The in-memory TUI lifecycle suite skips the cosmetic closing delay except in its explicit abort-ordering test. Real PTY tests retain the production delay. Presentation assertions share existing launch, picker-cancellation, and resize journeys instead of launching a separate process for each visual property.
