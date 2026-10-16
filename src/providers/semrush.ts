/**
 * Semrush client: v4 API only. Semrush's older v3 keys and reports aren't supported.
 *
 * - keyword volume: v4 Get Keyword Metrics (`/apis/v4/keywords/v1/metrics`), one request per keyword, 20 units each
 *   (Early Access per Semrush);
 * - backlinks summary: the v4 Backlinks overview (`/apis/v4/backlinks/v1/overview`), 45 units.
 *
 * Everything else (rankings, competitors, visibility, keyword ideas and gaps, Site Audit) isn't in Semrush's v4 API, so
 * the provider doesn't claim those capabilities and routing sends them to DataForSEO or says why not (seo-data.ts).
 *
 * The key goes in `Authorization: Apikey`, never in a URL. There is no documented free key check: the key is first
 * checked by the first paid call. At most 4 requests in flight and 100 ms between starts (10/s, 10 at once). Errors are
 * never retried, except one retry of a 429. Units are recorded per request; a timeout records the estimate. The pure
 * parts live in ./semrush-shape.ts.
 */
import { env, type Client } from "../config.js";
import { globalUnitCap, recordUnits, unitsThisMonth } from "../lib/budget.js";
import { TTL } from "../lib/cache.js";
import { noCountryMessage } from "../lib/country.js";
import { ProviderUnavailableError } from "../lib/provider-ids.js";
import { createLimiter } from "../lib/rate.js";
import { TIMEOUTS } from "../lib/timeout.js";
import {
  classifySemrushV4Error,
  mapSemrushBacklinksV4,
  mapSemrushKeywordMetricsV4,
  normalizeKeywordList,
  parseSemrushV4Error,
  SEMRUSH_UNITS,
  SEMRUSH_V4_BACKLINK_FIELDS,
  SEMRUSH_V4_METRICS_NOTE,
  type SemrushErrorKind,
} from "./semrush-shape.js";
import type { BacklinksRouted, KeywordVolumeResult, PaidPlan, SeoDataProvider } from "./seo-data.js";
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

const secrets = () => [env.SEMRUSH_API_KEY];

interface Req {
  /** Path under SEMRUSH_BASE_URL, always `/apis/v4/...`. */
  path: string;
  /** Ledger endpoint label, never the URL. */
  label: string;
  params: Record<string, string>;
}

function apiKey(capability: string): string {
  if (!env.SEMRUSH_API_KEY) throw new ProviderUnavailableError(capability, "semrush", "SEMRUSH_API_KEY is not set. Run setup --step semrush.");
  return env.SEMRUSH_API_KEY;
}

/** One request through the limiter; a 429 is retried once. Returns the body text and status. */
async function send(req: Req, key: string, signal?: AbortSignal): Promise<{ status: number; text: string }> {
  const url = `${env.SEMRUSH_BASE_URL}${req.path}?${new URLSearchParams(req.params).toString()}`;
  const headers = { Authorization: `Apikey ${key}`, Accept: "application/json" };
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
        throw new Error(`Couldn't reach Semrush (${req.label}): ${redact(err instanceof Error ? err.message : String(err), secrets())}`);
      }
    });
    const text = await res.text();
    if (res.status === 429 && attempt === 0) {
      await semrushTiming.sleep(retryAfterMs(res.headers.get("retry-after")));
      continue;
    }
    return { status: res.status, text };
  }
}

/**
 * One billed v4 GET (JSON). A timeout records `estimate` and rethrows; an error body is classified; a success records
 * `estimate` against the client's ledger. Returns the parsed body.
 */
