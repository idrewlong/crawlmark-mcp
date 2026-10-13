import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { LookupAddress } from "node:dns";
import { pinnedLookup, privateUrlsAllowed, resolvePublic, systemLookup, type LookupFn } from "./url-guard.js";

/**
 * In-process HTTP forward proxy that every headless Chrome is started behind
 * (`--proxy-server`). It resolves each target itself, refuses private, loopback and
 * link-local addresses, and connects to the vetted address only. Because Chrome sends
 * every connection through it (plain HTTP, CONNECT for HTTPS and WebSockets), the
 * check covers navigations, redirects, subresources, fetch/XHR, WebSockets, popups,
 * service workers and Lighthouse, and DNS rebinding cannot swap the address after the
 * check. Listens on 127.0.0.1 only.
 */

export interface EgressProxyOptions {
  /** DNS resolver. Default: the system resolver (A and AAAA). */
  lookup?: LookupFn;
  /** Allow private addresses. Read per connection; default ALLOW_PRIVATE_URLS. */
  allowPrivate?: () => boolean;
  /**
   * Test-only escape hatch: hosts for which this returns true skip the address check.
   * Production code never sets it (everything a local test serves is loopback).
   */
  allowHost?: (host: string, port: number) => boolean;
  /** Give up on an upstream connect after this long. Default 30s. */
  connectTimeoutMs?: number;
  /** Close a proxied connection or tunnel after this long with no traffic. Default 120s. */
  idleTimeoutMs?: number;
}

export interface EgressProxy {
  port: number;
  /** Stop listening and drop every open connection. */
  close(): Promise<void>;
  /** Synchronous variant for process exit. */
  closeSync(): void;
  /** Client and upstream sockets currently open (for tests and diagnostics). */
  openSockets(): number;
}

/** Response header on refusals, so callers can tell a proxy block from the site's own 403. */
export const BLOCKED_HEADER = "x-crawlmark-blocked";

const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function stripHopByHop(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const listed = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: IncomingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k) && !listed.has(k)) out[k] = v;
  }
  return out;
}

const bare = (h: string) => h.replace(/^\[|\]$/g, "");

/**
 * Parse "host:port" from a CONNECT line. The port comes from the raw authority
 * (URL drops a default port such as 80); URL only normalises the host.
 */
export function parseAuthority(authority: string | undefined): { host: string; port: number } | null {
  const m = /^(.+):(\d{1,5})$/.exec(authority ?? "");
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  // A colon in the host is only valid inside an IPv6 literal's brackets.
  if (m[1]!.includes(":") && !/^\[[^\]]+\]$/.test(m[1]!)) return null;
  try {
    const u = new URL(`http://${m[1]}`);
    if (!u.hostname || u.port !== "" || u.pathname !== "/" || u.username || u.password || u.search || u.hash) return null;
    return { host: bare(u.hostname), port };
  } catch {
    return null;
  }
}

