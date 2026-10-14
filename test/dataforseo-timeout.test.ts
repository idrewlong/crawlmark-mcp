import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";

// test/setup.ts gives this file a temp DATA_DIR, so the spend ledger is a throwaway SQLite file.
// Fake credentials only so authHeader() passes; fetch is stubbed and nothing leaves the process.
process.env.DATAFORSEO_LOGIN ??= "test@example.com";
process.env.DATAFORSEO_PASSWORD ??= "test-password";
process.env.GLOBAL_MONTHLY_BUDGET_USD = "1000";

const client = {
  slug: "timeout.example",
  domain: "timeout.example",
  aliases: [],
  monthlyBudgetUsd: 100,
  locationCode: 2840,
  languageCode: "en",
} as unknown as Client;

const timeoutFetch = () =>
  vi.fn(async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });

async function ledger(): Promise<Array<{ endpoint: string; cost_usd: number }>> {
  const { db } = await import("../src/lib/store.js");
  return db.prepare("SELECT endpoint, cost_usd FROM spend WHERE client = ? ORDER BY id").all(client.slug) as Array<{ endpoint: string; cost_usd: number }>;
}

describe("DataForSEO calls that time out", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("record the estimate as spend for a paid live call", async () => {
    vi.stubGlobal("fetch", timeoutFetch());
    const { serp } = await import("../src/providers/dataforseo.js");
    await expect(serp(client, "timeout keyword")).rejects.toThrow(/timed out after 30s; DataForSEO may still have billed it/);
    const rows = await ledger();
    expect(rows).toContainEqual({ endpoint: "/serp/google/organic/live/regular (timeout, estimated)", cost_usd: 0.002 });
  });

  it("record the scaled estimate for a crawl and say a crawl may have started", async () => {
    vi.stubGlobal("fetch", timeoutFetch());
    const { onPageStartCrawl } = await import("../src/providers/dataforseo.js");
    await expect(onPageStartCrawl(client, 400)).rejects.toThrow(/a crawl may have started anyway/);
    const rows = await ledger();
    expect(rows).toContainEqual({ endpoint: "/on_page/task_post (timeout, estimated)", cost_usd: 0.18 });
  });

  it("record nothing for other failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { serp } = await import("../src/providers/dataforseo.js");
    const before = (await ledger()).length;
    await expect(serp(client, "network error keyword")).rejects.toThrow("fetch failed");
    expect((await ledger()).length).toBe(before);
  });
});
