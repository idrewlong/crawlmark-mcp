import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, gzipSync } from "node:zlib";
// Isolate the cache/DB before anything imports the store.
process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), "crawlmark-render-"));

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Under a loaded machine (load average ~25) spawning tsx or launching Chrome can take tens of seconds.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import { compareRender } from "../src/analysis/render.js";
import { needsNoSandbox } from "../src/providers/browser.js";
import { extractIsolated, MAX_EXTRACT_WORKERS } from "../src/analysis/extract-isolated.js";
import { assertParseable, extractSeo } from "../src/analysis/render-extract.js";
import { checkedPairs, extractFindings } from "../src/analysis/findings.js";
import { assertSafeUrl, isPrivateHost } from "../src/lib/url-guard.js";
import type { AuditResult } from "../src/reports/audit.js";

const fx = (n: string) => readFileSync(new URL(`./fixtures/render/${n}.html`, import.meta.url), "utf8");
const U = "https://example.com/";
const pair = (name: string) => {
  const raw = extractSeo(fx(`${name}.raw`), U);
  const rendered = extractSeo(fx(`${name}.rendered`), U);
  return { raw, rendered, flags: compareRender(raw, rendered) };
};
const rules = (f: { rule: string }[]) => f.map((x) => x.rule).sort();

describe("extractSeo", () => {
  const s = extractSeo(fx("ssr.raw"), U);
  it("extracts head elements", () => {
    expect(s.title).toBe("Example Plumbing | Austin");
    expect(s.metaDescription).toBe("Plumbers in Austin.");
    expect(s.canonical).toBe("https://example.com/");
    expect(s.robots).toBe("index, follow");
    expect(s.h1).toEqual(["Austin plumbing repairs"]);
    expect(s.h2Count).toBe(2);
    expect(s.jsonLdTypes).toEqual(["Plumber", "WebSite"]);
  });
  it("counts links and images", () => {
    expect(s.internalLinks).toBe(2); // /services and www.example.com
    expect(s.externalLinks).toBe(1);
    expect(s.images).toBe(2);
    expect(s.imagesMissingAlt).toBe(1);
  });
  it("ignores script, style, noscript and template text in the word count", () => {
    const n = extractSeo("<body><p>one two three</p><script>a b c d</script><style>x y</style><noscript>n o</noscript><template>t t t</template></body>", U);
    expect(n.wordCount).toBe(3);
  });
  it("tolerates broken JSON-LD and empty documents", () => {
    const n = extractSeo('<script type="application/ld+json">{nope</script>', U);
    expect(n.jsonLdTypes).toEqual([]);
    expect(n.wordCount).toBe(0);
    expect(n.title).toBeNull();
  });
});

describe("compareRender", () => {
  it("reports nothing for an SSR page", () => {
    expect(pair("ssr").flags).toEqual([]);
  });
  it("flags an SPA shell", () => {
    const { flags } = pair("spa");
    expect(rules(flags)).toEqual(
      ["canonical-js-only", "content-js-dependent", "h1-mismatch", "jsonld-js-only", "links-js-only", "title-mismatch"].sort(),
    );
    const sev = Object.fromEntries(flags.map((f) => [f.rule, f.severity]));
    expect(sev["canonical-js-only"]).toBe("high");
    expect(sev["h1-mismatch"]).toBe("high");
    expect(sev["content-js-dependent"]).toBe("medium");
    expect(sev["jsonld-js-only"]).toBe("medium");
    expect(sev["links-js-only"]).toBe("medium");
    expect(flags.find((f) => f.rule === "title-mismatch")!.evidence).toContain('"App"');
  });
  it("flags a mismatched canonical with both values", () => {
    const { flags } = pair("canonical");
    expect(rules(flags)).toEqual(["canonical-mismatch"]);
    expect(flags[0]!.severity).toBe("high");
    expect(flags[0]!.evidence).toContain("https://example.com/staging-copy");
    expect(flags[0]!.evidence).toContain('"https://example.com/"');
  });
  it("ignores a trailing-slash-only canonical difference", () => {
    const a = extractSeo('<link rel="canonical" href="https://example.com/a"><title>t</title>', U);
    const b = extractSeo('<link rel="canonical" href="https://example.com/a/"><title>t</title>', U);
    expect(compareRender(a, b)).toEqual([]);
  });
  it("flags noindex that only appears after render", () => {
    const { flags } = pair("noindex");
    expect(rules(flags)).toEqual(["robots-js-only"]);
    expect(flags[0]!.severity).toBe("high");
    expect(flags[0]!.evidence).toContain("noindex");
  });
});

