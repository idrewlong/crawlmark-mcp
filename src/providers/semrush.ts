/**
 * Semrush client (Phase 9): v3 reports (phrase_these, domain_organic,
 * domain_organic_organic), backlinks via the v4 overview when SEMRUSH_V4_API_KEY is set
 * and the v3 backlinks_overview (at /analytics/v1/) otherwise, and the free balance
 * check. Endpoints, parameters, prices and errors follow docs/research/semrush-api.md
 * "Endpoints" (accessed 2026-10-13); the pure parts live in ./semrush-shape.ts.
 *
 * - v3 keys travel in the query string (`key=`), so a request URL is never shown, logged
 *   or put in an error; v4 keys go in `Authorization: Apikey`, never in a URL.
 * - `display_limit` is always sent on domain_organic and domain_organic_organic (unset means
 *   10,000 lines; 100,000 units for domain_organic). phrase_these has no display_limit: it returns
 *   at most one line per keyword sent, so its keyword list is normalised (split on `;` and line
 *   breaks, deduped) before the estimate, the batches and the cache key.
 * - Units are the documented price x lines returned (flat per request for backlinks);
 *   ERROR 50 (nothing found) and empty responses cost 0. A timeout records the estimate.
 * - At most 4 requests in flight and 100 ms between starts (10/s, 10 at once). Errors are
 *   never retried, except one retry of a 429.
 */
import { env, type Client } from "../config.js";
import { globalUnitCap, recordUnits, unitsThisMonth } from "../lib/budget.js";
import { TTL } from "../lib/cache.js";
import { noCountryMessage, semrushDatabase } from "../lib/country.js";
import { ProviderUnavailableError } from "../lib/provider-ids.js";
import { createLimiter } from "../lib/rate.js";
import { TIMEOUTS } from "../lib/timeout.js";
import { mergeGaps } from "../analysis/keyword-gap.js";
import {
  domainVsDomain,
  mapSemrushGapRows,
  mapSemrushIdeas,
  positionHeaderFor,
  classifySemrushError,
  classifySemrushV4Error,
  estimateSemrushUnits,
  mapSemrushBacklinksV3,
  mapSemrushBacklinksV4,
  mapSemrushCompetitors,
  mapSemrushKeywordVolumes,
  mapSemrushRankedKeywords,
  parseSemrushCsv,
  parseSemrushError,
  parseSemrushV4Error,
  normalizeKeywordList,
  parseUnitsBalance,
  partialLinesNote,
  SEMRUSH_COLUMNS,
  SEMRUSH_KEYWORD_BATCH,
  SEMRUSH_UNITS,
  SEMRUSH_V4_BACKLINK_FIELDS,
  SemrushFormatError,
  type SemrushErrorKind,
  type SemrushReport,
} from "./semrush-shape.js";
import type {
  BacklinksRouted,
  CompetitorsRouted,
  KeywordGapRequest,
  KeywordGapRouted,
  KeywordIdeasRequest,
  KeywordIdeasRouted,
  KeywordVolumeResult,
  PaidPlan,
  RankedKeywordsRouted,
  SeoDataProvider,
} from "./seo-data.js";
import { isTimeoutOrAbort, redact, retryAfterMs, unitsCall } from "./units-billing.js";

