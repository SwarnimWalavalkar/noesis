# Releasing Noesis

Publishing a GitHub release is the approval to publish its npm package. Saving a draft does not publish anything. There is no separate npm approval or GitHub environment review.

## Ship a version

1. Update the root `package.json` version, run `pnpm check` and `pnpm package:smoke`, and commit the version bump to `main`.
2. [Create a GitHub release](https://github.com/SwarnimWalavalkar/noesis/releases/new). Create a tag named `v` followed by that exact version, targeting the version-bump commit on `main`. Add release notes and publish the release.
3. Watch the **Publish npm release** workflow in Actions. The GitHub release appears before npm publishing finishes; wait for the workflow to pass before announcing the package.

The workflow verifies the tag, package name, version, and commit's membership in `main`. It runs the dependency audit, formatting, lint, types, tests, and fresh-install package smoke test. It attaches the tested tarball to the GitHub release and publishes those same bytes with npm provenance. It never rebuilds between testing and publishing.

The version determines the npm channel, independently of GitHub's prerelease checkbox:

| Version        | Release tag     | npm channel |
| -------------- | --------------- | ----------- |
| `0.0.2`        | `v0.0.2`        | `latest`    |
| `0.1.0-beta.1` | `v0.1.0-beta.1` | `beta`      |

All SemVer prerelease versions use `beta`, including `alpha` or `rc` identifiers. Build metadata (`+...`) is not accepted. The public-beta `0.0.x` versions remain on `latest` so ordinary installs receive them.

## One-time configuration

The npm trusted publisher for `noesisai` must allow direct publishing from repository `SwarnimWalavalkar/noesis`, workflow `publish.yml`, environment `npm`. The workflow uses GitHub OIDC; do not add an `NPM_TOKEN` secret.

The GitHub `npm` environment allows tags matching `v*`, with no required reviewers. The workflow separately verifies that the tagged commit belongs to `main`. Publishing a release is therefore a privileged action: keep repository write access limited to release maintainers.

## Test without publishing

```sh
pnpm check
PACKAGE_OUTPUT_DIR="$(mktemp -d)" pnpm package:smoke
```

The smoke test builds and installs the package in a temporary directory, exercises the installed CLI and runtime, and copies the exact tested tarball to `PACKAGE_OUTPUT_DIR` only after success. It refuses to overwrite an existing archive. Without that variable, it removes the temporary package after testing. Neither command publishes to npm or creates a GitHub release.

## Failed releases

A failed check prevents npm publishing. Inspect the Actions logs before retrying. The workflow preserves the tested tarball as an Actions artifact before uploading it to the release.

If npm publishing failed after the release asset was attached, first confirm that the version is absent from npm. Remove only that failed release's tarball asset before rerunning the job; the upload deliberately refuses to overwrite an existing asset.

If the version already exists on npm, do not rerun publishing or move the tag. Inspect the registry version and the saved artifact to establish whether publishing succeeded. npm versions are immutable; fixes require a new version and release.
