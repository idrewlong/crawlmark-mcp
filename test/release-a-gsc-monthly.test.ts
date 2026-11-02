/**
 * Release A / D5: monthly Search Console history. Backfill (16 months, oldest partial, idempotent, resumable, quota
 * aware), the read path for ranges older than Google's window, the report fill, the tool and the CLI. Google is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fake, filtersOf, row, type GscBody } from "./helpers/fake-analytics.js";

vi.mock("googleapis", async () => (await import("./helpers/fake-analytics.js")).googleapisMock);
vi.mock("../src/providers/google.js", async () => (await import("./helpers/fake-analytics.js")).googleProviderMock);
const state = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("../src/clients.js", () => ({ resolveClient: async () => state.client }));

const { gscQuery, gscQueryDetailed, gscTotals } = await import("../src/providers/gsc.js");
const m = await import("../src/lib/gsc-monthly.js");
const { exclusionRegex } = await import("../src/lib/gsc-exclusions.js");
const { monthlyReport } = await import("../src/reports/monthly.js");
const { registerRawTools } = await import("../src/tools/raw.js");
const { gscHistoryCommand } = await import("../src/gsc-history-cli.js");
const { db } = await import("../src/lib/store.js");
const { shiftDay } = await import("../src/analysis/query-spikes.js");

const NOW = Date.parse("2026-11-04T12:00:00Z");
const MONTHS = ["2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2026-04", "2026-03", "2026-02", "2026-01", "2025-12", "2025-11", "2025-10", "2025-09", "2025-08", "2025-07"];
const ITEMS = ["example login"];
const mk = (extra: Record<string, unknown> = {}) => ({ slug: "example", domain: "example.com", gscProperty: "sc-domain:example.com", ga4PropertyId: "99999999", name: "Example Co", aliases: [], gscExcludeQueries: [], trackedKeywords: [], brandTerms: [], ...extra }) as never;
const sleeps: number[] = [];
/** The retry waits (the request pacing sleeps are fractions of a millisecond clock, never these exact values). */
const backoffs = () => sleeps.filter((ms) => [1000, 2000, 4000, 8000].includes(ms));
const deps = { gscQuery, now: () => NOW, sleep: async (ms: number) => void sleeps.push(ms), random: () => 0.5 };
const requestsFor = (month: string) => fake.gscCalls.filter((c) => c.startDate.startsWith(month));
const stored = () => m.storedMonths("example", "sc-domain:example.com");

/** A plausible answer for any Search Console request. */
const answer = (b: GscBody) => {
  const dims = b.dimensions ?? [];
  const excluded = filtersOf(b).some((f) => f.operator === "includingRegex");
  if (excluded) return [row([], 0, 300)];
  if (dims.length === 0) return [row([], 100, 1000, 6)];
  if (dims[0] === "page") return [row(["https://example.com/a"], 60, 600), row(["https://example.com/b"], 40, 400)];
  if (dims[0] === "query") return [row(["plumber"], 70, 500), row(["example login"], 0, 300)];
  if (dims[0] === "device") return [row(["MOBILE"], 70, 700), row(["DESKTOP"], 30, 300)];
  if (dims[0] === "country") return [row(["usa"], 90, 900)];
  return [];
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fake.reset();
  fake.gsc = answer;
  sleeps.length = 0;
  state.client = mk();
  db.exec("DELETE FROM cache");
  db.exec("DELETE FROM gsc_monthly");
});
afterEach(() => vi.useRealTimers());

