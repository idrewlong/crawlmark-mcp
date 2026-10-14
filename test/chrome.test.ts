import { describe, expect, it } from "vitest";
import { chooseChromeBinary, looksLikeHeadlessShell, chooseChrome, systemChromeCandidates } from "../src/lib/chrome.js";

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

describe("chooseChromeBinary", () => {
  const shell = "/cache/shell/chrome-headless-shell";
  const withShell = { ...base, puppeteerShellPath: shell };
  it("prefers the headless shell over puppeteer's Chrome and a system Chrome", () => {
    expect(chooseChromeBinary({ ...withShell, chromePathEnv: undefined, exists: has(shell, "/cache/chrome", "/usr/bin/a") })).toEqual({ path: shell, kind: "headless-shell", isShell: true });
  });
  it("falls through to puppeteer's Chrome, then a system Chrome", () => {
    expect(chooseChromeBinary({ ...withShell, chromePathEnv: undefined, exists: has("/cache/chrome", "/usr/bin/a") })).toMatchObject({ path: "/cache/chrome", kind: "chrome", isShell: false });
    expect(chooseChromeBinary({ ...withShell, chromePathEnv: undefined, exists: has("/usr/bin/b") })).toMatchObject({ path: "/usr/bin/b", kind: "system-chrome", isShell: false });
  });
  it("CHROME_PATH beats the shell, and a shell-named override is treated as a shell", () => {
    expect(chooseChromeBinary({ ...withShell, chromePathEnv: "/x/chrome", exists: has(shell) })).toEqual({ path: "/x/chrome", kind: "chrome-path", isShell: false });
    expect(chooseChromeBinary({ ...withShell, chromePathEnv: "/x/headless_shell", exists: has() })).toMatchObject({ kind: "chrome-path", isShell: true });
  });
  it("recognises shell binary names", () => {
    expect(looksLikeHeadlessShell("/a/chrome-headless-shell")).toBe(true);
    expect(looksLikeHeadlessShell("C:\\a\\chrome-headless-shell.exe")).toBe(true);
    expect(looksLikeHeadlessShell("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")).toBe(false);
  });
});
