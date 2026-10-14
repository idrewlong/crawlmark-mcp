/**
 * The provider report sections (Phase 13 B, spec D1-D7): backlinks, organic visibility and the competitor overview,
 * through the client's SEO data provider (DataForSEO, Ahrefs or Semrush; routed, never another provider).
 *
 * Every section is planned first (no request): which figures can come from a stored snapshot (D2 reuse window, D3
 * matching by tolerance), what has to be fetched, and whether provider history must be bought (only when a stored
 * snapshot can't serve a requested comparison or the trend, and only when `history` allows it: templates by default,
 * standalone tools only when asked). The plan's cost goes into the run's pre-flight; executing it makes exactly the
 * planned requests, stores every result as a dated snapshot, then builds the section from snapshots of one provider
 * and market (D4: a provider change starts a new series, with a note).
 *
 * Stored figures are counts only (Ahrefs storage decision); domains and labels from providers are stripControl'd.
 */
import type { Client } from "../config.js";
import { cacheKey } from "../lib/cache.js";
import type { Denylist } from "../lib/competitor-denylist.js";
import { isDenied } from "../lib/competitor-denylist.js";
import { isPlainDomain, normalizeHost } from "../lib/clients.js";
import { competitorSnapshotsSince, historyForMonth, lastHistoryCapture, lastHistoryPurchase, latestLiveSince, oldestHistoryDay, recordHistoryPurchase, nearestSnapshot, otherProvidersSince, saveSnapshot, seriesKeys, seriesSince, type SnapshotKey, type StoredSnapshot } from "../lib/snapshots.js";
import { stripControl } from "../lib/terminal-text.js";
import type { BacklinksRouted, Capability, PaidPlan, ProviderId, SeoDataProvider, VisibilityFigures } from "../providers/seo-data.js";
import type { BacklinksData, BacklinksNow, Compared, CompetitorOverviewData, CompetitorRow, SnapshotOrigin, VisibilityData, VisibilityNow } from "./report-types.js";
import { monthLabel } from "./templates/period.js";

const DAY_MS = 86_400_000;
const PROVIDER_LABEL: Record<ProviderId, string> = { dataforseo: "DataForSEO", ahrefs: "Ahrefs", semrush: "Semrush" };
const TRAFFIC_LABEL: Record<ProviderId, string> = { dataforseo: "DataForSEO estimated traffic", ahrefs: "Ahrefs organic traffic", semrush: "Semrush organic traffic" };
export const AUTHORITY: Record<ProviderId, BacklinksData["authority"]> = {
  dataforseo: { metric: "dataforseo_rank", label: "DataForSEO Rank (0–1000)", scale: "0-1000" },
  ahrefs: { metric: "domain_rating", label: "Ahrefs Domain Rating (0–100)", scale: "0-100" },
  semrush: { metric: "semrush_score", label: "Semrush Authority Score (0–100)", scale: "0-100" },
};
/** Provider history bought for a series within this many days isn't bought again (D1: at most once); what it lacked, the provider lacks. */
export const HISTORY_REBUY_DAYS = 30;
export const PREVIOUS_YEAR_TOLERANCE_DAYS = 31;
/** At most this many months of history are bought (enough for the previous year and a trend). */
export const MAX_HISTORY_MONTHS = 25;

export type ProviderKind = "backlinks" | "visibility";

/** The report period as the provider sections need it (D3). */
export interface SectionWindow {
  /**
   * `period`: a report period; the current figures may come from the stored snapshot nearest its end (D3).
   * `tool`: today's figures (tools, seo-snapshot); only a live capture from the last SNAPSHOT_REUSE_DAYS is reused (D2).
   */
  kind: "period" | "tool";
  /** The day the current figures should describe: the period's last day (templates) or today (tools). */
  end: string;
  /** ± days a stored snapshot may be from `end` (monthly 10, quarterly 20). */
  toleranceDays: number;
  /** Comparison days: each comparison period's last day. */
  comparisons: { previous_period?: string | undefined; previous_year?: string | undefined };
  trendMonths: number;
}

export interface SeriesOptions {
  /** Buy provider history when no stored snapshot can serve a comparison or the trend (templates: true by default; tools: only when asked). */
  history: boolean;
  /** Fetch the current figures even when a stored snapshot would do. */
  refresh?: boolean | undefined;
}

export interface ProviderSectionDeps {
  now(): number;
  /** SNAPSHOT_REUSE_DAYS (D2). */
  reuseDays: number;
  route(client: Client, capability: Capability): Promise<{ provider: ProviderId }>;
  impl(provider: ProviderId): SeoDataProvider;
  /** The routed backlinks summary (backlinks now). */
  backlinksNow(client: Client, target: string): Promise<BacklinksRouted>;
  /** True when a fresh cache entry exists under this key. */
  cached(key: string): boolean;
  denylist(): Denylist;
}

