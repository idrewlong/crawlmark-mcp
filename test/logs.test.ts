/**
 * Phase 12 C2: server-log analysis. Parser (combined, common, nginx extras, malformed, IPv6, gzip), bot matching,
 * CIDR matching, Google's range files (stubbed fetch), file containment (../, absolute outside, symlink out,
 * non-regular), aggregation, caps, and that no IP or user agent reaches the output. No real network.
 */
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { matchBot, resolveBotNames } from "../src/analysis/bots.js";
import { ipInRanges, parseCidr, parseIp } from "../src/analysis/cidr.js";
import { parseLogLine, requestPath, scrubPath } from "../src/analysis/logs.js";
import { existingDirs, globMatch, logDirsFrom, readLogLines, resolveAllowedLogFiles, resolveCliLogFiles, type ReadState } from "../src/lib/log-files.js";
import { googleCrawlerRanges, parseRangeFile, type FetchFn } from "../src/providers/crawler-ipranges.js";
import { analyzeLogs, type LogAnalysisDeps } from "../src/reports/log-analysis.js";

const FIX = join(import.meta.dirname, "fixtures", "logs");
const LOG = readFileSync(join(FIX, "access.log"), "utf8");
const RANGES_JSON = readFileSync(join(FIX, "google-ranges.json"), "utf8");
const RANGES = parseRangeFile(RANGES_JSON).prefixes.map((p) => parseCidr(p)!);
const deps = (calls: string[] = []): LogAnalysisDeps => ({
  googleRanges: async () => (calls.push("ranges"), { ranges: RANGES, files: [{ file: "common-crawlers.json", prefixes: 2, creationTime: null }], fromCache: false }),
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "crawlmark-logs-"));
}

describe("parseLogLine", () => {
  it("parses combined and common lines, converting the time zone", () => {
    const c = parseLogLine(LOG.split("\n")[0]!)!;
    expect(c.format).toBe("combined");
    expect(c.entry).toMatchObject({ ip: "192.0.2.10", path: "/old-page", status: 404, hasQuery: false });
    expect(new Date(c.entry.time).toISOString()).toBe("2026-10-10T13:55:36.000Z");
    const common = parseLogLine('198.51.100.33 - frank [12/Oct/2026:05:00:00 -0500] "GET /common HTTP/1.0" 200 2326')!;
    expect(common.format).toBe("common");
    expect(common.entry.userAgent).toBeNull();
    expect(new Date(common.entry.time).toISOString()).toBe("2026-10-12T10:00:00.000Z");
  });
  it("handles IPv6, query strings, absolute-form targets, nginx extras and odd request lines", () => {
    expect(parseLogLine(LOG.split("\n")[3]!)!.entry).toMatchObject({ ip: "2001:db8:1::7", path: "/" });
    expect(new Date(parseLogLine(LOG.split("\n")[3]!)!.entry.time).toISOString()).toBe("2026-10-10T23:00:00.000Z");
    expect(parseLogLine(LOG.split("\n")[1]!)!.entry).toMatchObject({ path: "/products", hasQuery: true });
    expect(parseLogLine(LOG.split("\n")[10]!)!.entry).toMatchObject({ path: "/abs", hasQuery: true, userAgent: "PerplexityBot/1.0" });
    expect(parseLogLine(LOG.split("\n")[9]!)!.entry).toMatchObject({ path: null, status: 408 });
    expect(parseLogLine("this line is not a log line")).toBeNull();
    expect(parseLogLine('1.2.3.4 - - [10/Foo/2026:13:55:36 +0000] "GET / HTTP/1.1" 200 1')).toBeNull();
    expect(requestPath("GET /a\u0007b?x HTTP/1.1")).toEqual({ path: "/ab", hasQuery: true });
    expect(requestPath("garbage")).toEqual({ path: null, hasQuery: false });
  });
});

