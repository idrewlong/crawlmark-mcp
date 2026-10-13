/**
 * llms.txt check (informational): the llmstxt.org format parser, the site_hygiene integration against a
 * local server (presence, llms-full.txt, sampled same-host links), and checked/unverified semantics in the diff.
 */
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), "crawlmark-llms-"));

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "../src/config.js";
import { diffAudits, type StoredAudit } from "../src/analysis/diff.js";
import { checkedPairs, extractFindings, siteCheckUrl } from "../src/analysis/findings.js";
import { parseLlmsTxt } from "../src/analysis/llms-txt.js";
import type { AuditResult } from "../src/reports/audit.js";
import { LLMS_LINK_SAMPLE, siteHygiene } from "../src/reports/site-hygiene.js";

const BASE = "https://example.com/llms.txt";
const GOOD = `# Example Co

> Plumbing services in Springfield.

Some prose about the site.

## Docs

- [Services](/services): what we do
- [Pricing](https://example.com/pricing)

## Optional

- [Blog](https://example.com/blog)
`;

describe("parseLlmsTxt", () => {
  it("accepts a file that follows the proposal", () => {
    const f = parseLlmsTxt(GOOD, BASE);
    expect(f).toMatchObject({ title: "Example Co", hasSummary: true, sectionCount: 2, hasOptionalSection: true, linkCount: 3, issues: [] });
    expect(f.sections).toEqual([{ name: "Docs", links: 2 }, { name: "Optional", links: 1 }]);
    expect(f.links).toEqual(["https://example.com/services", "https://example.com/pricing", "https://example.com/blog"]);
  });

  it("accepts the minimum (an H1 only) and a BOM", () => {
    expect(parseLlmsTxt("\uFEFF# Title\n", BASE)).toMatchObject({ title: "Title", hasSummary: false, sectionCount: 0, issues: [] });
  });

  it("flags only the structure: a missing H1, content before it, several H1s, a deep heading first, sections without links", () => {
    expect(parseLlmsTxt("Just text\n", BASE).issues).toEqual(["There is no H1 title (the only required part)."]);
    expect(parseLlmsTxt("intro\n# T\n", BASE).issues).toEqual(["The file does not start with the H1 title."]);
    expect(parseLlmsTxt("# A\n# B\n", BASE).issues).toEqual(["There are 2 H1 headings; the proposal has one title."]);
    expect(parseLlmsTxt("# T\n### Deep\n## Docs\n- [a](/a)\n", BASE).issues).toEqual(["A heading other than H1 or H2 comes before the first H2 section."]);
    expect(parseLlmsTxt("# T\n## Docs\nprose only\n- plain item\n", BASE)).toMatchObject({ linkCount: 0, nonLinkItems: 1, issues: ["The H2 sections contain no links."] });
  });

  it("counts every common link-item variant as a link, with notes style as data", () => {
    const f = parseLlmsTxt(
      [
        "# T",
        "## Docs",
        "- [colon](/a): notes",
        "- [dash](/b) - notes",
        "- [em](/c) \u2014 notes",
        "- **[bold](/d)**: notes",
        '- [titled](/e "A title")',
        "- [angle](</f g>)",
        "- [wiki](https://en.wikipedia.org/wiki/Foo_(bar))",
        "1. [numbered](/h)",
        "2) [numbered paren](/i): x",
        "+ [plus](/j)",
        "  - an indented sub-bullet note",
        "\t- [indented link](/ignored)",
        "- just text",
        "",
      ].join("\n"),
      BASE,
    );
    expect(f.issues).toEqual([]);
    expect(f.linkCount).toBe(10);
    expect(f.nonLinkItems).toBe(1);
    expect(f.notesStyle).toEqual({ colon: 3, dash: 2, none: 5, other: 0 });
    expect(f.links).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
      "https://example.com/d",
      "https://example.com/e",
      "https://example.com/f%20g",
      "https://en.wikipedia.org/wiki/Foo_(bar)",
      "https://example.com/h",
      "https://example.com/i",
      "https://example.com/j",
    ]);
  });

  it("does not take nested or unbalanced parentheses as a link", () => {
    expect(parseLlmsTxt("# T\n## S\n- [a](/x((y)))\n- [b](/x(y)\n- [c](/ok)\n", BASE)).toMatchObject({ linkCount: 1, nonLinkItems: 2 });
  });

  it("keeps C# in a heading, strips a real closing sequence", () => {
    expect(parseLlmsTxt("# C#\n", BASE).title).toBe("C#");
    expect(parseLlmsTxt("# Title ##  \n", BASE).title).toBe("Title");
    expect(parseLlmsTxt("# Title#\n", BASE).title).toBe("Title#");
  });

  it("ignores fenced code, keeps only http(s) links, and strips control characters from the title", () => {
    const f = parseLlmsTxt("# Ti\u202Etle\u0007\n## S\n```\n# not a heading\n- not a link\n```\n- [m](mailto:a@example.com)\n- [j](javascript:alert(1))\n", BASE);
    expect(f.title).toBe("Title");
    expect(f.links).toEqual([]);
    expect(f).toMatchObject({ linkCount: 2, nonLinkItems: 0, issues: [] });
  });

  it("is linear on hostile input", () => {
    const hostile = `# T\n## S\n${`- [${"[".repeat(3000)}\n`.repeat(500)}${"#".repeat(6)} ${" #".repeat(2000)}x\n`;
    const t = Date.now();
    parseLlmsTxt(hostile, BASE);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe("llms.txt in siteHygiene against a local site", () => {
  let server: Server;
  let base = "";
  let llms: { status: number; type: string; body: string } = { status: 404, type: "text/html", body: "<p>nope</p>" };
  let full: { status: number; type: string; body: string } = { status: 404, type: "text/html", body: "<p>nope</p>" };
  beforeAll(async () => {
    process.env.ALLOW_PRIVATE_URLS = "true";
    server = createServer((req, res) => {
      const send = (status: number, type: string, body: string) => res.writeHead(status, { "content-type": type }).end(body);
      const url = req.url ?? "/";
      if (url === "/robots.txt") return send(200, "text/plain", "User-agent: *\nDisallow:\n");
      if (url === "/llms.txt") return send(llms.status, llms.type, llms.body);
      if (url === "/llms-full.txt") return send(full.status, full.type, full.body);
      if (url === "/" || url.startsWith("/ok")) return send(200, "text/html", "<!doctype html><title>t</title>");
      if (url === "/moved") return void res.writeHead(301, { location: "/ok-target" }).end();
      if (url === "/boom") return send(500, "text/plain", "err");
      return send(404, "text/html", "<p>nope</p>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    delete process.env.ALLOW_PRIVATE_URLS;
    server.close();
  });
  beforeEach(() => {
    llms = { status: 404, type: "text/html", body: "<p>nope</p>" };
    full = { status: 404, type: "text/html", body: "<p>nope</p>" };
  });
  const client = { slug: "127.0.0.1", domain: "127.0.0.1", keyPages: [] } as unknown as Client;
  const run = () => siteHygiene(client, { origin: base, gscSitemapPaths: [], fresh: true });
  const llmsRules = (flags: { rule: string; url: string }[]) => flags.filter((f) => f.rule.startsWith("llms-")).map((f) => `${f.rule} ${f.url.replace(base, "")}`).sort();

  it("a missing llms.txt is data only, not a finding, and still counts as checked", async () => {
    const r = await run();
    expect(r.llmsTxt).toMatchObject({ llmsTxt: { present: false, status: 404 }, llmsFullTxt: { present: false, status: 404 } });
    expect(llmsRules(r.flags)).toEqual([]);
    expect(r.checked).toContain("site:llms-txt");
    expect(r.notes.join(" ")).toMatch(/Google says it doesn't use/);
  });

  it("an HTML page served at /llms.txt is not the file", async () => {
    llms = { status: 200, type: "text/html; charset=utf-8", body: "<!doctype html><html></html>" };
    const r = await run();
    expect(r.llmsTxt).toMatchObject({ llmsTxt: { present: false, status: 200, note: expect.stringMatching(/HTML page/) } });
    expect(llmsRules(r.flags)).toEqual([]);
  });

  it("reports presence, type, size and format, and flags malformed files and broken same-host links as low", async () => {
    const body = `# Example\n> Summary\n# Second title\n## Docs\n- [ok](/ok)\n- [gone](/gone)\n- [moved](/moved)\n- [err](/boom)\n- [other](https://other.example.com/x)\n- not a link\n`;
    llms = { status: 200, type: "text/markdown", body };
    full = { status: 200, type: "text/plain", body: "# Everything\n" };
    const r = await run();
    expect(r.llmsTxt).toMatchObject({
      llmsTxt: { present: true, status: 200, contentType: "text/markdown", bytes: Buffer.byteLength(body), format: { title: "Example", hasSummary: true, linkCount: 5 } },
      llmsFullTxt: { present: true, contentType: "text/plain" },
      links: { total: 5, sameHost: 4 },
    });
    expect(llmsRules(r.flags)).toEqual(["llms-txt-broken-link /boom", "llms-txt-broken-link /gone", "llms-txt-malformed /llms.txt"]);
    expect(r.flags.filter((f) => f.rule.startsWith("llms-")).every((f) => f.severity === "low")).toBe(true);
    // The redirect that lands on a 200 is fine; the other host was never fetched.
    expect(r.checked).toEqual(expect.arrayContaining(["site:llms-txt", `site:llms-txt-link ${base}/ok`, `site:llms-txt-link ${base}/moved`, `site:llms-txt-link ${base}/gone`]));
    expect(r.checked.some((k) => k.includes("other.example.com"))).toBe(false);
  });

  it(`samples at most ${LLMS_LINK_SAMPLE} links`, async () => {
    llms = { status: 200, type: "text/plain", body: `# T\n## Docs\n${Array.from({ length: 15 }, (_, i) => `- [p${i}](/ok${i})`).join("\n")}\n` };
    const r = await run();
    const data = r.llmsTxt as { links: { sameHost: number; sampled: unknown[] } };
    expect(data.links.sameHost).toBe(15);
    expect(data.links.sampled).toHaveLength(LLMS_LINK_SAMPLE);
    expect(r.notes.join(" ")).toMatch(/first 10 of 15/);
  });

  it("an unreadable llms.txt (server error) is not checked", async () => {
    llms = { status: 503, type: "text/plain", body: "busy" };
    const r = await run();
    expect(r.llmsTxt).toEqual({ error: "HTTP 503" });
    expect(r.checked).not.toContain("site:llms-txt");
  });
});

describe("llms.txt findings in the audit diff", () => {
  const mk = (id: string, ranAt: number, hygiene: unknown): StoredAudit => {
    const a = { client: { slug: "x" }, settings: {}, summary: {}, pages: [], site: { sitemaps: { ok: false, error: "x" }, crawl: null, backlinks: null, hygiene } } as unknown as AuditResult;
    return { id, client: "x", ranAt, settings: {}, summary: {}, findings: extractFindings(a), checked: checkedPairs(a), result: a };
  };
  const flag = (rule: string, url: string) => ({ rule, url, severity: "low", title: rule });
  const before = mk("a", 1, { ok: true, data: { flags: [flag("llms-txt-malformed", "https://example.com/llms.txt"), flag("llms-txt-broken-link", "https://example.com/gone"), flag("llms-txt-broken-link", "https://example.com/old")], checked: [] } });

  it("maps rules to their check keys", () => {
    expect(siteCheckUrl("llms-txt-malformed", "https://example.com/llms.txt")).toBe("site:llms-txt");
    expect(siteCheckUrl("llms-txt-broken-link", "https://example.com/gone/")).toBe("site:llms-txt-link https://example.com/gone");
  });

  it("resolves only what the later run checked; a failed fetch leaves findings unverified", () => {
    const later = mk("b", 2, { ok: true, data: { flags: [], checked: ["site:llms-txt", "site:llms-txt-link https://example.com/gone"] } });
    const d = diffAudits(before, later);
    expect(d.resolved.map((f) => `${f.rule} ${f.url}`).sort()).toEqual(["llms-txt-broken-link https://example.com/gone", "llms-txt-malformed https://example.com/llms.txt"]);
    expect(d.unverified.map((f) => f.url)).toEqual(["https://example.com/old"]);
    const failed = mk("c", 3, { ok: true, data: { flags: [], checked: [] } });
    expect(diffAudits(before, failed).resolved).toEqual([]);
    expect(diffAudits(before, failed).unverified).toHaveLength(3);
  });
});