export async function loadProviderSectionDeps(): Promise<ProviderSectionDeps> {
  const [seo, cache, config, comp] = await Promise.all([import("../providers/seo-data.js"), import("../lib/cache.js"), import("../config.js"), import("../competitors.js")]);
  return {
    now: () => Date.now(),
    reuseDays: config.env.SNAPSHOT_REUSE_DAYS,
    route: (c, cap) => seo.routeProvider(c, cap),
    impl: (p) => seo.providerImpl(p),
    backlinksNow: (c, t) => seo.backlinksSummary(c, t),
    cached: (k) => cache.peekCache(k) !== undefined,
    denylist: () => comp.loadDenylist().denylist,
  };
}

/** One paid section's pre-flight figure (no request). */
export interface ProviderEstimate {
  provider: ProviderId;
  usd: number;
  units: number;
  requests: number;
  /** Nothing to buy: stored snapshots or the cache serve it. */
  reused: boolean;
  /** What would be bought, for the operator (tool and CLI results only). */
  parts: string[];
}

// ------------------------------------------------------------------ dates

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const shiftDays = (d: string, n: number) => dayOf(dayMs(d) + n * DAY_MS);
export function addMonths(d: string, n: number): string {
  const t = new Date(dayMs(d));
  return dayOf(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + n, 1));
}
const monthsBetween = (from: string, to: string) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));

/** A tool's window: today, compared with a month ago and a year ago (only when snapshots or bought history have them). */
export function toolWindow(now: number, trendMonths: number): SectionWindow {
  const today = dayOf(now);
  const t = new Date(now);
  const sameDay = (months: number) => dayOf(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - months, Math.min(t.getUTCDate(), 28)));
  return { kind: "tool", end: today, toleranceDays: 10, comparisons: { previous_period: sameDay(1), previous_year: sameDay(12) }, trendMonths };
}

// ------------------------------------------------------------------ snapshot lookup

/**
 * A stored point for `day` (D3): a live capture within `tol` days, else the provider's monthly history point for
 * that month (DataForSEO and Ahrefs date them the 1st, Semrush mid-month; each describes its own month). A history
 * point of a neighbouring month is never a stand-in, even inside the tolerance (a point dated Sept 1 must not answer
 * for Aug 31: the report labels the figures by the month it asked for).
 */
export function findPoint(key: SnapshotKey, day: string, tol: number, now: number): StoredSnapshot | undefined {
  return nearestSnapshot({ ...key, day, toleranceDays: tol, only: "live" }, now) ?? historyForMonth(key, day, now);
}

const originOf = (s: StoredSnapshot): SnapshotOrigin => (s.source === "live" ? "reused" : "provider_history");

