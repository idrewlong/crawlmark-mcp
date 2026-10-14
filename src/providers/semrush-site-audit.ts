/**
 * Semrush Site Audit as a technical_issues source (Phase 13 B, spec D11-D13; research §2). Read-only through a path
 * allowlist: a Semrush key can also launch audits and create or edit campaigns, so this module refuses any method other
 * than GET and any path outside ALLOWED before a request is built. Never `/siteaudit/snapshot?snapshot_id=` (10,000
 * units), never `launch`, `enable` or `save`.
 *
 * - The client's existing project: clients.yaml `semrushProject` wins; else the project list (100 units, cached 7 days)
 *   filtered to the client's host with a Site Audit tool must match exactly one.
 * - `/siteaudit/info` (100 units): per-issue counts (`defects`) and the last audit's date; `/siteaudit/meta/issues`
 *   (100 units, cached 30 days) for issue titles; with issueUrls, `/snapshot/{sid}/issue/{iid}` (100 each).
 * - Semrush terms: nothing is kept longer than 31 days (caches here are 7 and 30 days).
 */
import type { Client } from "../config.js";
import { recordUnits } from "../lib/budget.js";
import { TTL } from "../lib/cache.js";
import { cleanText, cleanUrl } from "../lib/inspections.js";
import { ProviderUnavailableError } from "../lib/provider-ids.js";
import { isTimeoutOrAbort, unitsCall, withUnitsReservation } from "./units-billing.js";
import type { RawIssue } from "../analysis/tech-issues.js";
import type { IssueSeverity, SourceRun } from "../reports/report-types.js";

const ID = "\\d{1,20}";
const SNAP = "[A-Za-z0-9_-]{1,64}";
/** The only Semrush calls this module can make (D12). Paths are matched whole; no query string may name a snapshot. */
export const ALLOWED: readonly { method: "GET"; pattern: RegExp; units: number; label: string }[] = [
  { method: "GET", pattern: /^\/management\/v1\/projects$/, units: 100, label: "projects list" },
  { method: "GET", pattern: new RegExp(`^/reports/v1/projects/${ID}/siteaudit/info$`), units: 100, label: "siteaudit/info" },
  { method: "GET", pattern: new RegExp(`^/reports/v1/projects/${ID}/siteaudit/meta/issues$`), units: 100, label: "siteaudit/meta/issues" },
  { method: "GET", pattern: new RegExp(`^/reports/v1/projects/${ID}/siteaudit/snapshot/${SNAP}/issue/${ID}$`), units: 100, label: "siteaudit/issue" },
];
export const CALL_UNITS = 100;

export class SemrushAuditRefused extends Error {
  override name = "SemrushAuditRefused";
}

