/**
 * A Chrome that fails to start can leave its profile locked on Windows (EBUSY). The launch error must still be the
 * one reported, not the cleanup error. puppeteer and fs/promises are mocked: no browser starts.
 */
import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ launch: vi.fn(), rm: vi.fn() }));

vi.mock("puppeteer", () => ({ default: { launch: m.launch, executablePath: async () => process.execPath } }));
// Any existing file will do as the "Chrome" binary: launch is mocked.
process.env.CHROME_PATH = process.execPath;
vi.mock("node:fs/promises", async (orig) => ({ ...(await orig<typeof import("node:fs/promises")>()), rm: m.rm }));

const { launchGuardedBrowser } = await import("../src/providers/browser.js");

describe("launchGuardedBrowser cleanup", () => {
  it("reports the launch error when removing the profile also fails", async () => {
    m.launch.mockRejectedValue(new Error("Timed out after 30000 ms while waiting for the WS endpoint URL to appear in stdout!"));
    m.rm.mockRejectedValue(Object.assign(new Error("EBUSY: resource busy or locked, unlink 'first_party_sets.db'"), { code: "EBUSY" }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(launchGuardedBrowser()).rejects.toThrow(/WS endpoint/);
    expect(m.rm).toHaveBeenCalledWith(expect.stringContaining("crawlmark-chrome-"), expect.objectContaining({ recursive: true, force: true, maxRetries: 10 }));
    expect(logged.mock.calls.flat().join(" ")).toMatch(/couldn't remove the Chrome profile .*EBUSY/);
    logged.mockRestore();
  });

  it("still reports the launch error when the profile is removed", async () => {
    m.launch.mockRejectedValue(new Error("Failed to launch the browser process!"));
    m.rm.mockResolvedValue(undefined);
    await expect(launchGuardedBrowser()).rejects.toThrow(/Failed to launch/);
  });
});
