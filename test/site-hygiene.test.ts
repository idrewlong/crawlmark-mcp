import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), "crawlmark-hygiene-"));

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "../src/config.js";
import { diffAudits, type StoredAudit } from "../src/analysis/diff.js";
import { checkedPairs, extractFindings } from "../src/analysis/findings.js";
import { analyzeRobots, hasNoindex, orphanFlags, keyPagesMissingFromSitemaps, orphanUrls, schemaFlags } from "../src/analysis/hygiene.js";
import { checkHreflang } from "../src/analysis/hreflang.js";
import { extractPageHygiene, parseSitemapXml } from "../src/analysis/hygiene-parse.js";
import { isAllowed, parseRobots, rulesFor } from "../src/analysis/robots.js";
import { validateJsonLd } from "../src/analysis/structured-data.js";
import type { AuditResult } from "../src/reports/audit.js";
import { evenSample, siteHygiene } from "../src/reports/site-hygiene.js";
import { saveAudit } from "../src/lib/audits.js";
import { closeAllBrowsers, withChrome } from "../src/providers/browser.js";

describe("robots.txt", () => {
  const file = parseRobots(`# c
User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /*.pdf$

User-agent: Googlebot
User-agent: Bingbot
Disallow: /g-only
Sitemap: https://example.com/sitemap.xml
`);
  it("parses groups and sitemap lines", () => {
    expect(file.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
    expect(rulesFor(file, "googlebot").matched).toBe("googlebot");
    expect(rulesFor(file, "other").matched).toBe("*");
  });
  it("uses longest match with Allow winning ties, plus wildcards", () => {
    const star = rulesFor(file, "x").rules;
    expect(isAllowed(star, "/private/a")).toBe(false);
    expect(isAllowed(star, "/private/public/a")).toBe(true);
    expect(isAllowed(star, "/a/doc.pdf")).toBe(false);
    expect(isAllowed(star, "/a/doc.pdf?x=1")).toBe(true);
    expect(isAllowed([{ allow: true, pattern: "/a" }, { allow: false, pattern: "/a" }], "/a")).toBe(true);
    expect(isAllowed(rulesFor(file, "googlebot").rules, "/private/a")).toBe(true); // Googlebot group replaces *
  });
  it("flags missing, disallow-all, blocked key page and no sitemap", () => {
    const rules = (r: { flags: { rule: string }[] }) => r.flags.map((f) => f.rule).sort();
    expect(rules(analyzeRobots("https://example.com/robots.txt", { status: 404, contentType: "text/html", text: "" }, []))).toEqual(["robots-missing"]);
    expect(rules(analyzeRobots("https://example.com/robots.txt", { status: 200, contentType: "text/html", text: "<html>" }, []))).toEqual(["robots-missing"]);
    expect(rules(analyzeRobots("u", { status: 200, contentType: "text/plain", text: "User-agent: *\nDisallow: /\n" }, ["https://example.com/a"]))).toEqual(["robots-blocks-key-page", "robots-disallow-all", "robots-no-sitemap"]);
    expect(rules(analyzeRobots("u", { status: 200, contentType: "text/plain", text: "User-agent: *\nDisallow:\nSitemap: https://example.com/s.xml" }, []))).toEqual([]);
    expect(() => analyzeRobots("u", { status: 503, contentType: null, text: "" }, [])).toThrow(/503/);
  });
});

describe("sitemap parsing", () => {
  it("reads urlsets and indexes in xml mode", () => {
    expect(parseSitemapXml('<?xml version="1.0"?><urlset xmlns="x"><url><loc> https://example.com/a </loc></url><url><loc>https://example.com/b</loc></url></urlset>')).toEqual({ kind: "urlset", locs: ["https://example.com/a", "https://example.com/b"], lastmods: {}, alternates: {} });
    expect(parseSitemapXml("<sitemapindex><sitemap><loc>https://example.com/s1.xml</loc></sitemap></sitemapindex>").kind).toBe("index");
    expect(() => parseSitemapXml("<html></html>")).toThrow(/Not a sitemap/);
  });
  it("samples evenly and deterministically", () => {
    const items = Array.from({ length: 200 }, (_, i) => i);
    expect(evenSample(items, 50)).toHaveLength(50);
    expect(evenSample(items, 50)).toEqual(evenSample(items, 50));
    expect(evenSample([1, 2], 50)).toEqual([1, 2]);
  });
  it("detects noindex directives and key pages missing from the sitemap", () => {
    expect(hasNoindex("noindex, nofollow")).toBe(true);
    expect(hasNoindex("googlebot: noindex")).toBe(true);
    expect(hasNoindex("index, follow")).toBe(false);
    const f = keyPagesMissingFromSitemaps(["https://example.com/a/", "https://www.example.com/b"], ["http://example.com/a", "https://example.com/c"]);
    expect(f.map((x) => x.url)).toEqual(["https://www.example.com/b"]);
  });
  it("finds sitemap URLs a crawl never reached", () => {
    expect(orphanUrls(["https://example.com/a", "https://example.com/b/"], ["https://example.com/a/"])).toEqual(["https://example.com/b/"]);
  });
});

describe("structured data (basic validation)", () => {
  const ld = (v: unknown) => ({ ok: true as const, value: v });
  it("flags missing required properties, including inside @graph and for LocalBusiness subtypes", () => {
    const r = validateJsonLd([
      ld({ "@context": "https://schema.org", "@graph": [{ "@type": "Plumber", name: "X" }, { "@type": "Organization", name: "X" }] }),
      ld({ "@type": "Product", name: "P", offers: { price: 1 } }),
      ld({ "@type": "Product", name: "P2" }),
      ld({ "@type": "FAQPage", mainEntity: [] }),
      ld({ "@type": ["Article", "Thing"], headline: "h", author: { name: "a" }, datePublished: "2026-01-01" }),
    ]);
    expect(r.issues.map((i) => `${i.type}:${i.detail.join("+")}`)).toEqual(["Plumber:address", "Product:offers|review|aggregateRating", "FAQPage:mainEntity"]);
    expect(r.types).toEqual(["Article", "FAQPage", "Organization", "Plumber", "Product", "Thing"]);
  });
  it("turns issues into medium and low findings that say the validation is basic", () => {
    const flags = schemaFlags("https://example.com/", validateJsonLd([{ ok: false, error: "Unexpected token" }, ld({ "@type": "BreadcrumbList" })]));
    expect(flags.map((f) => [f.rule, f.severity])).toEqual([["schema-missing-property", "medium"], ["schema-parse-error", "low"]]);
    expect(flags.every((f) => /basic validation/.test(f.title))).toBe(true);
  });
  it("extracts JSON-LD, including broken blocks, and hreflang from HTML", () => {
    const p = extractPageHygiene(
      '<head><script type="application/ld+json">{"@type":"Organization","name":"A"}</script><script type="application/ld+json">{bad</script><link rel="alternate" hreflang="FR" href="/fr"><meta name="robots" content="NoIndex"></head>',
      "https://example.com/",
    );
    expect(p.jsonLd.map((b) => b.ok)).toEqual([true, false]);
    expect(p.hreflang).toEqual([{ lang: "fr", href: "https://example.com/fr" }]);
    expect(p.robots).toBe("noindex");
  });
});

describe("orphans", () => {
  it("does not cap findings, and skips URLs modified after the crawl", () => {
    const urls = Array.from({ length: 120 }, (_, i) => `https://example.com/p${i}`);
    expect(orphanFlags(orphanUrls(urls, []))).toHaveLength(120);
    const lastmods = new Map([["https://example.com/p0", 2000], ["https://example.com/p1", 500]]);
    const got = orphanUrls(urls.slice(0, 3), [], { crawlAtMs: 1000, lastmods });
    expect(got).toEqual(["https://example.com/p1", "https://example.com/p2"]);
  });
  it("reads lastmod, treating a bare date as the end of that day", () => {
    const p = parseSitemapXml("<urlset><url><loc>https://example.com/a</loc><lastmod>2026-01-02</lastmod></url><url><loc>https://example.com/b</loc><lastmod>2026-01-02T03:00:00Z</lastmod></url><url><loc>https://example.com/c</loc></url></urlset>");
    expect(p.lastmods["https://example.com/a"]).toBe(Date.parse("2026-01-03T00:00:00Z") - 1);
    expect(p.lastmods["https://example.com/b"]).toBe(Date.parse("2026-01-02T03:00:00Z"));
    expect(p.lastmods["https://example.com/c"]).toBeUndefined();
  });
});

describe("Article schema is recommended, not required", () => {
  it("flags Article and subtypes as low schema-missing-recommended", () => {
    const r = validateJsonLd([{ ok: true, value: [{ "@type": "BlogPosting", headline: "h" }, { "@type": "Product", name: "p" }] }]);
    expect(r.issues.map((i) => i.kind)).toEqual(["missing-recommended", "missing-property"]);
    expect(schemaFlags("https://example.com/", r).map((f) => [f.rule, f.severity])).toEqual([["schema-missing-property", "medium"], ["schema-missing-recommended", "low"]]);
  });
});

describe("hreflang", () => {
  it("accepts a self-reference to the final URL of a redirecting page", () => {
    const own = [{ lang: "en", href: "https://example.com/new" }, { lang: "fr", href: "https://example.com/fr" }, { lang: "x-default", href: "https://example.com/new" }];
    const fr = new Map([["https://example.com/fr", [{ lang: "en", href: "https://example.com/new" }]]]);
    expect(checkHreflang(["https://example.com/old"], own, fr).map((i) => i.rule)).toEqual(["hreflang-missing-self", "hreflang-not-reciprocal"]); // judged against the pre-redirect URL only
    expect(checkHreflang(["https://example.com/old", "https://example.com/new"], own, fr)).toEqual([]);
  });
});

describe("hreflang checks", () => {
  const e = (lang: string, href: string) => ({ lang, href });
  it("is silent for single-language pages and a correct set", () => {
    expect(checkHreflang(["https://example.com/"], [], new Map())).toEqual([]);
    const own = [e("en", "https://example.com/"), e("fr", "https://example.com/fr"), e("x-default", "https://example.com/")];
    expect(checkHreflang(["https://example.com/"], own, new Map([["https://example.com/fr", [e("fr", "https://example.com/fr"), e("en", "https://example.com/")]]]))).toEqual([]);
  });
  it("flags missing self, missing x-default and non-reciprocal alternates; unread alternates are not judged", () => {
    const own = [e("en-US", "https://example.com/us"), e("fr", "https://example.com/fr"), e("de", "https://example.com/de")];
    const issues = checkHreflang(["https://example.com/"], own, new Map([["https://example.com/fr", [e("fr", "https://example.com/fr")]], ["https://example.com/de", null]]));
    expect(issues.map((i) => i.rule).sort()).toEqual(["hreflang-missing-self", "hreflang-missing-x-default", "hreflang-not-reciprocal"]);
    expect(issues.find((i) => i.rule === "hreflang-not-reciprocal")!.evidence).toContain("/fr");
    expect(issues.find((i) => i.rule === "hreflang-not-reciprocal")!.evidence).not.toContain("/de");
  });
});

describe("siteHygiene against a local site", () => {
  let server: Server;
  let base = "";
  const html = (head: string, body = "<p>hi</p>") => `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
  beforeAll(async () => {
    process.env.ALLOW_PRIVATE_URLS = "true";
    server = createServer((req, res) => {
      const url = req.url ?? "/";
      const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) => res.writeHead(status, { "content-type": type, ...headers }).end(body);
      const host = `http://${req.headers.host}`;
      const urlset = (...paths: string[]) => `<?xml version="1.0"?><urlset>${paths.map((p) => `<url><loc>${host}${p}</loc></url>`).join("")}</urlset>`;
      switch (url) {
        case "/robots.txt":
          return send(200, "text/plain", `User-agent: *\nDisallow: /private\nSitemap: ${host}/index.xml\n`);
        case "/index.xml":
          return send(200, "application/xml", `<sitemapindex><sitemap><loc>${host}/s1.xml</loc></sitemap><sitemap><loc>${host}/s2.xml.gz</loc></sitemap></sitemapindex>`);
        case "/s1.xml":
          return send(200, "application/xml", urlset("/", "/about", "/gone", "/moved", "/hidden"));
        case "/s2.xml.gz":
          return send(200, "application/gzip", gzipSync(urlset("/x-noindex")));
        case "/":
          return send(
            200,
            "text/html",
            html(`<script type="application/ld+json">{"@type":"Product","name":"P"}</script><script type="application/ld+json">{oops</script>
<link rel="alternate" hreflang="en" href="${host}/"><link rel="alternate" hreflang="fr" href="${host}/fr"><link rel="alternate" hreflang="de" href="${host}/de">`),
          );
        case "/fr":
          return send(200, "text/html", html(`<link rel="alternate" hreflang="fr" href="${host}/fr">`));
        case "/de":
          return send(200, "text/html", html(`<link rel="alternate" hreflang="de" href="${host}/de"><link rel="alternate" hreflang="en" href="${host}/">`));
        case "/about":
        case "/contact":
          return send(200, "text/html", html(""));
        case "/moved":
          return void res.writeHead(301, { location: "/about" }).end();
        case "/hidden":
          return send(200, "text/html", html('<meta name="robots" content="noindex">'));
        case "/x-noindex":
          return send(200, "text/html", html(""), { "x-robots-tag": "noindex" });
        default:
          return send(404, "text/html", "<p>nope</p>");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    delete process.env.ALLOW_PRIVATE_URLS;
    server.close();
  });

  const client = (keyPages: string[]) => ({ slug: "127.0.0.1", domain: "127.0.0.1", keyPages }) as unknown as Client;

  it("runs all checks, follows the index, decodes .xml.gz and reports findings", async () => {
    const r = await siteHygiene(client([`${base}/`, `${base}/about`, `${base}/contact`, `${base}/private/x`]), { origin: base, gscSitemapPaths: [] });
    const got = r.flags.map((f) => `${f.rule} ${f.url.replace(base, "")}`).sort();
    expect(got).toEqual(
      [
        "robots-blocks-key-page /private/x",
        "sitemap-non200 /gone",
        "sitemap-redirect /moved",
        "sitemap-noindex /hidden",
        "sitemap-noindex /x-noindex",
        "key-page-not-in-sitemap /contact",
        "key-page-not-in-sitemap /private/x",
        "schema-missing-property /",
        "schema-parse-error /",
        "hreflang-missing-x-default /",
        "hreflang-not-reciprocal /",
      ].sort(),
    );
    expect(r.sitemaps).toMatchObject({ totalUrls: 6, complete: true });
    expect(r.orphans).toEqual({ available: false, reason: "not available: no full crawl" });
    expect(r.checked).toEqual(expect.arrayContaining(["site:robots", "site:sitemap-urls", `${base}/gone`]));
  }, 30_000); // Renders pages in headless Chrome: about 5 s on a shared CI runner.

  it("feeds the audit diff: fixed findings resolve, unchecked ones stay unverified", async () => {
    const mk = (id: string, ranAt: number, hygiene: unknown): StoredAudit => {
      const a = { client: { slug: "x" }, settings: {}, summary: {}, pages: [], site: { sitemaps: { ok: false, error: "x" }, crawl: null, backlinks: null, hygiene } } as unknown as AuditResult;
      return { id, client: "x", ranAt, settings: {}, summary: {}, findings: extractFindings(a), checked: checkedPairs(a), result: a };
    };
    const flag = (rule: string, url: string) => ({ rule, url, severity: "medium", title: rule });
    const base = mk("a", 1, { ok: true, data: { flags: [flag("robots-missing", "https://example.com/robots.txt"), flag("sitemap-non200", "https://example.com/gone"), flag("schema-parse-error", "https://example.com/")], checked: [] } });
    const target = mk("b", 2, { ok: true, data: { flags: [], checked: ["site:robots", "https://example.com/gone"] } });
    const d = diffAudits(base, target);
    expect(d.resolved.map((f) => f.rule).sort()).toEqual(["robots-missing", "sitemap-non200"]);
    expect(d.unverified.map((f) => f.rule)).toEqual(["schema-parse-error"]);
    expect(base.findings.every((f) => f.source === "site")).toBe(true);
  });
});

