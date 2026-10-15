import { createServer, request, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import type { LookupAddress } from "node:dns";
import { existsSync } from "node:fs";
import puppeteerForPaths from "puppeteer";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Browser } from "puppeteer";

// Under a loaded machine (load average ~25) spawning tsx or launching Chrome can take tens of seconds.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import {
  assertOnClientDomain,
  assertSafeUrlResolved,
  hostInDomains,
  isPrivateHost,
  restrictToClientDomains,
  type LookupFn,
} from "../src/lib/url-guard.js";
import { BLOCKED_HEADER, proxyChromeFlags, startEgressProxy, type EgressProxy } from "../src/lib/egress-proxy.js";
import { onAbort, TimeoutError, withTimeout } from "../src/lib/timeout.js";

// test/setup.ts points DATA_DIR at a temp dir, so the usage-log tests write to a throwaway SQLite file.

/**
 * Chrome binaries the browser-launching tests run against, one describe each. Full Chrome and chrome-headless-shell
 * enforce the WebRTC policy differently (see CHROME_PREFS), so both must be covered; a missing binary skips its variant.
 */
const chromeVariants: [name: string, path: string | undefined][] = await (async () => {
  const full = await puppeteerForPaths.executablePath();
  const shell = await puppeteerForPaths.executablePath({ headless: "shell" }).catch(() => "");
  return [
    ["full Chrome", existsSync(full) ? full : undefined],
    ["headless shell", shell && existsSync(shell) ? shell : undefined],
  ];
})();

/** describe() once per Chrome variant, with CHROME_PATH pointing at that binary for the block's duration. */
function describeEachChrome(title: string, body: () => void): void {
  for (const [name, path] of chromeVariants) {
    (path ? describe : describe.skip)(`${title} [${name}]`, () => {
      let saved: string | undefined;
      beforeAll(() => {
        saved = process.env.CHROME_PATH;
        process.env.CHROME_PATH = path!;
      });
      afterAll(() => {
        if (saved === undefined) delete process.env.CHROME_PATH;
        else process.env.CHROME_PATH = saved;
      });
      body();
    });
  }
}

const v4 = (address: string): LookupAddress => ({ address, family: 4 });
const v6 = (address: string): LookupAddress => ({ address, family: 6 });
/** Fake DNS: a fixed table, ENOTFOUND for anything else. */
const fakeDns =
  (table: Record<string, LookupAddress[]>): LookupFn =>
  async (host) => {
    const hit = table[host];
    if (!hit) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return hit;
  };