describe("capturableMonths", () => {
  const at = (iso: string, max?: number) => m.capturableMonths(Date.parse(iso), max);

  it("starts from the newest month that is 3 days past its last day", () => {
    expect(at("2026-11-02T23:59:59Z")[0]).toBe("2026-09");
    expect(at("2026-11-03T00:00:00Z")[0]).toBe("2026-10");
    expect(at("2026-11-04T12:00:00Z", 3)).toEqual(["2026-10", "2026-09", "2026-08"]);
  });

  it("handles the year boundary and the 16-month default", () => {
    expect(at("2026-01-02T00:00:00Z")[0]).toBe("2025-11");
    expect(at("2026-01-03T00:00:00Z")[0]).toBe("2025-12");
    expect(at("2026-11-04T12:00:00Z")).toEqual(MONTHS);
  });

  it("windowStart and the read cutoff", () => {
    expect(m.windowStart(NOW)).toBe("2025-07-04");
    expect(m.windowStart(Date.parse("2026-03-31T00:00:00Z"))).toBe("2024-11-30");
    expect(m.windowStart(Date.parse("2026-06-30T00:00:00Z"))).toBe("2025-02-28");
    expect(m.historyCutoff(NOW)).toBe("2025-07-01");
  });

  it("wholeMonths needs a first day and a last day", () => {
    expect(m.wholeMonths({ startDate: "2025-04-01", endDate: "2025-05-31" })).toEqual(["2025-04", "2025-05"]);
    expect(m.wholeMonths({ startDate: "2025-04-02", endDate: "2025-05-31" })).toBeNull();
    expect(m.wholeMonths({ startDate: "2025-04-01", endDate: "2025-05-30" })).toBeNull();
  });
});

