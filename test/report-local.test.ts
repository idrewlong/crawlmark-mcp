/**
 * Phase 12 C4: the local_profile template section (paid): schema rules, the paid gate, the pre-flight
 * estimate reserved for the whole run, the real section builder over a stubbed DataForSEO, and rendering
 * in every format with Stage A's escaping.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";
import { localProfileSection, localSectionEstimateUsd } from "../src/local-seo.js";
import { exportReport } from "../src/reports/export.js";
import type { LocalProfileData } from "../src/reports/report-types.js";
import { validateTemplateText } from "../src/reports/templates/schema.js";
import { client, fakeDeps } from "./fixtures/reports/deps.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const today = new Date("2026-10-13T12:00:00Z");
const TEMPLATE = `version: 1
templates:
  local:
    title: Local
    period: { range: last_month }
    sections:
      - { id: search, type: search_overview }
      - { id: local, type: local_profile, paid: true, packKeywords: 2 }
`;
function homeWith(yaml: string): string {
  const home = mkdtempSync(join(tmpdir(), "crawlmark-c4-"));
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "report-templates.yaml"), yaml);
  return home;
}
const fx = (name: string) => readFileSync(new URL(`./fixtures/dataforseo/${name}`, import.meta.url), "utf8");
function stubDfs(mapsFail = false): string[] {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(String(input));
      if (url.hostname !== "127.0.0.1") throw new Error(`real host: ${url.hostname}`);
      paths.push(url.pathname);
      if (url.pathname.endsWith("/my_business_info/live")) return new Response(fx("business_data_google_my_business_info_live.json"));
      if (url.pathname.endsWith("/maps/live/advanced")) return mapsFail ? new Response("down", { status: 503 }) : new Response(fx("serp_google_maps_live_advanced.json"));
      return new Response("{}", { status: 404 });
    }),
  );
  return paths;
}
afterEach(() => vi.unstubAllGlobals());

const DATA: LocalProfileData = {
  business: { title: "Example Plumbing Co", category: "Plumber", address: "100 Example St", url: "https://www.example.com/", rating: 4.7, votes: 132, ratingDistribution: { "1": 4, "2": 1, "3": 3, "4": 14, "5": 110 }, isClaimed: true, totalPhotos: 37, currentStatus: "opened" },
  location: "Smallville,Kansas,United States",
  pack: [
    { keyword: "emergency plumber", clientRank: 4, leader: { title: "Competitor A Plumbing", rating: 4.9, votes: 410 } },
    { keyword: "drain cleaning", clientRank: null, leader: null },
  ],
  notes: [],
};

describe("local_profile section", () => {
  it("validates only with paid: true; packKeywords is 0 to 5", () => {
    expect(validateTemplateText(TEMPLATE, { today })).toMatchObject({ valid: true });
    expect(validateTemplateText(TEMPLATE.replace("paid: true, ", ""), { today }).errors).toEqual([{ path: "templates.local.sections[1].paid", message: "local_profile is paid, so the section must set paid: true" }]);
    expect(validateTemplateText(TEMPLATE.replace("packKeywords: 2", "packKeywords: 6"), { today }).valid).toBe(false);
  });

  it("is skipped without allowPaid, with no estimate and no request", async () => {
    const est = vi.fn(() => 0.0094);
    const local = vi.fn(async () => DATA);
    const r = await fixtureReport({ homeDir: homeWith(TEMPLATE), template: "local", include: [] }, fakeDeps({ localProfile: local, localProfileEstimateUsd: est }));
    expect(r.sections.find((s) => s.id === "local")).toMatchObject({ status: "skipped" });
    expect(est).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
  });

  it("with allowPaid: the whole estimate is reserved once before the section runs", async () => {
    const reserved: number[] = [];
    const deps = fakeDeps({
      localProfile: async (_c, o) => ({ ...DATA, pack: DATA.pack.slice(0, o.packKeywords) }),
      localProfileEstimateUsd: (_c, o) => 0.0054 + o.packKeywords * 0.002,
      withUsdReservation: async (_c, usd, fn) => (reserved.push(usd), fn()),
    });
    const r = await fixtureReport({ homeDir: homeWith(TEMPLATE), template: "local", include: [], allowPaid: true }, deps);
    expect(reserved).toEqual([0.0094]);
    expect(r.sections.find((s) => s.id === "local")).toMatchObject({ status: "ok", title: "Local search (Google Business Profile)" });
  });

  it("without a confirmed place ID it is unavailable, never a guessed business", async () => {
    const r = await fixtureReport({ homeDir: homeWith(TEMPLATE), template: "local", include: [], allowPaid: true });
    expect(r.sections.find((s) => s.id === "local")).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/no confirmed Google Business Profile for example\.com/) });
  });

  it("the real builder reads the saved place ID and the first tracked keywords", async () => {
    const paths = stubDfs();
    const c = { ...client, area: "Smallville,Kansas,United States", gbpPlaceId: "ChIJexamplePlaceId000001", trackedKeywords: ["emergency plumber", "drain cleaning", "leak detection"], monthlyBudgetUsd: 5 } as Client;
    expect(localSectionEstimateUsd(c, { packKeywords: 2 })).toBe(0.0094);
    expect(localSectionEstimateUsd({ ...c, gbpPlaceId: undefined } as Client, { packKeywords: 2 })).toBe(0);
    const data = await localProfileSection(c, { packKeywords: 2 });
    expect(paths).toEqual(["/v3/business_data/google/my_business_info/live", "/v3/serp/google/maps/live/advanced", "/v3/serp/google/maps/live/advanced"]);
    expect(data.business).toMatchObject({ title: "Example Plumbing Co", rating: 4.7, votes: 132 });
    expect(data.pack).toEqual([
      { keyword: "emergency plumber", clientRank: 4, leader: { title: "Competitor A Plumbing", rating: 4.9, votes: 410 } },
      { keyword: "drain cleaning", clientRank: 4, leader: { title: "Competitor A Plumbing", rating: 4.9, votes: 410 } },
    ]);
    expect(JSON.stringify(data)).not.toMatch(/555-0100|Jane/);
  });

  it("when every map check fails, the paid profile is kept with a note (R-3)", async () => {
    stubDfs(true);
    const c = { ...client, area: "Othertown,Kansas,United States", gbpPlaceId: "ChIJexamplePlaceId000001", trackedKeywords: ["emergency plumber", "drain cleaning"], monthlyBudgetUsd: 5 } as Client;
    const data = await localProfileSection(c, { packKeywords: 2 });
    expect(data.business.title).toBe("Example Plumbing Co");
    expect(data.pack).toEqual([]);
    expect(data.notes).toEqual(["Google Maps positions couldn't be checked for this report."]);
  });

  it("renders in every format; listing text is escaped and the website is code, not a link", async () => {
    const evil: LocalProfileData = { ...DATA, business: { ...DATA.business, title: "<script>alert(1)</script> | [x](https://evil.example)" } };
    const report = await fixtureReport({ homeDir: homeWith(TEMPLATE), template: "local", include: [], allowPaid: true }, fakeDeps({ localProfile: async () => evil }));
    const printer = vi.fn(async () => Buffer.from("%PDF-1.7"));
    const dir = join(mkdtempSync(join(tmpdir(), "crawlmark-c4-out-")), "reports");
    const out = await exportReport(report, { formats: ["md", "html", "docx", "pdf"], reportsDir: dir, branding: {}, version: "0.1.0", printer });
    const md = readFileSync(out.files[0]!.path, "utf8");
    const html = readFileSync(out.files[1]!.path, "utf8");
    const docXml = await (await JSZip.loadAsync(readFileSync(out.files[2]!.path))).file("word/document.xml")!.async("string");
    const pdfHtml = String((printer.mock.calls[0] as unknown as [string])[0]);
    for (const text of [md, html, docXml, pdfHtml]) {
      expect(text).toContain("4.7 from 132 reviews");
      expect(text).toContain("emergency plumber");
      expect(text).toContain("not in the results");
    }
    expect(md).toContain("Local search: Google Business Profile and Google Maps results via DataForSEO (paid).");
    expect(md).toContain("`https://www.example.com/`");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain('href="https://evil.example');
    expect(html).not.toContain('href="https://www.example.com/');
  });
});
