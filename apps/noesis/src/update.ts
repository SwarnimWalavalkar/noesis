import { spawn } from "node:child_process";
import manifest from "../../../package.json" with { type: "json" };

export const NOESIS_VERSION = manifest.version;

function versionParts(value: string): readonly string[] | undefined {
  if (value.length > 256) return undefined;
  const match =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(
      value,
    );
  if (!match || match[4]?.split(".").some((part) => /^0[0-9]+$/u.test(part))) return undefined;
  return [...match.slice(1, 4), ...(match[4]?.split(".") ?? [])];
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = versionParts(candidate);
  const previous = versionParts(current);
  if (!next || !previous) return false;
  for (let index = 0; index < Math.max(next.length, previous.length); index += 1) {
    const left = next[index];
    const right = previous[index];
    if (left === right) continue;
    if (left === undefined) return index === 3;
    if (right === undefined) return index !== 3;
    const leftNumeric = /^[0-9]+$/u.test(left);
    const rightNumeric = /^[0-9]+$/u.test(right);
    if (leftNumeric && rightNumeric) return BigInt(left) > BigInt(right);
    if (leftNumeric !== rightNumeric) return !leftNumeric;
    return left > right;
  }
  return false;
}

export function updateChannel(version: string): "latest" | "beta" {
  return version.includes("-") ? "beta" : "latest";
}

/** Best-effort, process-local information only; startup never waits for the registry. */
export async function checkForUpdate(
  options: {
    readonly currentVersion?: string;
    readonly fetch?: typeof fetch;
    readonly enabled?: boolean;
    readonly timeoutMs?: number;
  } = {},
): Promise<string | undefined> {
  if (!(options.enabled ?? process.env["NOESIS_NO_UPDATE_CHECK"] !== "1")) return undefined;
  const current = options.currentVersion ?? NOESIS_VERSION;
  try {
    const response = await (options.fetch ?? fetch)(
      `https://registry.npmjs.org/noesisai/${updateChannel(current)}`,
      { signal: AbortSignal.timeout(options.timeoutMs ?? 3_000), headers: { accept: "application/json" } },
    );
    if (!response.ok) return undefined;
    const data: unknown = await response.json();
    if (typeof data !== "object" || data === null || !("version" in data) || typeof data.version !== "string")
      return undefined;
    if (!isNewerVersion(data.version, current)) return undefined;
    return `Update available: ${current} → ${data.version}. Run noesis update`;
  } catch {
    return undefined;
  }
}

/** Explicit CLI action, independent of the agent runtime and workspace. */
export async function updateNoesis(
  options: {
    readonly currentVersion?: string;
    readonly run?: (args: readonly string[]) => Promise<void>;
    readonly writeLine?: (message: string) => void;
  } = {},
): Promise<void> {
  const channel = updateChannel(options.currentVersion ?? NOESIS_VERSION);
  const args = ["install", "--global", `noesisai@${channel}`];
  const writeLine = options.writeLine ?? console.log;
  writeLine(`Updating Noesis (${channel})…`);
  await (options.run ?? runNpm)(args);
  writeLine("Noesis updated. Run noesis to start the installed version.");
}

async function runNpm(args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // Windows npm is a command shim; all arguments here are fixed application literals.
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", (error) => reject(new Error(`Could not run npm: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Noesis update failed (${signal ?? `npm exit ${String(code)}`}). Check the npm output above and retry noesis update.`,
          ),
        );
    });
  });
}