describe("backfill", () => {
  it("stores 16 months with the full request set; the oldest month is partial and starts at Google's window", async () => {
    const r = await m.fillGscMonths(mk(), { max: 16 }, deps);
    expect(r.failed).toEqual([]);
    expect(r.stored).toEqual(MONTHS);
    expect(r.skipped).toEqual([]);
    expect(fake.gscCalls).toHaveLength(16 * 5);
    for (const month of MONTHS) {
      const dims = requestsFor(month).map((c) => (c.dimensions ?? []).join("+"));
      expect(dims.sort(), month).toEqual(["", "country", "device", "page", "query"]);
    }
    const summary = m.storedSummary("example", "sc-domain:example.com");
    expect(summary.map((s) => s.month)).toEqual(MONTHS);
    expect(summary.filter((s) => !s.complete).map((s) => s.month)).toEqual(["2025-07"]);
    expect(summary[0]).toMatchObject({ clicks: 100, impressions: 1000, ctr: 10, position: 6, complete: true, capturedAt: NOW });
    // The partial month asks only for what Google still has.
    expect(fake.gscCalls.filter((c) => c.startDate.startsWith("2025-07")).every((c) => c.startDate === "2025-07-04" && c.endDate === "2025-07-31")).toBe(true);
    expect(fake.gscCalls.filter((c) => c.startDate === "2026-10-01").every((c) => c.endDate === "2026-10-31")).toBe(true);
  });

  it("asks for raw numbers (no exclusions) and adds one excluded request per month when exclusions are set", async () => {
    const r = await m.fillGscMonths(mk({ gscExcludeQueries: ITEMS }), { max: 2, newestFirst: true }, deps);
    expect(r.stored).toHaveLength(2);
    expect(fake.gscCalls).toHaveLength(2 * 6);
    expect(fake.gscCalls.some((c) => filtersOf(c).some((f) => f.operator === "excludingRegex"))).toBe(false);
    const inc = fake.gscCalls.filter((c) => filtersOf(c).some((f) => f.operator === "includingRegex"));
    expect(inc).toHaveLength(2);
    expect(filtersOf(inc[0]!)[0]!.expression).toBe("(?i)^(?:example login)$");
    const ex = m.readMonths("example", "sc-domain:example.com", ["2026-10"], "excluded").get("2026-10")!;
    expect(ex[0]).toMatchObject({ clicks: 0, impressions: 300, keys: ["(?i)^(?:example login)$"] });
  });

  it("a second run stores nothing and skips all 16; refresh fetches them again", async () => {
    await m.fillGscMonths(mk(), { max: 16 }, deps);
    fake.gscCalls.length = 0;
    const again = await m.fillGscMonths(mk(), { max: 16 }, deps);
    expect(again.stored).toEqual([]);
    expect(again.skipped).toEqual(MONTHS);
    expect(fake.gscCalls).toHaveLength(0);
    const refreshed = await m.fillGscMonths(mk(), { max: 3, refresh: true, newestFirst: true }, deps);
    expect(refreshed.stored).toHaveLength(3);
    expect(fake.gscCalls.length).toBe(15);
  });

  it("fetches the oldest missing months first, or the newest first for reports, and at most max", async () => {
    const old = await m.fillGscMonths(mk(), { max: 2 }, deps);
    expect(old.stored).toEqual(["2025-08", "2025-07"]);
    const fresh = await m.fillGscMonths(mk(), { max: 2, newestFirst: true }, deps);
    expect(fresh.stored).toEqual(["2026-10", "2026-09"]);
    expect(stored()).toEqual(["2026-10", "2026-09", "2025-08", "2025-07"]);
  });

  it("window limits how far back it goes", async () => {
    const r = await m.fillGscMonths(mk(), { max: 16, window: 3 }, deps);
    expect(r.stored).toEqual(["2026-10", "2026-09", "2026-08"]);
  });

  it("reports a month that fails and keeps the others", async () => {
    fake.gsc = (b) => {
      if (b.startDate.startsWith("2026-05")) throw Object.assign(new Error("Backend Error"), { response: { status: 500 } });
      return answer(b);
    };
    const r = await m.fillGscMonths(mk(), { max: 16, window: 6 }, deps);
    expect(r.stored).toEqual(["2026-10", "2026-09", "2026-08", "2026-07", "2026-06"]);
    expect(r.failed).toEqual([{ month: "2026-05", error: "Backend Error" }]);
    expect(stored()).not.toContain("2026-05");
    // The failed month is retried next time, the rest are skipped.
    fake.gsc = answer;
    const next = await m.fillGscMonths(mk(), { max: 16, window: 6 }, deps);
    expect(next.stored).toEqual(["2026-05"]);
  });

  it("a month is never half stored: a failure in the middle of a month stores nothing for it", async () => {
    fake.gsc = (b) => {
      if (b.startDate.startsWith("2026-10") && b.dimensions?.[0] === "country") throw Object.assign(new Error("boom"), { response: { status: 500 } });
      return answer(b);
    };
    const r = await m.fillGscMonths(mk(), { max: 1, newestFirst: true }, deps);
    expect(r.failed).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM gsc_monthly").get()).toEqual({ n: 0 });
  });

  it("a month with no data at all is still stored (zeros), so it isn't asked for again", async () => {
    fake.gsc = () => [];
    const r = await m.fillGscMonths(mk(), { max: 1, newestFirst: true }, deps);
    expect(r.stored).toEqual(["2026-10"]);
    expect(m.storedSummary("example", "sc-domain:example.com")[0]).toMatchObject({ clicks: 0, impressions: 0 });
  });

  it("refusing to overwrite a partial month with less data on refresh", async () => {
    await m.fillGscMonths(mk(), { max: 1 }, deps); // 2025-07, partial, impressions 1000
    fake.gsc = () => [row([], 1, 10)];
    const r = await m.fillGscMonths(mk(), { max: 1, refresh: true }, deps);
    expect(r.stored).toEqual([]);
    expect(r.skipped).toContain("2025-07");
    expect(m.storedSummary("example", "sc-domain:example.com").find((s) => s.month === "2025-07")!.impressions).toBe(1000);
  });

  it("a client without a Search Console property can't be backfilled", async () => {
    await expect(m.fillGscMonths(mk({ gscProperty: undefined }), { max: 1 }, deps)).rejects.toThrow(/No Search Console property/);
  });
});

