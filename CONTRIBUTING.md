# Contributing to Noesis

Noesis is an experimental local agent harness. Before changing product behavior, read the relevant doctrine in [`docs/`](docs/README.md). Before changing package ownership, protected boundaries, tools, codemode, skills, Programs, or TUI surfaces, read the relevant plan in [`plans/`](plans/README.md).

## Local setup

Use Node.js 22.19 or newer and pnpm 10:

```sh
pnpm install
pnpm check
```

`pnpm check` verifies formatting, lint, types, and tests with credential-free controlled providers. Packaging changes must also pass:

```sh
pnpm package:smoke
```

That command builds the release artifact, packs it, installs the tarball into an isolated directory, and exercises the installed CLI and codemode worker.

## Changes

- Keep changes small enough to explain and test as one coherent contract.
- Add or update tests at the boundary the change affects.
- Keep implementation plans under `plans/` and durable product doctrine under `docs/`.
- Do not commit credentials, `.noesis/` state, or transcript data.
- Use a concise Conventional Commit message.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
