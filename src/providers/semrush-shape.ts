/**
 * Pure Semrush helpers (Phase 9): the v3 CSV parser with header checking, error
 * parsing and classification (v3 `ERROR n :: text` bodies and v4 JSON errors), the
 * balance parser, unit prices and estimates, and mappers to crawlmark's types. No I/O.
 *
 * Source of truth: docs/research/semrush-api.md (Semrush developer docs, accessed
 * 2026-10-13). Column codes and header texts, report prices, error codes and the
 * database list come from there; items under its "Not confirmed" take the spec's safe
 * reading (specs/2026-10-13-1500-phase-9-seo-data-providers.md 9.11 N7-N15), marked below.
 */
import type { KeywordVolume } from "./dataforseo.js";
import type { BacklinksSummary, CompetitorsResult, RankedKeywordsResult } from "./dataforseo-shape.js";

// ------------------------------------------------------------------ columns and prices

/** v3 column code -> the display-name header Semrush returns for it ("Column names can't be changed"). */
export const SEMRUSH_HEADER_TEXT: Readonly<Record<string, string>> = {
  Ph: "Keyword",
  Nq: "Search Volume",
  Cp: "CPC",
  Co: "Competition",
  Nr: "Number of Results",
  Td: "Trends",
  Po: "Position",
  Pp: "Previous Position",
  Pd: "Position Difference",
  Ur: "Url",
  Tr: "Traffic (%)",
  Tg: "Traffic",
  Tc: "Traffic Cost (%)",
  Dn: "Domain",
  Cr: "Competitor Relevance",
  Np: "Common Keywords",
  Or: "Organic Keywords",
  Ot: "Organic Traffic",
  Oc: "Organic Cost",
  Ad: "Adwords Keywords",
  // v3 backlinks_overview returns its export_columns names as the header.
  ascore: "ascore",
  total: "total",
  domains_num: "domains_num",
};

export const SEMRUSH_COLUMNS = {
  phrase_these: ["Ph", "Nq", "Cp", "Co"],
  /** Tg is estimated traffic (visits); Tr is a percentage share and is never requested. */
  domain_organic: ["Ph", "Po", "Nq", "Ur", "Tg"],
  domain_organic_organic: ["Dn", "Np", "Ot"],
  backlinks_overview: ["ascore", "total", "domains_num"],
} as const;

export const SEMRUSH_V4_BACKLINK_FIELDS = ["backlinks_count", "domains_count", "new_count", "lost_count", "score"] as const;

/** Documented prices: per line returned for the reports, per request for the backlinks overviews. */
export const SEMRUSH_UNITS = {
  phrase_these: 10,
  domain_organic: 10,
  domain_organic_organic: 40,
  backlinks_overview_v4: 45,
  backlinks_overview_v3: 40,
} as const;
export type SemrushReport = keyof typeof SEMRUSH_UNITS;

const PER_REQUEST: ReadonlySet<SemrushReport> = new Set(["backlinks_overview_v4", "backlinks_overview_v3"]);

/** Units for `lines` returned (per-line reports) or one request (backlinks). Empty responses cost nothing. */
export function estimateSemrushUnits(type: SemrushReport, lines: number): number {
  if (PER_REQUEST.has(type)) return lines > 0 ? SEMRUSH_UNITS[type] : 0;
  return SEMRUSH_UNITS[type] * Math.max(0, lines);
}

/**
 * A keyword list made safe to price and send: entries split on `;` (Semrush's phrase separator)
 * and line breaks, trimmed, empties dropped and exact duplicates removed. Estimates, batches and
 * cache keys all use this list, so one entry can't smuggle in extra billed keywords.
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

/** Keywords per phrase_these request ("up to 100 keywords"). */
export const SEMRUSH_KEYWORD_BATCH = 100;

// ------------------------------------------------------------------ CSV

export class SemrushFormatError extends Error {
  override name = "SemrushFormatError";
}

