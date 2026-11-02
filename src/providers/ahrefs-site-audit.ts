/**
 * Ahrefs Site Audit as a technical_issues source (Phase 13 B, spec D11-D13; research §1). Read-only through a path
 * allowlist: an Ahrefs key can also call the Management writes (create, delete, edit projects), so this module refuses
 * any method other than GET and any path outside ALLOWED before a request is built. It never starts a crawl.
 *
 * - The client's existing project: clients.yaml `ahrefsSiteAuditProject` wins; else `GET /site-audit/projects?project_url=`
 *   (free, cached a day) must match exactly one project on the client's host (with or without www.).
 * - `GET /site-audit/issues` (50 units) for the newest finished crawl; `GET /site-audit/page-explorer` (50 units each)
 *   for up to `issueUrls` example URLs per top issue, only when asked.
 * - Stored: issue names and counts only. Example URLs are shown in this run's result and never stored (the technical
 *   issues snapshot drops them for this source; nothing with URLs is cached).
 */
import type { Client } from "../config.js";
import { TTL } from "../lib/cache.js";
import { cleanText, cleanUrl } from "../lib/inspections.js";
import { ProviderUnavailableError } from "../lib/provider-ids.js";
import { withUnitsReservation, unitsCall } from "./units-billing.js";
import type { RawIssue } from "../analysis/tech-issues.js";
import type { IssueSeverity, SourceRun } from "../reports/report-types.js";
import { cliHint } from "../lib/cli-hint.js";

/** The only Ahrefs calls this module can make (D12). */
export const ALLOWED: readonly { method: "GET"; path: string; units: number }[] = [
  { method: "GET", path: "/site-audit/projects", units: 0 },
  { method: "GET", path: "/site-audit/issues", units: 50 },
  { method: "GET", path: "/site-audit/page-explorer", units: 50 },
];
export const ISSUES_UNITS = 50;
export const PAGE_EXPLORER_UNITS = 50;

export class SiteAuditRefused extends Error {
  override name = "SiteAuditRefused";
}

/** Throws unless (method, path) is on the allowlist (exact path; no query string in `path`). */
export function assertAhrefsAllowed(method: string, path: string): void {
  if (!ALLOWED.some((a) => a.method === method && a.path === path)) throw new SiteAuditRefused(`Refused: ${method} ${path} isn't an allowed read-only Ahrefs Site Audit call.`);
}

export interface AhrefsAuditTransport {
  get<T>(client: Client, path: string, params: Record<string, string>, estimate: number): Promise<{ json: T; units: number }>;
}

/** The real transport: the allowlist is checked here, then the shared Ahrefs client makes the GET. */
export function ahrefsAuditRequest(method: string, path: string): <T>(client: Client, params: Record<string, string>, estimate: number) => Promise<{ json: T; units: number }> {
  assertAhrefsAllowed(method, path);
  return async <T>(client: Client, params: Record<string, string>, estimate: number) => {
    const { ahrefsGet } = await import("./ahrefs.js");
    return ahrefsGet<T>(client, { path, params }, estimate);
  };
}

const realTransport: AhrefsAuditTransport = { get: (client, path, params, estimate) => ahrefsAuditRequest("GET", path)(client, params, estimate) };

interface RawProject {
  project_id?: string | number | null;
  target_url?: string | null;
  date?: string | null;
  status?: string | null;
}
interface RawIssueRow {
  issue_id?: string | null;
  name?: string | null;
  category?: string | null;
  importance?: string | null;
  crawled?: number | null;
}

/** True when a project's host is the client's domain or one of its subdomains (SEC-1: never another site's audit). */
export const onClientDomain = (host: string, domain: string) => {
  const own = bareHost(domain);
  return Boolean(host) && (host === own || host.endsWith(`.${own}`));
};

