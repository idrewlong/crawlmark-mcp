import { analyzeContainerVersion, countBySeverity, summarizeWorkspaces, type GtmFinding, type UnpublishedChanges } from "../analysis/gtm.js";
import { extractGtmIds } from "../lib/gtm.js";
import { fetchGtmAuditData, resolveGtmContainer, type GtmClientIds } from "../providers/gtm.js";
import { fetchRaw } from "../providers/render.js";
import { clientDomainPolicy } from "../user-url.js";

/**
 * gtm_audit composer. Findings use a local type (source "gtm"); run_audit maps
 * them into its findings (analysis/findings.ts) only with includeTagManager (Phase 12, opt-in).
 */
export interface GtmAuditResult {
  client: string;
  container: { accountId: string; containerId: string; publicId: string; name: string; domainName: string[] };
  /** Null when the container has never been published. */
  liveVersion: { versionId: string; name: string | null } | null;
  summary: {
    tags: number;
    triggers: number;
    variables: number;
    findings: number;
    bySeverity: Record<"medium" | "low", number>;
    consentModeDetected: boolean;
  };
  findings: GtmFinding[];
  unpublishedChanges: UnpublishedChanges;
  /** Which container the live homepage loads and how the audited one was chosen (D2). */
  containerCheck: {
    pageUrl: string;
    /** `GTM-` IDs on the homepage; null when the page couldn't be read. */
    pageIds: string[] | null;
    chosenBy: "pinned" | "live-page" | "only-candidate";
    /** Whether the audited container is among pageIds; null when the page wasn't read. */
    onPage: boolean | null;
  };
  notes: string[];
  fromCache: boolean;
}

export interface GtmAuditDeps {
  /** The homepage HTML. Default: fetchRaw (URL guard, egress proxy, client-domain policy). */
  fetchHomepage?: (url: string, signal?: AbortSignal, refresh?: boolean) => Promise<string>;
}

async function defaultFetchHomepage(url: string, signal?: AbortSignal, refresh?: boolean): Promise<string> {
  const res = await fetchRaw(url, { allowUrl: await clientDomainPolicy(), ...(signal ? { signal } : {}), ...(refresh ? { refresh } : {}) });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return res.html;
}

export async function runGtmAudit(
  client: GtmClientIds,
  opts: { refresh?: boolean; signal?: AbortSignal } = {},
  deps: GtmAuditDeps = {},
): Promise<GtmAuditResult> {
  const pageUrl = `https://${client.domain}/`;
  let pageIds: string[] | null = null;
  try {
    pageIds = extractGtmIds(await (deps.fetchHomepage ?? defaultFetchHomepage)(pageUrl, opts.signal, opts.refresh));
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    /* unreadable page: resolveGtmContainer decides what that means */
  }
  const resolved = await resolveGtmContainer(client, pageIds, opts.signal);
  const { value: data, fromCache } = await fetchGtmAuditData(resolved, opts);
  const notes: string[] = [...resolved.notes];
  const publicId = data.container.publicId.toUpperCase();
  const onPage = pageIds === null || !publicId ? null : pageIds.includes(publicId);
  if (resolved.chosenBy === "pinned" && onPage === false && pageIds!.length > 0) {
    notes.push(`The live homepage loads ${pageIds!.join(", ")}, not the pinned ${data.container.publicId}. Check gtmContainerId.`);
  }
  if (!data.liveVersion) notes.push("This container has never been published, so there is no live version to audit. Findings are empty.");
  notes.push(...data.workspaceErrors.map((e) => `Unpublished changes incomplete: ${e}`));
  const analysis = analyzeContainerVersion(data.liveVersion ?? {});
  return {
    client: client.domain,
    container: data.container,
    liveVersion: data.liveVersionMeta,
    summary: {
      ...analysis.counts,
      findings: analysis.findings.length,
      bySeverity: countBySeverity(analysis.findings),
      consentModeDetected: analysis.consentModeDetected,
    },
    findings: analysis.findings,
    unpublishedChanges: summarizeWorkspaces(data.workspaces),
    containerCheck: { pageUrl, pageIds, chosenBy: resolved.chosenBy, onPage },
    notes,
    fromCache,
  };
}