/** The last stored point of each month from `since` to `until`, oldest first. */
function monthly(points: StoredSnapshot[], until: string): StoredSnapshot[] {
  const byMonth = new Map<string, StoredSnapshot>();
  for (const p of points) if (p.day <= until) byMonth.set(p.day.slice(0, 7), p);
  return [...byMonth.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// ------------------------------------------------------------------ backlinks and visibility

export interface SeriesPlan {
  kind: ProviderKind;
  client: Client;
  target: string;
  provider: ProviderId;
  key: SnapshotKey;
  window: SectionWindow;
  opts: SeriesOptions;
  current: { use: StoredSnapshot } | { fetch: PaidPlan; cached: boolean };
  history: { months: number; plan: PaidPlan; cached: boolean } | null;
  estimate: ProviderEstimate;
  notes: string[];
}

const bare = (d: string) => d.toLowerCase().replace(/^www\./, "");
const capabilityOf = (kind: ProviderKind): Capability => (kind === "backlinks" ? "backlinksSummary" : "organicOverview");

function planKey(provider: ProviderId, capability: string, plan: PaidPlan): string {
  return plan.cacheKey ?? cacheKey("seo", provider, capability, plan.keyParts);
}

/** Plan one series (backlinks or visibility) for the client's own domain. No request; reads snapshots and the cache. */
export async function planSeries(client: Client, kind: ProviderKind, window: SectionWindow, opts: SeriesOptions, deps: ProviderSectionDeps): Promise<SeriesPlan> {
  const now = deps.now();
  const today = dayOf(now);
  const target = bare(client.domain);
  const { provider } = await deps.route(client, capabilityOf(kind));
  const p = deps.impl(provider);
  const market = kind === "backlinks" ? "global" : p.market!(client, "organicOverview");
  const key: SnapshotKey = { client: client.slug, kind, target, provider, market };
  const notes: string[] = [];

  let current: SeriesPlan["current"] | undefined;
  // SNAPSHOT_REUSE_DAYS=0 always fetches the current figures.
  if (!opts.refresh && deps.reuseDays > 0) {
    // Only a report period matches by tolerance (and a provider-history month); today's figures are a recent live capture.
    const near = window.kind === "period" ? findPoint(key, window.end, window.toleranceDays, now) : undefined;
    const recent = near ?? latestLiveSince(key, now - deps.reuseDays * DAY_MS, now);
    if (recent) current = { use: recent };
  }
  if (!current) {
    const plan = kind === "backlinks" ? p.planBacklinksSummary!(client, target) : p.planOrganicOverview!(client, target);
    current = { fetch: plan, cached: !opts.refresh && deps.cached(planKey(provider, capabilityOf(kind), plan)) };
  }

  // Provider history only when a stored snapshot can't serve a comparison or the trend (D1), and the provider has it.
  const missing: { which: "previous_period" | "previous_year"; day: string }[] = [];
  for (const which of ["previous_period", "previous_year"] as const) {
    const day = window.comparisons[which];
    if (!day) continue;
    const tol = which === "previous_year" ? PREVIOUS_YEAR_TOLERANCE_DAYS : window.toleranceDays;
    if (!findPoint(key, day, tol, now)) missing.push({ which, day });
  }
  const trendSince = addMonths(window.end, -window.trendMonths);
  const stored = window.trendMonths > 0 ? monthly(seriesSince(key, trendSince, now), shiftDays(window.end, window.toleranceDays)).length : 0;
  const trendShort = window.trendMonths > 0 && stored + ("fetch" in current ? 1 : 0) < 2;
  const historyPlanOf = kind === "backlinks" ? p.planBacklinksHistory : p.planOrganicHistory;
  const historyFn = kind === "backlinks" ? p.backlinksHistory : p.organicHistory;
  let history: SeriesPlan["history"] = null;
  const need = [...missing.map((m) => monthsBetween(m.day, today)), ...(trendShort ? [window.trendMonths + monthsBetween(window.end, today)] : [])];
  const months = Math.min(MAX_HISTORY_MONTHS, Math.max(2, ...need));
  const oldestNeeded = addMonths(`${today.slice(0, 7)}-01`, -months);
  // D1 "at most once": skip when a recent purchase (even one that came back empty, R-3), or stored history bought
  // recently, already reaches the oldest month needed; a report needing an older month still buys (R-4).
  const purchase = lastHistoryPurchase(key, now);
  const boughtAt = lastHistoryCapture(key, now);
  const oldestStored = oldestHistoryDay(key, now);
  const covered =
    (purchase !== undefined && now - purchase.capturedAt < HISTORY_REBUY_DAYS * DAY_MS && purchase.dateFrom <= oldestNeeded) ||
    (boughtAt !== null && now - boughtAt < HISTORY_REBUY_DAYS * DAY_MS && oldestStored !== undefined && oldestStored.slice(0, 7) <= oldestNeeded.slice(0, 7));
  if ((missing.length || trendShort) && opts.history && historyPlanOf && historyFn && !covered) {
    const plan = historyPlanOf(client, target, months);
    history = { months, plan, cached: !opts.refresh && deps.cached(planKey(provider, kind === "backlinks" ? "backlinksHistory" : "organicHistory", plan)) };
  }
  if (provider === "semrush" && kind === "backlinks" && missing.some((m) => m.which === "previous_year")) {
    notes.push("Semrush data is kept for 31 days (Semrush's terms) and Semrush has no backlink history, so last year's backlink figures aren't available.");
  }

  const parts: string[] = [];
  let cost = 0;
  let requests = 0;
  if ("fetch" in current && !current.cached) {
    cost += current.fetch.cost(1);
    requests += current.fetch.requests;
    parts.push(current.fetch.breakdown(1));
  }
  if (history && !history.cached) {
    cost += history.plan.cost(1);
    requests += history.plan.requests;
    parts.push(history.plan.breakdown(1));
  }
  const usd = provider === "dataforseo" ? Number(cost.toFixed(6)) : 0;
  const units = provider === "dataforseo" ? 0 : cost;
  return { kind, client, target, provider, key, window, opts, current, history, estimate: { provider, usd, units, requests, reused: requests === 0, parts }, notes };
}

const nul = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function backlinksFromSummary(r: BacklinksRouted): Record<string, unknown> {
  const s = r.summary;
  return {
    backlinks: nul(s?.backlinks),
    referringDomains: nul(s?.referringDomains),
    authority: { metric: s?.authority.metric ?? AUTHORITY[r.provider].metric, value: nul(s?.authority.value) },
    newBacklinks: nul(s?.newBacklinks),
    lostBacklinks: nul(s?.lostBacklinks),
    newReferringDomains: null,
    lostReferringDomains: null,
  };
}

const visibilityData = (f: VisibilityFigures): Record<string, unknown> => ({
  keywords: f.keywords,
  top3: f.top3,
  pos4_10: f.pos4_10,
  pos11_20: f.pos11_20,
  pos21_100: f.pos21_100,
  traffic: f.traffic,
  trafficLabel: f.trafficLabel,
});

/** Make the planned requests (none when everything is stored) and store every result as a snapshot. */
export async function executeSeries(plan: SeriesPlan, deps: ProviderSectionDeps): Promise<{ fresh: StoredSnapshot | null }> {
  const now = deps.now();
  const today = dayOf(now);
  const p = deps.impl(plan.provider);
  let fresh: StoredSnapshot | null = null;
  if ("fetch" in plan.current) {
    const data = plan.kind === "backlinks" ? backlinksFromSummary(await deps.backlinksNow(plan.client, plan.target)) : visibilityData((await p.organicOverview!(plan.client, plan.target, { refresh: plan.opts.refresh ?? false })).figures);
    saveSnapshot({ ...plan.key, day: today, source: "live", capturedAt: now, data }, now);
    fresh = { ...plan.key, id: 0, day: today, source: "live", capturedAt: now, data };
  }
  if (plan.history) {
    const points =
      plan.kind === "backlinks"
        ? (await p.backlinksHistory!(plan.client, plan.target, plan.history.months, { refresh: plan.opts.refresh ?? false })).points.map(({ day, ...f }) => ({ day, data: f as unknown as Record<string, unknown> }))
        : (await p.organicHistory!(plan.client, plan.target, plan.history.months, { refresh: plan.opts.refresh ?? false })).points.map(({ day, ...f }) => ({ day, data: visibilityData(f) }));
    for (const pt of points) saveSnapshot({ ...plan.key, day: pt.day, source: "provider_history", capturedAt: now, data: pt.data }, now);
    recordHistoryPurchase(plan.key, addMonths(`${dayOf(now).slice(0, 7)}-01`, -plan.history.months), now);
  }
  return { fresh };
}

const changeOf = <T extends object>(cur: T, prev: T): T => Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, typeof v === "number" && typeof (prev as Record<string, unknown>)[k] === "number" ? v - ((prev as Record<string, number>)[k] as number) : null])) as T;

