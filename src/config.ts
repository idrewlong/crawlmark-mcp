import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import type { ClientDefaults } from "./lib/clients.js";
import { dataForSeoBaseUrl, dropUnsetKeys, PHASE9_ENV_KEYS, shellUrlOverride, stripEmptyValues, urlOverrideNotice } from "./lib/env.js";
import { GOOGLE_AUTH_MODES } from "./lib/google-auth.js";
import { resolveHome, type HomeInfo } from "./lib/home.js";
import { projectRoot, resolveFromRoot } from "./lib/paths.js";
import { resolveDefaultProvider, type DefaultProvider } from "./lib/provider-ids.js";

/** Directory above src/ or dist/ (the code, prompt templates and dist/ entry points). */
export const PROJECT_ROOT = projectRoot(import.meta.url);

/**
 * The config home: CRAWLMARK_HOME, else the project root for a source checkout,
 * else ~/.crawlmark. `.env` is loaded from here, and relative CLIENTS_FILE,
 * DATA_DIR, REPORTS_DIR, COMPETITOR_DENYLIST_FILE and GOOGLE_APPLICATION_CREDENTIALS resolve against it.
 */
export const HOME: HomeInfo = resolveHome({
  crawlmarkHome: process.env.CRAWLMARK_HOME,
  projectRoot: PROJECT_ROOT,
  userHome: homedir(),
  cwd: process.cwd(),
  exists: existsSync,
});

/** `<home>/.env`. */
export const ENV_FILE = resolve(HOME.dir, ".env");

// Must run before EnvSchema.parse. A missing .env is fine (env may come from the client config).
// loadEnvFile never overrides variables already set (shell or client config win).
// A blank Phase 9 bundle field ("" or a leftover placeholder) must not hide the .env value (D11).
// Phase 12: the same for the Claude Desktop bundle's optional CrUX key field.
dropUnsetKeys(process.env, [...PHASE9_ENV_KEYS, "CRUX_API_KEY"]);
const keysBefore = new Set(Object.keys(process.env));
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
/** Variables that came from ENV_FILE (not the shell). The setup wizard drops them when it starts a child, so the child re-reads the edited file. */
export const ENV_FILE_KEYS: ReadonlySet<string> = new Set(Object.keys(process.env).filter((k) => !keysBefore.has(k)));

const EnvSchema = z.object({
  // Unset: auto-detect (service account if GOOGLE_APPLICATION_CREDENTIALS is set, else OAuth if its client is set, else no Google).
  GOOGLE_AUTH_MODE: z.enum(GOOGLE_AUTH_MODES).optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  DATAFORSEO_LOGIN: z.string().optional(),
  DATAFORSEO_PASSWORD: z.string().optional(),
  // Set explicitly, or DATAFORSEO_LIVE=true for the live API; unset means the free sandbox.
  DATAFORSEO_BASE_URL: z.string().url().optional(),
  // true/false/1/0/yes/no; normalised by dataForSeoBaseUrl (an unrecognised value counts as unset).
  DATAFORSEO_LIVE: z.string().optional(),
  PSI_API_KEY: z.string().optional(),
  // Phase 12: CrUX History (crux_history). Unset: PSI_API_KEY is tried (its project needs the Chrome UX Report API).
  CRUX_API_KEY: z.string().optional(),
  CLIENTS_FILE: z.string().default("./config/clients.yaml"),
  DATA_DIR: z.string().default("./data"),
  // Phase 12: report files (export_report, crawlmark-cli report), relative to the config home.
  REPORTS_DIR: z.string().default("./reports"),
  GLOBAL_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(50),
  // Defaults for discovered clients (and clients.yaml entries that leave these out).
  DEFAULT_LOCATION_CODE: z.coerce.number().int().positive().default(2840),
  DEFAULT_LANGUAGE_CODE: z.string().min(1).default("en"),
  DEFAULT_CLIENT_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(5),
  // Extra suggest_competitors denylist rules: a file (one per line; optional) and/or a comma-separated list.
  COMPETITOR_DENYLIST_FILE: z.string().default("./config/competitor-denylist.txt"),
  COMPETITOR_DENYLIST: z.string().optional(),
  // Scheduled-run alerts (crawlmark-cli check-traffic / audit).
  ALERT_TRAFFIC_DROP_PCT: z.coerce.number().min(0).max(100).default(25),
  ALERT_MIN_CLICKS_LOST: z.coerce.number().int().min(0).default(50),
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  // Phase 12 B: a live SERP rank that worsens by at least this many places alerts (check-ranks --live).
  ALERT_RANK_DROP: z.coerce.number().int().min(1).max(100).default(5),
  // Phase 9: Ahrefs (API v3) and Semrush keys, and monthly unit caps. SEO_DATA_PROVIDER is read
  // leniently below (not here), so an unknown value never stops the server.
  AHREFS_API_KEY: z.string().optional(),
  SEMRUSH_API_KEY: z.string().optional(),
  SEMRUSH_V4_API_KEY: z.string().optional(),
  AHREFS_MONTHLY_UNIT_CAP: z.coerce.number().int().positive().default(50_000),
  SEMRUSH_MONTHLY_UNIT_CAP: z.coerce.number().int().positive().default(20_000),
  DEFAULT_CLIENT_MONTHLY_AHREFS_UNITS: z.coerce.number().int().positive().default(10_000),
  DEFAULT_CLIENT_MONTHLY_SEMRUSH_UNITS: z.coerce.number().int().positive().default(5_000),
});

