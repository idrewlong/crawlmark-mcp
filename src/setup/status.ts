/**
 * setup_status: one row per integration with a state and the exact next step.
 * The checks are injected (StatusProviders), so the mapping from check results
 * to states and next steps is unit tested without network, Chrome or Google.
 * The real providers are in ./status-providers.ts.
 */
import type { DataForSeoStatusResult } from "../providers/dataforseo.js";
import type { GoogleAuthStatus } from "../lib/google-auth.js";
import type { GoogleLiveCheck } from "../providers/google.js";
import type { HomeInfo } from "../lib/home.js";

export type IntegrationState = "configured" | "working" | "missing" | "error";

export const INTEGRATIONS = ["home", "dataforseo", "google", "gsc", "ga4", "tagmanager", "psi", "chrome", "clients"] as const;
export type IntegrationId = (typeof INTEGRATIONS)[number];

export interface IntegrationStatus {
  id: IntegrationId;
  label: string;
  state: IntegrationState;
  /** Plain-language summary. Never contains a secret. */
  detail: string;
  /** A command to run or a URL to open; null when nothing is needed. */
  next: string | null;
  /** Integration-specific facts (mode, balance, email, counts, sample names). */
  data?: Record<string, unknown>;
}

export interface SetupStatusReport {
  home: { dir: string; source: HomeInfo["source"]; reason: string; envFile: string; envFileExists: boolean };
  /** The command that runs crawlmark-cli on this machine (used in every `next`; use it instead of a bare `crawlmark-cli`). */
  cli: string;
  integrations: IntegrationStatus[];
  summary: Record<IntegrationState, number>;
  checkedAt: string;
  fromCache: boolean;
  costUsd: 0;
}

export interface Listing<T> {
  items: T[];
  /** Partial failures that didn't stop the listing. */
  warnings?: string[];
}

export interface StatusProviders {
  /** `configuredByEnv`: integration credentials come from the process environment (an MCP client's env block, e.g. a Claude Desktop bundle) rather than `.env`. */
  home(): { info: HomeInfo; exists: boolean; envFile: string; envFileExists: boolean; configuredByEnv: boolean };
  /** How to invoke the CLI here, e.g. `crawlmark-cli` or `node "/abs/dist/cli.js"`. */
  cli(): string;
  dataforseo(): Promise<DataForSeoStatusResult>;
  googleStatus(): GoogleAuthStatus;
  googleLive(): Promise<GoogleLiveCheck>;
  gscSites(refresh: boolean): Promise<Listing<string>>;
  ga4Properties(refresh: boolean): Promise<Listing<{ id: string; name: string }>>;
  gtmContainers(refresh: boolean): Promise<Listing<{ publicId: string; name: string }>>;
  psiKeySet(): boolean;
  chrome(): Promise<{ ok: true; version: string } | { ok: false; error: string }>;
  clients(): { count: number; ignored: number; file: string; exists: boolean };
}

export const LINKS = {
  dataforseoApiAccess: "https://app.dataforseo.com/api-access",
  dataforseoStatus: "https://status.dataforseo.com/",
  enableSearchConsole: "https://console.cloud.google.com/apis/library/searchconsole.googleapis.com",
  enableAnalyticsData: "https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com",
  enableAnalyticsAdmin: "https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com",
  enableTagManager: "https://console.cloud.google.com/apis/library/tagmanager.googleapis.com",
  enablePageSpeed: "https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com",
  credentials: "https://console.cloud.google.com/apis/credentials",
  searchConsoleUsers: "https://search.google.com/search-console/users",
  ga4Access: "https://analytics.google.com/analytics/web/#/admin",
  tagManager: "https://tagmanager.google.com/",
} as const;

/** Sample size for lists in the report (counts are always complete). */
const SAMPLE = 25;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** "API has not been used ... or it is disabled" / SERVICE_DISABLED / accessNotConfigured. */
export function isApiDisabled(message: string): boolean {
  return /SERVICE_DISABLED|accessNotConfigured|has not been used in project|is disabled|API has not been used/i.test(message);
}

