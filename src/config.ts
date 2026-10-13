import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { stripEmptyValues } from "./lib/env.js";
import { projectRoot, resolveFromRoot } from "./lib/paths.js";

/** Directory above src/ or dist/. Relative paths in config resolve from here, not the cwd. */
export const PROJECT_ROOT = projectRoot(import.meta.url);

// Must run before EnvSchema.parse. A missing .env is fine (env may come from the client config).
const envFile = resolve(PROJECT_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const EnvSchema = z.object({
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  DATAFORSEO_LOGIN: z.string().optional(),
  DATAFORSEO_PASSWORD: z.string().optional(),
  DATAFORSEO_BASE_URL: z.string().url().default("https://sandbox.dataforseo.com/v3"),
  PSI_API_KEY: z.string().optional(),
  CLIENTS_FILE: z.string().default("./config/clients.yaml"),
  DATA_DIR: z.string().default("./data"),
  GLOBAL_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(50),
});

const parsedEnv = EnvSchema.parse(stripEmptyValues(process.env));

export const env = {
  ...parsedEnv,
  CLIENTS_FILE: resolveFromRoot(PROJECT_ROOT, parsedEnv.CLIENTS_FILE),
  DATA_DIR: resolveFromRoot(PROJECT_ROOT, parsedEnv.DATA_DIR),
  GOOGLE_APPLICATION_CREDENTIALS: parsedEnv.GOOGLE_APPLICATION_CREDENTIALS
    ? resolveFromRoot(PROJECT_ROOT, parsedEnv.GOOGLE_APPLICATION_CREDENTIALS)
    : undefined,
};

const ClientSchema = z.object({
  name: z.string(),
  domain: z.string(),
  gscProperty: z.string().optional(),
  ga4PropertyId: z.string().optional(),
  locationCode: z.number().int().default(2840),
  languageCode: z.string().default("en"),
  competitors: z.array(z.string()).default([]),
  trackedKeywords: z.array(z.string()).default([]),
  keyPages: z.array(z.string().url()).default([]),
  monthlyBudgetUsd: z.number().positive().default(5),
});

export type Client = z.infer<typeof ClientSchema> & { slug: string };

const ClientsFileSchema = z.object({
  clients: z.record(z.string(), ClientSchema),
});

let cache: Map<string, Client> | undefined;

export function loadClients(): Map<string, Client> {
  if (cache) return cache;
  const path = resolve(env.CLIENTS_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `Clients file not found at ${path}. Copy config/clients.example.yaml to config/clients.yaml.`,
    );
  }
  const parsed = ClientsFileSchema.parse(parseYaml(readFileSync(path, "utf8")));
  cache = new Map(
    Object.entries(parsed.clients).map(([slug, c]) => [slug, { ...c, slug }]),
  );
  return cache;
}

export function getClient(slug: string): Client {
  const client = loadClients().get(slug);
  if (!client) {
    const known = [...loadClients().keys()].join(", ") || "(none)";
    throw new Error(`Unknown client "${slug}". Known clients: ${known}`);
  }
  // Default the audit to the homepage when no key pages are configured.
  if (client.keyPages.length === 0) client.keyPages = [`https://${client.domain}/`];
  return client;
}
