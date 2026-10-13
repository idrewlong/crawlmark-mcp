import { env, type Client } from "../config.js";
import { db } from "./store.js";

export class BudgetExceededError extends Error {}

const currentMonth = () => new Date().toISOString().slice(0, 7); // YYYY-MM

const clientSpendStmt = db.prepare(
  "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM spend WHERE month = ? AND client = ?",
);
const globalSpendStmt = db.prepare(
  "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM spend WHERE month = ?",
);
const recordStmt = db.prepare(
  "INSERT INTO spend (client, provider, endpoint, cost_usd, month, created_at) VALUES (?, ?, ?, ?, ?, ?)",
);

export function spentThisMonth(client?: string): number {
  const month = currentMonth();
  const row = client
    ? (clientSpendStmt.get(month, client) as { total: number })
    : (globalSpendStmt.get(month) as { total: number });
  return row.total;
}

/**
 * Throws before a paid call if it would push the client or the global total
 * past its monthly cap. `estimateUsd` is a conservative guess for the call.
 */
export function assertBudget(client: Client, estimateUsd: number): void {
  const clientSpent = spentThisMonth(client.slug);
  if (clientSpent + estimateUsd > client.monthlyBudgetUsd) {
    throw new BudgetExceededError(
      `Budget cap hit for ${client.slug}: $${clientSpent.toFixed(4)} spent of ` +
        `$${client.monthlyBudgetUsd} this month. Raise monthlyBudgetUsd in clients.yaml to continue.`,
    );
  }
  const globalSpent = spentThisMonth();
  if (globalSpent + estimateUsd > env.GLOBAL_MONTHLY_BUDGET_USD) {
    throw new BudgetExceededError(
      `Global budget cap hit: $${globalSpent.toFixed(4)} of $${env.GLOBAL_MONTHLY_BUDGET_USD} this month.`,
    );
  }
}

export function recordSpend(
  client: string,
  provider: string,
  endpoint: string,
  costUsd: number,
): void {
  recordStmt.run(client, provider, endpoint, costUsd, currentMonth(), Date.now());
}

export function spendSummary() {
  const month = currentMonth();
  const rows = db
    .prepare(
      `SELECT client, provider, COUNT(*) AS calls, ROUND(SUM(cost_usd), 4) AS cost_usd
       FROM spend WHERE month = ? GROUP BY client, provider ORDER BY cost_usd DESC`,
    )
    .all(month);
  return {
    month,
    totalUsd: Number(spentThisMonth().toFixed(4)),
    globalCapUsd: env.GLOBAL_MONTHLY_BUDGET_USD,
    byClient: rows,
  };
}
