import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Options as ChromeLauncherOptions } from "chrome-launcher";
import puppeteer, { type Browser, type HTTPResponse, type Page } from "puppeteer";
import { isUnsetValue } from "../lib/env.js";
import { type ChromeChoice, chooseChromeBinary, systemChromeCandidates } from "../lib/chrome.js";
import { BLOCKED_HEADER, egressProxy, proxyChromeFlags } from "../lib/egress-proxy.js";
import { onAbort, TIMEOUTS, withTimeout } from "../lib/timeout.js";
import { assertSafeUrl, UrlRefusedError } from "../lib/url-guard.js";

/**
 * Which browser binary Lighthouse, axe, rendering and PDF use: CHROME_PATH if set, else the
 * chrome-headless-shell puppeteer downloaded (no Dock icon on macOS), else the Chrome puppeteer
 * downloaded, else a system Chrome (the Claude Desktop bundle ships without one).
 */
export async function resolveChrome(): Promise<ChromeChoice> {
  return chooseChromeBinary({
    chromePathEnv: process.env.CHROME_PATH,
    puppeteerPath: await puppeteer.executablePath(),
    // With PUPPETEER_EXECUTABLE_PATH set, puppeteer's own path is that override, so don't offer (and label) the shell.
    puppeteerShellPath: isUnsetValue(process.env.PUPPETEER_EXECUTABLE_PATH) ? await puppeteer.executablePath({ headless: "shell" }).catch(() => undefined) : undefined,
    candidates: systemChromeCandidates(process.platform, process.env, homedir()),
    exists: existsSync,
  });
}

/** Just the path of resolveChrome(). */
export async function chromePath(): Promise<string> {
  return (await resolveChrome()).path;
}

/** Chrome's sandbox stays on unless it cannot work (Linux as root, typical in containers) or CHROME_NO_SANDBOX is set. */
export function needsNoSandbox(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  uid: number | undefined = process.getuid?.(),
): boolean {
  const v = (env.CHROME_NO_SANDBOX ?? "").trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  return platform === "linux" && uid === 0;
}

/**
 * Flags for every Chrome we start. No --headless here: puppeteer adds its own from the `headless`
 * launch option (see puppeteerBinaryOptions), and chrome-launcher gets it from headlessFlag().
 */
export const CHROME_FLAGS = [
  "--disable-gpu",
  "--disable-dev-shm-usage",
  ...(needsNoSandbox() ? ["--no-sandbox"] : []),
];

/** puppeteer launch options that match the binary: the shell needs `headless: "shell"`, full Chrome the new headless mode. */
export function puppeteerBinaryOptions(choice: ChromeChoice): { executablePath: string; headless: boolean | "shell" } {
  return { executablePath: choice.path, headless: choice.isShell ? "shell" : true };
}

/** chrome-launcher's headless flag: the shell is always headless (plain --headless is accepted), full Chrome uses the new mode. */
export function headlessFlag(choice: ChromeChoice): string {
  return choice.isShell ? "--headless" : "--headless=new";
}

/** CHROME_FLAGS plus the egress-proxy flags. Every Chrome we start (puppeteer and chrome-launcher) uses these. */
export async function guardedChromeFlags(): Promise<string[]> {
  const { port } = await egressProxy();
  return [...CHROME_FLAGS, ...proxyChromeFlags(port)];
}

/**
 * Chrome profile prefs for every browser we start. WebRTC's UDP (STUN/ICE) cannot go through the HTTP proxy,
 * so it is restricted twice: this profile pref and the --force-webrtc-ip-handling-policy flag (proxyChromeFlags).
 * Both are required: full Chrome ignores --force-webrtc-ip-handling-policy and honours only the profile pref; chrome-headless-shell ignores the profile pref and honours only the flag. Removing either one reopens SEC-1 for one of the binaries.
 */
export const CHROME_PREFS = { webrtc: { ip_handling_policy: "disable_non_proxied_udp" } } as const;

/** chrome-launcher options for Lighthouse: proxy flags plus CHROME_PREFS (chrome-launcher writes them to its temp profile). */
export async function lighthouseLaunchOptions(): Promise<ChromeLauncherOptions> {
  const choice = await resolveChrome();
  return { chromePath: choice.path, chromeFlags: [headlessFlag(choice), ...(await guardedChromeFlags())], prefs: { ...CHROME_PREFS, webrtc: { ...CHROME_PREFS.webrtc } } };
}

