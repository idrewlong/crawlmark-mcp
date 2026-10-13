/**
 * Server-log analysis (Phase 12 C2): Apache/Nginx `combined` and `common` line
 * parsing and a streaming aggregate per known bot. Pure. The aggregate holds
 * only bot names, paths (query strings removed), statuses, days and counts:
 * never an IP address, a full user agent, a referrer or a raw line.
 */
import { stripControl } from "../lib/terminal-text.js";
import { BOTS, matchBot, type BotFamily } from "./bots.js";

export type LogFormat = "combined" | "common";

export interface LogEntry {
  /** The client address field (%h). Used only for verification, never kept. */
  ip: string;
  /** ms since the epoch. */
  time: number;
  /** Path without the query string; null when the request line wasn't a normal request. */
  path: string | null;
  hasQuery: boolean;
  status: number;
  /** null in the common format. */
  userAgent: string | null;
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** %h %l %u [%t] "%r" %>s %b, then optionally "%{Referer}i" "%{User-agent}i" (combined) and anything after (nginx extras). */
const LINE_RE =
  /^(\S+) \S+ \S+ \[(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})\] "((?:[^"\\]|\\.)*)" (\d{3}) (?:\d+|-)(?: "(?:[^"\\]|\\.)*" "((?:[^"\\]|\\.)*)")?(?:\s.*)?$/;
export const MAX_PATH_CHARS = 300;

/** Parse one access-log line; null when it isn't in the combined or common format. */
export function parseLogLine(line: string): { format: LogFormat; entry: LogEntry } | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const month = MONTHS[m[3]!.toLowerCase()];
  if (month === undefined) return null;
  const offsetMin = (m[8] === "-" ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10]));
  const time = Date.UTC(Number(m[4]), month, Number(m[2]), Number(m[5]), Number(m[6]), Number(m[7])) - offsetMin * 60_000;
  if (Number.isNaN(time)) return null;
  const { path, hasQuery } = requestPath(m[11]!);
  const ua = m[13];
  return { format: ua === undefined ? "common" : "combined", entry: { ip: m[1]!, time, path, hasQuery, status: Number(m[12]), userAgent: ua ?? null } };
}

/** "GET /a?b HTTP/1.1" → "/a" (query removed). Absolute-form targets keep only the path. */
export function requestPath(request: string): { path: string | null; hasQuery: boolean } {
  const parts = request.split(" ");
  if (parts.length < 2 || !/^[A-Z]{3,10}$/.test(parts[0]!)) return { path: null, hasQuery: false };
  let target = parts[1]!;
  if (/^https?:\/\//i.test(target)) {
    try {
      const u = new URL(target);
      target = `${u.pathname}${u.search}`;
    } catch {
      return { path: null, hasQuery: false };
    }
  }
  if (!target.startsWith("/") && target !== "*") return { path: null, hasQuery: false };
  const q = target.indexOf("?");
  // A percent-encoded "?" (%3F) starts what is effectively a query string too: drop it as well.
  const enc = target.search(/%3f/i);
  const cut = [q, enc].filter((i) => i !== -1);
  const end = cut.length ? Math.min(...cut) : -1;
  const path = scrubPath(stripControl(end === -1 ? target : target.slice(0, end)));
  return { path: path.length > MAX_PATH_CHARS ? path.slice(0, MAX_PATH_CHARS) : path, hasQuery: end !== -1 };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path segment that looks like a session id, key or token rather than a page name: shown as `:token`. */
export function looksLikeToken(segment: string): boolean {
  if (UUID_RE.test(segment)) return true;
  if (segment.length < 24 || !/^[A-Za-z0-9_-]+$/.test(segment)) return false;
  // Long slugs ("my-long-blog-post-title-2026") have several separators; tokens have digits and letters and few or none.
  return /\d/.test(segment) && /[A-Za-z]/.test(segment) && (segment.match(/[-_]/g) ?? []).length <= 2;
}

/**
 * Keep tokens embedded in paths out of the result (SEC-7): matrix parameters (`;jsessionid=...`) are
 * removed from every segment, and long token-like segments become `:token`.
 */
export function scrubPath(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      const s = seg.replace(/;.*$/, "");
      return looksLikeToken(s) ? ":token" : s;
    })
    .join("/");
}

export type Verification = "verified" | "unverified" | "unknown";

export interface PathCount {
  path: string;
  hits: number;
  status: number;
}

export interface BotSummary {
  bot: string;
  family: BotFamily;
  hits: number;
  verified: number;
  unverified: number;
  unknownVerification: number;
  byStatus: { "2xx": number; "3xx": number; "4xx": number; "5xx": number };
  topPaths: PathCount[];
  top404: PathCount[];
  top5xx: PathCount[];
  byDay: { day: string; hits: number }[];
  /** Share of hits whose URL had a query string (0..1, three decimals). */
  parameterShare: number;
  lastSeen: string;
}

/** Most distinct paths remembered per bot (bounded memory); hits on further paths still count everywhere except the path lists. */
export const MAX_PATHS_PER_BOT = 20_000;
const TOP = 20;

interface BotAcc {
  hits: number;
  verified: number;
  unverified: number;
  unknown: number;
  byStatus: BotSummary["byStatus"];
  paths: Map<string, Map<number, number>>;
  pathsCapped: boolean;
  byDay: Map<string, number>;
  withQuery: number;
  lastSeen: number;
}