describe("diffing old-style and new-style stored audits", () => {
  const mk = (id: string, ranAt: number, sitemaps: unknown, hygiene?: unknown): StoredAudit => {
    const a = { client: { slug: "x" }, settings: {}, summary: {}, pages: [], site: { sitemaps, crawl: null, backlinks: null, ...(hygiene ? { hygiene } : {}) } } as unknown as AuditResult;
    return { id, client: "x", ranAt, settings: {}, summary: {}, findings: extractFindings(a), checked: checkedPairs(a), result: a };
  };
  const gsc = { ok: true, data: [{ path: "https://example.com/s.xml", errors: 2, warnings: 0 }] };
  const hy = { ok: true, data: { flags: [{ rule: "robots-missing", url: "https://example.com/robots.txt", severity: "low", title: "t" }], checked: ["site:robots"] } };
  it("old to new: GSC sitemap findings stay persistent; the old audit's plain \"site\" pair still counts", () => {
    const old = mk("old", 1, gsc);
    expect(old.checked).toEqual([{ url: "site", source: "site" }]);
    const d = diffAudits(old, mk("new", 2, gsc, hy));
    expect(d.persistent.map((f) => f.rule)).toEqual(["sitemap-errors"]);
    expect(d.new.map((f) => f.rule)).toEqual(["robots-missing"]);
    expect(diffAudits(old, mk("new2", 3, { ok: true, data: [] }, hy)).resolved.map((f) => f.rule)).toEqual(["sitemap-errors"]);
  });
  it("new to old: hygiene findings are unverified (the old audit never ran them), GSC ones compare normally", () => {
    const d = diffAudits(mk("new", 1, gsc, hy), mk("old", 2, { ok: true, data: [] }));
    expect(d.resolved.map((f) => f.rule)).toEqual(["sitemap-errors"]);
    expect(d.unverified.map((f) => f.rule)).toEqual(["robots-missing"]);
  });
});

