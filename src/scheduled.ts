/**
 * Scheduled runs for `crawlmark-cli audit` and `check-traffic`. Clients run one
 * at a time (each audit launches Chrome). A client that cannot be processed is
 * skipped and reported; it never fails the run. Rules live in analysis/alerts.ts.
 */
import { compareSplit, splitBranded } from "./analysis/branded.js";
import {
  exitCodeFor,
  findingAlerts,
  formatAlertText,
  trafficAlert,
  type Alert,
  type AlertThresholds,
} from "./analysis/alerts.js";
import { diffAudits, type AuditDiff, type StoredAudit } from "./analysis/diff.js";
import type { Client } from "./config.js";
import { getAudit, latestAuditBefore } from "./lib/audits.js";
import { lastDays, previousRange, type DateRange } from "./lib/dates.js";
import { sendWebhook, type WebhookOutcome } from "./lib/webhook.js";
import type { GscQueryOptions, GscRow } from "./providers/gsc.js";

export interface Skipped {
  client: string;
  reason: string;
}

export interface RunReport<R> {
  command: "audit" | "check-traffic" | "report";
  ranAt: string;
  dryRun: boolean;
  results: R[];
  alerts: Alert[];
  skipped: Skipped[];
  /** Run-level failures (for example an undeliverable webhook). Skipped clients are not listed here. */
  errors: string[];
  webhook: WebhookOutcome;
  exitCode: 0 | 1 | 2;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------- audits

export interface AuditClientResult {
  client: string;
  auditId: string;
  findings: number;
  /** Null on a client's first audit: there is nothing to diff against, so nothing alerts. */
  diff: { baseAuditId: string; counts: AuditDiff["counts"]; new: AuditDiff["new"]; warnings: string[] } | null;
  note?: string;
}

export interface AuditDeps {
  runAudit(client: Client, opts: { urls?: string[]; fresh: boolean; includeTagManager?: boolean }): Promise<{ auditId: string }>;
  getAudit(id: string): StoredAudit | undefined;
  latestAuditBefore(client: string, beforeMs: number): StoredAudit | undefined;
}

const defaultAuditDeps: AuditDeps = {
  // Imported on demand so that listing or dry-running does not load the browser stack.
  runAudit: async (client, opts) => (await import("./reports/audit.js")).runAudit(client, opts),
  getAudit,
  latestAuditBefore,
};

export async function auditOne(
  client: Client,
  urls: string[] | undefined,
  deps: AuditDeps = defaultAuditDeps,
  extra: { includeTagManager?: boolean } = {},
): Promise<{ result: AuditClientResult; alerts: Alert[] }> {
  // Phase 12: Tag Manager findings only with --include-tag-manager (they are medium/low, so they never alert).
  const { auditId } = await deps.runAudit(client, { ...(urls?.length ? { urls } : {}), fresh: true, ...(extra.includeTagManager ? { includeTagManager: true } : {}) });
  const target = deps.getAudit(auditId);
  if (!target) throw new Error(`Audit ${auditId} was not saved.`);
  const base = deps.latestAuditBefore(client.slug, target.ranAt);
  if (!base) {
    return {
      result: { client: client.slug, auditId, findings: target.findings.length, diff: null, note: "First audit for this client; saved as the baseline, no alerts." },
      alerts: [],
    };
  }
  const diff = diffAudits(base, target);
  return {
    result: { client: client.slug, auditId, findings: target.findings.length, diff: { baseAuditId: base.id, counts: diff.counts, new: diff.new, warnings: diff.warnings } },
    alerts: findingAlerts(client.slug, diff.new),
  };
}

export async function runAudits(
  clients: Client[],
  opts: { urls?: string[]; dryRun?: boolean; skipped?: Skipped[]; webhookUrl?: string | undefined; discoveryError?: string | undefined; deps?: AuditDeps; send?: typeof sendWebhook; includeTagManager?: boolean },
): Promise<RunReport<AuditClientResult | { client: string; wouldAudit: string[] }>> {
  const skipped = [...(opts.skipped ?? [])];
  const results: (AuditClientResult | { client: string; wouldAudit: string[] })[] = [];
  const alerts: Alert[] = [];
  let attempted = 0;
  let failedClients = 0;

  for (const client of clients) {
    if (opts.dryRun) {
      results.push({ client: client.slug, wouldAudit: opts.urls?.length ? opts.urls : client.keyPages });
      continue;
    }
    attempted++;
    try {
      const r = await auditOne(client, opts.urls, opts.deps, { includeTagManager: opts.includeTagManager === true });
      results.push(r.result);
      alerts.push(...r.alerts);
    } catch (err) {
      failedClients++;
      skipped.push({ client: client.slug, reason: `error: ${message(err)}` });
    }
  }
  return finish("audit", results, alerts, skipped, { dryRun: !!opts.dryRun, attempted, failedClients, webhookUrl: opts.webhookUrl, send: opts.send, clientCount: clients.length, discoveryError: opts.discoveryError });
}

// ---------------------------------------------------------------- traffic

export interface TrafficClientResult {
  client: string;
  current: DateRange;
  previous: DateRange;
  nonBranded: { currentClicks: number; previousClicks: number; changePct: number | null };
  branded: { currentClicks: number; previousClicks: number; changePct: number | null };
  note: string;
}

export interface TrafficDeps {
  gscQuery(client: Client, opts: GscQueryOptions): Promise<GscRow[]>;
}

const defaultTrafficDeps: TrafficDeps = {
  gscQuery: async (client, opts) => (await import("./providers/gsc.js")).gscQuery(client, opts),
};

const QUERY_ROW_LIMIT = 25_000;
const TRAFFIC_NOTE = "Built from Search Console query rows, which leave out anonymized queries, so branded + non-branded is slightly under the site total.";

export async function trafficOne(
  client: Client,
  thresholds: AlertThresholds,
  deps: TrafficDeps = defaultTrafficDeps,
  today = new Date(),
): Promise<{ result: TrafficClientResult; alerts: Alert[] }> {
  const current = lastDays(7, 3, today);
  const previous = previousRange(current);
  const [cur, prev] = [
    await deps.gscQuery(client, { ...current, dimensions: ["query"], rowLimit: QUERY_ROW_LIMIT }),
    await deps.gscQuery(client, { ...previous, dimensions: ["query"], rowLimit: QUERY_ROW_LIMIT }),
  ];
  const a = splitBranded(cur, client);
  const b = splitBranded(prev, client);
  const nb = compareSplit(a.nonBranded, b.nonBranded);
  const br = compareSplit(a.branded, b.branded);
  const alert = trafficAlert(client.slug, b.nonBranded.clicks, a.nonBranded.clicks, thresholds);
  return {
    result: {
      client: client.slug,
      current,
      previous,
      nonBranded: { currentClicks: a.nonBranded.clicks, previousClicks: b.nonBranded.clicks, changePct: nb.change.clicks },
      branded: { currentClicks: a.branded.clicks, previousClicks: b.branded.clicks, changePct: br.change.clicks },
      note: TRAFFIC_NOTE,
    },
    alerts: alert ? [alert] : [],
  };
}

export async function runTrafficChecks(
  clients: Client[],
  opts: { thresholds: AlertThresholds; dryRun?: boolean; skipped?: Skipped[]; webhookUrl?: string | undefined; discoveryError?: string | undefined; deps?: TrafficDeps; send?: typeof sendWebhook; today?: Date },
): Promise<RunReport<TrafficClientResult | { client: string; wouldCompare: { current: DateRange; previous: DateRange } }>> {
  const skipped = [...(opts.skipped ?? [])];
  const results: (TrafficClientResult | { client: string; wouldCompare: { current: DateRange; previous: DateRange } })[] = [];
  const alerts: Alert[] = [];
  let attempted = 0;
  let failedClients = 0;

  for (const client of clients) {
    if (!client.gscProperty) {
      skipped.push({ client: client.slug, reason: "no Search Console property" });
      continue;
    }
    if (opts.dryRun) {
      const current = lastDays(7, 3, opts.today);
      results.push({ client: client.slug, wouldCompare: { current, previous: previousRange(current) } });
      continue;
    }
    attempted++;
    try {
      const r = await trafficOne(client, opts.thresholds, opts.deps, opts.today);
      results.push(r.result);
      alerts.push(...r.alerts);
    } catch (err) {
      failedClients++;
      skipped.push({ client: client.slug, reason: `error: ${message(err)}` });
    }
  }
  return finish("check-traffic", results, alerts, skipped, { dryRun: !!opts.dryRun, attempted, failedClients, webhookUrl: opts.webhookUrl, send: opts.send, clientCount: clients.length, discoveryError: opts.discoveryError });
}

// ---------------------------------------------------------------- shared

async function finish<R>(
  command: RunReport<R>["command"],
  results: R[],
  alerts: Alert[],
  skipped: Skipped[],
  o: { dryRun: boolean; attempted: number; failedClients: number; webhookUrl: string | undefined; send: typeof sendWebhook | undefined; clientCount: number; discoveryError: string | undefined },
): Promise<RunReport<R>> {
  const errors: string[] = [];
  // Errors that make the exit code 1. A discovery failure is always listed in `errors`, but it is only fatal
  // when it left nothing to run: with clients.yaml entries that ran fine, the run still exits 0 or 2.
  let fatal = 0;
  if (o.discoveryError) {
    if (o.clientCount === 0 && !o.dryRun) {
      errors.push(`Discovery failed and no clients are configured: ${o.discoveryError}`);
      fatal++;
    } else {
      errors.push(`Discovery failed (ran with clients.yaml entries only): ${o.discoveryError}`);
    }
  }
  // Every client that was tried failed: nothing worked, which is an error rather than a clean run.
  if (o.attempted > 0 && o.failedClients === o.attempted) { errors.push(`All ${o.attempted} client(s) failed; see skipped.`); fatal++; }

  let webhook: WebhookOutcome = { sent: false, reason: o.dryRun ? "dry run" : "no alerts" };
  if (!o.dryRun && alerts.length > 0) {
    webhook = await (o.send ?? sendWebhook)(o.webhookUrl, formatAlertText(alerts));
    // An unset URL is a choice; a URL that could not be delivered to is an error.
    if ("error" in webhook) {
      errors.push(`Webhook not delivered: ${webhook.error}`);
      fatal++;
    }
  }
  return {
    command,
    ranAt: new Date().toISOString(),
    dryRun: o.dryRun,
    results,
    alerts,
    skipped,
    errors,
    webhook,
    exitCode: exitCodeFor({ alerts: alerts.length, failed: fatal > 0 }),
  };
}
