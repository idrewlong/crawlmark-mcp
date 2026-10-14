/**
 * setup_status: one row per integration with a state and the exact next step.
 * The checks are injected (StatusProviders), so the mapping from check results
 * to states and next steps is unit tested without network, Chrome or Google.
 * The real providers are in ./status-providers.ts.
 */
import type { AhrefsKeyCheck } from "../providers/ahrefs.js";
import type { SemrushKeyCheck } from "../providers/semrush.js";
import { describeAhrefsAccount } from "../providers/ahrefs-shape.js";
import type { DataForSeoStatusResult } from "../providers/dataforseo.js";
import type { GoogleAuthStatus } from "../lib/google-auth.js";
import type { GoogleLiveCheck } from "../providers/google.js";
import type { HomeInfo } from "../lib/home.js";
import { displayProviderValue, invalidProviderMessage, PROVIDER_LABELS, type DefaultProviderSource, type ProviderId } from "../lib/provider-ids.js";

export type IntegrationState = "configured" | "working" | "missing" | "error";

export const INTEGRATIONS = ["home", "dataforseo", "seoprovider", "ahrefs", "semrush", "google", "gsc", "ga4", "tagmanager", "psi", "crux", "bing", "aivisibility", "chrome", "clients"] as const;
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
  /** Phase 9: the `seoprovider` row's data (default provider, where it comes from, which providers have keys), when that row was checked. */
  seoDataProvider?: SeoDataProviderData;
}

/** The default SEO data provider as setup_status reports it (also `report.seoDataProvider`). */
export interface SeoDataProviderData {
  /** null when SEO_DATA_PROVIDER holds an unknown value. */
  default: ProviderId | null;
  source: DefaultProviderSource;
  invalidValue?: string;
  /** Which providers have a key/login set (not whether it works). */
  configured: Record<ProviderId, boolean>;
  /** Clients whose clients.yaml dataProvider overrides the default. */
  perClientOverrides: number;
  /** The terminal command that changes it (never an MCP tool: D12). */
  change: string;
}

export interface SeoDataProviderInput {
  default: ProviderId | null;
  source: DefaultProviderSource;
  invalidValue?: string;
  perClientOverrides: number;
}

export interface Listing<T> {
  items: T[];
  /** Partial failures that didn't stop the listing. */
  warnings?: string[];
}

/** Whether a unit-billed provider is anyone's choice: the default, and/or this many clients' dataProvider. */
export interface ProviderChoice {
  byDefault: boolean;
  clients: number;
}

export interface AhrefsStatusInput {
  check: AhrefsKeyCheck;
  chosen: ProviderChoice;
  /** Units crawlmark recorded this calendar month, and its global cap. */
  unitsUsedThisMonth: number;
  cap: number;
}

export interface SemrushStatusInput {
  check: SemrushKeyCheck;
  chosen: ProviderChoice;
  /** SEMRUSH_V4_API_KEY is set (it has no free check, so it's untested until backlinks_summary runs). */
  v4KeySet: boolean;
  unitsUsedThisMonth: number;
  cap: number;
}

