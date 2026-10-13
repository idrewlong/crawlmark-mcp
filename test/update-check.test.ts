import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  checkForUpdate,
  isNewer,
  parseSemver,
  printUpdateNotice,
  readCapped,
  writeCache,
  REGISTRY_LATEST_URL,
  UPDATE_CHECK_INTERVAL_MS,
  updateCheckAllowed,
  updateNotice,
} from "../src/lib/update-check.js";

const DAY = UPDATE_CHECK_INTERVAL_MS;

function tempData() {
  const home = mkdtempSync(join(tmpdir(), "crawlmark-update-"));
  return { home, file: join(home, "data", "update-check.json") };
}

const registry = (version: unknown, init: ResponseInit = {}) => vi.fn(async () => new Response(JSON.stringify({ name: "crawlmark-mcp", version }), init)) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe("semver", () => {
  it("parses versions and refuses junk", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
    expect(parseSemver("1.2.3-beta.1+build.5")).toEqual({ major: 1, minor: 2, patch: 3, pre: ["beta", "1"] });
    for (const bad of ["1.2", "01.2.3", "1.2.3-", "latest", "1.2.3\u001b[2J", "9".repeat(70)]) expect(parseSemver(bad), bad).toBeUndefined();
  });

  it("isNewer compares by semver and ignores prereleases unless the current one is a prerelease", () => {
    expect(isNewer("0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.0.9", "0.1.0")).toBe(false);
    expect(isNewer("0.2.0-beta.1", "0.1.0")).toBe(false);
    expect(isNewer("0.2.0-beta.2", "0.2.0-beta.1")).toBe(true);
    expect(isNewer("0.2.0-beta.10", "0.2.0-beta.9")).toBe(true);
    expect(isNewer("0.2.0", "0.2.0-beta.9")).toBe(true);
    expect(isNewer("garbage", "0.1.0")).toBe(false);
  });
});

describe("updateCheckAllowed", () => {
  const ok = { env: {}, stdoutTTY: true };
  it("only on a TTY, without --json, outside CI and without an opt-out", () => {
    expect(updateCheckAllowed(ok)).toBe(true);
    expect(updateCheckAllowed({ ...ok, stdoutTTY: false })).toBe(false);
    expect(updateCheckAllowed({ ...ok, json: true })).toBe(false);
    expect(updateCheckAllowed({ ...ok, env: { CI: "true" } })).toBe(false);
    expect(updateCheckAllowed({ ...ok, env: { CRAWLMARK_NO_UPDATE_CHECK: "1" } })).toBe(false);
    expect(updateCheckAllowed({ ...ok, env: { NO_UPDATE_NOTIFIER: "1" } })).toBe(false);
    expect(updateCheckAllowed({ ...ok, env: { CI: "false", CRAWLMARK_NO_UPDATE_CHECK: "0", NO_UPDATE_NOTIFIER: "" } })).toBe(true);
  });
});

