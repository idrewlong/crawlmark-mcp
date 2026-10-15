import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny static site for the real-browser tests (Lighthouse, axe), served from node:http on 127.0.0.1.
 *   /fast      small, valid, accessible page
 *   /slow      render-blocking CSS and script that arrive late, a script that burns CPU, a 1.5 MB image
 *   /a11y      page with accessibility problems (no alt, no lang, no label, low contrast, empty button and link)
 *   /redirect  302 to /fast on the same host
 *   /offsite   302 to the same site under the host name `localhost` (a different host from 127.0.0.1)
 */
export interface FixtureSite {
  /** http://127.0.0.1:<port> */
  origin: string;
  /** http://localhost:<port>: same server, different host name. */
  otherOrigin: string;
  port: number;
  close(): Promise<void>;
}

const FAST = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fast fixture page</title><meta name="description" content="A small, quick page used by the Lighthouse tests."></head>
<body><main><h1>Fast page</h1><p>Hello from the fixture site.</p></main></body></html>`;

const SLOW = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Slow fixture page</title><meta name="description" content="A deliberately heavy page used by the Lighthouse tests.">
<link rel="stylesheet" href="/slow.css">
<script src="/slow.js"></script></head>
<body><main><h1>Slow page</h1><p>Heavy on purpose.</p><img src="/big.png" alt="Large decorative image"></main></body></html>`;

const A11Y = `<!doctype html>
<html><head><meta charset="utf-8"><title>Accessibility problems</title></head>
<body><h1>Problems</h1>
<img src="/pixel.png">
<p style="color:#bbb;background:#fff">Low contrast text that is hard to read.</p>
<button></button>
<a href="/fast"></a>
<input type="text">
</body></html>`;

// 1x1 transparent PNG.
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startFixtureSite(): Promise<FixtureSite> {
  const server: Server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
      res.end(body);
    };
    const port = (server.address() as AddressInfo).port;
    switch (path) {
      case "/fast":
        return send(200, "text/html; charset=utf-8", FAST);
      case "/slow":
        return send(200, "text/html; charset=utf-8", SLOW);
      case "/a11y":
        return send(200, "text/html; charset=utf-8", A11Y);
      case "/slow.css":
        await wait(1500);
        return send(200, "text/css", "body{font-family:sans-serif}" + "/* padding */".repeat(20_000));
      case "/slow.js":
        await wait(1500);
        // ~1 s of main-thread work, then padding so the transfer is large too.
        return send(200, "text/javascript", "var t=Date.now();while(Date.now()-t<1200){}\n" + "// padding padding padding\n".repeat(40_000));
      case "/big.png":
        // Not a decodable image; Chrome still downloads all of it. The size is what the audits look at.
        return send(200, "image/png", Buffer.concat([PIXEL, Buffer.alloc(1_500_000, 1)]));
      case "/pixel.png":
        return send(200, "image/png", PIXEL);
      case "/redirect":
        return send(302, "text/plain", "", { location: "/fast" });
      case "/offsite":
        return send(302, "text/plain", "", { location: `http://localhost:${port}/fast` });
      default:
        return send(404, "text/plain", "not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  // `localhost` can resolve to ::1 before 127.0.0.1 on some runners. Also serve it there when IPv6 loopback exists;
  // when the port is taken or there is no IPv6, the proxy's address fallback uses 127.0.0.1 and this stays unused.
  const server6 = createServer(server.listeners("request")[0] as never);
  await new Promise<void>((resolve) => {
    server6.once("error", () => resolve());
    server6.listen(port, "::1", () => resolve());
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    otherOrigin: `http://localhost:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server6.close();
        server6.closeAllConnections();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