describe("DNS-resolving URL guard", () => {
  const lookup = fakeDns({
    "public.example": [v4("93.184.215.14"), v6("2606:2800:21f:cb07:6820:80da:af6b:8b2c")],
    "rebind.example": [v4("127.0.0.1")],
    "mixed.example": [v4("93.184.215.14"), v4("10.0.0.7")],
    "mixed6.example": [v4("93.184.215.14"), v6("fd00::1")],
    "metadata.example": [v4("169.254.169.254")],
    "siit.example": [v6("::ffff:0:a00:1")],
  });

  it("allows a hostname whose every address is public, and returns them", async () => {
    const { url, addresses } = await assertSafeUrlResolved("https://public.example/x", { env: {}, lookup });
    expect(url.hostname).toBe("public.example");
    expect(addresses).toHaveLength(2);
  });
  it("refuses a public-looking hostname that resolves to 127.0.0.1", async () => {
    const err = await assertSafeUrlResolved("https://rebind.example/", { env: {}, lookup }).catch((e: Error) => e);
    expect(err).toMatchObject({ name: "UrlRefusedError" });
    expect((err as Error).message).toMatch(/Refusing rebind\.example: it does not resolve to a public address/);
    expect((err as Error).message).not.toContain("127.0.0.1");
  });
  it.each(["mixed.example", "mixed6.example", "metadata.example", "siit.example"])("refuses %s (any private address)", async (h) => {
    await expect(assertSafeUrlResolved(`http://${h}/`, { env: {}, lookup })).rejects.toMatchObject({ name: "UrlRefusedError" });
  });
  it("still refuses private literals and bad schemes before resolving", async () => {
    const never: LookupFn = async () => {
      throw new Error("should not resolve");
    };
    await expect(assertSafeUrlResolved("http://10.1.2.3/", { env: {}, lookup: never })).rejects.toThrow(/private or loopback/);
    await expect(assertSafeUrlResolved("file:///etc/passwd", { env: {}, lookup: never })).rejects.toThrow(/http and https/);
  });
  it("lets private resolutions through with ALLOW_PRIVATE_URLS=true", async () => {
    const r = await assertSafeUrlResolved("http://rebind.example/", { env: { ALLOW_PRIVATE_URLS: "true" }, lookup });
    expect(r.addresses[0]!.address).toBe("127.0.0.1");
  });
  it("gives unresolvable hosts the same message as private ones", async () => {
    const msg = (u: string) => assertSafeUrlResolved(u, { env: {}, lookup }).then(() => "allowed", (e: Error) => e.message);
    const a = await msg("http://nope.example/");
    const b = await msg("http://mixed.example/");
    expect(a.replace("nope.example", "H")).toBe(b.replace("mixed.example", "H"));
    expect(b).not.toContain("10.0.0.7");
  });
  it.each(["::ffff:0:7f00:1", "::ffff:0:808:808", "64:ff9b:1::1", "64:ff9b:1:ffff::808:808"])("treats SIIT / NAT64 local-use %s as private", (h) =>
    expect(isPrivateHost(h)).toBe(true),
  );
  it("keeps well-known NAT64 of a public address public", () => expect(isPrivateHost("64:ff9b::808:808")).toBe(false));
});

describe("RESTRICT_TO_CLIENT_DOMAINS", () => {
  it("parses true/false and fails closed on junk", () => {
    expect(restrictToClientDomains({})).toBe(false);
    expect(restrictToClientDomains({ RESTRICT_TO_CLIENT_DOMAINS: "false" })).toBe(false);
    expect(restrictToClientDomains({ RESTRICT_TO_CLIENT_DOMAINS: "TRUE" })).toBe(true);
    expect(restrictToClientDomains({ RESTRICT_TO_CLIENT_DOMAINS: "1" })).toBe(true);
    expect(() => restrictToClientDomains({ RESTRICT_TO_CLIENT_DOMAINS: "ture" })).toThrow(/must be true or false/);
  });
  it("matches client domains and their subdomains only", () => {
    const domains = ["example.com", "exampleplumbing.com"];
    expect(hostInDomains("example.com", domains)).toBe(true);
    expect(hostInDomains("www.example.com", domains)).toBe(true);
    expect(hostInDomains("Blog.Example.com.", domains)).toBe(true);
    expect(hostInDomains("badexample.com", domains)).toBe(false);
    expect(hostInDomains("example.com.evil.test", domains)).toBe(false);
    expect(() => assertOnClientDomain("evil.test", domains)).toThrow(/not a client domain/);
    expect(() => assertOnClientDomain("shop.exampleplumbing.com", domains)).not.toThrow();
  });
});

// ------------------------------------------------------------------ proxy

/** A local server that counts every TCP connection it receives. */
async function countingServer(body = "target"): Promise<{ server: Server; port: number; hits: () => number; upgrades: () => number }> {
  let hits = 0;
  let upgrades = 0;
  const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/plain" }).end(body));
  server.on("connection", () => hits++);
  server.on("upgrade", (_req, socket) => {
    upgrades++;
    socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port, hits: () => hits, upgrades: () => upgrades };
}

/** Send raw bytes to the proxy and collect the reply until the socket closes or `until` matches. */
function rawExchange(port: number, payload: string, until?: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1", () => s.write(payload));
    let out = "";
    s.on("data", (d) => {
      out += d.toString("latin1");
      if (until?.test(out)) {
        s.destroy();
        resolve(out);
      }
    });
    s.on("close", () => resolve(out));
    s.on("error", reject);
    setTimeout(() => {
      s.destroy();
      resolve(out);
    }, 5000).unref();
  });
}

