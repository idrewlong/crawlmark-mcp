/**
 * Release A, D7: URL Inspection is sent the exact URL (trailing slash kept), the stored row remembers it,
 * and earlier "URL is unknown to Google" results made with the slash stripped are re-checked first.
 * Injected deps only: no network, no Google.
 */
import { describe, expect, it } from "vitest";
import type { Client } from "../src/config.js";
import type { InspectionRecord } from "../src/lib/inspections.js";
import type { IndexingDeps } from "../src/reports/indexing.js";
import { planPool } from "../src/analysis/indexing.js";
import { indexCoverage, inspectIndexCoverage } from "../src/reports/indexing.js";
import { latestInspections, lastInspectedAt, lastSuccessfulAt, legacyUnknownUrls, saveFailedInspection, saveInspection, saveSitemapSet } from "../src/lib/inspections.js";
import { db } from "../src/lib/store.js";

const E = "https://example.com";
const NOW = Date.parse("2026-11-01T12:00:00Z");
const DAY = 86_400_000;

const client = (slug: string, keyPages: string[] = [`${E}/`]): Client => ({ slug, domain: "example.com", name: "Example Co", gscProperty: "sc-domain:example.com", keyPages, aliases: [] }) as unknown as Client;

const PASS: InspectionRecord = { url: "", verdict: "PASS", coverageState: "Submitted and indexed", indexingState: "INDEXING_ALLOWED", pageFetchState: "SUCCESSFUL", robotsTxtState: "ALLOWED", googleCanonical: null, userCanonical: null, lastCrawlTime: null, crawledAs: "MOBILE" };
const UNKNOWN: InspectionRecord = { ...PASS, verdict: "NEUTRAL", coverageState: "URL is unknown to Google", indexingState: null, pageFetchState: null, robotsTxtState: null };

function deps(sent: string[], sitemap: string[], extra: Partial<IndexingDeps> = {}): IndexingDeps {
  return {
    now: () => NOW,
    sleep: async () => undefined,
    inspect: async (_c, url) => {
      sent.push(url);
      return { ...PASS, url };
    },
    errorKind: () => "other",
    topPages: async () => [],
    sitemapUrls: async () => sitemap,
    sitemaps: async () => [],
    budget: 100,
    perMinute: 600,
    ...extra,
  };
}

// Raw rows with the 0.1.3 shape (no inspected_url): what an upgraded database holds.
function legacyRow(c: Client, url: string, coverage: string, o: { origin?: string; failed?: number; at?: number } = {}) {
  db.prepare("INSERT INTO url_inspections (client, property, url, inspected_at, origin, verdict, coverage_state, in_sitemap, failed) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)").run(c.slug, c.gscProperty!, url, o.at ?? NOW - 20 * DAY, o.origin ?? "sitemap", "NEUTRAL", coverage, o.failed ?? 0);
}

describe("D7: the exact URL is sent", () => {
  it("sends the sitemap's URL with its trailing slash and stores it in inspected_url", async () => {
    const c = client("d7-exact.example.com");
    const sent: string[] = [];
    await inspectIndexCoverage(c, { maxInspections: 10 }, deps(sent, [`${E}/about/`, `${E}/services/`]));
    expect(sent).toContain(`${E}/about/`);
    expect(sent).toContain(`${E}/services/`);
    expect(sent).not.toContain(`${E}/about`);
    const row = db.prepare("SELECT url, inspected_url FROM url_inspections WHERE client = ? AND url = ?").get(c.slug, `${E}/about`) as { url: string; inspected_url: string };
    expect(row).toEqual({ url: `${E}/about`, inspected_url: `${E}/about/` });
  });

  it("stores the sent URL on failed inspections too", async () => {
    const c = client("d7-failed.example.com", []);
    await inspectIndexCoverage(c, { maxInspections: 1 }, deps([], [`${E}/f/`], { inspect: async () => { throw new Error("boom"); } }));
    const row = db.prepare("SELECT inspected_url, failed FROM url_inspections WHERE client = ?").get(c.slug) as { inspected_url: string; failed: number };
    expect(row).toEqual({ inspected_url: `${E}/f/`, failed: 1 });
  });
});

