/**
 * Release A / D4: Search Console queries left out of totals and query lists. Pure (no I/O).
 * A plain string matches the whole query exactly (case-insensitive, spaces collapsed); "/.../" is an RE2 regex
 * (case-insensitive). Search Console takes one RE2 expression per filter, built by exclusionRegex.
 */

import { RE2JS } from "re2js";

export type Exclusion = { kind: "exact"; query: string } | { kind: "regex"; source: string };

export const MAX_EXCLUSIONS = 100;
export const MAX_EXCLUSION_LENGTH = 200;
/** Search Console's limit on a filter expression is 4,096 characters. */
export const MAX_EXCLUSION_REGEX_LENGTH = 4000;

const collapse = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** "/.../" (at least one character between the slashes) is a regex; anything else is an exact query. */
export function parseExclusion(item: string): Exclusion {
  const t = item.trim();
  if (t.length >= 3 && t.startsWith("/") && t.endsWith("/")) return { kind: "regex", source: t.slice(1, -1) };
  return { kind: "exact", query: collapse(t) };
}

/**
 * Compile a user pattern with RE2JS (a linear-time RE2 port, so Search Console's own syntax: no lookaround or
 * backreference, and no catastrophic backtracking whatever the pattern). Throws RE2JSSyntaxException.
 */
function compileRe2(source: string): RE2JS {
  return RE2JS.compile(source, RE2JS.CASE_INSENSITIVE);
}

const compiled = new Map<string, RE2JS | null>();

/** Compiled pattern (cached), or null when it doesn't compile. */
function cachedRe2(source: string): RE2JS | null {
  let re = compiled.get(source);
  if (re === undefined) {
    try {
      re = compileRe2(source);
    } catch {
      re = null;
    }
    if (compiled.size >= 500) compiled.clear();
    compiled.set(source, re);
  }
  return re;
}

/** A readable reason for an RE2JS compile error. */
function re2Problem(message: string): string {
  if (/\(\?[=!]|\(\?<[=!]/.test(message) || /invalid named capture: `\(\?<[=!]/.test(message)) {
    return "lookarounds aren't supported (Search Console uses RE2)";
  }
  if (/invalid escape sequence: `\\[1-9k]/.test(message)) return "backreferences aren't supported (Search Console uses RE2)";
  return `isn't a valid regular expression (${message.replace(/^error parsing regexp: /, "")})`;
}

/** Why one item isn't usable, or null when it is. */
export function exclusionProblem(item: string): string | null {
  if (typeof item !== "string" || item.trim() === "") return "is empty";
  if (item.length > MAX_EXCLUSION_LENGTH) return `is longer than ${MAX_EXCLUSION_LENGTH} characters`;
  const ex = parseExclusion(item);
  if (ex.kind === "exact") return ex.query === "" ? "is empty" : null;
  try {
    compileRe2(ex.source);
  } catch (err) {
    return re2Problem((err as Error).message);
  }
  return null;
}

const escapeRe2 = (s: string) => s.replace(/[\\.^$|?*+()[\]{}]/g, "\\$&");

/** Error text for a whole list, or null when it is OK. An empty list is an error: callers clear a list instead of validating it. */
export function validateExclusions(items: readonly string[]): string | null {
  if (items.length === 0) return "needs at least one item";
  if (items.length > MAX_EXCLUSIONS) return `has ${items.length} items; the most allowed is ${MAX_EXCLUSIONS}`;
  for (const item of items) {
    const problem = exclusionProblem(item);
    if (problem) return `"${item.slice(0, 100)}" isn't a usable exclusion: ${problem}.`;
  }
  const re = exclusionRegex(items);
  if (re !== null && re.length > MAX_EXCLUSION_REGEX_LENGTH) {
    return `The exclusions together make a ${re.length}-character expression; Search Console accepts about ${MAX_EXCLUSION_REGEX_LENGTH}. Remove some or merge them into one regex.`;
  }
  return null;
}

/**
 * One RE2 expression for Search Console: "(?i)^(?:<exact1>|<exact2>)$|(?:<re1>)|(?:<re2>)" (exact parts escaped),
 * or null when items is empty.
 */
export function exclusionRegex(items: readonly string[]): string | null {
  const exact: string[] = [];
  const regex: string[] = [];
  for (const item of items) {
    const ex = parseExclusion(item);
    if (ex.kind === "exact") {
      if (ex.query && !exact.includes(ex.query)) exact.push(ex.query);
    } else if (!regex.includes(ex.source)) regex.push(ex.source);
  }
  const parts = [...(exact.length ? [`^(?:${exact.map(escapeRe2).join("|")})$`] : []), ...regex.map((r) => `(?:${r})`)];
  return parts.length ? `(?i)${parts.join("|")}` : null;
}

/** Local match (used for stored history only) with RE2JS, the same syntax Search Console uses. */
export function isExcludedQuery(query: string, items: readonly string[]): boolean {
  const normalised = collapse(query);
  for (const item of items) {
    const ex = parseExclusion(item);
    if (ex.kind === "exact") {
      if (ex.query !== "" && ex.query === normalised) return true;
    } else {
      // An invalid pattern never matches. RE2JS runs in linear time, so a hostile pattern can't hang the server.
      if (cachedRe2(ex.source)?.matcher(query).find()) return true;
    }
  }
  return false;
}
