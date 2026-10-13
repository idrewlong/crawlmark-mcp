import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { clientDefaults, env } from "./config.js";
import { autoAddable } from "./analysis/brand-terms.js";
import { inferClientBrandTerms } from "./brand-inference.js";
import {
  planAddBrandTerms,
  planAddCompetitors,
  planAddKeywords,
  planRemoveBrandTerms,
  planRemoveCompetitors,
  planRemoveKeywords,
  today,
  type Skipped,
} from "./lib/client-lists.js";
import {
  addEntry,
  appendListItems,
  applySync,
  removeEntry,
  removeListItems,
  setEntryFields,
  setStringList,
  setIgnore,
} from "./lib/clients-file.js";
import {
  assembleRegistry,
  findClient,
  gtmFromOutcome,
  joinDiscovered,
  normalizeArea,
  normalizeHost,
  parseOverrides,
  planSync,
  toBrandTermEntries,
  toCompetitorEntries,
  toKeywordEntries,
  unknownClientMessage,
  type BrandTermEntry,
  type BrandTermSource,
  type Client,
  type ClientOverride,
  type ClientRegistry,
  type CompetitorEntry,
  type DiscoveryOutcome,
  type EntrySource,
  type KeywordEntry,
  type DiscoverySkipped,
  type Settled,
} from "./lib/clients.js";
import { MAX_BRAND_TERM_LENGTH, normalizeBrandTerm, squash, toBrandTerms } from "./lib/brand.js";
import { mapLimit } from "./lib/concurrency.js";
import { isProviderId, PROVIDER_IDS, type ProviderId } from "./lib/provider-ids.js";
import { GOOGLE_NOT_CONFIGURED_MESSAGE } from "./lib/google-auth.js";
import { listGa4Properties, listGscSites } from "./providers/discovery.js";
import { listGtmContainers } from "./providers/gtm.js";
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
  /** Properties filled on existing entries, e.g. "example.com gscProperty" or "example.com gtmContainerId". */
  filled: string[];
  /** Set when the sync couldn't write clients.yaml (discovery results are still used). */
  error?: string;
}

interface DiscoveryRun {
  outcome: DiscoveryOutcome | DiscoverySkipped;
  fromCache: boolean;
  sync: SyncResult;
  /** What automatic brand-term inference did for clients this run added. */
  brandNotes: string[];
}

async function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

let lastGtmLogged: string | undefined;

const NO_SYNC: SyncResult = { added: [], filled: [] };

