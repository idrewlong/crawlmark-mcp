/** A small robots.txt parser (RFC 9309 subset): user-agent groups, Allow/Disallow longest match, Sitemap lines. Pure. */
export interface RobotsRule {
  allow: boolean;
  pattern: string;
}
export interface RobotsFile {
  groups: { agents: string[]; rules: RobotsRule[] }[];
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

function toRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${body.join(".*")}${anchored ? "$" : ""}`);
}

/** Longest matching pattern wins; Allow wins a tie. `path` includes the query string. */
export function isAllowed(rules: RobotsRule[], path: string): boolean {
  let best: RobotsRule | undefined;
  for (const r of rules) {
    if (!toRegExp(r.pattern).test(path)) continue;
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
