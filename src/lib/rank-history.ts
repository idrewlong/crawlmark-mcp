/**
 * Stored rank history (Phase 12 B, spec 12.B.2): upserts and reads on the rank_history
 * table. Only a client's tracked keywords are stored (B-D1), normalised the same way
 * clients.yaml stores them. `gsc` rows are Search Console 7-day average positions (free);
 * `serp` rows are live DataForSEO ranks (paid). Nothing here makes a network request.
 */
import { normalizeKeyword } from "./clients.js";
import { db } from "./store.js";

export type RankSource = "serp" | "gsc";

/** Search Console isn't filtered by country, language or device, so its rows use this market. */
export const GSC_MARKET = { market: "all", language: "all", device: "all" } as const;

export interface RankInput {
  keyword: string;
  source: RankSource;
  /** YYYY-MM-DD: the check date (serp) or the window's end date (gsc). */
  day: string;
  /** serp: absolute organic rank; gsc: average position; null = not found within depth / no impressions. */
  rank: number | null;
  url?: string | null;
  depth?: number | null;
  market: string;
  language: string;
  device?: string;
  clicks?: number | null;
  impressions?: number | null;
}

export interface StoredRank {
  keyword: string;
  source: RankSource;
  day: string;
  checkedAt: number;
  rank: number | null;
  url: string | null;
  depth: number | null;
  market: string;
  language: string;
  device: string;
  clicks: number | null;
  impressions: number | null;
}

/** The live SERP depth (dataforseo.ts serp() default); a null live rank means "not in the top 100". */
export const SERP_DEPTH = 100;

/** A live rank row in the client's market (serp() uses its location code and language, desktop). */
export function serpRankRow(client: { locationCode: number; languageCode: string }, keyword: string, day: string, rank: number | null, url: string | null, depth = SERP_DEPTH): RankInput {
  return { keyword, source: "serp", day, rank, url, depth, market: String(client.locationCode), language: client.languageCode, device: "desktop" };
}

/**
 * Store one live rank as a side effect (monthly_report with liveRanks, serp_check): only for a tracked
 * keyword, never a "not found" from a check shallower than SERP_DEPTH, and never failing the caller.
 * Returns whether a row was written.
 */
export function recordLiveRank(
  client: { slug: string; trackedKeywords: readonly string[]; locationCode: number; languageCode: string },
  keyword: string,
  result: { clientRank: number | null; clientUrl: string | null },
  opts: { depth?: number; now?: Date } = {},
): boolean {
  try {
    const depth = opts.depth ?? SERP_DEPTH;
    // R-1: "not found in a shallow check" says nothing about ranks below that depth, and the day's row is keyed
    // without depth, so it would hide a real rank checked earlier that day. Found ranks are kept at any depth.
    if (result.clientRank === null && depth < SERP_DEPTH) return false;
    const day = (opts.now ?? new Date()).toISOString().slice(0, 10);
    return saveRanks(client, [serpRankRow(client, keyword, day, result.clientRank, result.clientUrl, depth)]) > 0;
  } catch (err) {
    console.error(`crawlmark: could not save the live rank to rank history: ${(err as Error).message}`);
    return false;
  }
}

/** The stored form of a keyword (trimmed, lowercased, inner whitespace collapsed), or undefined when empty. */
export const normalizeRankKeyword = (k: string): string | undefined => normalizeKeyword(k);

const upsertStmt = db.prepare(`
  INSERT INTO rank_history (client, keyword, source, day, checked_at, rank, url, depth, market, language, device, clicks, impressions)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (client, keyword, source, day, market, language, device) DO UPDATE SET
    checked_at = excluded.checked_at, rank = excluded.rank, url = excluded.url, depth = excluded.depth,
    clicks = excluded.clicks, impressions = excluded.impressions
`);

const nullable = (v: number | string | null | undefined) => (v === undefined ? null : v);

/**
 * Upsert rank rows for a client (the latest check of a day wins). Rows for keywords the
 * client doesn't track are dropped. Returns the number of rows written. One transaction.
 */
