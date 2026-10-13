/**
 * Pure helpers for the spend ledger (no I/O). Spend is recorded under a
 * client's canonical key (its domain); older rows may carry a clients.yaml
 * slug, which is now an alias of the same client.
 */

/** Ledger names that belong to a client: its canonical key and its aliases. */
export function spendKeys(client: { slug: string; aliases: string[] }): string[] {
  return [...new Set([client.slug, ...client.aliases])];
}

/** Map each alias (and canonical key) to the canonical key. */
export function canonicalSpendNames(clients: { slug: string; aliases: string[] }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of clients) for (const k of spendKeys(c)) map.set(k, c.slug);
  return map;
}

export interface SpendRow {
  client: string;
  provider: string;
  calls: number;
  cost_usd: number;
  /** Ahrefs/Semrush API units (Phase 9); 0 for DataForSEO, which bills in USD. */
  units: number;
}

/** Merge ledger rows whose client names are aliases of the same client, sorted by cost, then units. */
export function mergeSpendRows(rows: (Omit<SpendRow, "units"> & { units?: number })[], canonical: Map<string, string>): SpendRow[] {
  const merged = new Map<string, SpendRow>();
  for (const r of rows) {
    const client = canonical.get(r.client) ?? r.client;
    const key = JSON.stringify([client, r.provider]);
    const cur = merged.get(key) ?? { client, provider: r.provider, calls: 0, cost_usd: 0, units: 0 };
    cur.calls += Number(r.calls);
    cur.cost_usd = Number((cur.cost_usd + Number(r.cost_usd)).toFixed(4));
    cur.units += Number(r.units ?? 0);
    merged.set(key, cur);
  }
  return [...merged.values()].sort((a, b) => b.cost_usd - a.cost_usd || b.units - a.units);
}
