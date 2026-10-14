import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";
import { env } from "../config.js";
import { cached, cacheKey, TTL } from "../lib/cache.js";
import { TIMEOUTS } from "../lib/timeout.js";
import { assertSafeUrlResolved } from "../lib/url-guard.js";
import { assertAllowedByPolicy, clientDomainPolicy } from "../user-url.js";
import { lighthouseLaunchOptions, withChrome } from "./browser.js";

export type FormFactor = "mobile" | "desktop";

export interface LighthouseResult {
  url: string;
  formFactor: FormFactor;
  scores: { performance: number; accessibility: number; bestPractices: number; seo: number };
  /** Lab metrics from this run. */
  lab: { lcpMs: number; cls: number; tbtMs: number; fcpMs: number; speedIndexMs: number };
  /** Real-user (CrUX) p75 field data, only when PSI_API_KEY is set and the URL has enough traffic. */
  field?: { lcpMs?: number; inpMs?: number; cls?: number; overall?: string };
  /** Failing audits worth acting on, worst first. */
  opportunities: { id: string; title: string; savingsMs?: number }[];
}

const score = (v: number | null | undefined) => Math.round((v ?? 0) * 100);

/**
 * Run Lighthouse locally in headless Chrome (behind the egress proxy). Lab data only,
 * free. The chrome-launcher instance is killed on success, error, timeout or abort.
 */
export async function runLighthouse(
  url: string,
  formFactor: FormFactor = "mobile",
  opts: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<LighthouseResult> {
  await assertSafeUrlResolved(url);
  const policy = await clientDomainPolicy();
  const key = cacheKey("lighthouse", url, formFactor);
  const compute = async () => {
    const launchOpts = await lighthouseLaunchOptions();
    return withChrome(`Lighthouse on ${url}`, opts.signal, () => chromeLauncher.launch(launchOpts), (c) => c.kill(), async (chrome) => {
      const runner = await lighthouse(
        url,
        {
          port: chrome.port,
          output: "json",
          logLevel: "error",
          onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
        },
        formFactor === "desktop"
          ? { extends: "lighthouse:default", settings: { formFactor: "desktop", screenEmulation: { disabled: true } } }
          : undefined,
      );
      if (!runner) throw new Error(`Lighthouse returned no result for ${url}`);
      const { lhr } = runner;
      // RESTRICT_TO_CLIENT_DOMAINS: a page that redirected off the client's domains isn't reported on.
      assertAllowedByPolicy(policy, lhr.finalDisplayedUrl ?? lhr.finalUrl ?? url);
      const num = (id: string) => Math.round(lhr.audits[id]?.numericValue ?? 0);

      const opportunities = Object.values(lhr.audits)
        .filter((a) => a.details?.type === "opportunity" && (a.score ?? 1) < 0.9)
        .map((a) => ({
          id: a.id,
          title: a.title,
          savingsMs: (a.details as { overallSavingsMs?: number }).overallSavingsMs,
        }))
        .sort((a, b) => (b.savingsMs ?? 0) - (a.savingsMs ?? 0))
        .slice(0, 8);

      const result: LighthouseResult & { finalUrl?: string } = {
        finalUrl: lhr.finalDisplayedUrl ?? lhr.finalUrl ?? url,
        url,
        formFactor,
        scores: {
          performance: score(lhr.categories.performance?.score),
          accessibility: score(lhr.categories.accessibility?.score),
          bestPractices: score(lhr.categories["best-practices"]?.score),
          seo: score(lhr.categories.seo?.score),
        },
        lab: {
          lcpMs: num("largest-contentful-paint"),
          cls: Number((lhr.audits["cumulative-layout-shift"]?.numericValue ?? 0).toFixed(3)),
          tbtMs: num("total-blocking-time"),
          fcpMs: num("first-contentful-paint"),
          speedIndexMs: num("speed-index"),
        },
        opportunities,
      };
      return result;
    });
  };
  const first = await cached(key, TTL.day, compute, { refresh: opts.refresh });
  let cachedValue = first.value;
  // An entry cached before the final URL was stored, under a restriction, can't be vouched for: run it again.
  if (policy && cachedValue.finalUrl === undefined) cachedValue = (await cached(key, TTL.day, compute, { refresh: true })).value;
  // Also for an answer cached before the restriction was on.
  assertAllowedByPolicy(policy, cachedValue.finalUrl ?? url);
  const { finalUrl: _finalUrl, ...value } = cachedValue;

  if (env.PSI_API_KEY) value.field = await fetchFieldData(url, formFactor);
  return value;
}

interface CruxMetric {
  percentile?: number;
}

/** Real-user Core Web Vitals from the PageSpeed Insights API (CrUX). Free with an API key. */
async function fetchFieldData(url: string, formFactor: FormFactor): Promise<LighthouseResult["field"]> {
  const { value } = await cached(cacheKey("crux", url, formFactor), TTL.week, async () => {
    const qs = new URLSearchParams({
      url,
      strategy: formFactor.toUpperCase(),
      category: "PERFORMANCE",
      key: env.PSI_API_KEY!,
    });
    const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${qs}`, {
      signal: AbortSignal.timeout(TIMEOUTS.networkMs),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as {
      loadingExperience?: { overall_category?: string; metrics?: Record<string, CruxMetric> };
    };
    const m = json.loadingExperience?.metrics;
    if (!m) return undefined;
    return {
      lcpMs: m.LARGEST_CONTENTFUL_PAINT_MS?.percentile,
      inpMs: m.INTERACTION_TO_NEXT_PAINT?.percentile,
      cls: m.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile !== undefined
        ? m.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100
        : undefined,
      overall: json.loadingExperience?.overall_category,
    };
  });
  return value;
}