function compare<T extends object>(plan: SeriesPlan, current: StoredSnapshot, toNow: (s: StoredSnapshot) => T, now: number): { comparisons: Partial<Record<"previous_period" | "previous_year", Compared<T> | null>>; notes: string[] } {
  const out: Partial<Record<"previous_period" | "previous_year", Compared<T> | null>> = {};
  const notes: string[] = [];
  for (const which of ["previous_period", "previous_year"] as const) {
    const day = plan.window.comparisons[which];
    if (!day) continue;
    const tol = which === "previous_year" ? PREVIOUS_YEAR_TOLERANCE_DAYS : plan.window.toleranceDays;
    const s = findPoint(plan.key, day, tol, now);
    if (!s || s.day === current.day) {
      out[which] = null;
      continue;
    }
    const cur = toNow(current);
    const prev = toNow(s);
    out[which] = { asOf: s.day, origin: originOf(s), previous: prev, change: changeOf(cur, prev) };
  }
  return { comparisons: out, notes };
}

function seriesNotes(plan: SeriesPlan, current: StoredSnapshot, now: number): string[] {
  const notes = [...plan.notes];
  const label = PROVIDER_LABEL[plan.provider];
  if (current.day > shiftDays(plan.window.end, plan.window.toleranceDays)) notes.push(`${label} figures are as of ${current.day}, after the end of the report period.`);
  const others = otherProvidersSince({ client: plan.key.client, kind: plan.key.kind, target: plan.key.target, provider: plan.provider }, addMonths(plan.window.end, -Math.max(plan.window.trendMonths, 13)), now);
  if (others.length) notes.push(`Earlier months came from ${others.map((o) => PROVIDER_LABEL[o]).join(" and ")} and aren't shown (figures from different providers aren't comparable).`);
  return notes;
}

function trendOf<T>(plan: SeriesPlan, current: StoredSnapshot, map: (s: StoredSnapshot) => T, now: number): ({ day: string; origin: SnapshotOrigin } & T)[] {
  if (plan.window.trendMonths <= 0) return [];
  const until = current.day > plan.window.end ? current.day : shiftDays(plan.window.end, plan.window.toleranceDays);
  return monthly(seriesSince(plan.key, addMonths(plan.window.end, -plan.window.trendMonths), now), until).map((s) => ({ day: s.day, origin: s.id === 0 || (s.source === "live" && s.capturedAt === now) ? ("live" as const) : originOf(s), ...map(s) }));
}

const backlinksNow = (s: StoredSnapshot): BacklinksNow => ({
  backlinks: nul(s.data.backlinks),
  referringDomains: nul(s.data.referringDomains),
  authority: nul((s.data.authority as { value?: unknown } | undefined)?.value),
  newBacklinks: nul(s.data.newBacklinks),
  lostBacklinks: nul(s.data.lostBacklinks),
  newReferringDomains: nul(s.data.newReferringDomains),
  lostReferringDomains: nul(s.data.lostReferringDomains),
});

const visibilityNow = (s: StoredSnapshot): VisibilityNow => ({
  keywords: nul(s.data.keywords),
  top3: nul(s.data.top3),
  pos4_10: nul(s.data.pos4_10),
  pos11_20: nul(s.data.pos11_20),
  pos21_100: nul(s.data.pos21_100),
  traffic: nul(s.data.traffic),
});