/** Split one CSV line on `;`, honouring double-quoted fields (export_escape=1, with "" as an escaped quote). */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"' && cur === "") quoted = true;
    else if (ch === ";") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Parse a v3 report: semicolon-separated, header row first (display names, not codes).
 * Columns are mapped by the position of the `exportColumns` crawlmark sent, and each
 * header cell is checked against SEMRUSH_HEADER_TEXT, so a changed format is a
 * SemrushFormatError, never a silent mis-map. Commas inside a field (the Trends
 * value), CRLF, a trailing newline and quoted fields are fine. Extra trailing columns are ignored.
 */
export function parseSemrushCsv(text: string, exportColumns: readonly string[]): Record<string, string>[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const header = splitLine(lines[0]!).map((h) => h.trim());
  exportColumns.forEach((code, i) => {
    const want = SEMRUSH_HEADER_TEXT[code];
    if (want === undefined) throw new SemrushFormatError(`Unknown Semrush column code ${code}.`);
    if (header[i] !== want) {
      throw new SemrushFormatError(`Semrush returned an unexpected header: column ${i + 1} is ${JSON.stringify(header[i] ?? "(missing)")}, expected ${JSON.stringify(want)} for ${code}.`);
    }
  });
  return lines.slice(1).map((line) => {
    const cells = splitLine(line);
    return Object.fromEntries(exportColumns.map((code, i) => [code, (cells[i] ?? "").trim()]));
  });
}

// ------------------------------------------------------------------ errors

export interface SemrushApiErrorInfo {
  code: number;
  text: string;
}

/** A v3 error body, `ERROR <n> :: <text>` (whatever the HTTP status: N10), else null. */
export function parseSemrushError(text: string): SemrushApiErrorInfo | null {
  const m = /^\s*ERROR (\d+) :: (.*)/s.exec(text);
  return m ? { code: Number(m[1]), text: m[2]!.trim() } : null;
}

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

export type SemrushErrorKind = "auth" | "disabled" | "balance" | "rate" | "database" | "request" | "server";

const KEY_REJECTED = "Semrush rejected the API key (SEMRUSH_API_KEY, or SEMRUSH_V4_API_KEY for v4 calls).";
const DISABLED = "Semrush API is not enabled for this account or report (needs an SEO Business plan plus an API unit package).";
const ZERO_BALANCE = "Semrush API units balance is zero; buy units under Subscription info > API units.";
const RATE = "Semrush request limit hit (10 requests/s, 10 at once); try again shortly.";

/** The user-facing message for a v3 error code (spec 9.2). `text` is already redacted. */
export function classifySemrushError(e: SemrushApiErrorInfo, database: string | null): { kind: SemrushErrorKind; message: string } {
  const c = e.code;
  if (c === 110 || c === 120 || c === 402) return { kind: "auth", message: KEY_REJECTED };
  if (c === 130 || c === 135) return { kind: "disabled", message: DISABLED };
  if (c === 132) return { kind: "balance", message: ZERO_BALANCE };
  if (c === 131 || c === 134 || c === 429) return { kind: "rate", message: RATE };
  if (c === 133) return { kind: "database", message: `Semrush denied access to database ${database ?? "(unknown)"} on this plan.` };
  if ((c >= 40 && c <= 46) || (c >= 10000 && c <= 10040) || c === 605 || c === 613) {
    return { kind: "request", message: `Semrush rejected the request (${c}: ${e.text}). This is likely a crawlmark bug; please report it.` };
  }
  return { kind: "server", message: `Semrush error ${c}: ${e.text}` };
}

/**
 * A v4 error (HTTP status plus the JSON body). N11: how ERROR 132 shows up on v4 isn't
 * documented, so error.code 132, or a 403 whose message mentions units, is the zero balance;
 * any other 403 is "not enabled".
 */