async function v4Get(client: Client, req: Req, key: string, estimate: number): Promise<unknown> {
  let res: { status: number; text: string };
  try {
    res = await send(req, key);
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
  recordUnits(client.slug, "semrush", req.label, estimate);
  return json;
}

const meta = (r: { units: number; fromCache: boolean }) => ({ provider: "semrush" as const, costUsd: 0, units: r.units, fromCache: r.fromCache });

// ------------------------------------------------------------------ capabilities

/** Keyword volume via v4 Get Keyword Metrics: one request (20 units) per keyword, one after another. */
export async function semrushKeywordVolume(client: Client, input: string[], opts: { refresh?: boolean } = {}): Promise<KeywordVolumeResult> {
  // Defensive: the routed searchVolume already normalises, but `;` inside an entry would bill extra requests.
  const keywords = normalizeKeywordList(input);
  const key = apiKey("keywordVolume");
  if (!client.country) throw new ProviderUnavailableError("keywordVolume", "semrush", noCountryMessage(client));
  const country = client.country.toUpperCase();
  const perKeyword = SEMRUSH_UNITS.keyword_metrics_v4;
  const r = await unitsCall({
    client,
    provider: "semrush",
    capability: "keywordVolume",
    keyParts: { country: client.country, keywords },
    ttl: TTL.month,
    estimate: perKeyword * keywords.length,
    refresh: opts.refresh,
    run: async () => {
      const result = [];
      let units = 0;
      for (const keyword of keywords) {
        const req: Req = { path: "/apis/v4/keywords/v1/metrics", label: "keywords/v1/metrics", params: { keyword, country } };
        result.push(mapSemrushKeywordMetricsV4(await v4Get(client, req, key, perKeyword), keyword));
        units += perKeyword;
      }
      return { value: { result, notes: [SEMRUSH_V4_METRICS_NOTE] }, units };
    },
  });
  return { ...r.value, ...meta(r) };
}

/** Backlinks via the v4 overview (45 units). */
export async function semrushBacklinksSummary(client: Client, target: string, opts: { refresh?: boolean } = {}): Promise<BacklinksRouted> {
  const key = apiKey("backlinksSummary");
  const estimate = SEMRUSH_UNITS.backlinks_overview_v4;
  const r = await unitsCall({
    client,
    provider: "semrush",
    capability: "backlinksSummary",
    keyParts: { target },
    ttl: TTL.week,
    estimate,
    refresh: opts.refresh,
    run: async () => {
      const req: Req = { path: "/apis/v4/backlinks/v1/overview", label: "backlinks/v1/overview", params: { url: target, scope: "ROOT_DOMAIN", fields: SEMRUSH_V4_BACKLINK_FIELDS.join(",") } };
      const json = await v4Get(client, req, key, estimate);
      return { value: { summary: mapSemrushBacklinksV4(json, target) }, units: estimate };
    },
  });
  return { ...r.value, ...meta(r) };
}

export function planSemrushBacklinksSummary(_client: Client, target: string): PaidPlan {
  const units = SEMRUSH_UNITS.backlinks_overview_v4;
  return { keyParts: { target }, unit: "units", requests: 1, cost: () => units, breakdown: () => `backlinks overview (${units} units)` };
}

export const semrushProvider: SeoDataProvider = {
  id: "semrush",
  capabilities: new Set(["keywordVolume", "backlinksSummary"]),
  configured: () => Boolean(env.SEMRUSH_API_KEY),
  keywordVolume: (c, k, o) => semrushKeywordVolume(c, k, o),
  backlinksSummary: (c, t, o) => semrushBacklinksSummary(c, t, o),
  planBacklinksSummary: (c, t) => planSemrushBacklinksSummary(c, t),
};

/**
 * The `semrush_status` tool: whether the key is set, what it serves, and this month's ledger units. There is no
 * documented free check for a Semrush v4 key and no balance call, so the key is first checked by a paid call. Never a key.
 */
export function semrushStatus() {
  const keySet = Boolean(env.SEMRUSH_API_KEY);
  return {
    keySet,
    keyCheck: "none" as const,
    keyNote: "Semrush has no free key check; the key is checked by the first paid call (keyword volume or backlinks).",
    capabilities: { keywordVolume: keySet, backlinksSummary: keySet },
    notServed: "Rankings, competitors, visibility, keyword ideas, keyword gaps and Site Audit aren't in Semrush's v4 API; DataForSEO or Ahrefs serves them.",
    unitsUsedThisMonth: unitsThisMonth(undefined, "semrush"),
    monthlyUnitCap: globalUnitCap("semrush"),
    defaultClientMonthlyUnits: env.DEFAULT_CLIENT_MONTHLY_SEMRUSH_UNITS,
  };
}
