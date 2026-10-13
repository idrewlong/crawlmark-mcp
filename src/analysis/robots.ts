/** A small robots.txt parser (RFC 9309 subset): user-agent groups, Allow/Disallow longest match, Sitemap lines. Pure. */
export interface RobotsRule {
  allow: boolean;
  pattern: string;
}
export interface RobotsFile {
  /** `crawlDelay` (seconds) is the group's last valid Crawl-delay line; not part of RFC 9309, but widely honoured. */
  groups: { agents: string[]; rules: RobotsRule[]; crawlDelay?: number }[];
  sitemaps: string[];
}

export function parseRobots(text: string): RobotsFile {
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
  return { groups, sitemaps };
}

/** Rules for a crawler: the groups naming it, else the `*` groups (groups with the same agent are merged). */
export function rulesFor(file: RobotsFile, agent: string): { rules: RobotsRule[]; matched: string } {
  const a = agent.toLowerCase();
  const named = file.groups.filter((g) => g.agents.includes(a));
  if (named.length) return { rules: named.flatMap((g) => g.rules), matched: a };
  const star = file.groups.filter((g) => g.agents.includes("*"));
  return { rules: star.flatMap((g) => g.rules), matched: star.length ? "*" : "none" };
}

/** Crawl-delay (seconds) for a crawler from the same groups rulesFor picks (the largest when merged groups disagree), or null. */
export function crawlDelayFor(file: RobotsFile, agent: string): number | null {
  const a = agent.toLowerCase();
  let groups = file.groups.filter((g) => g.agents.includes(a));
  if (!groups.length) groups = file.groups.filter((g) => g.agents.includes("*"));
  const delays = groups.flatMap((g) => (g.crawlDelay === undefined ? [] : [g.crawlDelay]));
  return delays.length ? Math.max(...delays) : null;
}

/**
 * Does a robots.txt pattern match `path`? `*` matches any run of characters, a trailing `$` anchors
 * the end, otherwise the pattern is a prefix. A linear wildcard matcher (greedy with one backtrack
 * point, O(path × pattern) at worst), so hostile patterns can't cause regex backtracking. Pure.
 */
export function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  // An unanchored pattern is a prefix match: the same as a trailing `*`.
  const p = anchored ? pattern.slice(0, -1) : `${pattern}*`;
  let i = 0; // path
  let j = 0; // pattern
  let star = -1;
  let mark = 0;
  while (i < path.length) {
    if (j < p.length && p[j] !== "*" && p[j] === path[i]) {
      i++;
      j++;
    } else if (j < p.length && p[j] === "*") {
      star = j++;
      mark = i;
    } else if (star !== -1) {
      j = star + 1;
      i = ++mark;
    } else return false;
  }
  while (j < p.length && p[j] === "*") j++;
  return j === p.length;
}

/** Longest matching pattern wins; Allow wins a tie. `path` includes the query string. */
export function isAllowed(rules: RobotsRule[], path: string): boolean {
  let best: RobotsRule | undefined;
  for (const r of rules) {
    if (!robotsPatternMatches(r.pattern, path)) continue;
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