/** Close functions of every browser currently open, so shutdown can close them all. */
const openBrowsers = new Set<() => Promise<void>>();

/** Close every browser started through withChrome/withBrowser (process shutdown). */
export async function closeAllBrowsers(): Promise<void> {
  await Promise.all([...openBrowsers].map((close) => close()));
}

/**
 * Launch a resource (a browser), run `work` on it, and always close it: on success,
 * on error, after TIMEOUTS.browserMs, or as soon as `signal` aborts (a tool-level
 * timeout or the MCP client cancelling). Close errors are logged, not thrown.
 */
export async function withChrome<R, T>(
  label: string,
  signal: AbortSignal | undefined,
  launch: () => Promise<R>,
  close: (r: R) => unknown,
  work: (r: R) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  // Registered before launch() settles: a shutdown or abort during the launch still closes
  // the browser once it arrives (closeOnce waits for the launch).
  const launching = launch();
  launching.catch(() => undefined);
  let closing: Promise<void> | undefined;
  const closeOnce = () =>
    (closing ??= (async () => {
      let resource: R;
      try {
        resource = await launching;
      } catch {
        return; // the launch failed: nothing to close
      }
      try {
        await close(resource);
      } catch (err) {
        console.error(`crawlmark: closing the browser for ${label} failed: ${(err as Error).message}`);
      }
    })());
  openBrowsers.add(closeOnce);
  const off = onAbort(signal, () => void closeOnce());
  try {
    const resource = await launching;
    if (closing) throw new Error(`${label} was cancelled while the browser was starting`);
    return await withTimeout(work(resource), TIMEOUTS.browserMs, label, closeOnce);
  } catch (err) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : err;
    throw err;
  } finally {
    off();
    await closeOnce();
    openBrowsers.delete(closeOnce);
  }
}

/**
 * Start puppeteer's Chrome behind the egress proxy, with a fresh temp profile that
 * carries CHROME_PREFS. `close` shuts Chrome and deletes the profile.
 */
export async function launchGuardedBrowser(): Promise<{ browser: Browser; close: () => Promise<void> }> {
  const args = await guardedChromeFlags();
  const choice = await resolveChrome();
  const userDataDir = await mkdtemp(join(tmpdir(), "crawlmark-chrome-"));
  const removeProfile = () => rm(userDataDir, { recursive: true, force: true, maxRetries: 3 });
  try {
    await mkdir(join(userDataDir, "Default"));
    await writeFile(join(userDataDir, "Default", "Preferences"), JSON.stringify(CHROME_PREFS));
    const browser = await puppeteer.launch({ ...puppeteerBinaryOptions(choice), args, userDataDir });
    return {
      browser,
      close: async () => {
        try {
          await browser.close();
        } finally {
          await removeProfile();
        }
      },
    };
  } catch (err) {
    await removeProfile();
    throw err;
  }
}

/** Puppeteer variant of withChrome, launched behind the egress proxy with CHROME_PREFS. */
export async function withBrowser<T>(label: string, signal: AbortSignal | undefined, work: (browser: Browser) => Promise<T>): Promise<T> {
  return withChrome(label, signal, launchGuardedBrowser, (b) => b.close(), (b) => work(b.browser));
}

/** Throw a clear error when a navigation was answered by the egress proxy's refusal rather than the site. */
export function assertNotProxyBlocked(res: HTTPResponse | null, url: string): void {
  if (res?.headers()[BLOCKED_HEADER]) {
    throw new UrlRefusedError(`Refusing ${url}: the page or a redirect leads to a private or loopback address.`);
  }
}

/**
 * Defence in depth on top of the egress proxy (which is the real control): every
 * http(s) request a page makes is checked against the literal-host guard and aborted
 * early, with a clear BLOCKED_BY_CLIENT error, before it reaches the proxy. It cannot
 * see WebSockets or resolve DNS; the proxy covers those.
 */
export async function guardPage(page: Page, check: (url: string) => unknown = (u) => assertSafeUrl(u)): Promise<void> {
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (req.isInterceptResolutionHandled()) return;
    const url = req.url();
    if (!/^https?:/i.test(url)) return void req.continue();
    try {
      check(url);
    } catch {
      return void req.abort("blockedbyclient");
    }
    void req.continue();
  });
}
