import { join } from "node:path";
import { isUnsetValue } from "./env.js";

/** Well-known install locations of a system Chrome/Chromium, in preference order. Pure. */
export function systemChromeCandidates(platform: NodeJS.Platform, env: Record<string, string | undefined>, userHome: string): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      join(userHome, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  if (platform === "win32") {
    return [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]
      .filter((b): b is string => Boolean(b))
      .map((b) => join(b, "Google", "Chrome", "Application", "chrome.exe"));
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
}

export interface ChromeChoiceInputs {
  chromePathEnv: string | undefined;
  /** puppeteer's own (downloaded) Chrome path. */
  puppeteerPath: string;
  /** puppeteer's downloaded chrome-headless-shell path, when known. */
  puppeteerShellPath?: string;
  candidates: string[];
  exists: (p: string) => boolean;
}

/** Which kind of binary is in use: the headless shell (no Dock icon on macOS), a full Chrome, or the CHROME_PATH override. */
export type ChromeKind = "headless-shell" | "chrome" | "system-chrome" | "chrome-path";

export interface ChromeChoice {
  path: string;
  kind: ChromeKind;
  /** True when the binary is chrome-headless-shell, which only runs headless and takes puppeteer's `headless: "shell"`. */
  isShell: boolean;
}

/** chrome-headless-shell binaries are named chrome-headless-shell (new) or headless_shell (older builds, distro packages). */
export function looksLikeHeadlessShell(path: string): boolean {
  return /(^|[\\/])(chrome-headless-shell|headless_shell)(\.exe)?$/i.test(path.trim());
}

/**
 * Which Chrome to run: CHROME_PATH, then the headless shell puppeteer downloaded (no Dock icon on macOS,
 * lighter), then the Chrome puppeteer downloaded, then a system Chrome, else puppeteer's Chrome path
 * (so the error names the missing download). A bundle or an install with PUPPETEER_SKIP_DOWNLOAD relies on the system Chrome.
 */
export function chooseChromeBinary(i: ChromeChoiceInputs): ChromeChoice {
  if (!isUnsetValue(i.chromePathEnv)) {
    const path = i.chromePathEnv!.trim();
    return { path, kind: "chrome-path", isShell: looksLikeHeadlessShell(path) };
  }
  if (i.puppeteerShellPath && i.exists(i.puppeteerShellPath)) return { path: i.puppeteerShellPath, kind: "headless-shell", isShell: true };
  if (i.exists(i.puppeteerPath)) return { path: i.puppeteerPath, kind: "chrome", isShell: false };
  const system = i.candidates.find((c) => i.exists(c));
  if (system) return { path: system, kind: "system-chrome", isShell: false };
  return { path: i.puppeteerPath, kind: "chrome", isShell: false };
}

/** The path alone (see chooseChromeBinary). */
export function chooseChrome(i: ChromeChoiceInputs): string {
  return chooseChromeBinary(i).path;
}

/** Plain-language name of a ChromeKind for setup_status. */
export function chromeKindLabel(kind: ChromeKind): string {
  return { "headless-shell": "headless shell", chrome: "Chrome (puppeteer)", "system-chrome": "system Chrome", "chrome-path": "CHROME_PATH" }[kind];
}