describe("siteHygiene edge cases", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    process.env.ALLOW_PRIVATE_URLS = "true";
    server = createServer((req, res) => {
      const host = `http://${req.headers.host}`;
      const send = (type: string, body: string) => res.writeHead(200, { "content-type": type }).end(body);
      if (req.url === "/robots.txt") return send("text/plain", `User-agent: *\nSitemap: ${host}/s.xml\n`);
      if (req.url === "/s.xml") return send("application/xml", `<urlset><url><loc>${host}/big</loc></url><url><loc>${host}/</loc></url></urlset>`);
      if (req.url === "/big") return send("text/html", "<html><head></head><body>" + "<i></i>".repeat(210_000) + "</body></html>");
      return send("text/html", "<html><head><title>t</title></head><body>ok</body></html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    delete process.env.ALLOW_PRIVATE_URLS;
    server.close();
  });
  const client = { slug: "127.0.0.1", domain: "127.0.0.1", keyPages: [] as string[] } as unknown as Client;

  it("does not count a page whose HTML could not be parsed as checked", async () => {
    const r = await siteHygiene(client, { origin: base, gscSitemapPaths: [] });
    if ("error" in r.sitemaps) throw new Error(r.sitemaps.error);
    expect(r.sitemaps.sampled.map((s) => s.url.replace(base, ""))).toContain("/big");
    expect(r.sitemaps.sampleErrors.map((e) => e.url.replace(base, ""))).toEqual(["/big"]);
    expect(r.checked).not.toContain(`${base}/big`);
    expect(r.checked).toContain(base);
  });

  it("skips orphans, with a reason, when the stored crawl is older than 30 days", async () => {
    saveAudit({
      id: "old-crawl", client: "127.0.0.1", ranAt: Date.now() - 40 * 86_400_000, settings: {}, summary: {}, findings: [], checked: [],
      result: { site: { crawl: { ok: true, data: { taskId: "task-1" } } } },
    });
    const r = await siteHygiene(client, { origin: base, gscSitemapPaths: [] });
    expect(r.orphans).toMatchObject({ available: false });
    expect((r.orphans as { reason: string }).reason).toMatch(/40 days old/);
    expect(r.checked).not.toContain("site:orphans");
  });
});

describe("withChrome pending launch", () => {
  it("closes a browser that arrives after shutdown began", async () => {
    let finish!: (b: string) => void;
    const launch = () => new Promise<string>((r) => (finish = r));
    const closed: string[] = [];
    let worked = false;
    const p = withChrome("slow launch", undefined, launch, (b) => void closed.push(b), async () => void (worked = true));
    const shutdown = closeAllBrowsers();
    finish("browser-1");
    await shutdown;
    await expect(p).rejects.toThrow(/cancelled while the browser was starting/);
    expect(closed).toEqual(["browser-1"]);
    expect(worked).toBe(false);
  });
  it("does not try to close when the launch fails", async () => {
    let closed = 0;
    await expect(withChrome("bad launch", undefined, async () => Promise.reject(new Error("no chrome")), () => void closed++, async () => 1)).rejects.toThrow("no chrome");
    expect(closed).toBe(0);
  });
});