const ok = <T>(data: T) => ({ ok: true as const, data });
describe("rendering findings and checked pairs", () => {
  const { raw, rendered, flags } = pair("canonical");
  const check = { url: U, raw: { status: 200, finalUrl: U, redirects: 0, contentType: null, xRobotsTag: null, truncated: false, seo: raw }, rendered: { status: 200, finalUrl: U, seo: rendered }, flags };
  const mk = (rendering: unknown) =>
    ({
      client: { slug: "example.com", name: "E", domain: "example.com" },
      ranAt: "2026-10-01T00:00:00.000Z",
      settings: {},
      summary: {},
      site: { sitemaps: { ok: false, error: "x" }, crawl: null, backlinks: null },
      pages: [{ url: U, lighthouse: { ok: false, error: "x" }, accessibility: { ok: false, error: "x" }, indexing: { ok: false, error: "x" }, onPage: { ok: false, error: "x" }, rendering }],
    }) as unknown as AuditResult;

  it("emits findings with source rendering and marks the page checked", () => {
    const a = mk(ok(check));
    const f = extractFindings(a);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ source: "rendering", rule: "canonical-mismatch", severity: "high" });
    expect(checkedPairs(a)).toContainEqual({ url: "https://example.com", source: "rendering" });
  });
  it("does not mark the page checked when a fetch failed", () => {
    const a = mk({ ok: false, error: "timeout" });
    expect(extractFindings(a)).toEqual([]);
    expect(checkedPairs(a).some((c) => c.source === "rendering")).toBe(false);
  });
});

describe("url guard", () => {
  it.each(["localhost", "app.localhost", "127.0.0.1", "127.9.9.9", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "[::1]", "[::ffff:127.0.0.1]", "[fd00::1]", "[fe80::1]", "100.64.0.1", "0.0.0.0", "localhost.", "127.0.0.1.", "192.0.0.5", "198.18.0.1", "198.19.255.1", "224.0.0.1", "255.255.255.255", "[::7f00:1]", "[::a00:1]", "[64:ff9b::7f00:1]", "[64:ff9b::a9fe:a9fe]", "[2002:c0a8:101::]", "[2002:7f00:1::1]", "[fec0::1]", "[ff02::1]", "[::]"])(
    "treats %s as private",
    (h) => expect(isPrivateHost(h)).toBe(true),
  );
  it.each(["example.com", "8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.0.1", "[2606:4700::1111]", "[::ffff:8.8.8.8]", "[64:ff9b::808:808]", "[2002:808:808::]", "198.20.0.1", "192.0.2.1"])("treats %s as public", (h) =>
    expect(isPrivateHost(h)).toBe(false),
  );
  it("allows only http and https", () => {
    expect(() => assertSafeUrl("file:///etc/passwd", {})).toThrow(/http and https/);
    expect(() => assertSafeUrl("ftp://example.com", {})).toThrow();
    expect(() => assertSafeUrl("not a url", {})).toThrow();
    expect(assertSafeUrl("https://example.com/x", {}).hostname).toBe("example.com");
  });
  it("refuses private hosts unless ALLOW_PRIVATE_URLS=true", () => {
    expect(() => assertSafeUrl("http://localhost:3000", {})).toThrow(/ALLOW_PRIVATE_URLS/);
    expect(assertSafeUrl("http://localhost:3000", { ALLOW_PRIVATE_URLS: "true" }).port).toBe("3000");
  });
});

