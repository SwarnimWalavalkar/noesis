import { describe, expect, it } from "vitest";
import { patchedVersion, publishedManifest } from "./stage-release.mjs";

const overrides = {
  "brace-expansion@>=4.0.0 <5.0.12": "5.0.12",
  "ip-address@<10.7.5": "10.7.5",
  "undici@>=8.0.0 <8.12.3": "8.12.3",
};

describe("vendored dependency patches", () => {
  it.each([
    ["undici", "8.9.0", "8.12.3"],
    ["undici", "8.12.3", "8.12.3"],
    ["undici", "7.9.0", "7.9.0"],
    ["ip-address", "10.0.0", "10.7.5"],
    ["undici-types", "8.9.0", "8.9.0"],
  ])("resolves %s@%s to %s", (name, version, expected) => {
    expect(patchedVersion(name, version, overrides)).toBe(expected);
  });

  it("rejects override ranges it cannot evaluate", () => {
    expect(() => patchedVersion("undici", "8.9.0", { "undici@^8.0.0": "8.12.3" })).toThrow(
      "Unsupported override range",
    );
  });
});

describe("published manifest", () => {
  const source = {
    name: "noesisai",
    version: "1.0.0",
    bin: { noesis: "./dist/cli.js" },
    files: ["dist"],
    scripts: { prepack: "npm run build:release" },
    devDependencies: { vitest: "4.1.8" },
    packageManager: "pnpm@10.29.3",
    dependencies: { "@earendil-works/pi-ai": "0.85.0", "@earendil-works/pi-coding-agent": "0.85.0" },
    pnpm: { overrides },
  };
  const pi = {
    name: "@earendil-works/pi-coding-agent",
    dependencies: { "@earendil-works/pi-ai": "^0.85.0", undici: "8.9.0", chalk: "5.6.2" },
    optionalDependencies: { "@mariozechner/clipboard": "0.3.9" },
  };

  it("replaces the vendored package with its dependencies under patched pins", () => {
    expect(publishedManifest(source, [pi])).toEqual({
      name: "noesisai",
      version: "1.0.0",
      bin: { noesis: "./dist/cli.js" },
      files: ["dist"],
      dependencies: {
        "@earendil-works/pi-ai": "0.85.0",
        undici: "8.12.3",
        chalk: "5.6.2",
      },
      optionalDependencies: { "@mariozechner/clipboard": "0.3.9" },
    });
  });

  it("rejects a vendored requirement the release cannot satisfy", () => {
    const conflicting = { ...pi, dependencies: { "@earendil-works/pi-ai": "^0.86.0" } };
    expect(() => publishedManifest(source, [conflicting])).toThrow("needs @earendil-works/pi-ai@^0.86.0");
  });
});
