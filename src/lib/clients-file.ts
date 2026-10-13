/**
 * Pure edits to clients.yaml text (no I/O). Uses the `yaml` Document API so
 * comments, ordering and formatting a user wrote survive every edit. Callers
 * validate the result with parseOverrides before writing it.
 */
import { isMap, isScalar, isSeq, parseDocument, YAMLMap, YAMLSeq, type Document } from "yaml";
import type { NewEntry, SyncPlan } from "./clients.js";

/** Header for a clients.yaml that crawlmark creates. */
export const NEW_FILE_HEADER = [
  " crawlmark clients. Domains found in Search Console and GA4 are added here",
  " automatically; you can edit them and add your own. Each entry needs only `domain`.",
  " crawlmark never changes or removes what you write here: it only appends new",
  " domains and fills a missing gscProperty or ga4PropertyId.",
  " Hide a domain for good with `ignore: true`. See config/clients.example.yaml for every field.",
].join("\n");

function load(text: string | undefined): Document {
  const doc = parseDocument(text ?? "");
  if (doc.errors.length) throw new Error(`clients.yaml is not valid YAML: ${doc.errors[0]!.message}`);
  if (text === undefined || text.trim() === "") doc.commentBefore = NEW_FILE_HEADER;
  return doc;
}

/**
 * The `clients:` map, created if the file is empty or `clients:` has no
 * entries. A flow-style map (`clients: {}`) is switched to block style so
 * appended entries get one block each.
 */
function clientsMap(doc: Document): YAMLMap {
  const node = doc.get("clients", true);
  if (isMap(node)) {
    node.flow = false;
    return node;
  }
  const map = new YAMLMap();
  doc.set("clients", map);
  return map;
}

/** lineWidth 0: never fold long strings (names, URLs) across lines. */
const serialize = (doc: Document) => doc.toString({ lineWidth: 0 });

function entryNode(doc: Document, entry: NewEntry & { ignore?: boolean }) {
  // Field order matches clients.example.yaml.
  const value: Record<string, unknown> = { domain: entry.domain };
  if (entry.name !== undefined) value.name = entry.name;
  if (entry.gscProperty !== undefined) value.gscProperty = entry.gscProperty;
  if (entry.ga4PropertyId !== undefined) value.ga4PropertyId = entry.ga4PropertyId;
  if (entry.ignore) value.ignore = true;
  // Number-like strings (GA4 IDs) are quoted by the serializer, so they stay strings.
  return doc.createNode(value);
}

/** Apply a discovery sync plan. Returns the text unchanged when the plan is empty. */
export function applySync(text: string | undefined, plan: SyncPlan): string {
  if (plan.add.length === 0 && plan.fill.length === 0) return text ?? "";
  const doc = load(text);
  const map = clientsMap(doc);
  for (const f of plan.fill) {
    const entry = map.get(f.key, true);
    if (!isMap(entry)) throw new Error(`clients.yaml entry ${f.key} is not a mapping.`);
    // Fill only: a value already there (even one we wrote earlier) is never replaced.
    // An empty string counts as missing, matching planSync, so it gets filled once instead of being re-planned forever.
    const current = entry.get(f.field);
    if (current === undefined || current === null || current === "") entry.set(f.field, f.value);
  }
  for (const e of plan.add) {
    if (map.has(e.domain)) throw new Error(`clients.yaml already has a key ${e.domain} for another domain.`);
    map.set(e.domain, entryNode(doc, e));
  }
  return serialize(doc);
}

/** Append one entry keyed by its domain. */
export function addEntry(text: string | undefined, entry: NewEntry & { ignore?: boolean }): string {
  const doc = load(text);
  const map = clientsMap(doc);
  if (map.has(entry.domain)) throw new Error(`clients.yaml already has a key ${entry.domain}.`);
  map.set(entry.domain, entryNode(doc, entry));
  return serialize(doc);
}