describe("tokens in paths (SEC-7)", () => {
  it("drops matrix parameters and %3F tails, and replaces token-like segments", () => {
    expect(requestPath("GET /cart;jsessionid=ABC123DEF456/checkout;x=1 HTTP/1.1")).toEqual({ path: "/cart/checkout", hasQuery: false });
    expect(requestPath("GET /reset%3Ftoken=s3cr3t HTTP/1.1")).toEqual({ path: "/reset", hasQuery: true });
    expect(requestPath("GET /reset/password%3ftoken=x?y=1 HTTP/1.1")).toEqual({ path: "/reset/password", hasQuery: true });
    expect(scrubPath("/confirm/a8F3kQ9zL2mN7pR4sT6vW1xY5bC0dE")).toBe("/confirm/:token");
    expect(scrubPath("/files/550e8400-e29b-41d4-a716-446655440000/view")).toBe("/files/:token/view");
    expect(scrubPath("/blog/how-to-fix-a-leaking-kitchen-tap-2026")).toBe("/blog/how-to-fix-a-leaking-kitchen-tap-2026");
    expect(scrubPath("/products/short123")).toBe("/products/short123");
    expect(scrubPath("/abcdefghijklmnopqrstuvwxyzabcd")).toBe("/abcdefghijklmnopqrstuvwxyzabcd");
  });
});

describe("bots and CIDR", () => {
  it("matches the most specific bot first", () => {
    expect(matchBot("Mozilla/5.0 (compatible; Google-InspectionTool/1.0;)")!.bot).toBe("Google-InspectionTool");
    expect(matchBot("Googlebot-Image/1.0")!.bot).toBe("Googlebot");
    expect(matchBot("x ChatGPT-User/1.0")!.bot).toBe("ChatGPT-User");
    expect(matchBot("x GPTBot/1.2")!.bot).toBe("GPTBot");
    expect(matchBot("Claude-SearchBot")!.family).toBe("ai-search");
    expect(matchBot("Google-Extended")).toBeNull();
    expect(matchBot("Mozilla/5.0 Safari")).toBeNull();
    expect(resolveBotNames(["googlebot", "GPTBOT", "nope"])).toEqual({ bots: ["Googlebot", "GPTBot"], unknown: ["nope"] });
  });
  it("matches v4, v6 and IPv4-mapped addresses; refuses malformed input", () => {
    const r = ["192.0.2.0/25", "2001:db8:1::/48"].map((c) => parseCidr(c)!);
    expect(ipInRanges("192.0.2.127", r)).toBe(true);
    expect(ipInRanges("192.0.2.128", r)).toBe(false);
    expect(ipInRanges("::ffff:192.0.2.1", r)).toBe(true);
    expect(ipInRanges("2001:db8:1:ffff::1", r)).toBe(true);
    expect(ipInRanges("2001:db8:2::1", r)).toBe(false);
    expect(ipInRanges("not-an-ip", r)).toBe(false);
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("1.2.3.256/8")).toBeNull();
    expect(parseIp("01.2.3.4")).toBeNull();
    expect(parseIp("[2001:db8::1]")).toEqual({ v: 6, n: 0x20010db8000000000000000000000001n });
  });
});

describe("Google's crawler IP lists", () => {
  it("fetches both files once, then serves them from the cache; the request carries nothing about the user", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchFn: FetchFn = async (url, init) => (calls.push({ url, headers: init.headers }), { ok: true, status: 200, body: new Response(RANGES_JSON).body });
    const a = await googleCrawlerRanges({ fetchFn, baseUrl: "http://127.0.0.1:9/ipranges-a/" });
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:9/ipranges-a/common-crawlers.json", "http://127.0.0.1:9/ipranges-a/special-crawlers.json"]);
    expect(calls[0]!.headers).toEqual({ accept: "application/json" });
    expect(a).toMatchObject({ fromCache: false, files: [{ prefixes: 2, creationTime: "2026-10-01T00:00:00.000000" }, { prefixes: 2 }] });
    expect(a.ranges).toHaveLength(4);
    const b = await googleCrawlerRanges({ fetchFn, baseUrl: "http://127.0.0.1:9/ipranges-a" });
    expect(b.fromCache).toBe(true);
    expect(calls).toHaveLength(2);
  });
  it("stops reading a range file past 2 MB without buffering it (SEC-8)", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(256 * 1024).fill(32));
      },
    });
    await expect(googleCrawlerRanges({ baseUrl: "http://127.0.0.1:9/huge", fetchFn: async () => ({ ok: true, status: 200, body: endless }) })).rejects.toThrow(/larger than expected/);
    expect(pulled).toBeLessThan(20);
  });

  it("fails on an HTTP error or a malformed file", async () => {
    await expect(googleCrawlerRanges({ baseUrl: "http://127.0.0.1:9/b", fetchFn: async () => ({ ok: false, status: 500, body: new Response("").body }) })).rejects.toThrow(/HTTP 500/);
    await expect(googleCrawlerRanges({ baseUrl: "http://127.0.0.1:9/c", fetchFn: async () => ({ ok: true, status: 200, body: new Response('{"prefixes": "x"}').body }) })).rejects.toThrow();
  });
});

