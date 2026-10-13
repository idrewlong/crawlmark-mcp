import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { ClientDefaults } from "./lib/clients.js";
import { stripEmptyValues } from "./lib/env.js";
import { GOOGLE_AUTH_MODES } from "./lib/google-auth.js";
import { projectRoot, resolveFromRoot } from "./lib/paths.js";

/** Directory above src/ or dist/. Relative paths in config resolve from here, not the cwd. */
export const PROJECT_ROOT = projectRoot(import.meta.url);

// Must run before EnvSchema.parse. A missing .env is fine (env may come from the client config).
const envFile = resolve(PROJECT_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const EnvSchema = z.object({
  // Unset: auto-detect (service account if GOOGLE_APPLICATION_CREDENTIALS is set, else OAuth if its client is set, else no Google).
  GOOGLE_AUTH_MODE: z.enum(GOOGLE_AUTH_MODES).optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  DATAFORSEO_LOGIN: z.string().optional(),
  DATAFORSEO_PASSWORD: z.string().optional(),
  DATAFORSEO_BASE_URL: z.string().url().default("https://sandbox.dataforseo.com/v3"),
  PSI_API_KEY: z.string().optional(),
  CLIENTS_FILE: z.string().default("./config/clients.yaml"),
  DATA_DIR: z.string().default("./data"),
  GLOBAL_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(50),
  // Defaults for discovered clients (and clients.yaml entries that leave these out).
  DEFAULT_LOCATION_CODE: z.coerce.number().int().positive().default(2840),
  DEFAULT_LANGUAGE_CODE: z.string().min(1).default("en"),
  DEFAULT_CLIENT_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(5),
});

const parsedEnv = EnvSchema.parse(stripEmptyValues(process.env));

const dataDir = resolveFromRoot(PROJECT_ROOT, parsedEnv.DATA_DIR);

export const env = {
  ...parsedEnv,
  CLIENTS_FILE: resolveFromRoot(PROJECT_ROOT, parsedEnv.CLIENTS_FILE),
  DATA_DIR: dataDir,
  /** OAuth refresh token written by `crawlmark-cli auth login` (mode 0600). */
  GOOGLE_TOKEN_FILE: resolve(dataDir, "google-token.json"),
  GOOGLE_APPLICATION_CREDENTIALS: parsedEnv.GOOGLE_APPLICATION_CREDENTIALS
    ? resolveFromRoot(PROJECT_ROOT, parsedEnv.GOOGLE_APPLICATION_CREDENTIALS)
    : undefined,
};

export type { Client } from "./lib/clients.js";

/** Market and budget for clients that don't set their own. */
export const clientDefaults: ClientDefaults = {
  locationCode: env.DEFAULT_LOCATION_CODE,
  languageCode: env.DEFAULT_LANGUAGE_CODE,
  monthlyBudgetUsd: env.DEFAULT_CLIENT_MONTHLY_BUDGET_USD,
};