function currentOf(plan: SeriesPlan, fresh: StoredSnapshot | null): { snap: StoredSnapshot; origin: SnapshotOrigin } {
  if (fresh) return { snap: fresh, origin: "live" };
  if ("use" in plan.current) return { snap: plan.current.use, origin: originOf(plan.current.use) };
  throw new Error("the current figures were neither stored nor fetched");
}

/** Build the backlinks section from snapshots (after executeSeries). New/lost only as the provider reports them (D5). */
export function buildBacklinksData(plan: SeriesPlan, fresh: StoredSnapshot | null, now: number): BacklinksData {
  const { snap, origin } = currentOf(plan, fresh);
  const current = backlinksNow(snap);
  let newLostLabel: string | null = null;
  if (plan.provider === "dataforseo") {
    // DataForSEO's monthly history carries new/lost for the month of the report period (only when that call was made).
    const month = nearestSnapshot({ ...plan.key, day: `${plan.window.end.slice(0, 7)}-01`, toleranceDays: 0, prefer: "provider_history" }, now);
    if (month?.source === "provider_history" && (nul(month.data.newReferringDomains) !== null || nul(month.data.newBacklinks) !== null)) {
      current.newBacklinks = nul(month.data.newBacklinks);
      current.lostBacklinks = nul(month.data.lostBacklinks);
      current.newReferringDomains = nul(month.data.newReferringDomains);
      current.lostReferringDomains = nul(month.data.lostReferringDomains);
      newLostLabel = `${monthLabel(plan.window.end.slice(0, 7))} (DataForSEO, monthly)`;
    } else Object.assign(current, { newBacklinks: null, lostBacklinks: null, newReferringDomains: null, lostReferringDomains: null });
  } else if (plan.provider === "semrush" && (current.newBacklinks !== null || current.lostBacklinks !== null)) {
    newLostLabel = "as reported by Semrush";
  } else Object.assign(current, { newBacklinks: null, lostBacklinks: null, newReferringDomains: null, lostReferringDomains: null });
  const { comparisons } = compare(plan, snap, backlinksNow, now);
  return {
    provider: plan.provider,
    target: plan.target,
    asOf: snap.day,
    origin,
    authority: AUTHORITY[plan.provider],
    current,
    newLostLabel,
    comparisons,
    trend: trendOf(plan, snap, (s) => ({ referringDomains: nul(s.data.referringDomains), backlinks: nul(s.data.backlinks), authority: nul((s.data.authority as { value?: unknown } | undefined)?.value) }), now),
    notes: seriesNotes(plan, snap, now),
  };
}

/** Build the organic visibility section from snapshots (after executeSeries). */
export function buildVisibilityData(plan: SeriesPlan, fresh: StoredSnapshot | null, now: number): VisibilityData {
  const { snap, origin } = currentOf(plan, fresh);
  const { comparisons } = compare(plan, snap, visibilityNow, now);
  const notes = seriesNotes(plan, snap, now);
  if (plan.provider === "semrush") notes.push("Semrush's API doesn't report keywords by position band.");
  return {
    provider: plan.provider,
    target: plan.target,
    market: plan.key.market,
    asOf: snap.day,
    origin,
    trafficLabel: TRAFFIC_LABEL[plan.provider],
    distributionAvailable: plan.provider !== "semrush",
    current: visibilityNow(snap),
    comparisons,
    trend: trendOf(plan, snap, visibilityNow, now),
    notes,
  };
}

// ------------------------------------------------------------------ competitors

export interface CompetitorPlan {
  client: Client;
  provider: ProviderId;
  market: string;
  own: string;
  saved: string[];
  limit: number;
  source: "saved" | "suggested" | "saved_then_suggested";
  window: SectionWindow;
  refresh: boolean;
  current: { reuse: StoredSnapshot[] } | { fetch: PaidPlan; cached: boolean };
  estimate: ProviderEstimate;
}

/**
 * A competitor domain from a provider (untrusted): control characters stripped, normalised to a bare host, and kept
 * only when it's a plain domain that isn't the client's own (or one of its subdomains). Else null (SEC-4).
 */
export function vendorDomain(raw: unknown, own: string): string | null {
  if (typeof raw !== "string") return null;
  const h = normalizeHost(stripControl(raw).trim())?.replace(/^www\./, "");
  if (!h || !isPlainDomain(h)) return null;
  if (h.length > 253 || h.split(".").some((l) => l.length > 63)) return null;
  const o = bare(own);
  return h === o || h.endsWith(`.${o}`) ? null : h;
}

/** Saved competitors as bare, plain domains in saved order (never the client's own), at most `limit`. */
export function savedCompetitors(client: Pick<Client, "domain" | "competitors">, limit: number): string[] {
  const own = bare(client.domain);
  const out: string[] = [];
  for (const d of client.competitors) {
    const h = normalizeHost(d)?.replace(/^www\./, "");
    if (!h || !isPlainDomain(h) || h === own || h.endsWith(`.${own}`) || out.includes(h)) continue;
    out.push(h);
  }
  return out.slice(0, limit);
}