export function saveRanks(client: { slug: string; trackedKeywords: readonly string[] }, rows: readonly RankInput[], now = Date.now()): number {
  const tracked = new Set(client.trackedKeywords.map((k) => normalizeKeyword(k)).filter((k): k is string => Boolean(k)));
  const keep = rows.flatMap((r) => {
    const keyword = normalizeKeyword(r.keyword);
    return keyword && tracked.has(keyword) && /^\d{4}-\d{2}-\d{2}$/.test(r.day) ? [{ ...r, keyword }] : [];
  });
  if (keep.length === 0) return 0;
  db.exec("BEGIN");
  try {
    for (const r of keep) {
      upsertStmt.run(
        client.slug,
        r.keyword,
        r.source,
        r.day,
        now,
        r.rank === null || !Number.isFinite(r.rank) ? null : r.rank,
        nullable(r.url),
        r.depth === undefined || r.depth === null ? null : Math.round(r.depth),
        r.market,
        r.language,
        r.device ?? "desktop",
        r.clicks === undefined || r.clicks === null ? null : Math.round(r.clicks),
        r.impressions === undefined || r.impressions === null ? null : Math.round(r.impressions),
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return keep.length;
}

interface Row {
  keyword: string;
  source: string;
  day: string;
  checked_at: number;
  rank: number | null;
  url: string | null;
  depth: number | null;
  market: string;
  language: string;
  device: string;
  clicks: number | null;
  impressions: number | null;
}

const toStored = (r: Row): StoredRank => ({
  keyword: r.keyword,
  source: r.source as RankSource,
  day: r.day,
  checkedAt: Number(r.checked_at),
  rank: r.rank === null ? null : Number(r.rank),
  url: r.url,
  depth: r.depth === null ? null : Number(r.depth),
  market: r.market,
  language: r.language,
  device: r.device,
  clicks: r.clicks === null ? null : Number(r.clicks),
  impressions: r.impressions === null ? null : Number(r.impressions),
});

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** Stored rows for a client between `since` and `until` (inclusive), oldest first. Optional keyword and source filters. */
export function readRanks(q: { client: string; since: string; until: string; keywords?: readonly string[]; source?: RankSource }): StoredRank[] {
  const params: (string | number)[] = [q.client, q.since, q.until];
  let sql = "SELECT keyword, source, day, checked_at, rank, url, depth, market, language, device, clicks, impressions FROM rank_history WHERE client = ? AND day >= ? AND day <= ?";
  if (q.source) {
    sql += " AND source = ?";
    params.push(q.source);
  }
  if (q.keywords) {
    if (q.keywords.length === 0) return [];
    sql += ` AND keyword IN (${placeholders(q.keywords.length)})`;
    params.push(...q.keywords);
  }
  sql += " ORDER BY keyword, source, day, checked_at";
  return (db.prepare(sql).all(...params) as unknown as Row[]).map(toStored);
}

/**
 * The newest stored row before `beforeDay` for each keyword (one query for the whole list), optionally
 * in one market only. Used for "previous" and the alert rule.
 */
export function previousRanks(q: { client: string; keywords: readonly string[]; source: RankSource; beforeDay: string; market?: string }): Map<string, StoredRank> {
  const out = new Map<string, StoredRank>();
  if (q.keywords.length === 0) return out;
  const params: (string | number)[] = [q.client, q.source, q.beforeDay, ...q.keywords];
  let sql = `SELECT keyword, source, day, checked_at, rank, url, depth, market, language, device, clicks, impressions FROM rank_history
    WHERE client = ? AND source = ? AND day < ? AND keyword IN (${placeholders(q.keywords.length)})`;
  if (q.market !== undefined) {
    sql += " AND market = ?";
    params.push(q.market);
  }
  sql += " ORDER BY day DESC, checked_at DESC";
  for (const r of db.prepare(sql).all(...params) as unknown as Row[]) if (!out.has(r.keyword)) out.set(r.keyword, toStored(r));
  return out;
}

/** Keywords with any stored row for the client in the range (tracked now or not). */
export function storedKeywords(client: string, since: string, until: string): string[] {
  return (db.prepare("SELECT DISTINCT keyword FROM rank_history WHERE client = ? AND day >= ? AND day <= ? ORDER BY keyword").all(client, since, until) as { keyword: string }[]).map((r) => r.keyword);
}
