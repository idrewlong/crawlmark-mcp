/**
 * Indexing "check all pages" (2026-10-14): inspect_index_coverage { all: true } and index-coverage --all-pages
 * inspect every key, top and sitemap URL in the property when they fit in what's left of today's budget, and
 * otherwise continue the rotation and say how many runs a full pass needs; index_coverage and the report
 * section say when the sitemap check is complete. Search Console is a fake (googleapis mocked); example.com
 * only; no network.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";

const fake = vi.hoisted(() => ({ log: [] as string[], quotaOn: 0, inspections: 0, byUrl: {} as Record<string, unknown>, defaultResult: undefined as unknown }));

vi.mock("googleapis", () => ({
  google: {
    searchconsole: () => ({
      urlInspection: {
        index: {
          inspect: async ({ requestBody }: { requestBody: { inspectionUrl: string; siteUrl: string } }) => {
            fake.inspections++;
            fake.log.push(`inspect ${requestBody.inspectionUrl}`);
            if (fake.quotaOn && fake.inspections === fake.quotaOn) {
              const message = "Quota exceeded for quota metric 'URL Inspection requests' and limit 'URL Inspection requests per day per site'";
              throw Object.assign(new Error(message), { code: 429, response: { status: 429, data: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message } } } });
            }
            return { data: fake.byUrl[requestBody.inspectionUrl] ?? fake.defaultResult };
          },
        },
      },
      sitemaps: { list: async () => ({ data: { sitemap: [] } }) },
      searchanalytics: { query: async () => ({ data: { rows: [] } }) },
    }),
  },
}));
vi.mock("../src/providers/google.js", () => ({
  googleAuth: () => ({}),
  googleAuthIdentity: () => "sa:test@example.com",
  googleConfigured: () => true,
  assertGoogleConfigured: () => {},
  googleAuthStatus: () => ({ mode: "service_account", auto: false, configured: true, email: "test@example.com" }),
}));

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/google/p13/${name}`, import.meta.url), "utf8"));
fake.defaultResult = fixture("url-inspection-indexed.json");

const { fullPassSet, planPool, progressText, sitemapProgress } = await import("../src/analysis/indexing.js");
const { inspectIndexCoverage, indexCoverage, loadIndexingDeps } = await import("../src/reports/indexing.js");
const { quotaFor, storedSitemapSet, saveFailedInspection } = await import("../src/lib/inspections.js");
const { indexCoverageCommand, CLI_ALL_PAGES_TIME_LIMIT_MS } = await import("../src/index-coverage-cli.js");
const { SECTION_MAPPERS } = await import("../src/reports/render/sections.js");

const E = "https://example.com";
const NOW = Date.parse("2026-10-14T12:00:00Z");
const DAY = 86_400_000;

beforeEach(() => {
  fake.log.length = 0;
  fake.quotaOn = 0;
  fake.inspections = 0;
  fake.byUrl = {};
});

const client = (slug: string, property: string, keyPages: string[] = [`${E}/`]): Client => ({ slug, domain: "example.com", name: "Example Co", gscProperty: property, keyPages, aliases: [] }) as unknown as Client;

async function deps(o: { sitemapUrls?: string[]; top?: string[]; now?: () => number; budget?: number; perMinute?: number; sitemapsFail?: boolean } = {}) {
  const real = await loadIndexingDeps();
  return {
    ...real,
    now: o.now ?? (() => NOW),
    sleep: async () => undefined,
    topPages: async () => o.top ?? [],
    sitemapUrls: async () => {
      if (o.sitemapsFail) throw new Error("sitemap unreachable");
      return o.sitemapUrls ?? [];
    },
    sitemaps: async () => [],
    ...(o.budget ? { budget: o.budget } : {}),
    ...(o.perMinute ? { perMinute: o.perMinute } : {}),
  };
}

const sitemap = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${E}/${prefix}/p${i}`);
const inspected = () => fake.log.filter((l) => l.startsWith("inspect"));

describe("full pass helpers (pure)", () => {
  it("the full set is the unique in-property key, top and sitemap URLs", () => {
    const set = fullPassSet({ property: "sc-domain:example.com", keyPages: [`${E}/`, `${E}`], gscTop: [`${E}/a`, "https://example.net/x"], sitemapUrls: [`${E}/a`, `${E}/b`, "mailto:x@example.com"] });
    expect([...set].sort()).toEqual([E, `${E}/a`, `${E}/b`].sort());
  });

  it("onlyListed leaves URLs that dropped out of the set out of the 'oldest' group", () => {
    const last = new Map([[`${E}/gone`, NOW - 30 * DAY], [`${E}/a`, NOW - 20 * DAY]]);
    const base = { property: "sc-domain:example.com", keyPages: [], gscTop: [], sitemapUrls: [`${E}/a`], lastInspected: last, now: NOW, staleDays: 7, seed: "s", max: 100 };
    expect(planPool(base).map((p) => p.url)).toEqual([`${E}/gone`, `${E}/a`]);
    expect(planPool({ ...base, onlyListed: true }).map((p) => p.url)).toEqual([`${E}/a`]);
  });

  it("progress: N of M checked in the last K days (30-day window), complete only when all are", () => {
    const urls = [`${E}/a`, `${E}/b`, `${E}/c`];
    const some = sitemapProgress(urls, new Map([[`${E}/a`, NOW - 2 * DAY], [`${E}/b`, NOW - 40 * DAY]]), NOW);
    expect(some).toEqual({ sitemapUrls: 3, checked: 1, windowDays: 2, complete: false });
    expect(progressText(some)).toBe("A sample: 1 of 3 sitemap URLs checked in the last 2 days.");
    const all = sitemapProgress(urls, new Map(urls.map((u) => [u, NOW - DAY / 2])), NOW);
    expect(all).toMatchObject({ checked: 3, complete: true, windowDays: 1 });
    expect(progressText(all)).toBe("Complete: all 3 sitemap pages checked in the last 1 day.");
    expect(sitemapProgress([], new Map(), NOW).complete).toBe(false);
  });
});

describe("inspect_index_coverage { all: true }", () => {
  it("inspects every URL when the set fits in today's budget, reports the pass complete, and index_coverage says so", async () => {
    const property = "https://example.com/fit/";
    const c = client("all-fit.example.com", property, [`${E}/fit/`]);
    const urls = sitemap("fit", 23);
    const d = await deps({ sitemapUrls: urls, top: [`${E}/fit/p1`, `${E}/elsewhere`] });
    const dry = await inspectIndexCoverage(c, { all: true, dryRun: true }, d);
    expect(dry.fullPass).toEqual({ urls: 24, fresh: 0, needed: 24, capacity: 541, fitsToday: true, runsNeeded: 1, sitemapKnown: true });
    expect(inspected()).toEqual([]);

    const r = await inspectIndexCoverage(c, { all: true }, d);
    expect(r).toMatchObject({ planned: 24, inspected: 24, failed: 0, stoppedBy: null });
    expect(inspected()).toHaveLength(24);
    expect(r.sitemapCoverage).toMatchObject({ sitemapUrls: 23, checked: 23, complete: true, text: "Complete: all 23 sitemap pages checked in the last 1 day." });
    expect(storedSitemapSet(c.slug, property)?.urls).toHaveLength(23);
    expect(quotaFor(property, "2026-10-14").used).toBe(24);

    // A second run the same day has nothing left to check.
    const again = await inspectIndexCoverage(c, { all: true }, d);
    expect(again).toMatchObject({ planned: 0, inspected: 0, fullPass: { needed: 0, fresh: 24 } });
    expect(again.notes.join(" ")).toMatch(/All 24 pages were checked in the last 7 days/);

    const cov = await indexCoverage(c, {}, d);
    expect(cov.coverage).toMatchObject({ sitemapUrls: 23, checked: 23, complete: true });
    expect(cov.notes.join(" ")).toContain("Complete: all 23 sitemap pages checked");
    // The report section calls it complete instead of a sample.
    const blocks = SECTION_MAPPERS.indexing_issues!(cov as never, {} as never, { domain: "example.com", onepage: false } as never) as { kind: string; text?: { t?: string }[] }[];
    const note = blocks.filter((b) => b.kind === "note").flatMap((b) => b.text ?? []).map((x) => x.t ?? "").join(" ");
    expect(note).toContain("all 23 sitemap pages");
    expect(note).not.toContain("rotating sample");
  });

  it("when the set doesn't fit in today's budget it checks what's left in rotation order and says how many runs a full pass needs; the next day continues", async () => {
    const property = "https://example.com/big/";
    const c = client("all-big.example.com", property, [`${E}/big/`]);
    const urls = sitemap("big", 30);
    let now = NOW;
    const d = await deps({ sitemapUrls: urls, budget: 12, now: () => now });
    const r = await inspectIndexCoverage(c, { all: true }, d);
    expect(r.fullPass).toEqual({ urls: 31, fresh: 0, needed: 31, capacity: 12, fitsToday: false, runsNeeded: 3, sitemapKnown: true });
    expect(r).toMatchObject({ planned: 12, inspected: 12, stoppedBy: "budget" });
    expect(r.notes.join(" ")).toMatch(/A full pass needs 31 inspections .* 12 of today's 12 inspections are left\. This run checks 12 in rotation order; about 3 daily runs complete the pass/);
    expect(r.sitemapCoverage).toMatchObject({ sitemapUrls: 30, checked: 11, complete: false, text: "A sample: 11 of 30 sitemap URLs checked in the last 1 day." });
    // Next Pacific day: no URL is inspected twice until the pass is complete.
    now = NOW + DAY;
    const r2 = await inspectIndexCoverage(c, { all: true }, d);
    expect(r2.fullPass).toMatchObject({ needed: 19, fresh: 12, runsNeeded: 2 });
    now = NOW + 2 * DAY;
    const r3 = await inspectIndexCoverage(c, { all: true }, d);
    expect(r3).toMatchObject({ inspected: 7, stoppedBy: null, fullPass: { needed: 7, fitsToday: true } });
    expect(new Set(inspected()).size).toBe(31);
    expect(r3.sitemapCoverage?.complete).toBe(true);
  });

  it("a run's time limit caps the pass too, and the note says so", async () => {
    const c = client("all-time.example.com", "https://example.com/time/", []);
    const d = await deps({ sitemapUrls: sitemap("time", 20), perMinute: 1 });
    const r = await inspectIndexCoverage(c, { all: true, dryRun: true, timeLimitMs: 5 * 60_000 }, d);
    expect(r.fullPass).toMatchObject({ needed: 20, capacity: 6, fitsToday: false });
    expect(r.stoppedBy).toBe("time");
    expect(r.notes.join(" ")).toMatch(/one run can make about 6 at 1 a minute/);
  });

  it("R-1: pacing is start to start, so a run with Google answering in under the gap makes the planned capacity", async () => {
    const c = client("all-pace.example.com", "https://example.com/pace/", []);
    let clock = NOW;
    const starts: number[] = [];
    const base = await deps({ sitemapUrls: sitemap("pace", 6), perMinute: 1, now: () => clock });
    const d = {
      ...base,
      sleep: async (ms: number) => void (clock += ms),
      inspect: async (cl: Client, url: string) => {
        starts.push(clock - NOW);
        clock += 30_000; // Google takes 30 s; the gap is 60 s
        return base.inspect(cl, url);
      },
    };
    const r = await inspectIndexCoverage(c, { all: true, timeLimitMs: 5 * 60_000 }, d);
    expect(r.fullPass).toMatchObject({ needed: 6, capacity: 6, fitsToday: true });
    expect(r).toMatchObject({ inspected: 6, stoppedBy: null });
    expect(starts).toEqual([0, 60_000, 120_000, 180_000, 240_000, 300_000]);
  });

  it("a full pass retries a URL whose last attempt failed (after a day); a normal run still rotates it to the back", async () => {
    const property = "https://example.com/retry/";
    const c = client("all-retry.example.com", property, []);
    const urls = sitemap("retry", 5);
    // /p0-/p2 were checked; /p3 failed 2 days ago and /p4 an hour ago, neither ever succeeded.
    await inspectIndexCoverage(c, { all: true }, await deps({ sitemapUrls: urls.slice(0, 3) }));
    const T = NOW + 2 * 86_400_000;
    saveFailedInspection({ client: c.slug, property, url: urls[3]!, origin: "sitemap", inspectedAt: NOW });
    saveFailedInspection({ client: c.slug, property, url: urls[4]!, origin: "sitemap", inspectedAt: T - 60 * 60_000 });
    const d = await deps({ sitemapUrls: urls, now: () => T });
    const r = await inspectIndexCoverage(c, { all: true, dryRun: true }, d);
    expect(r.fullPass).toMatchObject({ urls: 5, needed: 1, fresh: 4 });
    expect(r.planned).toBe(1);
    // The normal rotation counts every attempt, so nothing is due yet.
    expect((await inspectIndexCoverage(c, { maxInspections: 5, dryRun: true }, d)).planned).toBe(0);
  });

  it("keeps the stop rules: a quota error stops the pass and marks the day used up", async () => {
    const property = "https://example.com/quota/";
    const c = client("all-quota.example.com", property, []);
    fake.quotaOn = 3;
    const r = await inspectIndexCoverage(c, { all: true }, await deps({ sitemapUrls: sitemap("quota", 10) }));
    expect(r).toMatchObject({ inspected: 2, stoppedBy: "quota", quota: { exhausted: true } });
    expect(inspected()).toHaveLength(3);
  });

  it("refuses all together with maxInspections; without readable sitemaps it covers key and top pages and says so", async () => {
    const c = client("all-nosm.example.com", "https://example.com/nosm/", [`${E}/nosm/`]);
    await expect(inspectIndexCoverage(c, { all: true, maxInspections: 5 }, await deps())).rejects.toThrow(/either all .* or maxInspections/);
    const r = await inspectIndexCoverage(c, { all: true, dryRun: true }, await deps({ sitemapsFail: true, top: [`${E}/nosm/top`] }));
    expect(r.fullPass).toMatchObject({ urls: 2, sitemapKnown: false });
    expect(r.sitemapCoverage).toBeUndefined();
    expect(r.notes.join(" ")).toMatch(/covers key pages and top Search Console pages only/);
  });
});

describe("crawlmark-cli index-coverage --all-pages", () => {
  const io = () => {
    const outs: string[] = [];
    const usage: string[] = [];
    return { outs, usage, io: { out: (l: string) => outs.push(l), warn: () => undefined, usage: (p: string) => (usage.push(p), 1) } };
  };
  const flags = { all: false, client: "x", "dry-run": false } as const;
  it("passes all with the longer CLI time limit, and refuses --max with it", async () => {
    const seen: unknown[] = [];
    const c = client("cli-all.example.com", "https://example.com/cli/");
    const run = async (_c: Client, o: unknown) => (seen.push(o), { property: "p", planned: 0, inspected: 0, failed: 0, stoppedBy: null, quota: { day: "d", used: 0, budget: 1, exhausted: false }, byOrigin: { recheck: 0, key: 0, gsc_top: 0, sitemap: 0, oldest: 0 }, notes: [] });
    const a = io();
    expect(await indexCoverageCommand([], { ...flags, "all-pages": true }, a.io, { loadClients: async () => ({ clients: [c], skipped: [] }), run })).toBe(0);
    expect(seen[0]).toEqual({ all: true, timeLimitMs: CLI_ALL_PAGES_TIME_LIMIT_MS, dryRun: false });
    const b = io();
    expect(await indexCoverageCommand([], { ...flags, "all-pages": true, max: "5" }, b.io, { loadClients: async () => ({ clients: [c], skipped: [] }), run })).toBe(1);
    expect(b.usage[0]).toMatch(/leave out --max/);
  });
});
