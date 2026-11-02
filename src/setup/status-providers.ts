import { existsSync } from "node:fs";
import { loadOverrides } from "../clients.js";
import { ENV_FILE, ENV_FILE_KEYS, env, HOME, seoDefaultProvider } from "../config.js";
import { globalUnitCap, unitsThisMonth } from "../lib/budget.js";
import type { ProviderId } from "../lib/provider-ids.js";
import { checkAhrefsKey } from "../providers/ahrefs.js";
import { checkCruxKey, cruxKey } from "../providers/crux.js";
import { bingKey, checkBingKey } from "../providers/bing.js";
import { remainingAiUsd } from "../lib/budget.js";
import { chromeKindLabel } from "../lib/chrome.js";
import { resolveChrome, withBrowser } from "../providers/browser.js";
import { dataForSeoStatus } from "../providers/dataforseo.js";
import { listGa4Properties, listGscSites } from "../providers/discovery.js";
import { checkGoogleAuthLive, googleAuthStatus } from "../providers/google.js";
import { listGtmContainers } from "../providers/gtm.js";
import { brandingConfigured } from "../reports/branding-settings.js";
import { cachedStatus, type StatusProviders } from "./status.js";

export { cliPrefix, commandPrefix, isCheckout, onPath, type CommandPrefixInputs } from "../lib/cli-hint.js";
import { cliPrefix } from "../lib/cli-hint.js";

/** Variables that configure an integration; any of them set outside .env means the setup is environment-driven. */
const CREDENTIAL_KEYS = [
  "DATAFORSEO_LOGIN",
  "DATAFORSEO_PASSWORD",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_OAUTH_CLIENT_ID",
  "PSI_API_KEY",
  "AHREFS_API_KEY",
  "SEMRUSH_API_KEY",
  "SEMRUSH_V4_API_KEY",
];

/** Who uses a provider: the default (when valid) and clients.yaml dataProvider overrides. A broken clients.yaml counts as none. */
function providerChoice(id: ProviderId): { byDefault: boolean; clients: number } {
  let clients = 0;
  try {
    clients = loadOverrides().filter((o) => !o.ignore && o.dataProvider === id).length;
  } catch {
    /* the clients row reports a broken clients.yaml */
  }
  return { byDefault: seoDefaultProvider.ok && seoDefaultProvider.provider === id, clients };
}

export const realStatusProviders: StatusProviders = {
  home: () => ({
    info: HOME,
    exists: existsSync(HOME.dir),
    envFile: ENV_FILE,
    envFileExists: existsSync(ENV_FILE),
    configuredByEnv: CREDENTIAL_KEYS.some((k) => Boolean(process.env[k]) && !ENV_FILE_KEYS.has(k)),
  }),
  cli: () => cliPrefix(),
  dataforseo: () => dataForSeoStatus(),
  seoDataProvider: () => {
    let perClientOverrides = 0;
    try {
      perClientOverrides = loadOverrides().filter((o) => !o.ignore && o.dataProvider).length;
    } catch {
      /* the clients row reports a broken clients.yaml */
    }
    const d = seoDefaultProvider;
    return d.ok
      ? { default: d.provider, source: d.source, perClientOverrides }
      : { default: null, source: ENV_FILE_KEYS.has("SEO_DATA_PROVIDER") ? "envFile" : "env", invalidValue: d.invalidValue, perClientOverrides };
  },
  semrush: async () => ({
    keySet: Boolean(env.SEMRUSH_API_KEY),
    chosen: providerChoice("semrush"),
    unitsUsedThisMonth: unitsThisMonth(undefined, "semrush"),
    cap: globalUnitCap("semrush"),
  }),
  ahrefs: async () => ({
    check: await checkAhrefsKey(env.AHREFS_API_KEY),
    chosen: providerChoice("ahrefs"),
    unitsUsedThisMonth: unitsThisMonth(undefined, "ahrefs"),
    cap: globalUnitCap("ahrefs"),
  }),
  googleStatus: () => googleAuthStatus(),
  googleLive: () => checkGoogleAuthLive(),
  gscSites: async (refresh) => ({ items: (await listGscSites({ refresh })).value.map((s) => s.siteUrl) }),
  ga4Properties: async (refresh) => {
    const { value } = await listGa4Properties({ refresh });
    return { items: value.properties.map((p) => ({ id: p.propertyId, name: p.displayName })), warnings: value.errors };
  },
  gtmContainers: async (refresh) => {
    const { value } = await listGtmContainers({ refresh, ignoreFailureMemory: true });
    return { items: value.containers.map((c) => ({ publicId: c.publicId, name: c.name })), warnings: value.errors };
  },
  psiKeySet: () => Boolean(env.PSI_API_KEY),
  crux: async () => {
    const k = cruxKey();
    return { source: k?.source ?? null, check: k ? await checkCruxKey(k.key, fetch, k.source) : null };
  },
  bing: async () => {
    const key = bingKey();
    return { keySet: Boolean(key), check: key ? await checkBingKey(key) : null };
  },
  aiVisibility: () => {
    const ai = remainingAiUsd();
    return { enabled: env.AI_VISIBILITY_ON, raw: env.AI_VISIBILITY_ENABLED ?? null, dataForSeo: Boolean(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD), capUsd: ai.capUsd, spentUsd: ai.spentUsd };
  },
  branding: () => brandingConfigured(HOME.dir),
  chrome: async () => {
    try {
      const choice = await resolveChrome();
      const version = await withBrowser("setup_status Chrome check", undefined, (b) => b.version());
      return { ok: true, version, binary: { kind: choice.kind, label: chromeKindLabel(choice.kind), path: choice.path } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  clients: () => {
    const overrides = loadOverrides();
    return { count: overrides.filter((o) => !o.ignore).length, ignored: overrides.filter((o) => o.ignore).length, file: env.CLIENTS_FILE, exists: existsSync(env.CLIENTS_FILE) };
  },
};

/** Shared by the setup_status tool and `crawlmark-cli setup status`: cached for 60 seconds. */
export const setupStatus = cachedStatus(realStatusProviders);
