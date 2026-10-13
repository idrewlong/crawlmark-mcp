import * as cheerio from "cheerio";
import { assertParseable } from "./render-extract.js";

/** A sitemap file: either an index of child sitemaps or a urlset. */
export interface ParsedSitemap {
  kind: "index" | "urlset";
  locs: string[];
  /** `<lastmod>` per loc in ms since epoch (a date without a time counts as the end of that day). Absent or unparseable ones are omitted. */
  lastmods: Record<string, number>;
}

/** Parse a sitemap with cheerio in XML mode (called inside a worker). */
export function parseSitemapXml(xml: string): ParsedSitemap {
  const $ = cheerio.load(xml, { xml: true });
  const isIndex = $("sitemapindex").length > 0;
  const sel = isIndex ? "sitemapindex > sitemap > loc" : "urlset > url > loc";
  const locs = $(sel)
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((s) => s !== "");
  const lastmods: Record<string, number> = {};
  if (!isIndex) {
    $("urlset > url").each((_, el) => {
      const loc = $(el).children("loc").first().text().trim();
      const raw = $(el).children("lastmod").first().text().trim();
      if (!loc || !raw) return;
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) return;
      lastmods[loc] = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? ms + 24 * 3600_000 - 1 : ms;
    });
  }
  if (!isIndex && $("urlset").length === 0) throw new Error("Not a sitemap: no <urlset> or <sitemapindex> element");
  return { kind: isIndex ? "index" : "urlset", locs, lastmods };
}

export type JsonLdBlock = { ok: true; value: unknown } | { ok: false; error: string };

/** What the hygiene checks need from one HTML page. */
export interface PageHygieneExtract {
  robots: string | null;
  canonical: string | null;
  hreflang: { lang: string; href: string }[];
  jsonLd: JsonLdBlock[];
}

const clean = (s: string | undefined | null) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
};

export function extractPageHygiene(html: string, pageUrl: string): PageHygieneExtract {
  assertParseable(html);
  const $ = cheerio.load(html);
  const abs = (href: string | null) => {
    if (!href) return null;
    try {
      return new URL(href, pageUrl).toString();
    } catch {
      return null;
    }
  };
  const hreflang: { lang: string; href: string }[] = [];
  $('link[rel~="alternate" i][hreflang]').each((_, el) => {
    const lang = clean($(el).attr("hreflang"))?.toLowerCase();
    const href = abs(clean($(el).attr("href")));
    if (lang && href) hreflang.push({ lang, href });
  });
  const jsonLd: JsonLdBlock[] = [];
  $('script[type="application/ld+json" i]').each((_, el) => {
    try {
      jsonLd.push({ ok: true, value: JSON.parse($(el).contents().text()) });
    } catch (err) {
      jsonLd.push({ ok: false, error: (err as Error).message.slice(0, 160) });
    }
  });
  return {
    robots: clean($('meta[name="robots" i]').first().attr("content"))?.toLowerCase() ?? null,
    canonical: abs(clean($('link[rel="canonical"]').first().attr("href"))),
    hreflang,
    jsonLd,
  };
}