export async function planCompetitors(client: Client, req: { limit: number; source: CompetitorPlan["source"]; refresh?: boolean | undefined }, window: SectionWindow, deps: ProviderSectionDeps): Promise<CompetitorPlan> {
  const now = deps.now();
  const { provider } = await deps.route(client, "competitorOverview");
  const p = deps.impl(provider);
  const market = p.market!(client, "competitorOverview");
  const own = bare(client.domain);
  const saved = req.source === "suggested" ? [] : savedCompetitors(client, req.limit);
  let current: CompetitorPlan["current"] | undefined;
  if (!req.refresh && deps.reuseDays > 0) {
    const snaps = competitorSnapshotsSince({ client: client.slug, provider, market, own }, now - deps.reuseDays * DAY_MS, now);
    if (snaps.length && saved.every((d) => snaps.some((s) => s.target === d))) current = { reuse: snaps };
  }
  if (!current) {
    const plan = p.planCompetitorOverview!(client, { saved, limit: req.limit });
    current = { fetch: plan, cached: !req.refresh && deps.cached(planKey(provider, "competitorOverview", plan)) };
  }
  const buy = "fetch" in current && !current.cached;
  const cost = buy && "fetch" in current ? current.fetch.cost(1) : 0;
  return {
    client,
    provider,
    market,
    own,
    saved,
    limit: req.limit,
    source: req.source,
    window,
    refresh: req.refresh === true,
    current,
    estimate: {
      provider,
      usd: provider === "dataforseo" ? Number(cost.toFixed(6)) : 0,
      units: provider === "dataforseo" ? 0 : cost,
      requests: buy && "fetch" in current ? current.fetch.requests : 0,
      reused: !buy,
      parts: buy && "fetch" in current ? [current.fetch.breakdown(1)] : [],
    },
  };
}

/** Fetch (when planned), store one visibility snapshot per competitor (counts only), and build the section (D7). */
export async function executeCompetitors(plan: CompetitorPlan, deps: ProviderSectionDeps): Promise<CompetitorOverviewData> {
  const now = deps.now();
  const today = dayOf(now);
  const label = TRAFFIC_LABEL[plan.provider];
  let snaps: StoredSnapshot[];
  if ("fetch" in plan.current) {
    const r = await deps.impl(plan.provider).competitorOverview!(plan.client, { saved: plan.saved, limit: plan.limit }, { refresh: plan.refresh });
    snaps = [];
    for (const row of r.rows) {
      const domain = vendorDomain(row.domain, plan.own);
      if (!domain) continue;
      const data = { keywords: row.keywords, top3: null, pos4_10: null, pos11_20: null, pos21_100: null, traffic: row.traffic, trafficLabel: label, commonKeywords: row.commonKeywords, inProviderList: row.inProviderList, listSize: r.providerListSize };
      const key = { client: plan.client.slug, kind: "visibility" as const, target: domain, provider: plan.provider, market: plan.market };
      saveSnapshot({ ...key, day: today, source: "live", capturedAt: now, data }, now);
      snaps.push({ ...key, id: 0, day: today, source: "live", capturedAt: now, data });
    }
  } else snaps = plan.current.reuse;

  const byDomain = new Map(snaps.map((s) => [s.target, s]));
  const denylist = deps.denylist();
  const keyFor = (target: string) => ({ client: plan.client.slug, kind: "visibility" as const, target, provider: plan.provider, market: plan.market });
  const ppDay = plan.window.comparisons.previous_period;
  const changeFor = (target: string, keywords: number | null, currentDay: string): number | null => {
    if (!ppDay || keywords === null) return null;
    const prev = findPoint(keyFor(target), ppDay, plan.window.toleranceDays, now);
    return prev && prev.day !== currentDay && nul(prev.data.keywords) !== null ? keywords - (prev.data.keywords as number) : null;
  };
  const rowOf = (s: StoredSnapshot, origin: CompetitorRow["origin"]): CompetitorRow => {
    const keywords = nul(s.data.keywords);
    return { domain: s.target, origin, commonKeywords: nul(s.data.commonKeywords), keywords, traffic: nul(s.data.traffic), inProviderList: s.data.inProviderList !== false, keywordsChange: changeFor(s.target, keywords, s.day) };
  };
  const rows: CompetitorRow[] = [];
  if (plan.source !== "suggested") {
    for (const d of plan.saved) {
      const s = byDomain.get(d);
      rows.push(s ? rowOf(s, "saved") : { domain: d, origin: "saved", commonKeywords: null, keywords: null, traffic: null, inProviderList: false, keywordsChange: null });
    }
  }
  if (plan.source !== "saved") {
    const suggested = snaps
      .filter((s) => !plan.saved.includes(s.target) && s.data.inProviderList !== false && !isDenied(s.target, denylist))
      .sort((a, b) => (nul(b.data.commonKeywords) ?? -1) - (nul(a.data.commonKeywords) ?? -1) || a.target.localeCompare(b.target));
    for (const s of suggested) {
      if (rows.length >= plan.limit) break;
      rows.push(rowOf(s, "suggested"));
    }
  }

  // The client's own row: its stored visibility figures (the organic_visibility section or tool stores them; never bought here).
  const ownKey = keyFor(plan.own);
  const ownSnap = (plan.window.kind === "period" ? findPoint(ownKey, plan.window.end, plan.window.toleranceDays, now) : undefined) ?? latestLiveSince(ownKey, now - deps.reuseDays * DAY_MS, now);
  const ownKeywords = ownSnap ? nul(ownSnap.data.keywords) : null;
  const client: CompetitorRow = { domain: plan.own, origin: "client", commonKeywords: null, keywords: ownKeywords, traffic: ownSnap ? nul(ownSnap.data.traffic) : null, inProviderList: true, keywordsChange: ownSnap ? changeFor(plan.own, ownKeywords, ownSnap.day) : null };
  const notes: string[] = [];
  if (!ownSnap) notes.push("This site's own ranking keywords and traffic come from the organic visibility section; they weren't stored for this period.");
  const listSize = Math.max(0, ...snaps.map((s) => nul(s.data.listSize) ?? 0));
  const asOf = snaps.reduce((a, s) => (s.day > a ? s.day : a), "") || today;
  return { provider: plan.provider, market: plan.market, asOf, trafficLabel: label, client, competitors: rows, providerListSize: listSize, notes };
}