describe("checkForUpdate", () => {
  it("asks the registry once (GET, no query, no added headers, no redirects) and caches the answer for a day", async () => {
    const { file } = tempData();
    const fetch = registry("0.2.0");
    let now = 1_000_000;
    expect(await checkForUpdate({ current: "0.1.0", cacheFile: file, fetch, now: () => now })).toBe("0.2.0");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(REGISTRY_LATEST_URL);
    expect(new URL(url).search).toBe("");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ checkedAt: 1_000_000, latest: "0.2.0" });
    expect(statSync(file).mode & 0o777).toBe(0o600);

    now += DAY - 1;
    expect(await checkForUpdate({ current: "0.1.0", cacheFile: file, fetch, now: () => now })).toBe("0.2.0");
    expect(fetch).toHaveBeenCalledOnce();

    now += 1;
    const newer = registry("0.3.0");
    expect(await checkForUpdate({ current: "0.1.0", cacheFile: file, fetch: newer, now: () => now })).toBe("0.3.0");
    expect(newer).toHaveBeenCalledOnce();
  });

  it("nothing newer, a prerelease, a bad answer or an error: no notice; a failure still records the time", async () => {
    const { file } = tempData();
    expect(await checkForUpdate({ current: "0.1.0", cacheFile: file, fetch: registry("0.1.0"), now: () => 1 })).toBeUndefined();
    const t2 = tempData();
    expect(await checkForUpdate({ current: "0.1.0", cacheFile: t2.file, fetch: registry("0.2.0-rc.1"), now: () => 1 })).toBeUndefined();
    const t3 = tempData();
    expect(await checkForUpdate({ current: "0.1.0", cacheFile: t3.file, fetch: registry("\u001b[2J9.9.9"), now: () => 1 })).toBeUndefined();
    const t4 = tempData();
    expect(await checkForUpdate({ current: "0.1.0", cacheFile: t4.file, fetch: registry("0.2.0", { status: 500 }), now: () => 1 })).toBeUndefined();
    const t5 = tempData();
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await checkForUpdate({ current: "0.1.0", cacheFile: t5.file, fetch: offline, now: () => 42 })).toBeUndefined();
    expect(JSON.parse(readFileSync(t5.file, "utf8"))).toEqual({ checkedAt: 42 });
    // ...so the next run within a day doesn't ask again.
    const again = registry("0.2.0");
    expect(await checkForUpdate({ current: "0.1.0", cacheFile: t5.file, fetch: again, now: () => 43 })).toBeUndefined();
    expect(again).not.toHaveBeenCalled();
  });

  it("SEC-3: a chunked answer over the cap is cancelled mid-stream, not read whole", async () => {
    const { file } = tempData();
    let pulled = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode(`{"version":"0.2.0","pad":"${"x".repeat(16 * 1024)}`);
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(chunk);
        if (pulled > 1000) c.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    // No content-length header: the size is only known by reading.
    const chunked = vi.fn(async () => new Response(body, { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    expect(await checkForUpdate({ current: "0.1.0", cacheFile: file, fetch: chunked, now: () => 1 })).toBeUndefined();
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it("readCapped returns small bodies whole", async () => {
    expect(await readCapped(new Response("hello"), 10)).toBe("hello");
    expect(await readCapped(new Response("hello world"), 5)).toBeUndefined();
  });

  it("an oversized answer is ignored", async () => {
    const { file } = tempData();
    const big = vi.fn(async () => new Response(JSON.stringify({ version: "0.2.0", pad: "x".repeat(70_000) }))) as unknown as typeof fetch;
    expect(await checkForUpdate({ current: "0.1.0", cacheFile: file, fetch: big, now: () => 1 })).toBeUndefined();
  });

  it("gives up after the timeout without throwing", async () => {
    const { file } = tempData();
    const hang = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const started = Date.now();
    expect(await checkForUpdate({ current: "0.1.0", cacheFile: file, fetch: hang, timeoutMs: 50 })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("a dry run reads the cache but never writes it; a missing config home is never created", async () => {
    const { file } = tempData();
    expect(await checkForUpdate({ current: "0.1.0", cacheFile: file, fetch: registry("0.2.0"), now: () => 1, write: false })).toBe("0.2.0");
    expect(existsSync(file)).toBe(false);
    const missing = join(tmpdir(), `crawlmark-no-home-${process.pid}-${Date.now()}`, "data", "update-check.json");
    expect(await checkForUpdate({ current: "0.1.0", cacheFile: missing, fetch: registry("0.2.0"), now: () => 1 })).toBe("0.2.0");
    expect(existsSync(dirname(dirname(missing)))).toBe(false);
  });

  it("SEC-4: a symlink planted at the temp path is never followed", () => {
    const { home, file } = tempData();
    mkdirSync(dirname(file), { recursive: true });
    const victim = join(home, "victim.txt");
    writeFileSync(victim, "keep me");
    const tmp = `${file}.${process.pid}.fixed.tmp`;
    symlinkSync(victim, tmp);
    writeCache(file, { checkedAt: 1, latest: "0.2.0" }, "fixed");
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(lstatSync(tmp).isSymbolicLink()).toBe(true);
    expect(existsSync(file)).toBe(false);
    // With a fresh (random) name the write goes through, mode 0600.
    writeCache(file, { checkedAt: 1, latest: "0.2.0" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ checkedAt: 1, latest: "0.2.0" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("a corrupt cache is treated as no cache", async () => {
    const { file } = tempData();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{not json");
    const fetch = registry("0.2.0");
    expect(await checkForUpdate({ current: "0.1.0", cacheFile: file, fetch, now: () => 5 })).toBe("0.2.0");
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("printUpdateNotice", () => {
  const sink = () => {
    let text = "";
    const stream = new Writable({
      write(c, _e, cb) {
        text += c.toString();
        cb();
      },
    }) as unknown as NodeJS.WriteStream;
    return { stream, text: () => text };
  };

  it("prints the notice when newer, and nothing (no request) when not allowed", async () => {
    const { file } = tempData();
    const s = sink();
    const fetch = registry("0.2.0");
    await printUpdateNotice({ current: "0.1.0", cacheFile: file, env: {}, stdoutTTY: true, stream: s.stream, fetch });
    expect(s.text()).toContain("Update available 0.1.0 → 0.2.0 · run npx crawlmark-mcp@latest init");
    for (const blocked of [{ env: { CRAWLMARK_NO_UPDATE_CHECK: "1" } }, { env: { NO_UPDATE_NOTIFIER: "1" } }, { env: { CI: "1" } }, { env: {}, json: true }, { env: {}, stdoutTTY: false }]) {
      const quiet = sink();
      const f = registry("0.2.0");
      await printUpdateNotice({ current: "0.1.0", cacheFile: tempData().file, stdoutTTY: true, stream: quiet.stream, fetch: f, ...blocked });
      expect(f).not.toHaveBeenCalled();
      expect(quiet.text()).toBe("");
    }
  });

  it("updateNotice strips control characters", () => {
    expect(updateNotice("0.1.0", "0.2.0\u001b[2J")).toBe("Update available 0.1.0 → 0.2.0[2J · run npx crawlmark-mcp@latest init");
  });
});

describe("the MCP server never makes the update request", () => {
  const root = resolve(import.meta.dirname, "..", "src");
  const STATIC = /(?:from\s+|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm;
  const ANY = /(?:from\s+|^\s*import\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/gm;
  /** Source files reachable from `start` through relative imports matching `pattern` (paths relative to src/). */
  const graph = (start: string, pattern: RegExp): string[] => {
    const seen = new Set<string>();
    const queue = [join(root, start)];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const m of readFileSync(file, "utf8").matchAll(pattern)) {
        const target = resolve(dirname(file), m[1]!.replace(/\.js$/, ".ts"));
        if (existsSync(target)) queue.push(target);
      }
    }
    return [...seen].map((f) => relative(root, f));
  };

  it("no module the server imports (statically or dynamically) reaches update-check", () => {
    const names = graph("server.ts", ANY);
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((n) => n.includes("update-check"))).toEqual([]);
    expect(names).not.toContain("cli.ts");
  });

  it("the entry point (which starts the server) only loads it dynamically, for --version", () => {
    const names = graph("index.ts", STATIC);
    expect(names).toContain("lib/entry.ts");
    expect(names.filter((n) => n.includes("update-check"))).toEqual([]);
    expect(names).not.toContain("cli.ts");
  });
});

describe("crawlmark-mcp --version (no config loaded)", () => {
  it("takes DATA_DIR and the opt-outs from the shell, else the home's .env", async () => {
    const { updateContextWithoutConfig } = await import("../src/lib/update-check.js");
    const home = mkdtempSync(join(tmpdir(), "crawlmark-update-home-"));
    writeFileSync(join(home, ".env"), "DATA_DIR=./state\nCRAWLMARK_NO_UPDATE_CHECK=1\nDATAFORSEO_PASSWORD=not-read\n");
    const moduleUrl = new URL("../src/index.ts", import.meta.url).href;
    const u = updateContextWithoutConfig(moduleUrl, { CRAWLMARK_HOME: home })!;
    expect(u.cacheFile).toBe(join(home, "state", "update-check.json"));
    expect(u.env.CRAWLMARK_NO_UPDATE_CHECK).toBe("1");
    expect(u.env.DATAFORSEO_PASSWORD).toBeUndefined();
    expect(updateCheckAllowed({ env: u.env, stdoutTTY: true })).toBe(false);
    const shellWins = updateContextWithoutConfig(moduleUrl, { CRAWLMARK_HOME: home, CRAWLMARK_NO_UPDATE_CHECK: "0", DATA_DIR: "./other" })!;
    expect(shellWins.cacheFile).toBe(join(home, "other", "update-check.json"));
    expect(updateCheckAllowed({ env: shellWins.env, stdoutTTY: true })).toBe(true);
    expect(updateContextWithoutConfig(moduleUrl, { CRAWLMARK_HOME: "relative/path" })).toBeUndefined();
  });
});
