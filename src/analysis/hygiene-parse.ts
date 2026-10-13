import * as cheerio from "cheerio";
import { assertParseable } from "./render-extract.js";

/** A sitemap file: either an index of child sitemaps or a urlset. */
export interface ParsedSitemap {
  kind: "index" | "urlset";
  locs: string[];
  /** `<lastmod>` per loc in ms since epoch (a date without a time counts as the end of that day). Absent or unparseable ones are omitted. */
  lastmods: Record<string, number>;
  /** `<xhtml:link rel="alternate" hreflang>` entries per `<url>` loc (hreflang lowercased, href resolved against the loc). Locs without any are omitted. */
  alternates: Record<string, { lang: string; href: string }[]>;
}

const XHTML_NS = "http://www.w3.org/1999/xhtml";

interface XmlNode {
  type: string;
  name?: string;
  attribs?: Record<string, string>;
  parent?: XmlNode | null;
}

/** The namespace URI bound to `prefix` ("" = default) in scope at `node`, found by walking up its ancestors' xmlns attributes. */
function namespaceOf(node: XmlNode, prefix: string): string | undefined {
  const attr = prefix ? `xmlns:${prefix}` : "xmlns";
  for (let n: XmlNode | null | undefined = node; n; n = n.parent) {
    const v = n.attribs?.[attr];
    if (v !== undefined) return v.trim();
  }
  return undefined;
}

/** True for a `link` element in the XHTML namespace (`<xhtml:link>` or `<link xmlns="http://www.w3.org/1999/xhtml">`). */
function isXhtmlLink(node: XmlNode): boolean {
  const m = /^(?:([\w.-]+):)?link$/i.exec(node.name ?? "");
  return !!m && namespaceOf(node, m[1] ?? "") === XHTML_NS;
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
  const alternates: Record<string, { lang: string; href: string }[]> = {};
  if (!isIndex) {
    $("urlset > url").each((_, el) => {
      const loc = $(el).children("loc").first().text().trim();
      if (loc) {
        // Only elements in the XHTML namespace count, whether prefixed (`xhtml:link`, any prefix) or via a default xmlns.
        $(el)
          .children()
          .each((__, child) => {
            if (child.type !== "tag" || !isXhtmlLink(child)) return;
            const rel = ($(child).attr("rel") ?? "").trim().toLowerCase().split(/\s+/);
            const lang = ($(child).attr("hreflang") ?? "").trim().toLowerCase();
            const href = ($(child).attr("href") ?? "").trim();
            if (!rel.includes("alternate") || !lang || !href) return;
            try {
              (alternates[loc] ??= []).push({ lang, href: new URL(href, loc).toString() });
            } catch {
              /* unusable href */
            }
          });
      }
      const raw = $(el).children("lastmod").first().text().trim();
      if (!loc || !raw) return;
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) return;
      lastmods[loc] = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? ms + 24 * 3600_000 - 1 : ms;
    });
  }
  if (!isIndex && $("urlset").length === 0) throw new Error("Not a sitemap: no <urlset> or <sitemapindex> element");
  return { kind: isIndex ? "index" : "urlset", locs, lastmods, alternates };
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
