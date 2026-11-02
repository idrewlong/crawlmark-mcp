/**
 * Release 0.5.0 (C4, decision C-D2): when a crawled page says it was published. Pure; run in the extraction worker.
 * First valid source wins:
 *   1. JSON-LD `datePublished` on an Article, BlogPosting, NewsArticle, TechArticle, Report or WebPage
 *   2. `article:published_time` meta tag, then `<time itemprop="datePublished" datetime>`
 *   3. a `/YYYY/` (optionally `/YYYY/MM/`) segment in the address
 * Never used: `dateModified`, a sitemap `lastmod`, HTTP `Last-Modified`. The sitemap and the response headers are not
 * parameters here on purpose: this function cannot see them.
 */
import type { CheerioAPI } from "cheerio";
import type { PublishedDate } from "./crawl.js";

export const MAX_JSONLD_SCRIPTS = 20;
export const MAX_JSONLD_CHARS = 100_000;
/** Levels of nesting read in a JSON-LD document (the root object is level 1; arrays do not count). */
export const MAX_JSONLD_DEPTH = 4;
export const FIRST_PUBLISH_YEAR = 1995;
const DAY_MS = 86_400_000;
const PUBLISHED_TYPES = new Set(["article", "blogposting", "newsarticle", "techarticle", "report", "webpage"]);

/** `YYYY-MM-DD` from an ISO-style value ("2023-04-02", "2023-04-02T10:00:00Z"), or null when it is not a real date or lies in the future. */
function isoDay(value: unknown, now: number): string | null {
  if (typeof value !== "string") return null;
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  if (y < FIRST_PUBLISH_YEAR || ms > now + DAY_MS) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

const isType = (t: unknown): boolean => (Array.isArray(t) ? t : [t]).some((x) => typeof x === "string" && PUBLISHED_TYPES.has(x.toLowerCase()));

/** Breadth-first through objects and arrays (arrays are transparent), at most MAX_JSONLD_DEPTH object levels. */
function jsonLdDate(root: unknown, now: number): string | null {
  let level: unknown[] = [root];
  for (let depth = 1; depth <= MAX_JSONLD_DEPTH && level.length; depth++) {
    const objects: Record<string, unknown>[] = [];
    const queue = [...level];
    while (queue.length) {
      const v = queue.shift();
      if (Array.isArray(v)) queue.unshift(...v);
      else if (v && typeof v === "object") objects.push(v as Record<string, unknown>);
    }
    for (const o of objects) {
      if (isType(o["@type"])) {
        const day = isoDay(o["datePublished"], now);
        if (day) return day;
      }
    }
    level = objects.flatMap((o) => Object.values(o));
  }
  return null;
}

function fromUrl(url: string, now: number): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = /\/(199[5-9]|20\d\d)\/(?:(0[1-9]|1[0-2])(?:\/|$))?/.exec(path);
  if (!m) return null;
  if (Date.UTC(Number(m[1]), 0, 1) > now + DAY_MS) return null;
  return m[2] ? `${m[1]}-${m[2]}` : m[1]!;
}

export function extractPublished($: CheerioAPI, url: string): PublishedDate | null {
  const now = Date.now();

  const scripts = $('script[type="application/ld+json"]').slice(0, MAX_JSONLD_SCRIPTS).toArray();
  for (const el of scripts) {
    const text = $(el).text();
    if (text.length > MAX_JSONLD_CHARS) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const day = jsonLdDate(parsed, now);
    if (day) return { date: day, source: "jsonld" };
  }

  const metaDay = isoDay($('meta[property="article:published_time"]').first().attr("content"), now) ?? isoDay($('time[itemprop="datePublished"][datetime]').first().attr("datetime"), now);
  if (metaDay) return { date: metaDay, source: "meta" };

  const fromAddress = fromUrl(url, now);
  return fromAddress ? { date: fromAddress, source: "url" } : null;
}
