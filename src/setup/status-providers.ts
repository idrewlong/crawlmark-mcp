import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadOverrides } from "../clients.js";
import { ENV_FILE, ENV_FILE_KEYS, env, HOME, PROJECT_ROOT, seoDefaultProvider } from "../config.js";
import { globalUnitCap, unitsThisMonth } from "../lib/budget.js";
import type { ProviderId } from "../lib/provider-ids.js";
import { checkAhrefsKey } from "../providers/ahrefs.js";
import { checkSemrushKey } from "../providers/semrush.js";
import { checkCruxKey, cruxKey } from "../providers/crux.js";
import { bingKey, checkBingKey } from "../providers/bing.js";
import { remainingAiUsd } from "../lib/budget.js";
import { shellQuote } from "../lib/claude-config.js";
import { sourceCheckoutMarker, USER_HOME_DIRNAME, type HomeSource } from "../lib/home.js";
import { withBrowser } from "../providers/browser.js";
import { dataForSeoStatus } from "../providers/dataforseo.js";
import { listGa4Properties, listGscSites } from "../providers/discovery.js";
import { checkGoogleAuthLive, googleAuthStatus } from "../providers/google.js";
import { listGtmContainers } from "../providers/gtm.js";
import { cachedStatus, type StatusProviders } from "./status.js";

/** True when `name` is an executable on PATH (no shell, no exec). */
export function onPath(name: string, pathEnv = process.env.PATH ?? "", platform = process.platform): boolean {
  const exts = platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        accessSync(join(dir, name + ext), constants.X_OK);
        return true;
      } catch {
        /* keep looking */
      }
    }
  }
  return false;
}

export interface CommandPrefixInputs {
  /** Running from a source checkout (npm run cli works in its root). */
  checkout: boolean;
  /** `crawlmark-cli` is on PATH (a global install). */
  cliOnPath: boolean;
  homeSource: HomeSource;
  homeDir: string;
  /** The home this install uses without CRAWLMARK_HOME: the project root for a checkout, ~/.crawlmark otherwise. */
  defaultHomeDir: string;
  /** The user's home directory, shown as `~` in the printed CRAWLMARK_HOME. */
  userHome?: string | undefined;
}

/** CRAWLMARK_HOME's value for a printed command: `~/rest` when it's under the user's home and needs no quoting. */
function displayHome(dir: string, userHome: string | undefined): string {
  if (userHome) {
    const rel = relative(userHome, dir);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel) && /^[A-Za-z0-9_./-]+$/.test(rel.split(sep).join("/"))) return `~/${rel.split(sep).join("/")}`;
  }
  return shellQuote(dir);
}

/**
 * The short command for printed next steps (pure): `npm run cli --` in a source
 * checkout, `crawlmark-cli` for a global install, else `npx crawlmark-mcp`.
 * `CRAWLMARK_HOME=<dir>` goes in front only when the home came from the env and
 * isn't this install's default.
 */
export function commandPrefix(i: CommandPrefixInputs): string {
  const base = i.checkout ? "npm run cli --" : i.cliOnPath ? "crawlmark-cli" : "npx crawlmark-mcp";
  if (i.homeSource !== "env" || resolve(i.homeDir) === resolve(i.defaultHomeDir)) return base;
  return `CRAWLMARK_HOME=${displayHome(i.homeDir, i.userHome)} ${base}`;
}

/** True when this process runs from a source checkout (not an installed package). */
export function isCheckout(): boolean {
  return sourceCheckoutMarker(PROJECT_ROOT, existsSync) !== undefined;
}

/** commandPrefix for this process. `withHome: false` leaves out any CRAWLMARK_HOME prefix. */
export function cliPrefix(opts: { withHome?: boolean } = {}): string {
  const checkout = isCheckout();
  const userHome = homedir();
  return commandPrefix({
    checkout,
    cliOnPath: onPath("crawlmark-cli"),
    homeSource: opts.withHome === false ? "user" : HOME.source,
    homeDir: HOME.dir,
    defaultHomeDir: checkout ? PROJECT_ROOT : join(userHome, USER_HOME_DIRNAME),
    userHome,
  });
}

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
    check: await checkSemrushKey(env.SEMRUSH_API_KEY),
    chosen: providerChoice("semrush"),
    v4KeySet: Boolean(env.SEMRUSH_V4_API_KEY),
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
  chrome: async () => {
    try {
      return { ok: true, version: await withBrowser("setup_status Chrome check", undefined, (b) => b.version()) };
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
