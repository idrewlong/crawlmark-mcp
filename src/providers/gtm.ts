import { google } from "googleapis";
import { cached, cacheKey, TTL } from "../lib/cache.js";
import { mapLimit } from "../lib/concurrency.js";
import { GTM_SCOPE_MESSAGE, missingGtmScope } from "../lib/google-auth.js";
import {
  apiErrorInfo,
  classifyGtmError,
  containersFromResponse,
  gtmApiError,
  type GtmContainerRef,
  type GtmIdentity,
  type GtmListing,
} from "../lib/gtm.js";
import type { GtmContainerVersion, GtmWorkspaceInput } from "../analysis/gtm.js";
import { assertGoogleConfigured, googleAuth, googleAuthIdentity, googleAuthStatus } from "./google.js";

/**
 * Tag Manager API v2 (read-only): container discovery (best-effort, cached per
 * identity like the Search Console and GA4 lists) and the data gtm_audit needs.
 */

const CONTAINER_CONCURRENCY = 5;
/** How long a failed discovery is remembered, so each tool call doesn't re-hit a failing API. `refresh` bypasses it. */
const FAILURE_MEMORY_MS = 10 * 60_000;

export interface Fetched<T> {
  value: T;
  fromCache: boolean;
}

function whoAmI(): GtmIdentity {
  const s = googleAuthStatus();
  return s.mode === "none" ? { mode: "none" } : { mode: s.mode, email: s.email };
}

/** OAuth tokens from before Phase 6b lack the Tag Manager scope: say so before calling. */
function assertGtmScope(): void {
  const s = googleAuthStatus();
  if (s.mode === "oauth" && s.scopes && missingGtmScope(s.scopes)) throw new Error(GTM_SCOPE_MESSAGE);
}

/** Tag Manager client, or a clear error (Google not set up, token without the scope). */
function gtmClient() {
  assertGoogleConfigured();
  assertGtmScope();
  return google.tagmanager({ version: "v2", auth: googleAuth() });
}

const failures = new Map<string, { at: number; error: Error }>();

/**
 * Lists the web containers the active identity can read. Account and
 * per-account container lists are cached for a day; a failing account is
 * reported in `errors` and retried next time. A failure of the account list
 * itself throws (remembered for 10 minutes unless `refresh`).
 */
export async function listGtmContainers(opts: { refresh?: boolean; ignoreFailureMemory?: boolean } = {}): Promise<Fetched<GtmListing>> {
  const tm = gtmClient();
  const id = googleAuthIdentity();
  const who = whoAmI();
  const remembered = failures.get(id);
  if (!opts.refresh && !opts.ignoreFailureMemory && remembered && Date.now() - remembered.at < FAILURE_MEMORY_MS) throw remembered.error;

  let accounts: Fetched<string[]>;
  try {
    accounts = await cached(
      cacheKey("discovery-gtm-accounts", id),
      TTL.day,
      async () => {
        const out: string[] = [];
        let pageToken: string | undefined;
        do {
          const res = await tm.accounts.list({ pageToken });
          for (const a of res.data.account ?? []) if (a.accountId) out.push(a.accountId);
          pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken);
        return out;
      },
      opts,
    );
  } catch (err) {
    const error = gtmApiError(err, "the Tag Manager accounts list", who);
    failures.set(id, { at: Date.now(), error });
    throw error;
  }
  failures.delete(id);

  const errors: string[] = [];
  let allFromCache = accounts.fromCache;
  const lists = await mapLimit(accounts.value, CONTAINER_CONCURRENCY, async (accountId): Promise<GtmContainerRef[]> => {
    try {
      const res = await cached(
        cacheKey("discovery-gtm-containers", id, accountId),
        TTL.day,
        async () => {
          const out: GtmContainerRef[] = [];
          let pageToken: string | undefined;
          do {
            const r = await tm.accounts.containers.list({ parent: `accounts/${accountId}`, pageToken });
            out.push(...containersFromResponse(r.data));
            pageToken = r.data.nextPageToken ?? undefined;
          } while (pageToken);
          return out;
        },
        opts,
      );
      if (!res.fromCache) allFromCache = false;
      return res.value;
    } catch (err) {
      errors.push(`Tag Manager account ${accountId}: could not list containers: ${apiErrorInfo(err).message}`);
      return [];
    }
  });
  return { value: { containers: lists.flat(), errors }, fromCache: allFromCache };
}

// ---------------------------------------------------------------- audit data

export interface GtmAuditData {
  container: { accountId: string; containerId: string; publicId: string; name: string; domainName: string[] };
  /** Null when the container has never been published. */
  liveVersion: GtmContainerVersion | null;
  liveVersionMeta: { versionId: string; name: string | null } | null;
  workspaces: GtmWorkspaceInput[];
  /** Workspaces whose status could not be read. */
  workspaceErrors: string[];
}

