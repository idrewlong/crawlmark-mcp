import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), "crawlmark-hreflang-"));

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "../src/config.js";
import { diffAudits, type StoredAudit } from "../src/analysis/diff.js";
import { checkedPairs, extractFindings } from "../src/analysis/findings.js";
import type { AuditResult } from "../src/reports/audit.js";
import { checkHreflang, mergeHreflang, parseLinkHeader } from "../src/analysis/hreflang.js";
import { parseSitemapXml } from "../src/analysis/hygiene-parse.js";
import { siteHygiene } from "../src/reports/site-hygiene.js";

const e = (lang: string, href: string) => ({ lang, href });

describe("parseLinkHeader", () => {
  const base = "https://example.com/en/";
  it("reads several comma-separated values, quoted and bare params", () => {
    const h = '<https://example.com/fr/>; rel="alternate"; hreflang="fr", <https://example.org/de/>; rel=alternate; hreflang=DE-AT, </x>; rel="alternate"; hreflang="x-default"';
    expect(parseLinkHeader(h, base)).toEqual([e("fr", "https://example.com/fr/"), e("de-at", "https://example.org/de/"), e("x-default", "https://example.com/x")]);
  });
  it("accepts rel with several tokens and params in any order, and commas inside quotes or URLs", () => {
    expect(parseLinkHeader('<https://example.com/a,b>; hreflang="es"; rel="alternate nofollow"', base)).toEqual([e("es", "https://example.com/a,b")]);
  });
  it("skips non-alternate, missing hreflang and malformed values without throwing", () => {
    const h = '<https://example.com/c>; rel="canonical", <https://example.com/n>; rel="alternate", garbage, <http://[bad>; rel=alternate; hreflang=fr, ; , <https://example.com/ok>; rel="alternate"; hreflang="it"';
    expect(parseLinkHeader(h, base)).toEqual([e("it", "https://example.com/ok")]);
    expect(parseLinkHeader(null, base)).toEqual([]);
    expect(parseLinkHeader("", base)).toEqual([]);
    expect(parseLinkHeader('<https://example.com/q; rel="alternate"; hreflang="fr"', base)).toEqual([]);
  });
});

describe("sitemap xhtml:link", () => {
  it("reads namespaced alternates per url, ignoring other elements", () => {
    const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
<url><loc>https://example.com/en/</loc>
<xhtml:link rel="alternate" hreflang="en" href="https://example.com/en/"/>
<xhtml:link rel="alternate" hreflang="FR" href="https://example.com/fr/"/>
<xhtml:link rel="alternate" hreflang="de" href="/de/"/>
<xhtml:link rel="stylesheet" hreflang="xx" href="https://example.com/s"/>
<xhtml:link rel="alternate" href="https://example.com/nolang"/>
</url>
<url><loc>https://example.com/plain/</loc></url>
<url><loc>https://example.com/x/</loc><foo:link xmlns:foo="urn:x" rel="alternate" hreflang="it" href="https://example.com/it/"/></url>
</urlset>`;
    const p = parseSitemapXml(xml);
    expect(p.locs).toHaveLength(3);
    expect(p.alternates["https://example.com/en/"]).toEqual([e("en", "https://example.com/en/"), e("fr", "https://example.com/fr/"), e("de", "https://example.com/de/")]);
    expect(p.alternates["https://example.com/plain/"]).toBeUndefined();
  });
});

describe("sitemap xhtml namespace", () => {
  const xhtml = "http://www.w3.org/1999/xhtml";
  it("accepts a default xmlns on the link element and any prefix bound to the XHTML namespace", () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:h="${xhtml}">
<url><loc>https://example.com/a</loc><link xmlns="${xhtml}" rel="alternate" hreflang="fr" href="https://example.com/fr"/><h:link rel="alternate" hreflang="de" href="https://example.com/de"/></url></urlset>`;
    expect(parseSitemapXml(xml).alternates["https://example.com/a"]).toEqual([e("fr", "https://example.com/fr"), e("de", "https://example.com/de")]);
  });
  it("rejects look-alikes in another namespace, a plain link in the sitemap namespace, or an unbound prefix", () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:x="urn:other">
<url><loc>https://example.com/a</loc><x:link rel="alternate" hreflang="fr" href="https://example.com/fr"/><link rel="alternate" hreflang="de" href="https://example.com/de"/><nope:link rel="alternate" hreflang="it" href="https://example.com/it"/></url></urlset>`;
    expect(parseSitemapXml(xml).alternates).toEqual({});
  });
});

