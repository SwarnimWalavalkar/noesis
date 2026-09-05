import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseDetails, verifyReleaseCheckout } from "./verify-release.mjs";

describe("release inputs", () => {
  it.each(["0.0.2", "0.1.0", "1.0.0"])("publishes %s to latest", (version) => {
    expect(releaseDetails({ name: "noesisai", version }, `v${version}`)).toEqual({
      version,
      distTag: "latest",
      filename: `noesisai-${version}.tgz`,
    });
  });
  it.each(["0.1.0-beta.1", "1.0.0-rc.1", "1.0.0-0"])("publishes %s to beta", (version) => {
    expect(releaseDetails({ name: "noesisai", version }, `v${version}`).distTag).toBe("beta");
  });
  it.each([
    "01.0.0",
    "1.0",
    "1.0.0-beta.01",
    "1.0.0-",
    "1.0.0+build",
    "1.0.0\ninjected=value",
    "9007199254740992.0.0",
    undefined,
  ])("rejects invalid version %s", (version) => {
    expect(() => releaseDetails({ name: "noesisai", version }, `v${version}`)).toThrow("SemVer");
  });
  it.each([undefined, "0.0.2", "v0.0.3", "v0.0.2\ninjected=value"])("rejects mismatched tag %s", (tag) => {
    expect(() => releaseDetails({ name: "noesisai", version: "0.0.2" }, tag)).toThrow("Release tag");
  });
  it("rejects another package name", () => {
    expect(() => releaseDetails({ name: "other", version: "0.0.2" }, "v0.0.2")).toThrow("named noesisai");
  });
});

it("requires the tagged checkout to belong to main, including annotated tags", () => {
  const cwd = mkdtempSync(join(tmpdir(), "noesis-release-test-"));
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Release Test",
        "-c",
        "user.email=release@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        ...args,
      ],
      { cwd, stdio: "pipe" },
    );
  try {
    git("init", "--initial-branch=main");
    git("commit", "--allow-empty", "-m", "initial");
    git("tag", "-a", "v0.0.2", "-m", "release");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    expect(() => verifyReleaseCheckout(cwd, "v0.0.2")).not.toThrow();
    git("checkout", "-b", "unmerged");
    git("commit", "--allow-empty", "-m", "unmerged");
    git("tag", "v0.0.3");
    expect(() => verifyReleaseCheckout(cwd, "v0.0.3")).toThrow();
    expect(() => verifyReleaseCheckout(cwd, "v0.0.2")).toThrow("exact release tag");
    git("checkout", "main");
    git("commit", "--allow-empty", "-m", "later main commit");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("checkout", "v0.0.2");
    expect(() => verifyReleaseCheckout(cwd, "v0.0.2")).not.toThrow();
    git("update-ref", "-d", "refs/remotes/origin/main");
    expect(() => verifyReleaseCheckout(cwd, "v0.0.2")).toThrow();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