function proxiedGet(proxyPort: number, url: string): Promise<{ status: number; blocked: boolean; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request({ host: "127.0.0.1", port: proxyPort, path: url, headers: { host: u.host } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, blocked: res.headers[BLOCKED_HEADER] === "1", body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("egress proxy", () => {
  let target: Awaited<ReturnType<typeof countingServer>>;
  let proxy: EgressProxy;
  let allowPrivate = false;
  const lookup = fakeDns({ "public.example": [v4("127.0.0.1")], "elsewhere.example": [v4("93.184.215.14"), v4("127.0.0.1")] });

  beforeAll(async () => {
    target = await countingServer();
    proxy = await startEgressProxy({ lookup, allowPrivate: () => allowPrivate });
  });
  afterEach(() => {
    allowPrivate = false;
  });
  afterAll(async () => {
    await proxy.close();
    await new Promise((r) => target.server.close(r));
  });

  it("refuses CONNECT to a public-looking host that resolves privately", async () => {
    const before = target.hits();
    const reply = await rawExchange(proxy.port, `CONNECT public.example:${target.port} HTTP/1.1\r\nHost: public.example:${target.port}\r\n\r\n`);
    expect(reply).toMatch(/^HTTP\/1\.1 403/);
    expect(reply.toLowerCase()).toContain(BLOCKED_HEADER);
    expect(target.hits()).toBe(before);
  });
  it("refuses CONNECT when any resolved address is private", async () => {
    const reply = await rawExchange(proxy.port, `CONNECT elsewhere.example:443 HTTP/1.1\r\n\r\n`);
    expect(reply).toMatch(/^HTTP\/1\.1 403/);
  });
  it("refuses CONNECT to a private literal", async () => {
    const before = target.hits();
    const reply = await rawExchange(proxy.port, `CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\n\r\n`);
    expect(reply).toMatch(/^HTTP\/1\.1 403/);
    expect(target.hits()).toBe(before);
  });
  it("refuses plain HTTP to a private address", async () => {
    const before = target.hits();
    for (const url of [`http://127.0.0.1:${target.port}/x`, `http://public.example:${target.port}/x`, `http://localhost:${target.port}/x`]) {
      const res = await proxiedGet(proxy.port, url);
      expect(res.status).toBe(403);
      expect(res.blocked).toBe(true);
    }
    expect(target.hits()).toBe(before);
  });
  it("refuses a WebSocket upgrade to a private address, through CONNECT and as a proxied GET", async () => {
    const before = target.hits();
    // Chrome opens ws:// and wss:// with CONNECT, then sends the upgrade inside the tunnel.
    const upgrade = `GET /ws HTTP/1.1\r\nHost: public.example:${target.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`;
    const tunnel = await rawExchange(proxy.port, `CONNECT public.example:${target.port} HTTP/1.1\r\n\r\n${upgrade}`);
    expect(tunnel).toMatch(/^HTTP\/1\.1 403/);
    expect(tunnel).not.toContain("101 Switching");
    const direct = await rawExchange(
      proxy.port,
      `GET http://public.example:${target.port}/ws HTTP/1.1\r\nHost: public.example:${target.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
    );
    expect(direct).toMatch(/^HTTP\/1\.1 403/);
    expect(target.hits()).toBe(before);
    expect(target.upgrades()).toBe(0);
  });
  it("allows all of it with ALLOW_PRIVATE_URLS", async () => {
    allowPrivate = true;
    const res = await proxiedGet(proxy.port, `http://public.example:${target.port}/x`);
    expect(res).toMatchObject({ status: 200, blocked: false, body: "target" });
    const tunnel = await rawExchange(
      proxy.port,
      `CONNECT public.example:${target.port} HTTP/1.1\r\n\r\nGET /y HTTP/1.1\r\nHost: public.example\r\nConnection: close\r\n\r\n`,
      /\r\n0\r\n\r\n$/,
    );
    expect(tunnel).toMatch(/^HTTP\/1\.1 200 Connection Established/);
    expect(tunnel).toContain("\r\ntarget\r\n");
    const ws = await rawExchange(
      proxy.port,
      `CONNECT public.example:${target.port} HTTP/1.1\r\n\r\nGET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
      /101 Switching/,
    );
    expect(ws).toContain("101 Switching");
    expect(target.upgrades()).toBe(1);
  });
  it("defaults to ALLOW_PRIVATE_URLS from the env, read per connection", async () => {
    const p = await startEgressProxy({ lookup });
    try {
      delete process.env.ALLOW_PRIVATE_URLS;
      expect((await proxiedGet(p.port, `http://public.example:${target.port}/`)).status).toBe(403);
      process.env.ALLOW_PRIVATE_URLS = "true";
      expect((await proxiedGet(p.port, `http://public.example:${target.port}/`)).status).toBe(200);
    } finally {
      delete process.env.ALLOW_PRIVATE_URLS;
      await p.close();
    }
  });
});

describeEachChrome("headless Chrome behind the egress proxy", () => {
  let blocked: Awaited<ReturnType<typeof countingServer>>;
  let allowed: Server;
  let allowedPort = 0;
  let allowedHits = 0;

  beforeAll(async () => {
    blocked = await countingServer("blocked");
    allowed = createServer((req, res) => {
      allowedHits++;
      if (req.url === "/ping") return void res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }).end("pong");
      const B = `blocked.test:${blocked.port}`;
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>allowed</title><body>
<script>
  window.attempts = (async () => {
    const tries = [];
    tries.push(fetch("http://${B}/fetch").then(() => "ok", () => "err"));
    tries.push(fetch("http://127.0.0.1:${blocked.port}/literal").then(() => "ok", () => "err"));
    tries.push(new Promise((r) => { try { const w = new WebSocket("ws://${B}/ws"); w.onopen = () => r("ok"); w.onerror = () => r("err"); } catch { r("err"); } }));
    tries.push(new Promise((r) => { const i = new Image(); i.onload = () => r("ok"); i.onerror = () => r("err"); i.src = "http://${B}/img.png"; }));
    try { window.open("http://${B}/popup"); } catch {}
    tries.push(fetch("/ping").then((r) => r.text(), () => "err"));
    return Promise.all(tries);
  })();
</script></body>`);
    });
    await new Promise<void>((r) => allowed.listen(0, "127.0.0.1", r));
    allowedPort = (allowed.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((r) => allowed.close(r));
    await new Promise((r) => blocked.server.close(r));
  });

  /** Browsers still open: a test that timed out leaves its run() going, so they are killed after each test. */
  const open = new Set<Browser>();
  afterEach(() => {
    for (const b of open) b.process()?.kill("SIGKILL");
    open.clear();
  });

  /** Load the allowed page in Chrome behind a proxy and let it try to reach the blocked server. */
  async function run(allowPrivate: boolean): Promise<unknown[]> {
    const puppeteer = (await import("puppeteer")).default;
    const { resolveChrome, puppeteerBinaryOptions, CHROME_FLAGS } = await import("../src/providers/browser.js");
    // Both servers are on loopback, so the "allowed" host goes through a test-only allowlist hook.
    const proxy = await startEgressProxy({
      lookup: fakeDns({ "allowed.test": [v4("127.0.0.1")], "blocked.test": [v4("127.0.0.1")] }),
      allowPrivate: () => allowPrivate,
      allowHost: (host, port) => host === "allowed.test" && port === allowedPort,
    });
    let browser: Browser;
    try {
      // A launch that takes longer than 60 s fails (puppeteer kills that Chrome) instead of its 30 s default.
      browser = await puppeteer.launch({ ...puppeteerBinaryOptions(await resolveChrome()), args: [...CHROME_FLAGS, ...proxyChromeFlags(proxy.port)], timeout: 60_000 });
    } catch (err) {
      await proxy.close();
      throw err;
    }
    open.add(browser);
    try {
      const page = await browser.newPage();
      // Full Chrome on GitHub's Windows runners sometimes aborts the first navigation of a fresh profile
      // (net::ERR_ABORTED) before any request reaches the proxy. Retry that one error; the checks below are unchanged.
      for (let attempt = 1; ; attempt++) {
        try {
          await page.goto(`http://allowed.test:${allowedPort}/`, { waitUntil: "load" });
          break;
        } catch (err) {
          if (attempt >= 3 || !/net::ERR_ABORTED/.test(String(err))) throw err;
        }
      }
      expect(await page.title()).toBe("allowed");
      const results = (await page.evaluate("window.attempts")) as unknown[];
      await new Promise((r) => setTimeout(r, 1000)); // let the popup try to load
      return results;
    } finally {
      open.delete(browser);
      await browser.close().catch(() => browser.process()?.kill("SIGKILL"));
      await proxy.close();
    }
  }

  it("blocks fetch, WebSocket, window.open and images to a private host", async () => {
    const results = await run(false);
    // allowed.test only resolves inside the proxy, so a working /ping proves Chrome used it.
    expect(results.at(-1)).toBe("pong");
    expect(results.slice(0, 4)).toEqual(["err", "err", "err", "err"]);
    expect(blocked.hits()).toBe(0);
    expect(blocked.upgrades()).toBe(0);
  }, 120_000);

  it("control: the same page does reach that host when private addresses are allowed", async () => {
    const before = blocked.hits();
    const results = await run(true);
    expect(results.at(-1)).toBe("pong");
    expect(blocked.hits()).toBeGreaterThan(before);
    expect(allowedHits).toBeGreaterThan(0);
  }, 120_000);
});

// ------------------------------------------------------------------ timeouts

describe("withTimeout", () => {
  it("passes results and errors through", async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, "x")).resolves.toBe(7);
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "x")).rejects.toThrow("boom");
  });
  it("runs the cleanup and waits for it before rejecting with a TimeoutError", async () => {
    let closed = false;
    const never = new Promise<never>(() => undefined);
    const err = await withTimeout(never, 20, "slow thing", async () => {
      await new Promise((r) => setTimeout(r, 30));
      closed = true;
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toBe("slow thing timed out after 20ms");
    expect(closed).toBe(true);
  });
  it("still rejects when the cleanup throws", async () => {
    await expect(withTimeout(new Promise(() => undefined), 10, "x", () => {
      throw new Error("close failed");
    })).rejects.toBeInstanceOf(TimeoutError);
  });
  it("onAbort fires once, immediately if already aborted", () => {
    const c = new AbortController();
    let n = 0;
    const off = onAbort(c.signal, () => n++);
    c.abort();
    c.abort();
    off();
    onAbort(c.signal, () => n++);
    expect(n).toBe(2);
  });
});

