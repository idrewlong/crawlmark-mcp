import { env, type Client } from "../config.js";
import { mergeSpendRows, spendKeys, type SpendRow } from "./spend.js";
import { db } from "./store.js";

export class BudgetExceededError extends Error {}

/** Providers billed in API units rather than USD (Phase 9). */
export type UnitProvider = "ahrefs" | "semrush";
const UNIT_LABEL: Record<UnitProvider, string> = { ahrefs: "Ahrefs", semrush: "Semrush" };
const UNIT_CAP_ENV: Record<UnitProvider, { global: string; client: string }> = {
  ahrefs: { global: "AHREFS_MONTHLY_UNIT_CAP", client: "DEFAULT_CLIENT_MONTHLY_AHREFS_UNITS" },
  semrush: { global: "SEMRUSH_MONTHLY_UNIT_CAP", client: "DEFAULT_CLIENT_MONTHLY_SEMRUSH_UNITS" },
};
/** The global monthly unit cap for a provider. */
export const globalUnitCap = (provider: UnitProvider): number => (provider === "ahrefs" ? env.AHREFS_MONTHLY_UNIT_CAP : env.SEMRUSH_MONTHLY_UNIT_CAP);

const currentMonth = () => new Date().toISOString().slice(0, 7); // YYYY-MM

const globalSpendStmt = db.prepare(
  "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM spend WHERE month = ?",
);
const recordStmt = db.prepare(
  "INSERT INTO spend (client, provider, endpoint, cost_usd, month, created_at) VALUES (?, ?, ?, ?, ?, ?)",
);
const recordUnitsStmt = db.prepare(
  "INSERT INTO spend (client, provider, endpoint, cost_usd, units, month, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
);
const globalUnitsStmt = db.prepare("SELECT COALESCE(SUM(units), 0) AS total FROM spend WHERE month = ? AND provider = ?");

/**
 * Spend this month for one ledger name, several (a client's key plus its
 * aliases, see spendKeys), or everything when omitted.
 */
export function spentThisMonth(client?: string | string[]): number {
  const month = currentMonth();
  if (client === undefined) return (globalSpendStmt.get(month) as { total: number }).total;
  const names = typeof client === "string" ? [client] : client;
  if (names.length === 0) return 0;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM spend WHERE month = ? AND client IN (${names.map(() => "?").join(", ")})`,
    )
    .get(month, ...names) as { total: number };
  return row.total;
}

/**
 * Throws before a paid call if it would push the client or the global total
 * past its monthly cap. `estimateUsd` is a conservative guess for the call.
 */
export function assertBudget(client: Client, estimateUsd: number): void {
  const clientSpent = spentThisMonth(spendKeys(client));
  if (clientSpent + estimateUsd > client.monthlyBudgetUsd) {
    throw new BudgetExceededError(
      `Budget cap hit for ${client.slug}: $${clientSpent.toFixed(4)} spent of ` +
        `$${client.monthlyBudgetUsd} this month. Raise monthlyBudgetUsd for this client in clients.yaml ` +
        "(or DEFAULT_CLIENT_MONTHLY_BUDGET_USD for every client) to continue.",
    );
  }
  const globalSpent = spentThisMonth();
  if (globalSpent + estimateUsd > env.GLOBAL_MONTHLY_BUDGET_USD) {
    throw new BudgetExceededError(
      `Global budget cap hit: $${globalSpent.toFixed(4)} of $${env.GLOBAL_MONTHLY_BUDGET_USD} this month.`,
    );
  }
}

/** Units used this month for one provider, by one ledger name, several (spendKeys), or everyone when omitted. */
export function unitsThisMonth(client: string | string[] | undefined, provider: UnitProvider): number {
  const month = currentMonth();
  if (client === undefined) return Number((globalUnitsStmt.get(month, provider) as { total: number }).total);
  const names = typeof client === "string" ? [client] : client;
  if (names.length === 0) return 0;
  const row = db
    .prepare(`SELECT COALESCE(SUM(units), 0) AS total FROM spend WHERE month = ? AND provider = ? AND client IN (${names.map(() => "?").join(", ")})`)
    .get(month, provider, ...names) as { total: number };
  return Number(row.total);
}

const fmtUnits = (n: number) => n.toLocaleString("en-US");

/**
 * Throws before an uncached Ahrefs or Semrush call if its estimate would push the
 * client (client.monthlyUnits) or everyone (<PROVIDER>_MONTHLY_UNIT_CAP) past this
 * month's unit cap. Unit calls never touch the USD caps (assertBudget).
 */
export function assertUnits(
  client: Pick<Client, "slug" | "aliases" | "domain" | "monthlyUnits">,
  provider: UnitProvider,
  estimateUnits: number,
  /** Estimates of calls already in progress (reserved, not yet recorded): this client's and everyone's. */
  pending: { client: number; global: number } = { client: 0, global: 0 },
): void {
  const label = UNIT_LABEL[provider];
  const reserved = (n: number) => (n > 0 ? ` (plus ${fmtUnits(n)} reserved by calls in progress)` : "");
  const used = unitsThisMonth(spendKeys(client), provider);
  const cap = client.monthlyUnits[provider];
  if (used + pending.client + estimateUnits > cap) {
    throw new BudgetExceededError(
      `${label} unit cap hit for ${client.domain}: ${fmtUnits(used)} of ${fmtUnits(cap)} units this month${reserved(pending.client)}. ` +
        `Raise monthlyUnits.${provider} in clients.yaml (or ${UNIT_CAP_ENV[provider].client}) to continue.`,
    );
  }
  const globalUsed = unitsThisMonth(undefined, provider);
  const globalCap = globalUnitCap(provider);
  if (globalUsed + pending.global + estimateUnits > globalCap) {
    throw new BudgetExceededError(
      `Global ${label} unit cap hit: ${fmtUnits(globalUsed)} of ${fmtUnits(globalCap)} units this month${reserved(pending.global)}. Raise ${UNIT_CAP_ENV[provider].global} to continue.`,
    );
  }
}

/** Record Ahrefs/Semrush units (cost_usd 0). Never stores a key: only the client, provider and endpoint path. */
export function recordUnits(client: string, provider: UnitProvider, endpoint: string, units: number): void {
  recordUnitsStmt.run(client, provider, endpoint, Math.max(0, Math.round(units)), currentMonth(), Date.now());
}

export function recordSpend(
  client: string,
  provider: string,
  endpoint: string,
  costUsd: number,
): void {
  recordStmt.run(client, provider, endpoint, costUsd, currentMonth(), Date.now());
}

/** `canonical` maps alias ledger names to the client's key, so old slug rows merge into their client. */
export function spendSummary(canonical: Map<string, string> = new Map()) {
  const month = currentMonth();
  const rows = db
    .prepare(
      `SELECT client, provider, COUNT(*) AS calls, ROUND(SUM(cost_usd), 4) AS cost_usd, SUM(units) AS units
       FROM spend WHERE month = ? GROUP BY client, provider ORDER BY cost_usd DESC, units DESC`,
    )
    .all(month) as unknown as SpendRow[];
  return {
    month,
    totalUsd: Number(spentThisMonth().toFixed(4)),
    globalCapUsd: env.GLOBAL_MONTHLY_BUDGET_USD,
    byClient: mergeSpendRows(rows, canonical),
    units: {
      ahrefs: { used: unitsThisMonth(undefined, "ahrefs"), globalCap: globalUnitCap("ahrefs") },
      semrush: { used: unitsThisMonth(undefined, "semrush"), globalCap: globalUnitCap("semrush") },
    },
  };
}
