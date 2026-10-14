/**
 * Deterministic Search Console, GA4 and audit data for the report tests (Phase 12 A): the
 * monthly_report golden test, runTemplate and the renderers. example.com only.
 * Keyed by date range so the current month, previous month and same month last year differ.
 */
import type { StoredAudit } from "../../../src/analysis/diff.js";
import type { Finding } from "../../../src/analysis/findings.js";
import type { GscQueryOptions, GscRow } from "../../../src/providers/gsc.js";

export const CLIENT = {
  slug: "example.com",
  name: "Example Co",
  domain: "example.com",
  gscProperty: "sc-domain:example.com",
  ga4PropertyId: "123456",
  sources: ["yaml"],
  aliases: [],
  brandTerms: ["example co"],
  brandTermEntries: [],
  trackedKeywords: ["emergency plumber", "example co", "water heater repair"],
  keywordEntries: [],
  competitors: [],
  competitorEntries: [],
  keyPages: ["https://example.com/"],
  alternates: { gsc: [], ga4: [] },
  locationCode: 2840,
  languageCode: "en",
  monthlyBudgetUsd: 5,
  monthlyUnits: { ahrefs: 10000, semrush: 5000 },
  country: "US",
} as const;

const row = (keys: string[], clicks: number, impressions: number, position: number): GscRow => ({
  keys,
  clicks,
  impressions,
  ctr: impressions ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
  position,
});

/** Multiplier per period: current, previous month, same month last year. */
const SCALE: Record<string, number> = { "2026-09-01": 1, "2026-08-01": 0.85, "2025-09-01": 0.6, "2026-07-01": 0.8, "2025-07-01": 0.5, "2026-04-01": 0.7 };
const scale = (startDate: string) => SCALE[startDate] ?? 0.9;

const QUERIES: [string, number, number, number][] = [
  ["example co", 300, 1200, 1.2],
  ["emergency plumber", 180, 4200, 6.4],
  ["water heater repair", 120, 3100, 8.1],
  ["drain cleaning near me", 90, 5200, 11.3],
  ["leak detection", 60, 900, 4.2],
  ["<img src=x onerror=alert(1)>", 5, 300, 15.0],
  ["pipe | fitting", 4, 260, 12.5],
];
const PAGES: [string, number, number, number][] = [
  ["https://example.com/", 420, 6000, 3.1],
  ["https://example.com/services/emergency", 200, 5100, 6.0],
  ["https://example.com/blog/water-heaters", 110, 4100, 9.2],
  ["https://example.com/contact", 40, 800, 5.5],
];

export function gscQuery(_client: unknown, opts: GscQueryOptions): GscRow[] {
  const k = scale(opts.startDate);
  const dims = (opts.dimensions ?? []).join(",");
  // In the previous month "leak detection" did much better, so it shows up as a loser.
  const adj = (q: string, c: number) => (q === "leak detection" && opts.startDate === "2026-08-01" ? c * 3 : c);
  if (dims === "query") return QUERIES.map(([q, c, i, p]) => row([q], Math.round(adj(q, c) * k), Math.round(i * k), p + (k < 1 ? 0.7 : 0)));
  if (dims === "page") return PAGES.map(([u, c, i, p]) => row([u], Math.round(c * k), Math.round(i * k), p + (k < 1 ? 0.4 : 0)));
  if (dims === "date") {
    const t = gscTotals(_client, opts);
    const clicks = dailySplit(opts.startDate, opts.endDate, t.clicks);
    const impressions = dailySplit(opts.startDate, opts.endDate, t.impressions);
    return clicks.map((c, i) => row([c.date], c.value, impressions[i]!.value, t.position));
  }
  if (dims === "query,page") {
    return [
      row(["emergency plumber", "https://example.com/services/emergency"], Math.round(150 * k), Math.round(3000 * k), 6.2),
      row(["emergency plumber", "https://example.com/"], Math.round(30 * k), Math.round(1200 * k), 7.9),
      row(["drain cleaning near me", "https://example.com/services/emergency"], Math.round(90 * k), Math.round(5200 * k), 11.3),
      row(["water heater repair", "https://example.com/blog/water-heaters"], Math.round(120 * k), Math.round(3100 * k), 8.1),
      row(["leak detection", "https://example.com/"], Math.round(10 * k), Math.round(900 * k), 2.2),
    ];
  }
  return [];
}

