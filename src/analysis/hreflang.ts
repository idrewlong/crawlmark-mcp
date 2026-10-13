import { normalizeUrl } from "./findings.js";

export type HreflangSource = "html" | "sitemap" | "header";

export interface HreflangEntry {
  lang: string;
  href: string;
  /** Where the declaration was found. Set on merged entries; absent on raw per-source lists. */
  sources?: HreflangSource[];
}

/** One hreflang value that different sources map to different URLs. */
export interface HreflangConflict {
  lang: string;
  /** Per source, the URLs it declares for `lang`. */
  bySource: Partial<Record<HreflangSource, string[]>>;
}

export interface HreflangIssue {
  rule: "hreflang-not-reciprocal" | "hreflang-missing-self" | "hreflang-missing-x-default" | "hreflang-conflict";
  evidence: string;
}

const key = (u: string) => normalizeUrl(u);

/**
 * Check one page's hreflang set. `alternates` maps each fetched alternate's URL to its own
 * hreflang list (null when it could not be read: those are not judged). Pure.
 * No hreflang at all means the page is single-language and nothing is flagged.
 */
export function checkHreflang(selfUrls: string[], own: HreflangEntry[], alternates: Map<string, HreflangEntry[] | null>, conflicts: HreflangConflict[] = []): HreflangIssue[] {
  if (own.length === 0) return [];
  const issues: HreflangIssue[] = [];
  const selfKeys = new Set(selfUrls.map(key));

  if (!own.some((e) => selfKeys.has(key(e.href)))) {
    issues.push({ rule: "hreflang-missing-self", evidence: "No hreflang entry points at the page itself." });
  }

  const languages = new Set(own.filter((e) => e.lang !== "x-default").map((e) => e.lang.split("-")[0]));
  if (languages.size > 1 && !own.some((e) => e.lang === "x-default")) {
    issues.push({ rule: "hreflang-missing-x-default", evidence: `Languages ${[...languages].sort().join(", ")} but no x-default.` });
  }

  const nonRecip: string[] = [];
  for (const e of own) {
    if (selfKeys.has(key(e.href))) continue;
    const theirs = alternates.get(key(e.href));
    if (!theirs) continue;
    if (!theirs.some((t) => selfKeys.has(key(t.href)))) nonRecip.push(`${e.lang} ${e.href}`);
  }
  if (nonRecip.length) issues.push({ rule: "hreflang-not-reciprocal", evidence: `Alternates that do not link back: ${nonRecip.slice(0, 5).join("; ")}${nonRecip.length > 5 ? ` (+${nonRecip.length - 5} more)` : ""}` });
  if (conflicts.length) {
    const shown = conflicts.slice(0, 5).map((c) => `${c.lang}: ${(Object.entries(c.bySource) as [HreflangSource, string[]][]).map(([src, urls]) => `${src} ${urls.join(" + ")}`).join(" vs ")}`);
    issues.push({ rule: "hreflang-conflict", evidence: `Sources disagree on the URL for ${conflicts.length} hreflang value${conflicts.length === 1 ? "" : "s"}: ${shown.join("; ")}${conflicts.length > 5 ? ` (+${conflicts.length - 5} more)` : ""}` });
  }
  return issues;
}

/** Split on a separator that is outside `<...>` and double quotes. */
function splitOutside(value: string, sep: string, angle: boolean): string[] {
  const parts: string[] = [];
  let cur = "";
  let inAngle = false;
  let inQuote = false;
  for (const ch of value) {
    if (ch === '"' && !inAngle) inQuote = !inQuote;
    else if (angle && ch === "<" && !inQuote) inAngle = true;
    else if (angle && ch === ">" && !inQuote) inAngle = false;
    if (ch === sep && !inAngle && !inQuote) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

/**
 * hreflang alternates from an HTTP `Link:` header, e.g.
 * `<https://example.com/fr>; rel="alternate"; hreflang="fr", <https://example.com/de>; rel=alternate; hreflang=de`.
 * Params may be quoted or bare. Values without rel=alternate, without hreflang or with an unusable URL are
 * skipped (malformed input never throws). Relative targets resolve against `baseUrl`. Pure.
 */
export function parseLinkHeader(value: string | null | undefined, baseUrl: string): HreflangEntry[] {
  if (!value) return [];
  const out: HreflangEntry[] = [];
  for (const raw of splitOutside(value, ",", true)) {
    const m = /^\s*<([^>]*)>(.*)$/s.exec(raw);
    if (!m) continue;
    const params = new Map<string, string>();
    for (const p of splitOutside(m[2]!, ";", false)) {
      const eq = p.indexOf("=");
      if (eq < 0) continue;
      const name = p.slice(0, eq).trim().toLowerCase();
      const val = p.slice(eq + 1).trim().replace(/^"(.*)"$/s, "$1").trim();
      if (name && !params.has(name)) params.set(name, val);
    }
    const rels = (params.get("rel") ?? "").toLowerCase().split(/\s+/);
    const lang = params.get("hreflang")?.toLowerCase();
    const target = m[1]!.trim();
    if (!rels.includes("alternate") || !lang || !target) continue;
    try {
      out.push({ lang, href: new URL(target, baseUrl).toString() });
    } catch {
      /* unusable URL */
    }
  }
  return out;
}

/**
 * Merge hreflang declarations from several sources: deduped by hreflang + normalized URL, each entry
 * listing every source that declared it. Also reports hreflang values that different sources map to
 * different URLs. Two entries for one value inside a single source are not a conflict. Pure.
 */
export function mergeHreflang(sets: { source: HreflangSource; entries: HreflangEntry[] }[]): { entries: HreflangEntry[]; conflicts: HreflangConflict[] } {
  const merged = new Map<string, HreflangEntry & { sources: HreflangSource[] }>();
  const perLang = new Map<string, Partial<Record<HreflangSource, Map<string, string>>>>();
  for (const { source, entries } of sets) {
    for (const e of entries) {
      const k = `${e.lang}\n${key(e.href)}`;
      const hit = merged.get(k);
      if (hit) {
        if (!hit.sources.includes(source)) hit.sources.push(source);
      } else merged.set(k, { lang: e.lang, href: e.href, sources: [source] });
      const langMap = perLang.get(e.lang) ?? {};
      const urls = langMap[source] ?? new Map<string, string>();
      urls.set(key(e.href), e.href);
      langMap[source] = urls;
      perLang.set(e.lang, langMap);
    }
  }
  const conflicts: HreflangConflict[] = [];
  for (const [lang, bySrc] of perLang) {
    const present = Object.entries(bySrc) as [HreflangSource, Map<string, string>][];
    if (present.length < 2) continue;
    const sig = (m: Map<string, string>) => [...m.keys()].sort().join("\n");
    if (new Set(present.map(([, m]) => sig(m))).size > 1) {
      conflicts.push({ lang, bySource: Object.fromEntries(present.map(([src, m]) => [src, [...m.values()]])) });
    }
  }
  conflicts.sort((a, b) => a.lang.localeCompare(b.lang));
  return { entries: [...merged.values()], conflicts };
}