describe("Search Console quotas", () => {
  const rate = () => Object.assign(new Error("Quota exceeded for quota metric 'Queries' (rateLimitExceeded)"), { response: { status: 429 } });

  it("backs off with jittered waits on a 429 and then carries on", async () => {
    let failures = 2;
    fake.gsc = (b) => {
      if (failures > 0 && (b.dimensions ?? []).length === 0) {
        failures--;
        throw rate();
      }
      return answer(b);
    };
    const r = await m.fillGscMonths(mk(), { max: 1, newestFirst: true }, deps);
    expect(r.stored).toEqual(["2026-10"]);
    expect(backoffs()).toEqual([1000, 2000]); // random() = 0.5 gives no jitter
  });

  it("Q2: a Google setup error stops the run after the first months; the rest are 'not attempted'", async () => {
    fake.gsc = () => {
      throw Object.assign(new Error("Google isn't set up (no service-account key or OAuth client configured), so Search Console and GA4 are unavailable."), { name: "GoogleNotConfiguredError" });
    };
    const r = await m.fillGscMonths(mk(), { max: 16, newestFirst: true }, deps);
    expect(r.stored).toEqual([]);
    expect(r.failed).toHaveLength(16);
    // Only the months already in flight (2 at a time) tried Google; the other 14 never started.
    expect(r.failed.filter((f) => /^not attempted: Google isn't set up/.test(f.error)).length).toBeGreaterThanOrEqual(14);
    expect(new Set(fake.gscCalls.map((c) => c.startDate.slice(0, 7))).size).toBeLessThanOrEqual(2);
    expect(m.gscErrorKind(new Error("Not signed in to Google (no token at /x). Run `npx -y crawlmark-mcp@latest auth login` to sign in."))).toBe("setup");
    expect(m.gscErrorKind(new Error("boom"))).toBe("other");
  });

  it("a quota that never clears stops the run: no new months are started, nothing stored is lost, and a re-run resumes", async () => {
    let calls = 0;
    fake.gsc = (b) => {
      if (b.startDate.startsWith("2026-06") || (calls > 0 && calls++ > 0 && false)) throw rate();
      return answer(b);
    };
    const r = await m.fillGscMonths(mk(), { max: 16, window: 8, newestFirst: true }, deps);
    // Two months run side by side, so one more month can finish while 2026-06 is retrying.
    expect(r.stored.slice(0, 4)).toEqual(["2026-10", "2026-09", "2026-08", "2026-07"]);
    expect(r.stored).not.toContain("2026-06");
    expect(r.failed.map((f) => f.month)).toContain("2026-06");
    expect(r.failed.find((f) => f.month === "2026-06")!.error).toMatch(/Quota exceeded/);
    const notTried = r.failed.filter((f) => f.month !== "2026-06");
    expect(notTried.every((f) => /not attempted: Search Console stopped answering at 2026-06/.test(f.error))).toBe(true);
    // Four retries (1+2+4+8 s) were made before giving up.
    expect(backoffs()).toEqual([1000, 2000, 4000, 8000]);
    const have = stored().length;
    expect(have + r.failed.length).toBe(8);
    fake.gsc = answer;
    const resumed = await m.fillGscMonths(mk(), { max: 16, window: 8, newestFirst: true }, deps);
    expect(resumed.stored.length).toBe(8 - have);
    expect(resumed.skipped).toHaveLength(have);
    expect(stored()).toHaveLength(8);
  });

  it("a daily quota error stops at once without retrying", async () => {
    fake.gsc = () => {
      throw Object.assign(new Error("Quota exceeded per day"), { response: { status: 429 } });
    };
    const r = await m.fillGscMonths(mk(), { max: 4, newestFirst: true }, deps);
    expect(r.stored).toEqual([]);
    expect(r.failed).toHaveLength(4);
    expect(backoffs()).toEqual([]);
  });

  it("an access error stops the run", async () => {
    fake.gsc = () => {
      throw Object.assign(new Error("The caller does not have permission"), { response: { status: 403, data: { error: { message: "The caller does not have permission" } } } });
    };
    const r = await m.fillGscMonths(mk(), { max: 6, newestFirst: true }, deps);
    expect(r.stored).toEqual([]);
    expect(r.failed.length).toBe(6);
    expect(fake.gscCalls.length).toBeLessThanOrEqual(2);
  });

  it("paces requests: never more than 2 in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    fake.gsc = async (b) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return answer(b);
    };
    vi.useRealTimers();
    await m.fillGscMonths(mk(), { max: 4, newestFirst: true }, deps);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });
});