describe("log file access", () => {
  const root = tempDir();
  const allowedDir = join(root, "allowed");
  const outside = join(root, "outside");
  mkdirSync(join(allowedDir, "nginx"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(allowedDir, "access.log"), LOG);
  writeFileSync(join(allowedDir, "access.log.1"), LOG);
  writeFileSync(join(allowedDir, "nginx", "site.log"), LOG);
  writeFileSync(join(outside, "secret.log"), "x");
  symlinkSync(join(outside, "secret.log"), join(allowedDir, "access.log.evil"));
  symlinkSync(join(allowedDir, "access.log"), join(allowedDir, "alias.log"));
  mkdirSync(join(allowedDir, "dir.log"));

  it("LOG_DIRS takes absolute directories only, plus <home>/logs", () => {
    expect(logDirsFrom(` ${allowedDir}, relative/dir ,,`, "/home/x")).toEqual({ dirs: [allowedDir, "/home/x/logs"], ignored: ["relative/dir"] });
  });

  it("expands globs and names inside the allowed directories, de-duplicating symlinks inside", async () => {
    const allowed = await existingDirs([allowedDir, join(root, "missing")]);
    expect(allowed).toHaveLength(1);
    const r = await resolveAllowedLogFiles(["access.log*", "nginx/site.log", "alias.log"], allowed);
    expect(r.files.map((f) => f.name)).toEqual(["access.log", "access.log.1", "nginx/site.log"]);
    expect(r.notes.join(" ")).toMatch(/Skipped access\.log\.evil: not a regular file inside the allowed log directories/);
  });

  it("refuses ../, absolute paths outside, symlinks out and non-regular files", async () => {
    const allowed = await existingDirs([allowedDir]);
    await expect(resolveAllowedLogFiles(["../outside/secret.log"], allowed)).rejects.toThrow(/can't contain "\.\."/);
    await expect(resolveAllowedLogFiles([join(outside, "secret.log")], allowed)).rejects.toThrow(/outside the allowed log directories/);
    await expect(resolveAllowedLogFiles([join(outside, "no-such.log")], allowed)).rejects.toThrow(/outside the allowed log directories\.$/);
    await expect(resolveAllowedLogFiles([`${allowedDir}/../outside/secret.log`], allowed)).rejects.toThrow(/outside the allowed log directories/);
    // SEC-5: one message for a symlink out, a directory and a missing name, so refusals say nothing about existence.
    const msg = (n: string) => `No readable log file ${n} inside the allowed log directories (it must be a regular file there; symlinks pointing elsewhere are refused).`;
    await expect(resolveAllowedLogFiles(["access.log.evil"], allowed)).rejects.toThrow(msg("access.log.evil"));
    await expect(resolveAllowedLogFiles(["dir.log"], allowed)).rejects.toThrow(msg("dir.log"));
    await expect(resolveAllowedLogFiles(["missing.log"], allowed)).rejects.toThrow(msg("missing.log"));
    await expect(resolveAllowedLogFiles(["*/x.log"], allowed)).rejects.toThrow(/only in the file name/);
    expect((await resolveAllowedLogFiles([join(allowedDir, "access.log")], allowed)).files.map((f) => f.name)).toEqual(["access.log"]);
    expect((await resolveAllowedLogFiles(["none-*.log"], allowed)).notes).toEqual(["No log file matched none-*.log."]);
  });

  it("globs match linearly; hostile patterns are refused or finish fast (SEC-4)", async () => {
    expect(globMatch("access.log*", "access.log.2.gz")).toBe(true);
    expect(globMatch("access.?.log", "access.1.log")).toBe(true);
    expect(globMatch("access.?.log", "access.12.log")).toBe(false);
    expect(globMatch("*.gz", "a.log")).toBe(false);
    expect(globMatch("a.b", "axb")).toBe(false);
    const t = performance.now();
    expect(globMatch("*".repeat(48) + "Z", "a".repeat(255))).toBe(false);
    expect(globMatch("*a*a*a*a*a*a*a*Z", "a".repeat(255))).toBe(false);
    expect(performance.now() - t).toBeLessThan(50);
    const allowed = await existingDirs([allowedDir]);
    await expect(resolveAllowedLogFiles(["*".repeat(48) + "Z"], allowed)).rejects.toThrow(/at most 8 wildcards/);
    const t2 = performance.now();
    await resolveAllowedLogFiles(["*a*a*a*a*Z"], allowed);
    expect(performance.now() - t2).toBeLessThan(200);
  });

  it("never lists or looks inside a symlinked directory that points outside (SEC-5)", async () => {
    const d = tempDir();
    const ok = join(d, "logs");
    const out = join(d, "out");
    mkdirSync(ok);
    mkdirSync(out);
    writeFileSync(join(out, "secret-name.log"), LOG);
    symlinkSync(out, join(ok, "linked"));
    const allowed = await existingDirs([ok]);
    const g = await resolveAllowedLogFiles(["linked/*.log"], allowed);
    expect(g.files).toEqual([]);
    expect(JSON.stringify(g.notes)).not.toContain("secret-name");
    await expect(resolveAllowedLogFiles(["linked/secret-name.log"], allowed)).rejects.toThrow(/No readable log file linked\/secret-name\.log/);
    await expect(resolveAllowedLogFiles(["linked/nope.log"], allowed)).rejects.toThrow(/No readable log file linked\/nope\.log/);
  });

  it("opens each file once and checks the handle: symlink swap, replacement, hard link and FIFO are refused (SEC-6)", async () => {
    const d = tempDir();
    const ok = join(d, "logs");
    mkdirSync(ok);
    writeFileSync(join(ok, "a.log"), LOG);
    writeFileSync(join(d, "outside.log"), "secret\n");
    const allowed = await existingDirs([ok]);
    const st: () => ReadState = () => ({ bytes: 0, lines: 0, capped: null });

    // Symlink swapped in after the check: O_NOFOLLOW refuses it.
    const [swap] = (await resolveAllowedLogFiles(["a.log"], allowed)).files;
    renameSync(swap!.path, join(ok, "a.real"));
    symlinkSync(join(d, "outside.log"), swap!.path);
    await expect(readLogLines(swap!, () => undefined, st())).rejects.toThrow(/couldn't be opened as a regular file/);
    rmSync(swap!.path);

    // Another regular file swapped in: different inode.
    writeFileSync(join(ok, "b.log"), LOG);
    const [b] = (await resolveAllowedLogFiles(["b.log"], allowed)).files;
    rmSync(b!.path);
    writeFileSync(b!.path, "replaced\n");
    await expect(readLogLines(b!, () => undefined, st())).rejects.toThrow(/replaced after it was checked/);

    // A hard link is refused at resolve time, and at open time if one appears later.
    writeFileSync(join(ok, "c.log"), LOG);
    const [c] = (await resolveAllowedLogFiles(["c.log"], allowed)).files;
    linkSync(c!.path, join(d, "c-hardlink.log"));
    await expect(readLogLines(c!, () => undefined, st())).rejects.toThrow(/more than one hard link/);
    await expect(resolveAllowedLogFiles(["c.log"], allowed)).rejects.toThrow(/No readable log file c\.log/);

    // A FIFO is not a regular file: refused at resolve time; one swapped in later doesn't block the open.
    execFileSync("mkfifo", [join(ok, "pipe.log")]);
    await expect(resolveAllowedLogFiles(["pipe.log"], allowed)).rejects.toThrow(/No readable log file pipe\.log/);
    writeFileSync(join(ok, "e.log"), LOG);
    const [e] = (await resolveAllowedLogFiles(["e.log"], allowed)).files;
    rmSync(e!.path);
    execFileSync("mkfifo", [e!.path]);
    await expect(readLogLines(e!, () => undefined, st())).rejects.toThrow(/isn't a regular file|replaced/);

    // analyzeLogs reports a refused file in notes, with no counts from it.
    const r = await analyzeLogs("example.com", [c!], { verify: false }, deps());
    expect(r.files[0]).toMatchObject({ lines: 0, format: "unknown" });
    expect(r.notes.join(" ")).toMatch(/more than one hard link/);
  });

  it("CLI paths must be existing regular files", async () => {
    await expect(resolveCliLogFiles([join(root, "nope.log")])).rejects.toThrow(/No such log file/);
    await expect(resolveCliLogFiles([join(allowedDir, "dir.log")])).rejects.toThrow(/Not a regular file/);
    expect(await resolveCliLogFiles([join(outside, "secret.log")])).toMatchObject([{ name: join(outside, "secret.log"), path: join(outside, "secret.log"), identity: { ino: expect.any(Number) } }]);
  });

  it("streams gzip, skips over-long lines and stops at the caps", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.log.gz"), gzipSync(LOG));
    writeFileSync(join(dir, "long.log"), `short\n${"x".repeat(100)}\nend`);
    const seen: string[] = [];
    const st: ReadState = { bytes: 0, lines: 0, capped: null };
    expect(await readLogLines(join(dir, "a.log.gz"), (l) => void seen.push(l), st)).toEqual({ lines: 13, tooLong: 0 });
    expect(seen[0]).toMatch(/^192\.0\.2\.10 /);
    const long: string[] = [];
    expect(await readLogLines(join(dir, "long.log"), (l) => void long.push(l), { bytes: 0, lines: 0, capped: null }, { maxBytes: 1e9, maxLines: 1e9, maxLineChars: 50 })).toEqual({ lines: 2, tooLong: 1 });
    expect(long).toEqual(["short", "end"]);
    const capped: ReadState = { bytes: 0, lines: 0, capped: null };
    await readLogLines(join(dir, "a.log.gz"), () => undefined, capped, { maxBytes: 1e9, maxLines: 3, maxLineChars: 16384 });
    expect(capped).toMatchObject({ lines: 3, capped: "lines" });
  });
});

describe("analyzeLogs", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "access.log"), LOG);
  writeFileSync(join(dir, "access.log.2.gz"), gzipSync(LOG.split("\n").slice(0, 2).join("\n") + "\n"));
  const files = [
    { name: "access.log", path: join(dir, "access.log") },
    { name: "access.log.2.gz", path: join(dir, "access.log.2.gz") },
  ];

  it("summarises bots with verification, statuses, top paths, days and parameter share", async () => {
    const calls: string[] = [];
    const r = await analyzeLogs("example.com", files, {}, deps(calls));
    expect(calls).toEqual(["ranges"]);
    expect(r.files).toEqual([
      { name: "access.log", lines: 13, parsed: 12, skipped: 1, format: "combined" },
      { name: "access.log.2.gz", lines: 2, parsed: 2, skipped: 0, format: "combined" },
    ]);
    const g = r.bots.find((b) => b.bot === "Googlebot")!;
    expect(g).toMatchObject({ family: "search", hits: 6, verified: 5, unverified: 1, unknownVerification: 0, byStatus: { "2xx": 3, "3xx": 0, "4xx": 3, "5xx": 0 } });
    expect(g.top404).toEqual([{ path: "/old-page", hits: 3, status: 404 }]);
    expect(g.topPaths[0]).toEqual({ path: "/old-page", hits: 3, status: 404 });
    expect(g.byDay).toEqual([{ day: "2026-10-10", hits: 6 }]);
    expect(g.parameterShare).toBe(0.333);
    expect(r.bots.find((b) => b.bot === "Google-InspectionTool")).toMatchObject({ verified: 1, top5xx: [{ path: "/api/broken", hits: 1, status: 503 }] });
    expect(r.bots.find((b) => b.bot === "GPTBot")).toMatchObject({ family: "ai-training", hits: 1, unknownVerification: 1 });
    expect(r.bots.find((b) => b.bot === "ChatGPT-User")).toMatchObject({ family: "ai-user" });
    expect(r.bots.find((b) => b.bot === "PerplexityBot")).toMatchObject({ family: "ai-search", parameterShare: 1 });
    expect(r.totals).toEqual({ hits: 14, botHits: 11, outsideWindow: 0 });
    expect(r.verification).toMatchObject({ method: "google-published-ranges", available: true });
  });

  it("never returns an IP address, a user agent, a referrer or a raw line", async () => {
    const text = JSON.stringify(await analyzeLogs("example.com", files, {}, deps()));
    expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(text).not.toMatch(/2001:db8|::ffff/i);
    expect(text).not.toMatch(/Mozilla|compatible;|AppleWebKit|example\.org\/ref|frank/);
    expect(text).not.toContain("color=red");
  });

  it("verify: false makes no request and counts Googlebot as unknownVerification", async () => {
    const calls: string[] = [];
    const r = await analyzeLogs("example.com", files, { verify: false }, deps(calls));
    expect(calls).toEqual([]);
    expect(r.bots.find((b) => b.bot === "Googlebot")).toMatchObject({ verified: 0, unverified: 0, unknownVerification: 6 });
    expect(r.verification).toEqual({ method: "off", available: false });
  });

  it("a failed range download leaves hits unknown, with a note", async () => {
    const r = await analyzeLogs("example.com", files, {}, { googleRanges: async () => Promise.reject(new Error("HTTP 503")) });
    expect(r.bots.find((b) => b.bot === "Googlebot")).toMatchObject({ unknownVerification: 6 });
    expect(r.notes.join(" ")).toMatch(/couldn't be read \(HTTP 503\)/);
  });

  it("filters by bots (no download when no Google bot is asked for) and by day", async () => {
    const calls: string[] = [];
    const r = await analyzeLogs("example.com", files, { bots: ["gptbot", "claudebot"] }, deps(calls));
    expect(calls).toEqual([]);
    expect(r.bots.map((b) => b.bot)).toEqual(["ClaudeBot", "GPTBot"]);
    await expect(analyzeLogs("example.com", files, { bots: ["nope"] }, deps())).rejects.toThrow(/Unknown bot: nope/);
    const day = await analyzeLogs("example.com", files, { since: "2026-10-11", until: "2026-10-11" }, deps());
    expect(day.bots.some((b) => b.bot === "Googlebot")).toBe(false);
    expect(day.totals.outsideWindow).toBe(7);
    expect(day.window).toMatchObject({ since: "2026-10-11", until: "2026-10-11", start: "2026-10-11T02:00:00.000Z" });
    await expect(analyzeLogs("example.com", files, { since: "2026-13-01" }, deps())).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("an unparseable address is unknown, and mostly-private Google addresses get a reverse-proxy note (R-1)", async () => {
    const d = tempDir();
    const line = (ip: string) => `${ip} - - [12/Oct/2026:05:00:00 +0000] "GET / HTTP/1.1" 200 1 "-" "Googlebot/2.1"`;
    writeFileSync(join(d, "proxy.log"), [line("crawler.example.net"), line("-"), line("10.0.0.5"), line("127.0.0.1"), line("10.0.0.5"), line("192.0.2.10")].join("\n") + "\n");
    const r = await analyzeLogs("example.com", [{ name: "proxy.log", path: join(d, "proxy.log") }], {}, deps());
    expect(r.bots[0]).toMatchObject({ bot: "Googlebot", hits: 6, verified: 1, unverified: 3, unknownVerification: 2 });
    expect(r.notes.join(" ")).toMatch(/probably behind a reverse proxy/);
    const plain = await analyzeLogs("example.com", [{ name: "access.log", path: join(dir, "access.log") }], {}, deps());
    expect(plain.notes.join(" ")).not.toMatch(/reverse proxy/);
  });

  it("notes the common format and the read caps", async () => {
    const d = tempDir();
    writeFileSync(join(d, "common.log"), '198.51.100.33 - - [12/Oct/2026:05:00:00 +0000] "GET /a HTTP/1.0" 200 1\n');
    const common = await analyzeLogs("example.com", [{ name: "common.log", path: join(d, "common.log") }], { verify: false }, deps());
    expect(common.files[0]!.format).toBe("common");
    expect(common.notes.join(" ")).toMatch(/common format \(no user agent\)/);
    const capped = await analyzeLogs("example.com", files, { verify: false, caps: { maxBytes: 100, maxLines: 1e9, maxLineChars: 16384 } }, deps());
    expect(capped.notes.join(" ")).toMatch(/read limit/);
    expect(capped.files[1]).toMatchObject({ lines: 0, format: "unknown" });
  });

  it("strips control characters from paths", async () => {
    const d = tempDir();
    writeFileSync(join(d, "x.log"), '192.0.2.1 - - [12/Oct/2026:05:00:00 +0000] "GET /a\u001b[31mred HTTP/1.1" 200 1 "-" "GPTBot/1.2"\n');
    const r = await analyzeLogs("example.com", [{ name: "x.log", path: join(d, "x.log") }], { verify: false }, deps());
    expect(r.bots[0]!.topPaths[0]!.path).toBe("/a[31mred");
  });
});

