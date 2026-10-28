import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Pi publishes an npm-shrinkwrap.json that pins its transitive dependencies. npm honors that
 * file for Pi's subtree and ignores our overrides, so vulnerable pins reach every install.
 * The release vendors Pi's own files under `dist/node_modules`, without the shrinkwrap, and
 * declares Pi's dependencies on the published package, where npm resolves them per platform
 * under our patched versions. Node resolves the built code's Pi imports to the vendored copy.
 * npm's `bundleDependencies` is not used because npm 11 leaves a global install's other
 * dependencies empty when a package bundles any of them.
 */
export const VENDORED_PACKAGES = ["@earendil-works/pi-coding-agent"];
const PUBLISHED_FIELDS = [
  "name",
  "version",
  "description",
  "keywords",
  "homepage",
  "bugs",
  "license",
  "author",
  "repository",
  "bin",
  "files",
  "type",
  "publishConfig",
  "engines",
];

function parseVersion(value, context) {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(value);
  if (!match) throw new Error(`${context} must be an exact release version, received ${value}`);
  return match.slice(1, 4).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1)
    if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

/** Supports the comparator forms used by our overrides: `<x.y.z` and `>=x.y.z <x.y.z`. */
function satisfiesRange(version, range, context) {
  const parsed = parseVersion(version, context);
  return range.split(" ").every((comparator) => {
    const match = /^(>=|<)(.+)$/u.exec(comparator);
    if (!match) throw new Error(`Unsupported override range ${range} for ${context}`);
    const order = compareVersions(parsed, parseVersion(match[2], `override range ${range}`));
    return match[1] === "<" ? order < 0 : order >= 0;
  });
}

/** Applies the repository's pnpm security overrides to one exact dependency pin. */
export function patchedVersion(name, version, overrides) {
  for (const [selector, replacement] of Object.entries(overrides)) {
    const separator = selector.lastIndexOf("@");
    if (separator <= 0 || selector.slice(0, separator) !== name) continue;
    if (satisfiesRange(version, selector.slice(separator + 1), `${name}@${version}`)) return replacement;
  }
  return version;
}

/** Replaces vendored packages with their dependencies in the published manifest, without silent conflicts. */
export function publishedManifest(source, vendored) {
  const overrides = source.pnpm?.overrides ?? {};
  const dependencies = Object.fromEntries(
    Object.entries(source.dependencies).filter(([name]) => !VENDORED_PACKAGES.includes(name)),
  );
  const optionalDependencies = {};
  for (const vendoredManifest of vendored) {
    for (const [field, target] of [
      ["dependencies", dependencies],
      ["optionalDependencies", optionalDependencies],
    ]) {
      for (const [name, range] of Object.entries(vendoredManifest[field] ?? {})) {
        if (VENDORED_PACKAGES.includes(name)) continue;
        const requested = /^[0-9]/u.test(range) ? patchedVersion(name, range, overrides) : range;
        const existing = target[name] ?? dependencies[name];
        if (existing === undefined) target[name] = requested;
        else if (existing !== requested && !rangeAccepts(range, existing))
          throw new Error(
            `${vendoredManifest.name} needs ${name}@${range}, but the release declares ${existing}`,
          );
      }
    }
  }
  const manifest = Object.fromEntries(
    PUBLISHED_FIELDS.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]),
  );
  manifest.dependencies = dependencies;
  if (Object.keys(optionalDependencies).length > 0) manifest.optionalDependencies = optionalDependencies;
  return manifest;
}

/** Accepts exact pins and caret ranges, the only forms Pi declares for shared dependencies. */
function rangeAccepts(range, version) {
  if (range === version) return true;
  if (!range.startsWith("^")) return false;
  const floor = parseVersion(range.slice(1), `range ${range}`);
  const candidate = parseVersion(version, `version ${version}`);
  const sameLine = floor[0] > 0 ? candidate[0] === floor[0] : candidate[1] === floor[1] && candidate[0] === 0;
  return sameLine && compareVersions(candidate, floor) >= 0;
}

async function run(file, args, options = {}) {
  return await execute(file, args, { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024, ...options });
}

/** Builds the release and writes the exact directory that `npm pack` publishes. */
export async function stageRelease(outputDirectory, options = {}) {
  const source = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  await run("npm", ["run", "build:release"]);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(
    ["dist", "README.md", "LICENSE"].map((path) =>
      cp(join(repositoryRoot, path), join(outputDirectory, path), { recursive: true }),
    ),
  );
  const downloads = await mkdtemp(join(outputDirectory, ".vendor-"));
  const vendored = [];
  try {
    for (const name of VENDORED_PACKAGES) {
      const version = source.dependencies[name];
      parseVersion(version, `${name} dependency`);
      const packed = await run(
        "npm",
        [
          "pack",
          `${name}@${version}`,
          "--json",
          "--pack-destination",
          downloads,
          ...(options.npmCache ? ["--cache", options.npmCache] : []),
        ],
        { cwd: downloads },
      );
      const [report] = JSON.parse(packed.stdout.slice(packed.stdout.indexOf("[")));
      const destination = join(outputDirectory, "dist", "node_modules", ...name.split("/"));
      await mkdir(destination, { recursive: true });
      await run("tar", ["-xzf", join(downloads, report.filename), "-C", destination, "--strip-components=1"]);
      await rm(join(destination, "npm-shrinkwrap.json"), { force: true });
      const manifest = JSON.parse(await readFile(join(destination, "package.json"), "utf8"));
      if (manifest.name !== name || manifest.version !== version)
        throw new Error(`Vendored ${name} does not match the pinned ${version}`);
      vendored.push(manifest);
    }
  } finally {
    await rm(downloads, { recursive: true, force: true });
  }
  await writeFile(
    join(outputDirectory, "package.json"),
    `${JSON.stringify(publishedManifest(source, vendored), null, 2)}\n`,
  );
}