describe("mergeHreflang", () => {
  it("dedupes by lang and normalized URL and records every source", () => {
    const { entries, conflicts } = mergeHreflang([
      { source: "html", entries: [e("fr", "https://example.com/fr"), e("en", "https://example.com/")] },
      { source: "sitemap", entries: [e("fr", "https://example.com/fr/"), e("de", "https://example.com/de")] },
      { source: "header", entries: [e("fr", "https://example.com/fr")] },
    ]);
    expect(conflicts).toEqual([]);
    expect(entries.map((x) => [x.lang, x.sources])).toEqual([
      ["fr", ["html", "sitemap", "header"]],
      ["en", ["html"]],
      ["de", ["sitemap"]],
    ]);
  });
  it("flags the same hreflang pointing at different URLs across sources, not within one", () => {
    const { conflicts } = mergeHreflang([
      { source: "html", entries: [e("fr", "https://example.com/fr"), e("fr", "https://example.com/fr-2")] },
    ]);
    expect(conflicts).toEqual([]);
    const m = mergeHreflang([
      { source: "html", entries: [e("fr", "https://example.com/fr")] },
      { source: "header", entries: [e("fr", "https://example.org/fr"), e("en", "https://example.com/")] },
    ]);
    expect(m.conflicts).toEqual([{ lang: "fr", bySource: { html: ["https://example.com/fr"], header: ["https://example.org/fr"] } }]);
    expect(m.entries).toHaveLength(3);
  });
  it("turns conflicts into a hreflang-conflict issue", () => {
    const m = mergeHreflang([
      { source: "html", entries: [e("en", "https://example.com/"), e("fr", "https://example.com/fr")] },
      { source: "sitemap", entries: [e("fr", "https://example.com/fr-ca")] },
    ]);
    const issues = checkHreflang(["https://example.com/"], m.entries, new Map(), m.conflicts);
    const c = issues.find((i) => i.rule === "hreflang-conflict")!;
    expect(c.evidence).toContain("fr: html https://example.com/fr vs sitemap https://example.com/fr-ca");
  });
  it("reciprocity can be satisfied by any source on the alternate page", () => {
    const own = [e("en", "https://example.com/"), e("fr", "https://example.com/fr"), e("x-default", "https://example.com/")];
    const fr = [e("en", "https://example.com/")]; // e.g. the alternate's sitemap or header entry
    expect(checkHreflang(["https://example.com/"], own, new Map([["https://example.com/fr", fr]]))).toEqual([]);
    expect(checkHreflang(["https://example.com/"], own, new Map([["https://example.com/fr", []]])).map((i) => i.rule)).toEqual(["hreflang-not-reciprocal"]);
  });
});

