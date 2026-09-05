# Releasing Noesis

Noesis publishes one npm package, `noesisai`, with the executable name `noesis`. Release builds include the bundled first-party runtime, workspace migrations, built-in skills, and the codemode worker.

## Before any release

1. Put the intended version in `package.json` and update `pnpm-lock.yaml`.
2. Merge only after CI passes on the minimum supported Node.js version and the current Node.js release.
3. From a clean checkout of `main`, run `pnpm install --frozen-lockfile`, `pnpm audit --prod`, `pnpm check`, and `pnpm package:smoke`.
4. Inspect the `npm pack --dry-run` file list. It must contain the CLI, migrations, built-in skills, codemode worker, README, and license, and must not contain credentials, `.noesis/` state, tests, plans, or TypeScript sources.
5. Confirm that the npm package name, repository metadata, release notes, support statement, and security-reporting route are correct.

## First release: `0.0.1`

npm staged publishing and trusted-publisher configuration require an existing package. The first release therefore bootstraps the package manually from a clean checkout after the maintainer has completed the review above.

Authenticate to npm with an account that has two-factor authentication enabled, then run:

```sh
npm publish --access public
```

Do not automate this first publish with a long-lived token. After `noesisai@0.0.1` is visible, verify a fresh `npm install --global noesisai` on both macOS and Linux before announcing the beta.

## Configure later releases

After the package exists, configure an npm trusted publisher with:

- provider: GitHub Actions
- owner: `SwarnimWalavalkar`
- repository: `noesis`
- workflow: `publish.yml`
- environment: `npm`
- allowed action: `npm stage publish` only

Create the GitHub `npm` environment with a required maintainer reviewer. Do not add an npm write token to the repository.

For later versions, dispatch **Stage npm release** from `main`. Enter the package version and the exact confirmation requested by the workflow. The workflow reruns repository checks and the installed-tarball smoke test, then submits the package to npm's private staging area.

Download and inspect the staged tarball. Approve it from npm with two-factor authentication only after its contents and metadata match the reviewed commit. Create the matching Git tag and GitHub release after npm reports the version as public.