export class SemrushApiError extends Error {
  override name = "SemrushApiError";
  constructor(
    readonly code: number,
    readonly kind: SemrushErrorKind,
    message: string,
  ) {
    super(message);
  }
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Test seams: the wait before the one 429 retry, and the limiter's start spacing. */
export const semrushTiming = { sleep: realSleep, spacing: realSleep };
/** Shared by every Semrush call in this process: 4 in flight, 100 ms between starts. */
export const semrushLimiter = createLimiter({ maxInFlight: 4, minSpacingMs: 100, sleep: (ms) => semrushTiming.spacing(ms) });

const secrets = () => [env.SEMRUSH_API_KEY, env.SEMRUSH_V4_API_KEY];

interface Req {
  /** Path under SEMRUSH_BASE_URL: `/` for v3 reports, `/analytics/v1/` for v3 backlinks, `/apis/v4/...` for v4. */
  path: string;
  /** Ledger endpoint label (the report type), never the URL. */
  label: string;
  params: Record<string, string>;
  /** v3: the key goes in the query string; v4: in the Authorization header. */
  auth: { v3: string } | { v4: string };
}

/** One request through the limiter; a 429 (HTTP or `ERROR 429`) is retried once. Returns the body text and status. */
async function send(req: Req, signal?: AbortSignal): Promise<{ status: number; text: string }> {
  const params = new URLSearchParams(req.params);
  if ("v3" in req.auth) params.set("key", req.auth.v3);
  const url = `${env.SEMRUSH_BASE_URL}${req.path}?${params.toString()}`;
  const headers: Record<string, string> = "v4" in req.auth ? { Authorization: `Apikey ${req.auth.v4}`, Accept: "application/json" } : {};
  for (let attempt = 0; ; attempt++) {
    const res = await semrushLimiter.run(async () => {
      try {
        return await fetch(url, {
          method: "GET",
          headers,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUTS.networkMs)]) : AbortSignal.timeout(TIMEOUTS.networkMs),
        });
      } catch (err) {
        if (isTimeoutOrAbort(err)) throw err;
        // Never the URL: it carries the v3 key.
        throw new Error(`Couldn't reach Semrush (${req.label}): ${redact(err instanceof Error ? err.message : String(err), secrets())}`);
      }
    });
    const text = await res.text();
    const throttled = res.status === 429 || parseSemrushError(text)?.code === 429;
    if (throttled && attempt === 0) {
      await semrushTiming.sleep(retryAfterMs(res.headers.get("retry-after")));
      continue;
    }
    return { status: res.status, text };
  }
}

function v3Key(capability: string): string {
  if (!env.SEMRUSH_API_KEY) throw new ProviderUnavailableError(capability, "semrush", "SEMRUSH_API_KEY is not set. Run setup --step semrush.");
  return env.SEMRUSH_API_KEY;
}

/** The client's Semrush database, or unavailable (no country, or one Semrush has no documented database for). */
function database(client: Client, capability: string): string {
  if (!client.country) throw new ProviderUnavailableError(capability, "semrush", noCountryMessage(client));
  const db = semrushDatabase(client.country);
  if (!db) throw new ProviderUnavailableError(capability, "semrush", `Semrush has no database for country ${client.country} (${client.domain}); set another country or use a different dataProvider for this client.`);
  return db;
}

/**
 * A billed v3 report. ERROR 50 (nothing found) is an empty result costing 0 units; other
 * ERROR bodies are classified by text whatever the HTTP status (N10). Units are the
 * documented price x lines returned. A timeout records `estimate` and rethrows.
 */
async function v3Report(
  client: Client,
  req: Req,
  columns: readonly string[],
  type: SemrushReport,
  estimate: number,
  db: string | null,
  accept: Readonly<Record<string, (header: string) => boolean>> = {},
): Promise<{ rows: Record<string, string>[]; units: number; nothingFound: boolean }> {
  let res: { status: number; text: string };
  try {
    res = await send(req);
  } catch (err) {
    if (!isTimeoutOrAbort(err)) throw err;
    recordUnits(client.slug, "semrush", `${req.label} (timeout, estimated)`, estimate);
    throw new Error(`Semrush ${req.label} timed out after ${TIMEOUTS.networkMs / 1000}s; Semrush may still have billed it. The estimated ${estimate} units were recorded against the cap.`);
  }
  const err = parseSemrushError(res.text);
  if (err?.code === 50) {
    recordUnits(client.slug, "semrush", req.label, 0);
    return { rows: [], units: 0, nothingFound: true };
  }
  if (err) {
    const info = classifySemrushError({ code: err.code, text: redact(err.text, secrets()) }, db);
    throw new SemrushApiError(err.code, info.kind, info.message);
  }
  if (res.status === 429) {
    const info = classifySemrushError({ code: 429, text: "Too Many Requests" }, db);
    throw new SemrushApiError(429, info.kind, info.message);
  }
  if (res.status >= 400) throw new SemrushApiError(res.status, "server", `Semrush ${req.label} returned HTTP ${res.status}: ${redact(res.text, secrets())}`);
  let rows: Record<string, string>[];
  try {
    rows = parseSemrushCsv(res.text, columns, accept);
  } catch (err) {
    if (!(err instanceof SemrushFormatError)) throw err;
    // R-3: a 2xx answer we can't read was probably billed: the lines it has (minus the header) x the price, else the estimate.
    const lines = res.text.split(/\r?\n/).filter((l) => l.trim() !== "").length - 1;
    recordUnits(client.slug, "semrush", `${req.label} (unreadable body, estimated)`, lines > 0 ? estimateSemrushUnits(type, lines) : estimate);
    throw err;
  }
  const units = estimateSemrushUnits(type, rows.length);
  recordUnits(client.slug, "semrush", req.label, units);
  return { rows, units, nothingFound: false };
}

