/**
 * Known crawlers for server-log analysis (Phase 12 C2): a user-agent substring
 * (case-insensitive) → bot name and family. Editable: add a row to recognise
 * another bot. Order matters: the first match wins, so more specific tokens
 * (Google-InspectionTool, ChatGPT-User) come before broader ones.
 */
export type BotFamily = "search" | "ai-training" | "ai-search" | "ai-user" | "other";

export interface BotDef {
  bot: string;
  /** Matched case-insensitively anywhere in the user agent. */
  token: string;
  family: BotFamily;
  /** The bot's IPs can be checked against Google's published crawler ranges. */
  googleVerifiable?: boolean;
  /** A robots.txt token only: it never appears in a user agent, so it never matches a log line. */
  robotsTokenOnly?: boolean;
}

export const BOTS: readonly BotDef[] = [
  { bot: "Google-InspectionTool", token: "google-inspectiontool", family: "search", googleVerifiable: true },
  { bot: "GoogleOther", token: "googleother", family: "other", googleVerifiable: true },
  { bot: "Google-Extended", token: "google-extended", family: "ai-training", robotsTokenOnly: true },
  { bot: "Googlebot", token: "googlebot", family: "search", googleVerifiable: true },
  { bot: "Bingbot", token: "bingbot", family: "search" },
  { bot: "OAI-SearchBot", token: "oai-searchbot", family: "ai-search" },
  { bot: "ChatGPT-User", token: "chatgpt-user", family: "ai-user" },
  { bot: "GPTBot", token: "gptbot", family: "ai-training" },
  { bot: "Claude-SearchBot", token: "claude-searchbot", family: "ai-search" },
  { bot: "Claude-User", token: "claude-user", family: "ai-user" },
  { bot: "ClaudeBot", token: "claudebot", family: "ai-training" },
  { bot: "Perplexity-User", token: "perplexity-user", family: "ai-user" },
  { bot: "PerplexityBot", token: "perplexitybot", family: "ai-search" },
  { bot: "CCBot", token: "ccbot", family: "ai-training" },
  { bot: "Applebot", token: "applebot", family: "search" },
  { bot: "Amazonbot", token: "amazonbot", family: "ai-training" },
  { bot: "Bytespider", token: "bytespider", family: "ai-training" },
  { bot: "Meta-ExternalAgent", token: "meta-externalagent", family: "ai-training" },
];

export const BOT_NAMES: readonly string[] = BOTS.map((b) => b.bot);

/** The bot a user agent belongs to, or null (not a known bot). */
export function matchBot(userAgent: string): BotDef | null {
  const ua = userAgent.toLowerCase();
  for (const b of BOTS) if (!b.robotsTokenOnly && ua.includes(b.token)) return b;
  return null;
}

/** Resolve user-supplied bot names (any case) to the table's names; unknown names are returned separately. */
export function resolveBotNames(names: readonly string[]): { bots: string[]; unknown: string[] } {
  const bots: string[] = [];
  const unknown: string[] = [];
  for (const n of names) {
    const b = BOTS.find((x) => x.bot.toLowerCase() === n.trim().toLowerCase());
    if (b) bots.push(b.bot);
    else unknown.push(n);
  }
  return { bots: [...new Set(bots)], unknown };
}