describe("withChrome and the tool handler", () => {
  /** A fake browser whose work never finishes until it is closed. */
  const fakeBrowser = () => {
    const state = { closed: 0, reject: (_e: Error) => undefined as void };
    const work = () =>
      new Promise<string>((_, reject) => {
        state.reject = reject;
      });
    const close = () => {
      state.closed++;
      state.reject(new Error("Target closed"));
    };
    return { state, work, close };
  };

  it("closes the browser when the signal aborts", async () => {
    const { withChrome } = await import("../src/providers/browser.js");
    const fb = fakeBrowser();
    const ctrl = new AbortController();
    const p = withChrome("fake", ctrl.signal, async () => "browser", fb.close, fb.work);
    setTimeout(() => ctrl.abort(new TimeoutError("tool timed out")), 20);
    await expect(p).rejects.toThrow("tool timed out");
    expect(fb.state.closed).toBe(1);
  });
  it("closes the browser after success and after an error", async () => {
    const { withChrome } = await import("../src/providers/browser.js");
    let closed = 0;
    await expect(withChrome("ok", undefined, async () => 1, () => closed++, async () => "done")).resolves.toBe("done");
    await expect(withChrome("bad", undefined, async () => 1, () => closed++, async () => Promise.reject(new Error("nav failed")))).rejects.toThrow("nav failed");
    expect(closed).toBe(2);
  });
  it("does not launch when already aborted", async () => {
    const { withChrome } = await import("../src/providers/browser.js");
    let launched = 0;
    const c = new AbortController();
    c.abort(new Error("gone"));
    await expect(withChrome("x", c.signal, async () => launched++, () => undefined, async () => 1)).rejects.toThrow("gone");
    expect(launched).toBe(0);
  });
  it("a tool timeout aborts the work, closes the browser, returns a tool error and logs a TimeoutError row", async () => {
    const { handler } = await import("../src/tools/util.js");
    const { withChrome } = await import("../src/providers/browser.js");
    const { toolCallsSince } = await import("../src/lib/usage.js");
    const fb = fakeBrowser();
    const t0 = Date.now();
    const h = handler(
      "fake_browser_tool",
      (_args: { client: string }, { signal }) => withChrome("fake", signal, async () => "b", fb.close, fb.work),
      { timeoutMs: 30 },
    );
    const res = await h({ client: "https://www.Example.com/private/path?q=secret" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/fake_browser_tool timed out after/);
    expect(fb.state.closed).toBe(1);
    const row = toolCallsSince(t0).find((r) => r.tool === "fake_browser_tool");
    expect(row).toMatchObject({ ok: false, errorClass: "TimeoutError", client: "example.com" });
  });
});

describe("usage log", () => {
  it("writes one row per call and summarises counts, error rates and percentiles", async () => {
    const { handler } = await import("../src/tools/util.js");
    const { summarizeUsage, toolCallsSince } = await import("../src/lib/usage.js");
    const { UrlRefusedError } = await import("../src/lib/url-guard.js");
    const t0 = Date.now();
    const okTool = handler("usage_ok", async (_a: { client?: string }) => ({ fine: true }));
    const badTool = handler("usage_bad", async (_a: { url: string }) => {
      throw new UrlRefusedError("nope");
    });
    await okTool({ client: "example.com" });
    await okTool({});
    const bad = await badTool({ url: "http://10.0.0.1/secret" });
    expect(bad.isError).toBe(true);

    const rows = toolCallsSince(t0).filter((r) => r.tool.startsWith("usage_"));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.client)).toEqual(["example.com", null, null]);
    // Nothing but the client is stored: the URL argument appears nowhere.
    expect(JSON.stringify(rows)).not.toContain("10.0.0.1");
    const summary = summarizeUsage(rows);
    expect(summary.find((s) => s.tool === "usage_ok")).toMatchObject({ calls: 2, errors: 0, errorRate: 0 });
    expect(summary.find((s) => s.tool === "usage_bad")).toMatchObject({ calls: 1, errors: 1, errorRate: 1, errorClasses: { UrlRefusedError: 1 } });
  });
  it("computes nearest-rank p50/p95", async () => {
    const { summarizeUsage } = await import("../src/lib/usage.js");
    const rows = Array.from({ length: 20 }, (_, i) => ({ tool: "t", client: null, durationMs: (i + 1) * 10, ok: i !== 0, errorClass: i === 0 ? "Error" : null, ts: 0 }));
    expect(summarizeUsage(rows)[0]).toMatchObject({ calls: 20, errors: 1, errorRate: 0.05, p50Ms: 100, p95Ms: 190 });
  });
});

