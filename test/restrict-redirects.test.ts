/**
 * SEC-2: RESTRICT_TO_CLIENT_DOMAINS also covers where a browser-based check ends up after redirects: rendered fetches
 * (and so render_check and site hygiene), axe and Lighthouse's final URL, and render_check's raw fetch. Stubbed
 * browser and registry; the raw fetch talks to a local server. No network.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UrlRefusedError } from "../src/lib/url-guard.js";

let landed = "https://example.com/";
let chain: string[] = [];
vi.mock("lighthouse", () => ({ default: vi.fn(async () => ({ lhr: { finalDisplayedUrl: landed, audits: {}, categories: {} } })) }));
vi.mock("chrome-launcher", () => ({ launch: vi.fn() }));
vi.mock("../src/providers/browser.js", () => ({
  lighthouseLaunchOptions: async () => ({}),
  withChrome: async (_w: string, _s: unknown, _launch: unknown, _kill: unknown, fn: (c: unknown) => Promise<unknown>) => fn({ port: 1 }),
  assertNotProxyBlocked: () => undefined,
  guardPage: async () => undefined,
  withBrowser: async (_what: string, _signal: unknown, fn: (b: unknown) => Promise<unknown>) =>
    fn({
      newPage: async () => ({
        setDefaultNavigationTimeout: () => undefined,
        setUserAgent: async () => undefined,
        setViewport: async () => undefined,
        goto: async () => ({ status: () => 200, request: () => ({ redirectChain: () => chain.map((u) => ({ url: () => u })) }) }),
        content: async () => "<html><title>t</title><body>hi</body></html>",
        url: () => landed,
      }),
    }),
}));
vi.mock("../src/clients.js", () => ({ loadRegistry: async () => ({ clients: [{ domain: "example.com" }, { domain: "127.0.0.1" }] }) }));
vi.mock("@axe-core/puppeteer", () => ({ AxePuppeteer: class { withTags() { return this; } async analyze() { return { violations: [], incomplete: [], passes: [] }; } } }));

const { fetchRendered, checkRender } = await import("../src/providers/render.js");
const { runAxe } = await import("../src/providers/axe.js");
const { runLighthouse } = await import("../src/providers/lighthouse.js");

let n = 0;
const fresh = () => `https://example.com/p${++n}`;

describe("browser checks under RESTRICT_TO_CLIENT_DOMAINS", () => {
  beforeEach(() => {
    process.env.ALLOW_PRIVATE_URLS = "true";
    process.env.RESTRICT_TO_CLIENT_DOMAINS = "true";
    landed = "https://example.com/final";
    chain = [];
  });
  afterAll(() => {
    delete process.env.RESTRICT_TO_CLIENT_DOMAINS;
    delete process.env.ALLOW_PRIVATE_URLS;
  });

  it("fetchRendered refuses a page that ended on another domain, and one that hopped through it", async () => {
    landed = "https://other.example.org/";
    await expect(fetchRendered(fresh(), { refresh: true })).rejects.toBeInstanceOf(UrlRefusedError);
    landed = "https://www.example.com/final";
    chain = ["https://elsewhere.example.net/hop"];
    await expect(fetchRendered(fresh(), { refresh: true })).rejects.toThrow(/Refusing a redirect to elsewhere\.example\.net/);
  });

  it("fetchRendered allows the client's own domains and subdomains", async () => {
    landed = "https://blog.example.com/final";
    chain = ["https://example.com/old"];
    await expect(fetchRendered(fresh(), { refresh: true })).resolves.toMatchObject({ finalUrl: "https://blog.example.com/final" });
  });

  it("does not reuse a cached rendered answer that ended off the client's domains", async () => {
    const url = fresh();
    delete process.env.RESTRICT_TO_CLIENT_DOMAINS;
    landed = "https://other.example.org/";
    await fetchRendered(url, { refresh: true });
    process.env.RESTRICT_TO_CLIENT_DOMAINS = "true";
    await expect(fetchRendered(url)).rejects.toBeInstanceOf(UrlRefusedError);
  });

  it("axe refuses a redirect off the client's domains", async () => {
    landed = "https://other.example.org/";
    await expect(runAxe(fresh(), "AA", { refresh: true })).rejects.toBeInstanceOf(UrlRefusedError);
    landed = "https://example.com/final";
    await expect(runAxe(fresh(), "AA", { refresh: true })).resolves.toMatchObject({ level: "AA" });
  });

  it("cached axe and Lighthouse results that ended off the client's domains are not served once the restriction is on", async () => {
    delete process.env.RESTRICT_TO_CLIENT_DOMAINS;
    landed = "https://other.example.org/";
    const a = fresh();
    const l = fresh();
    await runAxe(a, "AA", { refresh: true });
    await runLighthouse(l, "mobile", { refresh: true });
    process.env.RESTRICT_TO_CLIENT_DOMAINS = "true";
    await expect(runAxe(a, "AA")).rejects.toBeInstanceOf(UrlRefusedError);
    await expect(runLighthouse(l, "mobile")).rejects.toBeInstanceOf(UrlRefusedError);
    // The cached finalUrl is internal: results do not carry it.
    delete process.env.RESTRICT_TO_CLIENT_DOMAINS;
    expect(await runAxe(a, "AA")).not.toHaveProperty("finalUrl");
    expect(await runLighthouse(l, "mobile")).not.toHaveProperty("finalUrl");
  });

  it("nothing is refused when the restriction is off", async () => {
    delete process.env.RESTRICT_TO_CLIENT_DOMAINS;
    landed = "https://other.example.org/";
    await expect(fetchRendered(fresh(), { refresh: true })).resolves.toBeDefined();
  });
});

describe("render_check's raw fetch", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/away") return void res.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/landing` }).end();
      res.writeHead(200, { "content-type": "text/html" }).end("<html><title>t</title><body>hi</body></html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("refuses a redirect off the client's domains when the restriction is on", async () => {
    process.env.ALLOW_PRIVATE_URLS = "true";
    process.env.RESTRICT_TO_CLIENT_DOMAINS = "true";
    landed = base;
    await expect(checkRender(`${base}/away`, { refresh: true })).rejects.toBeInstanceOf(UrlRefusedError);
    delete process.env.RESTRICT_TO_CLIENT_DOMAINS;
    delete process.env.ALLOW_PRIVATE_URLS;
  });
});