describe("siteHygiene merges hreflang sources", () => {
  let server: Server;
  let base = "";
  const html = (head: string) => `<!doctype html><html><head><title>t</title>${head}</head><body><p>hi</p></body></html>`;
  beforeAll(async () => {
    process.env.ALLOW_PRIVATE_URLS = "true";
    server = createServer((req, res) => {
      const host = `http://${req.headers.host}`;
      const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) => res.writeHead(status, { "content-type": type, ...headers }).end(body);
      const alt = (lang: string, path: string) => `<xhtml:link rel="alternate" hreflang="${lang}" href="${host}${path}"/>`;
      switch (req.url) {
        case "/sitemap.xml":
          return send(
            200,
            "application/xml",
            `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
<url><loc>${host}/</loc>${alt("en", "/")}${alt("de", "/de")}${alt("x-default", "/")}</url>
<url><loc>${host}/de</loc>${alt("de", "/de")}${alt("en", "/")}</url></urlset>`,
          );
        case "/":
          return send(200, "text/html", html(`<link rel="alternate" hreflang="en" href="${host}/"><link rel="alternate" hreflang="fr" href="${host}/fr">`), {
            link: `<${host}/es>; rel="alternate"; hreflang="es", <${host}/fr-other>; rel="alternate"; hreflang="fr"`,
          });
        case "/fr":
          return send(200, "text/html", html(`<link rel="alternate" hreflang="fr" href="${host}/fr"><link rel="alternate" hreflang="en" href="${host}/">`));
        case "/de": // no HTML tags: points back only through the sitemap
          return send(200, "text/html", html(""));
        case "/es": // reciprocates through a Link header only
          return send(200, "text/html", html(""), { link: `<${host}/>; rel="alternate"; hreflang="en", <${host}/es>; rel="alternate"; hreflang="es"` });
        default:
          return send(404, "text/plain", "nope");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    delete process.env.ALLOW_PRIVATE_URLS;
    server.close();
  });

  it("finds sitemap and header alternates, accepts cross-source reciprocity, flags the conflict", async () => {
    const client = { slug: "127.0.0.1", domain: "127.0.0.1", keyPages: [`${base}/`] } as unknown as Client;
    const r = await siteHygiene(client, { origin: base, gscSitemapPaths: [] });
    const hl = r.flags.filter((f) => f.rule.startsWith("hreflang-")).map((f) => f.rule).sort();
    // fr: html /fr vs header /fr-other conflicts; /fr-other is a 404 (not judged); de and es reciprocate via sitemap / header; x-default comes from the sitemap.
    expect(hl).toEqual(["hreflang-conflict"]);
    expect(r.hreflang).toMatchObject({ pages: [{ alternates: 6, sources: { html: 2, sitemap: 3, header: 2 } }] });
    // /fr-other could not be read, so the page is not recorded as fully checked.
    expect(r.checked).not.toContain(`site:hreflang ${base}`);
  });
});

describe("sitemap hreflang cap", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    process.env.ALLOW_PRIVATE_URLS = "true";
    server = createServer((req, res) => {
      const host = `http://${req.headers.host}`;
      const send = (status: number, type: string, body: string) => res.writeHead(status, { "content-type": type }).end(body);
      const alt = (lang: string, path: string) => `<xhtml:link rel="alternate" hreflang="${lang}" href="${host}${path}"/>`;
      if (req.url === "/sitemap.xml")
        return send(200, "application/xml", `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml"><url><loc>${host}/</loc>${alt("en", "/")}${alt("fr", "/fr")}${alt("de", "/de")}</url></urlset>`);
      if (req.url === "/" || req.url === "/fr" || req.url === "/de") return send(200, "text/html", "<!doctype html><title>t</title><p>hi</p>");
      return send(404, "text/plain", "nope");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    delete process.env.ALLOW_PRIVATE_URLS;
    server.close();
  });

  it("keeps at most the cap, says so, and does not record hreflang as checked", async () => {
    const client = { slug: "127.0.0.1", domain: "127.0.0.1", keyPages: [`${base}/`] } as unknown as Client;
    const capped = await siteHygiene(client, { origin: base, gscSitemapPaths: [], sitemapHreflangLimit: 2 });
    expect(capped.hreflang).toMatchObject({ pages: [{ alternates: 2 }] });
    expect(capped.notes.join(" ")).toContain("capped at 2");
    expect(capped.checked).not.toContain(`site:hreflang ${base}`);
    const full = await siteHygiene(client, { origin: base, gscSitemapPaths: [] });
    expect(full.hreflang).toMatchObject({ pages: [{ alternates: 3 }] });
    expect(full.checked).toContain(`site:hreflang ${base}`);
  });
});

describe("a failing sitemap leaves sitemap-dependent hreflang findings unverified", () => {
  let server: Server;
  let base = "";
  let sitemapDown = false;
  let staleListed = false;
  beforeAll(async () => {
    process.env.ALLOW_PRIVATE_URLS = "true";
    server = createServer((req, res) => {
      const host = `http://${req.headers.host}`;
      const send = (status: number, type: string, body: string) => res.writeHead(status, { "content-type": type }).end(body);
      const page = (head: string) => `<!doctype html><title>t</title>${head}<p>hi</p>`;
      switch (req.url) {
        case "/robots.txt":
          return send(200, "text/plain", `Sitemap: ${host}/sitemap.xml\n${staleListed ? `Sitemap: ${host}/old-sitemap.xml\n` : ""}`);
        case "/sitemap.xml":
          return sitemapDown
            ? send(503, "text/plain", "down")
            : send(200, "application/xml", `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml"><url><loc>${host}/</loc><xhtml:link rel="alternate" hreflang="fr" href="${host}/fr-ca"/></url></urlset>`);
        case "/":
          return send(200, "text/html", page(`<link rel="alternate" hreflang="en" href="${host}/"><link rel="alternate" hreflang="fr" href="${host}/fr">`));
        case "/fr":
        case "/fr-ca":
          return send(200, "text/html", page(`<link rel="alternate" hreflang="en" href="${host}/">`));
        default:
          return send(404, "text/plain", "nope");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    delete process.env.ALLOW_PRIVATE_URLS;
    server.close();
  });

  const stored = (id: string, ranAt: number, hygiene: unknown): StoredAudit => {
    const a = { client: { slug: "x" }, settings: {}, summary: {}, pages: [], site: { sitemaps: { ok: false, error: "x" }, crawl: null, backlinks: null, hygiene: { ok: true, data: hygiene } } } as unknown as AuditResult;
    return { id, client: "x", ranAt, settings: {}, summary: {}, findings: extractFindings(a), checked: checkedPairs(a), result: a };
  };

  it("reports the old conflict as unverified, not resolved, when the sitemap fails next time", async () => {
    const client = { slug: "127.0.0.1", domain: "127.0.0.1", keyPages: [`${base}/`] } as unknown as Client;
    const run1 = await siteHygiene(client, { origin: base, gscSitemapPaths: [] });
    expect(run1.flags.map((f) => f.rule)).toContain("hreflang-conflict");
    expect(run1.checked).toContain(`site:hreflang ${base}`);

    sitemapDown = true;
    const run2 = await siteHygiene(client, { origin: base, gscSitemapPaths: [] });
    expect(run2.flags.map((f) => f.rule)).not.toContain("hreflang-conflict");
    expect(run2.checked).not.toContain(`site:hreflang ${base}`);
    expect(run2.notes.join(" ")).toContain("A sitemap could not be read");

    const d = diffAudits(stored("a", 1, run1), stored("b", 2, run2));
    expect(d.resolved.map((f) => f.rule)).not.toContain("hreflang-conflict");
    expect(d.unverified.map((f) => f.rule)).toContain("hreflang-conflict");
  });

  it("still records hreflang as checked when a listed sitemap no longer exists (404)", async () => {
    sitemapDown = false;
    staleListed = true;
    const client = { slug: "127.0.0.1", domain: "127.0.0.1", keyPages: [`${base}/`] } as unknown as Client;
    const run = await siteHygiene(client, { origin: base, gscSitemapPaths: [] });
    expect(run.checked).toContain(`site:hreflang ${base}`);
    expect(run.notes.join(" ")).not.toContain("A sitemap could not be read");
    staleListed = false;
  });
});
