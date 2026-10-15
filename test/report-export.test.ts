import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { exportReport, ReportWriteError, safeSegment, writeReportFile } from "../src/reports/export.js";
import { reportRelPath } from "../src/reports/paths.js";
import { reportCommand, type ReportCliDeps, type ReportFlags } from "../src/report-cli.js";
import { PromptAbortedError } from "../src/setup/prompter.js";
import { client, fakeDeps } from "./fixtures/reports/deps.js";
import { fixtureReport, TINY_PNG } from "./fixtures/reports/report.js";
import { POSIX_MODES } from "./platform.js";

const tmp = (p = "crawlmark-export-") => mkdtempSync(join(tmpdir(), p));
const fakePdf = vi.fn(async () => Buffer.from("%PDF-1.7 fake"));
const noChrome = async () => {
  throw new Error("Could not find Chrome (ver. 140.0.0)");
};
const base = (reportsDir: string, extra = {}) => ({ formats: ["md", "html"] as ("md" | "html" | "pdf" | "docx")[], reportsDir, branding: {}, version: "0.1.0", printer: fakePdf, ...extra });
const mode = (p: string) => statSync(p).mode & 0o777;

describe("report paths", () => {
  it("safeSegment", () => {
    expect(safeSegment("../x")).toBe("x");
    expect(safeSegment(".hidden")).toBe("hidden");
    expect(safeSegment("Exämple.COM")).toBe("ex-mple.com");
    expect(safeSegment("a/../../b")).toBe("a-.-.-b");
    expect(safeSegment("x".repeat(200))).toHaveLength(100);
    expect(() => safeSegment("..")).toThrow();
    expect(() => safeSegment("")).toThrow();
    expect(reportRelPath("example.com", "2026-09", "monthly", { startDate: "2026-09-01", endDate: "2026-09-30" }, "pdf")).toEqual({ clientDir: "example.com", monthDir: "2026-09", file: "monthly-2026-09.pdf" });
    expect(reportRelPath("example.com", "2026-09", "quarterly", { startDate: "2026-07-01", endDate: "2026-09-30" }, "html").file).toBe("quarterly-2026-q3.html");
    expect(() => reportRelPath("example.com", "../../etc", "monthly", { startDate: "2026-09-01", endDate: "2026-09-30" }, "md")).toThrow(/folder month/);
  });

  it("writes 0600 files in 0700 directories, reports overwrites, refuses symlinked client and month directories", async () => {
    const report = await fixtureReport();
    const dir = join(tmp(), "reports");
    const a = writeReportFile(dir, report, "md", "one");
    expect(a).toMatchObject({ path: join(dir, "example.com", "2026-09", "monthly-2026-09.md"), bytes: 3, overwritten: false });
    if (POSIX_MODES) expect(mode(a.path)).toBe(0o600);
    if (POSIX_MODES) for (const d of [dir, join(dir, "example.com"), join(dir, "example.com", "2026-09")]) expect(mode(d)).toBe(0o700);
    expect(writeReportFile(dir, report, "md", "two").overwritten).toBe(true);
    expect(readFileSync(a.path, "utf8")).toBe("two");

    const evil = join(tmp(), "reports");
    mkdirSync(evil);
    const elsewhere = tmp("crawlmark-elsewhere-");
    symlinkSync(elsewhere, join(evil, "example.com"));
    expect(() => writeReportFile(evil, report, "md", "x")).toThrow(ReportWriteError);
    expect(readdirSync(elsewhere)).toEqual([]);
    const evil2 = join(tmp(), "reports");
    mkdirSync(join(evil2, "example.com"), { recursive: true });
    symlinkSync(elsewhere, join(evil2, "example.com", "2026-09"));
    expect(() => writeReportFile(evil2, report, "md", "x")).toThrow(/symlink/);
    const evil3 = join(tmp(), "reports");
    mkdirSync(join(evil3, "example.com", "2026-09"), { recursive: true });
    symlinkSync(join(elsewhere, "target"), join(evil3, "example.com", "2026-09", "monthly-2026-09.md"));
    expect(() => writeReportFile(evil3, report, "md", "x")).toThrow(/regular file/);
    expect(existsSync(join(elsewhere, "target"))).toBe(false);
  });
});

