import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";

// A task that comes back with an error status (e.g. 40102 No Search Results) can still be billed.
// Temp DATA_DIR from test/setup.ts; fake credentials; fetch is stubbed and nothing leaves the process.
process.env.DATAFORSEO_LOGIN ??= "test@example.com";
process.env.DATAFORSEO_PASSWORD ??= "test-password";
process.env.GLOBAL_MONTHLY_BUDGET_USD = "1000";

const client = {
  slug: "failed-task.example",
  domain: "failed-task.example",
  aliases: [],
  monthlyBudgetUsd: 100,
  locationCode: 2840,
  languageCode: "en",
} as unknown as Client;

const taskFetch = (status_code: number, status_message: string, cost: number) =>
  vi.fn(async () => new Response(JSON.stringify({ status_code: 20000, status_message: "Ok.", cost, tasks: [{ id: "t1", status_code, status_message, cost, result: null }] }), { status: 200 }));

async function ledger(): Promise<Array<{ endpoint: string; cost_usd: number }>> {
  const { db } = await import("../src/lib/store.js");
  return db.prepare("SELECT endpoint, cost_usd FROM spend WHERE client = ? ORDER BY id").all(client.slug) as Array<{ endpoint: string; cost_usd: number }>;
}

describe("DataForSEO tasks that fail but are billed", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("record the charged cost and explain a business lookup with no listing", async () => {
    vi.stubGlobal("fetch", taskFetch(40102, "No Search Results.", 0.0054));
    const { myBusinessInfo } = await import("../src/providers/dataforseo.js");
    await expect(myBusinessInfo(client, { keyword: "No Such Business Example", location_code: 2840, language_code: "en" })).rejects.toThrow(
      /no Business Profile matching that search[\s\S]*charged \$0\.0054/,
    );
    expect(await ledger()).toContainEqual({ endpoint: "/business_data/google/my_business_info/live (failed)", cost_usd: 0.0054 });
  });

  it("record nothing when the failed task wasn't charged", async () => {
    vi.stubGlobal("fetch", taskFetch(40501, "Invalid Field.", 0));
    const { serp } = await import("../src/providers/dataforseo.js");
    const before = (await ledger()).length;
    await expect(serp(client, "unbilled failure keyword")).rejects.toThrow(/40501: Invalid Field/);
    expect((await ledger()).length).toBe(before);
  });
});