function listingStatus<T>(
  id: "gsc" | "ga4" | "tagmanager",
  label: string,
  result: { ok: true; listing: Listing<T> } | { ok: false; error: string },
  opts: { noun: string; sample: (t: T) => unknown; enableUrl: string; emptyNext: string; shareHint: string },
): IntegrationStatus {
  if (!result.ok) {
    const disabled = isApiDisabled(result.error);
    return {
      id,
      label,
      state: "error",
      detail: disabled ? `The ${label} API isn't enabled in the Google Cloud project.` : result.error.slice(0, 300),
      next: disabled ? opts.enableUrl : opts.emptyNext,
    };
  }
  const { items, warnings } = result.listing;
  const data = { count: items.length, sample: items.slice(0, SAMPLE).map(opts.sample), ...(warnings?.length ? { warnings } : {}) };
  if (items.length === 0) {
    return { id, label, state: "configured", detail: `Signed in, but no ${opts.noun} are visible. ${opts.shareHint}`, next: opts.emptyNext, data };
  }
  return { id, label, state: "working", detail: `${items.length} ${opts.noun} visible.`, next: null, data };
}

async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; listing: T } | { ok: false; error: string }> {
  try {
    return { ok: true, listing: await fn() };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

/** Compute the report. `only` limits which integrations are checked (the wizard checks one step at a time). */
export async function collectSetupStatus(
  p: StatusProviders,
  opts: { only?: readonly IntegrationId[]; refresh?: boolean } = {},
): Promise<Omit<SetupStatusReport, "fromCache">> {
  const want = (id: IntegrationId) => !opts.only || opts.only.includes(id);
  const refresh = opts.refresh ?? false;
  const cli = p.cli();
  const home = p.home();
  const step = (name: string) => `${cli} setup --step ${name}`;
  const out: IntegrationStatus[] = [];

  if (want("home")) {
    out.push(
      !home.envFileExists && home.configuredByEnv
        ? { id: "home", label: "Config home", state: "working", detail: `Settings come from the environment (no .env needed); data lives in ${home.info.dir} (${home.info.reason}).`, next: null }
        : !home.exists
        ? { id: "home", label: "Config home", state: "missing", detail: `${home.info.dir} doesn't exist yet (${home.info.reason}).`, next: `${cli} setup` }
        : home.envFileExists
          ? { id: "home", label: "Config home", state: "working", detail: `${home.info.dir} (${home.info.reason}).`, next: null }
          : { id: "home", label: "Config home", state: "configured", detail: `${home.info.dir} exists but has no .env yet (${home.info.reason}).`, next: `${cli} setup` },
    );
    out[out.length - 1]!.data = { dir: home.info.dir, source: home.info.source, envFile: home.envFile, configuredByEnv: home.configuredByEnv };
  }

  // Independent network checks run in parallel.
  const google = p.googleStatus();
  const googleUsable = google.mode !== "none" && !google.problem;
  const [dfs, live, chrome] = await Promise.all([
    want("dataforseo") ? p.dataforseo() : undefined,
    googleUsable && (want("google") || want("gsc") || want("ga4") || want("tagmanager")) ? p.googleLive() : undefined,
    want("chrome") ? p.chrome() : undefined,
  ]);

  if (dfs) {
    const data = { mode: dfs.mode, apiHost: dfs.apiHost, ...("balanceUsd" in dfs ? { balanceUsd: dfs.balanceUsd } : {}) };
    if (dfs.credentialsWork === true) {
      const balance = "balanceUsd" in dfs && dfs.balanceUsd !== null ? `, balance $${dfs.balanceUsd.toFixed(2)}` : "";
      out.push({
        id: "dataforseo",
        label: "DataForSEO",
        state: "working",
        detail: `Credentials work (${dfs.mode} mode${balance}).${dfs.mode === "sandbox" ? " Sandbox returns sample data at no cost." : " Live mode is billed per call."}`,
        next: null,
        data,
      });
    } else if (!dfs.credentialsConfigured) {
      out.push({ id: "dataforseo", label: "DataForSEO", state: "missing", detail: "No DataForSEO login set. Paid keyword, SERP and backlink tools won't work; everything else does.", next: step("dataforseo"), data });
    } else if (dfs.credentialsWork === false) {
      out.push({ id: "dataforseo", label: "DataForSEO", state: "error", detail: "DataForSEO rejected the login and password (use the API password from the dashboard, not the account password).", next: step("dataforseo"), data });
    } else {
      out.push({ id: "dataforseo", label: "DataForSEO", state: "configured", detail: `Credentials are set but DataForSEO couldn't be reached, so they're untested: ${dfs.error}`, next: LINKS.dataforseoStatus, data });
    }
  }

  const googleNext = google.mode === "oauth" && google.configured && !google.signedIn ? `${cli} auth login` : step("google");
  if (want("google")) {
    const data: Record<string, unknown> = { mode: google.mode, auto: google.auto, ...("email" in google && google.email ? { email: google.email } : {}) };
    if (google.mode === "none") {
      out.push({ id: "google", label: "Google", state: "missing", detail: "Google isn't set up. Search Console, GA4 and Tag Manager are unavailable; DataForSEO, Lighthouse and accessibility checks still work.", next: step("google"), data });
    } else if (google.problem) {
      out.push({ id: "google", label: "Google", state: "error", detail: google.problem, next: googleNext, data });
    } else if (live?.ok) {
      const who = "email" in google && google.email ? ` as ${google.email}` : "";
      out.push({ id: "google", label: "Google", state: "working", detail: `${google.mode === "oauth" ? "OAuth sign-in" : "Service account"}${who} works.`, next: null, data });
    } else {
      out.push({ id: "google", label: "Google", state: "error", detail: `Google rejected the ${google.mode === "oauth" ? "sign-in" : "key"}: ${live?.error ?? "unknown error"}`, next: google.mode === "oauth" ? `${cli} auth login` : step("google"), data });
    }
  }

  const googleOk = googleUsable && live?.ok === true;
  const notReady = (id: "gsc" | "ga4" | "tagmanager", label: string): IntegrationStatus => ({
    id,
    label,
    state: google.mode === "none" ? "missing" : "error",
    detail: google.mode === "none" ? "Needs Google." : "Google auth isn't working, so this can't be checked.",
    next: googleNext,
  });
  const shareTarget = google.mode === "service_account" && google.email ? `the service account ${google.email}` : "the signed-in account";

  if (want("gsc")) {
    out.push(
      googleOk
        ? listingStatus("gsc", "Search Console", await attempt(() => p.gscSites(refresh)), {
            noun: "Search Console properties",
            sample: (s) => s,
            enableUrl: LINKS.enableSearchConsole,
            emptyNext: LINKS.searchConsoleUsers,
            shareHint: `Add ${shareTarget} to each property under Settings > Users and permissions.`,
          })
        : notReady("gsc", "Search Console"),
    );
  }
  if (want("ga4")) {
    out.push(
      googleOk
        ? listingStatus("ga4", "GA4", await attempt(() => p.ga4Properties(refresh)), {
            noun: "GA4 properties",
            sample: (x) => x,
            enableUrl: LINKS.enableAnalyticsAdmin,
            emptyNext: LINKS.ga4Access,
            shareHint: `Add ${shareTarget} as a Viewer under Admin > Property access management.`,
          })
        : notReady("ga4", "GA4"),
    );
  }
  if (want("tagmanager")) {
    if (!googleOk) out.push(notReady("tagmanager", "Tag Manager"));
    else if (live?.gtmScopeMissing) {
      out.push({ id: "tagmanager", label: "Tag Manager", state: "error", detail: "The Google sign-in doesn't include Tag Manager access.", next: `${cli} auth login` });
    } else {
      const s = listingStatus("tagmanager", "Tag Manager", await attempt(() => p.gtmContainers(refresh)), {
        noun: "web containers",
        sample: (c) => c,
        enableUrl: LINKS.enableTagManager,
        emptyNext: LINKS.tagManager,
        shareHint: `Give ${shareTarget} Read access under Admin > User Management (optional; only gtm_audit needs it).`,
      });
      // A disabled API is the one failure listingStatus points at the enable page for.
      s.data = { ...s.data, apiEnabled: !(s.state === "error" && s.next === LINKS.enableTagManager) };
      out.push(s);
    }
  }

  if (want("psi")) {
    out.push(
      p.psiKeySet()
        ? { id: "psi", label: "PageSpeed Insights", state: "configured", detail: "PSI_API_KEY is set (not checked here, to keep this call fast); lighthouse adds real-user field data.", next: null }
        : { id: "psi", label: "PageSpeed Insights", state: "missing", detail: "Optional. Without a key, Lighthouse still runs locally but without real-user (CrUX) field data.", next: step("psi") },
    );
  }

  if (chrome) {
    out.push(
      chrome.ok
        ? { id: "chrome", label: "Chrome", state: "working", detail: `Headless Chrome launches (${chrome.version}).`, next: null, data: { version: chrome.version } }
        : { id: "chrome", label: "Chrome", state: "error", detail: `Headless Chrome didn't launch: ${chrome.error.slice(0, 300)}`, next: "npx puppeteer browsers install chrome" },
    );
  }

  if (want("clients")) {
    let c: ReturnType<StatusProviders["clients"]> | undefined;
    try {
      c = p.clients();
    } catch (err) {
      out.push({ id: "clients", label: "Clients", state: "error", detail: errorText(err).slice(0, 300), next: `${cli} clients list` });
    }
    const data = c && { count: c.count, ignored: c.ignored, file: c.file };
    if (c) out.push(
      c.count > 0
        ? { id: "clients", label: "Clients", state: "working", detail: `${c.count} client(s) in ${c.file}${c.ignored ? ` (${c.ignored} ignored)` : ""}.`, next: null, data }
        : {
            id: "clients",
            label: "Clients",
            state: "missing",
            detail: c.exists ? `${c.file} has no clients yet.` : `${c.file} doesn't exist yet.`,
            next: google.mode === "none" ? `${cli} clients add <domain>` : step("discovery"),
            data,
          },
    );
  }

  const summary: Record<IntegrationState, number> = { working: 0, configured: 0, missing: 0, error: 0 };
  for (const i of out) summary[i.state]++;
  return {
    home: { dir: home.info.dir, source: home.info.source, reason: home.info.reason, envFile: home.envFile, envFileExists: home.envFileExists },
    cli,
    integrations: out,
    summary,
    checkedAt: new Date().toISOString(),
    costUsd: 0,
  };
}

/** A 60-second cache over collectSetupStatus, keyed by `only`, shared by the MCP tool and the CLI. */
export function cachedStatus(p: StatusProviders, ttlMs = 60_000, now: () => number = Date.now) {
  const memo = new Map<string, { at: number; value: Promise<Omit<SetupStatusReport, "fromCache">> }>();
  return async (opts: { only?: readonly IntegrationId[]; refresh?: boolean } = {}): Promise<SetupStatusReport> => {
    const key = (opts.only ? [...opts.only].sort() : ["*"]).join(",");
    const hit = memo.get(key);
    if (!opts.refresh && hit && now() - hit.at < ttlMs) return { ...(await hit.value), fromCache: true };
    const value = collectSetupStatus(p, opts);
    memo.set(key, { at: now(), value });
    value.catch(() => memo.delete(key));
    return { ...(await value), fromCache: false };
  };
}
