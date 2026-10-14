/**
 * The builtin Local SEO template (`local`) and the dashboard rendering of the local_profile and ai_visibility
 * sections: tiles, side-by-side tables, map positions marked "in the pack", operator notes kept out of files,
 * escaped untrusted text, cited URLs as code. Fixture data only (example.com); no network.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AiVisibilityData, LocalProfileData } from "../src/reports/report-types.js";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { toHtml } from "../src/reports/render/html.js";
import { toMarkdown } from "../src/reports/render/markdown.js";
import { isLocalIntent } from "../src/reports/templates/run.js";
import * as data from "./fixtures/reports/data.js";
import { fakeDeps } from "./fixtures/reports/deps.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const v = { version: "0.1.0" };
const LOCAL: LocalProfileData = {
  business: { title: "Example Plumbing Co", category: "Plumber", address: "100 Example St", url: "https://www.example.com/", rating: 4.7, votes: 132, ratingDistribution: { "1": 4, "2": 1, "3": 3, "4": 14, "5": 110 }, isClaimed: true, totalPhotos: 37, currentStatus: "opened" },
  location: "Smallville,Kansas,United States",
  pack: [
    { keyword: "emergency plumber", clientRank: 2, leader: { title: "Competitor A Plumbing", rating: 4.9, votes: 410 } },
    { keyword: "drain cleaning", clientRank: null, leader: null },
  ],
  notes: ["No area is set for example.com, so the map results are for location 2840, not the client's town. Set area with set_client_profile."],
};

describe("local intent", () => {
  it("near-me words and the client's town (whole words only)", () => {
    expect(isLocalIntent("plumber near me", undefined)).toBe(true);
    expect(isLocalIntent("24 hour plumber", undefined)).toBe(true);
    expect(isLocalIntent("plumber smallville", "Smallville,Kansas,United States")).toBe(true);
    expect(isLocalIntent("water heater repair", "Smallville,Kansas,United States")).toBe(false);
    expect(isLocalIntent("united states plumbing code", "Smallville,Kansas,United States")).toBe(false);
    expect(isLocalIntent("bigsmallvilleish", "Smallville,Kansas,United States")).toBe(false);
  });
});

describe("Local SEO template", () => {
  it("local-intent queries, or the top queries with a note; the paid profile left out when paid data isn't allowed", async () => {
    const r = await fixtureReport({ template: "local", include: [] });
    expect(r.sections.map((s) => [s.id, s.status])).toEqual([["search", "ok"], ["brand", "ok"], ["local", "skipped"], ["queries", "ok"], ["landing", "ok"], ["tracked", "ok"]]);
    const q = r.sections.find((s) => s.id === "queries") as { data: { rows: { keys: string[] }[]; intentFallback?: boolean } };
    expect(q.data.rows.map((x) => x.keys[0])).toEqual(["drain cleaning near me"]);
    expect(q.data.intentFallback).toBeUndefined();
    const md = toMarkdown(buildReportDoc(r, v));
    expect(md).toContain("## Local searches");
    expect(md).not.toMatch(/Local search \(Google Business Profile\)|allowPaid|--paid/);

    const none = fakeDeps({ gscQuery: async (c, o) => data.gscQuery(c, o).filter((x) => !/near me/.test(x.keys[0] ?? "")) });
    const r2 = await fixtureReport({ template: "local", include: [] }, none);
    const q2 = r2.sections.find((s) => s.id === "queries") as { data: { rows: unknown[]; intentFallback?: boolean } };
    expect(q2.data.intentFallback).toBe(true);
    expect(q2.data.rows.length).toBeGreaterThan(3);
    expect(toMarkdown(buildReportDoc(r2, v))).toContain("No local-intent searches");
  });

  it("with paid data allowed but no confirmed place ID: unavailable, named once in About, no tool hint", async () => {
    const r = await fixtureReport({ template: "local", include: [], allowPaid: true });
    expect(r.sections.find((s) => s.id === "local")).toMatchObject({ status: "unavailable" });
    const md = toMarkdown(buildReportDoc(r, v));
    expect(md).toContain("Not included this time (no data for this period): Local search (Google Business Profile).");
    expect(md).not.toMatch(/set_client_profile|gbpPlaceId/);
  });

  it("local_profile: tiles, profile and stars side by side, map positions marked in the pack, operator notes reworded", async () => {
    const r = await fixtureReport({ template: "local", include: [], allowPaid: true }, fakeDeps({ localProfile: async () => LOCAL }));
    const doc = buildReportDoc(r, { ...v, branding: { hideCrawlmark: true } });
    const local = doc.sections.find((s) => s.id === "local")!;
    expect(local.blocks.find((b) => b.kind === "kpiRow")).toMatchObject({
      items: [{ label: "Google rating", value: "4.7", detail: "from 132 reviews" }, { label: "Reviews", value: "132" }, { label: "Map pack (top 3)", value: "1 of 2" }, { label: "Photos", value: "37" }],
    });
    const md = toMarkdown(doc);
    expect(md).toContain("| emergency plumber | 2 *in the pack* | Competitor A Plumbing |");
    expect(md).toContain("| drain cleaning | not in the results | n/a |");
    expect(md).toContain("Map positions were checked across the client's market, not a single town.");
    expect(md).not.toMatch(/set_client_profile|location 2840|crawlmark|via DataForSEO,/);
    const html = toHtml(doc);
    expect(html).toContain('<div class="cols cols-2">');
    expect(html).toContain("Reviews by stars");
  });
});

describe("ai_visibility rendering", () => {
  it("tiles, questions escaped, cited pages as code, no answer text", async () => {
    const AI: AiVisibilityData = {
      mode: "mentions",
      platform: "google",
      domain: "example.com",
      mentions: { total: 42, items: [{ question: "<script>alert(1)</script> how to fix a leak", aiSearchVolume: 1300, citedUrl: "https://www.example.com/blog/leaks", position: 2 }] },
    };
    const h = mkdtempSync(join(tmpdir(), "crawlmark-local-ai-"));
    mkdirSync(join(h, "config"), { recursive: true });
    writeFileSync(join(h, "config", "report-templates.yaml"), "version: 1\ntemplates:\n  t:\n    title: T\n    sections: [{ id: ai, type: ai_visibility, paid: true }]\n");
    const r = await fixtureReport({ homeDir: h, template: "t", include: [], allowPaid: true }, fakeDeps({ aiVisibilityEnabled: () => true, aiVisibility: async () => AI }));
    const doc = buildReportDoc(r, v);
    expect(doc.sections[0]!.blocks.find((b) => b.kind === "kpiRow")).toMatchObject({ items: [{ label: "Questions citing the site", value: "42" }] });
    const md = toMarkdown(doc);
    const html = toHtml(doc);
    expect(md).toContain("`https://www.example.com/blog/leaks`");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; how to fix a leak");
    expect(html).not.toContain("<script>alert(1)");
  });
});
