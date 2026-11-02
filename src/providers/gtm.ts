import { google } from "googleapis";
import { cached, cacheKey, TTL } from "../lib/cache.js";
import { mapLimit } from "../lib/concurrency.js";
import { createLimiter } from "../lib/rate.js";
import { gtmScopeMessage, missingGtmScope } from "../lib/google-auth.js";
import {
  apiErrorInfo,
  classifyGtmError,
  containersFromResponse,
  gtmApiError,
  GtmRateLimitError,
  type GtmContainerRef,
  type GtmIdentity,
  type GtmListing,
} from "../lib/gtm.js";
import type { GtmContainerVersion, GtmWorkspaceInput } from "../analysis/gtm.js";
import type { Client } from "../lib/clients.js";
import { assertGoogleConfigured, googleAuth, googleAuthIdentity, googleAuthStatus } from "./google.js";
import { cliHint } from "../lib/cli-hint.js";

/**
 * Tag Manager API v2 (read-only): container discovery (best-effort, cached per
 * identity like the Search Console and GA4 lists) and the data gtm_audit needs.
 */

const CONTAINER_CONCURRENCY = 2;
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
  if (s.mode === "oauth" && s.scopes && missingGtmScope(s.scopes)) throw new Error(gtmScopeMessage());
}

/** Tag Manager client, or a clear error (Google not set up, token without the scope). */
function gtmClient() {
  assertGoogleConfigured();
  assertGtmScope();
  // retry: false, so gaxios doesn't stack its own 429 retries on top of gtmCall's.
  return google.tagmanager({ version: "v2", auth: googleAuth(), retry: false } as Parameters<typeof google.tagmanager>[0]);
}

// ---------------------------------------------------------------- pacing (D9c)

/** Wait `ms`, or reject with the signal's reason as soon as it aborts. */
const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Aborted");
}

/** Settle with `p`, or reject as soon as `signal` aborts (p keeps running but nobody waits for it). */
function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Test seam: `sleep` is the wait between retries, `pace` the spacing between call starts, `random` the jitter source. */
export const gtmTiming: {
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  pace: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
} = {
  sleep: realSleep,
  pace: realSleep,
  random: (): number => Math.random(),
};

/** Tag Manager's quota is per minute per project: two calls at once, 250 ms apart. */
const gtmLimiter = createLimiter({ maxInFlight: 2, minSpacingMs: 250, sleep: (ms) => gtmTiming.pace(ms) });

const RETRY_WAITS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 29_000];
const RETRY_BUDGET_MS = 60_000;

/** `Retry-After` in ms (seconds or an HTTP date), or undefined. */
function retryAfterMs(err: unknown): number | undefined {
  const h = (err as { response?: { headers?: unknown } })?.response?.headers as
    | { get?: (k: string) => string | null | undefined; [k: string]: unknown }
    | undefined;
  if (!h) return undefined;
  const raw = typeof h.get === "function" ? h.get("retry-after") : h["retry-after"];
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const text = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * Every Tag Manager API call goes through here: paced by the limiter, and retried with backoff (1, 2, 4, 8, 16, 29 s,
 * each +-25%, at most 60 s of waiting in all) when Google answers with a rate limit. A Retry-After header replaces the
 * computed wait when it fits the budget; otherwise we give up. Other errors are thrown untouched.
 */
export async function gtmCall<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let waited = 0;
  let retries = 0;
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await raceAbort(
        gtmLimiter.run(() => {
          signal?.throwIfAborted();
          return fn();
        }),
        signal,
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      if (classifyGtmError(apiErrorInfo(err)) !== "rate-limit") throw err;
      const remaining = RETRY_BUDGET_MS - waited;
      const hinted = retryAfterMs(err);
      let wait: number | undefined;
      if (hinted !== undefined) wait = hinted <= remaining ? hinted : undefined;
      else if (retries < RETRY_WAITS_MS.length && remaining > 0) {
        wait = Math.min(Math.round(RETRY_WAITS_MS[retries]! * (0.75 + gtmTiming.random() * 0.5)), remaining);
      }
      if (wait === undefined) {
        throw new GtmRateLimitError(
          `Tag Manager is rate limiting requests (quota exceeded). Wait a minute and retry. (retried ${retries} time${retries === 1 ? "" : "s"} over ${Math.round(waited / 1000)}s)`,
        );
      }
      await gtmTiming.sleep(wait, signal);
      waited += wait;
      retries++;
    }
  }
}

