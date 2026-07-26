import { type ChildProcess, spawn } from "node:child_process";
import type { NoesisAuthEvent } from "@noesis/runtime-pi";

export interface BrowserOpenCommand {
  readonly command: string;
  readonly args: readonly string[];
}

interface BrowserProcess {
  once(event: "error", listener: () => void): unknown;
  unref(): void;
}

export type BrowserProcessSpawner = (
  command: string,
  args: readonly string[],
  options: {
    readonly detached: true;
    readonly stdio: "ignore";
    readonly windowsHide: true;
  },
) => BrowserProcess;

export type BrowserUrlOpener = (url: string) => boolean;

const spawnBrowserProcess: BrowserProcessSpawner = (command, args, options): ChildProcess =>
  spawn(command, args, options);

export function browserOpenCommand(platform: NodeJS.Platform, url: string): BrowserOpenCommand | undefined {
  if (platform === "darwin") return Object.freeze({ command: "open", args: Object.freeze([url]) });
  if (platform === "win32")
    return Object.freeze({
      command: "rundll32",
      args: Object.freeze(["url.dll,FileProtocolHandler", url]),
    });
  if (platform === "linux") return Object.freeze({ command: "xdg-open", args: Object.freeze([url]) });
  return undefined;
}

function browserSafeUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    if (parsed.username || parsed.password) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

export function createBrowserUrlOpener(
  options: {
    readonly enabled?: boolean;
    readonly platform?: NodeJS.Platform;
    readonly spawnProcess?: BrowserProcessSpawner;
  } = {},
): BrowserUrlOpener {
  const enabled = options.enabled ?? true;
  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawnProcess ?? spawnBrowserProcess;

  return (value) => {
    if (!enabled) return false;
    const url = browserSafeUrl(value);
    if (!url) return false;
    const invocation = browserOpenCommand(platform, url);
    if (!invocation) return false;

    try {
      const child = spawnProcess(invocation.command, invocation.args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", () => {
        // The printed URL remains the fallback when no browser opener is installed.
      });
      child.unref();
      return true;
    } catch {
      return false;
    }
  };
}

export function createAuthEventNotifier(options: {
  readonly openUrl: BrowserUrlOpener;
  readonly writeLine: (message: string) => void;
}): (event: NoesisAuthEvent) => void {
  return (event) => {
    if (event.type === "auth_url") {
      options.writeLine(`Open this URL in your browser:\n${event.url}`);
      if (event.instructions) options.writeLine(event.instructions);
      try {
        options.openUrl(event.url);
      } catch {
        // Authentication remains usable through the URL printed above.
      }
      return;
    }
    if (event.type === "device_code") {
      options.writeLine(`Open ${event.verificationUri} and enter code ${event.userCode}.`);
      return;
    }
    options.writeLine(event.message);
  };
}
