import type { LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline, type Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { cached, cacheKey, TTL } from "../lib/cache.js";
import { onAbort } from "../lib/timeout.js";
import { assertSafeUrlResolved, pinnedLookup } from "../lib/url-guard.js";
import { compareRender, type RenderFlag } from "../analysis/render.js";
import { extractIsolated } from "../analysis/extract-isolated.js";
import type { SeoExtract } from "../analysis/render-extract.js";
import { assertNotProxyBlocked, guardPage, withBrowser } from "./browser.js";

export const GOOGLEBOT_UA =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/120.0.0.0 Safari/537.36";
const RAW_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const NAV_TIMEOUT_MS = 60_000; // inside the 90s browser limit (TIMEOUTS.browserMs)

export interface RawFetch {
  status: number;
  finalUrl: string;
  redirects: number;
  contentType: string | null;
  xRobotsTag: string | null;
  /** The `Link` response header(s), comma-joined. Absent in responses cached before this field existed. */
  link?: string | null;
  /** True when the body was cut at the size cap. */
  truncated: boolean;
  html: string;
}

export interface RenderedFetch {
  status: number | null;
  finalUrl: string;
  html: string;
}

/** Read a body stream up to MAX_BODY_BYTES. */
async function readCapped(body: Readable): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    const room = MAX_BODY_BYTES - size;
    if (chunk.byteLength > room) {
      chunks.push(chunk.subarray(0, room));
      size += room;
      truncated = true;
      break;
    }
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  body.destroy();
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

/** A 200 response for a `.gz` path that is not an HTML error page: the body is a gzip file to decompress ourselves. */
function isGzipFile(url: string, status: number, contentType: string | null): boolean {
  try {
    return status === 200 && /\.gz$/i.test(new URL(url).pathname) && !/html/i.test(contentType ?? "");
  } catch {
    return false;
  }
}

/** Decode gzip/deflate/br like fetch would; other encodings are passed through. */
function decoded(res: IncomingMessage, gzFile = false): Readable {
  const enc = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
  const decoder =
    enc === "gzip" || enc === "x-gzip"
      ? createGunzip()
      : enc === "deflate"
        ? createInflate()
        : enc === "br"
          ? createBrotliDecompress()
          : gzFile
            ? createGunzip() // a .xml.gz file served as-is (no Content-Encoding): the size cap then applies after decompression
            : undefined;
  return decoder ? pipeline(res, decoder, () => undefined) : res;
}

const header = (res: IncomingMessage, name: string): string | null => {
  const v = res.headers[name];
  return v == null ? null : Array.isArray(v) ? v.join(", ") : v;
};

/** One GET, connected only to the vetted `addresses` (no second DNS lookup, so no rebinding). */
function getPinned(url: URL, addresses: LookupAddress[], signal: AbortSignal): Promise<IncomingMessage> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, {
      method: "GET",
      agent: false,
      lookup: pinnedLookup(addresses),
      signal,
      headers: {
        "user-agent": GOOGLEBOT_UA,
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "accept-encoding": "gzip, deflate, br",
      },
    });
    req.once("response", resolve);
    req.once("error", reject);
    req.end();
  });
}

/**
 * Plain HTTP fetch as a crawler sees it. Redirects are followed by hand: each hop is
 * resolved, every address checked (assertSafeUrlResolved), and the connection pinned
 * to those addresses.
 */
export async function fetchRaw(url: string, opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<RawFetch> {
  await assertSafeUrlResolved(url);
  const { value } = await cached(cacheKey("render-raw", url), TTL.day, async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), RAW_TIMEOUT_MS);
    const off = onAbort(opts.signal, () => ctrl.abort());
    try {
      let current = url;
      for (let redirects = 0; ; redirects++) {
        const { url: target, addresses } = await assertSafeUrlResolved(current);
        const res = await getPinned(target, addresses, ctrl.signal);
        const location = header(res, "location");
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && location) {
          res.destroy();
          if (redirects >= MAX_REDIRECTS) throw new Error(`Too many redirects fetching ${url}`);
          current = new URL(location, current).toString();
          continue;
        }
        const { text, truncated } = await readCapped(decoded(res, isGzipFile(current, status, header(res, "content-type"))));
        return {
          status,
          finalUrl: current,
          redirects,
          contentType: header(res, "content-type"),
          xRobotsTag: header(res, "x-robots-tag"),
          link: header(res, "link"),
          truncated,
          html: text,
        } satisfies RawFetch;
      }
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : err;
      if (ctrl.signal.aborted) throw new Error(`Raw fetch of ${url} timed out after ${RAW_TIMEOUT_MS / 1000}s`);
      throw err;
    } finally {
      clearTimeout(timer);
      off();
    }
  }, { refresh: opts.refresh });
  return value;
}

/** The DOM after JavaScript has run, from headless Chrome behind the egress proxy. */
export async function fetchRendered(url: string, opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<RenderedFetch> {
  await assertSafeUrlResolved(url);
  const { value } = await cached(cacheKey("render-dom", url), TTL.day, () =>
    withBrowser(`Rendered fetch of ${url}`, opts.signal, async (browser) => {
      const page = await browser.newPage();
      await guardPage(page);
      page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
      await page.setUserAgent({ userAgent: GOOGLEBOT_UA });
      const res = await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
      assertNotProxyBlocked(res, url);
      const html = await page.content();
      // Measured in Node: page JS cannot spoof it, and the DOM may have grown since any in-page check.
      if (html.length > MAX_BODY_BYTES) throw new Error(`Rendered DOM is ${html.length} characters, over the ${MAX_BODY_BYTES} cap`);
      return { status: res?.status() ?? null, finalUrl: page.url(), html } satisfies RenderedFetch;
    }),
  { refresh: opts.refresh });
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
export async function checkRender(url: string, opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<RenderCheck> {
  await assertSafeUrlResolved(url);
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
