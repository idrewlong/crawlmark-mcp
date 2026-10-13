import { analyzeContainerVersion, countBySeverity, summarizeWorkspaces, type GtmFinding, type UnpublishedChanges } from "../analysis/gtm.js";
import { fetchGtmAuditData, resolveGtmContainer, type GtmClientIds } from "../providers/gtm.js";

/**
 * gtm_audit composer. Findings use a local type (source "gtm") and are not part
 * of run_audit or analysis/findings.ts yet; follow-up: add "gtm" to FindingSource
 * and an audit section.
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
  notes: string[];
  fromCache: boolean;
}

export async function runGtmAudit(client: GtmClientIds, opts: { refresh?: boolean } = {}): Promise<GtmAuditResult> {
  const ids = await resolveGtmContainer(client);
  const { value: data, fromCache } = await fetchGtmAuditData(ids, opts);
  const notes: string[] = [];
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
    notes,
    fromCache,
  };
}
