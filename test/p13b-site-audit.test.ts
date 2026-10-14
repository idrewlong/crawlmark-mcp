/**
 * Phase 13 B-5: Ahrefs and Semrush Site Audit as technical_issues sources. Read-only path allowlists (any other method
 * or path is refused before a request), existing projects only (matching 0/1/many, a saved ID wins), units planned and
 * recorded, Ahrefs names and Semrush IDs mapped onto the catalogue, issueUrls adding exactly n calls, nothing requested
 * without allowPaid, and no Ahrefs example URLs in the stored snapshot. fetch stubbed on the closed local port.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";

const AH = "ahrefs-AUDIT-sentinel-5b0d";
const SR = "semrush-AUDIT-sentinel-0c4a";
process.env.AHREFS_API_KEY = AH;
process.env.SEMRUSH_API_KEY = SR;

const aSA = await import("../src/providers/ahrefs-site-audit.js");
const sSA = await import("../src/providers/semrush-site-audit.js");
const ti = await import("../src/reports/technical-issues.js");
const { ahrefsTiming } = await import("../src/providers/ahrefs.js");
const { semrushTiming } = await import("../src/providers/semrush.js");
const { db } = await import("../src/lib/store.js");
const { canonicalOf } = await import("../src/analysis/tech-issues.js");
ahrefsTiming.spacing = async () => undefined;
semrushTiming.spacing = async () => undefined;

const ax = (n: string) => readFileSync(new URL(`./fixtures/ahrefs/p13/${n}`, import.meta.url), "utf8");
const sx = (n: string) => readFileSync(new URL(`./fixtures/semrush/p13/${n}`, import.meta.url), "utf8");

interface Call {
  method: string;
  path: string;
  params: Record<string, string>;
}
function fake(o: { projects?: unknown; infoUrl?: string } = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.hostname !== "127.0.0.1") throw new Error(`test tried to reach a real host: ${url.hostname}`);
      calls.push({ method: init?.method ?? "GET", path: url.pathname, params: Object.fromEntries(url.searchParams) });
      const json = (body: string, units?: number) => new Response(body, { status: 200, headers: { "content-type": "application/json", ...(units !== undefined ? { "x-api-units-cost-total": String(units) } : {}) } });
      switch (url.pathname) {
        case "/v3/site-audit/projects":
          return json(o.projects ? JSON.stringify(o.projects) : ax("site-audit-projects.json"), 0);
        case "/v3/site-audit/issues":
          return json(ax("site-audit-issues.json"), 50);
        case "/v3/site-audit/page-explorer":
          return json(ax("site-audit-page-explorer.json"), 50);
        case "/management/v1/projects":
          return json(o.projects ? JSON.stringify(o.projects) : sx("projects.json"));
      }
      if (/\/siteaudit\/info$/.test(url.pathname)) return json(o.infoUrl ? JSON.stringify({ ...JSON.parse(sx("siteaudit-info.json")), url: o.infoUrl }) : sx("siteaudit-info.json"));
      if (/\/siteaudit\/meta\/issues$/.test(url.pathname)) return json(sx("siteaudit-meta-issues.json"));
      if (/\/siteaudit\/snapshot\/.+\/issue\/\d+$/.test(url.pathname)) return json(sx("siteaudit-issue.json"));
      return new Response("{}", { status: 404 });
    }),
  );
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

let n = 0;
function client(extra: Partial<Client> = {}): Client {
  n++;
  return { slug: `audit${n}.example.com`, domain: "example.com", name: "Example Co", aliases: [], competitors: [], keyPages: [], locationCode: 2840, languageCode: "en", monthlyBudgetUsd: 5, country: "US", monthlyUnits: { ahrefs: 10_000, semrush: 10_000 }, ...extra } as unknown as Client;
}
const ledger = (c: Client) => db.prepare("SELECT provider, endpoint, units FROM spend WHERE client = ? ORDER BY id").all(c.slug) as { provider: string; endpoint: string; units: number }[];

describe("allowlists (D12)", () => {
  it("Ahrefs: only GET projects, issues and page-explorer; anything else is refused before a request", async () => {
    const calls = fake();
    expect(aSA.ALLOWED.map((a) => `${a.method} ${a.path}`)).toEqual(["GET /site-audit/projects", "GET /site-audit/issues", "GET /site-audit/page-explorer"]);
    for (const [m, p] of [["POST", "/site-audit/issues"], ["GET", "/site-audit/page-content"], ["POST", "/management/projects"], ["DELETE", "/management/projects"], ["PATCH", "/management/update-project"], ["GET", "/site-audit/issues?project_id=1"], ["GET", "/site-explorer/metrics"]]) {
      expect(() => aSA.ahrefsAuditRequest(m!, p!), `${m} ${p}`).toThrow(aSA.SiteAuditRefused);
    }
    expect(calls).toHaveLength(0);
  });

  it("Semrush: only the four GETs; the 10,000-unit snapshot report, launch, enable, save and any non-GET are refused", async () => {
    const calls = fake();
    const ok = ["/management/v1/projects", "/reports/v1/projects/7701/siteaudit/info", "/reports/v1/projects/7701/siteaudit/meta/issues", "/reports/v1/projects/7701/siteaudit/snapshot/5f1e00aa/issue/8"];
    for (const p of ok) expect(() => sSA.assertSemrushAllowed("GET", p)).not.toThrow();
    const refused: [string, string, Record<string, string>?][] = [
      ["GET", "/reports/v1/projects/7701/siteaudit/snapshot", { snapshot_id: "5f1e00aa" }],
      ["GET", "/reports/v1/projects/7701/siteaudit/snapshot"],
      ["GET", "/reports/v1/projects/7701/siteaudit/snapshots"],
      ["POST", "/reports/v1/projects/7701/siteaudit/launch"],
      ["GET", "/reports/v1/projects/7701/siteaudit/launch"],
      ["POST", "/management/v1/projects/7701/siteaudit/enable"],
      ["POST", "/management/v1/projects/7701/siteaudit/save"],
      ["POST", "/management/v1/projects"],
      ["GET", "/reports/v1/projects/7701/siteaudit/info?snapshot_id=1"],
      ["GET", "/reports/v1/projects/abc/siteaudit/info"],
      ["GET", "/reports/v1/projects/7701/siteaudit/info", { snapshot_id: "x" }],
    ];
    for (const [m, p, q] of refused) expect(() => sSA.semrushAuditRequest(m, p, q ?? {}), `${m} ${p}`).toThrow(sSA.SemrushAuditRefused);
    expect(calls).toHaveLength(0);
  });
});

describe("Ahrefs Site Audit", () => {
  it("technical_issues with ahrefs_site_audit + allowPaid calls only GET projects and GET issues, records 50 units, maps names, stores no Ahrefs URLs", async () => {
    const calls = fake();
    const c = client();
    const deps = await ti.loadTechIssuesDeps();
    const saved: unknown[] = [];
    const r = await ti.technicalIssues(c, { sources: ["ahrefs_site_audit"], allowPaid: true, issueUrls: 1, baseBeforeMs: Date.now() }, { ...deps, saveIssueSnapshot: (s) => void saved.push(s) });
    expect(calls.map((x) => `${x.method} ${x.path}`)).toEqual(["GET /v3/site-audit/projects", "GET /v3/site-audit/issues", "GET /v3/site-audit/page-explorer"]);
    expect(calls[0]!.params).toEqual({ project_url: "example.com" });
    expect(calls[1]!.params).toEqual({ project_id: "4412001" });
    expect(calls[2]!.params).toMatchObject({ project_id: "4412001", select: "url", limit: "3" });
    expect(ledger(c).filter((l) => l.units > 0)).toEqual([{ provider: "ahrefs", endpoint: "/site-audit/issues", units: 50 }, { provider: "ahrefs", endpoint: "/site-audit/page-explorer", units: 50 }]);
    expect(r.sources).toEqual([expect.objectContaining({ source: "ahrefs_site_audit", runId: "ahrefs:4412001@2026-10-08T03:12:00.000Z" })]);
    const keys = r.issues.map((i) => [i.key, i.severity, i.affected]);
    expect(keys).toEqual(expect.arrayContaining([["client-error-page", "high", 5], ["missing-title", "high", 3]]));
    const og = r.issues.find((i) => i.key.startsWith("ahrefs_site_audit:"))!;
    expect(og.title).toBe("Open Graph tags incomplete <script>x</script>");
    expect(og.severity).toBe("low");
    expect(r.issues.some((i) => i.title.startsWith("Slow page"))).toBe(false);
    // The top issue got its example URLs in this result, but the stored snapshot keeps Ahrefs counts only.
    expect(r.issues.flatMap((i) => i.sources.flatMap((s) => s.examples))).toContain("https://example.com/thanks");
    expect(JSON.stringify(saved)).not.toContain("example.com/thanks");
    expect(JSON.stringify(r)).not.toContain(AH);
    expect(aSA.planAhrefsSiteAudit(1)).toMatchObject({ units: 100, requests: 3 });
    expect(aSA.planAhrefsSiteAudit(0)).toMatchObject({ units: 50, requests: 2 });
  });

  it("project matching: none and several are unavailable naming ahrefsSiteAuditProject; a saved ID wins", async () => {
    db.exec("DELETE FROM cache");
    fake({ projects: { healthscores: [] } });
    await expect(aSA.matchAhrefsProject(client())).rejects.toThrow(/ahrefsSiteAuditProject/);
    vi.unstubAllGlobals();
    db.exec("DELETE FROM cache");
    fake({ projects: { healthscores: [{ project_id: "1", target_url: "https://example.com/" }, { project_id: "2", target_url: "https://www.example.com/" }] } });
    await expect(aSA.matchAhrefsProject(client())).rejects.toThrow(/2 Ahrefs Site Audit projects match example\.com/);
    vi.unstubAllGlobals();
    const calls = fake();
    expect((await aSA.matchAhrefsProject(client({ ahrefsSiteAuditProject: "4412001" } as Partial<Client>))).id).toBe("4412001");
    expect(calls[0]!.params).toEqual({ project_id: "4412001" });
  });

  it("without allowPaid nothing is requested and the source is unavailable", async () => {
    const calls = fake();
    const r = await ti.technicalIssues(client(), { sources: ["ahrefs_site_audit", "semrush_site_audit"], baseBeforeMs: Date.now(), save: false }, await ti.loadTechIssuesDeps());
    expect(calls).toHaveLength(0);
    expect(r.unavailable.map((u) => u.reason)).toEqual(["paid source: needs allowPaid (it spends provider units)", "paid source: needs allowPaid (it spends provider units)"]);
  });
});

describe("Semrush Site Audit", () => {
  it("list (matched by host and Site Audit tool) + info + meta titles; IDs mapped; issueUrls adds exactly n issue calls; 100 units each", async () => {
    const calls = fake();
    const c = client();
    const r = await sSA.readSemrushSiteAudit(c, { issueUrls: 2 });
    expect(calls.map((x) => x.path)).toEqual([
      "/management/v1/projects",
      "/reports/v1/projects/7701/siteaudit/info",
      "/reports/v1/projects/7701/siteaudit/meta/issues",
      "/reports/v1/projects/7701/siteaudit/snapshot/5f1e00aa/issue/8",
      "/reports/v1/projects/7701/siteaudit/snapshot/5f1e00aa/issue/103",
    ]);
    for (const x of calls) {
      expect(x.method).toBe("GET");
      expect(x.params.key).toBe(SR);
      expect(x.params.snapshot_id).toBeUndefined();
    }
    expect(r.issues.map((i) => [i.rule, i.severity, i.title, i.count])).toEqual([
      ["8", "high", "internal links are broken", 4],
      ["103", "medium", "pages don't have an h1 heading", 7],
      ["215", "low", "pages have only one incoming internal link", 20],
    ]);
    expect(r.issues[0]!.examples).toEqual(["https://example.com/old-link", "https://example.com/also-broken"]);
    expect(canonicalOf(r.issues[0]!).key).toBe("broken-internal-link");
    expect(canonicalOf(r.issues[1]!).key).toBe("missing-h1");
    expect(canonicalOf(r.issues[2]!).key).toBe("semrush_site_audit:215");
    expect(ledger(c).map((l) => [l.endpoint, l.units])).toEqual([["projects list", 100], ["siteaudit/info", 100], ["siteaudit/meta/issues", 100], ["siteaudit/issue", 100], ["siteaudit/issue", 100]]);
    expect(JSON.stringify([r, ledger(c), db.prepare("SELECT value FROM cache").all()])).not.toContain(SR);
    expect(sSA.planSemrushSiteAudit({ savedProject: false, listCached: false, metaCached: false, issueUrls: 2 })).toMatchObject({ units: 500, requests: 5 });
    expect(sSA.planSemrushSiteAudit({ savedProject: true, listCached: false, metaCached: true, issueUrls: 0 })).toMatchObject({ units: 100, requests: 1 });
  });

  it("a saved semrushProject skips the list; no matching project is unavailable naming semrushProject", async () => {
    const calls = fake();
    await sSA.readSemrushSiteAudit(client({ semrushProject: "7701" } as Partial<Client>), {});
    expect(calls[0]!.path).toBe("/reports/v1/projects/7701/siteaudit/info");
    vi.unstubAllGlobals();
    db.exec("DELETE FROM cache");
    fake({ projects: [{ project_id: 1, url: "example.com", tools: [{ tool: "tracking" }] }] });
    await expect(sSA.matchSemrushProject(client())).rejects.toThrow(/semrushProject/);
  });
});

describe("clients.yaml project fields", () => {
  it("set_client_profile / clients set save digits only, and \"\" clears", async () => {
    const { writeFileSync } = await import("node:fs");
    const { env } = await import("../src/config.js");
    const { setClientProfile, resolveClient } = await import("../src/clients.js");
    writeFileSync(env.CLIENTS_FILE, "clients:\n  example.com:\n    domain: example.com\n    name: Example Co # keep this comment\n");
    await expect(setClientProfile("example.com", { ahrefsSiteAuditProject: "12ab" })).rejects.toThrow(/an Ahrefs Site Audit project ID/);
    const r = await setClientProfile("example.com", { ahrefsSiteAuditProject: "4412001", semrushProject: "7701" });
    expect(r.profile).toMatchObject({ ahrefsSiteAuditProject: "4412001", semrushProject: "7701" });
    const c = await resolveClient("example.com");
    expect([c.ahrefsSiteAuditProject, c.semrushProject]).toEqual(["4412001", "7701"]);
    expect(readFileSync(env.CLIENTS_FILE, "utf8")).toContain("# keep this comment");
    await setClientProfile("example.com", { semrushProject: "" });
    expect((await resolveClient("example.com")).semrushProject).toBeUndefined();
  });
});

describe("SEC-1: a Site Audit project for another site never reaches this client's report", () => {
  it("Ahrefs: a pinned project on another host is refused naming the mismatch; a subdomain project matches; another host never matches", async () => {
    db.exec("DELETE FROM cache");
    fake({ projects: { healthscores: [{ project_id: "9", target_url: "https://other.example.org/", date: "2026-10-01T00:00:00Z" }] } });
    await expect(aSA.matchAhrefsProject(client({ ahrefsSiteAuditProject: "9" } as Partial<Client>))).rejects.toThrow(/project 9 is for other\.example\.org, not example\.com/);
    vi.unstubAllGlobals();
    db.exec("DELETE FROM cache");
    fake({ projects: { healthscores: [{ project_id: "5", target_url: "https://blog.example.com/" }, { project_id: "6", target_url: "https://notexample.com/" }] } });
    expect((await aSA.matchAhrefsProject(client())).id).toBe("5");
    expect(aSA.onClientDomain("notexample.com", "example.com")).toBe(false);
  });

  it("Semrush: an audit whose site isn't the client's is refused (pinned or matched), and nothing from it is returned", async () => {
    const calls = fake({ infoUrl: "other.example.org" });
    await expect(sSA.readSemrushSiteAudit(client({ semrushProject: "7701" } as Partial<Client>), {})).rejects.toThrow(/project 7701 is for other\.example\.org, not example\.com/);
    // Refused right after /info: no titles or issue URLs requested.
    expect(calls.map((x) => x.path)).toEqual(["/reports/v1/projects/7701/siteaudit/info"]);
  });

  it("set_client_profile (MCP) can't set the project IDs: only the CLI or the file can", async () => {
    const { registerCompetitorTools } = await import("../src/tools/competitors.js");
    let schema: Record<string, unknown> = {};
    registerCompetitorTools({ registerTool: (name: string, d: { inputSchema: Record<string, unknown> }) => void (name === "set_client_profile" && (schema = d.inputSchema)) } as never);
    expect(Object.keys(schema)).toContain("gbpPlaceId");
    expect(Object.keys(schema)).not.toContain("ahrefsSiteAuditProject");
    expect(Object.keys(schema)).not.toContain("semrushProject");
  });
});

describe("SEC-3: a Semrush Site Audit call that times out", () => {
  it("records its estimated 100 units as (timeout, estimated) and rethrows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (new URL(input).hostname !== "127.0.0.1") throw new Error("real host");
        throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
      }),
    );
    const c = client();
    await expect(sSA.semrushAuditRequest("GET", "/reports/v1/projects/7701/siteaudit/info")(c)).rejects.toThrow(/timed out.*100 units were recorded/);
    expect(ledger(c)).toEqual([{ provider: "semrush", endpoint: "siteaudit/info (timeout, estimated)", units: 100 }]);
  });
});

describe("SEC-6: the shared request helpers check the allowlists themselves", () => {
  it("ahrefsGet and semrushProjectsGet refuse any path outside the Site Audit allowlist before a request", async () => {
    const calls = fake();
    const { ahrefsGet } = await import("../src/providers/ahrefs.js");
    const { semrushProjectsGet } = await import("../src/providers/semrush.js");
    await expect(ahrefsGet(client(), { path: "/management/projects", params: {} }, 0)).rejects.toThrow(aSA.SiteAuditRefused);
    await expect(ahrefsGet(client(), { path: "/site-explorer/metrics", params: {} }, 0)).rejects.toThrow(aSA.SiteAuditRefused);
    await expect(semrushProjectsGet("/reports/v1/projects/7701/siteaudit/launch", "x", {})).rejects.toThrow(sSA.SemrushAuditRefused);
    await expect(semrushProjectsGet("/reports/v1/projects/7701/siteaudit/info", "x", { snapshot_id: "1" })).rejects.toThrow(sSA.SemrushAuditRefused);
    expect(calls).toHaveLength(0);
  });
});