const bareHost = (u: string) => {
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** D9: Ahrefs Error -> high, Warning -> medium, Notice -> low. */
export function ahrefsSeverity(importance: string | null | undefined): IssueSeverity {
  return importance === "Error" ? "high" : importance === "Warning" ? "medium" : "low";
}

export interface AuditPlan {
  units: number;
  requests: number;
  breakdown: string;
}

/** Pure: what one read costs (projects is free). */
export function planAhrefsSiteAudit(issueUrls: number): AuditPlan {
  const n = Math.max(0, Math.min(5, issueUrls));
  return { units: ISSUES_UNITS + n * PAGE_EXPLORER_UNITS, requests: 2 + n, breakdown: `Ahrefs Site Audit: issues (50 units)${n ? ` + ${n} page-explorer call(s) (50 each)` : ""} + projects (free)` };
}

/** The client's project: the saved ID, else exactly one project on the client's host (D13). */
export async function matchAhrefsProject(client: Client, t: AhrefsAuditTransport = realTransport): Promise<{ id: string; date: string | null; status: string | null }> {
  const saved = client.ahrefsSiteAuditProject;
  const params: Record<string, string> = saved ? { project_id: saved } : { project_url: bareHost(client.domain) };
  const r = await unitsCall({
    client,
    provider: "ahrefs",
    capability: "siteAuditProjects",
    keyParts: params,
    ttl: TTL.day,
    estimate: 0,
    run: async () => {
      const res = await t.get<{ healthscores?: RawProject[] | null }>(client, "/site-audit/projects", params, 0);
      // Kept: project IDs, crawl dates and statuses only.
      const rows = (res.json.healthscores ?? []).map((p) => ({ id: p.project_id === null || p.project_id === undefined ? "" : String(p.project_id), host: bareHost(p.target_url ?? ""), date: typeof p.date === "string" ? p.date : null, status: typeof p.status === "string" ? p.status : null }));
      return { value: rows, units: res.units };
    },
  });
  const own = bareHost(client.domain);
  const matches = saved ? r.value.filter((p) => p.id === saved) : r.value.filter((p) => onClientDomain(p.host, client.domain));
  // A pinned project on another site would put that site's audit in this client's report: refused.
  if (saved && matches.length === 1 && !onClientDomain(matches[0]!.host, client.domain)) {
    throw new ProviderUnavailableError("siteAudit", "ahrefs", `Ahrefs Site Audit project ${saved} is for ${matches[0]!.host || "another site"}, not ${own}; fix ahrefsSiteAuditProject (${cliHint()} clients set ${client.domain} --ahrefs-site-audit-project <id>)`);
  }
  if (matches.length !== 1) {
    throw new ProviderUnavailableError(
      "siteAudit",
      "ahrefs",
      saved
        ? `no Ahrefs Site Audit project ${saved} for this key (check ahrefsSiteAuditProject)`
        : matches.length
          ? `${matches.length} Ahrefs Site Audit projects match ${own}; set ahrefsSiteAuditProject (${cliHint()} clients set ${client.domain} --ahrefs-site-audit-project <id>)`
          : `no Ahrefs Site Audit project for ${own}; create one in Ahrefs, or set ahrefsSiteAuditProject`,
    );
  }
  return { id: matches[0]!.id, date: matches[0]!.date, status: matches[0]!.status };
}

/**
 * Read the newest finished crawl's issues (and, with issueUrls, example URLs for the top issues). The whole read's
 * units are checked and reserved first (withUnitsReservation). Returns raw issues for tech-issues.ts.
 */
export async function readAhrefsSiteAudit(client: Client, opts: { issueUrls?: number | undefined }, t: AhrefsAuditTransport = realTransport): Promise<{ run: SourceRun; issues: RawIssue[]; units: number }> {
  const plan = planAhrefsSiteAudit(opts.issueUrls ?? 0);
  const project = await matchAhrefsProject(client, t);
  return withUnitsReservation(client, "ahrefs", plan.units, async () => {
    let units = 0;
    const res = await t.get<{ issues?: RawIssueRow[] | null }>(client, "/site-audit/issues", { project_id: project.id }, ISSUES_UNITS);
    units += res.units;
    const rows = (res.json.issues ?? []).filter((i) => typeof i.crawled === "number" && i.crawled > 0);
    const issues: (RawIssue & { issueId: string | null })[] = rows.map((i) => {
      const name = cleanText(i.name, 200) ?? "Ahrefs issue";
      const severity = ahrefsSeverity(i.importance);
      return { source: "ahrefs_site_audit", rule: name, url: null, severity, nativeSeverity: cleanText(i.importance, 20) ?? "Notice", title: name, count: Math.round(i.crawled!), issueId: typeof i.issue_id === "string" ? i.issue_id : null };
    });
    const n = Math.max(0, Math.min(5, opts.issueUrls ?? 0));
    if (n > 0) {
      const order: IssueSeverity[] = ["critical", "high", "medium", "low"];
      const top = [...issues].filter((i) => i.issueId).sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || (b.count ?? 0) - (a.count ?? 0)).slice(0, n);
      for (const i of top) {
        const pe = await t.get<{ pages?: { url?: string | null }[] | null }>(client, "/site-audit/page-explorer", { project_id: project.id, issue_id: i.issueId!, select: "url", limit: "3" }, PAGE_EXPLORER_UNITS);
        units += pe.units;
        i.examples = (pe.json.pages ?? []).map((p) => (typeof p.url === "string" ? cleanUrl(p.url) : null)).filter((u): u is string => Boolean(u)).slice(0, 3);
      }
    }
    const ranAt = project.date && !Number.isNaN(Date.parse(project.date)) ? new Date(project.date).toISOString() : new Date().toISOString();
    return { run: { source: "ahrefs_site_audit", runId: `ahrefs:${project.id}@${ranAt}`, ranAt, stale: false }, issues: issues.map(({ issueId: _i, ...r }) => r), units };
  });
}