describe("exportReport", () => {
  it("writes every requested format; PDF via the injected printer", async () => {
    const dir = join(tmp(), "reports");
    const out = await exportReport(await fixtureReport(), base(dir, { formats: ["md", "html", "pdf", "docx"] }));
    expect(out.files.map((f) => [f.format, f.path.split(/[\\/]/).slice(-3).join("/")])).toEqual([
      ["md", "example.com/2026-09/monthly-2026-09.md"],
      ["html", "example.com/2026-09/monthly-2026-09.html"],
      ["pdf", "example.com/2026-09/monthly-2026-09.pdf"],
      ["docx", "example.com/2026-09/monthly-2026-09.docx"],
    ]);
    expect(out).toMatchObject({ client: "example.com", template: "monthly", period: { label: "September 2026", folderMonth: "2026-09" }, dataOnly: true, sectionErrors: [], warnings: [] });
    expect(readFileSync(out.files[2]!.path, "utf8").startsWith("%PDF-")).toBe(true);
    expect(fakePdf).toHaveBeenLastCalledWith(expect.stringContaining("<!doctype html>"), expect.objectContaining({ paper: "Letter" }));
  });

  it("Chrome missing: PDF goes to warnings with the setup hint, other formats are written, and HTML stands in for the PDF", async () => {
    const dir = join(tmp(), "reports");
    const out = await exportReport(await fixtureReport(), base(dir, { formats: ["pdf", "md"], printer: noChrome }));
    expect(out.files.map((f) => f.format)).toEqual(["md", "html"]);
    expect(out.warnings[0]).toMatch(/^PDF not written: Could not find Chrome.*npx puppeteer browsers install chrome/);
    expect(out.warnings[1]).toBe("Wrote HTML instead of the PDF; open it in a browser, or print it to PDF from there.");
    // The fallback note is for the operator, not the file.
    expect(readFileSync(out.files[1]!.path, "utf8")).not.toContain("instead of the PDF");
    const only = await exportReport(await fixtureReport(), base(dir, { formats: ["pdf"], printer: noChrome }));
    expect(only.files.map((f) => f.format)).toEqual(["html"]);
    // HTML asked for as well: no second HTML file, only the PDF warning.
    const both = await exportReport(await fixtureReport(), base(dir, { formats: ["pdf", "html"], printer: noChrome }));
    expect(both.files.map((f) => f.format)).toEqual(["html"]);
    expect(both.warnings).toHaveLength(1);
  });

  it("inline docs HTML without files; narrative switches the banner; unknown narrative ids are refused", async () => {
    const dir = join(tmp(), "reports");
    const out = await exportReport(await fixtureReport(), base(dir, { formats: [], inline: "html", narrative: { summary: "Good month." } }));
    expect(out.files).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(out.dataOnly).toBe(false);
    expect(out.inline).toMatchObject({ mimeType: "text/html", title: "Example Co - SEO report - September 2026" });
    expect(out.inline!.content).toContain("Commentary written with Claude");
    expect(out.inline!.content).not.toContain("<style");
    await expect(exportReport(await fixtureReport(), base(dir, { narrative: { sections: { nope: "x" } } }))).rejects.toThrow(/nope/);
    await expect(exportReport(await fixtureReport(), base(dir, { formats: [] }))).rejects.toThrow(/Nothing to do/);
  });

  it("refuses inline content over 1,000,000 characters", async () => {
    const huge = fakeDeps({ gscQuery: async () => Array.from({ length: 100 }, (_, i) => ({ keys: [`q${i} ${"x@y".repeat(20_000)}`], clicks: 1, impressions: 1, ctr: 1, position: 1 })) });
    const report = await fixtureReport({ include: [] }, huge);
    await expect(exportReport(report, base(tmp(), { formats: [], inline: "html" }))).rejects.toThrow(/inline: "md"/);
  });

  it("passes given warnings through first (R-3)", async () => {
    const out = await exportReport(await fixtureReport(), base(tmp(), { formats: ["md"], warnings: ["Template file report-templates.yaml has errors and was ignored."] }));
    expect(out.warnings).toEqual(["Template file report-templates.yaml has errors and was ignored."]);
  });

  it("uses a valid logo and warns about a bad one", async () => {
    const h = tmp();
    writeFileSync(join(h, "logo.png"), TINY_PNG);
    writeFileSync(join(h, "logo.gif"), "GIF89a");
    const ok = await exportReport(await fixtureReport(), base(join(h, "r"), { branding: { logo: { path: "logo.png", resolved: join(h, "logo.png"), exists: true } } }));
    expect(readFileSync(ok.files[1]!.path, "utf8")).toContain("data:image/png;base64,");
    const bad = await exportReport(await fixtureReport(), base(join(h, "r"), { branding: { logo: { path: "logo.gif", resolved: join(h, "logo.gif"), exists: true } } }));
    expect(bad.warnings).toEqual(["Logo logo.gif isn't a PNG or JPEG; rendered without it."]);
  });
});

