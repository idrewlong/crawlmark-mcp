/**
 * CrUX History API client (Phase 12 A, D11): weekly real-user Core Web Vitals
 * (75th percentile) for an origin or URL, up to 40 periods. Free with a Google
 * Cloud key that has the Chrome UX Report API enabled: CRUX_API_KEY, else
 * PSI_API_KEY. The key travels only in the request URL; it is never part of a
 * cache key, an error, a log line or a result. Cached a day (the data changes weekly).
 */
import { cliHint } from "../lib/cli-hint.js";
import { env, type Client } from "../config.js";
import { ALL_CRUX_METRICS, CRUX_METRICS, parseCruxHistory, type CruxHistoryResponse } from "../analysis/crux.js";
import { cached, cacheKey, TTL } from "../lib/cache.js";
import { ProviderUnavailableError } from "../lib/provider-ids.js";
import { TIMEOUTS } from "../lib/timeout.js";
import type { CruxHistoryResult, CwvMetric } from "../reports/report-types.js";
import { redact } from "./units-billing.js";

export type CruxFormFactor = "PHONE" | "DESKTOP" | "TABLET" | "ALL";

export interface CruxRequest {
  origin?: string | undefined;
  url?: string | undefined;
  formFactor?: CruxFormFactor | undefined;
  weeks?: number | undefined;
  metrics?: CwvMetric[] | undefined;
}

export const cruxSetupHint = (): string => `Run ${cliHint()} setup --step crux.`;
export const noCruxKey = (): string =>
  `CrUX History needs CRUX_API_KEY (or a PSI_API_KEY whose Google Cloud project has the Chrome UX Report API enabled). ${cruxSetupHint()}`;

/** No usable key, or the key's project can't use the CrUX API: the data is unavailable, not failed. */
export class CruxUnavailableError extends ProviderUnavailableError {
  override name = "CruxUnavailableError";
  constructor(message: string) {
    super("cruxHistory", null, message);
  }
}

export function cruxKey(e: { CRUX_API_KEY?: string | undefined; PSI_API_KEY?: string | undefined } = env): { key: string; source: "CRUX_API_KEY" | "PSI_API_KEY" } | undefined {
  if (e.CRUX_API_KEY) return { key: e.CRUX_API_KEY, source: "CRUX_API_KEY" };
  if (e.PSI_API_KEY) return { key: e.PSI_API_KEY, source: "PSI_API_KEY" };
  return undefined;
}

/** The client's origin: https://<domain>, or https://www.<domain> when its key pages use www. */
export function clientOrigin(client: Pick<Client, "domain" | "keyPages">): string {
  const www = client.keyPages.some((u) => {
    try {
      return new URL(u).hostname.toLowerCase() === `www.${client.domain}`;
    } catch {
      return false;
    }
  });
  return `https://${www ? "www." : ""}${client.domain}`;
}

/** Classify an error response. Pure. The text is redacted by the caller. */
export function cruxErrorMessage(status: number, body: string, keySource: "CRUX_API_KEY" | "PSI_API_KEY"): { unavailable: boolean; message: string } {
  if (/API_KEY_INVALID|API key not valid|keyInvalid/i.test(body)) {
    return { unavailable: true, message: `Google says the ${keySource} isn't a valid key. ${cruxSetupHint()}` };
  }
  if (status === 403 && /SERVICE_DISABLED|accessNotConfigured|has not been used|is disabled|chromeuxreport/i.test(body)) {
    return { unavailable: true, message: `${noCruxKey()} The ${keySource} project can't use it yet: enable the Chrome UX Report API at https://console.cloud.google.com/apis/library/chromeuxreport.googleapis.com.` };
  }
  if (status === 403 && /API_KEY_SERVICE_BLOCKED|blocked/i.test(body)) {
    return { unavailable: true, message: `The ${keySource} is restricted to other APIs; allow the Chrome UX Report API on it (APIs & Services > Credentials). ${cruxSetupHint()}` };
  }
  if (status === 429) return { unavailable: false, message: "CrUX API quota exceeded (150 queries a minute per Google Cloud project). Try again in a minute." };
  return { unavailable: false, message: `CrUX API returned HTTP ${status}.` };
}