const meta = (r: { units: number; fromCache: boolean }) => ({ provider: "semrush" as const, costUsd: 0, units: r.units, fromCache: r.fromCache });
const withNotes = (notes: string[]) => (notes.length ? { notes } : {});

// ------------------------------------------------------------------ capabilities

/** Keyword volume via v3 phrase_these (deprecated, D8), in batches of 100 run one after another. */
export async function semrushKeywordVolume(client: Client, input: string[], opts: { refresh?: boolean } = {}): Promise<KeywordVolumeResult> {
  // Defensive: the routed searchVolume already normalises, but `;` inside an entry would bill extra lines.
  const keywords = normalizeKeywordList(input);
  const db = database(client, "keywordVolume");
  const key = v3Key("keywordVolume");
  const batches: string[][] = [];
  for (let i = 0; i < keywords.length; i += SEMRUSH_KEYWORD_BATCH) batches.push(keywords.slice(i, i + SEMRUSH_KEYWORD_BATCH));
  const r = await unitsCall({
    client,
    provider: "semrush",
    capability: "keywordVolume",
    keyParts: { country: client.country, keywords },
    ttl: TTL.month,
    estimate: estimateSemrushUnits("phrase_these", keywords.length),
    refresh: opts.refresh,
    run: async () => {
      const result = [];
      const notes: string[] = [];
      let units = 0;
      for (const batch of batches) {
        const columns = SEMRUSH_COLUMNS.phrase_these;
        const req: Req = { path: "/", label: "phrase_these", auth: { v3: key }, params: { type: "phrase_these", phrase: batch.join(";"), database: db, export_columns: columns.join(",") } };
        const out = await v3Report(client, req, columns, "phrase_these", estimateSemrushUnits("phrase_these", batch.length), db);
        units += out.units;
        result.push(...mapSemrushKeywordVolumes(out.rows, batch));
        const note = out.nothingFound ? undefined : partialLinesNote(out.rows.length, batch.length);
        if (note) notes.push(note);
      }
      return { value: { result, ...withNotes(notes) }, units };
    },
  });
  return { ...r.value, ...meta(r) };
}

/** Ranked keywords via v3 domain_organic, sorted by volume, `display_limit` always set. */
export async function semrushRankedKeywords(client: Client, target: string, limit: number, opts: { refresh?: boolean } = {}): Promise<RankedKeywordsRouted> {
  const db = database(client, "rankedKeywords");
  const key = v3Key("rankedKeywords");
  const estimate = estimateSemrushUnits("domain_organic", limit);
  const r = await unitsCall({
    client,
    provider: "semrush",
    capability: "rankedKeywords",
    keyParts: { target, country: client.country, limit },
    ttl: TTL.week,
    estimate,
    refresh: opts.refresh,
    run: async () => {
      const columns = SEMRUSH_COLUMNS.domain_organic;
      const req: Req = {
        path: "/",
        label: "domain_organic",
        auth: { v3: key },
        params: { type: "domain_organic", domain: target, database: db, export_columns: columns.join(","), display_sort: "nq_desc", display_limit: String(limit) },
      };
      const out = await v3Report(client, req, columns, "domain_organic", estimate, db);
      const note = out.nothingFound ? undefined : partialLinesNote(out.rows.length, limit);
      return { value: { ...mapSemrushRankedKeywords(out.rows, target), ...withNotes(note ? [note] : []) }, units: out.units };
    },
  });
  return { ...r.value, ...meta(r) };
}

/** Organic competitors via v3 domain_organic_organic, sorted by common keywords. */
export async function semrushCompetitorDomains(client: Client, limit: number, opts: { refresh?: boolean } = {}): Promise<CompetitorsRouted> {
  const db = database(client, "competitorDomains");
  const key = v3Key("competitorDomains");
  const target = client.domain;
  const estimate = estimateSemrushUnits("domain_organic_organic", limit);
  const r = await unitsCall({
    client,
    provider: "semrush",
    capability: "competitorDomains",
    keyParts: { target, country: client.country, limit },
    ttl: TTL.month,
    estimate,
    refresh: opts.refresh,
    run: async () => {
      const columns = SEMRUSH_COLUMNS.domain_organic_organic;
      const req: Req = {
        path: "/",
        label: "domain_organic_organic",
        auth: { v3: key },
        params: { type: "domain_organic_organic", domain: target, database: db, export_columns: columns.join(","), display_sort: "np_desc", display_limit: String(limit) },
      };
      const out = await v3Report(client, req, columns, "domain_organic_organic", estimate, db);
      const note = out.nothingFound ? undefined : partialLinesNote(out.rows.length, limit);
      return { value: { ...mapSemrushCompetitors(out.rows, target), ...withNotes(note ? [note] : []) }, units: out.units };
    },
  });
  return { ...r.value, ...meta(r) };
}