export async function startEgressProxy(opts: EgressProxyOptions = {}): Promise<EgressProxy> {
  const lookup = opts.lookup ?? systemLookup;
  const allowPrivate = opts.allowPrivate ?? (() => privateUrlsAllowed());
  const connectTimeoutMs = opts.connectTimeoutMs ?? 30_000;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
  const sockets = new Set<Socket | Duplex>();
  const track = (s: Socket | Duplex) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  };

  /** Vetted addresses for host:port, or null (and a stderr note) when refused. */
  async function vet(host: string, port: number): Promise<LookupAddress[] | null> {
    try {
      if (opts.allowHost?.(host, port)) return await lookup(host);
      return await resolvePublic(host, { allowPrivate: allowPrivate(), lookup });
    } catch (err) {
      console.error(`crawlmark: egress proxy refused ${host}:${port}: ${(err as Error).message}`);
      return null;
    }
  }

  const refuseRaw = (socket: Duplex, status = "403 Forbidden") => {
    if (socket.writable) {
      socket.end(`HTTP/1.1 ${status}\r\n${BLOCKED_HEADER}: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    }
    socket.destroy();
  };

  /** Open a TCP connection to a vetted address, with a connect timeout. */
  function dial(host: string, port: number, addresses: LookupAddress[]): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const upstream = connect({ host, port, lookup: pinnedLookup(addresses) });
      track(upstream);
      const timer = setTimeout(() => upstream.destroy(new Error(`connect to ${host}:${port} timed out`)), connectTimeoutMs);
      upstream.once("connect", () => {
        clearTimeout(timer);
        resolve(upstream);
      });
      upstream.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  /** Pipe a client and an upstream socket together; either side closing, erroring or idling closes both. */
  function splice(a: Duplex, b: Socket) {
    b.setTimeout(idleTimeoutMs, () => b.destroy());
    a.on("error", () => b.destroy());
    b.on("error", () => a.destroy());
    a.on("close", () => b.destroy());
    b.on("close", () => a.destroy());
    a.pipe(b);
    b.pipe(a);
  }

  // Plain HTTP: absolute-form request line, e.g. "GET http://example.com/ HTTP/1.1".
  async function onRequest(req: IncomingMessage, res: ServerResponse) {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      return void res.writeHead(400, { [BLOCKED_HEADER]: "1", connection: "close" }).end("Proxy requests must use an absolute http:// URL");
    }
    if (target.protocol !== "http:") {
      return void res.writeHead(400, { [BLOCKED_HEADER]: "1", connection: "close" }).end("Only http:// is proxied directly; use CONNECT");
    }
    const host = bare(target.hostname);
    const port = Number(target.port) || 80;
    const addresses = await vet(host, port);
    if (!addresses) {
      req.resume();
      return void res
        .writeHead(403, { "content-type": "text/plain", [BLOCKED_HEADER]: "1", connection: "close" })
        .end("Blocked by crawlmark: private or loopback address");
    }
    const upstream = httpRequest({
      host,
      port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: stripHopByHop(req.headers),
      lookup: pinnedLookup(addresses),
      agent: false,
    });
    // Connect timeout first, then an idle timeout once connected; either destroys the upstream.
    upstream.setTimeout(connectTimeoutMs);
    upstream.on("timeout", () => upstream.destroy(new Error("upstream timed out")));
    upstream.once("socket", (s) => {
      track(s);
      s.once("connect", () => upstream.setTimeout(idleTimeoutMs));
    });
    // The client went away (closed, or the request aborted) before the response finished: drop the upstream too.
    res.once("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.once("error", () => upstream.destroy());
    upstream.on("response", (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.statusMessage, stripHopByHop(ur.headers));
      ur.pipe(res);
      ur.on("error", () => res.destroy());
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { connection: "close" }).end();
      else res.destroy();
    });
    req.pipe(upstream);
  }

  // CONNECT host:port: HTTPS, and every WebSocket (Chrome tunnels ws:// and wss:// through CONNECT).
  async function onConnect(req: IncomingMessage, client: Duplex, head: Buffer) {
    track(client);
    client.on("error", () => client.destroy());
    const target = parseAuthority(req.url);
    if (!target) return refuseRaw(client, "400 Bad Request");
    const addresses = await vet(target.host, target.port);
    if (!addresses) return refuseRaw(client);
    let upstream: Socket;
    try {
      upstream = await dial(target.host, target.port, addresses);
    } catch {
      return refuseRaw(client, "502 Bad Gateway");
    }
    if (client.destroyed) return void upstream.destroy();
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    splice(client, upstream);
  }

  // Absolute-form Upgrade request (ws:// sent as a plain proxied GET). Chrome uses CONNECT, but other clients may not.
  async function onUpgrade(req: IncomingMessage, client: Duplex, head: Buffer) {
    track(client);
    client.on("error", () => client.destroy());
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      return refuseRaw(client, "400 Bad Request");
    }
    if (target.protocol !== "http:" && target.protocol !== "ws:") return refuseRaw(client, "400 Bad Request");
    const host = bare(target.hostname);
    const port = Number(target.port) || 80;
    const addresses = await vet(host, port);
    if (!addresses) return refuseRaw(client);
    let upstream: Socket;
    try {
      upstream = await dial(host, port, addresses);
    } catch {
      return refuseRaw(client, "502 Bad Gateway");
    }
    const lines = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]!;
      if (/^proxy-/i.test(name)) continue;
      lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    splice(client, upstream);
  }

  const server = createServer();
  server.on("connection", track);
  server.on("request", (req, res) => void onRequest(req, res).catch(() => res.destroy()));
  server.on("connect", (req, socket, head) => void onConnect(req, socket, head).catch(() => socket.destroy()));
  server.on("upgrade", (req, socket, head) => void onUpgrade(req, socket, head).catch(() => socket.destroy()));
  server.on("clientError", (_err, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  // Never keeps the process alive on its own.
  server.unref();

  const closeSync = () => {
    server.close();
    for (const s of sockets) s.destroy();
    sockets.clear();
  };
  return {
    port: (server.address() as AddressInfo).port,
    openSockets: () => [...sockets].filter((s) => !s.destroyed).length,
    closeSync,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
        sockets.clear();
      }),
  };
}

let shared: Promise<EgressProxy> | undefined;

/** The process-wide proxy, started on first use and closed when the process exits. */
export function egressProxy(): Promise<EgressProxy> {
  shared ??= startEgressProxy().then(
    (proxy) => {
      process.once("exit", () => proxy.closeSync());
      return proxy;
    },
    (err: unknown) => {
      shared = undefined;
      throw err;
    },
  );
  return shared;
}

/** Close the shared proxy if it was started (process shutdown). */
export async function closeEgressProxy(): Promise<void> {
  const p = shared;
  shared = undefined;
  if (p) await (await p).close();
}

/** Chrome flags that send all of its traffic, loopback included, through the proxy on `port`. */
export function proxyChromeFlags(port: number): string[] {
  return [
    `--proxy-server=http://127.0.0.1:${port}`,
    // Chrome bypasses the proxy for localhost by default; this removes that exemption.
    "--proxy-bypass-list=<-loopback>",
    // QUIC and WebRTC use UDP, which an HTTP proxy cannot carry; keep both off the network.
    // The WebRTC flag alone is not honoured; the CHROME_PREFS profile pref (browser.ts) is what enforces it.
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];
}
