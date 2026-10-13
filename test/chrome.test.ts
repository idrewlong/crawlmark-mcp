import { describe, expect, it } from "vitest";
import { chooseChrome, systemChromeCandidates } from "../src/lib/chrome.js";

const base = { puppeteerPath: "/cache/chrome", candidates: ["/usr/bin/a", "/usr/bin/b"] };
const has = (...paths: string[]) => (p: string) => paths.includes(p);

describe("chooseChrome", () => {
  it("CHROME_PATH wins, even if the file is not checked", () => {
    expect(chooseChrome({ ...base, chromePathEnv: "/custom/chrome", exists: has("/cache/chrome") })).toBe("/custom/chrome");
  });
  it("then puppeteer's downloaded Chrome", () => {
    expect(chooseChrome({ ...base, chromePathEnv: undefined, exists: has("/cache/chrome", "/usr/bin/a") })).toBe("/cache/chrome");
  });
  it("then the first system Chrome that exists (the Claude Desktop bundle ships without one)", () => {
    expect(chooseChrome({ ...base, chromePathEnv: " ", exists: has("/usr/bin/b") })).toBe("/usr/bin/b");
  });
  it("a leftover ${user_config.chrome_path} placeholder counts as unset, so the system Chrome is still found", () => {
    expect(chooseChrome({ ...base, chromePathEnv: "${user_config.chrome_path}", exists: has("/usr/bin/a") })).toBe("/usr/bin/a");
  });
  it("falls back to puppeteer's path so the launch error names the missing download", () => {
    expect(chooseChrome({ ...base, chromePathEnv: undefined, exists: has() })).toBe("/cache/chrome");
  });
});

describe("systemChromeCandidates", () => {
  it("lists the usual locations per platform", () => {
    expect(systemChromeCandidates("darwin", {}, "/Users/u")[0]).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(systemChromeCandidates("linux", {}, "/home/u")).toContain("/usr/bin/google-chrome");
    const win = systemChromeCandidates("win32", { PROGRAMFILES: "C:\\Program Files" }, "C:\\Users\\u");
    expect(win).toHaveLength(1);
    expect(win[0]).toContain("chrome.exe");
  });
});