export interface StatusProviders {
  /** `configuredByEnv`: integration credentials come from the process environment (an MCP client's env block, e.g. a Claude Desktop bundle) rather than `.env`. */
  home(): { info: HomeInfo; exists: boolean; envFile: string; envFileExists: boolean; configuredByEnv: boolean };
  /** How to invoke the CLI here, e.g. `crawlmark-cli` or `node "/abs/dist/cli.js"`. */
  cli(): string;
  dataforseo(): Promise<DataForSeoStatusResult>;
  /** The free Ahrefs limits-and-usage check plus who uses Ahrefs and this month's units. */
  ahrefs(): Promise<AhrefsStatusInput>;
  /** The free Semrush balance check plus who uses Semrush, whether a v4 key is set, and this month's units. */
  semrush(): Promise<SemrushStatusInput>;
  /** The default SEO data provider (SEO_DATA_PROVIDER, resolved leniently) and how many clients override it. */
  seoDataProvider(): SeoDataProviderInput;
  googleStatus(): GoogleAuthStatus;
  googleLive(): Promise<GoogleLiveCheck>;
  gscSites(refresh: boolean): Promise<Listing<string>>;
  ga4Properties(refresh: boolean): Promise<Listing<{ id: string; name: string }>>;
  gtmContainers(refresh: boolean): Promise<Listing<{ publicId: string; name: string }>>;
  psiKeySet(): boolean;
  /** Phase 12: which key CrUX History would use (CRUX_API_KEY, else PSI_API_KEY) and a free live check of it; absent means no row data. */
  crux?(): Promise<{ source: "CRUX_API_KEY" | "PSI_API_KEY" | null; check: { ok: true } | { ok: false; problem: string } | null }>;
  /** Phase 12 C3: whether BING_WEBMASTER_API_KEY is set and a free live check of it (GetUserSites); absent means no row data. */
  bing?(): Promise<{ keySet: boolean; check: { ok: true; sites: number; verified: number } | { ok: false; kind?: "refused" | "network" | "throttled" | "other"; problem: string } | null }>;
  /** Phase 12 C5: the AI_VISIBILITY_ENABLED switch (raw value too, to flag a typo) and this month's AI spend against its sub-cap; no network. */
  aiVisibility?(): { enabled: boolean; raw: string | null; dataForSeo: boolean; capUsd: number; spentUsd: number };
  /** `binary` says which browser ran (headless shell, Chrome, system Chrome or CHROME_PATH); absent in stubs. */
  chrome(): Promise<{ ok: true; version: string; binary?: { kind: string; label: string; path: string } } | { ok: false; error: string }>;
  clients(): { count: number; ignored: number; file: string; exists: boolean };
}