// ------------------------------------------------------- review fixes (SEC-1, SEC-2, CONNECT :80)

describe("CONNECT authority parsing", () => {
  it("keeps the default port 80 (and 443) instead of dropping it", async () => {
    const { parseAuthority } = await import("../src/lib/egress-proxy.js");
    expect(parseAuthority("example.com:80")).toEqual({ host: "example.com", port: 80 });
    expect(parseAuthority("example.com:443")).toEqual({ host: "example.com", port: 443 });
    expect(parseAuthority("[::1]:80")).toEqual({ host: "::1", port: 80 });
    expect(parseAuthority("Example.COM:8080")).toEqual({ host: "example.com", port: 8080 });
    for (const bad of ["example.com", "example.com:0", "example.com:65536", "a/b:80", "user@example.com:80", "", "example.com:80:80"]) {
      expect(parseAuthority(bad)).toBeNull();
    }
  });

  it("handles a ws:// upgrade on port 80 through CONNECT (refused when private, tunnelled when allowed)", async () => {
    let allow = false;
    const proxy = await startEgressProxy({ lookup: fakeDns({ "ws80.example": [v4("127.0.0.1")] }), allowPrivate: () => allow });
    // Binding port 80 needs privileges on some systems; when it can't, an allowed CONNECT must at least
    // get past parsing (502 from the failed dial rather than 400). Port 80 may also belong to another server
    // (IIS on GitHub's Windows runners): then the tunnel opens and that server answers instead.
    const ws80 = createServer();
    let upgrades = 0;
    ws80.on("upgrade", (_req, socket) => {
      upgrades++;
      socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    });
    const bound = await new Promise<boolean>((r) => {
      ws80.once("error", () => r(false));
      ws80.listen(80, "127.0.0.1", () => r(true));
    });
    const upgrade = "GET /ws HTTP/1.1\r\nHost: ws80.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n";
    try {
      const refused = await rawExchange(proxy.port, `CONNECT ws80.example:80 HTTP/1.1\r\n\r\n${upgrade}`);
      expect(refused).toMatch(/^HTTP\/1\.1 403/);
      allow = true;
      const reply = await rawExchange(proxy.port, `CONNECT ws80.example:80 HTTP/1.1\r\n\r\n${upgrade}`, /101 Switching|^HTTP\/1\.1 502|Established\r\n\r\nHTTP\/1\.1 \d{3} /);
      if (bound) {
        expect(reply).toMatch(/^HTTP\/1\.1 200 Connection Established/);
        expect(reply).toContain("101 Switching");
        expect(upgrades).toBe(1);
      } else {
        expect(reply).toMatch(/^HTTP\/1\.1 (502|200 Connection Established)/);
        expect(upgrades).toBe(0);
      }
    } finally {
      await proxy.close();
      if (bound) await new Promise((r) => ws80.close(r));
    }
  });
});

