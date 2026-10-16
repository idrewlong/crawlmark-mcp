import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic-file.js";

/**
 * A comment-preserving `.env` editor. `setEnvValues` (pure) updates existing
 * keys in place, appends new ones, and never adds a second line for a key;
 * comments, blank lines, order and unrelated keys are kept byte for byte.
 * `writeEnvFile` writes the result atomically with mode 0600.
 */

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `KEY=value` or `export KEY=value`, not a comment. */
const LINE_RE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)([^]*)$/;

/** Unquote a value the way a dotenv parser would (enough for reading back our own writes and typical files). */
function unquote(raw: string): string {
  const v = raw.trim();
  const q = v[0];
  if ((q === '"' || q === "'" || q === "`") && v.length >= 2) {
    const end = v.indexOf(q, 1);
    if (end > 0) {
      const inner = v.slice(1, end);
      return q === '"' ? inner.replace(/\\n/g, "\n") : inner;
    }
  }
  // Unquoted: an inline comment starts at " #".
  const hash = v.search(/\s#/);
  return (hash >= 0 ? v.slice(0, hash) : v).trim();
}

/** Parse KEY=value lines. Later duplicates win, as in Node's parser. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(line);
    if (m) out[m[2]!] = unquote(m[4]!);
  }
  return out;
}

/** Format a value so Node's `.env` parser reads it back unchanged. Newlines are refused. */
export function formatEnvValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("Env values can't contain line breaks.");
  if (value === "" || /^[A-Za-z0-9_./:@+,=-]+$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes("\\n")) return `"${value}"`;
  if (!value.includes("`")) return `\`${value}\``;
  throw new Error("Env value contains every quote character; set it by hand.");
}

/**
 * Apply updates to `.env` text. An existing key is rewritten in place on every
 * line it appears on (keeping `export` and spacing), so it never ends up with two
 * different values; a new key is appended. Returns the new text and what changed.
 */
export function setEnvValues(text: string, updates: Record<string, string>, remove: readonly string[] = []): { text: string; updated: string[]; added: string[]; removed: string[] } {
  for (const k of Object.keys(updates)) if (!KEY_RE.test(k)) throw new Error(`Invalid env key: ${k}`);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);
  // A trailing newline gives a last empty element; keep it aside so appends go before it.
  const trailing = lines.length > 0 && lines[lines.length - 1] === "";
  if (trailing) lines.pop();

  // Keys to delete (every line they appear on), e.g. a name an older version wrote.
  const removed = new Set<string>();
  for (let i = lines.length - 1; i >= 0 && remove.length; i--) {
    const m = LINE_RE.exec(lines[i]!);
    if (m && remove.includes(m[2]!)) {
      removed.add(m[2]!);
      lines.splice(i, 1);
    }
  }

  const seen = new Set<string>();
  const updated = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const m = LINE_RE.exec(lines[i]!);
    if (!m) continue;
    const key = m[2]!;
    if (!(key in updates)) continue;
    seen.add(key);
    const next = `${m[1]}${key}${m[3]}${formatEnvValue(updates[key]!)}`;
    if (next !== lines[i]) {
      lines[i] = next;
      updated.add(key);
    }
  }
  const added: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (seen.has(key)) continue;
    lines.push(`${key}=${formatEnvValue(value)}`);
    added.push(key);
  }
  return { text: lines.length ? lines.join(eol) + eol : "", updated: [...updated], added, removed: [...removed] };
}

export function readEnvFile(path: string): Record<string, string> {
  return existsSync(path) ? parseEnvText(readFileSync(path, "utf8")) : {};
}

/**
 * Update keys in a `.env` file: atomic (temp file, then rename), mode 0600,
 * parent directory created with 0700, symlinks followed. Returns which keys were updated or added.
 */
export function writeEnvFile(file: string, updates: Record<string, string>, remove: readonly string[] = []): { updated: string[]; added: string[]; removed: string[] } {
  // Follow a symlinked .env so the link survives the rename.
  const path = existsSync(file) ? realpathSync(file) : file;
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const r = setEnvValues(before, updates, remove);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, r.text, 0o600);
  return { updated: r.updated, added: r.added, removed: r.removed };
}