export function classifySemrushV4Error(status: number, body: { code: number; message: string } | null): { kind: SemrushErrorKind; message: string } {
  const code = body?.code ?? status;
  const message = body?.message ?? "";
  if (code === 132 || (status === 403 && /unit/i.test(message))) return { kind: "balance", message: ZERO_BALANCE };
  if (status === 401 || code === 401) return { kind: "auth", message: KEY_REJECTED };
  if (status === 403 || code === 403) return { kind: "disabled", message: DISABLED };
  if (status === 429 || code === 429) return { kind: "rate", message: RATE };
  if (status === 400 || status === 404 || status === 409) {
    return { kind: "request", message: `Semrush rejected the request (${code}: ${message || `HTTP ${status}`}). This is likely a crawlmark bug; please report it.` };
  }
  return { kind: "server", message: `Semrush v4 error ${code}: ${message || `HTTP ${status}`}` };
}

/** The countapiunits body: a number with thousands separators and whitespace (N9), e.g. `1,000\n` -> 1000. Null if it isn't one. */
export function parseUnitsBalance(text: string): number | null {
  const t = text.replace(/[\s,]/g, "");
  return /^\d+$/.test(t) ? Number(t) : null;
}

// ------------------------------------------------------------------ mappers

const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: string | undefined): string | null => (v && v.trim() !== "" ? v.trim() : null);

/** Co (0-1 competitive density) -> LOW (< 0.34), MEDIUM (< 0.67), HIGH. */
export function competitionLevel(co: number | null): "LOW" | "MEDIUM" | "HIGH" | null {
  if (co === null) return null;
  return co < 0.34 ? "LOW" : co < 0.67 ? "MEDIUM" : "HIGH";
}

/** phrase_these rows -> KeywordVolume, in request order; a keyword with no line comes back with nulls (N13). Cp is already USD. */
export function mapSemrushKeywordVolumes(rows: Record<string, string>[], requested: readonly string[]): KeywordVolume[] {
  const byKey = new Map<string, KeywordVolume>();
  for (const r of rows) {
    const keyword = str(r.Ph);
    if (!keyword) continue;
    byKey.set(keyword.toLowerCase(), { keyword, search_volume: num(r.Nq), competition: competitionLevel(num(r.Co)), cpc: num(r.Cp) });
  }
  return requested.map((k) => byKey.get(k.toLowerCase()) ?? { keyword: k, search_volume: null, competition: null, cpc: null });
}

/** domain_organic rows -> RankedKeywordsResult. Position 0 means not ranked (null). Tg is the traffic estimate. */
export function mapSemrushRankedKeywords(rows: Record<string, string>[], target: string): RankedKeywordsResult {
  const items = rows.flatMap((r) => {
    const keyword = str(r.Ph);
    const pos = num(r.Po);
    return keyword ? [{ keyword, position: pos === 0 ? null : pos, searchVolume: num(r.Nq), url: str(r.Ur), estimatedTraffic: num(r.Tg) }] : [];
  });
  return { target, totalCount: items.length, items };
}

/** domain_organic_organic rows -> CompetitorsResult (avgPosition null). */
export function mapSemrushCompetitors(rows: Record<string, string>[], target: string): CompetitorsResult {
  const items = rows.flatMap((r) => {
    const domain = str(r.Dn);
    return domain ? [{ domain, intersectingKeywords: num(r.Np), avgPosition: null, estimatedTraffic: num(r.Ot) }] : [];
  });
  return { target, totalCount: items.length, items };
}

type SemrushAuthority = { authority: { metric: "semrush_score"; value: number | null } };

const jnum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

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

/** v3 backlinks_overview row -> BacklinksSummary (no new/lost in v3; `ascore` as semrush_score). Null when there is no row. */
export function mapSemrushBacklinksV3(rows: Record<string, string>[], target: string): (BacklinksSummary & SemrushAuthority) | null {
  const r = rows[0];
  if (!r) return null;
  return {
    target,
    backlinks: num(r.total),
    referringDomains: num(r.domains_num),
    rank: null,
    spamScore: null,
    newBacklinks: null,
    lostBacklinks: null,
    authority: { metric: "semrush_score", value: num(r.ascore) },
  };
}

/** D13: a per-line report shorter than requested may have been cut short by a low balance. */
export function partialLinesNote(returned: number, requested: number): string | undefined {
  return returned < requested
    ? `Semrush returned ${returned} of ${requested} requested lines; if your unit balance is low, results may be cut short (semrush_status shows the balance).`
    : undefined;
}
