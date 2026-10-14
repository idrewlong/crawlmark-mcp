import { AsyncLocalStorage } from "node:async_hooks";
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

interface UsdReservation {
  keys: string[];
  usd: number;
  /** Phase 12 C5: the part of `usd` that is AI visibility, which also counts against AI_VISIBILITY_MONTHLY_BUDGET_USD. */
  aiUsd?: number;
}

/**
 * USD estimates of DataForSEO operations in progress in this process (SEC-1, like unitsCall's units).
 * assertBudget and remainingUsd count them, so calls started together can't each pass a check their sum
 * would fail. A call never counts its own reservation (AsyncLocalStorage), so the per-request checks inside
 * a reserved operation aren't double-counted. Per process: a cron run and the MCP server can each pass.
 */
const usdInFlight = new Set<UsdReservation>();
/** The reservations of the operation running here and of every operation it runs inside (nested reservations). */
const currentReservation = new AsyncLocalStorage<ReadonlySet<UsdReservation>>();

/** Reserved USD of calls in progress (other than the caller's own): this client's and everyone's. */
export function pendingUsd(keys: readonly string[]): { client: number; global: number } {
  const own = currentReservation.getStore();
  let client = 0;
  let global = 0;
  for (const r of usdInFlight) {
    if (own?.has(r)) continue;
    global += r.usd;
    if (r.keys.some((k) => keys.includes(k))) client += r.usd;
  }
  return { client, global };
}

const reservedNote = (n: number) => (n > 0 ? ` (plus $${n.toFixed(4)} reserved by calls in progress)` : "");

/**
 * Throws before a paid call if it would push the client or the global total
 * past its monthly cap. `estimateUsd` is a conservative guess for the call.
 * Estimates reserved by other calls in progress count too.
 */
export function assertBudget(client: Client, estimateUsd: number): void {
  const pending = pendingUsd(spendKeys(client));
  const clientSpent = spentThisMonth(spendKeys(client));
  if (clientSpent + pending.client + estimateUsd > client.monthlyBudgetUsd) {
    throw new BudgetExceededError(
      `Budget cap hit for ${client.slug}: $${clientSpent.toFixed(4)} spent of ` +
        `$${client.monthlyBudgetUsd} this month${reservedNote(pending.client)}. Raise monthlyBudgetUsd for this client in clients.yaml ` +
        "(or DEFAULT_CLIENT_MONTHLY_BUDGET_USD for every client) to continue.",
    );
  }
  const globalSpent = spentThisMonth();
  if (globalSpent + pending.global + estimateUsd > env.GLOBAL_MONTHLY_BUDGET_USD) {
    throw new BudgetExceededError(
      `Global budget cap hit: $${globalSpent.toFixed(4)} of $${env.GLOBAL_MONTHLY_BUDGET_USD} this month${reservedNote(pending.global)}.`,
    );
  }
}

/**
 * Check `usd` against the caps and reserve it (synchronously, before any await) for as long as `fn` runs,
 * so a multi-request operation's whole estimate counts against concurrent calls. Released in finally.
 */
export async function withUsdReservation<T>(client: Client, usd: number, fn: () => Promise<T>, opts: { aiUsd?: number } = {}): Promise<T> {
  // Phase 12 C5: an operation with an AI-visibility share is also checked, and reserved, against the AI sub-cap.
  if (opts.aiUsd) assertAiBudget(opts.aiUsd);
  assertBudget(client, usd);
  const r: UsdReservation = { keys: spendKeys(client), usd, ...(opts.aiUsd ? { aiUsd: opts.aiUsd } : {}) };
  usdInFlight.add(r);
  try {
    return await currentReservation.run(new Set([...(currentReservation.getStore() ?? []), r]), fn);
  } finally {
    usdInFlight.delete(r);
  }
}

// ------------------------------------------------------------------ AI visibility sub-cap (Phase 12 C5)

/** Ledger rows of AI-visibility calls: DataForSEO AI Optimization endpoints (timeouts included). */
export const AI_ENDPOINT_PREFIX = "/ai_optimization/";
const aiSpendStmt = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM spend WHERE month = ? AND provider = 'dataforseo' AND endpoint LIKE ?");

/** AI-visibility spend this month, every client together. */
export function aiVisibilitySpentThisMonth(): number {
  return Number((aiSpendStmt.get(currentMonth(), `${AI_ENDPOINT_PREFIX}%`) as { total: number }).total);
}

/** AI-visibility USD reserved by other calls in progress (never the caller's own). */
function pendingAiUsd(): number {
  const own = currentReservation.getStore();
  let n = 0;
  for (const r of usdInFlight) if (r.aiUsd && !own?.has(r)) n += r.aiUsd;
  return n;
}

/** What's left of AI_VISIBILITY_MONTHLY_BUDGET_USD this month (reservations in progress included); never below 0. */
export function remainingAiUsd(): { capUsd: number; spentUsd: number; remainingUsd: number } {
  const spent = aiVisibilitySpentThisMonth();
  return { capUsd: env.AI_VISIBILITY_MONTHLY_BUDGET_USD, spentUsd: Number(spent.toFixed(4)), remainingUsd: Number(Math.max(0, env.AI_VISIBILITY_MONTHLY_BUDGET_USD - spent - pendingAiUsd()).toFixed(4)) };
}

/** Throws before an AI-visibility request that would push this month's AI spend past its own sub-cap. */
export function assertAiBudget(estimateUsd: number): void {
  const spent = aiVisibilitySpentThisMonth();
  const pending = pendingAiUsd();
  if (spent + pending + estimateUsd > env.AI_VISIBILITY_MONTHLY_BUDGET_USD) {
    throw new BudgetExceededError(
      `AI visibility cap hit: $${spent.toFixed(4)} of $${env.AI_VISIBILITY_MONTHLY_BUDGET_USD} this month${reservedNote(pending)}, and this call needs about $${estimateUsd.toFixed(4)}. ` +
        "Raise AI_VISIBILITY_MONTHLY_BUDGET_USD to continue (each LLM Mentions request costs at least $0.10).",
    );
  }
}

/**
 * Like withUsdReservation, for an AI-visibility call: checks the AI sub-cap and the client and global caps, then
 * reserves the estimate against all three until `fn` ends.
 */
export function withAiUsdReservation<T>(client: Client, usd: number, fn: () => Promise<T>): Promise<T> {
  return withUsdReservation(client, usd, fn, { aiUsd: usd });
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

/** USD left this month for a client (its monthlyBudgetUsd) and for everyone (GLOBAL_MONTHLY_BUDGET_USD); never below 0. Phase 12 B estimates. */
export function remainingUsd(client: Pick<Client, "slug" | "aliases" | "monthlyBudgetUsd">): { clientUsd: number; globalUsd: number } {
  const r4 = (n: number) => Number(Math.max(0, n).toFixed(4));
  const pending = pendingUsd(spendKeys(client));
  return {
    clientUsd: r4(client.monthlyBudgetUsd - spentThisMonth(spendKeys(client)) - pending.client),
    globalUsd: r4(env.GLOBAL_MONTHLY_BUDGET_USD - spentThisMonth() - pending.global),
  };
}
