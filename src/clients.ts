import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { clientDefaults, env } from "./config.js";
import { addEntry, applySync, removeEntry, setIgnore } from "./lib/clients-file.js";
import {
  assembleRegistry,
  findClient,
  joinDiscovered,
  normalizeHost,
  parseOverrides,
  planSync,
  unknownClientMessage,
  type Client,
  type ClientOverride,
  type ClientRegistry,
  type DiscoveryOutcome,
  type DiscoverySkipped,
  type Settled,
} from "./lib/clients.js";
import { GOOGLE_NOT_CONFIGURED_MESSAGE } from "./lib/google-auth.js";
import { listGa4Properties, listGscSites } from "./providers/discovery.js";
import { googleAuthModeNote, googleConfigured } from "./providers/google.js";

/**
 * Clients live in clients.yaml (CLIENTS_FILE). When Google is set up,
 * discovery appends any newly found Search Console / GA4 domains to it and
 * fills missing properties, never changing what a user wrote. Users add their
 * own entries (only `domain` is required), which work for DataForSEO,
 * Lighthouse and axe without Google. The file is re-read on every call, so
 * edits apply without a restart.
 */

// ---------------------------------------------------------------- file I/O

function readText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function parseText(text: string | undefined, path: string): ClientOverride[] {
  if (text === undefined) return [];
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`Could not parse ${path}: ${(err as Error).message}`);
  }
  return parseOverrides(raw, path);
}

/** clients.yaml entries, or [] when the file doesn't exist. Throws on invalid YAML or fields. */
export function loadOverrides(path = env.CLIENTS_FILE): ClientOverride[] {
  return parseText(readText(path), path);
}

/**
 * Write via a temp file next to the real target and rename, so readers never
 * see a half-written file. A symlinked clients.yaml stays a symlink (the
 * target is replaced), and the existing file's permissions are kept.
 */
function writeAtomic(path: string, text: string): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  const mode = existsSync(target) ? statSync(target).mode & 0o7777 : undefined;
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { flag: "wx" });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Serialises clients.yaml edits within this process: each edit re-reads the
 * file, so concurrent edits (a discovery sync and a CLI add) can't lose each
 * other's changes.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function editClientsFile<T>(edit: (text: string | undefined, path: string) => { text?: string; result: T }): Promise<T> {
  const run = writeQueue.then(() => {
    const path = env.CLIENTS_FILE;
    const before = readText(path);
    const { text, result } = edit(before, path);
    if (text !== undefined && text !== before) {
      parseText(text, path); // never write a file we can't read back
      writeAtomic(path, text);
    }
    return result;
  });
  writeQueue = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------- discovery + sync

export interface SyncResult {
  /** Domains appended to clients.yaml by this run. */
  added: string[];
  /** Properties filled on existing entries, e.g. "example.com gscProperty". */
  filled: string[];
  /** Set when the sync couldn't write clients.yaml (discovery results are still used). */
  error?: string;
}

interface DiscoveryRun {
  outcome: DiscoveryOutcome | DiscoverySkipped;
  fromCache: boolean;
  sync: SyncResult;
}

async function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

const NO_SYNC: SyncResult = { added: [], filled: [] };

async function runDiscovery(refresh: boolean): Promise<DiscoveryRun> {
  if (!googleConfigured()) {
    return {
      outcome: { skipped: `${GOOGLE_NOT_CONFIGURED_MESSAGE} Clients come from clients.yaml only.` },
      fromCache: false,
      sync: NO_SYNC,
    };
  }
  const [gsc, ga4] = await Promise.all([settle(listGscSites({ refresh })), settle(listGa4Properties({ refresh }))]);
  const outcome: DiscoveryOutcome = {
    gsc: gsc.ok ? { ok: true, value: gsc.value.value } : gsc,
    ga4: ga4.ok ? { ok: true, value: ga4.value.value } : ga4,
  };
  const fetched = [gsc, ga4].flatMap((r) => (r.ok ? [r.value.fromCache] : []));
  const fromCache = fetched.length > 0 && fetched.every(Boolean);

  let sync = NO_SYNC;
  if (gsc.ok || ga4.ok) {
    const joined = joinDiscovered(
      outcome.gsc.ok ? outcome.gsc.value : [],
      outcome.ga4.ok ? outcome.ga4.value.properties : [],
    ).clients;
    try {
      sync = await editClientsFile((text, path) => {
        const plan = planSync(parseText(text, path), joined);
        return {
          text: applySync(text, plan),
          result: { added: plan.add.map((e) => e.domain), filled: plan.fill.map((f) => `${f.domain} ${f.field}`) },
        };
      });
    } catch (err) {
      sync = { added: [], filled: [], error: (err as Error).message };
    }
  }

  const problems = [
    ...(gsc.ok ? [] : [`Search Console: ${(gsc.error as Error).message}`]),
    ...(ga4.ok ? ga4.value.value.errors : [`GA4: ${(ga4.error as Error).message}`]),
    ...(sync.error ? [`could not update ${env.CLIENTS_FILE}: ${sync.error}`] : []),
  ];
  for (const p of problems) console.error(`crawlmark: client discovery: ${p}`);
  return { outcome, fromCache, sync };
}