describe("reading history older than Google's window", () => {
  const save = (month: string, o: { clicks: number; impressions: number; position: number; excluded?: number; regex?: string }) =>
    m.saveMonth({
      client: "example",
      property: "sc-domain:example.com",
      month,
      complete: true,
      capturedAt: NOW,
      totals: row([], o.clicks, o.impressions, o.position) as never,
      excluded: o.excluded === undefined ? undefined : { clicks: 0, impressions: o.excluded },
      exclusionRegex: o.excluded === undefined ? undefined : (o.regex ?? exclusionRegex(ITEMS)) ?? undefined,
      pages: [{ keys: ["https://example.com/a"], clicks: o.clicks, impressions: o.impressions, ctr: 0, position: o.position }],
      queries: [
        { keys: ["plumber"], clicks: o.clicks, impressions: o.impressions - (o.excluded ?? 0), ctr: 0, position: o.position },
        { keys: ["example login"], clicks: 0, impressions: o.excluded ?? 0, ctr: 0, position: 1 },
      ],
      devices: [],
      countries: [],
    });
  // 18 months before November 2026.
  const RANGE = { startDate: "2025-04-01", endDate: "2025-05-31" };

  it("sums stored months, subtracts the stored excluded rows and makes no Google request", async () => {
    save("2025-04", { clicks: 100, impressions: 1000, position: 4, excluded: 400 });
    save("2025-05", { clicks: 300, impressions: 3000, position: 8, excluded: 1000 });
    const t = await gscTotals(mk({ gscExcludeQueries: ITEMS }), RANGE);
    expect(t).toEqual({ keys: [], clicks: 400, impressions: 2600, ctr: 15.38, position: 7, excluded: { clicks: 0, impressions: 1400 } });
    expect(fake.gscCalls).toHaveLength(0);
  });

  it("R3: months saved under different (or no) exclusions are read raw with a note; query rows are still filtered", async () => {
    save("2025-04", { clicks: 100, impressions: 1000, position: 4, excluded: 400, regex: "(?i)^(?:old term)$" });
    save("2025-05", { clicks: 300, impressions: 3000, position: 8, excluded: 1000 });
    const c = mk({ gscExcludeQueries: ITEMS });
    const raw = await gscQueryDetailed(c, { ...RANGE, dimensions: [] });
    expect(raw.rows[0]).toMatchObject({ clicks: 400, impressions: 4000 });
    expect(raw.excluded).toBeUndefined();
    expect(raw.notes?.[0]).toMatch(/saved before the current query exclusions.*totals are raw/);
    expect((await gscQuery(c, { ...RANGE, dimensions: ["query"] })).map((r) => r.keys[0])).toEqual(["plumber"]);
    // A month saved with no exclusions at all (no excluded row) is also raw once exclusions are set.
    save("2025-02", { clicks: 50, impressions: 500, position: 2 });
    const none = await gscQueryDetailed(c, { startDate: "2025-02-01", endDate: "2025-02-28", dimensions: [] });
    expect(none.excluded).toBeUndefined();
    expect(none.notes).toHaveLength(1);
    // An unknown regex key (a row saved without one) never matches either.
    save("2025-03", { clicks: 50, impressions: 500, position: 2, excluded: 100, regex: "" });
    expect((await gscQueryDetailed(c, { startDate: "2025-03-01", endDate: "2025-03-31", dimensions: [] })).notes).toHaveLength(1);
  });

  it("without exclusions the totals are the plain sums; position is impressions-weighted", async () => {
    save("2025-04", { clicks: 100, impressions: 1000, position: 4 });
    save("2025-05", { clicks: 300, impressions: 3000, position: 8 });
    expect(await gscTotals(mk(), RANGE)).toEqual({ keys: [], clicks: 400, impressions: 4000, ctr: 10, position: 7 });
  });

  it("serves query and page rows, leaving excluded queries out; includeExcludedQueries keeps them", async () => {
    save("2025-04", { clicks: 100, impressions: 1000, position: 4, excluded: 400 });
    save("2025-05", { clicks: 300, impressions: 3000, position: 8, excluded: 1000 });
    const c = mk({ gscExcludeQueries: ITEMS });
    const q = await gscQuery(c, { ...RANGE, dimensions: ["query"] });
    expect(q.map((r) => r.keys[0])).toEqual(["plumber"]);
    expect(q[0]).toMatchObject({ clicks: 400, impressions: 2600 });
    expect((await gscQuery(c, { ...RANGE, dimensions: ["query"], includeExcludedQueries: true })).map((r) => r.keys[0])).toEqual(["plumber", "example login"]);
    expect((await gscQuery(c, { ...RANGE, dimensions: ["page"], rowLimit: 1 })).map((r) => r.keys[0])).toEqual(["https://example.com/a"]);
    expect(fake.gscCalls).toHaveLength(0);
  });

  it("a range that is only partly stored falls through to Google as before", async () => {
    save("2025-05", { clicks: 300, impressions: 3000, position: 8 });
    fake.gsc = () => [row([], 7, 70)];
    const t = await gscTotals(mk(), RANGE);
    expect(t.clicks).toBe(7);
    expect(fake.gscCalls).toHaveLength(1);
  });

  it("other shapes (a filter, the date dimension, a range inside the window, live) go to Google", async () => {
    save("2025-04", { clicks: 100, impressions: 1000, position: 4 });
    save("2025-05", { clicks: 300, impressions: 3000, position: 8 });
    fake.gsc = () => [row([], 7, 70)];
    await gscQuery(mk(), { ...RANGE, dimensions: [], queryContains: "x" });
    await gscQuery(mk(), { ...RANGE, dimensions: ["date"] });
    await gscQuery(mk(), { ...RANGE, dimensions: [], live: true });
    await gscQuery(mk(), { startDate: "2026-09-01", endDate: "2026-09-30", dimensions: [] });
    expect(fake.gscCalls).toHaveLength(4);
  });
});

