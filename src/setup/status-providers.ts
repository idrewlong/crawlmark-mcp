import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { loadOverrides } from "../clients.js";
import { ENV_FILE, ENV_FILE_KEYS, env, HOME, PROJECT_ROOT } from "../config.js";
import { shellQuote } from "../lib/claude-config.js";
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

/**
 * How a user runs the CLI on this machine: `crawlmark-cli` when it's on PATH, else
 * `node <root>/dist/cli.js`; prefixed with CRAWLMARK_HOME when that's how the home was chosen.
 */
export function cliInvocation(): string {
  return HOME.source === "env" ? `CRAWLMARK_HOME=${shellQuote(HOME.dir)} ${cliBase()}` : cliBase();
}

/** The CLI command without any CRAWLMARK_HOME prefix. */
export function cliBase(): string {
  return onPath("crawlmark-cli") ? "crawlmark-cli" : `node ${shellQuote(join(PROJECT_ROOT, "dist", "cli.js"))}`;
}

/** Variables that configure an integration; any of them set outside .env means the setup is environment-driven. */
const CREDENTIAL_KEYS = ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_OAUTH_CLIENT_ID", "PSI_API_KEY"];

export const realStatusProviders: StatusProviders = {
  home: () => ({
    info: HOME,
    exists: existsSync(HOME.dir),
    envFile: ENV_FILE,
    envFileExists: existsSync(ENV_FILE),
    configuredByEnv: CREDENTIAL_KEYS.some((k) => Boolean(process.env[k]) && !ENV_FILE_KEYS.has(k)),
  }),
  cli: cliInvocation,
  dataforseo: () => dataForSeoStatus(),
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
