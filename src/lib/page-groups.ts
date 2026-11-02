/**
 * Release 0.5.0 (C3): page groups ("page types") for the yearly sections. A group is a name plus URL path
 * prefixes and/or RE2 regexes; a URL belongs to the first group it matches, else to "Other". The same
 * expression is sent to Search Console (page includingRegex / excludingRegex on full URLs) and matched
 * locally with RE2JS (stored history rows, crawled pages), so both sides agree. Pure (no I/O).
 */
import { RE2JS } from "re2js";
import { stripControl } from "./terminal-text.js";

export interface PageGroup {
  name: string;
  prefix?: string[];
  regex?: string[];
}

export const DEFAULT_PAGE_GROUPS: readonly PageGroup[] = [
  { name: "Home", regex: ["/(\\?.*)?$"] },
  { name: "Blog", prefix: ["/blog/", "/news/", "/articles/", "/insights/", "/resources/"] },
  { name: "Services", prefix: ["/services/", "/service/"] },
  { name: "Locations", prefix: ["/locations/", "/location/", "/areas/", "/service-areas/"] },
];
export const OTHER_GROUP = "Other";
export const MAX_PAGE_GROUPS = 12;
export const MAX_GROUP_NAME = 40;
export const MAX_GROUP_ITEMS = 20;
export const MAX_GROUP_ITEM_LENGTH = 200;
/** Search Console's limit on a filter expression is 4,096 characters. */
export const MAX_GROUPS_REGEX_LENGTH = 4000;

/** A deep copy of the defaults (callers may keep or change it). */
export const defaultPageGroups = (): PageGroup[] => DEFAULT_PAGE_GROUPS.map((g) => ({ name: g.name, ...(g.prefix ? { prefix: [...g.prefix] } : {}), ...(g.regex ? { regex: [...g.regex] } : {}) }));

const escapeRe2 = (s: string) => s.replace(/[\\.^$|?*+()[\]{}]/g, "\\$&");

/** The alternatives of one group, each wrapped so a regex's own `|` stays inside it. */
const alternatives = (g: PageGroup): string[] => [...(g.prefix ?? []).map(escapeRe2), ...(g.regex ?? []).map((r) => `(?:${r})`)];

const HOST = "^https?://[^/]+";

/** RE2 for Search Console's page filter on full URLs: ^https?://[^/]+(?:<escaped prefix 1>|<prefix 2>|(?:<regex 1>)…). */
export function groupRegex(g: PageGroup): string {
  return `${HOST}(?:${alternatives(g).join("|")})`;
}

/** The alternation of several groups (for excludingRegex): a URL matches when it matches any of them. */
export function groupsRegex(gs: readonly PageGroup[]): string {
  return `${HOST}(?:${gs.flatMap(alternatives).join("|")})`;
}

/** A readable reason for an RE2JS compile error (the same wording as gsc-exclusions.ts). */
function re2Problem(message: string): string {
  if (/\(\?[=!]|\(\?<[=!]/.test(message) || /invalid named capture: `\(\?<[=!]/.test(message)) {
    return "lookarounds aren't supported (Search Console uses RE2)";
  }
  if (/invalid escape sequence: `\\[1-9k]/.test(message)) return "backreferences aren't supported (Search Console uses RE2)";
  return `isn't a valid regular expression (${message.replace(/^error parsing regexp: /, "")})`;
}

/** Null when the list is usable; else one sentence naming the group. Names are checked as trimmed. */
export function validatePageGroups(groups: readonly PageGroup[]): string | null {
  if (groups.length === 0) return "needs at least one page group.";
  if (groups.length > MAX_PAGE_GROUPS) return `has ${groups.length} page groups; the most allowed is ${MAX_PAGE_GROUPS}.`;
  const seen = new Set<string>();
  for (const [i, g] of groups.entries()) {
    const name = typeof g.name === "string" ? g.name.trim() : "";
    const label = name ? `page group "${name.slice(0, MAX_GROUP_NAME)}"` : `page group ${i + 1}`;
    if (!name) return `${label} has no name.`;
    if (name.length > MAX_GROUP_NAME) return `${label} has a name longer than ${MAX_GROUP_NAME} characters.`;
    if (stripControl(g.name) !== g.name) return `${label} has control or invisible characters in its name.`;
    if (name.toLowerCase() === OTHER_GROUP.toLowerCase()) return `${label}: "${OTHER_GROUP}" is the name for pages no group matches; choose another name.`;
    if (seen.has(name.toLowerCase())) return `${label} appears twice (names are compared ignoring case).`;
    seen.add(name.toLowerCase());
    const prefix = g.prefix ?? [];
    const regex = g.regex ?? [];
    if (prefix.length === 0 && regex.length === 0) return `${label} needs at least one prefix or regex.`;
    if (prefix.length > MAX_GROUP_ITEMS) return `${label} has ${prefix.length} prefixes; the most allowed is ${MAX_GROUP_ITEMS}.`;
    if (regex.length > MAX_GROUP_ITEMS) return `${label} has ${regex.length} regexes; the most allowed is ${MAX_GROUP_ITEMS}.`;
    for (const p of prefix) {
      const shown = `"${String(p).slice(0, 60)}"`;
      if (typeof p !== "string" || !p.startsWith("/")) return `${label}: the prefix ${shown} must start with "/".`;
      if (p.length > MAX_GROUP_ITEM_LENGTH) return `${label}: a prefix is longer than ${MAX_GROUP_ITEM_LENGTH} characters.`;
      if (p.includes("*")) return `${label}: the prefix ${shown} has a "*"; prefixes are plain text (use a regex for patterns).`;
      if (stripControl(p) !== p) return `${label}: the prefix ${shown} has control or invisible characters.`;
    }
    for (const r of regex) {
      const shown = `"${String(r).slice(0, 60)}"`;
      if (typeof r !== "string" || r === "") return `${label}: a regex is empty.`;
      if (r.length > MAX_GROUP_ITEM_LENGTH) return `${label}: a regex is longer than ${MAX_GROUP_ITEM_LENGTH} characters.`;
      if (stripControl(r) !== r) return `${label}: the regex ${shown} has control or invisible characters.`;
      try {
        RE2JS.compile(r);
      } catch (err) {
        return `${label}: the regex ${shown} ${re2Problem((err as Error).message)}.`;
      }
    }
  }
  const all = groupsRegex(groups);
  if (all.length > MAX_GROUPS_REGEX_LENGTH) {
    return `The page groups together make a ${all.length}-character expression; Search Console accepts about ${MAX_GROUPS_REGEX_LENGTH}. Use fewer or shorter prefixes and regexes.`;
  }
  return null;
}

const compiled = new Map<string, RE2JS | null>();
function cachedRe2(source: string): RE2JS | null {
  let re = compiled.get(source);
  if (re === undefined) {
    try {
      re = RE2JS.compile(source);
    } catch {
      re = null;
    }
    if (compiled.size >= 500) compiled.clear();
    compiled.set(source, re);
  }
  return re;
}

/**
 * JS side (stored rows, crawled pages): the first matching group's name, else "Other". Uses RE2JS, the same syntax and
 * case sensitivity as Search Console. A bare path ("/blog/x") is matched as if on the site's own host.
 */
export function groupOf(url: string, groups: readonly PageGroup[]): string {
  const full = url.startsWith("/") ? `https://site.invalid${url}` : url;
  for (const g of groups) {
    if (cachedRe2(groupRegex(g))?.matcher(full).find()) return g.name.trim();
  }
  return OTHER_GROUP;
}
