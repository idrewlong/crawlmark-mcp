/** A small robots.txt parser (RFC 9309 subset): user-agent groups, Allow/Disallow longest match, Sitemap lines. Pure. */
export interface RobotsRule {
  allow: boolean;
  pattern: string;
}
export interface RobotsFile {
  /** `crawlDelay` (seconds) is the group's last valid Crawl-delay line; not part of RFC 9309, but widely honoured. */
  groups: { agents: string[]; rules: RobotsRule[]; crawlDelay?: number }[];
  sitemaps: string[];
  /** The file was longer than ROBOTS_MAX_BYTES and only the start was read. */
  truncated?: boolean;
}

/** RFC 9309 lets crawlers stop at 500 KiB, and Google does; anything after that is ignored. */
export const ROBOTS_MAX_BYTES = 500 * 1024;

export function parseRobots(input: string): RobotsFile {
  let text = input;
  let truncated = false;
  // Cheap check first: a string can't be over the byte cap unless its length could be.
  if (text.length > ROBOTS_MAX_BYTES / 4 && Buffer.byteLength(text) > ROBOTS_MAX_BYTES) {
    // Cut at the last line break inside the cap: a line cut partway could turn
    // "Disallow: /private-area" into a broader "Disallow: /".
    const buf = Buffer.from(text).subarray(0, ROBOTS_MAX_BYTES);
    const nl = buf.lastIndexOf(0x0a);
    text = buf.subarray(0, nl === -1 ? 0 : nl + 1).toString("utf8");
    truncated = true;
  }
  const groups: RobotsFile["groups"] = [];
  const sitemaps: string[] = [];
  let current: RobotsFile["groups"][number] | undefined;
  let lastWasAgent = false;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const i = line.indexOf(":");
    if (i < 1) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
    } else if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    } else if ((field === "allow" || field === "disallow") && current) {
      // An empty Disallow means "allow everything" and adds no rule.
      if (value) current.rules.push({ allow: field === "allow", pattern: value });
    } else if (field === "crawl-delay" && current) {
      const n = Number(value);
      if (value !== "" && Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
    lastWasAgent = false;
  }
  return { groups, sitemaps, ...(truncated ? { truncated } : {}) };
}

/** Merged rules without exact duplicates (same pattern, same Allow/Disallow), which can't change a decision. */
function mergeRules(groups: RobotsFile["groups"]): RobotsRule[] {
  const seen = new Set<string>();
  const out: RobotsRule[] = [];
  for (const g of groups)
    for (const r of g.rules) {
      const k = `${r.allow ? "A" : "D"}${r.pattern}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
  return out;
}

/** Rules for a crawler: the groups naming it, else the `*` groups (groups with the same agent are merged). */
export function rulesFor(file: RobotsFile, agent: string): { rules: RobotsRule[]; matched: string } {
  const a = agent.toLowerCase();
  const named = file.groups.filter((g) => g.agents.includes(a));
  if (named.length) return { rules: mergeRules(named), matched: a };
  const star = file.groups.filter((g) => g.agents.includes("*"));
  return { rules: mergeRules(star), matched: star.length ? "*" : "none" };
}

/** Crawl-delay (seconds) for a crawler from the same groups rulesFor picks (the largest when merged groups disagree), or null. */
export function crawlDelayFor(file: RobotsFile, agent: string): number | null {
  const a = agent.toLowerCase();
  let groups = file.groups.filter((g) => g.agents.includes(a));
  if (!groups.length) groups = file.groups.filter((g) => g.agents.includes("*"));
  const delays = groups.flatMap((g) => (g.crawlDelay === undefined ? [] : [g.crawlDelay]));
  return delays.length ? Math.max(...delays) : null;
}

/** A pattern split at its `*`s: the literal pieces, and whether a trailing `$` anchors the end. */
interface CompiledPattern {
  segments: string[];
  anchored: boolean;
}

function compilePattern(pattern: string): CompiledPattern {
  const anchored = pattern.endsWith("$");
  return { segments: (anchored ? pattern.slice(0, -1) : pattern).split("*"), anchored };
}

/**
 * The compiled match: the first piece is a prefix, each middle piece is found left to right (the leftmost
 * place is always the best choice when `*` is the only wildcard), and the last piece must end the path when
 * anchored, or just appear after the others when not (an unanchored pattern is a prefix match). Every step is
 * a native startsWith / indexOf / endsWith, so there's no backtracking.
 */
function matchCompiled(c: CompiledPattern, path: string): boolean {
  const s = c.segments;
  const first = s[0]!;
  if (s.length === 1) return c.anchored ? path === first : path.startsWith(first);
  if (!path.startsWith(first)) return false;
  let pos = first.length;
  for (let k = 1; k < s.length - 1; k++) {
    const seg = s[k]!;
    if (seg === "") continue;
    const at = path.indexOf(seg, pos);
    if (at === -1) return false;
    pos = at + seg.length;
  }
  const last = s[s.length - 1]!;
  if (c.anchored) return path.length - last.length >= pos && path.endsWith(last);
  return last === "" || path.indexOf(last, pos) !== -1;
}

const compiled = new WeakMap<RobotsRule, CompiledPattern>();
function compiledOf(r: RobotsRule): CompiledPattern {
  let c = compiled.get(r);
  if (!c) compiled.set(r, (c = compilePattern(r.pattern)));
  return c;
}

/**
 * Does a robots.txt pattern match `path`? `*` matches any run of characters, a trailing `$` anchors
 * the end, otherwise the pattern is a prefix. Split at the `*`s and matched with native string search,
 * so hostile patterns can't cause regex backtracking. Pure.
 */
export function robotsPatternMatches(pattern: string, path: string): boolean {
  return matchCompiled(compilePattern(pattern), path);
}

/** Longest matching pattern wins; Allow wins a tie. `path` includes the query string. */
export function isAllowed(rules: RobotsRule[], path: string): boolean {
  let best: RobotsRule | undefined;
  for (const r of rules) {
    // A rule no longer than the best match so far can only matter as an Allow tie-break.
    if (best && (r.pattern.length < best.pattern.length || (r.pattern.length === best.pattern.length && (!r.allow || best.allow)))) continue;
    if (!matchCompiled(compiledOf(r), path)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow && !best.allow)) best = r;
  }
  return best ? best.allow : true;
}

/** True when the rules block the whole site (the root and an arbitrary deep path). */
export function blocksEverything(rules: RobotsRule[]): boolean {
  return !isAllowed(rules, "/") && !isAllowed(rules, "/crawlmark-probe/page.html");
}

export const pathOf = (url: string): string => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};
