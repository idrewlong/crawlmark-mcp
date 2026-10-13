/** Phase 12 C1: `crawlmark-cli crawl` with injected dependencies (no network). */
import { describe, expect, it } from "vitest";
import type { Client } from "../src/config.js";
import { crawlCommand, type CrawlCliDeps } from "../src/crawl-cli.js";
import type { LocalCrawlOptions, LocalCrawlResult } from "../src/reports/local-crawl.js";
import { groupHelp } from "../src/cli-help.js";

const client = { slug: "example.com", domain: "example.com", keyPages: [] } as unknown as Client;
const result = (o: Partial<LocalCrawlResult> = {}): LocalCrawlResult =>
  ({
    crawlId: "crawl_x",
    client: "example.com",
    ranAt: "2026-10-13T00:00:00.000Z",
    durationMs: 130_000,
    exhaustive: true,
    stoppedBy: null,
    pages: 3,
    summary: { fetched: 287, brokenLinks: 4, duplicateTitles: 11, orphans: { available: true, count: 3, urls: [] } },
    topIssues: [],
    findingCount: 0,
    settings: {},
    robots: [],
    notes: [],
    ...o,
  }) as unknown as LocalCrawlResult;

function harness(run: CrawlCliDeps["run"] = async () => result()) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: LocalCrawlOptions[] = [];
  const deps: CrawlCliDeps = {
    resolveClient: async (c) => {
      if (c !== "example.com") throw new Error(`Unknown client ${c}`);
      return client;
    },
    run: async (c, o) => {
      calls.push(o);
      return run(c, o);
    },
  };
  const io = { out: (l: string) => void out.push(l), warn: (l: string) => void err.push(l), usage: (p: string) => (err.push(p), 1) };
  return { out, err, calls, deps, io };
}

describe("crawlmark-cli crawl", () => {
  it("runs with the flags given and prints JSON and a summary", async () => {
    const h = harness();
    const code = await crawlCommand([], { client: "example.com", "max-pages": "500", "max-depth": "3", concurrency: "2", "user-agent": "googlebot", "include-subdomains": true, "start-url": "https://example.com/a, https://example.com/b" }, h.io, h.deps);
    expect(code).toBe(0);
    expect(h.calls).toEqual([{ maxPages: 500, maxDepth: 3, concurrency: 2, userAgent: "googlebot", includeSubdomains: true, startUrls: ["https://example.com/a", "https://example.com/b"] }]);
    expect(JSON.parse(h.out[0]!)).toMatchObject({ command: "crawl", crawlId: "crawl_x", exhaustive: true });
    expect(h.err[0]).toBe("Crawled 287 pages in 2m 10s (exhaustive: yes). 4 broken internal links, 11 duplicate titles, 3 orphan pages. Saved as crawl_x.");
  });

  it("usage errors exit 1 and run nothing", async () => {
    for (const flags of [{}, { client: "example.com", "max-pages": "0" }, { client: "example.com", "max-pages": "2001" }, { client: "example.com", "max-depth": "x" }, { client: "example.com", concurrency: "9" }, { client: "example.com", "user-agent": "bingbot" }, { client: "example.com", "start-url": "ftp://example.com/" }, { client: "example.com", "start-url": "," }]) {
      const h = harness();
      expect(await crawlCommand([], flags, h.io, h.deps), JSON.stringify(flags)).toBe(1);
      expect(h.calls).toEqual([]);
    }
    const h = harness();
    expect(await crawlCommand(["extra"], { client: "example.com" }, h.io, h.deps)).toBe(1);
  });

  it("refuses a --start-url off the client's host instead of dropping it (R-3)", async () => {
    const h = harness();
    expect(await crawlCommand([], { client: "example.com", "start-url": "https://example.com/a,https://example.org/b" }, h.io, h.deps)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err.join(" ")).toMatch(/--start-url https:\/\/example\.org\/b is not on example\.com/);
    const sub = harness();
    expect(await crawlCommand([], { client: "example.com", "start-url": "https://blog.example.com/", "include-subdomains": true }, sub.io, sub.deps)).toBe(0);
  });

  it("an unknown client or a failed crawl exits 1", async () => {
    const h = harness();
    expect(await crawlCommand([], { client: "nope.example" }, h.io, h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/Unknown client/);
    const f = harness(async () => {
      throw new Error("No start URL is on example.com");
    });
    expect(await crawlCommand([], { client: "example.com" }, f.io, f.deps)).toBe(1);
    expect(f.out).toEqual([]);
  });

  it("help lists the flags within 80 columns", () => {
    const text = groupHelp("crawl", { prog: "crawlmark-cli", bold: false });
    for (const flag of ["--client", "--max-pages", "--max-depth", "--concurrency", "--user-agent", "--include-subdomains", "--start-url"]) expect(text).toContain(flag);
    expect(Math.max(...text.split("\n").map((l) => l.length))).toBeLessThanOrEqual(80);
  });
});