export interface AggregateOptions {
  /** Only hits at or after this time (ms). */
  since?: number;
  /** Only hits before this time (ms). */
  until?: number;
  /** Only these bots (names from the bot table). Default: all. */
  bots?: ReadonlySet<string>;
  /** Verification of a hit's address for a Google-verifiable bot. Not called for other bots. */
  verify(ip: string): Verification;
}

/** Streaming aggregate: add() each parsed entry, then result(). Memory is bounded by bots × MAX_PATHS_PER_BOT. */
export class LogAggregator {
  private readonly acc = new Map<string, BotAcc>();
  private first: number | null = null;
  private last: number | null = null;
  hits = 0;
  botHits = 0;
  outsideWindow = 0;

  constructor(private readonly opts: AggregateOptions) {}

  add(e: LogEntry): void {
    if ((this.opts.since !== undefined && e.time < this.opts.since) || (this.opts.until !== undefined && e.time >= this.opts.until)) {
      this.outsideWindow++;
      return;
    }
    this.hits++;
    this.first = this.first === null ? e.time : Math.min(this.first, e.time);
    this.last = this.last === null ? e.time : Math.max(this.last, e.time);
    if (!e.userAgent) return;
    const def = matchBot(e.userAgent);
    if (!def || (this.opts.bots && !this.opts.bots.has(def.bot))) return;
    this.botHits++;
    let a = this.acc.get(def.bot);
    if (!a) {
      a = { hits: 0, verified: 0, unverified: 0, unknown: 0, byStatus: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 }, paths: new Map(), pathsCapped: false, byDay: new Map(), withQuery: 0, lastSeen: 0 };
      this.acc.set(def.bot, a);
    }
    a.hits++;
    const v = def.googleVerifiable ? this.opts.verify(e.ip) : "unknown";
    if (v === "verified") a.verified++;
    else if (v === "unverified") a.unverified++;
    else a.unknown++;
    const cls = `${Math.floor(e.status / 100)}xx`;
    if (cls in a.byStatus) a.byStatus[cls as keyof BotSummary["byStatus"]]++;
    if (e.path !== null) {
      let statuses = a.paths.get(e.path);
      if (!statuses && a.paths.size < MAX_PATHS_PER_BOT) a.paths.set(e.path, (statuses = new Map()));
      if (statuses) statuses.set(e.status, (statuses.get(e.status) ?? 0) + 1);
      else a.pathsCapped = true;
    }
    const day = new Date(e.time).toISOString().slice(0, 10);
    a.byDay.set(day, (a.byDay.get(day) ?? 0) + 1);
    if (e.hasQuery) a.withQuery++;
    a.lastSeen = Math.max(a.lastSeen, e.time);
  }

  window(): { start: string | null; end: string | null } {
    return { start: this.first === null ? null : new Date(this.first).toISOString(), end: this.last === null ? null : new Date(this.last).toISOString() };
  }

  /** Bots whose path lists hit MAX_PATHS_PER_BOT. */
  pathsCapped(): string[] {
    return [...this.acc].filter(([, a]) => a.pathsCapped).map(([b]) => b);
  }

  result(): BotSummary[] {
    const out: BotSummary[] = [];
    for (const [bot, a] of this.acc) {
      const family = BOTS.find((b) => b.bot === bot)!.family;
      const rows = [...a.paths].map(([path, statuses]) => {
        let total = 0;
        let topStatus = 0;
        let topCount = -1;
        let n404 = 0;
        let n5xx = 0;
        let top5xx = 0;
        let top5xxCount = -1;
        for (const [st, n] of statuses) {
          total += n;
          if (n > topCount || (n === topCount && st < topStatus)) [topStatus, topCount] = [st, n];
          if (st === 404) n404 += n;
          if (st >= 500 && st < 600) {
            n5xx += n;
            if (n > top5xxCount) [top5xx, top5xxCount] = [st, n];
          }
        }
        return { path, total, topStatus, n404, n5xx, top5xx };
      });
      const top = <T>(list: T[], key: (x: T) => number, map: (x: T) => PathCount) =>
        list.filter((x) => key(x) > 0).sort((x, y) => key(y) - key(x) || map(x).path.localeCompare(map(y).path)).slice(0, TOP).map(map);
      out.push({
        bot,
        family,
        hits: a.hits,
        verified: a.verified,
        unverified: a.unverified,
        unknownVerification: a.unknown,
        byStatus: a.byStatus,
        topPaths: top(rows, (r) => r.total, (r) => ({ path: r.path, hits: r.total, status: r.topStatus })),
        top404: top(rows, (r) => r.n404, (r) => ({ path: r.path, hits: r.n404, status: 404 })),
        top5xx: top(rows, (r) => r.n5xx, (r) => ({ path: r.path, hits: r.n5xx, status: r.top5xx })),
        byDay: [...a.byDay].sort(([x], [y]) => x.localeCompare(y)).map(([day, hits]) => ({ day, hits })),
        parameterShare: Math.round((a.withQuery / a.hits) * 1000) / 1000,
        lastSeen: new Date(a.lastSeen).toISOString(),
      });
    }
    return out.sort((x, y) => y.hits - x.hits || x.bot.localeCompare(y.bot));
  }
}
