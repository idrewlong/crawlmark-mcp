/**
 * Alert rules for scheduled runs (pure, no I/O): which audit findings and
 * traffic changes are worth waking someone for, how the summary reads, and
 * which exit code a cron wrapper sees.
 */
import type { Finding, Severity } from "./findings.js";

export interface AlertThresholds {
  /** Alert when non-branded clicks fell by at least this percent... */
  trafficDropPct: number;
  /** ...and at least this many clicks were lost. */
  minClicksLost: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = { trafficDropPct: 25, minClicksLost: 50 };

export type Alert =
  | { kind: "new-finding"; client: string; severity: Severity; rule: string; url: string; title: string }
  | { kind: "traffic-drop"; client: string; previousClicks: number; currentClicks: number; clicksLost: number; dropPct: number };

/** Severities that alert when a finding first appears. */
export const ALERT_SEVERITIES: Severity[] = ["critical", "high"];

/** One alert per new critical or high finding. `newFindings` is a diff's `new` list. */
export function findingAlerts(client: string, newFindings: Finding[]): Alert[] {
  return newFindings
    .filter((f) => ALERT_SEVERITIES.includes(f.severity))
    .map((f) => ({ kind: "new-finding", client, severity: f.severity, rule: f.rule, url: f.url, title: f.title }));
}

/** A non-branded click drop that is both large in percent and in absolute clicks. Null when it is not. */
export function trafficAlert(client: string, previousClicks: number, currentClicks: number, t: AlertThresholds): Alert | null {
  if (previousClicks <= 0) return null;
  const clicksLost = previousClicks - currentClicks;
  if (clicksLost <= 0) return null;
  const dropPct = Number(((clicksLost / previousClicks) * 100).toFixed(1));
  if (dropPct < t.trafficDropPct || clicksLost < t.minClicksLost) return null;
  return { kind: "traffic-drop", client, previousClicks, currentClicks, clicksLost, dropPct };
}

/** Exit codes for `audit` and `check-traffic`: 0 clean, 1 error, 2 alerts. An error wins, since it means the run could not be trusted or delivered. */
export function exitCodeFor(opts: { alerts: number; failed: boolean }): 0 | 1 | 2 {
  if (opts.failed) return 1;
  return opts.alerts > 0 ? 2 : 0;
}

const MAX_LINES = 15;

/** Slack mrkdwn treats & < > as control characters; titles come from page content. */
const escapeMrkdwn = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Keep the path, drop query and fragment (they can carry tokens). */
function plainUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.origin + u.pathname;
  } catch {
    return raw.split(/[?#]/, 1)[0] ?? raw;
  }
}

/** A short plain-text summary for an incoming webhook. Empty string when there are no alerts. */
export function formatAlertText(alerts: Alert[]): string {
  if (alerts.length === 0) return "";
  const lines = alerts.map((a) =>
    a.kind === "new-finding"
      ? `[${a.severity}] ${a.client}: new ${a.rule} on ${plainUrl(a.url)} - ${escapeMrkdwn(a.title)}`
      : `[traffic] ${a.client}: non-branded clicks down ${a.dropPct}% (${a.previousClicks} to ${a.currentClicks}, ${a.clicksLost} lost)`,
  );
  const shown = lines.slice(0, MAX_LINES);
  if (lines.length > shown.length) shown.push(`...and ${lines.length - shown.length} more`);
  return `crawlmark: ${alerts.length} alert${alerts.length === 1 ? "" : "s"}\n${shown.join("\n")}`;
}