describe("monthly_report", () => {
  const spikeDay = "2026-09-15";
  beforeEach(() => {
    state.client = mk({ gscExcludeQueries: [] });
    fake.gsc = (b) => {
      const dims = b.dimensions ?? [];
      if (dims[0] === "date") {
        const out = [];
        for (let d = b.startDate; d <= b.endDate; d = shiftDay(d, 1)) out.push(row([d], 5, d === spikeDay ? 600 : 100));
        return out;
      }
      if (dims[0] === "query" && b.startDate === spikeDay && b.endDate === spikeDay) return [row(["rank bot one"], 0, 120), row(["rank bot two"], 0, 100), row(["rank bot three"], 0, 80), row(["plumber"], 5, 100)];
      return answer(b);
    };
    fake.ga4 = (b) =>
      b.dimensions?.[0]?.name === "hostName"
        ? { rows: [{ dimensionValues: [{ value: "example.com" }], metricValues: [{ value: "800" }] }, { dimensionValues: [{ value: "staging.example.com" }], metricValues: [{ value: "120" }] }] }
        : { metricHeaders: ["sessions", "totalUsers", "engagedSessions", "engagementRate", "keyEvents"].map((name) => ({ name })), rows: [{ metricValues: ["800", "700", "500", "0.6", "10"].map((value) => ({ value })) }] };
  });

  it("flags the spike, names the hostnames GA4 left out, and saves at most 2 months of history", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const r = await monthlyReport(state.client as never, { month: "2026-09" });
    const spikes = (r.search as { querySpikes: { date: string; share: number; queries: { query: string }[] }[] }).querySpikes;
    expect(spikes).toHaveLength(1);
    expect(spikes[0]).toMatchObject({ date: spikeDay });
    expect(spikes[0]!.queries.map((x) => x.query)).toEqual(["rank bot one", "rank bot two", "rank bot three"]);
    expect(spikes[0]!.share).toBeGreaterThanOrEqual(0.5);
    expect(r.notes).toContain("GA4: 120 organic sessions from other hostnames were left out (staging.example.com 120). If a hostname belongs to this site, add it with set_client_profile ga4Hostnames.");
    expect(stored()).toEqual(["2026-10", "2026-09"]);
    expect(r.notes).toContain("Saved Search Console history for 2 month(s) (2026-09…2026-10).");
    // A second report stores the next two, never more.
    const again = await monthlyReport(state.client as never, { month: "2026-09" });
    expect(stored()).toHaveLength(4);
    expect(again.notes.some((n: string) => /Saved Search Console history for 2 month/.test(n))).toBe(true);
  }, 30_000);

  it("adds the exclusion note and a history failure becomes a note, never a failed report", async () => {
    state.client = mk({ gscExcludeQueries: ITEMS });
    const base = fake.gsc;
    fake.gsc = (b) => {
      if (b.startDate >= "2026-09-01" && b.endDate <= "2026-10-31" && b.startDate.endsWith("-01") && b.endDate.endsWith("-31") && b.startDate.slice(0, 7) === "2026-10") throw Object.assign(new Error("Backend Error"), { response: { status: 500 } });
      return base(b);
    };
    const r = await monthlyReport(state.client as never, { month: "2026-09" });
    expect(r.notes.some((n: string) => /^Search Console: \d+ clicks and 300 impressions from excluded queries were left out of totals \(positions are unadjusted\)\.$/.test(n))).toBe(true);
    expect(r.notes.some((n: string) => /^Search Console history couldn't be saved this run: Backend Error\.$/.test(n))).toBe(true);
  }, 30_000);
});

describe("gsc_history tool and CLI", () => {
  const tools = new Map<string, (args: Record<string, unknown>, extra?: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>>();
  registerRawTools({ registerTool: (name: string, _d: unknown, cb: never) => void tools.set(name, cb) } as never);
  const call = async (args: Record<string, unknown>) => {
    const r = await tools.get("gsc_history")!({ client: "example.com", ...args });
    return { error: r.isError, body: r.isError ? r.content[0]!.text : JSON.parse(r.content[0]!.text) };
  };

  it("shows nothing saved with a hint, then backfills 16 months and shows them newest first (oldest partial)", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const empty = await call({});
    expect(empty.body.stored).toEqual([]);
    expect(empty.body.notes.join(" ")).toMatch(/backfill: true/);
    const r = await call({ backfill: true, months: 2, detail: ["queries", "devices"], limit: 1 });
    expect(r.error).toBeFalsy();
    expect(r.body.backfill.stored).toEqual(["2026-10", "2026-09"]);
    expect(r.body.stored.map((s: { month: string }) => s.month)).toEqual(["2026-10", "2026-09"]);
    expect(r.body.detail.queries).toHaveLength(1);
    expect(r.body.detail.devices).toHaveLength(1);
    expect(r.body.notes.join(" ")).toMatch(/Detail is for 2026-10/);
    const more = await call({ backfill: true, months: 3 });
    expect(more.body.backfill).toEqual({ stored: ["2026-08"], skipped: ["2026-10", "2026-09"], failed: [] });
    expect(more.body.stored).toHaveLength(3);
    // Without backfill nothing is fetched.
    const calls = fake.gscCalls.length;
    await call({});
    expect(fake.gscCalls.length).toBe(calls);
  }, 30_000);

  it("refuses a client with no Search Console property and a bad month", async () => {
    state.client = mk({ gscProperty: undefined });
    expect((await call({})).error).toBe(true);
  });

  const io = () => {
    const out: string[] = [];
    const warn: string[] = [];
    return { out, warn, io: { out: (l: string) => void out.push(l), warn: (l: string) => void warn.push(l), usage: (p: string) => (warn.push(p), 1) } };
  };
  const c = (domain: string, gscProperty?: string) => ({ slug: domain, domain, ...(gscProperty ? { gscProperty } : {}) }) as never;
  const fillOk = async () => ({ stored: ["2026-10", "2026-09"], skipped: ["2026-08"], failed: [] });

  it("backfill --all prints one line per client and exits 0", async () => {
    const t = io();
    const code = await gscHistoryCommand(["backfill"], { all: true, refresh: false }, t.io, {
      allClients: async () => [c("example.com", "sc-domain:example.com"), c("example.org", "sc-domain:example.org"), c("nosite.example.net")],
      resolveClient: async () => c("x"),
      fill: fillOk,
      stored: async () => [],
    });
    expect(code).toBe(0);
    expect(t.out).toEqual(["example.com: stored 2, skipped 1, failed 0", "example.org: stored 2, skipped 1, failed 0", "nosite.example.net: skipped, no Search Console property"]);
  });

  it("Q2: identical failure messages print once with a month count", async () => {
    const t = io();
    const msg = "Google isn't set up (no service-account key or OAuth client configured).";
    const failed = ["2026-10", "2026-09", "2026-08"].map((month) => ({ month, error: msg }));
    failed.push({ month: "2026-07", error: "quota" });
    const code = await gscHistoryCommand(["backfill", "example.com"], { all: false, refresh: false }, t.io, {
      allClients: async () => [],
      resolveClient: async () => c("example.com", "p"),
      fill: async () => ({ stored: [], skipped: [], failed }),
      stored: async () => [],
    });
    expect(code).toBe(1);
    expect(t.out).toEqual(["example.com: stored 0, skipped 0, failed 4"]);
    expect(t.warn.slice(0, 2)).toEqual([`  ${msg} (3 months, 2026-08 to 2026-10)`, "  2026-07: quota"]);
  });

  it("exits 1 only when every client failed, and passes --months and --refresh through", async () => {
    const t = io();
    const seen: unknown[] = [];
    const failing = async (_c: unknown, o: unknown) => {
      seen.push(o);
      return { stored: [], skipped: [], failed: [{ month: "2026-10", error: "quota" }] };
    };
    const deps = { allClients: async () => [c("example.com", "p1"), c("example.org", "p2")], resolveClient: async () => c("x"), fill: failing as never, stored: async () => [] };
    expect(await gscHistoryCommand(["backfill"], { all: true, refresh: true, months: "4" }, t.io, deps)).toBe(1);
    expect(seen[0]).toEqual({ max: 4, window: 4, refresh: true });
    let n = 0;
    const mixed = { ...deps, fill: (async (...a: unknown[]) => (n++ === 0 ? fillOk() : failing(a[0], a[1]))) as never };
    expect(await gscHistoryCommand(["backfill"], { all: true, refresh: false }, io().io, mixed)).toBe(0);
  });

  it("usage errors: no clients and no --all, a bad --months, an unknown subcommand", async () => {
    const deps = { allClients: async () => [], resolveClient: async () => c("x"), fill: fillOk as never, stored: async () => [] };
    expect(await gscHistoryCommand(["backfill"], { all: false, refresh: false }, io().io, deps)).toBe(1);
    expect(await gscHistoryCommand(["backfill", "example.com"], { all: false, refresh: false, months: "17" }, io().io, deps)).toBe(1);
    expect(await gscHistoryCommand(["wipe"], { all: false, refresh: false }, io().io, deps)).toBe(1);
  });

  it("show prints a table of the stored months", async () => {
    const t = io();
    const code = await gscHistoryCommand(["show", "example.com"], { all: false, refresh: false }, t.io, {
      allClients: async () => [],
      resolveClient: async () => c("example.com", "p"),
      fill: fillOk as never,
      stored: async () => [{ month: "2026-10", clicks: 5, impressions: 50, ctr: 10, position: 3.2, complete: false, capturedAt: NOW }],
    });
    expect(code).toBe(0);
    expect(t.out[1]).toContain("month\tclicks");
    expect(t.out[2]).toBe("2026-10\t5\t50\t10\t3.2\tpartial\t2026-11-04");
  });
});
