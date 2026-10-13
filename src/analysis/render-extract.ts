import * as cheerio from "cheerio";

export const MAX_TAGS = 200_000;

/**
 * Cheap linear cap on the number of start tags. This is not a security boundary:
 * parse time and memory are bounded by running extractSeo in a worker
 * (extract-isolated.ts). Valid HTML can nest deeply via omitted end tags, so depth is not checked.
 */
export function assertParseable(html: string): void {
  let tags = 0;
  let i = 0;
  for (;;) {
    i = html.indexOf("<", i);
    if (i === -1) return;
    i++;
    const c = html.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      if (++tags > MAX_TAGS) throw new Error(`HTML has more than ${MAX_TAGS} tags; refusing to parse`);
    }
  }
}

export interface SeoExtract {
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  robots: string | null;
  h1: string[];
  h2Count: number;
  internalLinks: number;
  externalLinks: number;
  images: number;
  imagesMissingAlt: number;
  jsonLdTypes: string[];
  hreflang: { lang: string; href: string }[];
  ogTitle: string | null;
  ogImage: string | null;
  /** Words of visible body text (script, style, noscript and template removed). */
  wordCount: number;
}

const clean = (s: string | undefined | null): string | null => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
};

const hostKey = (h: string) => h.toLowerCase().replace(/^www\./, "");

function collectTypes(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) collectTypes(n, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const t = obj["@type"];
  if (typeof t === "string") out.add(t);
  else if (Array.isArray(t)) for (const x of t) if (typeof x === "string") out.add(x);
  if (obj["@graph"]) collectTypes(obj["@graph"], out);
}

/** Pull the SEO-relevant elements out of an HTML document. `pageUrl` decides internal vs external links. */
export function extractSeo(html: string, pageUrl: string): SeoExtract {
  assertParseable(html);
  const $ = cheerio.load(html);
  const resolve = (href: string | null): string | null => {
    if (!href) return null;
    try {
      return new URL(href, pageUrl).toString();
    } catch {
      return href;
    }
  };
  let pageHost = "";
  try {
    pageHost = hostKey(new URL(pageUrl).hostname);
  } catch {
    /* relative links are then all internal */
  }

  const meta = (sel: string) => clean($(sel).first().attr("content"));

  let internalLinks = 0;
  let externalLinks = 0;
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!href || href.startsWith("#") || /^(mailto:|tel:|javascript:|sms:|data:)/i.test(href)) return;
    try {
      const u = new URL(href, pageUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") return;
      if (!pageHost || hostKey(u.hostname) === pageHost) internalLinks++;
      else externalLinks++;
    } catch {
      /* unparseable href: ignore */
    }
  });

  const types = new Set<string>();
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      collectTypes(JSON.parse($(el).contents().text()), types);
    } catch {
      /* invalid JSON-LD is not a type source */
    }
  });

  const hreflang: { lang: string; href: string }[] = [];
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const lang = clean($(el).attr("hreflang"));
    const href = resolve(clean($(el).attr("href")));
    if (lang && href) hreflang.push({ lang, href });
  });

  const images = $("img");
  let imagesMissingAlt = 0;
  images.each((_, el) => {
    if ($(el).attr("alt") === undefined) imagesMissingAlt++;
  });

  const body = $("body").first().clone();
  body.find("script, style, noscript, template").remove();
  // Join text nodes with spaces: .text() would fuse the last word of one block with the first of the next.
  const parts: string[] = [];
  const stack = [...body.contents().toArray()].reverse();
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === "text") parts.push((n as unknown as { data: string }).data);
    else if ("children" in n) for (let k = n.children.length - 1; k >= 0; k--) stack.push(n.children[k]!);
  }
  const text = clean(parts.join(" ")) ?? "";

  return {
    title: clean($("title").first().text()),
    metaDescription: meta('meta[name="description" i]'),
    canonical: resolve(clean($('link[rel="canonical"]').first().attr("href"))),
    robots: meta('meta[name="robots" i]')?.toLowerCase() ?? null,
    h1: $("h1").map((_, el) => clean($(el).text())).get().filter((s): s is string => !!s),
    h2Count: $("h2").length,
    internalLinks,
    externalLinks,
    images: images.length,
    imagesMissingAlt,
    jsonLdTypes: [...types].sort(),
    hreflang,
    ogTitle: meta('meta[property="og:title"]'),
    ogImage: meta('meta[property="og:image"]'),
    wordCount: text === "" ? 0 : text.split(" ").length,
  };
}