describe("fetchRaw", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    process.env.ALLOW_PRIVATE_URLS = "true";
    server = createServer((req, res) => {
      if (req.url === "/a") return void res.writeHead(301, { location: "/b" }).end();
      if (req.url === "/b") return void res.writeHead(200, { "content-type": "text/html", "x-robots-tag": "noindex", "x-ua": String(req.headers["user-agent"]) }).end("<title>hi</title>" + (req.headers["user-agent"] ?? ""));
      if (req.url === "/big") return void res.writeHead(200, { "content-type": "text/html" }).end("x".repeat(6 * 1024 * 1024));
      if (req.url === "/gz")
        return void res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip", "x-accept": String(req.headers["accept-encoding"]) }).end(gzipSync("<title>zipped</title><p>gzip body</p>"));
      if (req.url === "/br") return void res.writeHead(200, { "content-type": "text/html", "content-encoding": "br" }).end(brotliCompressSync("<title>brotli</title>"));
      if (req.url === "/json") return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
      if (req.url === "/bad") return void res.writeHead(302, { location: "http://169.254.169.254/" }).end();
      res.writeHead(404).end("nope");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    delete process.env.ALLOW_PRIVATE_URLS;
    await new Promise((r) => server.close(r));
  });

  it("follows redirects, records them, and sends a Googlebot UA", async () => {
    const { fetchRaw } = await import("../src/providers/render.js");
    const r = await fetchRaw(`${base}/a`, { refresh: true });
    expect(r).toMatchObject({ status: 200, finalUrl: `${base}/b`, redirects: 1, xRobotsTag: "noindex", truncated: false });
    expect(r.html).toContain("Googlebot");
  });
  it("asks for and decodes gzip (and brotli) bodies", async () => {
    const { fetchRaw } = await import("../src/providers/render.js");
    const gz = await fetchRaw(`${base}/gz`, { refresh: true });
    expect(gz).toMatchObject({ status: 200, truncated: false, html: "<title>zipped</title><p>gzip body</p>" });
    expect((await fetchRaw(`${base}/br`, { refresh: true })).html).toBe("<title>brotli</title>");
  });
  it("caps the body size", async () => {
    const { fetchRaw } = await import("../src/providers/render.js");
    const r = await fetchRaw(`${base}/big`, { refresh: true });
    expect(r.truncated).toBe(true);
    expect(r.html.length).toBe(5 * 1024 * 1024);
  });
  it("checkRender refuses a 404 page instead of comparing it", async () => {
    const { checkRender } = await import("../src/providers/render.js");
    const t = performance.now();
    await expect(checkRender(`${base}/missing`, { refresh: true })).rejects.toThrow(/HTTP 404/);
    // The rendered fetch is aborted, not waited for (no Chrome launch on the critical path). A Chrome launch
    // plus render takes far longer, but a loaded machine can slow the raw fetch, so the bound is generous.
    expect(performance.now() - t).toBeLessThan(10_000);
  });
  it("checkRender refuses non-HTML content", async () => {
    const { checkRender } = await import("../src/providers/render.js");
    await expect(checkRender(`${base}/json`, { refresh: true })).rejects.toThrow(/not HTML/);
  });
  it("returns non-200 statuses without throwing", async () => {
    const { fetchRaw } = await import("../src/providers/render.js");
    expect((await fetchRaw(`${base}/missing`, { refresh: true })).status).toBe(404);
  });
  it("refuses a loopback target when ALLOW_PRIVATE_URLS is off", async () => {
    const { fetchRaw } = await import("../src/providers/render.js");
    delete process.env.ALLOW_PRIVATE_URLS;
    await expect(fetchRaw(`${base}/bad`, { refresh: true })).rejects.toThrow(/private or loopback/);
    process.env.ALLOW_PRIVATE_URLS = "true";
  });
});

describe("extractSeo hardening", () => {
  it("counts words across adjacent blocks", () => {
    const n = extractSeo("<body><p>one two</p><p>three four</p><div>five</div><ul><li>six</li><li>seven</li><li>eight</li></ul></body>", U);
    expect(n.wordCount).toBe(8);
  });
  it("resolves relative canonical and hreflang against the page URL", () => {
    const a = extractSeo('<link rel="canonical" href="/p/"><link rel="alternate" hreflang="es" href="/es/p/">', "https://example.com/p/");
    const b = extractSeo('<link rel="canonical" href="https://example.com/p/">', "https://example.com/p/");
    expect(a.canonical).toBe("https://example.com/p/");
    expect(a.hreflang).toEqual([{ lang: "es", href: "https://example.com/es/p/" }]);
    expect(compareRender(a, b)).toEqual([]);
  });
  it("treats reordered or re-spaced robots directives as equal", () => {
    const a = extractSeo('<meta name="robots" content="index,follow">', U);
    const b = extractSeo('<meta name="robots" content="Follow, INDEX">', U);
    expect(compareRender(a, b)).toEqual([]);
  });
  it("applies the content-js-dependent floor and skips it for truncated raw", () => {
    const words = (n: number) => `<body><p>${"word ".repeat(n)}</p></body>`;
    const small = compareRender(extractSeo("<body></body>", U), extractSeo(words(20), U));
    expect(small.map((f) => f.rule)).not.toContain("content-js-dependent");
    const big = (o = {}) => compareRender(extractSeo(words(5), U), extractSeo(words(80), U), o).map((f) => f.rule);
    expect(big()).toContain("content-js-dependent");
    expect(big({ rawTruncated: true })).not.toContain("content-js-dependent");
  });
  it("caps the total tag count", () => {
    expect(() => extractSeo("<br>".repeat(250_000), U)).toThrow(/tags/);
    expect(() => assertParseable("<a ".repeat(100_000))).not.toThrow();
  });
  it("parses valid HTML with many omitted end tags", () => {
    expect(extractSeo("<body><ul>" + "<li>item ".repeat(1100) + "</ul></body>", U).wordCount).toBe(1100);
    expect(extractSeo("<body>" + "<p>x ".repeat(1100) + "</body>", U).wordCount).toBe(1100);
  });
  it("does not count void tags toward depth", () => {
    expect(() => extractSeo("<br>".repeat(3000) + "<img src=x>".repeat(3000), U)).not.toThrow();
  });
});

