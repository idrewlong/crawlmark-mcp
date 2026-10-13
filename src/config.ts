import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import type { ClientDefaults } from "./lib/clients.js";
import { dataForSeoBaseUrl, stripEmptyValues } from "./lib/env.js";
import { GOOGLE_AUTH_MODES } from "./lib/google-auth.js";
import { resolveHome, type HomeInfo } from "./lib/home.js";
import { projectRoot, resolveFromRoot } from "./lib/paths.js";

/** Directory above src/ or dist/ (the code, prompt templates and dist/ entry points). */
export const PROJECT_ROOT = projectRoot(import.meta.url);

/**
 * The config home: CRAWLMARK_HOME, else the project root for a source checkout,
 * else ~/.crawlmark. `.env` is loaded from here, and relative CLIENTS_FILE,
 * DATA_DIR, COMPETITOR_DENYLIST_FILE and GOOGLE_APPLICATION_CREDENTIALS resolve against it.
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
  CLIENTS_FILE: z.string().default("./config/clients.yaml"),
  DATA_DIR: z.string().default("./data"),
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
});

const parsedEnv = EnvSchema.parse(stripEmptyValues(process.env));

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
  COMPETITOR_DENYLIST_FILE: resolveFromRoot(HOME.dir, parsedEnv.COMPETITOR_DENYLIST_FILE),
  /** OAuth refresh token written by `crawlmark-cli auth login` (mode 0600). */
  GOOGLE_TOKEN_FILE: resolve(dataDir, "google-token.json"),
  GOOGLE_APPLICATION_CREDENTIALS: parsedEnv.GOOGLE_APPLICATION_CREDENTIALS
    ? resolveFromRoot(HOME.dir, parsedEnv.GOOGLE_APPLICATION_CREDENTIALS)
    : undefined,
};

export type { Client } from "./lib/clients.js";

/** Market and budget for clients that don't set their own. */
export const clientDefaults: ClientDefaults = {
  locationCode: env.DEFAULT_LOCATION_CODE,
  languageCode: env.DEFAULT_LANGUAGE_CODE,
  monthlyBudgetUsd: env.DEFAULT_CLIENT_MONTHLY_BUDGET_USD,
};