describe("D7: legacy 'unknown to Google' results", () => {
  it("are left out of the stored picture, counted in a note, and planned first as recheck with the sitemap's raw form", async () => {
    const c = client("d7-legacy.example.com", []);
    legacyRow(c, `${E}/about`, "URL is unknown to Google");
    legacyRow(c, `${E}/ok`, "Submitted and indexed", { at: NOW - 20 * DAY });
    expect(legacyUnknownUrls(c.slug, c.gscProperty!)).toEqual([`${E}/about`]);
    expect(latestInspections(c.slug, c.gscProperty!).map((r) => r.url)).toEqual([`${E}/ok`]);
    expect(lastSuccessfulAt(c.slug, c.gscProperty!).has(`${E}/about`)).toBe(false);
    expect(lastInspectedAt(c.slug).has(`${E}/about`)).toBe(false);

    saveSitemapSet(c.slug, c.gscProperty!, [`${E}/about/`], NOW - DAY);
    const cov = await indexCoverage(c, {}, deps([], []));
    expect(cov.sample.inspected).toBe(1);
    expect(cov.notes.join("\n")).toMatch(/1 earlier "URL is unknown to Google" result\(s\) were made with the URL's trailing slash removed/);

    const sent: string[] = [];
    const r = await inspectIndexCoverage(c, { maxInspections: 5 }, deps(sent, [`${E}/about/`, `${E}/ok`, `${E}/new/`]));
    expect(sent[0]).toBe(`${E}/about/`);
    expect(r.byOrigin.recheck).toBe(1);
    expect(latestInspections(c.slug, c.gscProperty!).find((x) => x.url === `${E}/about`)?.coverageState).toBe("Submitted and indexed");
    expect(legacyUnknownUrls(c.slug, c.gscProperty!)).toEqual([]);
  });

  it("falls back to the next-older non-legacy row", () => {
    const c = client("d7-older.example.com", []);
    legacyRow(c, `${E}/x`, "Submitted and indexed", { at: NOW - 30 * DAY });
    legacyRow(c, `${E}/x`, "URL is unknown to Google", { at: NOW - 5 * DAY });
    expect(latestInspections(c.slug, c.gscProperty!).map((r) => r.coverageState)).toEqual(["Submitted and indexed"]);
  });

  it("are not planned when the URL is in no current source", () => {
    const pool = planPool({ property: "sc-domain:example.com", keyPages: [`${E}/`], gscTop: [], sitemapUrls: [`${E}/a/`], lastInspected: new Map(), recheck: [`${E}/gone`, `${E}/a`], now: NOW, staleDays: 7, seed: "s", max: 10 });
    expect(pool.map((p) => [p.url, p.inspectUrl, p.group])).toEqual([
      [`${E}/a`, `${E}/a/`, "recheck"],
      [E, `${E}/`, "key"],
    ]);
  });

  it("R4: a key page typed without the slash still sends Google's form from top pages or the sitemap", () => {
    const fromTop = planPool({ property: "sc-domain:example.com", keyPages: [`${E}/a`], gscTop: [`${E}/a/`], sitemapUrls: [], lastInspected: new Map(), now: NOW, staleDays: 7, seed: "s", max: 10 });
    expect(fromTop.map((p) => [p.url, p.inspectUrl])).toEqual([[`${E}/a`, `${E}/a/`]]);
    const fromSitemap = planPool({ property: "sc-domain:example.com", keyPages: [`${E}/b`], gscTop: [], sitemapUrls: [`${E}/b/`], lastInspected: new Map(), now: NOW, staleDays: 7, seed: "s", max: 10 });
    expect(fromSitemap.map((p) => p.inspectUrl)).toEqual([`${E}/b/`]);
    const keyOnly = planPool({ property: "sc-domain:example.com", keyPages: [`${E}/c`], gscTop: [], sitemapUrls: [], lastInspected: new Map(), now: NOW, staleDays: 7, seed: "s", max: 10 });
    expect(keyOnly.map((p) => p.inspectUrl)).toEqual([`${E}/c`]);
  });

  it("R2: the recheck note counts only URLs that will be re-checked; the rest get their own wording", async () => {
    const c = client("d7-note.example.com", [`${E}/key`]);
    legacyRow(c, `${E}/key`, "URL is unknown to Google");
    legacyRow(c, `${E}/map`, "URL is unknown to Google");
    legacyRow(c, `${E}/gone1`, "URL is unknown to Google");
    legacyRow(c, `${E}/gone2`, "URL is unknown to Google");
    saveSitemapSet(c.slug, c.gscProperty!, [`${E}/map/`], NOW - DAY);
    const notes = (await indexCoverage(c, {}, deps([], []))).notes.join("\n");
    expect(notes).toMatch(/2 earlier "URL is unknown to Google" result\(s\) were made with the URL's trailing slash removed/);
    expect(notes).toMatch(/2 older "URL is unknown to Google" result\(s\) are for URLs that are no longer key pages or in the sitemap/);
  });

  it("R2: manual-origin rows (gsc_inspect_url sends the URL as given) are not legacy-unknown", () => {
    const c = client("d7-manual.example.com", []);
    legacyRow(c, `${E}/m`, "URL is unknown to Google", { origin: "manual" });
    expect(legacyUnknownUrls(c.slug, c.gscProperty!)).toEqual([]);
  });

  it("audit-origin rows, failed rows and rows that carry inspected_url are not legacy-unknown", () => {
    const c = client("d7-audit.example.com", []);
    legacyRow(c, `${E}/aud`, "URL is unknown to Google", { origin: "audit" });
    legacyRow(c, `${E}/fail`, "URL is unknown to Google", { failed: 1 });
    saveInspection({ ...UNKNOWN, url: `${E}/new/`, client: c.slug, property: c.gscProperty!, origin: "sitemap", inspectedAt: NOW, inSitemap: true });
    saveFailedInspection({ client: c.slug, property: c.gscProperty!, url: `${E}/f/`, origin: "sitemap", inspectedAt: NOW });
    expect(legacyUnknownUrls(c.slug, c.gscProperty!)).toEqual([]);
    expect(latestInspections(c.slug, c.gscProperty!).map((r) => r.url).sort()).toEqual([`${E}/aud`, `${E}/new`]);
  });
});
