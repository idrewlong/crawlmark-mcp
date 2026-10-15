/**
 * Escaping per format (D4). Every string from data goes through stripControl
 * first (bidi overrides, zero-width and control characters), then the format's
 * own escaping. Markdown never gets raw HTML or a link from data.
 */
import { stripControl } from "../../lib/terminal-text.js";

export const clean = (s: string) => stripControl(String(s));

/** HTML text and attribute values: & < > " ' . */
export function escapeHtml(s: string): string {
  return clean(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Text inside a Markdown paragraph or table cell. Newlines are folded and \ ` * _ [ ] < > | ~ are escaped
 * everywhere. When the text starts a block (`atLineStart`, the default), leading whitespace is dropped (four
 * spaces would start a code block) and a leading block marker (#, +, -, =, a ~~~ fence, `1.` or `1)`) is
 * escaped so it can't become a heading, list, thematic break, setext underline or code fence.
 */
export function escapeMarkdown(s: string, atLineStart = true): string {
  const text = clean(s)
    .replace(/\r?\n|\r/g, " ")
    .replace(/[\\`*_[\]<>|~]/g, (c) => `\\${c}`);
  // Only text that starts a block (a line, a list item, a quote line) needs the block-marker rules.
  if (!atLineStart) return text;
  return text
    .replace(/^\s+/, "")
    .replace(/^[#+\-=]/, (m) => `\\${m}`)
    .replace(/^(\d{1,9})([.)])(?=\s|$)/, "$1\\$2");
}

/** A Markdown code span: the fence is longer than any backtick run inside, so the content can't close it. `\` then `|` are escaped for tables (backslash first, so `\|` in the data can't become an escaped backslash plus a real cell separator). */
export function markdownCode(s: string): string {
  const text = clean(s).replace(/\r?\n|\r/g, " ");
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") || text.startsWith(" ") ? " " : "";
  return `${fence}${pad}${text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")}${pad}${fence}`;
}

/**
 * Text that a Markdown renderer could turn into a link (GFM autolinks a scheme://, www. and
 * e-mail addresses). Linear time on purpose: these strings come from Search Console and can be long.
 */
export function looksLinky(s: string): boolean {
  return s.includes("://") || /www\./i.test(s) || /@[^\s@]*\.[a-z]/i.test(s);
}

/** Characters that are not allowed in XML 1.0 (DOCX). Tab, LF and CR are allowed. */
const XML_INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Text for a DOCX run: control and invalid XML characters removed (the docx library XML-escapes). */
export function docxText(s: string): string {
  return clean(s).replace(XML_INVALID, "");
}

/** A #rrggbb colour, or the fallback when the value isn't one. */
export const safeColor = (c: string | undefined, fallback: string) => (c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback);
