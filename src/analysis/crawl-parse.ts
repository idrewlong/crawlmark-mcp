import * as cheerio from "cheerio";
import { assertParseable } from "./render-extract.js";

/** Most links kept per page; a page with more is noted, and the crawl can't call itself exhaustive. */
export const MAX_LINKS_PER_PAGE = 2000;

/** What the local crawler needs from one HTML page (Phase 12 C1). Pure; run in the extraction worker. */
export interface CrawlPageExtract {
  title: string | null;
  description: string | null;
  /** Absolute canonical URL, or null. */
  canonical: string | null;
  /** meta robots (lowercased), or null. */
  robots: string | null;
  h1Count: number;
  /** Absolute http(s) link targets, fragments removed, first-seen order, de-duplicated, at most MAX_LINKS_PER_PAGE. */
  links: string[];
  /** True when the page had more links than were kept. */
  linksCapped: boolean;
}

const clean = (s: string | undefined | null): string | null => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
};

/** Resolve `href` against `base`; http(s) only, fragment dropped. Null for anything else. */
export function resolveLink(href: string, base: string): string | null {
  const h = href.trim();
  if (!h || h.startsWith("#") || /^(mailto:|tel:|javascript:|sms:|data:|ftp:|file:)/i.test(h)) return null;
  try {
    const u = new URL(h, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export function extractCrawlPage(html: string, pageUrl: string): CrawlPageExtract {
  assertParseable(html);
  const $ = cheerio.load(html);
  // A <base href> changes how relative links resolve (only http(s) bases are honoured).
  const baseHref = $("base[href]").first().attr("href");
  const base = (baseHref && resolveLink(baseHref, pageUrl)) || pageUrl;

  const links: string[] = [];
  const seen = new Set<string>();
  let linksCapped = false;
  $("a[href], area[href]").each((_, el) => {
    const u = resolveLink($(el).attr("href") ?? "", base);
    if (!u || seen.has(u)) return;
    if (links.length >= MAX_LINKS_PER_PAGE) {
      linksCapped = true;
      return false;
    }
    seen.add(u);
    links.push(u);
    return undefined;
  });

  const canonicalHref = clean($('link[rel~="canonical" i]').first().attr("href"));
  return {
    title: clean($("title").first().text()),
    description: clean($('meta[name="description" i]').first().attr("content")),
    canonical: canonicalHref ? resolveLink(canonicalHref, base) : null,
    robots: clean($('meta[name="robots" i]').first().attr("content"))?.toLowerCase() ?? null,
    h1Count: $("h1").length,
    links,
    linksCapped,
  };
}
