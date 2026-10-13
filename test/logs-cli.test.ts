/** Phase 12 C2: `crawlmark-cli logs` with injected dependencies, and its help. No network. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Client } from "../src/config.js";
import { groupHelp, topHelp } from "../src/cli-help.js";
import { logsCommand, type LogsCliDeps } from "../src/logs-cli.js";
import { analyzeLogs, type LogAnalysisOptions } from "../src/reports/log-analysis.js";

const dir = mkdtempSync(join(tmpdir(), "crawlmark-logs-cli-"));
const LOG = join(dir, "access.log");
writeFileSync(LOG, '192.0.2.10 - - [10/Oct/2026:13:55:36 +0000] "GET /old-page HTTP/1.1" 404 512 "-" "Mozilla/5.0 (compatible; Googlebot/2.1)"\n198.51.100.1 - - [10/Oct/2026:13:56:00 +0000] "GET / HTTP/1.1" 200 5 "-" "GPTBot/1.2"\n');
const client = { slug: "example.com", domain: "example.com" } as unknown as Client;

function harness() {
  const out: string[] = [];
  const err: string[] = [];
  const opts: LogAnalysisOptions[] = [];
  let rangeCalls = 0;
  const deps: LogsCliDeps = {
    resolveClient: async (c) => {
      if (c !== "example.com") throw new Error(`Unknown client ${c}`);
      return client;
    },
    analyze: (c, files, o) => {
      opts.push(o);
      return analyzeLogs(c.slug, files, o, { googleRanges: async () => (rangeCalls++, { ranges: [], files: [], fromCache: true }) });
    },
  };
  const io = { out: (l: string) => void out.push(l), warn: (l: string) => void err.push(l), usage: (p: string) => (err.push(p), 1) };
  return { out, err, opts, deps, io, rangeCalls: () => rangeCalls };
}

describe("crawlmark-cli logs", () => {
  it("analyses the files given and prints JSON and a summary", async () => {
    const h = harness();
    expect(await logsCommand([LOG], { client: "example.com", since: "2026-10-01", bots: "googlebot,gptbot", "no-verify": true }, h.io, h.deps)).toBe(0);
    expect(h.opts).toEqual([{ since: "2026-10-01", bots: ["googlebot", "gptbot"], verify: false }]);
    expect(h.rangeCalls()).toBe(0);
    const json = JSON.parse(h.out[0]!);
    expect(json).toMatchObject({ command: "logs", client: "example.com", totals: { hits: 2, botHits: 2 } });
    expect(h.out[0]).not.toMatch(/192\.0\.2\.10|Mozilla/);
    expect(h.err[0]).toBe("2 requests, 2 from known bots (2026-10-10 to 2026-10-10). Googlebot: 1 hits, 100.0% 4xx; GPTBot: 1 hits, no 4xx.");
  });

  it("usage problems and unreadable files exit 1", async () => {
    for (const [args, flags] of [[[LOG], {}], [[], { client: "example.com" }], [[LOG], { client: "example.com", since: "10/01/2026" }], [[LOG], { client: "example.com", bots: "," }]] as const) {
      const h = harness();
      expect(await logsCommand([...args], flags, h.io, h.deps)).toBe(1);
      expect(h.out).toEqual([]);
    }
    const h = harness();
    expect(await logsCommand([join(dir, "missing.log")], { client: "example.com" }, h.io, h.deps)).toBe(1);
    expect(h.err.join(" ")).toMatch(/No such log file/);
    const u = harness();
    expect(await logsCommand([LOG], { client: "example.com", bots: "nobot" }, u.io, u.deps)).toBe(1);
    expect(u.err.join(" ")).toMatch(/Unknown bot: nobot/);
  });

  it("help lists the flags within 80 columns, and the top level lists logs", () => {
    const text = groupHelp("logs", { prog: "crawlmark-cli", bold: false });
    for (const f of ["--client", "--since", "--until", "--bots", "--no-verify", "never leave the machine"]) expect(text).toContain(f);
    expect(Math.max(...text.split("\n").map((l) => l.length))).toBeLessThanOrEqual(80);
    expect(topHelp({ prog: "crawlmark-cli", bold: false })).toContain("logs ");
  });
});