async function runDiscovery(refresh: boolean): Promise<DiscoveryRun> {
  if (!googleConfigured()) {
    return {
      outcome: { skipped: `${GOOGLE_NOT_CONFIGURED_MESSAGE} Clients come from clients.yaml only.` },
      fromCache: false,
      sync: NO_SYNC,
      brandNotes: [],
    };
  }
  // Tag Manager is best-effort: its failure becomes a discovery note and never touches client discovery.
  const [gsc, ga4, gtm] = await Promise.all([
    settle(listGscSites({ refresh })),
    settle(listGa4Properties({ refresh })),
    settle(listGtmContainers({ refresh })),
  ]);
  const outcome: DiscoveryOutcome = {
    gsc: gsc.ok ? { ok: true, value: gsc.value.value } : gsc,
    ga4: ga4.ok ? { ok: true, value: ga4.value.value } : ga4,
    gtm: gtm.ok ? { ok: true, value: gtm.value.value } : gtm,
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
        const plan = planSync(parseText(text, path), joined, gtmFromOutcome(outcome.gtm).matches);
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
  // Logged once per distinct message: a failing Tag Manager would otherwise repeat on every tool call.
  if (!gtm.ok && (gtm.error as Error).message !== lastGtmLogged) {
    lastGtmLogged = (gtm.error as Error).message;
    console.error(`crawlmark: client discovery: Tag Manager: ${lastGtmLogged}`);
  }
  for (const p of problems) console.error(`crawlmark: client discovery: ${p}`);
  const brandNotes = sync.added.length ? await autoBrandTermsForNewClients(outcome, sync.added) : [];
  return { outcome, fromCache, sync, brandNotes };
}

// ---------------------------------------------------------------- automatic brand terms for new clients

/** How long a discovery run waits for brand-term inference before returning; the rest finishes in the background. */
const AUTO_BRAND_WAIT_MS = 20_000;
/** Notes from inference that finished after its discovery run returned; shown by the next list_clients. */
const lateBrandNotes: string[] = [];

/**
 * For clients discovery just added that have a Search Console property: infer
 * brand terms from their own Search Console queries (free; never DataForSEO)
 * and save the high-confidence ones with source auto-gsc. Best-effort: a
 * failure becomes a note and never affects the sync. Waits up to
 * AUTO_BRAND_WAIT_MS, then lets the rest finish in the background.
 */
async function autoBrandTermsForNewClients(outcome: DiscoveryOutcome, added: string[]): Promise<string[]> {
  let clients: Client[];
  try {
    clients = assembleRegistry(outcome, loadOverrides(), clientDefaults).clients;
  } catch (err) {
    return [`Automatic brand terms skipped: ${(err as Error).message}`];
  }
  const fresh = clients.filter((c) => added.includes(c.domain) && c.gscProperty);
  if (fresh.length === 0) return [];
  const notes: string[] = [];
  let finished = false;
  const work = mapLimit(fresh, 2, async (client) => {
    let note: string;
    try {
      const r = await inferClientBrandTerms(client, clients, { allowPaid: false });
      // Strict: only high candidates that match the distinctive part of the client's name.
      const high = autoAddable(r.candidates, "high");
      if (high.length === 0) {
        note = `${client.domain}: no brand terms qualified for automatic adding (${r.candidates.length} suggestion(s) to review; run suggest_brand_terms).`;
      } else {
        const res = await addBrandTermsTo(client, high.map((c) => c.term), { source: "auto-gsc" });
        note = res.added.length
          ? `${client.domain}: added brand terms ${res.added.map((a) => `"${a.term}"`).join(", ")} (auto-gsc, high confidence). Undo with remove_brand_terms.`
          : `${client.domain}: high-confidence brand terms were already listed.`;
      }
    } catch (err) {
      note = `${client.domain}: automatic brand terms failed: ${(err as Error).message}`;
    }
    if (finished) lateBrandNotes.push(note);
    else notes.push(note);
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, AUTO_BRAND_WAIT_MS);
    timer.unref();
  });
  await Promise.race([work.then(() => undefined), timeout]);
  clearTimeout(timer);
  if (notes.length < fresh.length) {
    finished = true;
    notes.push("Automatic brand terms are still running for some new clients; list_clients will show the result.");
  }
  work.catch(() => undefined);
  return notes;
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
  registry.discovery.notes.push(...run.brandNotes, ...lateBrandNotes.splice(0));
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

// ---------------------------------------------------------------- competitors, keywords, profile

/**
 * The clients.yaml entry for a resolved client. A client discovery found but
 * couldn't write (e.g. the sync failed) gets a `domain:`-only entry first.
 */
function entryFor(text: string | undefined, path: string, client: Client): { text: string; entry: ClientOverride } {
  const entry = parseText(text, path).find((o) => o.domain === client.domain);
  if (entry?.ignore) throw new Error(`${client.domain} is marked ignore: true in clients.yaml.`);
  if (entry) return { text: text ?? "", entry };
  return { text: addEntry(text, { domain: client.domain }), entry: { slug: client.domain, domain: client.domain } };
}

export interface ListAddResult<E> {
  client: string;
  added: (E & { input: string })[];
  skipped: Skipped[];
  /** The full list after the change. */
  list: E[];
  clientsFile: string;
}

export interface ListRemoveResult<E> {
  client: string;
  removed: string[];
  skipped: Skipped[];
  list: E[];
  clientsFile: string;
}

export interface AddOptions {
  note?: string | undefined;
  source?: EntrySource | undefined;
}

/**
 * Add competitor domains to a client in clients.yaml. URLs and `www.` forms
 * become bare domains; the client's own domain, existing competitors, repeats
 * and non-domains are skipped with a reason.
 */
export async function addCompetitors(idOrDomain: string, domains: string[], opts: AddOptions = {}): Promise<ListAddResult<CompetitorEntry>> {
  const client = await resolveClient(idOrDomain);
  return editClientsFile((text, path) => {
    const { text: base, entry } = entryFor(text, path, client);
    const plan = planAddCompetitors(entry.competitors, domains, client.domain, { ...opts, addedAt: today() });
    const result: ListAddResult<CompetitorEntry> = {
      client: client.domain,
      added: plan.add.map((e, i) => ({ ...e, input: plan.inputs[i]! })),
      skipped: plan.skipped,
      list: [...toCompetitorEntries(entry.competitors), ...plan.add],
      clientsFile: path,
    };
    return plan.add.length ? { text: appendListItems(base, entry.slug, "competitors", plan.add), result } : { result };
  });
}

/** Remove competitor domains (any URL or `www.` form) from a client. */
export async function removeCompetitors(idOrDomain: string, domains: string[]): Promise<ListRemoveResult<CompetitorEntry>> {
  const client = await resolveClient(idOrDomain);
  return editClientsFile((text, path) => {
    const entry = parseText(text, path).find((o) => o.domain === client.domain);
    const plan = planRemoveCompetitors(entry?.competitors, domains);
    const kept = (entry?.competitors ?? []).filter((_, i) => !plan.indexes.includes(i));
    const result = { client: client.domain, removed: plan.removed, skipped: plan.skipped, list: toCompetitorEntries(kept), clientsFile: path };
    return entry && plan.indexes.length ? { text: removeListItems(text!, entry.slug, "competitors", plan.indexes), result } : { result };
  });
}

/** Add tracked keywords to a client (normalised to lowercase with single spaces). */
export async function addKeywords(idOrDomain: string, keywords: string[], opts: AddOptions = {}): Promise<ListAddResult<KeywordEntry>> {
  const client = await resolveClient(idOrDomain);
  return editClientsFile((text, path) => {
    const { text: base, entry } = entryFor(text, path, client);
    const plan = planAddKeywords(entry.trackedKeywords, keywords, { ...opts, addedAt: today() });
    const result: ListAddResult<KeywordEntry> = {
      client: client.domain,
      added: plan.add.map((e, i) => ({ ...e, input: plan.inputs[i]! })),
      skipped: plan.skipped,
      list: [...toKeywordEntries(entry.trackedKeywords), ...plan.add],
      clientsFile: path,
    };
    return plan.add.length ? { text: appendListItems(base, entry.slug, "trackedKeywords", plan.add), result } : { result };
  });
}

/** Remove tracked keywords from a client (matched case- and spacing-insensitively). */
export async function removeKeywords(idOrDomain: string, keywords: string[]): Promise<ListRemoveResult<KeywordEntry>> {
  const client = await resolveClient(idOrDomain);
  return editClientsFile((text, path) => {
    const entry = parseText(text, path).find((o) => o.domain === client.domain);
    const plan = planRemoveKeywords(entry?.trackedKeywords, keywords);
    const kept = (entry?.trackedKeywords ?? []).filter((_, i) => !plan.indexes.includes(i));
    const result = { client: client.domain, removed: plan.removed, skipped: plan.skipped, list: toKeywordEntries(kept), clientsFile: path };
    return entry && plan.indexes.length ? { text: removeListItems(text!, entry.slug, "trackedKeywords", plan.indexes), result } : { result };
  });
}

export interface BrandAddOptions {
  source?: BrandTermSource | undefined;
}

/** Add brand terms to an already-resolved client. Only ever writes that client's own entry. */
function addBrandTermsTo(client: Client, terms: string[], opts: BrandAddOptions = {}): Promise<ListAddResult<BrandTermEntry>> {
  return editClientsFile((text, path) => {
    const { text: base, entry } = entryFor(text, path, client);
    const plan = planAddBrandTerms(entry.brandTerms, terms, { source: opts.source, addedAt: today() });
    const result: ListAddResult<BrandTermEntry> = {
      client: client.domain,
      added: plan.add.map((e, i) => ({ ...e, input: plan.inputs[i]! })),
      skipped: plan.skipped,
      list: [...toBrandTermEntries(entry.brandTerms), ...plan.add],
      clientsFile: path,
    };
    return plan.add.length ? { text: appendListItems(base, entry.slug, "brandTerms", plan.add), result } : { result };
  });
}

/**
 * Add brand terms to a client (saved as `{ term, source, addedAt }`). Skips
 * terms already listed (ignoring case, spacing and punctuation), repeats and
 * unusable ones, with a reason.
 */
export async function addBrandTerms(idOrDomain: string, terms: string[], opts: BrandAddOptions = {}): Promise<ListAddResult<BrandTermEntry>> {
  return addBrandTermsTo(await resolveClient(idOrDomain), terms, opts);
}

/** Remove brand terms from a client (matched ignoring case, spacing and punctuation). */
export async function removeBrandTerms(idOrDomain: string, terms: string[]): Promise<ListRemoveResult<BrandTermEntry>> {
  const client = await resolveClient(idOrDomain);
  return editClientsFile((text, path) => {
    const entry = parseText(text, path).find((o) => o.domain === client.domain);
    const plan = planRemoveBrandTerms(entry?.brandTerms, terms);
    const kept = (entry?.brandTerms ?? []).filter((_, i) => !plan.indexes.includes(i));
    const result = { client: client.domain, removed: plan.removed, skipped: plan.skipped, list: toBrandTermEntries(kept), clientsFile: path };
    return entry && plan.indexes.length ? { text: removeListItems(text!, entry.slug, "brandTerms", plan.indexes), result } : { result };
  });
}

export interface ProfileUpdate {
  /** DataForSEO location_name, e.g. "Austin,Texas,United States". Empty string clears it. */
  area?: string | undefined;
  /** A few words on what the client does. Empty string clears it. */
  niche?: string | undefined;
  /** Display name. Empty string clears it (back to the GA4 name or the domain). */
  name?: string | undefined;
  /** Brand terms replacing the stored list; an empty array clears it. */
  brandTerms?: string[] | undefined;
  /** Phase 9: dataforseo, ahrefs or semrush; empty string clears the override (back to SEO_DATA_PROVIDER). */
  dataProvider?: string | undefined;
  /** Phase 9: ISO 3166-1 alpha-2 (stored uppercase); empty string clears it. */
  country?: string | undefined;
}

export interface ProfileResult {
  client: string;
  set: Record<string, string>;
  cleared: string[];
  /** dataProvider and country are included when the update set or cleared either of them. */
  profile: { name: string; area: string | null; niche: string | null; brandTerms: string[]; dataProvider?: ProviderId | null; country?: string | null };
  clientsFile: string;
}

/** Set or clear a client's area, niche and name in clients.yaml. */
export async function setClientProfile(idOrDomain: string, update: ProfileUpdate): Promise<ProfileResult> {
  const fields: Record<string, string | undefined> = {};
  for (const key of ["area", "niche", "name"] as const) {
    const raw = update[key];
    if (raw === undefined) continue;
    const trimmed = raw.replace(/\s+/g, " ").trim();
    if (trimmed === "") {
      fields[key] = "";
    } else if (key === "area") {
      const area = normalizeArea(trimmed);
      if (!area) throw new Error(`"${raw}" is not a location name. Use DataForSEO's form, e.g. "Austin,Texas,United States".`);
      fields[key] = area;
    } else {
      fields[key] = trimmed;
    }
  }
  if (update.dataProvider !== undefined) {
    const v = update.dataProvider.trim().toLowerCase();
    if (v !== "" && !isProviderId(v)) throw new Error(`"${update.dataProvider}" is not a data provider. Use ${PROVIDER_IDS.join(", ")}, or an empty value to use the default (SEO_DATA_PROVIDER).`);
    fields.dataProvider = v;
  }
  if (update.country !== undefined) {
    const v = update.country.trim();
    if (v !== "" && !/^[A-Za-z]{2}$/.test(v)) throw new Error(`"${update.country}" is not a two-letter ISO country code (e.g. US or GB).`);
    fields.country = v.toUpperCase();
  }
  let brandTerms: string[] | undefined;
  if (update.brandTerms !== undefined) {
    brandTerms = toBrandTerms(update.brandTerms);
    const bad = update.brandTerms.filter((t) => t.trim() !== "" && !normalizeBrandTerm(t));
    if (bad.length) throw new Error(`Not a usable brand term: ${bad.map((t) => `"${t}"`).join(", ")}. Terms need a letter or digit and at most ${MAX_BRAND_TERM_LENGTH} characters.`);
  }
  if (Object.keys(fields).length === 0 && brandTerms === undefined) throw new Error("Nothing to set: pass area, niche, name, brandTerms, dataProvider or country.");
  const client = await resolveClient(idOrDomain);
  await editClientsFile((text, path) => {
    const { text: base, entry } = entryFor(text, path, client);
    let next = setEntryFields(base, entry.slug, fields);
    // Terms already listed (in either form, ignoring case and spacing) keep their written form and metadata.
    if (brandTerms !== undefined) next = setStringList(next, entry.slug, "brandTerms", brandTerms, { objectKey: "term", same: (a, b) => squash(a) === squash(b) });
    return { text: next, result: undefined };
  });
  const updated = await resolveClient(client.domain);
  return {
    client: client.domain,
    set: {
      ...(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== "")) as Record<string, string>),
      ...(brandTerms?.length ? { brandTerms: brandTerms.join(", ") } : {}),
    },
    cleared: [...Object.entries(fields).filter(([, v]) => v === "").map(([k]) => k), ...(brandTerms?.length === 0 ? ["brandTerms"] : [])],
    profile: {
      name: updated.name,
      area: updated.area ?? null,
      niche: updated.niche ?? null,
      brandTerms: updated.brandTerms,
      ...(update.dataProvider !== undefined || update.country !== undefined ? { dataProvider: updated.dataProvider ?? null, country: updated.country } : {}),
    },
    clientsFile: env.CLIENTS_FILE,
  };
}
