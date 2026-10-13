/**
 * R-5 (Phase 12 B fix round): check_ranks live always fetches a fresh SERP, while serp_check keeps its
 * one-day cache. DataForSEO is a stubbed fetch on the closed local port; no real network.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";
import { serp } from "../src/providers/seo-data.js";
import { loadCheckRanksDeps } from "../src/ranks.js";

const FIX = readFileSync(new URL("./fixtures/dataforseo/serp_google_organic_live_regular.json", import.meta.url), "utf8");
afterEach(() => vi.unstubAllGlobals());

const client = {
  slug: "fresh.example.com", domain: "fresh.example.com", name: "Example Co", aliases: [], trackedKeywords: ["drain repair"], competitors: [],
  locationCode: 2840, languageCode: "en", monthlyBudgetUsd: 5, monthlyUnits: { ahrefs: 10_000, semrush: 5_000 },
} as unknown as Client;

describe("check_ranks live SERPs are fresh", () => {
  it("bypasses the one-day cache that serp_check uses", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (new URL(input).hostname !== "127.0.0.1") throw new Error("real host");
      return new Response(FIX, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await serp(client, "drain repair");
    await serp(client, "drain repair");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const deps = await loadCheckRanksDeps();
    const r = await deps.serp(client, "drain repair");
    await deps.serp(client, "drain repair");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(r.fromCache).toBe(false);
  });
});

describe("report templates' live ranks", () => {
  it("are saved to rank history for tracked keywords", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(FIX, { status: 200 })));
    const { loadDefaultRunDeps } = await import("../src/reports/templates/run.js");
    const { readRanks } = await import("../src/lib/rank-history.js");
    const deps = await loadDefaultRunDeps();
    const c = { ...client, slug: "template-live.example.com", domain: "template-live.example.com" } as Client;
    await deps.serp(c, "drain repair");
    await deps.serp(c, "untracked words");
    const today = new Date().toISOString().slice(0, 10);
    expect(readRanks({ client: c.slug, since: today, until: today }).map((r) => [r.keyword, r.source])).toEqual([["drain repair", "serp"]]);
  });
});
