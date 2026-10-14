/**
 * Phase 13 B-4: backlinks_summary keeps its output and, as a side effect, stores a snapshot only for the client's own
 * domain; crawlmark-cli seo-snapshot needs --paid, --dry-run requests nothing, and a client over its cap is skipped.
 * fetch stubbed on the closed local port; temp SQLite and clients file from test/setup.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";
import { env } from "../src/config.js";
import { db } from "../src/lib/store.js";
import { registerRawTools } from "../src/tools/raw.js";
import { seoSnapshotCommand } from "../src/seo-snapshot-cli.js";
import * as ps from "../src/reports/provider-sections.js";
import * as seo from "../src/providers/seo-data.js";

const SUMMARY = readFileSync(new URL("./fixtures/dataforseo/backlinks_summary_live.json", import.meta.url), "utf8");
const OVERVIEW = readFileSync(new URL("./fixtures/dataforseo/p13/domain_rank_overview_live.json", import.meta.url), "utf8");
function fake() {
  const log: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.hostname !== "127.0.0.1") throw new Error(`real host: ${url.hostname}`);
      log.push(url.pathname);
      if (url.pathname === "/v3/backlinks/summary/live") return new Response(SUMMARY, { status: 200 });
      if (url.pathname === "/v3/dataforseo_labs/google/domain_rank_overview/live") return new Response(OVERVIEW, { status: 200 });
      return new Response("{}", { status: 404 });
    }),
  );
  return log;
}
afterEach(() => vi.unstubAllGlobals());
const snapshots = (client: string) => db.prepare("SELECT kind, target, provider, source FROM seo_snapshots WHERE client = ?").all(client) as { kind: string; target: string; provider: string; source: string }[];

describe("backlinks_summary (side effect only)", () => {
  type Cb = (args: { client: string; target?: string }) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  let cb!: Cb;
  registerRawTools({ registerTool: (name: string, _d: unknown, c: Cb) => void (name === "backlinks_summary" && (cb = c)) } as never);

  it("stores a snapshot for the client's own domain, not for another target; the output keys are unchanged", async () => {
    writeFileSync(env.CLIENTS_FILE, "clients:\n  side.example.com:\n    domain: side.example.com\n    name: Example Co\n");
    const log = fake();
    const own = await cb({ client: "side.example.com" });
    expect(own.isError, own.content[0]!.text).toBeFalsy();
    const out = JSON.parse(own.content[0]!.text);
    expect(Object.keys(out).sort()).toEqual(["costUsd", "fromCache", "provider", "summary", "units"]);
    expect(snapshots("side.example.com")).toEqual([{ kind: "backlinks", target: "side.example.com", provider: "dataforseo", source: "live" }]);
    await cb({ client: "side.example.com", target: "competitor-a.example" });
    expect(snapshots("side.example.com")).toHaveLength(1);
    expect(log).toHaveLength(2);
  });
});

describe("crawlmark-cli seo-snapshot", () => {
  const io = () => {
    const lines: string[] = [];
    const errs: string[] = [];
    return { lines, errs, io: { out: (l: string) => void lines.push(l), warn: (l: string) => void errs.push(l), usage: (p: string) => (errs.push(p), 2) } };
  };
  const client = (slug: string) => ({ slug, domain: slug, name: "Example Co", aliases: [], competitors: [], locationCode: 2840, languageCode: "en", monthlyBudgetUsd: 5, country: "US", monthlyUnits: { ahrefs: 1000, semrush: 1000 } }) as unknown as Client;
  const deps = (clients: Client[], left = 5) => ({
    loadClients: async () => ({ clients, skipped: [] }),
    sections: async () => ({
      ps,
      deps: { now: () => Date.parse("2026-10-02T12:00:00Z"), reuseDays: 7, route: seo.routeProvider, impl: seo.providerImpl, backlinksNow: seo.backlinksSummary, cached: () => false, denylist: () => ({ deny: [], allow: [] }) },
      spend: { remainingUsd: () => ({ clientUsd: left, globalUsd: 50 }), remainingUnits: () => ({ client: 0, global: 0 }), withUsdReservation: async <T,>(_c: Client, _u: number, fn: () => Promise<T>) => fn(), withUnitsReservation: async <T,>(_c: Client, _p: string, _u: number, fn: () => Promise<T>) => fn(), spent: () => ({ usd: 0, ahrefs: 0, semrush: 0 }) },
    }),
  });

  it("without --paid exits 1 before anything; bad --kinds is a usage error", async () => {
    const log = fake();
    const a = io();
    expect(await seoSnapshotCommand([], { all: true, paid: false, "dry-run": false }, a.io, deps([client("snap0.example.com")]) as never)).toBe(1);
    expect(a.errs[0]).toContain("add --paid");
    expect(await seoSnapshotCommand([], { all: true, paid: true, kinds: "links", "dry-run": false }, a.io, deps([]) as never)).toBe(2);
    expect(log).toHaveLength(0);
  });

  it("--paid --dry-run prints estimates and requests nothing; a real run stores; over the cap is skipped with exit 2", async () => {
    const log = fake();
    const a = io();
    expect(await seoSnapshotCommand([], { all: true, paid: true, kinds: "backlinks,visibility", "dry-run": true }, a.io, deps([client("snap1.example.com")]) as never)).toBe(0);
    const out = JSON.parse(a.lines.join("\n"));
    expect(out.results[0]).toMatchObject({ client: "snap1.example.com", provider: "dataforseo", estimate: { usd: 0.03712, requests: 2 } });
    expect(log).toHaveLength(0);
    const b = io();
    expect(await seoSnapshotCommand([], { client: "snap1.example.com", all: false, paid: true, kinds: "backlinks,visibility", "dry-run": false }, b.io, deps([client("snap1.example.com")]) as never)).toBe(0);
    expect(JSON.parse(b.lines.join("\n")).results[0].stored).toEqual(["backlinks", "visibility"]);
    expect(snapshots("snap1.example.com").map((s) => s.kind).sort()).toEqual(["backlinks", "visibility"]);
    const c = io();
    expect(await seoSnapshotCommand([], { all: true, paid: true, kinds: "visibility", "dry-run": false }, c.io, deps([client("snap2.example.com")], 0.001) as never)).toBe(2);
    expect(JSON.parse(c.lines.join("\n")).skipped[0].reason).toContain("left this month");
  });
});