/** Every date from start to end (inclusive), YYYY-MM-DD. */
function daysBetween(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${startDate}T00:00:00Z`); t <= Date.parse(`${endDate}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** A realistic daily shape (weekday highs, weekend dips, a gentle wave), scaled so the days add up to `total`. */
export function dailySplit(startDate: string, endDate: string, total: number): { date: string; value: number }[] {
  const days = daysBetween(startDate, endDate);
  const w = days.map((d, i) => {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    return (1 + 0.16 * Math.sin(i / 4.1) + 0.006 * i) * (dow === 0 || dow === 6 ? 0.68 : 1);
  });
  const sum = w.reduce((a, b) => a + b, 0);
  return days.map((date, i) => ({ date, value: Math.round((total * w[i]!) / sum) }));
}

export function gscTotals(_client: unknown, range: { startDate: string }) {
  const k = scale(range.startDate);
  return { keys: [], clicks: Math.round(1120 * k), impressions: Math.round(20000 * k), ctr: Number((5.6).toFixed(2)), position: k === 1 ? 7.5 : 8.2 };
}

export function ga4OrganicSummary(_client: unknown, range: { startDate: string }) {
  const k = scale(range.startDate);
  return { sessions: Math.round(1500 * k), users: Math.round(1200 * k), engagedSessions: Math.round(900 * k), engagementRate: k === 1 ? 61.2 : 58.4, keyEvents: Math.round(40 * k) };
}

export function ga4OrganicDaily(_client: unknown, range: { startDate: string; endDate: string }) {
  return dailySplit(range.startDate, range.endDate, ga4OrganicSummary(_client, range).sessions).map((d) => ({ date: d.date, sessions: d.value }));
}

export function ga4TopLandingPages(_client: unknown, _range: unknown, limit = 20) {
  return [
    { landingPagePlusQueryString: "/", sessions: 700, engagementRate: 0.64, keyEvents: 20 },
    { landingPagePlusQueryString: "/services/emergency", sessions: 400, engagementRate: 0.58, keyEvents: 15 },
    { landingPagePlusQueryString: "/blog/water-heaters", sessions: 210, engagementRate: 0.49, keyEvents: 2 },
  ].slice(0, limit);
}

const finding = (id: string, severity: Finding["severity"], title: string, source: Finding["source"] = "onpage"): Finding => ({
  id,
  source,
  rule: id,
  url: "https://example.com/",
  severity,
  title,
});

export const AUDIT_BEFORE: StoredAudit = {
  id: "aud_before",
  client: "example.com",
  ranAt: Date.parse("2026-08-20T10:00:00Z"),
  settings: { formFactor: "mobile", wcagLevel: "AA", fresh: true },
  summary: { avgScores: { performance: 71, accessibility: 88, bestPractices: 92, seo: 90 } },
  findings: [finding("no_description", "medium", "On-page check failed: no description"), finding("no_h1_tag", "medium", "On-page check failed: no h1 tag"), finding("gone", "low", "Old low issue", "axe")],
  checked: [{ url: "https://example.com", source: "onpage" }],
  result: { pages: [{ url: "https://example.com/", lighthouse: { ok: true, data: { scores: { performance: 71, seo: 90 } } } }] },
};

export const AUDIT_LATEST: StoredAudit = {
  ...AUDIT_BEFORE,
  id: "aud_latest",
  ranAt: Date.parse("2026-09-25T10:00:00Z"),
  summary: { avgScores: { performance: 78, accessibility: 90, bestPractices: 92, seo: 92 } },
  findings: [finding("no_h1_tag", "medium", "On-page check failed: no h1 tag"), finding("is_broken", "high", "On-page check failed: is broken")],
  result: { pages: [{ url: "https://example.com/", lighthouse: { ok: true, data: { scores: { performance: 78, seo: 92 } } } }] },
};