/** Backlinks: the v4 overview with SEMRUSH_V4_API_KEY (45 units), else the v3 backlinks_overview (40 units) (D3). */
export async function semrushBacklinksSummary(client: Client, target: string, opts: { refresh?: boolean } = {}): Promise<BacklinksRouted> {
  const v4 = env.SEMRUSH_V4_API_KEY;
  const v3 = v4 ? undefined : v3Key("backlinksSummary");
  const type: SemrushReport = v4 ? "backlinks_overview_v4" : "backlinks_overview_v3";
  const estimate = SEMRUSH_UNITS[type];
  const r = await unitsCall({
    client,
    provider: "semrush",
    capability: "backlinksSummary",
    keyParts: { target, semrushApi: v4 ? "v4" : "v3" },
    ttl: TTL.week,
    estimate,
    refresh: opts.refresh,
    run: async () => {
      if (v4) {
        const req: Req = { path: "/apis/v4/backlinks/v1/overview", label: "backlinks/v1/overview", auth: { v4 }, params: { url: target, scope: "ROOT_DOMAIN", fields: SEMRUSH_V4_BACKLINK_FIELDS.join(",") } };
        let res: { status: number; text: string };
        try {
          res = await send(req);
        } catch (err) {
          if (!isTimeoutOrAbort(err)) throw err;
          recordUnits(client.slug, "semrush", `${req.label} (timeout, estimated)`, estimate);
          throw new Error(`Semrush ${req.label} timed out after ${TIMEOUTS.networkMs / 1000}s; Semrush may still have billed it. The estimated ${estimate} units were recorded against the cap.`);
        }
        let json: unknown;
        try {
          json = JSON.parse(res.text);
        } catch {
          json = null;
        }
        if (res.status >= 400 || (json as { meta?: { success?: unknown } } | null)?.meta?.success === false) {
          const e = parseSemrushV4Error(json);
          const info = classifySemrushV4Error(res.status, e && { code: e.code, message: redact(e.message, secrets()) });
          throw new SemrushApiError(e?.code ?? res.status, info.kind, info.message);
        }
        const units = estimateSemrushUnits(type, 1);
        recordUnits(client.slug, "semrush", req.label, units);
        return { value: { summary: mapSemrushBacklinksV4(json, target) }, units };
      }
      const columns = SEMRUSH_COLUMNS.backlinks_overview;
      const req: Req = {
        path: "/analytics/v1/",
        label: "backlinks_overview",
        auth: { v3: v3! },
        params: { type: "backlinks_overview", target, target_type: "root_domain", export_columns: columns.join(",") },
      };
      // Priced per request: estimateSemrushUnits gives 40 for a returned row and 0 when nothing came back.
      const out = await v3Report(client, req, columns, type, estimate, null);
      return { value: { summary: mapSemrushBacklinksV3(out.rows, target) }, units: out.units };
    },
  });
  return { ...r.value, ...meta(r) };
}

// ------------------------------------------------------------------ keyword ideas and gap (Phase 12 B)

const IDEAS_TYPE = { related: "phrase_related", matching: "phrase_fullsearch" } as const;
const perSeed = (limit: number, seeds: number) => Math.max(1, Math.ceil(limit / Math.max(1, seeds)));
/** Semrush wants bare domains in `domains`. */
const bare = (d: string) => d.replace(/^www\./, "");

export function planSemrushKeywordIdeas(client: Client, req: KeywordIdeasRequest): PaidPlan {
  const db = database(client, "keywordIdeas");
  const type = IDEAS_TYPE[req.mode];
  const n = req.seeds.length;
  return {
    keyParts: { database: db, mode: req.mode, seeds: req.seeds, limit: req.limit },
    unit: "units",
    requests: n,
    cost: (limit) => n * estimateSemrushUnits(type, perSeed(limit, n)),
    breakdown: (limit) => `${n} ${type} request(s) × ${perSeed(limit, n)} lines × ${SEMRUSH_UNITS[type]} units`,
  };
}

