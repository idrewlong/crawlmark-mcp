import puppeteer, { type Page } from "puppeteer";
import { assertSafeUrl } from "../lib/url-guard.js";

/**
 * Chrome path shared by Lighthouse and axe. Uses CHROME_PATH if set,
 * otherwise the Chrome that puppeteer downloaded on install.
 */
export async function chromePath(): Promise<string> {
  return process.env.CHROME_PATH || (await puppeteer.executablePath());
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

export const CHROME_FLAGS = [
  "--headless=new",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  ...(needsNoSandbox() ? ["--no-sandbox"] : []),
];

/**
 * Interim SSRF guard for headless Chrome: every http(s) request the page makes
 * (navigation, redirect hops, subresources) must pass the URL guard, otherwise it
 * is aborted. Other schemes (data:, blob:, about:) cannot reach the network.
 * Phase 6d replaces the literal-host check with resolved-address checks.
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
