import { normalizeUrl } from "./findings.js";

export interface HreflangEntry {
  lang: string;
  href: string;
}

export interface HreflangIssue {
  rule: "hreflang-not-reciprocal" | "hreflang-missing-self" | "hreflang-missing-x-default";
  evidence: string;
}

const key = (u: string) => normalizeUrl(u);

/**
 * Check one page's hreflang set. `alternates` maps each fetched alternate's URL to its own
 * hreflang list (null when it could not be read: those are not judged). Pure.
 * No hreflang at all means the page is single-language and nothing is flagged.
 */
export function checkHreflang(selfUrls: string[], own: HreflangEntry[], alternates: Map<string, HreflangEntry[] | null>): HreflangIssue[] {
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
  return issues;
}