const failures = new Map<string, { at: number; error: Error }>();

/**
 * Lists the web containers the active identity can read. Account and
 * per-account container lists are cached for a day; a failing account is
 * reported in `errors` and retried next time. A failure of the account list
 * itself throws (remembered for 10 minutes unless `refresh`).
 */
export async function listGtmContainers(opts: { refresh?: boolean; ignoreFailureMemory?: boolean; signal?: AbortSignal } = {}): Promise<Fetched<GtmListing>> {
  const signal = opts.signal;
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
          const res = await gtmCall(() => tm.accounts.list({ pageToken }), signal);
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
            const r = await gtmCall(() => tm.accounts.containers.list({ parent: `accounts/${accountId}`, pageToken }), signal);
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
  /** True when clients.yaml sets gtmContainerId or gtmAccountId. Absent: ids without candidates count as a pin. */
  gtmPinned?: boolean | undefined;
  /** Every container discovery matched to this domain (see Client.gtmCandidates). */
  gtmCandidates?: Client["gtmCandidates"] | undefined;
}

const NO_CONTAINER_HELP =
  "Either give the Google account Read access to the container in Tag Manager (Admin > User Management) and call list_clients with refresh: true " +
  "(containers are matched to clients by the domains listed in the container's settings), or set gtmAccountId and gtmContainerId for the client in clients.yaml " +
  "(the numeric IDs in the Tag Manager URL: /container/accounts/<account>/containers/<container>).";

export interface GtmResolution {
  accountId: string;
  containerId: string;
  chosenBy: "pinned" | "live-page" | "only-candidate";
  /** Notes about how the container was chosen (not the pinned-vs-page warning, which needs the audited container's public ID). */
  notes: string[];
}

