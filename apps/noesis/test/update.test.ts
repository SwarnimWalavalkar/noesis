import { describe, expect, test, vi } from "vitest";
import { checkForUpdate, isNewerVersion, updateNoesis } from "../src/update.ts";

describe("Noesis updates", () => {
  test.each([
    ["0.0.10", "0.0.9", true],
    ["1.0.0", "0.99.99", true],
    ["1.0.0", "1.0.0", false],
    ["0.0.1", "0.0.2", false],
    ["1.0.0-beta.10", "1.0.0-beta.9", true],
    ["1.0.0-beta.1", "1.0.0", false],
    ["1.0.0", "1.0.0-beta.1", true],
    ["1.0.0-beta.1", "1.0.0-beta", true],
    ["1.0.0-beta", "1.0.0-beta.1", false],
    ["1.0.0-alpha", "1.0.0-1", true],
    ["1.0.0-01", "0.0.2", false],
    ["01.0.0", "0.0.2", false],
    ["garbage\u001b[2J", "0.0.2", false],
  ])("compares %s with %s", (candidate, current, newer) => {
    expect(isNewerVersion(candidate, current)).toBe(newer);
  });

  test.each([
    ["0.0.2", "latest", "0.0.3"],
    ["0.1.0-beta.1", "beta", "0.1.0-beta.2"],
  ])("checks the matching channel for %s", async (current, channel, version) => {
    const fetchRegistry = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ version }));
    expect(await checkForUpdate({ currentVersion: current, fetch: fetchRegistry, enabled: true })).toBe(
      `Update available: ${current} → ${version}. Run noesis update`,
    );
    expect(fetchRegistry).toHaveBeenCalledWith(
      `https://registry.npmjs.org/noesisai/${channel}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  test.each([{}, null, { version: 42 }, { version: "0.0.2" }, { version: "0.0.1" }, { version: "invalid" }])(
    "ignores non-update metadata %j",
    async (data) => {
      expect(
        await checkForUpdate({
          currentVersion: "0.0.2",
          enabled: true,
          fetch: async () => Response.json(data),
        }),
      ).toBeUndefined();
    },
  );

  test("stays silent when offline, on HTTP errors, or with invalid JSON", async () => {
    for (const fetchRegistry of [
      vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
      vi.fn<typeof fetch>().mockResolvedValue(new Response("no", { status: 503 })),
      vi.fn<typeof fetch>().mockResolvedValue(new Response("not JSON")),
    ]) {
      expect(await checkForUpdate({ fetch: fetchRegistry, enabled: true })).toBeUndefined();
    }
  });

  test("aborts a slow check", async () => {
    const fetchRegistry: typeof fetch = async (_url, init) =>
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
      });
    expect(await checkForUpdate({ fetch: fetchRegistry, enabled: true, timeoutMs: 5 })).toBeUndefined();
  });

  test("opt-out skips the network", async () => {
    const fetchRegistry = vi.fn<typeof fetch>();
    expect(await checkForUpdate({ fetch: fetchRegistry, enabled: false })).toBeUndefined();
    expect(fetchRegistry).not.toHaveBeenCalled();
  });

  test.each([
    ["0.0.2", "latest"],
    ["0.1.0-rc.1", "beta"],
  ])("updates %s globally on %s", async (currentVersion, channel) => {
    const run = vi.fn().mockResolvedValue(undefined);
    const writeLine = vi.fn();
    await updateNoesis({ currentVersion, run, writeLine });
    expect(run).toHaveBeenCalledExactlyOnceWith(["install", "--global", `noesisai@${channel}`]);
    expect(writeLine).toHaveBeenLastCalledWith("Noesis updated. Run noesis to start the installed version.");
  });

  test("does not claim success when installation fails", async () => {
    const writeLine = vi.fn();
    await expect(
      updateNoesis({
        run: async () => {
          throw new Error("permission denied");
        },
        writeLine,
      }),
    ).rejects.toThrow("permission denied");
    expect(writeLine).toHaveBeenCalledTimes(1);
  });
});
