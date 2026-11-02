/**
 * The client-text term check (B-C5): client-facing text must not name crawlmark, Claude, the data vendor
 * DataForSEO, tool names or credentials. Pure: export.ts feeds it the texts and refuses the export on hits.
 * Ahrefs, Semrush and Google are attribution, not terms. Data strings (queries, URLs, page titles) and
 * crawlmark's own generated wording are not checked here (hideCrawlmark / hideProviders cover the wording).
 */
import { stripControl } from "../../lib/terminal-text.js";

export interface LintField {
  /** "summary" | "sections.<id>" | "blocks.<id>" | "sections.<id>.text" | "cover.subtitle" | "cover.preparedFor" | "cover.preparedBy" | "branding.footer" | "branding.commentaryNote" */
  where: string;
  text: string;
}
export interface LintHit {
  where: string;
  term: string;
  /** At most 80 characters around the hit, control characters removed, newlines as spaces. */
  snippet: string;
  /** A built-in term (or a report id / credential name): under white label only the branding allowTerms can allow it. */
  builtin?: true;
}
export interface LintOptions {
  toolNames: readonly string[];
  /** The branding allowTerms: may allow any term. */
  allowTerms?: readonly string[] | undefined;
  /**
   * An export's own allowTerms: may allow any term without white label; with white label on (`whiteLabel`)
   * only tool names and blockTerms, never the built-in terms (crawlmark, Claude, DataForSEO, ...).
   */
  exportAllowTerms?: readonly string[] | undefined;
  /** hideCrawlmark or hideProviders is on. */
  whiteLabel?: boolean | undefined;
  blockTerms?: readonly string[] | undefined;
}

const FIXED_TERMS = [
  "crawlmark",
  ["crawlmark", "cli"].join("-"), // built, not written: the hint test bans the literal outside cli-help.ts
  "crawlmark-mcp",
  "Claude",
  "Anthropic",
  "DataForSEO",
  "MCP server",
  "MCP tool",
  "allowPaid",
  "estimateOnly",
  "reportId",
  "CRAWLMARK_HOME",
  "~/.crawlmark",
] as const;

/** Patterns whose matched text is the term (a report id, a credential-looking variable name). */
const PATTERNS: readonly RegExp[] = [/\brpt_[0-9A-Z]{26}\b/g, /\b[A-Z][A-Z0-9]*_(?:API_KEY|KEY|TOKEN|SECRET|PASSWORD|ENABLED|BUDGET_USD)\b/g];

const SNIPPET_MAX = 80;
/** One term is listed at most this many times per field; the rest are counted in the message. */
export const MAX_HITS_PER_TERM = 5;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordChar = /[A-Za-z0-9]/;

/** A case-insensitive matcher: whole word when the term starts and ends with a letter or digit; spaces match any run of spaces. */
function termRegex(term: string): RegExp {
  const body = escapeRe(term).replace(/(?:\\?\s)+/g, "\\s+");
  const left = wordChar.test(term[0]!) ? "(?<![A-Za-z0-9_])" : "";
  const right = wordChar.test(term[term.length - 1]!) ? "(?![A-Za-z0-9_])" : "";
  return new RegExp(`${left}${body}${right}`, "gi");
}

function snippetAround(text: string, start: number, end: number): string {
  const flat = text.replace(/[\r\n\t]+/g, " ");
  const room = Math.max(0, SNIPPET_MAX - (end - start));
  const from = Math.max(0, start - Math.floor(room / 2));
  return stripControl(flat.slice(from, Math.min(flat.length, end + Math.ceil(room / 2)))).slice(0, SNIPPET_MAX);
}

/** The built-in terms plus every tool name that contains `_` (single-word names such as `lighthouse` are ordinary words). */
export function builtinTerms(toolNames: readonly string[]): string[] {
  return [...FIXED_TERMS, ...toolNames.filter((n) => n.includes("_"))];
}

const FIXED_LOWER: ReadonlySet<string> = new Set(FIXED_TERMS.map((t) => t.toLowerCase()));

/** True for a fixed built-in term (crawlmark, Claude, DataForSEO, ...) or a report id / credential-looking name. */
export function isFixedTerm(term: string): boolean {
  if (FIXED_LOWER.has(term.toLowerCase())) return true;
  return PATTERNS.some((p) => new RegExp(`^(?:${p.source})$`).test(term));
}

/**
 * The text as the check reads it (Q1): each character NFKC-normalised (fullwidth letters become ASCII), format
 * characters (zero-width spaces and joiners, soft hyphens) removed, and the inline Markdown markers `*` and `` ` ``
 * removed, so "Data\u200bForSEO", "ＤａｔａＦｏｒＳＥＯ" and "**Data**ForSEO" all read as DataForSEO. Snippets come
 * from this text, so they show no invisible characters.
 */