// ------------------------------------------------------------------ section entry points

export interface SectionRequest {
  type: "backlinks" | "organic_visibility" | "competitor_overview";
  trendMonths?: number | undefined;
  history?: boolean | undefined;
  limit?: number | undefined;
  source?: CompetitorPlan["source"] | undefined;
  refresh?: boolean | undefined;
}

export type SectionPlanAny = { type: "series"; plan: SeriesPlan } | { type: "competitors"; plan: CompetitorPlan };

export async function planSection(client: Client, req: SectionRequest, window: SectionWindow, deps: ProviderSectionDeps): Promise<SectionPlanAny> {
  if (req.type === "competitor_overview") return { type: "competitors", plan: await planCompetitors(client, { limit: req.limit ?? 5, source: req.source ?? "saved_then_suggested", refresh: req.refresh }, { ...window, trendMonths: 0 }, deps) };
  const kind: ProviderKind = req.type === "backlinks" ? "backlinks" : "visibility";
  return { type: "series", plan: await planSeries(client, kind, { ...window, trendMonths: req.trendMonths ?? 12 }, { history: req.history ?? true, refresh: req.refresh }, deps) };
}

export async function runSection(planned: SectionPlanAny, deps: ProviderSectionDeps): Promise<BacklinksData | VisibilityData | CompetitorOverviewData> {
  if (planned.type === "competitors") return executeCompetitors(planned.plan, deps);
  const { fresh } = await executeSeries(planned.plan, deps);
  const now = deps.now();
  return planned.plan.kind === "backlinks" ? buildBacklinksData(planned.plan, fresh, now) : buildVisibilityData(planned.plan, fresh, now);
}

export const estimateOf = (planned: SectionPlanAny): ProviderEstimate => planned.plan.estimate;

// ------------------------------------------------------------------ standalone tools and the seo-snapshot CLI

export interface ToolRunOptions {
  estimateOnly?: boolean | undefined;
}

export interface ToolEstimate {
  estimateOnly: true;
  provider: ProviderId;
  usd: number;
  units: number;
  requests: number;
  reused: boolean;
  breakdown: string;
  remaining: { unit: "usd" | "units"; client: number; global: number };
  wouldExceed: boolean;
  message: string;
}

export interface SpendDeps {
  remainingUsd(client: Client): { clientUsd: number; globalUsd: number };
  remainingUnits(client: Client, provider: "ahrefs" | "semrush"): { client: number; global: number };
  withUsdReservation<T>(client: Client, usd: number, fn: () => Promise<T>): Promise<T>;
  withUnitsReservation<T>(client: Client, provider: "ahrefs" | "semrush", units: number, fn: () => Promise<T>): Promise<T>;
  spent(client: Client): { usd: number; ahrefs: number; semrush: number };
}

export async function loadSpendDeps(): Promise<SpendDeps> {
  const [budget, units, spend] = await Promise.all([import("../lib/budget.js"), import("../providers/units-billing.js"), import("../lib/spend.js")]);
  return {
    remainingUsd: (c) => budget.remainingUsd(c),
    remainingUnits: (c, p) => units.remainingUnits(c, p),
    withUsdReservation: (c, usd, fn) => budget.withUsdReservation(c, usd, fn),
    withUnitsReservation: (c, p, u, fn) => units.withUnitsReservation(c, p, u, fn),
    spent: (c) => {
      const keys = spend.spendKeys(c);
      return { usd: budget.spentThisMonth(keys), ahrefs: budget.unitsThisMonth(keys, "ahrefs"), semrush: budget.unitsThisMonth(keys, "semrush") };
    },
  };
}

