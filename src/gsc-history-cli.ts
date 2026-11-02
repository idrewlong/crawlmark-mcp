/**
 * `crawlmark-cli gsc-history` (Release A / D5): save Search Console history before Google drops it.
 *   gsc-history backfill <client>... | --all [--months N] [--refresh]   one line per client; exit 1 when every client failed
 *   gsc-history show <client> [--months N]                              a table of the stored months
 * Free (Search Console only). Dependencies are injected for tests.
 */
import type { Client } from "./config.js";
import type { FillResult, StoredMonthSummary } from "./lib/gsc-monthly.js";
import { cliHint } from "./lib/cli-hint.js";
import { stripControl } from "./lib/terminal-text.js";

export interface GscHistoryFlags {
  all: boolean;
  months?: string | undefined;
  refresh: boolean;
}

export interface GscHistoryDeps {
  /** Every client except ignored ones. */
  allClients(): Promise<Client[]>;
  resolveClient(input: string): Promise<Client>;
  fill(client: Client, o: { max: number; window: number; refresh: boolean }): Promise<FillResult>;
  stored(client: Client, limit: number): Promise<StoredMonthSummary[]>;
}

const parseMonths = (v: string | undefined): number | null => {
  if (v === undefined) return 16;
  const n = Number(v.trim());
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : null;
};

const errText = (err: unknown) => stripControl(err instanceof Error ? err.message : String(err));

export async function gscHistoryCommand(args: string[], flags: GscHistoryFlags, io: { out(l: string): void; warn(l: string): void; usage(problem: string): number }, deps: GscHistoryDeps): Promise<number> {
  const [sub, ...names] = args;
  const months = parseMonths(flags.months);
  if (months === null) return io.usage("--months must be a whole number from 1 to 16.");

  if (sub === "show") {
    if (flags.all || names.length !== 1) return io.usage("gsc-history show takes one client.");
    let client: Client;
    try {
      client = await deps.resolveClient(names[0]!);
    } catch (err) {
      io.warn(errText(err));
      return 1;
    }
    const rows = await deps.stored(client, months);
    if (!rows.length) {
      io.out(`${client.domain}: no Search Console history saved yet. Run: ${cliHint()} gsc-history backfill ${client.domain}`);
      return 0;
    }
    io.out(`${client.domain}: ${rows.length} stored month(s), newest first (raw numbers, no query exclusions)`);
    io.out(["month", "clicks", "impressions", "ctr %", "position", "complete", "saved"].join("\t"));
    for (const r of rows) {
      io.out([r.month, r.clicks, r.impressions, r.ctr, r.position, r.complete ? "yes" : "partial", new Date(r.capturedAt).toISOString().slice(0, 10)].join("\t"));
    }
    return 0;
  }

  if (sub !== "backfill") return io.usage("gsc-history takes backfill or show.");
  if (flags.all === names.length > 0) return io.usage("gsc-history backfill takes one or more clients, or --all.");

  let clients: Client[];
  try {
    clients = flags.all ? await deps.allClients() : await Promise.all(names.map((n) => deps.resolveClient(n)));
  } catch (err) {
    io.warn(errText(err));
    return 1;
  }
  if (!clients.length) {
    io.out("No clients to back up.");
    return 0;
  }

  let attempted = 0;
  let failedClients = 0;
  for (const client of clients) {
    if (!client.gscProperty) {
      io.out(`${client.domain}: skipped, no Search Console property`);
      continue;
    }
    attempted++;
    try {
      const r = await deps.fill(client, { max: months, window: months, refresh: flags.refresh });
      io.out(`${client.domain}: stored ${r.stored.length}, skipped ${r.skipped.length}, failed ${r.failed.length}`);
      // The same message for many months (a setup or quota stop) prints once with a month count.
      const groups = new Map<string, string[]>();
      for (const f of r.failed) {
        const msg = stripControl(f.error);
        groups.set(msg, [...(groups.get(msg) ?? []), f.month]);
      }
      const lines = [...groups].map(([msg, ms]) => (ms.length === 1 ? `  ${ms[0]}: ${msg}` : `  ${msg} (${ms.length} months, ${ms.at(-1)} to ${ms[0]})`));
      for (const l of lines.slice(0, 5)) io.warn(l);
      if (lines.length > 5) io.warn(`  ... and ${lines.length - 5} more`);
      if (r.failed.length && !r.stored.length) failedClients++;
    } catch (err) {
      failedClients++;
      io.out(`${client.domain}: failed (${errText(err)})`);
    }
  }
  if (attempted > 0 && failedClients === attempted) return 1;
  if (failedClients > 0) io.warn("Some months weren't saved. Run the same command again to carry on where it stopped.");
  return 0;
}