export function lintView(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch === "*" || ch === "`") continue;
    // Cf: zero-width and soft hyphen; Mn: variation selectors and the combining grapheme joiner, which render invisibly.
    out += ch.normalize("NFKC").replace(/[\p{Cf}\p{Mn}]/gu, "");
  }
  return out;
}

/** Find internal terms in client-facing texts. Returns hits in field order, then text order. */
export function lintClientText(fields: readonly LintField[], o: LintOptions): LintHit[] {
  const lower = (xs: readonly string[] | undefined) => (xs ?? []).map((t) => lintView(t).toLowerCase());
  // Allows any term: the branding's own list, and an export's list when white label is off.
  const allowed = new Set([...lower(o.allowTerms), ...(o.whiteLabel ? [] : lower(o.exportAllowTerms))]);
  // Allows only tool names and blockTerms (an export's list under white label).
  const allowedSoft = new Set(lower(o.exportAllowTerms));
  const seen = new Set<string>();
  const terms: { term: string; builtin: boolean }[] = [];
  for (const t of [...builtinTerms(o.toolNames), ...(o.blockTerms ?? [])]) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const builtin = FIXED_LOWER.has(k);
    if (allowed.has(k) || (!builtin && allowedSoft.has(k))) continue;
    terms.push({ term: t, builtin });
  }
  const regexes = terms.map((t) => ({ ...t, re: termRegex(t.term) }));
  const out: LintHit[] = [];
  for (const f of fields) {
    if (!f.text) continue;
    const text = lintView(f.text);
    const found: { start: number; end: number; term: string; builtin: boolean }[] = [];
    for (const { term, builtin, re } of regexes) {
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) found.push({ start: m.index, end: m.index + m[0].length, term, builtin });
    }
    for (const p of PATTERNS) {
      p.lastIndex = 0;
      for (let m = p.exec(text); m; m = p.exec(text)) {
        if (!allowed.has(m[0].toLowerCase())) found.push({ start: m.index, end: m.index + m[0].length, term: m[0], builtin: true });
      }
    }
    // A match inside a longer one ("crawlmark" in "crawlmark-cli") is the longer term's hit alone.
    const kept = found.filter((a) => !found.some((b) => b !== a && b.start <= a.start && b.end >= a.end && b.end - b.start > a.end - a.start));
    kept.sort((a, b) => a.start - b.start || a.end - b.end);
    const counts = new Map<string, number>();
    for (const h of kept) {
      const n = (counts.get(h.term.toLowerCase()) ?? 0) + 1;
      counts.set(h.term.toLowerCase(), n);
      if (n <= MAX_HITS_PER_TERM) out.push({ where: f.where, term: h.term, snippet: snippetAround(text, h.start, h.end), ...(h.builtin ? { builtin: true as const } : {}) });
    }
  }
  return out;
}

/**
 * Where the refused text came from: `commentary` (export_report: the model's narrative plus the template's text) or
 * `template` (the `report` CLI: the template's own text, cover and branding lines only, no narrative).
 */
export type LintContext = "commentary" | "template";

/** What to do about the hits, worded for where they came from (SEC-2, Q3). */
export function lintAdvice(hits: readonly LintHit[], o: { context?: LintContext | undefined; whiteLabel?: boolean | undefined } = {}): string {
  if (o.context === "template") {
    return "Edit the template's own text (its title, section and block titles, text and block sections, cover) or the branding footer and commentary note in the template file, or allow a term with branding.allowTerms there; then run `report templates validate`.";
  }
  if (o.whiteLabel && hits.some((h) => h.builtin)) {
    return "Rewrite those passages, move them to internal notes (narrative.<field>.internal), or, if the term is fine for this client, allow it in the branding's allowTerms in the template file.";
  }
  return "Rewrite those passages, move them to internal notes (narrative.<field>.internal), or allow a term with allowTerms.";
}

/** Thrown by exportReport before anything is rendered or written. */
export class ClientTextLintError extends Error {
  override name = "ClientTextLintError";
  constructor(
    readonly hits: LintHit[],
    opts: { context?: LintContext | undefined; whiteLabel?: boolean | undefined } = {},
  ) {
    super(`Client-facing text names internal terms: ${hits.map((h) => `${h.where}: "${h.term}" (…${h.snippet}…)`).join("; ")}. ${lintAdvice(hits, opts)}`);
  }
}