/** Throws unless (method, path) is allowed and no parameter names a snapshot (the 10,000-unit snapshot report). */
export function assertSemrushAllowed(method: string, path: string, params: Record<string, string> = {}): { label: string; units: number } {
  const hit = ALLOWED.find((a) => a.method === method && a.pattern.test(path));
  if (!hit || "snapshot_id" in params || /[?#]/.test(path)) throw new SemrushAuditRefused(`Refused: ${method} ${path.slice(0, 120)} isn't an allowed read-only Semrush Site Audit call.`);
  return { label: hit.label, units: hit.units };
}

export interface SemrushAuditTransport {
  /** One allowed GET; returns the parsed JSON body. Records its units. */
  get<T>(client: Client, path: string, params: Record<string, string>): Promise<T>;
}

/** The real transport: allowlist, the shared Semrush limiter and key handling, units recorded on success. */
export function semrushAuditRequest(method: string, path: string, params: Record<string, string> = {}): <T>(client: Client) => Promise<T> {
  const { label, units } = assertSemrushAllowed(method, path, params);
  return async <T>(client: Client) => {
    const { semrushProjectsGet, semrushRedact } = await import("./semrush.js");
    let res: { status: number; text: string };
    try {
      res = await semrushProjectsGet(path, label, params);
    } catch (err) {
      if (!isTimeoutOrAbort(err)) throw err;
      // Semrush may still have billed it: the estimate is recorded against the cap (as v3Report does).
      recordUnits(client.slug, "semrush", `${label} (timeout, estimated)`, units);
      throw new Error(`Semrush ${label} timed out; Semrush may still have billed it. The estimated ${units} units were recorded against the cap.`);
    }
    let json: unknown;
    try {
      json = JSON.parse(res.text);
    } catch {
      json = undefined;
    }
    if (res.status >= 400 || json === undefined || /^\s*ERROR \d+/.test(res.text)) {
      throw new Error(`Semrush ${label} failed (HTTP ${res.status}): ${semrushRedact(res.text).slice(0, 200)}`);
    }
    recordUnits(client.slug, "semrush", label, units);
    return json as T;
  };
}

const realTransport: SemrushAuditTransport = { get: (client, path, params) => semrushAuditRequest("GET", path, params)(client) };

/** True when a project's host is the client's domain or one of its subdomains (SEC-1). */
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

/** D9: Semrush errors (IDs 1-99) -> high, warnings (101-199) -> medium, notices (201+) -> low. */
export function semrushSeverity(id: number): IssueSeverity {
  return id < 100 ? "high" : id < 200 ? "medium" : "low";
}

/** Not confirmed (live check, research Not confirmed 4): the tool name Semrush uses for Site Audit in the project list. */
export const SITE_AUDIT_TOOL = "siteaudit";

export interface AuditPlan {
  units: number;
  requests: number;
  breakdown: string;
}

/** Pure apart from the cache peek: list (unless a project is saved or the list is cached) + info + meta (unless cached) + issue URLs. */
export function planSemrushSiteAudit(o: { savedProject: boolean; listCached: boolean; metaCached: boolean; issueUrls: number }): AuditPlan {
  const n = Math.max(0, Math.min(5, o.issueUrls));
  const list = o.savedProject || o.listCached ? 0 : 1;
  const meta = o.metaCached ? 0 : 1;
  const calls = list + 1 + meta + n;
  return { units: calls * CALL_UNITS, requests: calls, breakdown: `Semrush Site Audit: ${list ? "project list (100) + " : ""}info (100)${meta ? " + issue titles (100)" : ""}${n ? ` + ${n} issue URL call(s) (100 each)` : ""}` };
}

interface RawProject {
  project_id?: number | string | null;
  url?: string | null;
  tools?: { tool?: string | null }[] | null;
}

export async function matchSemrushProject(client: Client, t: SemrushAuditTransport = realTransport): Promise<string> {
  if (client.semrushProject) return client.semrushProject;
  const r = await unitsCall({
    client,
    provider: "semrush",
    capability: "siteAuditProjects",
    keyParts: { list: "all" },
    ttl: TTL.week,
    estimate: CALL_UNITS,
    run: async () => {
      const json = await t.get<RawProject[] | { projects?: RawProject[] }>(client, "/management/v1/projects", {});
      const list = Array.isArray(json) ? json : (json.projects ?? []);
      // Kept: project IDs, hosts and tool names only.
      return { value: list.map((p) => ({ id: p.project_id === null || p.project_id === undefined ? "" : String(p.project_id), host: bareHost(p.url ?? ""), tools: (p.tools ?? []).map((x) => String(x.tool ?? "")) })), units: CALL_UNITS };
    },
  });
  const own = bareHost(client.domain);
  const matches = r.value.filter((p) => onClientDomain(p.host, client.domain) && p.tools.includes(SITE_AUDIT_TOOL) && /^\d+$/.test(p.id));
  if (matches.length !== 1) {
    throw new ProviderUnavailableError(
      "siteAudit",
      "semrush",
      matches.length
        ? `${matches.length} Semrush projects with Site Audit match ${own}; set semrushProject (crawlmark-cli clients set ${client.domain} --semrush-project <id>)`
        : `no Semrush project with Site Audit for ${own}; set one up in Semrush, or set semrushProject`,
    );
  }
  return matches[0]!.id;
}

interface RawInfo {
  url?: string | null;
  defects?: Record<string, number | null> | null;
  last_audit?: number | string | null;
  status?: string | null;
  current_snapshot?: { snapshot_id?: string | null } | null;
}

const auditTime = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
};

/**
 * Read the latest audit: info (counts per issue ID), titles from meta/issues (cached 30 days) and, with issueUrls,
 * example URLs for the top issues. The whole read's units are checked and reserved first.
 */
export async function readSemrushSiteAudit(client: Client, opts: { issueUrls?: number | undefined; metaCached?: boolean }, t: SemrushAuditTransport = realTransport): Promise<{ run: SourceRun; issues: RawIssue[] }> {
  const project = await matchSemrushProject(client, t);
  const n = Math.max(0, Math.min(5, opts.issueUrls ?? 0));
  const plan = planSemrushSiteAudit({ savedProject: true, listCached: true, metaCached: opts.metaCached === true, issueUrls: n });
  return withUnitsReservation(client, "semrush", plan.units, async () => {
    const base = `/reports/v1/projects/${project}/siteaudit`;
    const info = await t.get<RawInfo>(client, `${base}/info`, {});
    // SEC-1: a project (pinned or matched) whose site isn't this client's never reaches its report.
    const infoHost = bareHost(typeof info.url === "string" ? info.url : "");
    if (!onClientDomain(infoHost, client.domain)) {
      throw new ProviderUnavailableError("siteAudit", "semrush", `Semrush project ${project} is for ${infoHost || "an unknown site"}, not ${bareHost(client.domain)}; fix semrushProject (crawlmark-cli clients set ${client.domain} --semrush-project <id>)`);
    }
    const meta = await unitsCall({
      client,
      provider: "semrush",
      capability: "siteAuditMeta",
      keyParts: { project },
      ttl: TTL.month,
      estimate: CALL_UNITS,
      run: async () => {
        const json = await t.get<{ issues?: { id?: number | null; title?: string | null }[] | null }>(client, `${base}/meta/issues`, {});
        return { value: (json.issues ?? []).flatMap((i) => (typeof i.id === "number" ? [{ id: i.id, title: cleanText(i.title, 200) }] : [])), units: CALL_UNITS };
      },
    });
    const titles = new Map(meta.value.map((m) => [m.id, m.title]));
    const issues: (RawIssue & { id: number })[] = [];
    for (const [k, v] of Object.entries(info.defects ?? {})) {
      const id = Number(k);
      if (!Number.isInteger(id) || id <= 0 || typeof v !== "number" || v <= 0) continue;
      const severity = semrushSeverity(id);
      const title = titles.get(id) ?? `Semrush Site Audit issue ${id}`;
      issues.push({ id, source: "semrush_site_audit", rule: String(id), url: null, severity, nativeSeverity: severity === "high" ? "error" : severity === "medium" ? "warning" : "notice", title, count: Math.round(v) });
    }
    const snapshotId = typeof info.current_snapshot?.snapshot_id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(info.current_snapshot.snapshot_id) ? info.current_snapshot.snapshot_id : null;
    if (n > 0 && snapshotId) {
      const order: IssueSeverity[] = ["critical", "high", "medium", "low"];
      for (const i of [...issues].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || (b.count ?? 0) - (a.count ?? 0)).slice(0, n)) {
        const json = await t.get<{ data?: Record<string, unknown>[] | null }>(client, `${base}/snapshot/${snapshotId}/issue/${i.id}`, { limit: "3" });
        // Not confirmed (live check): the URL field's name in this response.
        i.examples = (json.data ?? []).map((row) => [row.source_url, row.url, row.page_url].find((x): x is string => typeof x === "string")).map((u) => (u ? cleanUrl(u) : null)).filter((u): u is string => Boolean(u)).slice(0, 3);
      }
    }
    const ranAt = auditTime(info.last_audit) ?? new Date().toISOString();
    return { run: { source: "semrush_site_audit", runId: `semrush:${project}@${ranAt}`, ranAt, stale: false }, issues: issues.map(({ id: _id, ...r }) => r) };
  });
}

/** The pre-flight for one read, honouring the cached project list and issue titles (no request). */
export async function estimateSemrushSiteAudit(client: Client, issueUrls: number): Promise<AuditPlan> {
  const { cacheKey, peekCache } = await import("../lib/cache.js");
  const listCached = peekCache(cacheKey("seo", "semrush", "siteAuditProjects", { list: "all" })) !== undefined;
  const metaCached = client.semrushProject ? peekCache(cacheKey("seo", "semrush", "siteAuditMeta", { project: client.semrushProject })) !== undefined : false;
  return planSemrushSiteAudit({ savedProject: Boolean(client.semrushProject), listCached, metaCached, issueUrls });
}