const NOT_FOUND = (what: string, ff: string) => `The Chrome UX Report has no data for ${what} (${ff.toLowerCase()}): not enough real-user traffic in Chrome.`;

export async function cruxHistory(req: CruxRequest, opts: { fetchImpl?: typeof fetch; refresh?: boolean; e?: Parameters<typeof cruxKey>[0] } = {}): Promise<CruxHistoryResult> {
  if ((req.origin === undefined) === (req.url === undefined)) throw new Error("Give exactly one of origin or url.");
  const k = cruxKey(opts.e ?? env);
  if (!k) throw new CruxUnavailableError(noCruxKey());
  const formFactor = req.formFactor ?? "PHONE";
  const weeks = Math.min(40, Math.max(1, Math.round(req.weeks ?? 25)));
  const metrics = req.metrics?.length ? [...new Set(req.metrics)] : ALL_CRUX_METRICS;
  const origin = req.origin?.replace(/\/+$/, "");
  const target = origin ? { origin } : { url: req.url! };
  const keyObj = { ...target, formFactor };
  const fetchImpl = opts.fetchImpl ?? fetch;

  const { value, fromCache } = await cached(
    // The key is deliberately not part of the cache key.
    cacheKey("crux-history", target, formFactor, weeks, metrics),
    TTL.day,
    async (): Promise<CruxHistoryResult> => {
      const body = { ...target, ...(formFactor === "ALL" ? {} : { formFactor }), metrics: metrics.map((m) => CRUX_METRICS[m].api), collectionPeriodCount: weeks };
      let res: Response;
      try {
        res = await fetchImpl(`${env.CRUX_BASE_URL}/records:queryHistoryRecord?key=${encodeURIComponent(k.key)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUTS.networkMs),
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : "Error";
        throw new Error(`Couldn't reach the CrUX API (${name === "TimeoutError" ? "timed out" : redact(err instanceof Error ? err.message : String(err), [k.key], 120)}).`);
      }
      const text = await res.text();
      if (res.status === 404) return { key: keyObj, keySource: k.source, available: false, reason: NOT_FOUND(origin ?? req.url!, formFactor) };
      if (!res.ok) {
        const c = cruxErrorMessage(res.status, redact(text, [k.key], 2000), k.source);
        throw c.unavailable ? new CruxUnavailableError(c.message) : new Error(c.message);
      }
      let json: CruxHistoryResponse;
      try {
        json = JSON.parse(text) as CruxHistoryResponse;
      } catch {
        throw new Error("The CrUX API returned something that isn't JSON.");
      }
      return parseCruxHistory(json, { ...target, formFactor, metrics }, k.source);
    },
    { refresh: opts.refresh ?? false },
  );
  return { ...value, ...(value.available ? { fromCache } : {}) };
}

/**
 * One free History query for a public origin (https://developer.chrome.com; no client data) to check a key.
 * The key is never in the result.
 */
export async function checkCruxKey(key: string, fetchImpl: typeof fetch = fetch, source: "CRUX_API_KEY" | "PSI_API_KEY" = "CRUX_API_KEY"): Promise<{ ok: true } | { ok: false; problem: string }> {
  try {
    const res = await fetchImpl(`${env.CRUX_BASE_URL}/records:queryHistoryRecord?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: "https://developer.chrome.com", formFactor: "PHONE", metrics: ["largest_contentful_paint"], collectionPeriodCount: 1 }),
      signal: AbortSignal.timeout(TIMEOUTS.networkMs),
    });
    if (res.ok || res.status === 404) return { ok: true };
    return { ok: false, problem: cruxErrorMessage(res.status, redact(await res.text(), [key], 2000), source).message };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return { ok: false, problem: `Couldn't reach the CrUX API (${name === "TimeoutError" ? "timed out" : name}). Check your connection and try again.` };
  }
}
