/**
 * Search Console Pages report import (2026-10-14): the bounded zip reader, the CSV / .xlsx parsing of exports
 * shaped like Search Console's (docs/research/2026-10-14-gsc-pages-export.md), property checks, storage, the
 * merge with URL Inspection in index_coverage and the indexing_issues section, the import_index_report tool's
 * folder rules and the CLI. Hand-built fixtures with example.com URLs; no network, no Google calls.
 */
import { mkdirSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";
import { buildZip } from "./fixtures/zip.js";

vi.mock("../src/clients.js", () => ({
  resolveClient: vi.fn(async (c: string) => ({ slug: c, domain: "example.com", name: "Example", gscProperty: "sc-domain:example.com", keyPages: [], aliases: [] })),
}));

const { readZip, looksLikeZip } = await import("../src/lib/zip-read.js");
const { parseCsv, parseXlsx, interpretExport, cleanLabel, parseDay, parseCount, hostFromFileName, dayFromFileName, TABLES_MAX, ROW_ELEMENTS_MAX, WORKBOOK_XML_MAX, REASONS_MAX } = await import("../src/analysis/gsc-pages-export.js");
const { importPagesExport, readExportTables, pagesReportFor, hostMatches, IMPORT_MAX_BYTES } = await import("../src/reports/pages-import.js");
const { saveInspection } = await import("../src/lib/inspections.js");
const { indexCoverage } = await import("../src/reports/indexing.js");
const { indexImportCommand } = await import("../src/index-coverage-cli.js");
const { SECTION_MAPPERS } = await import("../src/reports/render/sections.js");
const { buildReportDoc } = await import("../src/reports/render/doc.js");
const { toMarkdown } = await import("../src/reports/render/markdown.js");
const { p13Report, INDEXING } = await import("./fixtures/reports/p13-data.js");

const E = "https://example.com";
const NOW = Date.parse("2026-10-20T12:00:00Z");
const dir = mkdtempSync(join(tmpdir(), "crawlmark-import-"));
const client = (slug: string, property = "sc-domain:example.com"): Client => ({ slug, domain: "example.com", name: "Example Co", gscProperty: property, keyPages: [], aliases: [] }) as unknown as Client;
const file = (name: string, data: Buffer | string) => {
  const path = join(dir, name);
  writeFileSync(path, data);
  return { name, path };
};

// Shaped like Search Console's Pages export (summary page): Chart, Critical issues, Non-critical issues, Metadata.
const CHART = "Date,Not indexed,Indexed,Impressions\n2026-10-12,130,410,900\n2026-10-13,128,412,950\n";
const CRITICAL =
  "\ufeffReason,Source,Validation,Pages\r\n" +
  "Crawled - currently not indexed,Google systems,Not Started,61\r\n" +
  "Page with redirect,Website,Not Started,40\r\n" +
  "\"Duplicate, Google chose different canonical than user\",Google systems,N/A,12\r\n" +
  "Not found (404),Website,Failed,\"1,005\"\r\n" +
  "Server error (5xx),Website,Not Started,~\r\n";
// The same reason twice (spacing differs): kept once.
const NON_CRITICAL = 'Reason,Source,Validation,Pages\n"Indexed, though blocked by robots.txt",Website,N/A,3\n"Indexed,  though  blocked by robots.txt",Website,N/A,3\n';
const METADATA = "Property,Value\nReport,Page indexing\n";
const summaryZip = () =>
  buildZip([
    { name: "Chart.csv", data: CHART },
    { name: "Critical issues.csv", data: CRITICAL },
    { name: "Non-critical issues.csv", data: NON_CRITICAL, store: true },
    { name: "Metadata.csv", data: METADATA },
  ]);
// A reason's drilldown: Table (URL, Last crawled), Chart and Metadata naming the reason.
const drillZip = (rows: string[], meta = "Property,Value\nIssue,Crawled - currently not indexed\n") =>
  buildZip([
    { name: "Table.csv", data: `URL,Last crawled\n${rows.join("\n")}\n` },
    { name: "Chart.csv", data: "Date,Affected pages\n2026-10-13,61\n" },
    { name: "Metadata.csv", data: meta },
  ]);

describe("zip reader (bounded)", () => {
  it("reads stored and deflated entries, skips unwanted ones", () => {
    const z = buildZip([{ name: "a.csv", data: "x,y\n1,2\n" }, { name: "b.txt", data: "no", store: true }, { name: "c.csv", data: "z\n", store: true }]);
    expect(looksLikeZip(z)).toBe(true);
    expect(readZip(z, (n) => n.endsWith(".csv")).map((e) => [e.name, e.data.toString()])).toEqual([["a.csv", "x,y\n1,2\n"], ["c.csv", "z\n"]]);
  });

  it("refuses an entry that inflates past its declared size (zip bomb), encryption, too many entries and garbage", () => {
    const bomb = buildZip([{ name: "big.csv", data: "a".repeat(100_000) }]);
    // Lie about the uncompressed size in the central directory: 10 bytes.
    const cd = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bomb.writeUInt32LE(10, cd + 24);
    expect(() => readZip(bomb, () => true)).toThrow(/couldn't be decompressed|isn't the size/);
    const big = buildZip([{ name: "big.csv", data: "a".repeat(2_000) }]);
    expect(() => readZip(big, () => true, { maxEntries: 5, maxEntryBytes: 1_000, maxTotalBytes: 10_000 })).toThrow(/larger than 1000 bytes/);
    const enc = buildZip([{ name: "e.csv", data: "x" }]);
    enc.writeUInt16LE(0x801, enc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8);
    expect(() => readZip(enc, () => true)).toThrow(/encrypted/);
    const many = buildZip(Array.from({ length: 6 }, (_, i) => ({ name: `${i}.csv`, data: "x" })));
    expect(() => readZip(many, () => true, { maxEntries: 5, maxEntryBytes: 100, maxTotalBytes: 100 })).toThrow(/6 entries/);
    expect(() => readZip(Buffer.from("not a zip at all, just text"), () => true)).toThrow(/Not a zip/);
    // A raw deflate stream is fine on its own (sanity check of the fixture builder).
    expect(deflateRawSync(Buffer.from("x")).length).toBeGreaterThan(0);
  });
});

describe("parsing (pure)", () => {
  it("CSV: quotes, doubled quotes, CRLF, BOM, tabs, and row caps", () => {
    expect(parseCsv('\ufeffa,"b, ""c"""\r\n1,2\r\n').rows).toEqual([["a", 'b, "c"'], ["1", "2"]]);
    expect(parseCsv("URL\tLast crawled\nhttps://example.com/a\t2026-10-01\n").rows[1]).toEqual(["https://example.com/a", "2026-10-01"]);
    const r = parseCsv("h\n1\n2\n3\n4\n", 3);
    expect(r).toEqual({ rows: [["h"], ["1"], ["2"]], truncated: true });
    expect(parseCsv("h\n1\n", 3).truncated).toBe(false);
  });

  it("labels never keep a formula prefix or control characters; dates and counts in Search Console's forms", () => {
    expect(cleanLabel("=HYPERLINK(\"http://evil.example\")")).toBe('HYPERLINK("http://evil.example")');
    expect(cleanLabel("@SUM(1)\u202e\u0007")).toBe("SUM(1)");
    expect(parseDay("20 Aug 2019")).toBe("2019-08-20");
    expect(parseDay("Aug 20, 2019")).toBe("2019-08-20");
    expect(parseDay("2026-10-01")).toBe("2026-10-01");
    expect(parseDay("46300")).toBe("2026-10-05");
    expect(parseDay("2026-02-30")).toBeNull();
    expect([parseCount("1,005"), parseCount("~"), parseCount("-"), parseCount(""), parseCount("12abc")]).toEqual([1005, 0, 0, null, null]);
    expect(hostFromFileName("www.example.com-Coverage-2026-10-14.zip")).toBe("www.example.com");
    expect(hostFromFileName("https___example.com_ Index Coverage Drilldown 2019-09-17.csv")).toBe("example.com");
    expect(hostFromFileName("Critical issues.csv")).toBeNull();
    expect(dayFromFileName("example.com-Coverage-Drilldown-2026-10-14.zip")).toBe("2026-10-14");
  });

  it("a summary export: totals from the chart's last day, reasons grouped, Google's labels, duplicates once", async () => {
    const tables = await readExportTables({ ...file("example.com-Coverage-2026-10-14.zip", summaryZip()) });
    const p = interpretExport(tables, "example.com-Coverage-2026-10-14.zip");
    expect(p).toMatchObject({ kind: "summary", exportedOn: "2026-10-14", exportedOnFrom: "file name", hostHint: "example.com", totals: { date: "2026-10-13", indexed: 412, notIndexed: 128 } });
    expect(p.reasons.map((r) => [r.reason, r.group, r.pages])).toEqual([
      ["Crawled - currently not indexed", "not_indexed", 61],
      ["Page with redirect", "not_indexed", 40],
      ["Duplicate, Google chose different canonical than user", "not_indexed", 12],
      ["Not found (404)", "not_indexed", 1005],
      ["Server error (5xx)", "not_indexed", 0],
      ["Indexed, though blocked by robots.txt", "improve", 3],
    ]);
  });

  it("an .xlsx workbook (Excel or Google Sheets) reads like the CSVs; a formula contributes only its cached value", () => {
    const sheets = parseXlsx(
      new Map([
        ["xl/workbook.xml", '<workbook><sheets><sheet name="Critical issues" sheetId="1" r:id="rId1"/><sheet name="Chart" sheetId="2" r:id="rId2"/></sheets></workbook>'],
        ["xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>'],
        ["xl/sharedStrings.xml", "<sst><si><t>Reason</t></si><si><t>Pages</t></si><si><r><t>Soft </t></r><r><t>404</t></r></si></sst>"],
        ["xl/worksheets/sheet1.xml", '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><f>1+1</f><v>7</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Redirect error &amp; more</t></is></c><c r="C3"><v>5</v></c></row></sheetData></worksheet>'],
        ["xl/worksheets/sheet2.xml", '<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>Date</v></c><c r="B1" t="str"><v>Indexed</v></c></row><row r="2"><c r="A2"><v>46309</v></c><c r="B2"><v>99</v></c></row></sheetData></worksheet>'],
      ]),
    );
    expect(sheets.map((s) => [s.name, s.rows])).toEqual([
      ["Critical issues", [["Reason", "Pages"], ["Soft 404", "7"], ["Redirect error & more", "", "5"]]],
      ["Chart", [["Date", "Indexed"], ["46309", "99"]]],
    ]);
    const p = interpretExport(sheets, "example.com-Coverage-2026-10-14.xlsx");
    expect(p.reasons).toEqual([{ reason: "Soft 404", group: "not_indexed", source: null, validation: null, pages: 7 }]);
    expect(p.totals).toEqual({ date: "2026-10-14", indexed: 99, notIndexed: null });
  });

  it("SEC-1: thousands of <sheet> tags pointing at one worksheet parse it once; empty <row/> elements are capped", async () => {
    const rows = Array.from({ length: 2_000 }, (_, i) => `<row><c r="A${i + 1}" t="inlineStr"><is><t>Reason ${i}</t></is></c><c r="B${i + 1}"><v>${i}</v></c></row>`).join("");
    const sheets = Array.from({ length: 3_000 }, (_, i) => `<sheet name="S${i}" sheetId="${i + 1}" r:id="rId1"/>`).join("");
    const xlsx = buildZip([
      { name: "xl/workbook.xml", data: `<workbook><sheets>${sheets}</sheets></workbook>` },
      { name: "xl/_rels/workbook.xml.rels", data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
      { name: "xl/worksheets/sheet1.xml", data: `<worksheet><sheetData>${rows}</sheetData></worksheet>` },
    ]);
    expect(xlsx.length).toBeLessThan(40_000);
    const started = Date.now();
    const tables = await readExportTables(file("bomb.xlsx", xlsx));
    expect(tables).toHaveLength(1);
    expect(tables[0]!.rows).toHaveLength(2_000);
    expect(Date.now() - started).toBeLessThan(2_000);
    // Distinct worksheets stop at TABLES_MAX.
    const many = new Map<string, string>([
      ["xl/workbook.xml", `<workbook><sheets>${Array.from({ length: 30 }, (_, i) => `<sheet name="S${i}" r:id="r${i}"/>`).join("")}</sheets></workbook>`],
      ["xl/_rels/workbook.xml.rels", `<Relationships>${Array.from({ length: 30 }, (_, i) => `<Relationship Id="r${i}" Target="worksheets/s${i}.xml"/>`).join("")}</Relationships>`],
      ...Array.from({ length: 30 }, (_, i) => [`xl/worksheets/s${i}.xml`, "<worksheet><sheetData><row><c><v>1</v></c></row></sheetData></worksheet>"] as [string, string]),
    ]);
    expect(parseXlsx(many)).toHaveLength(TABLES_MAX);
    const empty = parseXlsx(new Map([
      ["xl/workbook.xml", '<workbook><sheets><sheet name="E" r:id="r1"/></sheets></workbook>'],
      ["xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="r1" Target="worksheets/e.xml"/></Relationships>'],
      ["xl/worksheets/e.xml", `<worksheet><sheetData>${"<row/>".repeat(ROW_ELEMENTS_MAX + 10)}<row><c><v>late</v></c></row></sheetData></worksheet>`],
    ]));
    expect(empty[0]).toMatchObject({ rows: [], truncated: true });
  });

  it("SEC-2: many tag openings without a closing > parse in linear time; an oversized sheet list is refused", () => {
    const MB = 1024 * 1024;
    const fill = (unit: string, bytes: number) => unit.repeat(Math.floor(bytes / unit.length));
    const time = (fn: () => unknown) => {
      const t0 = Date.now();
      fn();
      return Date.now() - t0;
    };
    const rels = '<Relationships><Relationship Id="r1" Target="worksheets/a.xml"/></Relationships>';
    const sheet = '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>';
    const wb = '<workbook><sheets><sheet name="A" r:id="r1"/></sheets></workbook>';
    // 1 MB of "<t " in the shared strings and in an inline-string cell.
    expect(time(() => parseXlsx(new Map([["xl/workbook.xml", wb], ["xl/_rels/workbook.xml.rels", rels], ["xl/worksheets/a.xml", sheet], ["xl/sharedStrings.xml", `<sst><si>${fill("<t ", MB)}</si></sst>`]])))).toBeLessThan(1_000);
    const inline = `<worksheet><sheetData><row><c r="A1" t="inlineStr"><is>${fill("<t ", MB)}</is></c></row></sheetData></worksheet>`;
    expect(time(() => parseXlsx(new Map([["xl/workbook.xml", wb], ["xl/_rels/workbook.xml.rels", rels], ["xl/worksheets/a.xml", inline]])))).toBeLessThan(1_000);
    // Just under 1 MB of "<sheet " and of "<Relationship " (the cap).
    expect(time(() => parseXlsx(new Map([["xl/workbook.xml", `<workbook>${fill("<sheet ", MB - 100)}</workbook>`], ["xl/_rels/workbook.xml.rels", rels]])))).toBeLessThan(1_000);
    expect(time(() => parseXlsx(new Map([["xl/workbook.xml", wb], ["xl/_rels/workbook.xml.rels", fill("<Relationship ", MB - 100)]])))).toBeLessThan(1_000);
    // Attributes: a huge tag isn't read.
    expect(time(() => parseXlsx(new Map([["xl/workbook.xml", `<workbook><sheet ${fill(' r:id="', MB - 100)}/></workbook>`], ["xl/_rels/workbook.xml.rels", rels]])))).toBeLessThan(1_000);
    expect(() => parseXlsx(new Map([["xl/workbook.xml", " ".repeat(WORKBOOK_XML_MAX + 1)]]))).toThrow(/larger than 1 MB/);
  });

  it("SEC-4: at most 50 distinct reasons are kept, with a note; the section lists at most 50 per table", () => {
    const rows = [["Reason", "Pages"], ...Array.from({ length: 80 }, (_, i) => [`Made-up reason ${i}`, String(i + 1)])];
    const p = interpretExport([{ name: "Critical issues", rows }], "example.com-Coverage-2026-10-14.csv");
    expect(p.reasons).toHaveLength(REASONS_MAX);
    expect(p.notes.join(" ")).toMatch(/Only the first 50 reasons were read; 30 more were left out/);
    const pr = { exportedOn: "2026-10-14", importedAt: "2026-10-14T00:00:00Z", indexed: 1, notIndexed: 1, reasons: Array.from({ length: 70 }, (_, i) => ({ reason: `R${i}`, group: "not_indexed", severity: "medium", pages: 5, source: null, validation: null, examples: [], examplesTotal: null, examplesExportedOn: null, indexedSince: 0 })) };
    const data = { property: "sc-domain:example.com", sample: { inspected: 0, inspectedThisRun: 0, keyPages: 0, sitemapUrls: 0, sitemapUrlsKnown: 0, oldestDays: null }, indexed: { count: 0, share: null }, byCoverage: [], worst: [], canonicalMismatches: 0, sitemaps: [], trend: [], quota: { day: "d", used: 0, budget: 1, exhausted: false }, pagesReport: pr, notes: [] };
    const blocks = SECTION_MAPPERS.indexing_issues!(data as never, {} as never, { domain: "example.com", onepage: false } as never) as { kind: string; rows?: unknown[] }[];
    expect(blocks.find((b) => b.kind === "table")?.rows).toHaveLength(50);
  });

  it("refuses something that isn't a Pages export, and a drilldown that doesn't name its reason", () => {
    expect(() => interpretExport([{ name: "x", rows: [["Query", "Clicks"], ["a", "1"]] }], "x.csv")).toThrow(/doesn't look like Search Console's Pages report/);
    expect(() => interpretExport([{ name: "Table", rows: [["URL", "Last crawled"], [`${E}/a`, "2026-10-01"]] }], "Table.csv")).toThrow(/doesn't say which reason/);
    expect(interpretExport([{ name: "Table", rows: [["URL", "Last crawled"], [`${E}/a`, "2026-10-01"]] }], "Table.csv", { reason: "crawled \u2013 currently not indexed" }).drilldown?.reason).toBe("Crawled - currently not indexed");
  });
});

describe("import (store) and the merged view", () => {
  it("imports a summary and a drilldown, checks the property, and index_coverage merges them with fresher URL Inspection results", async () => {
    const c = client("imp-merge.example.com");
    const s = await importPagesExport(c, file("example.com-Coverage-2026-10-14.zip", summaryZip()), { now: NOW });
    expect(s).toMatchObject({ kind: "summary", exportedOn: "2026-10-14", exportedOnFrom: "file name", indexed: 412, notIndexed: 128, file: "example.com-Coverage-2026-10-14.zip" });
    expect(s.reasons).toHaveLength(6);

    const rows = [`${E}/blog/a,20 Sep 2026`, `${E}/blog/b,2026-09-21`, `${E}/blog/c,`, "https://example.net/elsewhere,2026-09-01", "javascript:alert(1),2026-09-01"];
    const d = await importPagesExport(c, file("example.com-Coverage-Drilldown-2026-10-14.zip", drillZip(rows)), { now: NOW });
    expect(d).toMatchObject({ kind: "drilldown", reason: "Crawled - currently not indexed", examplesStored: 3, urlsInProperty: 3 });
    expect(d.notes.join(" ")).toMatch(/1 row without an http\(s\) URL was skipped.*1 URL outside sc-domain:example.com was left out/);

    // URL Inspection after the export says /blog/a is indexed now; /blog/b was inspected before the export (not fresher).
    const base = { verdict: "PASS", coverageState: "Submitted and indexed", indexingState: "INDEXING_ALLOWED", pageFetchState: "SUCCESSFUL", robotsTxtState: "ALLOWED", googleCanonical: null, userCanonical: null, lastCrawlTime: null, crawledAs: "MOBILE" };
    saveInspection({ ...base, url: `${E}/blog/a`, client: c.slug, property: "sc-domain:example.com", origin: "sitemap", inspectedAt: Date.parse("2026-10-16T10:00:00Z") });
    saveInspection({ ...base, url: `${E}/blog/b`, client: c.slug, property: "sc-domain:example.com", origin: "sitemap", inspectedAt: Date.parse("2026-10-14T10:00:00Z") });

    const cov = await indexCoverage(c, {}, { now: () => NOW, sitemaps: async () => [], budget: 1000 });
    const pr = cov.pagesReport!;
    expect(pr).toMatchObject({ exportedOn: "2026-10-14", indexed: 412, notIndexed: 128 });
    expect(pr.reasons.map((r) => [r.reason, r.severity, r.pages])).toEqual([
      ["Server error (5xx)", "high", 0],
      ["Not found (404)", "medium", 1005],
      ["Crawled - currently not indexed", "medium", 61],
      ["Duplicate, Google chose different canonical than user", "medium", 12],
      ["Page with redirect", "low", 40],
      ["Indexed, though blocked by robots.txt", "medium", 3],
    ]);
    const crawled = pr.reasons.find((r) => r.reason === "Crawled - currently not indexed")!;
    expect(crawled).toMatchObject({ examplesTotal: 3, examplesExportedOn: "2026-10-14", indexedSince: 1 });
    expect(crawled.examples.map((e) => [e.url, e.lastCrawled, e.indexedNow])).toEqual([
      [`${E}/blog/b`, "2026-09-21", null],
      [`${E}/blog/c`, null, null],
      [`${E}/blog/a`, "2026-09-20", true],
    ]);
    expect(cov.notes.join(" ")).toMatch(/From Search Console's Pages report exported on 2026-10-14: 128 not indexed and 412 indexed, by reason: Server error \(5xx\) 0; Not found \(404\) 1,005; .* 1 example URL were indexed when URL Inspection checked them after the export/);

    // The section shows the export first; with only an import (no inspections) it still renders.
    const blocks = SECTION_MAPPERS.indexing_issues!({ ...cov, sample: { ...cov.sample, inspected: 0 } } as never, {} as never, { domain: "example.com", onepage: false } as never) as { kind: string; title?: string; text?: { t: string }[]; rows?: { t: string }[][][] }[];
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "table", "table", "note"]);
    expect(blocks[0]!.text![0]!.t).toBe("From Search Console's Pages report exported on 14 Oct 2026: 128 pages not indexed and 412 indexed. These are Google's own counts for every page it knows, by reason.");
    expect(blocks[1]!.title).toBe("Why pages aren't indexed (Search Console)");
    const crawledRow = blocks[1]!.rows!.find((r) => r[0]!.some((x) => x.t === "Crawled - currently not indexed"))!;
    // R-4: "Server error (5xx)" at 0 pages stays in the data but not in the table.
    expect(pr.reasons.some((r) => r.reason === "Server error (5xx)" && r.pages === 0)).toBe(true);
    expect(blocks[1]!.rows!.some((r) => r[0]!.some((x) => x.t === "Server error (5xx)"))).toBe(false);
    expect(blocks[1]!.rows).toHaveLength(4);
    expect(crawledRow[2]!.map((x) => x.t).join("")).toBe("/blog/b, /blog/c, /blog/a (indexed now)");

    // Re-importing the same export replaces it (one summary for that date).
    await importPagesExport(c, file("example.com-Coverage-2026-10-14.zip", summaryZip()), { now: NOW + 1000 });
    expect(pagesReportFor(c.slug, "sc-domain:example.com", [])?.reasons).toHaveLength(6);
  });

  it("R-2: an older drilldown for a reason the newer summary no longer lists doesn't come back; a newer one does", async () => {
    const c = client("imp-stale.example.com");
    await importPagesExport(c, file("example.com-Coverage-Drilldown-2026-10-01.zip", drillZip([`${E}/old,2026-09-01`], "Property,Value\nIssue,Soft 404\n")), { now: NOW });
    expect(pagesReportFor(c.slug, "sc-domain:example.com", [])?.reasons.map((r) => r.reason)).toEqual(["Soft 404"]);
    await importPagesExport(c, file("example.com-Coverage-2026-10-14.zip", summaryZip()), { now: NOW });
    expect(pagesReportFor(c.slug, "sc-domain:example.com", [])?.reasons.map((r) => r.reason)).not.toContain("Soft 404");
    await importPagesExport(c, file("example.com-Coverage-Drilldown-2026-10-16.zip", drillZip([`${E}/new,2026-10-15`], "Property,Value\nIssue,Soft 404\n")), { now: NOW });
    expect(pagesReportFor(c.slug, "sc-domain:example.com", [])?.reasons.find((r) => r.reason === "Soft 404")).toMatchObject({ pages: null, examplesExportedOn: "2026-10-16" });
  });

  it("R-3: with only drilldowns imported, the section doesn't claim Google's complete counts", async () => {
    const c = client("imp-drill-only.example.com");
    await importPagesExport(c, file("example.com-Coverage-Drilldown-2026-10-14.zip", drillZip([`${E}/x,2026-10-01`])), { now: NOW });
    const cov = await indexCoverage(c, {}, { now: () => NOW, sitemaps: async () => [], budget: 1000 });
    expect(cov.pagesReport).toMatchObject({ exportedOn: null, notIndexed: null });
    const blocks = SECTION_MAPPERS.indexing_issues!(cov as never, {} as never, { domain: "example.com", onepage: false } as never) as { kind: string; text?: { t: string }[] }[];
    const para = blocks.find((b) => b.kind === "paragraph")!.text![0]!.t;
    expect(para).toBe("From Search Console's Pages report (example pages only). Only example pages were imported, so there are no counts.");
    expect(para).not.toMatch(/Google's own counts/);
  });

  it("the About line names only the import when there are no inspections, and both when there are", () => {
    const pr = { exportedOn: "2026-10-14", importedAt: "2026-10-14T00:00:00Z", indexed: 4, notIndexed: 2, reasons: [] };
    const only = toMarkdown(buildReportDoc(p13Report({ indexing: { ...INDEXING, sample: { ...INDEXING.sample, inspected: 0 }, pagesReport: pr } }), { version: "0.1.0" }));
    expect(only).toContain("Google indexing: an export of Search Console's Pages report (imported, read on this machine).");
    expect(only).not.toContain("URL Inspection of a sample");
    const both = toMarkdown(buildReportDoc(p13Report({ indexing: { ...INDEXING, pagesReport: pr } }), { version: "0.1.0" }));
    expect(both).toContain("Google indexing: Search Console's URL Inspection of a sample of pages and its sitemap report (free, read-only), and an export of its Pages report.");
  });

  it("refuses an export for another site (file name host, or every URL outside the property)", async () => {
    const c = client("imp-other.example.com", "https://www.example.com/");
    expect(hostMatches("example.com", "https://www.example.com/")).toBe(true);
    expect(hostMatches("www.example.org", "https://www.example.com/")).toBe(false);
    expect(hostMatches("blog.example.com", "sc-domain:example.com")).toBe(true);
    // A URL-prefix property covers one host: neither a subdomain nor the parent domain matches.
    expect(hostMatches("blog.example.com", "https://example.com/")).toBe(false);
    expect(hostMatches("example.com", "https://blog.example.com/")).toBe(false);
    expect(hostMatches("www.example.com", "https://example.com/")).toBe(true);
    await expect(importPagesExport(c, file("www.example.org-Coverage-2026-10-14.zip", summaryZip()), { now: NOW })).rejects.toThrow(/for www.example.org, not example.com/);
    await expect(importPagesExport(c, file("Coverage-Drilldown-2026-10-14.zip", drillZip(["https://example.net/a,2026-09-01", "https://example.net/b,2026-09-01"])), { now: NOW })).rejects.toThrow(/None of the 2 URLs in this export are in https:\/\/www.example.com\//);
    await expect(importPagesExport({ ...c, gscProperty: undefined } as unknown as Client, file("x.csv", CRITICAL), { now: NOW })).rejects.toThrow(/No Search Console property/);
  });

  it("a single CSV (Google Sheets download) works; a missing export date falls back to today and says so; binary and .xls files are refused", async () => {
    const c = client("imp-single.example.com");
    // SEC-3: no host in its name or metadata, so it's refused without the user's confirmation.
    await expect(importPagesExport(c, file("Critical issues.csv", CRITICAL), { now: NOW })).rejects.toThrow(/doesn't name its site .* can't be checked against example.com .* --confirm-property/);
    const r = await importPagesExport(c, file("Critical issues.csv", CRITICAL), { now: NOW, confirmProperty: true });
    expect(r).toMatchObject({ kind: "summary", exportedOn: "2026-10-20", exportedOnFrom: "import day" });
    expect(r.notes.join(" ")).toMatch(/today's date was used/);
    expect(r.notes.join(" ")).toMatch(/stored for example.com as the user confirmed/);
    // A host in the metadata is enough.
    const meta = buildZip([{ name: "Critical issues.csv", data: CRITICAL }, { name: "Metadata.csv", data: "Property,Value\nSite,sc-domain:example.com\n" }]);
    expect((await importPagesExport(c, file("renamed.zip", meta), { now: NOW })).kind).toBe("summary");
    await expect(importPagesExport(c, file("weird.csv", Buffer.from([0x00, 0x01, 0x02, 0x41])), { now: NOW })).rejects.toThrow(/binary data/);
    await expect(importPagesExport(c, file("old.xls", Buffer.from("\xd0\xcf\x11\xe0 binary", "latin1")), { now: NOW })).rejects.toThrow(/an old .xls can't be read/);
  });

  it("files over the size cap are refused before they're read", async () => {
    const big = file("huge-Coverage-2026-10-14.zip", "");
    truncateSync(big.path, IMPORT_MAX_BYTES + 1);
    await expect(importPagesExport(client("imp-big.example.com"), big, { now: NOW })).rejects.toThrow(/larger than 25 MB are refused/);
  });
});

describe("import_index_report tool (IMPORT_DIRS containment)", () => {
  type Cb = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  async function loadTool(importDirs: string | undefined): Promise<Cb> {
    vi.resetModules();
    if (importDirs === undefined) delete process.env.IMPORT_DIRS;
    else process.env.IMPORT_DIRS = importDirs;
    const { registerIndexImportTools } = await import("../src/tools/index-import.js");
    let cb: Cb | undefined;
    registerIndexImportTools({ registerTool: (_n: string, _d: unknown, c: Cb) => void (cb = c) } as never);
    delete process.env.IMPORT_DIRS;
    return cb!;
  }
  const root = mkdtempSync(join(tmpdir(), "crawlmark-import-tool-"));
  const imports = join(root, "imports");
  const outside = join(root, "elsewhere");
  mkdirSync(imports);
  mkdirSync(outside);
  writeFileSync(join(imports, "example.com-Coverage-2026-10-14.zip"), summaryZip());
  writeFileSync(join(outside, "secret.csv"), CRITICAL);
  symlinkSync(join(outside, "secret.csv"), join(imports, "link.csv"));

  it("without IMPORT_DIRS (and no <home>/imports) it is unavailable with the setup hint", async () => {
    const r = await (await loadTool(undefined))({ client: "imp-tool.example.com", path: "x.zip" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Put the export in the imports folder of your crawlmark home, or set IMPORT_DIRS/);
  });

  it("imports a file inside IMPORT_DIRS and refuses paths outside, traversal, symlinks out and wildcards", async () => {
    const tool = await loadTool(`${imports}, relative/dir`);
    const ok = await tool({ client: "imp-tool.example.com", path: "example.com-Coverage-2026-10-14.zip" });
    expect(ok.isError).toBeUndefined();
    const data = JSON.parse(ok.content[0]!.text);
    expect(data).toMatchObject({ client: "imp-tool.example.com", kind: "summary", exportedOn: "2026-10-14", notIndexed: 128 });
    expect(data.notes.join(" ")).toMatch(/"relative\/dir" isn't an absolute path/);
    for (const path of [join(outside, "secret.csv"), "../elsewhere/secret.csv", "link.csv", "*.zip"]) {
      const r = await tool({ client: "imp-tool.example.com", path });
      expect(r.isError, path).toBe(true);
      expect(r.content[0]!.text).toMatch(/outside the allowed import directories|can't contain|No readable export file|without wildcards/);
    }
  });
});

describe("crawlmark-cli index-coverage import", () => {
  const io = () => {
    const outs: string[] = [];
    const warns: string[] = [];
    const usage: string[] = [];
    return { outs, warns, usage, io: { out: (l: string) => outs.push(l), warn: (l: string) => warns.push(l), usage: (p: string) => (usage.push(p), 1) } };
  };
  const base = { all: false, "dry-run": false };
  it("imports one file for one client; usage errors and import errors exit 1", async () => {
    const deps = { resolveClient: async (s: string) => client(s), importFile: async (c: Client, path: string, o: { reason?: string; confirmProperty?: boolean }) => importPagesExport(c, { name: path, path }, { ...o, now: NOW }) };
    const zip = file("example.com-Coverage-Drilldown-2026-10-15.zip", drillZip([`${E}/x,2026-10-01`], "Property,Value\nReport,Page indexing\n"));
    const a = io();
    expect(await indexImportCommand([zip.path], { ...base, client: "cli-imp.example.com", reason: "Discovered - currently not indexed" }, a.io, deps)).toBe(0);
    expect(JSON.parse(a.outs[0]!)).toMatchObject({ command: "index-coverage import", kind: "drilldown", reason: "Discovered - currently not indexed", exportedOn: "2026-10-15", examplesStored: 1 });

    const b = io();
    expect(await indexImportCommand([zip.path], { ...base, client: "cli-imp.example.com" }, b.io, deps)).toBe(1);
    expect(b.warns[0]).toMatch(/doesn't say which reason/);
    // --confirm-property reaches the import (SEC-3).
    const hostless = file("Critical issues.csv", CRITICAL);
    const h1 = io();
    expect(await indexImportCommand([hostless.path], { ...base, client: "cli-imp.example.com" }, h1.io, deps)).toBe(1);
    expect(h1.warns[0]).toMatch(/--confirm-property/);
    const h2 = io();
    expect(await indexImportCommand([hostless.path], { ...base, client: "cli-imp.example.com", "confirm-property": true }, h2.io, deps)).toBe(0);
    for (const [args, flags] of [
      [[], { ...base, client: "x" }],
      [[zip.path, zip.path], { ...base, client: "x" }],
      [[zip.path], { ...base, all: true }],
      [[zip.path], { ...base, client: "x", "all-pages": true }],
    ] as const) {
      const u = io();
      expect(await indexImportCommand([...args], flags, u.io, deps)).toBe(1);
      expect(u.usage).toHaveLength(1);
    }
  });
});