const fmtCost = (e: ProviderEstimate) => (e.provider === "dataforseo" ? `$${e.usd.toFixed(4)}` : `${Math.round(e.units).toLocaleString("en-US")} ${PROVIDER_LABEL[e.provider]} units`);

/** A plan's estimate against what's left this month (no request). */
export function priceEstimate(client: Client, e: ProviderEstimate, spend: SpendDeps): ToolEstimate {
  const remaining =
    e.provider === "dataforseo"
      ? (() => {
          const r = spend.remainingUsd(client);
          return { unit: "usd" as const, client: r.clientUsd, global: r.globalUsd };
        })()
      : { unit: "units" as const, ...spend.remainingUnits(client, e.provider) };
  const need = e.provider === "dataforseo" ? e.usd : e.units;
  const left = Math.min(remaining.client, remaining.global);
  const wouldExceed = need > left;
  const label = PROVIDER_LABEL[e.provider];
  const message = e.reused
    ? `${label}: served from stored snapshots or the cache, so this costs nothing.`
    : wouldExceed
      ? `That needs ${fmtCost(e)} (${e.parts.join(" + ")}) but ${remaining.client <= remaining.global ? client.domain : "the global cap"} has ${e.provider === "dataforseo" ? `$${left.toFixed(4)}` : `${left.toLocaleString("en-US")} units`} left this month.`
      : `${label}: ${e.parts.join(" + ")} = ${fmtCost(e)} (an estimate; the actual cost is recorded).`;
  return { estimateOnly: true, provider: e.provider, usd: e.usd, units: e.units, requests: e.requests, reused: e.reused, breakdown: e.parts.join(" + "), remaining, wouldExceed, message };
}

/** Run a planned section with its whole estimate checked and reserved first (refused before any request when over a cap). */
export async function runReserved<T>(client: Client, e: ProviderEstimate, spend: SpendDeps, fn: () => Promise<T>): Promise<{ value: T; spend: { usd: number; units: { ahrefs: number; semrush: number } } }> {
  const before = spend.spent(client);
  const value =
    e.reused || (e.usd <= 0 && e.units <= 0)
      ? await fn()
      : e.provider === "dataforseo"
        ? await spend.withUsdReservation(client, e.usd, fn)
        : await spend.withUnitsReservation(client, e.provider, e.units, fn);
  const after = spend.spent(client);
  return { value, spend: { usd: Number(Math.max(0, after.usd - before.usd).toFixed(4)), units: { ahrefs: Math.max(0, after.ahrefs - before.ahrefs), semrush: Math.max(0, after.semrush - before.semrush) } } };
}

/**
 * organic_visibility / competitor_overview tools: today's figures (stored ones reused within SNAPSHOT_REUSE_DAYS),
 * provider history only with `history: true` (never bought unasked), `estimateOnly` makes no request.
 */
export async function providerTool(client: Client, req: SectionRequest, opts: ToolRunOptions, deps: ProviderSectionDeps, spend: SpendDeps) {
  const window = toolWindow(deps.now(), req.type === "competitor_overview" ? 0 : (req.trendMonths ?? 12));
  const planned = await planSection(client, { ...req, history: req.history === true }, window, deps);
  const e = estimateOf(planned);
  const priced = priceEstimate(client, e, spend);
  if (opts.estimateOnly) return priced;
  if (priced.wouldExceed) {
    const { BudgetExceededError } = await import("../lib/budget.js");
    throw new BudgetExceededError(priced.message);
  }
  const r = await runReserved(client, e, spend, () => runSection(planned, deps));
  return { ...r.value, costUsd: r.spend.usd, units: e.provider === "dataforseo" ? null : r.spend.units[e.provider], fromCache: e.reused, spend: r.spend };
}

/** seo_trends: every stored series for the client (or a target), per provider and market. Local and free. */
export function seoTrends(client: Client, kind: ProviderKind, target: string | undefined, months: number, now = Date.now()) {
  const t = bare(target ?? client.domain);
  const since = addMonths(dayOf(now), -months);
  const series = seriesKeys(client.slug, kind, t, now).map(({ provider, market }) => {
    const points = seriesSince({ client: client.slug, kind, target: t, provider, market }, since, now).map((s) => ({ day: s.day, origin: originOf(s), ...(kind === "backlinks" ? backlinksNow(s) : visibilityNow(s)) }));
    return { provider, market, ...(kind === "backlinks" ? { authority: AUTHORITY[provider] } : { trafficLabel: TRAFFIC_LABEL[provider] }), points };
  });
  const notes: string[] = [];
  if (series.length > 1) notes.push("Each provider and market is its own series: their figures aren't comparable.");
  if (series.some((x) => x.provider === "semrush")) notes.push("Semrush figures are kept for 31 days (Semrush's terms).");
  if (!series.length) notes.push(`No stored ${kind} figures for ${t} yet. They're stored by the ${kind === "backlinks" ? "backlinks section, backlinks_summary" : "organic_visibility section or tool"} and crawlmark-cli seo-snapshot.`);
  return { client: client.slug, kind, target: t, since, series, notes };
}
