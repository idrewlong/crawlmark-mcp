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
  candidates: string[];
  exists: (p: string) => boolean;
}

/**
 * Which Chrome to run: CHROME_PATH, then the Chrome puppeteer downloaded (if the file is there),
 * then a system Chrome, else puppeteer's path (so the error names the missing download).
 * A bundle or an install with PUPPETEER_SKIP_DOWNLOAD relies on the system Chrome.
 */
export function chooseChrome(i: ChromeChoiceInputs): string {
  if (!isUnsetValue(i.chromePathEnv)) return i.chromePathEnv!.trim();
  if (i.exists(i.puppeteerPath)) return i.puppeteerPath;
  return i.candidates.find((c) => i.exists(c)) ?? i.puppeteerPath;
}