const parsedEnv = EnvSchema.parse(stripEmptyValues(process.env));

export const AHREFS_DEFAULT_BASE_URL = "https://api.ahrefs.com/v3";
export const SEMRUSH_DEFAULT_BASE_URL = "https://api.semrush.com";
export const SEMRUSH_DEFAULT_BALANCE_URL = "https://www.semrush.com/users/countapiunits.html";
export const CRUX_DEFAULT_BASE_URL = "https://chromeuxreport.googleapis.com/v1";
/** Test-only base URL overrides, honoured only from the shell (never .env). */
const urlOverride = (key: string, fallback: string) => shellUrlOverride(process.env[key], ENV_FILE_KEYS.has(key), fallback);

/**
 * The default SEO data provider (9.3, D11): blank or unset means dataforseo; an unknown
 * value is `{ ok: false }` (reported by setup_status and every routed paid call), never a crash.
 */
export const seoDefaultProvider: DefaultProvider = resolveDefaultProvider({
  raw: process.env.SEO_DATA_PROVIDER,
  source: ENV_FILE_KEYS.has("SEO_DATA_PROVIDER") ? "envFile" : "env",
});

const dataDir = resolveFromRoot(HOME.dir, parsedEnv.DATA_DIR);

export const env = {
  ...parsedEnv,
  DATAFORSEO_BASE_URL: dataForSeoBaseUrl({
    baseUrl: parsedEnv.DATAFORSEO_BASE_URL,
    baseUrlFromFile: ENV_FILE_KEYS.has("DATAFORSEO_BASE_URL"),
    live: parsedEnv.DATAFORSEO_LIVE,
    liveFromFile: ENV_FILE_KEYS.has("DATAFORSEO_LIVE"),
  }),
  CLIENTS_FILE: resolveFromRoot(HOME.dir, parsedEnv.CLIENTS_FILE),
  DATA_DIR: dataDir,
  REPORTS_DIR: resolveFromRoot(HOME.dir, parsedEnv.REPORTS_DIR),
  COMPETITOR_DENYLIST_FILE: resolveFromRoot(HOME.dir, parsedEnv.COMPETITOR_DENYLIST_FILE),
  /** OAuth refresh token written by `crawlmark-cli auth login` (mode 0600). */
  GOOGLE_TOKEN_FILE: resolve(dataDir, "google-token.json"),
  GOOGLE_APPLICATION_CREDENTIALS: parsedEnv.GOOGLE_APPLICATION_CREDENTIALS
    ? resolveFromRoot(HOME.dir, parsedEnv.GOOGLE_APPLICATION_CREDENTIALS)
    : undefined,
  AHREFS_BASE_URL: urlOverride("AHREFS_BASE_URL", AHREFS_DEFAULT_BASE_URL),
  SEMRUSH_BASE_URL: urlOverride("SEMRUSH_BASE_URL", SEMRUSH_DEFAULT_BASE_URL),
  SEMRUSH_BALANCE_URL: urlOverride("SEMRUSH_BALANCE_URL", SEMRUSH_DEFAULT_BALANCE_URL),
  CRUX_BASE_URL: urlOverride("CRUX_BASE_URL", CRUX_DEFAULT_BASE_URL),
};

export type { Client } from "./lib/clients.js";

/** Market and budget for clients that don't set their own. */
export const clientDefaults: ClientDefaults = {
  locationCode: env.DEFAULT_LOCATION_CODE,
  languageCode: env.DEFAULT_LANGUAGE_CODE,
  monthlyBudgetUsd: env.DEFAULT_CLIENT_MONTHLY_BUDGET_USD,
  monthlyUnits: { ahrefs: env.DEFAULT_CLIENT_MONTHLY_AHREFS_UNITS, semrush: env.DEFAULT_CLIENT_MONTHLY_SEMRUSH_UNITS },
};

/** A stderr line when a test-only provider URL override is active (origins only), else undefined. Printed by the server and `setup`. */
export const providerUrlNotice: string | undefined = urlOverrideNotice([
  { name: "AHREFS_BASE_URL", value: env.AHREFS_BASE_URL, fallback: AHREFS_DEFAULT_BASE_URL },
  { name: "SEMRUSH_BASE_URL", value: env.SEMRUSH_BASE_URL, fallback: SEMRUSH_DEFAULT_BASE_URL },
  { name: "SEMRUSH_BALANCE_URL", value: env.SEMRUSH_BALANCE_URL, fallback: SEMRUSH_DEFAULT_BALANCE_URL },
  { name: "CRUX_BASE_URL", value: env.CRUX_BASE_URL, fallback: CRUX_DEFAULT_BASE_URL },
]);
