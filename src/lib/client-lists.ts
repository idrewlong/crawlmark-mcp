/**
 * Pure planning for a client's competitor and tracked-keyword lists (no I/O):
 * what to add, what to remove and why anything was skipped. src/clients.ts
 * applies the plans to clients.yaml through src/lib/clients-file.ts.
 */
import {
  normalizeCompetitorDomain,
  normalizeKeyword,
  toCompetitorEntries,
  toKeywordEntries,
  type CompetitorEntry,
  type CompetitorItem,
  type EntrySource,
  type KeywordEntry,
  type KeywordItem,
} from "./clients.js";

export type SkipReason = "invalid" | "own-domain" | "already-listed" | "duplicate-input" | "not-listed";

export interface Skipped {
  /** What the caller passed. */
  input: string;
  /** The normalised value, when there is one. */
  value?: string;
  reason: SkipReason;
  detail: string;
}

export interface AddMeta {
  note?: string | undefined;
  source?: EntrySource | undefined;
  /** ISO date stamped on each new entry. */
  addedAt: string;
}

export interface AddPlan<E> {
  /** New entries, in input order, as they will be written. */
  add: E[];
  /** The input each new entry came from, same order as `add`. */
  inputs: string[];
  skipped: Skipped[];
}

export interface RemovePlan {
  /** Positions in the list as written in clients.yaml. */
  indexes: number[];
  removed: string[];
  skipped: Skipped[];
}

/** Metadata written on each new entry, in the order it appears in clients.yaml. */
function meta(m: AddMeta): { note?: string; source: EntrySource; addedAt: string } {
  const note = m.note?.trim();
  return { ...(note ? { note } : {}), source: m.source ?? "manual", addedAt: m.addedAt };
}

/** True when `domain` is the client's domain or one of its subdomains. */
export function isOwnDomain(domain: string, ownDomain: string): boolean {
  return domain === ownDomain || domain.endsWith(`.${ownDomain}`);
}

/**
 * Plan adding competitor domains. Inputs may be URLs or `www.` forms; each is
 * normalised to a bare host. Skips anything that isn't a domain, the client's
 * own domain (and its subdomains), domains already listed, and repeats.
 */
export function planAddCompetitors(
  existing: CompetitorItem[] | undefined,
  inputs: string[],
  ownDomain: string,
  m: AddMeta,
): AddPlan<CompetitorEntry> {
  const listed = new Set(toCompetitorEntries(existing).map((c) => c.domain));
  const plan: AddPlan<CompetitorEntry> = { add: [], inputs: [], skipped: [] };
  const seen = new Set<string>();
  for (const input of inputs) {
    const domain = normalizeCompetitorDomain(input);
    if (!domain) {
      plan.skipped.push({ input, reason: "invalid", detail: `"${input}" is not a domain.` });
    } else if (isOwnDomain(domain, ownDomain)) {
      plan.skipped.push({ input, value: domain, reason: "own-domain", detail: `${domain} is the client's own site (${ownDomain}).` });
    } else if (listed.has(domain)) {
      plan.skipped.push({ input, value: domain, reason: "already-listed", detail: `${domain} is already a competitor.` });
    } else if (seen.has(domain)) {
      plan.skipped.push({ input, value: domain, reason: "duplicate-input", detail: `${domain} appears more than once in this request.` });
    } else {
      seen.add(domain);
      plan.add.push({ domain, ...meta(m) });
      plan.inputs.push(input);
    }
  }
  return plan;
}

/** Plan adding tracked keywords: normalised, skipping empty or overlong ones, ones already tracked, and repeats. */
export function planAddKeywords(existing: KeywordItem[] | undefined, inputs: string[], m: AddMeta): AddPlan<KeywordEntry> {
  const listed = new Set(toKeywordEntries(existing).map((k) => k.keyword));
  const plan: AddPlan<KeywordEntry> = { add: [], inputs: [], skipped: [] };
  const seen = new Set<string>();
  for (const input of inputs) {
    const keyword = normalizeKeyword(input);
    if (!keyword) {
      plan.skipped.push({ input, reason: "invalid", detail: "Empty, or longer than the keyword limit." });
    } else if (listed.has(keyword)) {
      plan.skipped.push({ input, value: keyword, reason: "already-listed", detail: `"${keyword}" is already tracked.` });
    } else if (seen.has(keyword)) {
      plan.skipped.push({ input, value: keyword, reason: "duplicate-input", detail: `"${keyword}" appears more than once in this request.` });
    } else {
      seen.add(keyword);
      plan.add.push({ keyword, ...meta(m) });
      plan.inputs.push(input);
    }
  }
  return plan;
}

function planRemove<T>(
  items: T[] | undefined,
  inputs: string[],
  valueOf: (item: T) => string | undefined,
  normalize: (input: string) => string | undefined,
  label: string,
): RemovePlan {
  const plan: RemovePlan = { indexes: [], removed: [], skipped: [] };
  const done = new Set<string>();
  for (const input of inputs) {
    const value = normalize(input);
    if (!value) {
      plan.skipped.push({ input, reason: "invalid", detail: `"${input}" is not a valid ${label}.` });
      continue;
    }
    if (done.has(value)) continue;
    // Every written item that normalises to this value, so hand-written duplicates go too.
    const hits = (items ?? []).flatMap((item, i) => (valueOf(item) === value ? [i] : []));
    if (hits.length === 0) {
      plan.skipped.push({ input, value, reason: "not-listed", detail: `${value} isn't in the list.` });
      continue;
    }
    done.add(value);
    plan.indexes.push(...hits);
    plan.removed.push(value);
  }
  plan.indexes.sort((a, b) => a - b);
  return plan;
}

export function planRemoveCompetitors(existing: CompetitorItem[] | undefined, inputs: string[]): RemovePlan {
  return planRemove(existing, inputs, (c) => normalizeCompetitorDomain(typeof c === "string" ? c : c.domain), normalizeCompetitorDomain, "domain");
}

export function planRemoveKeywords(existing: KeywordItem[] | undefined, inputs: string[]): RemovePlan {
  return planRemove(existing, inputs, (k) => normalizeKeyword(typeof k === "string" ? k : k.keyword), normalizeKeyword, "keyword");
}

/** Today's local date as YYYY-MM-DD (the date the person adding an entry sees). */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
