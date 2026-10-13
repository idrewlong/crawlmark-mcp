/**
 * Phase 12 B-2: check_ranks (free Search Console mode, paid live mode behind one pre-flight
 * cap check, estimateOnly), the rank-drop alert rule and its webhook line, and the
 * `check-ranks` scheduled runner (exit codes, per-client caps, dry run, a local fake webhook).
 * Every source is an injected fake; the only socket is a loopback HTTP server in this file.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { formatAlertText, type Alert } from "../src/analysis/alerts.js";
import { rankDropAlert } from "../src/analysis/ranks.js";
import type { Client } from "../src/config.js";
import { BudgetExceededError } from "../src/lib/budget.js";
import { ProviderUnavailableError } from "../src/lib/provider-ids.js";
import { readRanks, recordLiveRank, saveRanks } from "../src/lib/rank-history.js";
import { sendWebhook } from "../src/lib/webhook.js";
import type { GscQueryOptions, GscRow } from "../src/providers/gsc.js";
import { checkRanks, keywordRegexes, type CheckRanksDeps, type CheckRanksEstimate, type CheckRanksResult } from "../src/ranks.js";
import { runRankChecks } from "../src/scheduled.js";

const TODAY = new Date("2026-10-13T08:00:00Z");

function makeClient(slug: string, extra: Partial<Client> = {}): Client {
  return {
    slug, domain: slug, name: "Example Co", aliases: [], sources: [], brandTerms: [], brandTermEntries: [], competitors: [], competitorEntries: [],
    trackedKeywords: ["plumber example city", "drain repair"], keywordEntries: [], keyPages: [`https://${slug}/`], alternates: { gsc: [], ga4: [] },
    locationCode: 2840, languageCode: "en", monthlyBudgetUsd: 5, country: "US", monthlyUnits: { ahrefs: 10_000, semrush: 5_000 },
    gscProperty: `sc-domain:${slug}`, ...extra,
  } as Client;
}

interface Fake extends CheckRanksDeps {
  log: string[];
}

function fakeDeps(o: { ranks?: Record<string, number | null>; gscFails?: boolean; budgetLeft?: number; dfs?: boolean } = {}): Fake {
  const log: string[] = [];
  return {
    log,
    googleConfigured: () => true,
    gscQuery: async (_c: Client, q: GscQueryOptions): Promise<GscRow[]> => {
      log.push(`gsc:${q.dimensions?.join(",")}`);
      if (o.gscFails) throw new Error("Search Console said no");
      if (q.dimensions?.length === 2) {
        return [
          { keys: ["plumber example city", "https://example.com/plumbing"], clicks: 9, impressions: 120, ctr: 7.5, position: 5.2 },
          { keys: ["plumber example city", "https://example.com/"], clicks: 1, impressions: 40, ctr: 2.5, position: 9 },
        ];
      }
      return [{ keys: ["Plumber Example City"], clicks: 10, impressions: 150, ctr: 6.7, position: 5.6 }];
    },
    requireSerp: () => {
      if (o.dfs === false) throw new ProviderUnavailableError("serpLive", "ahrefs", "Live SERP checks need DataForSEO; ahrefs (the provider for example.com) doesn't offer them. Run setup --step dataforseo.");
      return {};
    },
    serp: async (_c, k) => {
      log.push(`serp:${k}`);
      return { clientRank: o.ranks?.[k] ?? null, clientUrl: o.ranks?.[k] ? "https://example.com/plumbing" : null, costUsd: 0.002, fromCache: false };
    },
    withUsdReservation: async (c, usd, fn) => {
      log.push(`budget:${usd}`);
      if (o.budgetLeft !== undefined && usd > o.budgetLeft) throw new BudgetExceededError(`Budget cap hit for ${c.slug}: $4.9990 spent of $5 this month.`);
      return fn();
    },
    remainingUsd: () => ({ clientUsd: o.budgetLeft ?? 4.71, globalUsd: 40 }),
    serpEstimateUsd: 0.002,
  };
}

describe("check_ranks, Search Console mode (free)", () => {
  it("makes no paid call, stores one gsc row per tracked keyword, and keeps one row per keyword on a second run the same day", async () => {
    const c = makeClient("gsc-mode.example.com");
    const deps = fakeDeps();
    const r = (await checkRanks(c, { today: TODAY }, deps)) as CheckRanksResult;
    expect(deps.log).toEqual(["gsc:query", "gsc:query,page"]);
    expect(r).toMatchObject({ day: "2026-10-13", gscWindow: { startDate: "2026-10-04", endDate: "2026-10-10" }, live: false, saved: 2, costUsd: 0 });
    expect(r.results[0]).toEqual({
      keyword: "plumber example city",
      gsc: { position: 5.6, clicks: 10, impressions: 150, page: "https://example.com/plumbing" },
      live: null,
      previous: { gsc: null, live: null },
      change: { gsc: null, live: null },
    });
    expect(r.results[1]!.gsc).toEqual({ position: null, clicks: 0, impressions: 0, page: null });
    await checkRanks(c, { today: TODAY }, fakeDeps());
    expect(readRanks({ client: c.slug, since: "2026-01-01", until: "2026-12-31" })).toHaveLength(2);
  });

  it("reports the change against the previous stored window", async () => {
    const c = makeClient("gsc-change.example.com");
    saveRanks(c, [{ keyword: "plumber example city", source: "gsc", day: "2026-10-03", rank: 8.4, market: "all", language: "all", device: "all" }]);
    const r = (await checkRanks(c, { today: TODAY }, fakeDeps())) as CheckRanksResult;
    expect(r.results[0]).toMatchObject({ previous: { gsc: 8.4 }, change: { gsc: -2.8 } });
  });

  it("works for a client whose data provider is Ahrefs (Search Console needs no DataForSEO)", async () => {
    const deps = fakeDeps({ dfs: false });
    const r = (await checkRanks(makeClient("ahrefs-client.example.com", { dataProvider: "ahrefs" }), { today: TODAY }, deps)) as CheckRanksResult;
    expect(r.saved).toBe(2);
    expect(deps.log.some((l) => l.startsWith("serp"))).toBe(false);
  });

  it("needs Search Console unless live, and only checks tracked keywords", async () => {
    await expect(checkRanks(makeClient("no-gsc.example.com", { gscProperty: undefined } as Partial<Client>), { today: TODAY }, fakeDeps())).rejects.toThrow(/needs Search Console .* or live: true/);
    await expect(checkRanks(makeClient("subset.example.com"), { keywords: ["Drain  Repair", "not tracked"] }, fakeDeps())).rejects.toThrow(/Not tracked for subset.example.com: "not tracked"/);
    await expect(checkRanks(makeClient("none.example.com", { trackedKeywords: [] }), {}, fakeDeps())).rejects.toThrow(/has no tracked keywords/);
  });
});

describe("check_ranks, live mode (paid)", () => {
  it("estimates n x the SERP estimate, checks the budget once with the total before the first request, and stores serp rows", async () => {
    const c = makeClient("live.example.com");
    const deps = fakeDeps({ ranks: { "plumber example city": 4 } });
    const r = (await checkRanks(c, { live: true, today: TODAY }, deps)) as CheckRanksResult;
    expect(deps.log[0]).toBe("budget:0.004");
    expect(deps.log.filter((l) => l.startsWith("budget"))).toHaveLength(1);
    expect(deps.log.filter((l) => l.startsWith("serp"))).toEqual(["serp:plumber example city", "serp:drain repair"]);
    expect(r).toMatchObject({ live: true, saved: 4, costUsd: 0.004, estimate: { provider: "dataforseo", usd: 0.004, requests: 2 } });
    expect(r.results[0]!.live).toEqual({ rank: 4, url: "https://example.com/plumbing" });
    expect(readRanks({ client: c.slug, since: "2026-10-13", until: "2026-10-13", source: "serp" }).map((x) => [x.keyword, x.rank, x.market, x.depth])).toEqual([
      ["drain repair", null, "2840", 100],
      ["plumber example city", 4, "2840", 100],
    ]);
  });

  it("makes no request when the cap would be exceeded", async () => {
    const deps = fakeDeps({ budgetLeft: 0.001 });
    await expect(checkRanks(makeClient("over-cap.example.com"), { live: true, today: TODAY }, deps)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(deps.log).toEqual(["budget:0.004"]);
  });

  it("estimateOnly returns the estimate and remaining caps, makes no request and writes nothing", async () => {
    const c = makeClient("estimate.example.com");
    const deps = fakeDeps();
    const r = (await checkRanks(c, { live: true, estimateOnly: true, today: TODAY }, deps)) as CheckRanksEstimate;
    expect(r).toMatchObject({ estimate: { provider: "dataforseo", usd: 0.004, requests: 2 }, remaining: { clientUsd: 4.71, globalUsd: 40 }, wouldExceed: false, keywords: ["plumber example city", "drain repair"] });
    expect(deps.log).toEqual([]);
    expect(readRanks({ client: c.slug, since: "2000-01-01", until: "2100-01-01" })).toEqual([]);
    expect(((await checkRanks(c, { live: true, estimateOnly: true }, fakeDeps({ budgetLeft: 0.001 }))) as CheckRanksEstimate).wouldExceed).toBe(true);
  });

  it("is unavailable, before any request, when DataForSEO can't serve live SERPs", async () => {
    const deps = fakeDeps({ dfs: false });
    await expect(checkRanks(makeClient("no-dfs.example.com"), { live: true }, deps)).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(checkRanks(makeClient("no-dfs.example.com"), { live: true, estimateOnly: true }, deps)).rejects.toThrow(/setup --step dataforseo/);
    expect(deps.log).toEqual([]);
  });

  it("lists rank drops against the previous live check in the same market", async () => {
    const c = makeClient("drops.example.com");
    saveRanks(c, [
      { keyword: "plumber example city", source: "serp", day: "2026-10-06", rank: 3, market: "2840", language: "en" },
      { keyword: "drain repair", source: "serp", day: "2026-10-06", rank: 12, market: "2840", language: "en" },
    ]);
    const r = (await checkRanks(c, { live: true, today: TODAY, rankDropThreshold: 5 }, fakeDeps({ ranks: { "plumber example city": 14, "drain repair": 15 } }))) as CheckRanksResult;
    expect(r.rankDrops).toEqual([{ keyword: "plumber example city", previousRank: 3, currentRank: 14 }]);
    expect(r.results[0]!.change.live).toBe(11);
  });
});

describe("rank-drop alert rule", () => {
  it("alerts on leaving the top 10, on not found, and on a drop of at least the threshold", () => {
    expect(rankDropAlert("k", 8, 11, 5)).toEqual({ keyword: "k", previousRank: 8, currentRank: 11 });
    expect(rankDropAlert("k", 10, null, 5)).toEqual({ keyword: "k", previousRank: 10, currentRank: null });
    expect(rankDropAlert("k", 20, 25, 5)).not.toBeNull();
  });

  it("R-4: a found keyword that is now not found alerts at any earlier position", () => {
    expect(rankDropAlert("k", 30, null, 5)).toEqual({ keyword: "k", previousRank: 30, currentRank: null });
    expect(rankDropAlert("k", 97, null, 5)).toEqual({ keyword: "k", previousRank: 97, currentRank: null });
    expect(rankDropAlert("k", 30, 33, 5)).toBeNull();
  });

  it("doesn't alert on improvements, small drops, first checks or a keyword that wasn't found before", () => {
    expect(rankDropAlert("k", 9, 4, 5)).toBeNull();
    expect(rankDropAlert("k", 20, 24, 5)).toBeNull();
    expect(rankDropAlert("k", 3, 7, 5)).toBeNull();
    expect(rankDropAlert("k", undefined, 50, 5)).toBeNull();
    expect(rankDropAlert("k", null, null, 5)).toBeNull();
  });

  it("formats the webhook line with the keyword sanitised and mrkdwn-escaped", () => {
    const a: Alert = { kind: "rank-drop", client: "example.com", keyword: "<b>pipes</b> & \u202edrains\n", previousRank: 3, currentRank: null, source: "serp" };
    const text = formatAlertText([a]);
    expect(text).toBe('crawlmark: 1 alert\n[rank] example.com: "&lt;b&gt;pipes&lt;/b&gt; &amp; drains " live rank 3 to not found');
    expect(text).not.toMatch(/[<>\u202e]/);
  });
});

describe("live rank side effects (monthly_report liveRanks, serp_check)", () => {
  it("records a live rank for a tracked keyword only", () => {
    const c = makeClient("side.example.com");
    expect(recordLiveRank(c, "Drain Repair", { clientRank: 6, clientUrl: null }, { now: TODAY })).toBe(true);
    expect(recordLiveRank(c, "untracked words", { clientRank: 1, clientUrl: null }, { now: TODAY })).toBe(false);
    expect(readRanks({ client: c.slug, since: "2026-10-13", until: "2026-10-13" }).map((r) => r.keyword)).toEqual(["drain repair"]);
  });
});

describe("keywordRegexes", () => {
  it("escapes RE2 metacharacters and splits long lists", () => {
    expect(keywordRegexes(["a.b", "c+d (e)"])).toEqual(["(?i)^(?:a\\.b|c\\+d \\(e\\))$"]);
    const many = Array.from({ length: 200 }, (_, i) => `keyword number ${i} with some padding text`);
    const res = keywordRegexes(many);
    expect(res.length).toBeGreaterThan(1);
    for (const r of res) expect(r.length).toBeLessThanOrEqual(3_500);
  });
});

describe("crawlmark-cli check-ranks (runRankChecks)", () => {
  const noWebhook = async () => ({ sent: false as const, reason: "test" });

  it("free run: exit 0, rows stored, clients without tracked keywords skipped", async () => {
    const report = await runRankChecks([makeClient("cli-a.example.com"), makeClient("cli-empty.example.com", { trackedKeywords: [] })], { live: false, rankDropThreshold: 5, deps: fakeDeps(), send: noWebhook, today: TODAY });
    expect(report).toMatchObject({ command: "check-ranks", exitCode: 0, alerts: [], skipped: [{ client: "cli-empty.example.com", reason: "no tracked keywords" }] });
    expect(report.results[0]).toMatchObject({ client: "cli-a.example.com", checked: 2, saved: 2 });
  });

  it("--live: a client over its cap is skipped with the cap message and the others run", async () => {
    const deps = fakeDeps({ ranks: { "plumber example city": 2 } });
    const reserve = deps.withUsdReservation;
    deps.withUsdReservation = async (c, usd, fn) => {
      if (c.slug === "cli-over.example.com") throw new BudgetExceededError(`Budget cap hit for ${c.slug}: $5.0000 spent of $5 this month.`);
      return reserve(c, usd, fn);
    };
    const report = await runRankChecks([makeClient("cli-over.example.com"), makeClient("cli-ok.example.com")], { live: true, rankDropThreshold: 5, deps, send: noWebhook, today: TODAY });
    expect(report.exitCode).toBe(0);
    expect(report.skipped).toEqual([{ client: "cli-over.example.com", reason: expect.stringMatching(/^Budget cap hit for cli-over/) }]);
    expect(report.results.map((r) => r.client)).toEqual(["cli-ok.example.com"]);
    expect(deps.log.filter((l) => l.startsWith("serp"))).toHaveLength(2);
  });

  it("--dry-run lists keywords and the estimate and calls nothing", async () => {
    const deps = fakeDeps();
    const report = await runRankChecks([makeClient("cli-dry.example.com")], { live: true, rankDropThreshold: 5, dryRun: true, deps, send: noWebhook, today: TODAY });
    expect(report.results).toEqual([
      {
        client: "cli-dry.example.com",
        wouldCheck: ["plumber example city", "drain repair"],
        gscWindow: { startDate: "2026-10-04", endDate: "2026-10-10" },
        live: true,
        estimate: { provider: "dataforseo", usd: 0.004, requests: 2 },
        remaining: { clientUsd: 4.71, globalUsd: 40 },
        wouldExceed: false,
      },
    ]);
    expect(deps.log).toEqual([]);
    expect(report.webhook).toEqual({ sent: false, reason: "dry run" });
  });

  it("exit 1 when every client fails", async () => {
    const report = await runRankChecks([makeClient("cli-fail.example.com")], { live: false, rankDropThreshold: 5, deps: fakeDeps({ gscFails: true }), send: noWebhook, today: TODAY });
    expect(report.exitCode).toBe(1);
    expect(report.skipped[0]!.reason).toMatch(/^error: Search Console said no/);
  });

  it("--live sends a rank-drop alert to a local fake webhook and exits 2", async () => {
    const received: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        received.push(body);
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const c = makeClient("cli-alert.example.com");
      saveRanks(c, [{ keyword: "plumber example city", source: "serp", day: "2026-10-06", rank: 4, market: "2840", language: "en" }]);
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
      const report = await runRankChecks([c], {
        live: true,
        rankDropThreshold: 5,
        deps: fakeDeps({ ranks: { "plumber example city": 18 } }),
        webhookUrl: url,
        send: (u, t) => sendWebhook(u, t, { env: { ALLOW_PRIVATE_URLS: "true" } }),
        today: TODAY,
      });
      expect(report.exitCode).toBe(2);
      expect(report.alerts).toEqual([{ kind: "rank-drop", client: "cli-alert.example.com", keyword: "plumber example city", previousRank: 4, currentRank: 18, source: "serp" }]);
      expect(report.webhook).toEqual({ sent: true, status: 200 });
      expect(JSON.parse(received[0]!)).toEqual({ text: 'crawlmark: 1 alert\n[rank] cli-alert.example.com: "plumber example city" live rank 4 to 18' });
    } finally {
      server.close();
    }
  });
});

describe("check-ranks help", async () => {
  const { groupHelp, HELP_GROUPS, topHelp } = await import("../src/cli-help.js");
  const { CLI_SUBCOMMANDS } = await import("../src/lib/entry.js");
  it("lists its flags within 80 columns and is a CLI subcommand", () => {
    const text = groupHelp("check-ranks", { prog: "crawlmark-cli", bold: false });
    for (const f of ["--client", "--all", "--live", "--dry-run", "ALERT_RANK_DROP"]) expect(text).toContain(f);
    expect(Math.max(...text.split("\n").map((l) => l.length))).toBeLessThanOrEqual(80);
    expect(HELP_GROUPS).toContain("check-ranks");
    expect(CLI_SUBCOMMANDS).toContain("check-ranks");
    expect(topHelp({ prog: "crawlmark-cli", bold: false })).toContain("check-ranks");
  });
});

describe("R-1: a shallow serp_check miss doesn't overwrite the day's live rank", () => {
  it("skips a not-found result from depth < 100 but keeps found ranks at any depth", () => {
    const c = makeClient("shallow.example.com");
    expect(recordLiveRank(c, "drain repair", { clientRank: 14, clientUrl: "https://shallow.example.com/drains" }, { now: TODAY })).toBe(true);
    // serp_check with depth 10 doesn't find the site: says nothing about position 14.
    expect(recordLiveRank(c, "drain repair", { clientRank: null, clientUrl: null }, { now: TODAY, depth: 10 })).toBe(false);
    expect(readRanks({ client: c.slug, since: "2026-10-13", until: "2026-10-13" }).map((r) => [r.rank, r.depth])).toEqual([[14, 100]]);
    // A found rank from a shallow check is real and replaces the day's row.
    expect(recordLiveRank(c, "drain repair", { clientRank: 6, clientUrl: null }, { now: TODAY, depth: 10 })).toBe(true);
    expect(readRanks({ client: c.slug, since: "2026-10-13", until: "2026-10-13" }).map((r) => [r.rank, r.depth])).toEqual([[6, 10]]);
    // A full-depth miss is stored (not in the top 100).
    expect(recordLiveRank(c, "drain repair", { clientRank: null, clientUrl: null }, { now: TODAY })).toBe(true);
  });
});

describe("R-2: failed live checks", () => {
  const failingSerp = (fail: (k: string) => boolean) => {
    const d = fakeDeps({ ranks: { "plumber example city": 3, "drain repair": 9 } });
    const serp = d.serp;
    d.serp = async (c, k) => {
      if (fail(k)) throw new Error("DataForSEO /serp/google/organic/live/regular HTTP 500: upstream");
      return serp(c, k);
    };
    return d;
  };
  const noWebhook = async () => ({ sent: false as const, reason: "test" });

  it("checkRanks notes any failed live check", async () => {
    const r = (await checkRanks(makeClient("r2-note.example.com"), { live: true, today: TODAY }, failingSerp((k) => k === "drain repair"))) as CheckRanksResult;
    expect(r.notes).toContain("1 of 2 live check(s) failed; see liveError on each result.");
    expect(r.results[1]!.liveError).toMatch(/HTTP 500/);
  });

  it("check-ranks --live exits 1 when every live check failed (even though Search Console worked)", async () => {
    const report = await runRankChecks([makeClient("r2-all.example.com")], { live: true, rankDropThreshold: 5, deps: failingSerp(() => true), send: noWebhook, today: TODAY });
    expect(report.exitCode).toBe(1);
    expect(report.skipped[0]).toMatchObject({ client: "r2-all.example.com", reason: expect.stringMatching(/^error: every live check failed/) });
  });

  it("some live checks failing doesn't fail the client; an alert from the others still exits 2", async () => {
    const c = makeClient("r2-some.example.com");
    saveRanks(c, [{ keyword: "plumber example city", source: "serp", day: "2026-10-06", rank: 2, market: "2840", language: "en" }]);
    const d = fakeDeps({ ranks: { "plumber example city": 15 } });
    const serp = d.serp;
    d.serp = async (cl, k) => {
      if (k === "drain repair") throw new Error("DataForSEO /serp/google/organic/live/regular HTTP 500: upstream");
      return serp(cl, k);
    };
    const report = await runRankChecks([c], { live: true, rankDropThreshold: 5, deps: d, send: noWebhook, today: TODAY });
    expect(report.exitCode).toBe(2);
    expect(report.results[0]).toMatchObject({ client: "r2-some.example.com", notes: ["1 of 2 live check(s) failed; see liveError on each result."] });
  });
});
