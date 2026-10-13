/**
 * AI crawler access in robots.txt: for each known AI crawler, whether the homepage and key pages
 * are allowed, which group matched (the crawler's own or `*`), and whether the whole site is
 * blocked. Uses the same parser and linear matcher as the robots.txt check. Pure.
 *
 * Tokens and purposes come from each vendor's own documentation (sources in
 * docs/research/2026-10-13-llms-txt.md); names line up with BOTS in bots.ts.
 */
import type { HygieneFlag, RobotsSummary } from "./hygiene.js";
import { normalizeUrl } from "./findings.js";
import { blocksEverything, isAllowed, pathOf, rulesFor, type RobotsFile } from "./robots.js";

/**
 * `search`: indexes pages for an AI search/answer product (blocking it hides the site there).
 * `user`: fetches a page when a user asks (blocking it keeps the page out of those answers).
 * `training`: collects content for model training, or is a training opt-out token (blocking it is a legitimate choice).
 */
export type AiCrawlerPurpose = "search" | "user" | "training";

export interface AiCrawlerDef {
  bot: string;
  /** The robots.txt user-agent token, lowercase. */
  token: string;
  vendor: string;
  purpose: AiCrawlerPurpose;
  /** False when the vendor says robots.txt may not apply (user-initiated fetchers). Such blocks are data only. */
  honorsRobots: boolean;
}

export const AI_CRAWLERS: readonly AiCrawlerDef[] = [
  { bot: "OAI-SearchBot", token: "oai-searchbot", vendor: "OpenAI", purpose: "search", honorsRobots: true },
  { bot: "ChatGPT-User", token: "chatgpt-user", vendor: "OpenAI", purpose: "user", honorsRobots: false },
  { bot: "GPTBot", token: "gptbot", vendor: "OpenAI", purpose: "training", honorsRobots: true },
  { bot: "Claude-SearchBot", token: "claude-searchbot", vendor: "Anthropic", purpose: "search", honorsRobots: true },
  { bot: "Claude-User", token: "claude-user", vendor: "Anthropic", purpose: "user", honorsRobots: true },
  { bot: "ClaudeBot", token: "claudebot", vendor: "Anthropic", purpose: "training", honorsRobots: true },
  // A legacy Anthropic token, no longer in Anthropic's documentation but still common in robots.txt files.
  { bot: "anthropic-ai", token: "anthropic-ai", vendor: "Anthropic", purpose: "training", honorsRobots: true },
  { bot: "PerplexityBot", token: "perplexitybot", vendor: "Perplexity", purpose: "search", honorsRobots: true },
  { bot: "Perplexity-User", token: "perplexity-user", vendor: "Perplexity", purpose: "user", honorsRobots: false },
  { bot: "Google-Extended", token: "google-extended", vendor: "Google", purpose: "training", honorsRobots: true },
  { bot: "Applebot-Extended", token: "applebot-extended", vendor: "Apple", purpose: "training", honorsRobots: true },
  { bot: "CCBot", token: "ccbot", vendor: "Common Crawl", purpose: "training", honorsRobots: true },
  { bot: "Bytespider", token: "bytespider", vendor: "ByteDance", purpose: "training", honorsRobots: true },
  { bot: "Meta-ExternalAgent", token: "meta-externalagent", vendor: "Meta", purpose: "training", honorsRobots: true },
  { bot: "Amazonbot", token: "amazonbot", vendor: "Amazon", purpose: "training", honorsRobots: true },
];

export type PageAccess = "allowed" | "blocked";

export interface AiCrawlerAccess {
  bot: string;
  vendor: string;
  purpose: AiCrawlerPurpose;
  honorsRobots: boolean;
  /** `named`: a group names this crawler; `*`: the catch-all group; `none`: no group applies (everything allowed). */
  group: "named" | "*" | "none";
  /** `blocked`: the whole site; `partial`: the homepage or some key pages; `allowed`: every page checked. */
  access: "allowed" | "partial" | "blocked";
  homepage: PageAccess;
  /** Key pages (not the homepage) this crawler may not fetch. */
  blockedKeyPages: string[];
}

export interface AiCrawlersResult {
  /** robots.txt existed; false means every crawler is allowed everywhere. */
  robotsFound: boolean;
  homepage: string;
  /** Key pages other than the homepage (the homepage has its own column), so `blockedKeyPages` is out of this. */
  keyPages: number;
  crawlers: AiCrawlerAccess[];
}

