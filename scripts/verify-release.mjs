import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function releaseDetails(manifest, tag) {
  if (manifest.name !== "noesisai") throw new Error("Release package must be named noesisai");
  const version = manifest.version;
  const match =
    typeof version === "string" && version.length <= 256
      ? /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(
          version,
        )
      : null;
  if (
    !match ||
    match[4]?.split(".").some((part) => /^0[0-9]+$/u.test(part)) ||
    match.slice(1, 4).some((part) => !Number.isSafeInteger(Number(part)))
  ) {
    throw new Error("Release version must be valid SemVer without build metadata");
  }
  if (tag !== `v${version}`) throw new Error(`Release tag must equal v${version}`);
  return { version, distTag: match[4] ? "beta" : "latest", filename: `noesisai-${version}.tgz` };
}

export function verifyReleaseCheckout(cwd, tag) {
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git("rev-parse", "HEAD") !== git("rev-parse", `refs/tags/${tag}^{commit}`)) {
    throw new Error("Checkout must match the exact release tag");
  }
  // Release.target_commitish is only a hint; prove membership in main's history.
  git("merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repositoryRoot = new URL("../", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("package.json", repositoryRoot), "utf8"));
  const tag = process.env["RELEASE_TAG"];
  const details = releaseDetails(manifest, tag);
  verifyReleaseCheckout(repositoryRoot, tag);
  const output = process.env["GITHUB_OUTPUT"];
  if (output) {
    appendFileSync(output, `dist-tag=${details.distTag}\nfilename=${details.filename}\n`);
  }
  console.log(`Verified noesisai@${details.version} from ${tag}; npm tag: ${details.distTag}`);
}