/** Delete the entry under `key`. */
export function removeEntry(text: string, key: string): string {
  const doc = load(text);
  const map = clientsMap(doc);
  if (!map.delete(key)) throw new Error(`clients.yaml has no entry ${key}.`);
  if (map.items.length === 0) map.flow = true; // render as `clients: {}`, not a dangling `{}` line
  return serialize(doc);
}

/** Set (true) or remove (false) `ignore` on the entry under `key`. */
export function setIgnore(text: string, key: string, ignore: boolean): string {
  const doc = load(text);
  const entry = clientsMap(doc).get(key, true);
  if (!isMap(entry)) throw new Error(`clients.yaml has no entry ${key}.`);
  if (ignore) entry.set("ignore", true);
  else entry.delete("ignore");
  return serialize(doc);
}

/** List fields crawlmark edits on a client entry. */
export type ListField = "competitors" | "trackedKeywords";

function entryMap(doc: Document, key: string): YAMLMap {
  const entry = clientsMap(doc).get(key, true);
  if (!isMap(entry)) throw new Error(`clients.yaml has no entry ${key}.`);
  return entry;
}

/**
 * Append items to a list field on the entry under `key`, creating the field if
 * needed. A flow-style list (`[a, b]`) is switched to block style so each item
 * gets its own line; existing items, comments and values are kept.
 */
export function appendListItems(text: string, key: string, field: ListField, items: unknown[]): string {
  if (items.length === 0) return text;
  const doc = load(text);
  const entry = entryMap(doc, key);
  let seq: unknown = entry.get(field, true);
  // Missing, or written as `competitors:` with no value.
  if (seq === undefined || seq === null || (isScalar(seq) && seq.value === null)) {
    seq = new YAMLSeq();
    entry.set(field, seq);
  }
  if (!isSeq(seq)) throw new Error(`clients.yaml entry ${key}: ${field} is not a list.`);
  seq.flow = false;
  for (const item of items) seq.items.push(doc.createNode(item));
  return serialize(doc);
}

/**
 * Remove items by index from a list field on the entry under `key`. Indexes
 * are positions in the list as written. A list left empty is removed.
 */
export function removeListItems(text: string, key: string, field: ListField, indexes: number[]): string {
  if (indexes.length === 0) return text;
  const doc = load(text);
  const entry = entryMap(doc, key);
  const seq = entry.get(field, true);
  if (!isSeq(seq)) throw new Error(`clients.yaml entry ${key}: ${field} is not a list.`);
  for (const i of [...new Set(indexes)].sort((a, b) => b - a)) {
    if (i < 0 || i >= seq.items.length) throw new Error(`clients.yaml entry ${key}: ${field} has no item ${i}.`);
    seq.items.splice(i, 1);
  }
  if (seq.items.length === 0) entry.delete(field);
  return serialize(doc);
}

/**
 * Set string fields on the entry under `key`. `undefined` leaves a field
 * alone; an empty string removes it.
 */
export function setEntryFields(text: string, key: string, fields: Record<string, string | undefined>): string {
  const doc = load(text);
  const entry = entryMap(doc, key);
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value === "") entry.delete(field);
    else entry.set(field, value);
  }
  return serialize(doc);
}

/**
 * Replace a list of plain strings on the entry under `key`. An empty list
 * removes the field. Comments on the entry's other fields are kept.
 */
export function setStringList(text: string, key: string, field: string, items: string[]): string {
  const doc = load(text);
  const entry = entryMap(doc, key);
  if (items.length === 0) entry.delete(field);
  else {
    // Edit an existing list in place so the key-line comment and the list's own comments stay put;
    // items that survive (matched by text) keep their own comments, new ones are appended as plain items.
    const old = entry.get(field, true);
    if (isSeq(old)) {
      const next = items.map((item) => old.items.find((o) => isScalar(o) && o.value === item) ?? doc.createNode(item));
      old.items = next;
      old.flow = false;
    } else {
      entry.set(field, doc.createNode(items));
    }
  }
  return serialize(doc);
}
