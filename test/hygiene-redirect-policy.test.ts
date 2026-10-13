/**
 * Redirect policy for hygiene fetches (SEC-1): fetchRaw's allowUrl checks the URL and every redirect hop and
 * never reuses a cached redirect it didn't check; sampled llms.txt links stay on llms.txt's host; with
 * RESTRICT_TO_CLIENT_DOMAINS every hygiene fetch stays on the client's domain. Local servers only:
 * "localhost" and "127.0.0.1" are two hosts here.
 */
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), "crawlmark-redirect-policy-"));

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "../src/config.js";
import { fetchRaw } from "../src/providers/render.js";
import { siteHygiene } from "../src/reports/site-hygiene.js";

let site: Server;
let other: Server;
let base = "";
let otherBase = "";
let otherHits = 0;

beforeAll(async () => {
  process.env.ALLOW_PRIVATE_URLS = "true";
  other = createServer((_req, res) => {
    otherHits++;
    res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>elsewhere</title>");
  });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  otherBase = `http://localhost:${(other.address() as AddressInfo).port}`;
  site = createServer((req, res) => {
    const url = req.url ?? "/";
    const send = (status: number, type: string, body: string) => res.writeHead(status, { "content-type": type }).end(body);
    if (url === "/robots.txt") return send(200, "text/plain", "User-agent: *\nDisallow:\n");
    if (url === "/llms.txt") return send(200, "text/plain", "# T\n## Docs\n- [ok](/ok)\n- [away](/away)\n");
    if (url === "/away" || url === "/hop") return void res.writeHead(302, { location: `${otherBase}/x` }).end();
    return send(200, "text/html", "<!doctype html><title>t</title>");
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
afterAll(() => {
  delete process.env.ALLOW_PRIVATE_URLS;
  site.close();
  other.close();
});
afterEach(() => {
  delete process.env.RESTRICT_TO_CLIENT_DOMAINS;
});

const client = (keyPages: string[] = []) => ({ slug: "127.0.0.1", domain: "127.0.0.1", keyPages }) as unknown as Client;
const onSite = (u: string) => new URL(u).hostname === "127.0.0.1";

describe("fetchRaw allowUrl", () => {
  it("refuses the URL itself and any redirect hop the policy refuses; no policy keeps the old behaviour", async () => {
    await expect(fetchRaw(`${otherBase}/x`, { refresh: true, allowUrl: onSite })).rejects.toMatchObject({ name: "UrlRefusedError" });
    const before = otherHits;
    await expect(fetchRaw(`${base}/hop`, { refresh: true, allowUrl: onSite })).rejects.toThrow(/Refusing a redirect to localhost/);
    expect(otherHits).toBe(before);
    expect(await fetchRaw(`${base}/hop`, { refresh: true })).toMatchObject({ status: 200, redirects: 1, finalUrl: `${otherBase}/x` });
  });

  it("does not reuse a cached redirect that wasn't checked against the policy", async () => {
    // Cached without a policy (the previous test), so the cache now holds an off-host redirect for /hop.
    await expect(fetchRaw(`${base}/hop`, { allowUrl: onSite })).rejects.toMatchObject({ name: "UrlRefusedError" });
    // A cached single-hop response on an allowed URL is still served from the cache.
    await fetchRaw(`${base}/plain`, { refresh: true });
    const hits = otherHits;
    expect(await fetchRaw(`${base}/plain`, { allowUrl: onSite })).toMatchObject({ status: 200, redirects: 0 });
    expect(otherHits).toBe(hits);
  });
});

describe("hygiene redirect policy", () => {
  it("never follows a sampled llms.txt link that redirects to another host", async () => {
    const before = otherHits;
    const r = await siteHygiene(client(), { origin: base, gscSitemapPaths: [], fresh: true });
    expect(otherHits).toBe(before);
    const links = (r.llmsTxt as { links: { sampled: { url: string }[]; errors: { url: string; error: string }[] } }).links;
    expect(links.sampled.map((s) => s.url)).toEqual([`${base}/ok`]);
    expect(links.errors).toEqual([{ url: `${base}/away`, error: expect.stringMatching(/Refusing a redirect to localhost/) }]);
    // Not fetched means not checked: no broken-link finding and no check key for it.
    expect(r.flags.some((f) => f.rule === "llms-txt-broken-link")).toBe(false);
    expect(r.checked).not.toContain(`site:llms-txt-link ${base}/away`);
  });

  it("with RESTRICT_TO_CLIENT_DOMAINS a key page that redirects off the client is refused", async () => {
    process.env.RESTRICT_TO_CLIENT_DOMAINS = "true";
    const before = otherHits;
    const r = await siteHygiene(client([`${base}/hop`]), { origin: base, gscSitemapPaths: [], fresh: true });
    expect(otherHits).toBe(before);
    expect(r.structuredData).toMatchObject({ errors: [{ url: `${base}/hop`, error: expect.stringMatching(/Refusing a redirect to localhost/) }] });
    expect(r.checked.some((k) => k.includes("/hop"))).toBe(false);
  });

  it("skips llms.txt when robots.txt redirected off the client's domain", async () => {
    const r = await siteHygiene({ slug: "example.com", domain: "example.com", keyPages: [] } as unknown as Client, { origin: base, gscSitemapPaths: [], fresh: true });
    expect(r.llmsTxt).toEqual({ error: expect.stringMatching(/^not checked: robots.txt redirected to 127\.0\.0\.1:\d+, which isn't on example\.com$/) });
    expect(r.checked).not.toContain("site:llms-txt");
  });
});
