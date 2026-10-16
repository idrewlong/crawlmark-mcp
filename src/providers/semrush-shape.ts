/**
 * Pure Semrush helpers: v4 error parsing and classification, unit prices, and mappers from the v4 JSON
 * responses (Get Keyword Metrics, Backlinks overview) to crawlmark's types. No I/O. crawlmark uses Semrush's
 * v4 API only; Semrush's older v3 keys and reports aren't supported.
 */
import type { KeywordVolume } from "./dataforseo.js";
import type { BacklinksSummary } from "./dataforseo-shape.js";

export const SEMRUSH_V4_BACKLINK_FIELDS = ["backlinks_count", "domains_count", "new_count", "lost_count", "score"] as const;

/** Documented prices per request: the v4 backlinks overview and v4 Get Keyword Metrics (one keyword each). */
export const SEMRUSH_UNITS = {
  backlinks_overview_v4: 45,
  keyword_metrics_v4: 20,
} as const;

/**
 * A keyword list made safe to price and send: entries split on `;` and line breaks, trimmed, empties dropped and exact
 * duplicates removed. Estimates, requests and cache keys all use this list, so one entry can't smuggle in extra billed
 * keywords. (Shared with Ahrefs.)
 */
export function normalizeKeywordList(keywords: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of keywords) {
    for (const part of k.split(/[;\r\n]/)) {
      const t = part.replace(/\s+/g, " ").trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ errors

/** A v4 JSON error body: `{ meta, error: { code, message, retryable } }`, else null. */
export function parseSemrushV4Error(json: unknown): { code: number; message: string; retryable: boolean; status: number | null } | null {
  const j = json as { meta?: { status_code?: unknown }; error?: { code?: unknown; message?: unknown; retryable?: unknown } } | null;
  if (!j || typeof j !== "object" || !j.error || typeof j.error !== "object") return null;
  const code = typeof j.error.code === "number" ? j.error.code : Number(j.error.code);
  return {
    code: Number.isFinite(code) ? code : 0,
    message: typeof j.error.message === "string" ? j.error.message : "",
    retryable: j.error.retryable === true,
    status: typeof j.meta?.status_code === "number" ? j.meta.status_code : null,
  };
}

export type SemrushErrorKind = "auth" | "balance" | "rate" | "request" | "server";

export const KEY_REJECTED =
  "Semrush rejected the API key. crawlmark uses Semrush's v4 API: create a key under your profile > API keys and run setup --step semrush.";
const ZERO_BALANCE = "Semrush API units balance is zero; check your units under Subscription info > API units.";
const RATE = "Semrush request limit hit (10 requests/s, 10 at once); try again shortly.";

/**
 * A v4 error (HTTP status plus the JSON body). How a zero balance shows up on v4 isn't documented, so error.code 132,
 * or a 403 whose message mentions units, is the zero balance; 401 and any other 403 are a rejected key.
 */
export function classifySemrushV4Error(status: number, body: { code: number; message: string } | null): { kind: SemrushErrorKind; message: string } {
  const code = body?.code ?? status;
  const message = body?.message ?? "";
  if (code === 132 || (status === 403 && /unit/i.test(message))) return { kind: "balance", message: ZERO_BALANCE };
  if (status === 401 || status === 403 || code === 401 || code === 403) return { kind: "auth", message: KEY_REJECTED };
  if (status === 429 || code === 429) return { kind: "rate", message: RATE };
  if (status === 400 || status === 404 || status === 409) {
    return { kind: "request", message: `Semrush rejected the request (${code}: ${message || `HTTP ${status}`}). This is likely a crawlmark bug; please report it.` };
  }
  return { kind: "server", message: `Semrush v4 error ${code}: ${message || `HTTP ${status}`}` };
}

// ------------------------------------------------------------------ mappers

/** Co / competitive density (0-1) -> LOW (< 0.34), MEDIUM (< 0.67), HIGH. */
export function competitionLevel(co: number | null): "LOW" | "MEDIUM" | "HIGH" | null {
  if (co === null) return null;
  return co < 0.34 ? "LOW" : co < 0.67 ? "MEDIUM" : "HIGH";
}

type SemrushAuthority = { authority: { metric: "semrush_score"; value: number | null } };

const jnum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** Sent with v4 keyword metrics: cpc's unit and competitive_density's scale aren't documented. */
export const SEMRUSH_V4_METRICS_NOTE =
  "Semrush v4 keyword metrics are Early Access. cpc is passed through as Semrush returns it (its unit isn't documented; the sample value 1245 may be cents), and competition is derived from competitive_density read as 0-100 (also undocumented).";

/** v4 Get Keyword Metrics response -> KeywordVolume (search_volume and cpc arrive as strings). */
export function mapSemrushKeywordMetricsV4(json: unknown, keyword: string): KeywordVolume {
  const d = ((json as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
  const density = jnum(d.competitive_density);
  return { keyword, search_volume: jnum(d.search_volume), competition: competitionLevel(density === null ? null : density / 100), cpc: jnum(d.cpc) };
}

/** v4 backlinks overview `data` -> BacklinksSummary (new/lost from new_count/lost_count; `score` as semrush_score). */
export function mapSemrushBacklinksV4(json: unknown, target: string): BacklinksSummary & SemrushAuthority {
  const d = ((json as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
  return {
    target,
    backlinks: jnum(d.backlinks_count),
    referringDomains: jnum(d.domains_count),
    rank: null,
    spamScore: null,
    newBacklinks: jnum(d.new_count),
    lostBacklinks: jnum(d.lost_count),
    authority: { metric: "semrush_score", value: jnum(d.score) },
  };
}