/** Keyword ideas: one phrase_related (`related`) or phrase_fullsearch (`matching`) request per seed, display_limit = ceil(limit / seeds), always sent. */
export async function semrushKeywordIdeas(client: Client, req: KeywordIdeasRequest, opts: { refresh?: boolean } = {}): Promise<KeywordIdeasRouted> {
  const plan = planSemrushKeywordIdeas(client, req);
  const db = plan.keyParts.database as string;
  const key = v3Key("keywordIdeas");
  const type = IDEAS_TYPE[req.mode];
  const per = perSeed(req.limit, req.seeds.length);
  const r = await unitsCall({
    client,
    provider: "semrush",
    capability: "keywordIdeas",
    keyParts: plan.keyParts,
    ttl: TTL.week,
    estimate: plan.cost(req.limit),
    refresh: opts.refresh,
    run: async () => {
      const lists = [];
      const notes: string[] = [];
      let units = 0;
      for (const seed of req.seeds) {
        const columns = SEMRUSH_COLUMNS[type];
        const q: Req = { path: "/", label: type, auth: { v3: key }, params: { type, phrase: seed, database: db, export_columns: columns.join(","), display_limit: String(per) } };
        const out = await v3Report(client, q, columns, type, estimateSemrushUnits(type, per), db);
        units += out.units;
        lists.push(mapSemrushIdeas(out.rows, seed));
        const note = out.nothingFound ? undefined : partialLinesNote(out.rows.length, per);
        if (note) notes.push(`${seed}: ${note}`);
      }
      const seen = new Set<string>();
      const ideas = lists.flat().filter((i) => {
        const k = i.keyword.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      return { value: { ideas: ideas.slice(0, req.limit), ...withNotes(notes) }, units };
    },
  });
  return { ...r.value, ...meta(r) };
}

export function planSemrushKeywordGap(client: Client, req: KeywordGapRequest): PaidPlan {
  const db = database(client, "keywordGap");
  const n = req.competitors.length;
  return {
    keyParts: { database: db, target: bare(client.domain), competitors: req.competitors, limit: req.limit },
    unit: "units",
    requests: n,
    cost: (limit) => n * estimateSemrushUnits("domain_domains", limit),
    breakdown: (limit) => `${n} competitor(s) × domain_domains ${limit} lines × ${SEMRUSH_UNITS.domain_domains} units`,
  };
}

/** Keyword gap: one domain_domains (Domain vs Domain) per competitor, `domains = *|or|<competitor>|-|or|<client>`, display_limit = limit. */
export async function semrushKeywordGap(client: Client, req: KeywordGapRequest, opts: { refresh?: boolean } = {}): Promise<KeywordGapRouted> {
  const plan = planSemrushKeywordGap(client, req);
  const db = plan.keyParts.database as string;
  const key = v3Key("keywordGap");
  const target = bare(client.domain);
  const r = await unitsCall({
    client,
    provider: "semrush",
    capability: "keywordGap",
    keyParts: plan.keyParts,
    ttl: TTL.week,
    estimate: plan.cost(req.limit),
    refresh: opts.refresh,
    run: async () => {
      const per = [];
      const notes: string[] = [];
      let units = 0;
      for (const competitor of req.competitors) {
        const columns = SEMRUSH_COLUMNS.domain_domains;
        const q: Req = {
          path: "/",
          label: "domain_domains",
          auth: { v3: key },
          params: { type: "domain_domains", domains: domainVsDomain(bare(competitor), target), database: db, export_columns: columns.join(","), display_sort: "nq_desc", display_limit: String(req.limit) },
        };
        const out = await v3Report(client, q, columns, "domain_domains", estimateSemrushUnits("domain_domains", req.limit), db, {
          P0: positionHeaderFor(bare(competitor), "P0"),
          P1: positionHeaderFor(target, "P1"),
        });
        units += out.units;
        per.push({ domain: competitor, rows: mapSemrushGapRows(out.rows) });
        // B1: fewer lines than display_limit may be a cut-short answer (low balance), or simply all there is.
        const note = out.nothingFound ? undefined : partialLinesNote(out.rows.length, req.limit);
        if (note) notes.push(`${competitor}: ${note}`);
      }
      return { value: { per, notes }, units };
    },
  });
  const merged = mergeGaps(r.value.per, { metric: "semrush_kd", clientCheck: "provider", minVolume: req.minVolume });
  return { gaps: merged.gaps, perCompetitor: merged.perCompetitor, ...withNotes(r.value.notes), ...meta(r) };
}

export const semrushProvider: SeoDataProvider = {
  id: "semrush",
  capabilities: new Set(["keywordVolume", "rankedKeywords", "competitorDomains", "backlinksSummary", "keywordIdeas", "keywordGap"]),
  configured: () => Boolean(env.SEMRUSH_API_KEY),
  planKeywordIdeas: (c, r) => planSemrushKeywordIdeas(c, r),
  keywordIdeas: (c, r, o) => semrushKeywordIdeas(c, r, o),
  planKeywordGap: (c, r) => planSemrushKeywordGap(c, r),
  keywordGap: (c, r, _ctx, o) => semrushKeywordGap(c, r, o),
  keywordVolume: (c, k, o) => semrushKeywordVolume(c, k, o),
  rankedKeywords: (c, t, l, o) => semrushRankedKeywords(c, t, l, o),
  competitorDomains: (c, l, o) => semrushCompetitorDomains(c, l, o),
  backlinksSummary: (c, t, o) => semrushBacklinksSummary(c, t, o),
};

// ------------------------------------------------------------------ balance check (free)

export type SemrushKeyCheck =
  | { configured: true; works: true; reachable: true; unitsLeft: number; error: null; costUsd: 0 }
  | {
      configured: boolean;
      /** false: no key, or Semrush rejected it; null: the balance check couldn't be reached, so the key is untested. */
      works: false | null;
      reachable: boolean;
      /** The ERROR code Semrush answered with, when it did. */
      errorCode?: number;
      error: string;
      costUsd: 0;
    };

/**
 * The free balance check, `GET SEMRUSH_BALANCE_URL?key=` (countapiunits; documented as
 * free). https only (N8; the docs show http and a key is never sent over it). It proves
 * the v3 key exists and shows the balance, not plan access (D4). Never throws; errors
 * never contain the key or the URL.
 */
export async function checkSemrushKey(key: string | undefined, fetchImpl: typeof fetch = fetch): Promise<SemrushKeyCheck> {
  if (!key) return { configured: false, works: false, reachable: true, error: "SEMRUSH_API_KEY is not set.", costUsd: 0 };
  const base = env.SEMRUSH_BALANCE_URL;
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(`${base}?${new URLSearchParams({ key }).toString()}`, { method: "GET", signal: AbortSignal.timeout(TIMEOUTS.networkMs) });
    text = await res.text();
  } catch (err) {
    return { configured: true, works: null, reachable: false, error: `Couldn't reach Semrush's balance check: ${redact(err instanceof Error ? err.message : String(err), [key])}`, costUsd: 0 };
  }
  const e = parseSemrushError(text);
  if (e) {
    const info = classifySemrushError({ code: e.code, text: redact(e.text, [key]) }, null);
    if (info.kind === "auth") return { configured: true, works: false, reachable: true, errorCode: e.code, error: info.message, costUsd: 0 };
    return { configured: true, works: null, reachable: info.kind !== "rate", errorCode: e.code, error: info.message, costUsd: 0 };
  }
  if (res.status === 401 || res.status === 403) return { configured: true, works: false, reachable: true, error: "Semrush rejected the API key (SEMRUSH_API_KEY).", costUsd: 0 };
  if (!res.ok) return { configured: true, works: null, reachable: false, error: `Semrush's balance check returned HTTP ${res.status}.`, costUsd: 0 };
  const units = parseUnitsBalance(text);
  if (units === null) return { configured: true, works: null, reachable: true, error: `Semrush's balance check answered with an unexpected body: ${redact(text, [key], 80)}`, costUsd: 0 };
  return { configured: true, works: true, reachable: true, unitsLeft: units, error: null, costUsd: 0 };
}

/** The `semrush_status` tool: the balance check with the configured v3 key, whether a v4 key is set, and this month's ledger units. Never a key. */
export async function semrushStatus() {
  const check = await checkSemrushKey(env.SEMRUSH_API_KEY);
  return {
    ...check,
    v4KeySet: Boolean(env.SEMRUSH_V4_API_KEY),
    v4KeyNote: env.SEMRUSH_V4_API_KEY ? "The v4 key (backlinks) has no free check; it is checked the first time backlinks_summary runs." : undefined,
    unitsUsedThisMonth: unitsThisMonth(undefined, "semrush"),
    monthlyUnitCap: globalUnitCap("semrush"),
    defaultClientMonthlyUnits: env.DEFAULT_CLIENT_MONTHLY_SEMRUSH_UNITS,
  };
}