/** A pinned container: the ids from clients.yaml. A `GTM-XXXX` public ID, or an ID without an account, is looked up in the listing. */
async function resolvePinned(client: GtmClientIds, signal?: AbortSignal): Promise<{ accountId: string; containerId: string }> {
  const { gtmAccountId: accountId, gtmContainerId: containerId } = client;
  if (!containerId) throw new Error(`No Tag Manager container is pinned for ${client.domain}.`);
  if (accountId && !/^GTM-/i.test(containerId)) return { accountId, containerId };
  const { value } = await listGtmContainers({ ignoreFailureMemory: true, ...(signal ? { signal } : {}) });
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

/**
 * Resolve the container to audit. Pinned (clients.yaml): that one. Otherwise the candidates discovery matched to the
 * domain are checked against the `GTM-` IDs on the live homepage (`pageIds`, null when the page couldn't be read):
 * a candidate on the page wins; else any container this account can see that the page loads; else the single
 * candidate; with several candidates and no page match it refuses and names the pin command.
 */
export async function resolveGtmContainer(client: GtmClientIds, pageIds: string[] | null = null, signal?: AbortSignal): Promise<GtmResolution> {
  const candidates = client.gtmCandidates ?? [];
  const pinned = client.gtmPinned ?? (client.gtmContainerId !== undefined && client.gtmCandidates === undefined);
  if (pinned) return { ...(await resolvePinned(client, signal)), chosenBy: "pinned", notes: [] };

  const loaded = pageIds ?? [];
  for (const id of loaded) {
    const hit = candidates.find((c) => c.publicId.toUpperCase() === id);
    if (!hit) continue;
    const others = candidates.filter((c) => c !== hit).map((c) => c.publicId);
    return {
      accountId: hit.gtmAccountId,
      containerId: hit.gtmContainerId,
      chosenBy: "live-page",
      notes: others.length ? [`Chose ${hit.publicId} because the live homepage loads it (other candidates: ${others.join(", ")}).`] : [],
    };
  }
  if (loaded.length) {
    // Not a candidate, but maybe a container this account can see.
    let visible: GtmContainerRef[] = [];
    try {
      visible = (await listGtmContainers({ ignoreFailureMemory: true, ...(signal ? { signal } : {}) })).value.containers;
    } catch {
      /* discovery failing must not hide the candidates below */
    }
    // Only a container whose own domain list is empty may be taken on the page's word. One that lists other
    // domains belongs to someone else; a page naming it (in text, or a widget) must not steer the audit there.
    for (const id of loaded) {
      const hit = visible.find((c) => c.publicId.toUpperCase() === id && c.domainName.length === 0);
      if (hit) {
        return {
          accountId: hit.accountId,
          containerId: hit.containerId,
          chosenBy: "live-page",
          notes: [`${hit.publicId} is loaded by the live homepage but its Tag Manager settings don't list ${client.domain}.`],
        };
      }
    }
  }
  if (candidates.length === 1) {
    const only = candidates[0]!;
    return {
      accountId: only.gtmAccountId,
      containerId: only.gtmContainerId,
      chosenBy: "only-candidate",
      notes: [
        loaded.length
          ? `The live homepage loads ${loaded.join(", ")}, which this Google account can't see; auditing ${only.publicId} instead.`
          : pageIds === null
            ? "Couldn't read the live homepage to confirm the container."
            : "",
      ].filter(Boolean),
    };
  }
  if (candidates.length > 1) {
    const cli = cliHint();
    throw new Error(
      `${client.domain} matches ${candidates.length} Tag Manager containers (${candidates.map((c) => c.publicId).join(", ")}) and the live homepage doesn't show which one it loads. ` +
        `Pin one with set_client_profile gtmContainerId (or ${cli} clients set ${client.domain} --gtm-container GTM-XXXX).`,
    );
  }
  // Say why discovery found nothing when it failed (API disabled, no scope), rather than only "no container".
  await listGtmContainers({ ignoreFailureMemory: true, ...(signal ? { signal } : {}) });
  throw new Error(
    `No Tag Manager container found for ${client.domain}: discovery didn't match any container whose domain list includes it. ${NO_CONTAINER_HELP}`,
  );
}

/** Live version plus workspace statuses for one container. Cached for an hour. */
export async function fetchGtmAuditData(
  ids: { accountId: string; containerId: string },
  opts: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<Fetched<GtmAuditData>> {
  const signal = opts.signal;
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
        const res = await gtmCall(() => tm.accounts.containers.versions.live({ parent: path }), signal);
        version = res.data as GtmContainerVersion;
        meta = { versionId: res.data.containerVersionId ?? "", name: res.data.name ?? null };
        const c = res.data.container;
        if (c) containerInfo = { ...ids, publicId: c.publicId ?? "", name: c.name ?? ids.containerId, domainName: c.domainName ?? [] };
      } catch (err) {
        if (classifyGtmError(apiErrorInfo(err)) !== "not-found") throw gtmApiError(err, path, who);
        // 404 on `live` means no published version, or no such container. Tell them apart.
        try {
          const c = (await gtmCall(() => tm.accounts.containers.get({ path }), signal)).data;
          containerInfo = { ...ids, publicId: c.publicId ?? "", name: c.name ?? ids.containerId, domainName: c.domainName ?? [] };
        } catch (inner) {
          throw gtmApiError(inner, path, who);
        }
      }

      const workspaces: GtmWorkspaceInput[] = [];
      const workspaceErrors: string[] = [];
      try {
        const list = await gtmCall(() => tm.accounts.containers.workspaces.list({ parent: path }), signal);
        await mapLimit(list.data.workspace ?? [], CONTAINER_CONCURRENCY, async (w) => {
          try {
            const s = await gtmCall(() => tm.accounts.containers.workspaces.getStatus({ path: w.path! }), signal);
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