describe("crawlmark-cli report", () => {
  const today = new Date("2026-10-13T12:00:00Z");
  const flags = (f: Partial<ReportFlags>): ReportFlags => ({ all: false, paid: false, "dry-run": false, ...f });
  function harness(over: Partial<ReportCliDeps> = {}, runOver = {}) {
    const home = tmp();
    const reportsDir = join(home, "reports");
    const lines: string[] = [];
    const errs: string[] = [];
    const deps: ReportCliDeps = {
      loadClients: async ({ client: c, all }) => {
        if (all) return { clients: [client, { ...client, slug: "example.org", domain: "example.org", name: "Example Org", gscProperty: undefined, ga4PropertyId: undefined } as typeof client], skipped: [{ client: "example.net", reason: "ignore: true in clients.yaml" }], discovery: { ok: true } };
        if (c !== "example.com") throw new Error(`Unknown client "${c}".`);
        return { clients: [client], skipped: [] };
      },
      runDeps: async () => fakeDeps(runOver),
      printer: fakePdf,
      reportsDir,
      version: "0.1.0",
      ...over,
    };
    const io = { out: (l = "") => lines.push(l), warn: (l: string) => errs.push(l), homeDir: home, cwd: home, today };
    const json = () => JSON.parse(lines.join("\n"));
    return { home, reportsDir, deps, io, json, errs };
  }

  it("default formats: one PDF; the interactive picker asks once (PDF ticked) and is never asked with --format, --all, --dry-run or --yes", async () => {
    const plain = harness();
    expect(await reportCommand([], flags({ client: "example.com", month: "2026-09" }), plain.io, plain.deps)).toBe(0);
    expect(plain.json().results[0].files.map((f: { format: string }) => f.format)).toEqual(["pdf"]);

    const ask = vi.fn(async (defaults: string[]) => (expect(defaults).toEqual(["pdf"]), ["docx", "md"] as never));
    const h = harness({ chooseFormats: ask });
    expect(await reportCommand([], flags({ client: "example.com", month: "2026-09" }), h.io, h.deps)).toBe(0);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(h.json().results[0].files.map((f: { format: string }) => f.format)).toEqual(["docx", "md"]);

    const empty = harness({ chooseFormats: async () => [] });
    expect(await reportCommand([], flags({ client: "example.com", month: "2026-09" }), empty.io, empty.deps)).toBe(0);
    expect(empty.json().results[0].files.map((f: { format: string }) => f.format)).toEqual(["pdf"]);

    for (const f of [{ format: "html" }, { all: true, client: undefined }, { "dry-run": true }, { yes: true }]) {
      const never = vi.fn(async () => ["md"] as never);
      const n = harness({ chooseFormats: never });
      await reportCommand([], flags({ client: "example.com", month: "2026-09", ...f }), n.io, n.deps);
      expect(never, JSON.stringify(f)).not.toHaveBeenCalled();
    }
  });

  it("Ctrl-C in the format picker: 'Cancelled; nothing written.', exit 130, no report run", async () => {
    const run = vi.fn();
    const h = harness({ chooseFormats: async () => { throw new PromptAbortedError(); } });
    const deps = { ...h.deps, runDeps: async () => (run(), fakeDeps()) };
    expect(await reportCommand([], flags({ client: "example.com", month: "2026-09" }), h.io, deps)).toBe(130);
    expect(h.errs).toEqual(["Cancelled; nothing written."]);
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(h.reportsDir)).toBe(false);
  });

  it("--client writes four files and prints JSON with exitCode 0", async () => {
    const h = harness();
    expect(await reportCommand([], flags({ client: "example.com", format: "md,html,pdf,docx", month: "2026-09" }), h.io, h.deps)).toBe(0);
    const out = h.json();
    expect(out).toMatchObject({ command: "report", dryRun: false, skipped: [], errors: [], exitCode: 0 });
    expect(out.results[0]).toMatchObject({ client: "example.com", template: "monthly", dataOnly: true, period: { label: "September 2026" }, sections: { ok: 11, error: 0, unavailable: 0, skipped: 0 } });
    expect(out.results[0].files.map((f: { format: string }) => f.format)).toEqual(["md", "html", "pdf", "docx"]);
    expect(readdirSync(join(h.reportsDir, "example.com", "2026-09")).sort()).toEqual(["monthly-2026-09.docx", "monthly-2026-09.html", "monthly-2026-09.md", "monthly-2026-09.pdf"]);
  });

  it("--all skips ignored clients and clients with no data; --dry-run writes nothing", async () => {
    const h = harness({}, { latestAudit: () => undefined });
    expect(await reportCommand([], flags({ all: true, month: "2026-09" }), h.io, h.deps)).toBe(0);
    const out = h.json();
    expect(out.results.map((r: { client: string }) => r.client)).toEqual(["example.com"]);
    expect(out.skipped).toEqual([
      { client: "example.net", reason: "ignore: true in clients.yaml" },
      { client: "example.org", reason: expect.stringMatching(/^no data, so no file: no Search Console property for example.org; no GA4 property for example.org/) },
    ]);
    const d = harness();
    const runDeps = vi.fn();
    expect(await reportCommand([], flags({ all: true, "dry-run": true, format: "pdf,docx" }), d.io, { ...d.deps, runDeps })).toBe(0);
    expect(runDeps).not.toHaveBeenCalled();
    expect(readdirSync(d.home)).toEqual([]);
    const dry = d.json();
    expect(dry.results[0]).toMatchObject({ client: "example.com", period: { label: "September 2026" }, wouldWrite: [join(d.reportsDir, "example.com/2026-09/monthly-2026-09.pdf"), join(d.reportsDir, "example.com/2026-09/monthly-2026-09.docx")] });
  });

  it("discovery failing with no clients is an error, except on a dry run (R-5)", async () => {
    const noClients = { loadClients: async () => ({ clients: [], skipped: [], discovery: { ok: false }, discoveryError: "Search Console: 401" }) };
    const run = harness(noClients);
    expect(await reportCommand([], flags({ all: true }), run.io, run.deps)).toBe(1);
    const dry = harness(noClients);
    expect(await reportCommand([], flags({ all: true, "dry-run": true }), dry.io, dry.deps)).toBe(0);
    expect(dry.json().errors[0]).toMatch(/Discovery failed/);
  });

  it("exit 2: a section error, or a requested format that failed (unavailable doesn't count)", async () => {
    const a = harness({}, { gscTotals: async () => { throw new Error("quota"); } });
    expect(await reportCommand([], flags({ client: "example.com", month: "2026-09" }), a.io, a.deps)).toBe(2);
    expect(a.json().results[0].sectionErrors).toEqual([{ id: "search", error: "quota" }]);
    const b = harness({ printer: noChrome });
    expect(await reportCommand([], flags({ client: "example.com", month: "2026-09", format: "md,pdf" }), b.io, b.deps)).toBe(2);
    expect(b.json().results[0].warnings[0]).toMatch(/PDF not written/);
    const c = harness({}, { ga4OrganicSummary: async () => { throw new Error("x"); }, googleConfigured: () => true });
    const noGa4 = { ...c.deps, loadClients: async () => ({ clients: [{ ...client, ga4PropertyId: undefined } as typeof client], skipped: [] }) };
    expect(await reportCommand([], flags({ client: "example.com", month: "2026-09" }), c.io, noGa4)).toBe(0);
  });

  it("a client whose every data section errored counts as failed (R-1): --client exits 1; --all exits 1 when nothing was written, 2 when others were", async () => {
    const boom = async () => {
      throw new Error("invalid_grant: token expired");
    };
    const dead = { gscTotals: boom, gscQuery: boom, ga4OrganicSummary: boom, ga4TopLandingPages: boom, opportunitiesForMonth: boom, latestAudit: () => undefined };
    const one = harness({}, dead);
    expect(await reportCommand([], flags({ client: "example.com", month: "2026-09" }), one.io, one.deps)).toBe(1);
    expect(one.json().skipped[0]).toMatchObject({ client: "example.com", reason: expect.stringContaining("invalid_grant") });
    expect(existsSync(one.reportsDir)).toBe(false);

    // example.com fails, example.org has no Google (unavailable): nothing written.
    const all = harness({}, dead);
    expect(await reportCommand([], flags({ all: true, month: "2026-09" }), all.io, all.deps)).toBe(1);
    expect(all.json().errors.join(" ")).toMatch(/No report was written/);

    // One client written, another failed: attention.
    const mixed = harness({
      loadClients: async () => ({ clients: [client, { ...client, slug: "example.org", domain: "example.org" } as typeof client], skipped: [] }),
      runDeps: async () => {
        const ok = fakeDeps();
        const failing = (c: { slug: string }) => c.slug === "example.org";
        return fakeDeps({
          gscTotals: async (c, r) => (failing(c) ? boom() : ok.gscTotals(c, r)),
          gscQuery: async (c, o) => (failing(c) ? boom() : ok.gscQuery(c, o)),
          ga4OrganicSummary: async (c, r) => (failing(c) ? boom() : ok.ga4OrganicSummary(c, r)),
          ga4TopLandingPages: async (c, r, n) => (failing(c) ? boom() : ok.ga4TopLandingPages(c, r, n)),
          opportunitiesForMonth: async (c, r, n) => (failing(c) ? boom() : ok.opportunitiesForMonth(c, r, n)),
          latestAudit: (s) => (s === "example.org" ? undefined : ok.latestAudit(s)),
        });
      },
    });
    expect(await reportCommand([], flags({ all: true, month: "2026-09" }), mixed.io, mixed.deps)).toBe(2);
    expect(mixed.json().results.map((r: { client: string }) => r.client)).toEqual(["example.com"]);
  });

  it("exit 1: usage errors, unknown client, invalid template, every client failing, unwritable files", async () => {
    const h = harness();
    expect(await reportCommand([], flags({}), h.io, h.deps)).toBe(1);
    expect(await reportCommand([], flags({ client: "example.com", all: true }), h.io, h.deps)).toBe(1);
    expect(await reportCommand([], flags({ client: "example.com", format: "pdf,txt" }), h.io, h.deps)).toBe(1);
    expect(await reportCommand([], flags({ client: "example.com", start: "2026-09-01" }), h.io, h.deps)).toBe(1);
    expect(await reportCommand([], flags({ client: "example.com", month: "2026-09", quarter: "2026-Q3" }), h.io, h.deps)).toBe(1);
    expect(await reportCommand(["extra"], flags({ client: "example.com" }), h.io, h.deps)).toBe(1);
    expect(await reportCommand([], flags({ client: "nope.example" }), h.io, h.deps)).toBe(1);
    expect(await reportCommand([], flags({ client: "example.com", template: "missing" }), h.io, h.deps)).toBe(1);
    expect(await reportCommand([], flags({ client: "example.com", include: "search" }), h.io, h.deps)).toBe(1);
    mkdirSync(join(h.home, "config"));
    writeFileSync(join(h.home, "config", "report-templates.yaml"), "version: 1\ntemplates: { t: { title: T, sections: [{ id: a, type: nope }] } }\n");
    expect(await reportCommand([], flags({ client: "example.com" }), h.io, h.deps)).toBe(1);
    expect(h.errs.join("\n")).toContain("templates.t.sections[0].type");

    const f = harness({}, { googleConfigured: () => true });
    const failing = { ...f.deps, runDeps: async () => { throw new Error("boom"); } };
    expect(await reportCommand([], flags({ client: "example.com", month: "2026-09" }), f.io, failing)).toBe(1);

    const w = harness();
    writeFileSync(w.reportsDir, "a file where the folder should be");
    expect(await reportCommand([], flags({ client: "example.com", month: "2026-09" }), w.io, w.deps)).toBe(1);
    expect(w.json().errors[0]).toMatch(/Couldn't write/);
  });
});