export const LINKS = {
  dataforseoApiAccess: "https://app.dataforseo.com/api-access",
  dataforseoStatus: "https://status.dataforseo.com/",
  ahrefsApiKeys: "https://app.ahrefs.com/account/api-keys",
  enableSearchConsole: "https://console.cloud.google.com/apis/library/searchconsole.googleapis.com",
  enableAnalyticsData: "https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com",
  enableAnalyticsAdmin: "https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com",
  enableTagManager: "https://console.cloud.google.com/apis/library/tagmanager.googleapis.com",
  enablePageSpeed: "https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com",
  enableCrux: "https://console.cloud.google.com/apis/library/chromeuxreport.googleapis.com",
  bingWebmaster: "https://www.bing.com/webmasters",
  aiVisibilityDocs: "https://github.com/idrewlong/crawlmark-mcp#ai-search-visibility-optional-paid",
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

/** A provider's key state from its free check: working, configured (unreachable), error (rejected) or missing (no key). */
function dfsState(d: DataForSeoStatusResult): IntegrationState {
  if (d.credentialsWork === true) return "working";
  if (!d.credentialsConfigured) return "missing";
  return d.credentialsWork === false ? "error" : "configured";
}
export function keyState(c: { configured: boolean; works: boolean | null }): IntegrationState {
  if (c.works === true) return "working";
  if (!c.configured) return "missing";
  return c.works === false ? "error" : "configured";
}

const SOURCE_TEXT: Record<DefaultProviderSource, string> = { envFile: "from .env", env: "from the environment", default: "built-in default" };

/** The bundle's settings field, when the value comes from Claude Desktop's extension settings. */
export const BUNDLE_PROVIDER_FIELD = 'Change "Default SEO data provider" in Claude Desktop > Settings > Extensions > Crawlmark';

/**
 * The `seoprovider` row (spec 9.6): working when the default is valid and its provider works,
 * configured when that provider is set but unreachable, missing when nothing is chosen
 * (SEO_DATA_PROVIDER unset) and DataForSEO has no login, error when the default is invalid or an
 * explicitly chosen provider has no working key. `next` is the CLI command, or the bundle field when the value comes
 * from the process env of a bundle install.
 */
export function seoProviderRow(
  seo: SeoDataProviderInput,
  states: Record<ProviderId, IntegrationState>,
  o: { cli: string; configuredByEnv: boolean },
): IntegrationStatus {
  const change = `${o.cli} setup --step provider`;
  const data: SeoDataProviderData = {
    default: seo.default,
    source: seo.source,
    ...(seo.invalidValue !== undefined ? { invalidValue: seo.invalidValue } : {}),
    configured: { dataforseo: states.dataforseo !== "missing", ahrefs: states.ahrefs !== "missing", semrush: states.semrush !== "missing" },
    perClientOverrides: seo.perClientOverrides,
    change,
  };
  const next = seo.source === "env" && o.configuredByEnv ? BUNDLE_PROVIDER_FIELD : change;
  const base = { id: "seoprovider" as const, label: "Data provider", data: data as unknown as Record<string, unknown> };
  const overrides = seo.perClientOverrides ? ` ${seo.perClientOverrides} client(s) override it in clients.yaml.` : "";
  if (seo.default === null) {
    return { ...base, state: "error", detail: invalidProviderMessage(displayProviderValue(seo.invalidValue ?? "")), next };
  }
  const label = PROVIDER_LABELS[seo.default];
  const head = `${label} (default, ${SOURCE_TEXT[seo.source]}).`;
  const tail = seo.default === "dataforseo" ? "" : " DataForSEO for live SERPs, on-page and crawls.";
  const st = states[seo.default];
  if (st === "working") return { ...base, state: "working", detail: `${head}${tail}${overrides}`, next: null };
  if (st === "configured") return { ...base, state: "configured", detail: `${head} Its key is set but couldn't be checked just now.${tail}${overrides}`, next };
  // Nothing chosen and no DataForSEO login: a fresh or free-only install, not an error.
  if (seo.source === "default" && st === "missing") {
    return { ...base, state: "missing", detail: `No paid data provider is set up (the default is DataForSEO). Free tools work; keyword, ranking, competitor and backlink tools need DataForSEO, Ahrefs or Semrush.${overrides}`, next };
  }
  return {
    ...base,
    state: "error",
    detail: `${head} ${st === "missing" ? `${label} isn't set up, so the paid keyword, ranking, competitor and backlink tools fail.` : `${label} rejected its key.`}${overrides}`,
    next,
  };
}

const fmtUnits = (n: number | null) => (n === null ? "?" : n.toLocaleString("en-US"));
const choiceText = (c: ProviderChoice) =>
  [c.byDefault ? "the default provider" : "", c.clients ? `the provider for ${c.clients} client(s)` : ""].filter(Boolean).join(" and ");

/**
 * The `ahrefs` row (spec 9.6): missing (no key, nobody uses it), error (used but no key,
 * or the key was rejected), configured (Ahrefs unreachable, so untested), working.
 * `data` never contains the key.
 */
export function ahrefsRow(a: AhrefsStatusInput, next: string): IntegrationStatus {
  const { check, chosen } = a;
  const used = chosen.byDefault || chosen.clients > 0;
  const base = { id: "ahrefs" as const, label: "Ahrefs" };
  const data: Record<string, unknown> = {
    default: chosen.byDefault,
    clients: chosen.clients,
    keySet: check.configured,
    unitsUsedThisMonth: a.unitsUsedThisMonth,
    cap: a.cap,
  };
  if (check.works === true) {
    const acct = check as Extract<AhrefsKeyCheck, { works: true }>;
    data.plan = acct.plan;
    data.unitsUsedApiKey = acct.unitsUsageApiKey;
    data.unitsLimitApiKey = acct.unitsLimitApiKey;
    data.resetDate = acct.resetDate;
  }
  const usage = `crawlmark used ${fmtUnits(a.unitsUsedThisMonth)} of its ${fmtUnits(a.cap)}-unit monthly cap`;
  if (!check.configured) {
    return used
      ? { ...base, state: "error", detail: `Ahrefs is ${choiceText(chosen)}, but AHREFS_API_KEY is not set, so its paid calls fail.`, next, data }
      : { ...base, state: "missing", detail: "Optional. An Ahrefs API v3 key (Lite plan or higher) can supply keyword, ranking, competitor and backlink data.", next, data };
  }
  if (check.works === false) return { ...base, state: "error", detail: check.error, next, data };
  if (check.works === null) {
    return { ...base, state: "configured", detail: `AHREFS_API_KEY is set but Ahrefs couldn't be reached, so it's untested: ${check.error}`, next, data };
  }
  const acct = check as Extract<AhrefsKeyCheck, { works: true }>;
  return {
    ...base,
    state: "working",
    detail: `Key works (${describeAhrefsAccount(acct)}); ${usage} this month.${used ? ` Used as ${choiceText(chosen)}.` : ""}`,
    next: null,
    data,
  };
}

/**
 * The `semrush` row (spec 9.6): missing (no key, nobody uses it), error (used but no key,
 * or rejected), configured (the balance check couldn't be reached, the balance is 0, or a
 * v4 key is set but untested: it has no free check), working. Never a key.
 */
export function semrushRow(s: SemrushStatusInput, next: string): IntegrationStatus {
  const { check, chosen } = s;
  const used = chosen.byDefault || chosen.clients > 0;
  const base = { id: "semrush" as const, label: "Semrush" };
  const data: Record<string, unknown> = {
    default: chosen.byDefault,
    clients: chosen.clients,
    keySet: check.configured,
    v4KeySet: s.v4KeySet,
    unitsUsedThisMonth: s.unitsUsedThisMonth,
    cap: s.cap,
    ...(check.works === true ? { unitsLeft: (check as Extract<SemrushKeyCheck, { works: true }>).unitsLeft } : {}),
  };
  const usage = `crawlmark used ${fmtUnits(s.unitsUsedThisMonth)} of its ${fmtUnits(s.cap)}-unit monthly cap this month`;
  if (!check.configured) {
    return used
      ? { ...base, state: "error", detail: `Semrush is ${choiceText(chosen)}, but SEMRUSH_API_KEY is not set, so its paid calls fail.`, next, data }
      : { ...base, state: "missing", detail: "Optional. A Semrush API key (SEO Business plan plus an API unit package) can supply keyword, ranking, competitor and backlink data.", next, data };
  }
  if (check.works === false) return { ...base, state: "error", detail: check.error, next, data };
  if (check.works === null) {
    return { ...base, state: "configured", detail: `SEMRUSH_API_KEY is set but Semrush's balance check couldn't be reached, so it's untested: ${check.error}`, next, data };
  }
  const left = (check as Extract<SemrushKeyCheck, { works: true }>).unitsLeft;
  const v4 = s.v4KeySet ? " The v4 key (backlinks) has no free check; it's checked the first time backlinks_summary runs." : " Backlinks use the v3 report (no v4 key set).";
  const head = `Key accepted, ${fmtUnits(left)} API units left; ${usage}.${used ? ` Used as ${choiceText(chosen)}.` : ""}`;
  if (left === 0) return { ...base, state: "configured", detail: `Key accepted but the balance is 0 units; Semrush API needs an SEO Business plan and a unit package.${v4}`, next, data };
  return { ...base, state: s.v4KeySet ? "configured" : "working", detail: `${head}${v4}`, next: null, data };
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
  // The seoprovider row needs every provider's check, even when only it was asked for.
  const wantSeo = want("seoprovider");
  const [dfs, ahrefs, semrush, live, chrome] = await Promise.all([
    want("dataforseo") || wantSeo ? p.dataforseo() : undefined,
    want("ahrefs") || wantSeo ? p.ahrefs() : undefined,
    want("semrush") || wantSeo ? p.semrush() : undefined,
    googleUsable && (want("google") || want("gsc") || want("ga4") || want("tagmanager")) ? p.googleLive() : undefined,
    want("chrome") ? p.chrome() : undefined,
  ]);

  const seo = wantSeo || want("dataforseo") ? p.seoDataProvider() : undefined;
  const otherDefault = seo?.default && seo.default !== "dataforseo" ? " Fallback for live SERPs, on-page and crawls." : "";
  if (dfs && want("dataforseo")) {
    const data = { mode: dfs.mode, apiHost: dfs.apiHost, ...("balanceUsd" in dfs ? { balanceUsd: dfs.balanceUsd } : {}) };
    if (dfs.credentialsWork === true) {
      const balance = "balanceUsd" in dfs && dfs.balanceUsd !== null ? `, balance $${dfs.balanceUsd.toFixed(2)}` : "";
      out.push({
        id: "dataforseo",
        label: "DataForSEO",
        state: "working",
        detail: `Credentials work (${dfs.mode} mode${balance}).${dfs.mode === "sandbox" ? " Sandbox returns sample data at no cost." : " Live mode is billed per call."}${otherDefault}`,
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

  let seoData: SeoDataProviderData | undefined;
  if (wantSeo && seo) {
    const states: Record<ProviderId, IntegrationState> = {
      dataforseo: dfs ? dfsState(dfs) : "missing",
      ahrefs: ahrefs ? keyState(ahrefs.check) : "missing",
      semrush: semrush ? keyState(semrush.check) : "missing",
    };
    const row = seoProviderRow(seo, states, { cli, configuredByEnv: home.configuredByEnv });
    seoData = row.data as unknown as SeoDataProviderData;
    out.push(row);
  }
  if (ahrefs && want("ahrefs")) out.push(ahrefsRow(ahrefs, step("ahrefs")));
  if (semrush && want("semrush")) out.push(semrushRow(semrush, step("semrush")));

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

  if (want("crux")) {
    // Phase 12: always in --json; human output shows it only when a key is set (status-render.ts).
    const c = p.crux ? await p.crux() : { source: null, check: null };
    const label = "CrUX History";
    if (!c.source) {
      out.push({ id: "crux", label, state: "missing", detail: "Optional. Adds real-user Core Web Vitals history (crux_history and the cwv report section).", next: step("crux"), data: { keySource: null } });
    } else if (!c.check || c.check.ok) {
      out.push({
        id: "crux",
        label,
        state: c.check ? "working" : "configured",
        detail: c.check ? `${c.source} works with the Chrome UX Report API.` : `${c.source} is set (not checked here).`,
        next: null,
        data: { keySource: c.source },
      });
    } else {
      out.push({ id: "crux", label, state: "configured", detail: `${c.source} is set but the Chrome UX Report API refused it: ${c.check.problem}`.slice(0, 400), next: step("crux"), data: { keySource: c.source } });
    }
  }

  if (want("bing")) {
    // Phase 12 C3: always in --json; human output shows it only when a key is set (status-render.ts).
    const b = p.bing ? await p.bing() : { keySet: false, check: null };
    const label = "Bing Webmaster Tools";
    if (!b.keySet) {
      out.push({ id: "bing", label, state: "missing", detail: "Optional. Adds Bing search data (bing_report and the bing_overview report section); free, read-only.", next: step("bing"), data: { keySet: false } });
    } else if (!b.check) {
      out.push({ id: "bing", label, state: "configured", detail: "BING_WEBMASTER_API_KEY is set (not checked here).", next: null, data: { keySet: true } });
    } else if (b.check.ok) {
      out.push({
        id: "bing",
        label,
        state: "working",
        detail: `BING_WEBMASTER_API_KEY works: ${b.check.verified} verified site(s)${b.check.sites > b.check.verified ? ` (${b.check.sites - b.check.verified} not verified yet)` : ""}.`,
        next: b.check.verified ? null : LINKS.bingWebmaster,
        data: { keySet: true, sites: b.check.sites, verified: b.check.verified },
      });
    } else if (b.check.kind === "network" || b.check.kind === "throttled") {
      // Not the key's fault: say so, and don't send the user to replace a key that may be fine.
      const why = b.check.kind === "network" ? `Bing Webmaster Tools couldn't be reached to check it (${b.check.problem.replace(/^Couldn't reach Bing Webmaster Tools \(|\)\.$/g, "")})` : "Bing is throttling requests for this key right now";
      out.push({ id: "bing", label, state: "configured", detail: `BING_WEBMASTER_API_KEY is set, but ${why}. Try again in a few minutes.`.slice(0, 400), next: null, data: { keySet: true, checkFailed: b.check.kind } });
    } else if (b.check.kind === "other") {
      out.push({ id: "bing", label, state: "configured", detail: `BING_WEBMASTER_API_KEY is set, but Bing returned an error while checking it: ${b.check.problem}`.slice(0, 400), next: null, data: { keySet: true, checkFailed: "other" } });
    } else {
      out.push({ id: "bing", label, state: "configured", detail: `BING_WEBMASTER_API_KEY is set but Bing refused it: ${b.check.problem}`.slice(0, 400), next: step("bing"), data: { keySet: true } });
    }
  }

  if (want("aivisibility")) {
    // Phase 12 C5: always in --json; human output shows it only when it's on (or the switch has a value that isn't true/false).
    const a = p.aiVisibility?.() ?? { enabled: false, raw: null, dataForSeo: false, capUsd: 2, spentUsd: 0 };
    const label = "AI-search visibility";
    const cost = `Paid: DataForSEO LLM Mentions, at least $0.10 per request, capped at $${a.capUsd} a month (AI_VISIBILITY_MONTHLY_BUDGET_USD). DataForSEO has required a $100 monthly top-up for LLM Mentions access; its 2026-07-07 update says that was removed, so check your account.`;
    const data = { enabled: a.enabled, capUsd: a.capUsd, spentUsd: a.spentUsd };
    const raw = a.raw?.trim().toLowerCase() ?? "";
    if (!a.enabled && raw !== "" && raw !== "false") {
      out.push({ id: "aivisibility", label, state: "error", detail: `AI_VISIBILITY_ENABLED is set but isn't "true", so ai_visibility stays off. Set it to true to turn it on, or false. ${cost}`.slice(0, 500), next: LINKS.aiVisibilityDocs, data });
    } else if (!a.enabled) {
      out.push({ id: "aivisibility", label, state: "missing", detail: `Optional and off. Set AI_VISIBILITY_ENABLED=true to turn on ai_visibility. ${cost}`.slice(0, 500), next: LINKS.aiVisibilityDocs, data });
    } else if (!a.dataForSeo) {
      out.push({ id: "aivisibility", label, state: "error", detail: "AI_VISIBILITY_ENABLED is true but DataForSEO isn't set up, so ai_visibility can't run.", next: step("dataforseo"), data });
    } else {
      out.push({ id: "aivisibility", label, state: "configured", detail: `On: $${a.spentUsd.toFixed(2)} of $${a.capUsd} spent this month. ${cost}`.slice(0, 500), next: null, data });
    }
  }

  if (chrome) {
    out.push(
      chrome.ok
        ? {
            id: "chrome",
            label: "Chrome",
            state: "working",
            // The plain text stays as it was; the binary is in data. Only on macOS with a full Chrome, which shows a Dock icon per launch, the detail says how to avoid that.
            detail: `Headless Chrome launches (${chrome.version}).${chrome.binary && (chrome.binary.kind === "chrome" || chrome.binary.kind === "system-chrome") && process.platform === "darwin" ? " It runs full Chrome, which flashes a Dock icon on macOS; `npx puppeteer browsers install chrome-headless-shell` avoids that." : ""}`,
            next: null,
            data: { version: chrome.version, ...(chrome.binary ? { binary: chrome.binary.kind, binaryLabel: chrome.binary.label, path: chrome.binary.path } : {}) },
          }
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
    ...(seoData ? { seoDataProvider: seoData } : {}),
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