const allowed = (rules: ReturnType<typeof rulesFor>["rules"], url: string): boolean => {
  try {
    return isAllowed(rules, pathOf(url));
  } catch {
    return true; // not a URL: nothing to judge
  }
};

/** Access for every AI crawler from an already-parsed robots.txt (or null when there is none). */
export function aiCrawlerAccess(file: RobotsFile | null, homepage: string, keyPages: string[]): AiCrawlerAccess[] {
  const home = normalizeUrl(homepage);
  const others = keyPages.filter((u) => normalizeUrl(u) !== home);
  // Most crawlers fall back to `*`, so each distinct group is evaluated once and shared.
  const byGroup = new Map<string, Pick<AiCrawlerAccess, "access" | "homepage" | "blockedKeyPages">>();
  return AI_CRAWLERS.map((def) => {
    const base = { bot: def.bot, vendor: def.vendor, purpose: def.purpose, honorsRobots: def.honorsRobots };
    if (!file) return { ...base, group: "none", access: "allowed", homepage: "allowed", blockedKeyPages: [] };
    const r = rulesFor(file, def.token);
    const group: AiCrawlerAccess["group"] = r.matched === "*" ? "*" : r.matched === "none" ? "none" : "named";
    let result = byGroup.get(r.matched);
    if (!result) {
      const homeOk = allowed(r.rules, homepage);
      const blockedKeyPages = others.filter((u) => !allowed(r.rules, u));
      const access: AiCrawlerAccess["access"] = blocksEverything(r.rules) ? "blocked" : !homeOk || blockedKeyPages.length ? "partial" : "allowed";
      byGroup.set(r.matched, (result = { access, homepage: homeOk ? "allowed" : "blocked", blockedKeyPages }));
    }
    return { ...base, group, ...result, blockedKeyPages: [...result.blockedKeyPages] };
  });
}

/**
 * The AI crawler part of the robots.txt check: the access table, plus one low `ai-search-crawler-blocked`
 * finding per page that an AI search/answer crawler (one that honours robots.txt) may not fetch. Training-only
 * crawlers are data only. Blocks that the robots.txt check already reports are skipped: the catch-all group
 * blocking everything (`robots-disallow-all`) or a key page blocked for Googlebot by the same `*` group.
 */
export function analyzeAiCrawlers(
  robotsUrl: string,
  /** The robots.txt analyzeRobots already parsed, or null when there is none. */
  file: RobotsFile | null,
  robots: RobotsSummary,
  homepage: string,
  keyPages: string[],
): { aiCrawlers: AiCrawlersResult; flags: HygieneFlag[] } {
  const crawlers = aiCrawlerAccess(robots.found ? file : null, homepage, keyPages);
  const alreadyReported = new Set(robots.group === "*" ? robots.blockedKeyPages.map(normalizeUrl) : []);
  const byPage = new Map<string, { url: string; bots: string[] }>();
  for (const c of crawlers) {
    if (c.purpose === "training" || !c.honorsRobots) continue;
    if (c.group === "*" && robots.disallowAll) continue;
    const pages = [...(c.homepage === "blocked" ? [homepage] : []), ...c.blockedKeyPages];
    for (const url of pages) {
      const k = normalizeUrl(url);
      if (c.group === "*" && alreadyReported.has(k)) continue;
      let entry = byPage.get(k);
      if (!entry) byPage.set(k, (entry = { url, bots: [] }));
      entry.bots.push(`${c.bot} (group ${c.group === "named" ? c.bot.toLowerCase() : "*"})`);
    }
  }
  const flags: HygieneFlag[] = [...byPage.values()].map((p) => ({
    rule: "ai-search-crawler-blocked",
    url: p.url,
    severity: "low",
    title: "robots.txt blocks AI search crawlers from this page (if this is intended, ignore it)",
    evidence: `${p.bots.join(", ")} in ${robotsUrl}`,
  }));
  const home = normalizeUrl(homepage);
  const others = new Set(keyPages.map(normalizeUrl).filter((k) => k !== home)).size;
  return { aiCrawlers: { robotsFound: robots.found, homepage, keyPages: others, crawlers }, flags };
}
