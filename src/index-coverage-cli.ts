/**
 * `crawlmark-cli index-coverage` (Phase 13, spec 13.6.5): inspect each client's next URLs with Search Console
 * URL Inspection (free, read-only) within the per-property daily budget, for cron. The scheduled-command shape:
 * JSON on stdout, exit 0 ok, 2 when a client failed or Google's quota ran out before the run finished, 1 for a
 * usage error or when every client failed. Clients without a Search Console property are skipped.
 */
import type { Client } from "./config.js";
import type { InspectOptions, InspectResult } from "./reports/indexing.js";

export interface IndexCoverageFlags {
  client?: string | undefined;
  all: boolean;
  max?: string | undefined;
  "stale-days"?: string | undefined;
  "dry-run": boolean;
}

export interface IndexCoverageCliDeps {
  /** One client (`--client`) or every client (`--all`; ignored ones in `skipped`). Throws for an unknown client. */
  loadClients(sel: { client?: string | undefined; all: boolean }): Promise<{ clients: Client[]; skipped: { client: string; reason: string }[]; discoveryError?: string | undefined }>;
  run(client: Client, opts: InspectOptions): Promise<InspectResult>;
}

export interface IndexCoverageOutput {
  command: "index-coverage";
  ranAt: string;
  dryRun: boolean;
  results: ({ client: string } & Omit<InspectResult, "notes"> & { notes?: string[] })[];
  skipped: { client: string; reason: string }[];
  errors: string[];
  exitCode: 0 | 1 | 2;
}

/** The CLI's run cap (spec 13.13: 200 per run; the tool's default is 100). */
export const CLI_DEFAULT_MAX = 200;

const int = (v: string | undefined, min: number, max: number): number | null | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v.trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

export async function indexCoverageCommand(args: string[], flags: IndexCoverageFlags, io: { out(l: string): void; warn(l: string): void; usage(problem: string): number }, deps: IndexCoverageCliDeps): Promise<number> {
  if (args.length) return io.usage(`index-coverage takes only flags, got: ${args.join(" ")}`);
  if (flags.all === (flags.client !== undefined)) return io.usage("index-coverage takes --client <domain|slug> or --all.");
  const max = int(flags.max, 1, 500);
  if (max === null) return io.usage("--max must be a whole number from 1 to 500.");
  const staleDays = int(flags["stale-days"], 1, 90);
  if (staleDays === null) return io.usage("--stale-days must be a whole number from 1 to 90.");

  let sel: Awaited<ReturnType<IndexCoverageCliDeps["loadClients"]>>;
  try {
    sel = await deps.loadClients({ client: flags.client, all: flags.all });
  } catch (err) {
    io.warn(`Error: ${(err as Error).message}`);
    return 1;
  }
  const results: IndexCoverageOutput["results"] = [];
  const skipped = [...sel.skipped];
  const errors: string[] = [];
  if (sel.discoveryError) errors.push(`Discovery failed (ran with clients.yaml entries only): ${sel.discoveryError}`);
  let attempted = 0;
  let failed = 0;
  let attention = false;
  for (const client of sel.clients) {
    if (!client.gscProperty) {
      skipped.push({ client: client.slug, reason: "no Search Console property" });
      continue;
    }
    attempted++;
    try {
      const r = await deps.run(client, { maxInspections: max ?? CLI_DEFAULT_MAX, ...(staleDays ? { staleDays } : {}), dryRun: flags["dry-run"] });
      const { notes, ...rest } = r;
      results.push({ client: client.slug, ...rest, ...(notes.length ? { notes } : {}) });
      if (!flags["dry-run"] && (r.stoppedBy === "quota" || r.stoppedBy === "errors" || r.failed > 0)) attention = true;
    } catch (err) {
      failed++;
      skipped.push({ client: client.slug, reason: `error: ${(err as Error).message}` });
    }
  }
  const allFailed = attempted > 0 && failed === attempted;
  if (allFailed) errors.push(`All ${attempted} client(s) failed; see skipped.`);
  const exitCode: 0 | 1 | 2 = allFailed || (sel.discoveryError && sel.clients.length === 0) ? 1 : attention || failed > 0 ? 2 : 0;
  const output: IndexCoverageOutput = { command: "index-coverage", ranAt: new Date().toISOString(), dryRun: flags["dry-run"], results, skipped, errors, exitCode };
  io.out(JSON.stringify(output, null, 2));
  for (const e of errors) io.warn(`Error: ${e}`);
  return exitCode;
}
