/**
 * `crawlmark-cli seo-snapshot --client <d> | --all --paid [--kinds backlinks,visibility,competitors] [--dry-run]`
 * (Phase 13 B, spec 13.6.5): store today's backlinks, visibility and competitor figures for each client through its
 * SEO data provider, for cron (monthly). Paid: `--paid` is required. Per client: plan (a stored snapshot from the last
 * SNAPSHOT_REUSE_DAYS is reused, nothing is bought for it) -> the whole estimate against the caps (a client over its cap
 * is skipped with the cap message) -> reserve -> fetch -> store. Provider history is never bought here.
 * `--dry-run` prints the estimates and makes no request. JSON on stdout; exit 0 ok, 2 some client failed or was over
 * its cap, 1 usage error or every client failed.
 */
import type { Client } from "./config.js";
import type { ProviderEstimate, ProviderSectionDeps, SectionPlanAny, SpendDeps, ToolEstimate } from "./reports/provider-sections.js";

export const SNAPSHOT_KINDS = ["backlinks", "visibility", "competitors"] as const;
export type SnapshotKindFlag = (typeof SNAPSHOT_KINDS)[number];

export interface SeoSnapshotFlags {
  client?: string | undefined;
  all: boolean;
  paid: boolean;
  kinds?: string | undefined;
  "dry-run": boolean;
}

export interface SeoSnapshotCliDeps {
  loadClients(sel: { client?: string | undefined; all: boolean }): Promise<{ clients: Client[]; skipped: { client: string; reason: string }[]; discoveryError?: string | undefined }>;
  sections(): Promise<{ deps: ProviderSectionDeps; spend: SpendDeps; ps: typeof import("./reports/provider-sections.js") }>;
}

interface ClientResult {
  client: string;
  provider: string | null;
  estimate: { usd: number; units: number; requests: number; breakdown: string };
  stored: SnapshotKindFlag[];
  reused: SnapshotKindFlag[];
  unavailable?: { kind: SnapshotKindFlag; reason: string }[];
  spend?: { usd: number; units: { ahrefs: number; semrush: number } };
}

const TYPE: Record<SnapshotKindFlag, "backlinks" | "organic_visibility" | "competitor_overview"> = { backlinks: "backlinks", visibility: "organic_visibility", competitors: "competitor_overview" };

export async function seoSnapshotCommand(args: string[], flags: SeoSnapshotFlags, io: { out(l: string): void; warn(l: string): void; usage(problem: string): number }, deps: SeoSnapshotCliDeps): Promise<number> {
  if (args.length) return io.usage(`seo-snapshot takes only flags, got: ${args.join(" ")}`);
  if (flags.all === (flags.client !== undefined)) return io.usage("seo-snapshot takes --client <domain|slug> or --all.");
  if (!flags.paid) {
    io.warn("seo-snapshot spends provider credits; add --paid (try --paid --dry-run first to see the estimate).");
    return 1;
  }
  const kinds = flags.kinds === undefined ? [...SNAPSHOT_KINDS] : flags.kinds.split(",").map((k) => k.trim()).filter(Boolean);
  const bad = kinds.filter((k) => !(SNAPSHOT_KINDS as readonly string[]).includes(k));
  if (!kinds.length || bad.length) return io.usage(`--kinds takes ${SNAPSHOT_KINDS.join(", ")}${bad.length ? ` (got ${bad.join(", ")})` : ""}.`);

  let sel: Awaited<ReturnType<SeoSnapshotCliDeps["loadClients"]>>;
  try {
    sel = await deps.loadClients({ client: flags.client, all: flags.all });
  } catch (err) {
    io.warn(`Error: ${(err as Error).message}`);
    return 1;
  }
  const { deps: sd, spend, ps } = await deps.sections();
  const results: ClientResult[] = [];
  const skipped = [...sel.skipped];
  const errors: string[] = [];
  if (sel.discoveryError) errors.push(`Discovery failed (ran with clients.yaml entries only): ${sel.discoveryError}`);
  let attempted = 0;
  let failed = 0;
  let overCap = 0;
  const window = { kind: "tool" as const, end: new Date(sd.now()).toISOString().slice(0, 10), toleranceDays: 0, comparisons: {}, trendMonths: 0 };
  for (const client of sel.clients) {
    attempted++;
    try {
      const plans: { kind: SnapshotKindFlag; planned: SectionPlanAny }[] = [];
      const unavailable: { kind: SnapshotKindFlag; reason: string }[] = [];
      for (const kind of kinds as SnapshotKindFlag[]) {
        try {
          plans.push({ kind, planned: await ps.planSection(client, { type: TYPE[kind], history: false, trendMonths: 0 }, window, sd) });
        } catch (err) {
          unavailable.push({ kind, reason: (err as Error).message });
        }
      }
      if (!plans.length) {
        failed++;
        skipped.push({ client: client.slug, reason: `nothing to snapshot: ${unavailable.map((u) => `${u.kind}: ${u.reason}`).join("; ")}` });
        continue;
      }
      const ests = plans.map((p) => ps.estimateOf(p.planned));
      const provider = ests[0]!.provider;
      const total: ProviderEstimate = {
        provider,
        usd: Number(ests.reduce((a, e) => a + e.usd, 0).toFixed(6)),
        units: ests.reduce((a, e) => a + e.units, 0),
        requests: ests.reduce((a, e) => a + e.requests, 0),
        reused: ests.every((e) => e.reused),
        parts: ests.flatMap((e) => e.parts),
      };
      const priced: ToolEstimate = ps.priceEstimate(client, total, spend);
      const base: ClientResult = {
        client: client.slug,
        provider,
        estimate: { usd: total.usd, units: total.units, requests: total.requests, breakdown: priced.breakdown },
        stored: [],
        reused: plans.filter((p) => ps.estimateOf(p.planned).reused).map((p) => p.kind),
        ...(unavailable.length ? { unavailable } : {}),
      };
      if (flags["dry-run"]) {
        results.push(base);
        continue;
      }
      if (priced.wouldExceed) {
        overCap++;
        skipped.push({ client: client.slug, reason: priced.message });
        continue;
      }
      const r = await ps.runReserved(client, total, spend, async () => {
        // Competitors last: the client's own row reads the visibility snapshot stored just before.
        for (const p of [...plans].sort((a, b) => Number(a.kind === "competitors") - Number(b.kind === "competitors"))) await ps.runSection(p.planned, sd);
      });
      results.push({ ...base, stored: plans.filter((p) => !ps.estimateOf(p.planned).reused).map((p) => p.kind), spend: r.spend });
    } catch (err) {
      failed++;
      skipped.push({ client: client.slug, reason: `error: ${(err as Error).message}` });
    }
  }
  const allFailed = attempted > 0 && failed === attempted;
  if (allFailed) errors.push(`All ${attempted} client(s) failed; see skipped.`);
  const exitCode: 0 | 1 | 2 = allFailed || (sel.discoveryError && sel.clients.length === 0) ? 1 : failed > 0 || overCap > 0 ? 2 : 0;
  io.out(JSON.stringify({ command: "seo-snapshot", ranAt: new Date(sd.now()).toISOString(), dryRun: flags["dry-run"], kinds, results, skipped, errors, exitCode }, null, 2));
  for (const e of errors) io.warn(`Error: ${e}`);
  return exitCode;
}
