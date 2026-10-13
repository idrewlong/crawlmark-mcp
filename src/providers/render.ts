import puppeteer from "puppeteer";
import { cached, cacheKey, TTL } from "../lib/cache.js";
import { assertSafeUrl } from "../lib/url-guard.js";
import { compareRender, type RenderFlag } from "../analysis/render.js";
import { extractIsolated } from "../analysis/extract-isolated.js";
import type { SeoExtract } from "../analysis/render-extract.js";
import { CHROME_FLAGS, chromePath, guardPage } from "./browser.js";

export const GOOGLEBOT_UA =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/120.0.0.0 Safari/537.36";
const RAW_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const NAV_TIMEOUT_MS = 60_000;

export interface RawFetch {
  status: number;
  finalUrl: string;
  redirects: number;
  contentType: string | null;
  xRobotsTag: string | null;
  /** True when the body was cut at the size cap. */
  truncated: boolean;
  html: string;
}

export interface RenderedFetch {
  status: number | null;
  finalUrl: string;
  html: string;
}

async function readCapped(res: Response): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = MAX_BODY_BYTES - size;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      size += room;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

/** Plain HTTP fetch as a crawler sees it. Redirects are followed by hand so each hop passes the URL guard. */
export async function fetchRaw(url: string, opts: { refresh?: boolean } = {}): Promise<RawFetch> {
  assertSafeUrl(url);
  const { value } = await cached(cacheKey("render-raw", url), TTL.day, async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), RAW_TIMEOUT_MS);
    try {
      let current = url;
      for (let redirects = 0; ; redirects++) {
        assertSafeUrl(current);
        const res = await fetch(current, {
          redirect: "manual",
          signal: ctrl.signal,
          headers: { "user-agent": GOOGLEBOT_UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
        });
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
          await res.body?.cancel();
          if (redirects >= MAX_REDIRECTS) throw new Error(`Too many redirects fetching ${url}`);
          current = new URL(location, current).toString();
          continue;
        }
        const { text, truncated } = await readCapped(res);
        return {
          status: res.status,
          finalUrl: current,
          redirects,
          contentType: res.headers.get("content-type"),
          xRobotsTag: res.headers.get("x-robots-tag"),
          truncated,
          html: text,
        } satisfies RawFetch;
      }
    } catch (err) {
      if (ctrl.signal.aborted) throw new Error(`Raw fetch of ${url} timed out after ${RAW_TIMEOUT_MS / 1000}s`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }, opts);
  return value;
}

/** The DOM after JavaScript has run, from headless Chrome. */
export async function fetchRendered(url: string, opts: { refresh?: boolean } = {}): Promise<RenderedFetch> {
  assertSafeUrl(url);
  const { value } = await cached(cacheKey("render-dom", url), TTL.day, async () => {
    const browser = await puppeteer.launch({ executablePath: await chromePath(), args: CHROME_FLAGS });
    try {
      const page = await browser.newPage();
      await guardPage(page);
      page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
      await page.setUserAgent({ userAgent: GOOGLEBOT_UA });
      const res = await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
      const html = await page.content();
      // Measured in Node: page JS cannot spoof it, and the DOM may have grown since any in-page check.
      if (html.length > MAX_BODY_BYTES) throw new Error(`Rendered DOM is ${html.length} characters, over the ${MAX_BODY_BYTES} cap`);
      return { status: res?.status() ?? null, finalUrl: page.url(), html } satisfies RenderedFetch;
    } finally {
      await browser.close();
    }
  }, opts);
  return value;
}

export interface RenderCheck {
  url: string;
  raw: Omit<RawFetch, "html"> & { seo: SeoExtract };
  rendered: Omit<RenderedFetch, "html"> & { seo: SeoExtract };
  flags: RenderFlag[];
  /** Caveats about the comparison, e.g. a truncated raw body. */
  notes: string[];
}

/** True for HTML responses; a missing content-type is given the benefit of the doubt. */
const isHtml = (contentType: string | null) => contentType == null || /html/i.test(contentType);

/** Fetch both versions, extract, and compare. Throws (so the audit section fails) unless both are usable HTML pages. */
export async function checkRender(url: string, opts: { refresh?: boolean } = {}): Promise<RenderCheck> {
  assertSafeUrl(url);
  const [raw, rendered] = await Promise.all([fetchRaw(url, opts), fetchRendered(url, opts)]);
  if (raw.status >= 400) throw new Error(`Raw fetch of ${url} returned HTTP ${raw.status}; nothing to compare`);
  if (rendered.status != null && rendered.status >= 400) throw new Error(`Rendered fetch of ${url} returned HTTP ${rendered.status}; nothing to compare`);
  if (!isHtml(raw.contentType)) throw new Error(`Raw response for ${url} is ${raw.contentType}, not HTML; nothing to compare`);

  const { html: rawHtml, ...rawMeta } = raw;
  const { html: renHtml, ...renMeta } = rendered;
  const [rawSeo, renSeo] = await Promise.all([extractIsolated(rawHtml, raw.finalUrl), extractIsolated(renHtml, rendered.finalUrl)]);
  const notes: string[] = [];
  if (raw.truncated) notes.push("Raw body was cut at the size cap, so the word-count comparison was skipped.");
  return {
    url,
    raw: { ...rawMeta, seo: rawSeo },
    rendered: { ...renMeta, seo: renSeo },
    flags: compareRender(rawSeo, renSeo, { rawTruncated: raw.truncated }),
    notes,
  };
}