export interface GtmClientIds {
  domain: string;
  gtmAccountId?: string | undefined;
  gtmContainerId?: string | undefined;
}

const NO_CONTAINER_HELP =
  "Either give the Google account Read access to the container in Tag Manager (Admin > User Management) and call list_clients with refresh: true " +
  "(containers are matched to clients by the domains listed in the container's settings), or set gtmAccountId and gtmContainerId for the client in clients.yaml " +
  "(the numeric IDs in the Tag Manager URL: /container/accounts/<account>/containers/<container>).";

/**
 * Resolve the container to audit: the ids from clients.yaml or discovery. A
 * pinned container id without an account (or a `GTM-XXXX` public ID) is looked
 * up in the discovery listing.
 */
export async function resolveGtmContainer(client: GtmClientIds): Promise<{ accountId: string; containerId: string }> {
  const { gtmAccountId: accountId, gtmContainerId: containerId } = client;
  if (!containerId) {
    // Say why discovery found nothing when it failed (API disabled, no scope), rather than only "no container".
    await listGtmContainers({ ignoreFailureMemory: true });
    throw new Error(
      `No Tag Manager container found for ${client.domain}: discovery didn't match any container whose domain list includes it. ${NO_CONTAINER_HELP}`,
    );
  }
  if (accountId && !/^GTM-/i.test(containerId)) return { accountId, containerId };
  const { value } = await listGtmContainers({ ignoreFailureMemory: true });
  const hit = value.containers.find(
    (c) => (c.containerId === containerId || c.publicId.toUpperCase() === containerId.toUpperCase()) && (!accountId || c.accountId === accountId),
  );
  if (!hit) {
    throw new Error(
      `Tag Manager container ${containerId} (set in clients.yaml for ${client.domain}) isn't visible to this Google account. ${NO_CONTAINER_HELP}`,
    );
  }
  return { accountId: hit.accountId, containerId: hit.containerId };
}

/** Live version plus workspace statuses for one container. Cached for an hour. */
export async function fetchGtmAuditData(
  ids: { accountId: string; containerId: string },
  opts: { refresh?: boolean } = {},
): Promise<Fetched<GtmAuditData>> {
  const tm = gtmClient();
  const path = `accounts/${ids.accountId}/containers/${ids.containerId}`;
  const who = whoAmI();
  return cached(
    cacheKey("gtm-audit", googleAuthIdentity(), path),
    TTL.hour,
    async (): Promise<GtmAuditData> => {
      let version: GtmContainerVersion | null = null;
      let meta: GtmAuditData["liveVersionMeta"] = null;
      let containerInfo: GtmAuditData["container"] = { ...ids, publicId: "", name: ids.containerId, domainName: [] };
      try {
        const res = await tm.accounts.containers.versions.live({ parent: path });
        version = res.data as GtmContainerVersion;
        meta = { versionId: res.data.containerVersionId ?? "", name: res.data.name ?? null };
        const c = res.data.container;
        if (c) containerInfo = { ...ids, publicId: c.publicId ?? "", name: c.name ?? ids.containerId, domainName: c.domainName ?? [] };
      } catch (err) {
        if (classifyGtmError(apiErrorInfo(err)) !== "not-found") throw gtmApiError(err, path, who);
        // 404 on `live` means no published version, or no such container. Tell them apart.
        try {
          const c = (await tm.accounts.containers.get({ path })).data;
          containerInfo = { ...ids, publicId: c.publicId ?? "", name: c.name ?? ids.containerId, domainName: c.domainName ?? [] };
        } catch (inner) {
          throw gtmApiError(inner, path, who);
        }
      }

      const workspaces: GtmWorkspaceInput[] = [];
      const workspaceErrors: string[] = [];
      try {
        const list = await tm.accounts.containers.workspaces.list({ parent: path });
        await mapLimit(list.data.workspace ?? [], CONTAINER_CONCURRENCY, async (w) => {
          try {
            const s = await tm.accounts.containers.workspaces.getStatus({ path: w.path! });
            workspaces.push({ workspaceId: w.workspaceId ?? "", name: w.name ?? "(unnamed)", status: s.data as GtmWorkspaceInput["status"] });
          } catch (err) {
            workspaceErrors.push(`workspace ${w.name ?? w.workspaceId}: ${apiErrorInfo(err).message}`);
          }
        });
      } catch (err) {
        workspaceErrors.push(`could not list workspaces: ${apiErrorInfo(err).message}`);
      }
      workspaces.sort((a, b) => Number(a.workspaceId) - Number(b.workspaceId));
      return { container: containerInfo, liveVersion: version, liveVersionMeta: meta, workspaces, workspaceErrors };
    },
    opts,
  );
}
