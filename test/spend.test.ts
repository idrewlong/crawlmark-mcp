import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalSpendNames, mergeSpendRows, spendKeys } from "../src/lib/spend.js";

// The ledger is real SQLite in a throwaway DATA_DIR. src/config.ts is only
// imported dynamically below, after these are set (it never overrides
// variables that are already set).
const dataDir = mkdtempSync(join(tmpdir(), "crawlmark-spend-"));
process.env.DATA_DIR = dataDir;
process.env.GLOBAL_MONTHLY_BUDGET_USD = "1000";

const client = { slug: "example.com", aliases: ["old-slug"], monthlyBudgetUsd: 5 };

describe("spend helpers", () => {
  it("spendKeys is the canonical key plus aliases, deduplicated", () => {
    expect(spendKeys(client)).toEqual(["example.com", "old-slug"]);
    expect(spendKeys({ slug: "a.example", aliases: ["a.example"] })).toEqual(["a.example"]);
  });

  it("mergeSpendRows folds alias rows into their client and re-sorts by cost", () => {
    const canonical = canonicalSpendNames([client, { slug: "example.org", aliases: [] }]);
    const rows = mergeSpendRows(
      [
        { client: "old-slug", provider: "dataforseo", calls: 2, cost_usd: 0.3 },
        { client: "example.com", provider: "dataforseo", calls: 1, cost_usd: 0.1 },
        { client: "example.org", provider: "dataforseo", calls: 1, cost_usd: 0.35 },
        { client: "gone.example", provider: "dataforseo", calls: 1, cost_usd: 0.01 },
      ],
      canonical,
    );
    expect(rows).toEqual([
      { client: "example.com", provider: "dataforseo", calls: 3, cost_usd: 0.4 },
      { client: "example.org", provider: "dataforseo", calls: 1, cost_usd: 0.35 },
      { client: "gone.example", provider: "dataforseo", calls: 1, cost_usd: 0.01 },
    ]);
  });
});

describe("budget ledger (SQLite)", () => {
  it("uses the temp data dir", async () => {
    const { env } = await import("../src/config.js");
    expect(env.DATA_DIR).toBe(dataDir);
  });

  it("counts spend recorded under an old yaml slug toward the client's cap", async () => {
    const { assertBudget, recordSpend, spendSummary, spentThisMonth, BudgetExceededError } = await import("../src/lib/budget.js");
    recordSpend("old-slug", "dataforseo", "/old", 4);
    recordSpend("example.com", "dataforseo", "/new", 0.5);

    expect(spentThisMonth("example.com")).toBeCloseTo(0.5);
    expect(spentThisMonth(spendKeys(client))).toBeCloseTo(4.5);
    expect(spentThisMonth([])).toBe(0);

    // 4.5 spent of 5: a 0.4 call fits, a 0.6 call doesn't.
    expect(() => assertBudget(client as never, 0.4)).not.toThrow();
    expect(() => assertBudget(client as never, 0.6)).toThrow(BudgetExceededError);

    const summary = spendSummary(canonicalSpendNames([client]));
    expect(summary.byClient).toEqual([{ client: "example.com", provider: "dataforseo", calls: 2, cost_usd: 4.5 }]);
    expect(spendSummary().byClient).toHaveLength(2);
  });
});