describe("extractIsolated", () => {
  it("returns the same result as extractSeo", async () => {
    const html = fx("ssr.raw");
    expect(await extractIsolated(html, U)).toEqual(extractSeo(html, U));
  }, 30_000);
  it("queues calls beyond the worker limit and still completes them all", async () => {
    const html = fx("ssr.raw");
    const results = await Promise.all(Array.from({ length: MAX_EXTRACT_WORKERS * 2 }, () => extractIsolated(html, U)));
    for (const r of results) expect(r).toEqual(extractSeo(html, U));
  }, 60_000);
  it("propagates the tag-count error", async () => {
    await expect(extractIsolated("<br>".repeat(250_000), U)).rejects.toThrow(/tags/);
  }, 30_000);
  it("times out on a payload that hangs the parser, without blocking the event loop", async () => {
    // The abrupt comment "<!-->" hides the divs from any tag scan, but parse5 still nests 100k levels (tens of seconds unbounded).
    const payload = "<!-->" + "<div>".repeat(100_000) + "-->";
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    const t0 = Date.now();
    try {
      await expect(extractIsolated(payload, U, { timeoutMs: 1500 })).rejects.toThrow(/timed out/);
    } finally {
      clearInterval(timer);
    }
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(ticks).toBeGreaterThan(10);
  }, 30_000);
});

describe("chrome sandbox flag", () => {
  it("is off by default and on for Linux root or CHROME_NO_SANDBOX", () => {
    expect(needsNoSandbox({}, "darwin", 501)).toBe(false);
    expect(needsNoSandbox({}, "linux", 1000)).toBe(false);
    expect(needsNoSandbox({}, "linux", 0)).toBe(true);
    expect(needsNoSandbox({ CHROME_NO_SANDBOX: "true" }, "darwin", 501)).toBe(true);
  });
});

describe("fetchRendered request guard", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/start") return void res.writeHead(302, { location: "/internal" }).end();
      if (req.url === "/internal") return void res.writeHead(200, { "content-type": "text/html" }).end("<title>secret</title>");
      if (req.url === "/huge")
        return void res.writeHead(200, { "content-type": "text/html" }).end("<body><script>document.body.append(document.createTextNode('x'.repeat(6*1024*1024)))</script></body>");
      res.writeHead(200, { "content-type": "text/html" }).end("<title>ok</title><body>fine</body>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    delete process.env.ALLOW_PRIVATE_URLS;
    await new Promise((r) => server.close(r));
  });

  it("aborts redirects to a blocked address (default guard, private URLs not allowed)", async () => {
    const puppeteer = (await import("puppeteer")).default;
    const { chromePath, CHROME_FLAGS, guardPage } = await import("../src/providers/browser.js");
    delete process.env.ALLOW_PRIVATE_URLS;
    const browser = await puppeteer.launch({ executablePath: await chromePath(), args: CHROME_FLAGS });
    try {
      const page = await browser.newPage();
      await guardPage(page);
      await expect(page.goto(`${base}/start`)).rejects.toThrow(/BLOCKED_BY_CLIENT/);
      // A custom check that only blocks /internal lets other loopback pages and the redirect's first hop through.
      const page2 = await browser.newPage();
      await guardPage(page2, (u) => {
        if (u.endsWith("/internal")) throw new Error("blocked");
      });
      await expect(page2.goto(`${base}/start`)).rejects.toThrow(/BLOCKED_BY_CLIENT/);
      const page3 = await browser.newPage();
      await guardPage(page3, (u) => {
        if (u.endsWith("/internal")) throw new Error("blocked");
      });
      await page3.goto(`${base}/ok`);
      expect(await page3.title()).toBe("ok");
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("refuses an oversized rendered DOM", async () => {
    const { fetchRendered } = await import("../src/providers/render.js");
    process.env.ALLOW_PRIVATE_URLS = "true";
    await expect(fetchRendered(`${base}/huge`, { refresh: true })).rejects.toThrow(/over the .* cap/);
    const ok = await fetchRendered(`${base}/ok`, { refresh: true });
    expect(ok.html).toContain("fine");
  }, 60_000);
});