describe("egress proxy socket hygiene", () => {
  /** An upstream that accepts connections and never answers. */
  async function hungServer() {
    const open = new Set<import("node:net").Socket>();
    const server = createServer(() => undefined);
    server.on("connection", (s) => {
      open.add(s);
      s.on("close", () => open.delete(s));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { server, port: (server.address() as AddressInfo).port, open: () => open.size };
  }
  const waitFor = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return cond();
  };

  it("drops the upstream when the client closes mid-request (plain HTTP and CONNECT)", async () => {
    const hung = await hungServer();
    const proxy = await startEgressProxy({ lookup: fakeDns({ "hung.example": [v4("127.0.0.1")] }), allowPrivate: () => true });
    try {
      for (const payload of [
        `GET http://hung.example:${hung.port}/ HTTP/1.1\r\nHost: hung.example:${hung.port}\r\n\r\n`,
        `CONNECT hung.example:${hung.port} HTTP/1.1\r\n\r\nGET / HTTP/1.1\r\nHost: hung.example\r\n\r\n`,
      ]) {
        const s = connect(proxy.port, "127.0.0.1", () => s.write(payload));
        expect(await waitFor(() => hung.open() === 1)).toBe(true);
        s.destroy();
        expect(await waitFor(() => hung.open() === 0 && proxy.openSockets() === 0)).toBe(true);
      }
    } finally {
      await proxy.close();
      await new Promise((r) => hung.server.close(r));
    }
  });

  it("closes idle connections and tunnels after the idle timeout", async () => {
    const hung = await hungServer();
    const proxy = await startEgressProxy({ lookup: fakeDns({ "hung.example": [v4("127.0.0.1")] }), allowPrivate: () => true, idleTimeoutMs: 200 });
    try {
      const a = connect(proxy.port, "127.0.0.1", () => a.write(`GET http://hung.example:${hung.port}/ HTTP/1.1\r\nHost: hung.example\r\n\r\n`));
      const b = connect(proxy.port, "127.0.0.1", () => b.write(`CONNECT hung.example:${hung.port} HTTP/1.1\r\n\r\n`));
      a.on("error", () => undefined);
      b.on("error", () => undefined);
      expect(await waitFor(() => hung.open() === 2)).toBe(true);
      // The clients stay open but silent; the proxy must still let go of the upstreams.
      expect(await waitFor(() => hung.open() === 0)).toBe(true);
      a.destroy();
      b.destroy();
      expect(await waitFor(() => proxy.openSockets() === 0)).toBe(true);
    } finally {
      await proxy.close();
      await new Promise((r) => hung.server.close(r));
    }
  });
});

describeEachChrome("WebRTC cannot send UDP around the proxy (SEC-1)", () => {
  /** A loopback "STUN server" that just counts datagrams. */
  async function stunListener() {
    const { createSocket } = await import("node:dgram");
    const sock = createSocket("udp4");
    let packets = 0;
    sock.on("message", () => packets++);
    await new Promise<void>((r) => sock.bind(0, "127.0.0.1", r));
    return { port: sock.address().port, packets: () => packets, close: () => new Promise<void>((r) => sock.close(() => r())) };
  }

  /** Make the page gather ICE candidates against the STUN listener, then give it time to send. */
  async function tryStun(page: import("puppeteer").Page, port: number, waitMs = 2500) {
    await page.evaluate(async (p: number, ms: number) => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${p}` }] });
      pc.createDataChannel("x");
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((r) => setTimeout(r, ms));
      pc.close();
    }, port, waitMs);
  }

  // Both are required: full Chrome ignores --force-webrtc-ip-handling-policy and honours only the profile pref; chrome-headless-shell
  // ignores the profile pref and honours only the flag. Removing either one reopens SEC-1 for one of the binaries. The control drops
  // the flag (and has no pref), so it only proves the listener sees packets when nothing restricts WebRTC.
  it("control: with no WebRTC policy at all (no pref, no flag), Chrome does send STUN packets", async () => {
    const puppeteer = (await import("puppeteer")).default;
    const { resolveChrome, puppeteerBinaryOptions, CHROME_FLAGS } = await import("../src/providers/browser.js");
    const stun = await stunListener();
    const browser = await puppeteer.launch({ ...puppeteerBinaryOptions(await resolveChrome()), args: [...CHROME_FLAGS, ...proxyChromeFlags(1)].filter((f) => !f.startsWith("--force-webrtc-ip-handling-policy")) });
    try {
      // A longer wait than the blocked cases: a loaded Windows runner sometimes sent nothing within 2.5 s.
      await tryStun(await browser.newPage(), stun.port, 8000);
      expect(stun.packets()).toBeGreaterThan(0);
    } finally {
      await browser.close();
      await stun.close();
    }
  }, 60_000);

  it("puppeteer (withBrowser's launcher): zero UDP packets reach a loopback STUN listener", async () => {
    const { launchGuardedBrowser } = await import("../src/providers/browser.js");
    const stun = await stunListener();
    const { browser, close } = await launchGuardedBrowser();
    try {
      await tryStun(await browser.newPage(), stun.port);
      expect(stun.packets()).toBe(0);
    } finally {
      await close();
      await stun.close();
    }
  }, 60_000);

  it("Lighthouse's chrome-launcher: prefs are passed and zero UDP packets get out", async () => {
    const chromeLauncher = await import("chrome-launcher");
    const puppeteer = (await import("puppeteer")).default;
    const { lighthouseLaunchOptions } = await import("../src/providers/browser.js");
    const opts = await lighthouseLaunchOptions();
    expect(opts.prefs).toEqual({ webrtc: { ip_handling_policy: "disable_non_proxied_udp" } });
    expect(opts.chromeFlags).toEqual(expect.arrayContaining(["--proxy-bypass-list=<-loopback>"]));
    const stun = await stunListener();
    const chrome = await chromeLauncher.launch(opts);
    try {
      const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}` });
      try {
        await tryStun(await browser.newPage(), stun.port);
      } finally {
        await browser.disconnect();
      }
      expect(stun.packets()).toBe(0);
    } finally {
      chrome.kill();
      await stun.close();
    }
  }, 60_000);
});