/**
 * In-flight discovery runs (including their clients.yaml sync), one per
 * refresh mode, so calls that arrive together share one run and one write.
 * Cleared when the run settles.
 */
const inflight = new Map<boolean, Promise<DiscoveryRun>>();

function discover(refresh: boolean): Promise<DiscoveryRun> {
  let run = inflight.get(refresh);
  if (!run) {
    run = runDiscovery(refresh).finally(() => inflight.delete(refresh));
    inflight.set(refresh, run);
  }
  return run;
}

export interface LoadedRegistry extends ClientRegistry {
  /** True when every discovery list that succeeded came from the cache (false if none succeeded). */
  fromCache: boolean;
  clientsFile: { path: string; exists: boolean } & SyncResult;
}

export async function loadRegistry(opts: { refresh?: boolean } = {}): Promise<LoadedRegistry> {
  const run = await discover(opts.refresh ?? false);
  // Read after the sync so the registry includes what it just wrote.
  const overrides = loadOverrides();
  const registry = assembleRegistry(run.outcome, overrides, clientDefaults);
  if (run.sync.error) registry.discovery.warnings.push(`Could not update ${env.CLIENTS_FILE}: ${run.sync.error}`);
  const modeNote = googleAuthModeNote();
  if (modeNote) registry.discovery.info = [registry.discovery.info, modeNote].filter(Boolean).join(" ");
  return {
    ...registry,
    fromCache: run.fromCache,
    clientsFile: { path: env.CLIENTS_FILE, exists: existsSync(env.CLIENTS_FILE), ...run.sync },
  };
}

/**
 * Resolve a tool's `client` argument: a domain (`example.com`), any URL or
 * `www.` form of it, `sc-domain:example.com`, or a clients.yaml key.
 */
export async function resolveClient(idOrDomain: string): Promise<Client> {
  const registry = await loadRegistry();
  const client = findClient(registry.clients, idOrDomain);
  if (!client) {
    const host = normalizeHost(idOrDomain);
    const key = idOrDomain.trim().toLowerCase();
    const ignored = loadOverrides().find((o) => o.ignore && (o.slug.toLowerCase() === key || o.domain === host));
    if (ignored) {
      throw new Error(`${ignored.domain} is marked ignore: true in clients.yaml. Remove that line to use it as a client.`);
    }
    const hint = registry.discovery.skipped
      ? ` Add it with \`crawlmark-cli clients add ${host ?? idOrDomain}\`.`
      : " If the property was added in the last day, call list_clients with refresh: true.";
    throw new Error(unknownClientMessage(idOrDomain, registry.clients, registry.discovery.error) + hint);
  }
  return client;
}

// ---------------------------------------------------------------- manual edits (CLI)

export type AddResult = { status: "added" | "unignored" | "exists"; domain: string; key: string };

/** Add a manual client keyed by its domain. Re-adding an ignored domain clears `ignore`. */
export function addClient(domainInput: string, name?: string): Promise<AddResult> {
  const domain = normalizeHost(domainInput);
  if (!domain || !domain.includes(".")) return Promise.reject(new Error(`"${domainInput}" is not a domain.`));
  return editClientsFile<AddResult>((text, path) => {
    const existing = parseText(text, path).find((o) => o.domain === domain);
    if (existing?.ignore) return { text: setIgnore(text!, existing.slug, false), result: { status: "unignored", domain, key: existing.slug } };
    if (existing) return { result: { status: "exists", domain, key: existing.slug } };
    return {
      text: addEntry(text, { domain, ...(name ? { name } : {}) }),
      result: { status: "added", domain, key: domain },
    };
  });
}

export type RemoveResult = { status: "removed" | "ignored" | "not-found"; domain: string };

/**
 * Remove a client's entry. With `ignore`, keep (or create) the entry with
 * `ignore: true` instead, so discovery never re-adds it.
 */
export function removeClient(idOrDomain: string, opts: { ignore?: boolean } = {}): Promise<RemoveResult> {
  return editClientsFile<RemoveResult>((text, path) => {
    const overrides = parseText(text, path);
    const key = idOrDomain.trim().toLowerCase();
    const host = normalizeHost(idOrDomain);
    const entry = overrides.find((o) => o.slug.toLowerCase() === key) ?? overrides.find((o) => o.domain === host);
    const domain = entry?.domain ?? host ?? idOrDomain;
    if (opts.ignore) {
      if (entry) return { text: setIgnore(text!, entry.slug, true), result: { status: "ignored", domain } };
      if (!host || !host.includes(".")) throw new Error(`"${idOrDomain}" is not a domain.`);
      return { text: addEntry(text, { domain: host, ignore: true }), result: { status: "ignored", domain } };
    }
    if (!entry) return { result: { status: "not-found", domain } };
    return { text: removeEntry(text!, entry.slug), result: { status: "removed", domain } };
  });
}
