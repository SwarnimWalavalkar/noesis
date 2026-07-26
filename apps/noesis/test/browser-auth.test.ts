import { describe, expect, test, vi } from "vitest";
import {
  type BrowserProcessSpawner,
  browserOpenCommand,
  createAuthEventNotifier,
  createBrowserUrlOpener,
  presentAuthEvent,
} from "../src/browser-auth.ts";

function createProcess() {
  return {
    once: vi.fn(),
    unref: vi.fn(),
  };
}

describe("browser OAuth URL opening", () => {
  test.each([
    ["darwin", "open", ["https://auth.example/callback?state=abc"]],
    [
      "win32",
      "rundll32",
      [
        "url.dll,FileProtocolHandler",
        "https://auth.example/callback?state=abc",
      ],
    ],
    ["linux", "xdg-open", ["https://auth.example/callback?state=abc"]],
  ] as const)(
    "selects the platform browser opener on %s",
    (platform, command, args) => {
      expect(
        browserOpenCommand(platform, "https://auth.example/callback?state=abc"),
      ).toEqual({
        command,
        args,
      });
    },
  );

  test("passes an allowed URL as one argument without shell interpolation", () => {
    const child = createProcess();
    const spawnProcess = vi.fn<BrowserProcessSpawner>(() => child);
    const openUrl = createBrowserUrlOpener({
      platform: "darwin",
      spawnProcess,
    });

    expect(openUrl("https://auth.example/authorize?a=1&b=$(whoami)")).toBe(
      true,
    );
    expect(spawnProcess).toHaveBeenCalledWith(
      "open",
      ["https://auth.example/authorize?a=1&b=$(whoami)"],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    expect(child.once).toHaveBeenCalledWith("error", expect.any(Function));
    expect(child.unref).toHaveBeenCalledOnce();
  });

  test.each([
    "javascript:alert(1)",
    "file:///tmp/credential",
    "https://user:password@example.com",
    "not a URL",
  ])("rejects unsafe or invalid URL %s", (url) => {
    const spawnProcess = vi.fn<BrowserProcessSpawner>();
    const openUrl = createBrowserUrlOpener({ platform: "linux", spawnProcess });

    expect(openUrl(url)).toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  test("can be disabled for headless environments", () => {
    const spawnProcess = vi.fn<BrowserProcessSpawner>();
    const openUrl = createBrowserUrlOpener({
      enabled: false,
      platform: "darwin",
      spawnProcess,
    });

    expect(openUrl("https://auth.example/authorize")).toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  test("does not throw when the platform opener cannot be launched", () => {
    const openUrl = createBrowserUrlOpener({
      platform: "linux",
      spawnProcess: () => {
        throw new Error("ENOENT");
      },
    });

    expect(() => openUrl("https://auth.example/authorize")).not.toThrow();
    expect(openUrl("https://auth.example/authorize")).toBe(false);
  });

  test("handles an asynchronous missing-opener error without retaining the child", () => {
    let onError = (): void => {
      throw new Error("Missing error listener");
    };
    const child = {
      once: (_event: "error", listener: () => void) => {
        onError = listener;
      },
      unref: vi.fn(),
    };
    const openUrl = createBrowserUrlOpener({
      platform: "linux",
      spawnProcess: () => child,
    });

    expect(openUrl("https://auth.example/authorize")).toBe(true);
    expect(() => onError()).not.toThrow();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  test("prints the browser URL before attempting the best-effort launch", () => {
    const events: string[] = [];
    const notify = createAuthEventNotifier({
      writeLine: (message) => events.push(`print:${message}`),
      openUrl: (url) => {
        events.push(`open:${url}`);
        throw new Error("No opener");
      },
    });

    expect(() =>
      notify({
        type: "auth_url",
        url: "https://auth.example/authorize",
        instructions: "Complete login in your browser.",
      }),
    ).not.toThrow();
    expect(events).toEqual([
      "print:Open this URL in your browser:\nhttps://auth.example/authorize",
      "print:Complete login in your browser.",
      "open:https://auth.example/authorize",
    ]);
  });

  test("keeps device-code and progress notifications unchanged", () => {
    const messages: string[] = [];
    const openUrl = vi.fn();
    const notify = createAuthEventNotifier({
      writeLine: (message) => messages.push(message),
      openUrl,
    });

    notify({
      type: "device_code",
      verificationUri: "https://auth.example/device",
      userCode: "CODE-123",
    });
    notify({ type: "progress", message: "Waiting for authentication" });

    expect(messages).toEqual([
      "Open https://auth.example/device and enter code CODE-123.",
      "Waiting for authentication",
    ]);
    expect(openUrl).not.toHaveBeenCalled();
  });

  test("presentAuthEvent uses reference when the sink supports copy targets", () => {
    const notes: string[] = [];
    const references: Array<[string, string]> = [];
    const openUrl = vi.fn(() => false);

    presentAuthEvent(
      {
        type: "auth_url",
        url: "https://auth.example/authorize",
        instructions: "Complete login in your browser.",
      },
      {
        openUrl,
        note: (message) => notes.push(message),
        reference: (label, value) => references.push([label, value]),
      },
    );

    expect(openUrl).toHaveBeenCalledWith("https://auth.example/authorize");
    expect(notes).toEqual([
      "Finish sign-in in your browser.",
      "Complete login in your browser.",
    ]);
    expect(references).toEqual([
      ["Open this URL:", "https://auth.example/authorize"],
    ]);
  });
});
