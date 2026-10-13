/**
 * llms.txt format check against the llmstxt.org proposal (sources in docs/research/2026-10-13-llms-txt.md):
 * an H1 title first (the only required part), an optional blockquote summary, optional prose, then H2
 * sections of Markdown link lists (`- [name](url): notes`); an H2 named "Optional" holds links that can be
 * skipped. llms.txt is a proposal Google says it doesn't use, so this is informational only. Real files vary
 * (dash notes, bold links, titles, numbered lists), so any top-level list item that starts with a link counts
 * as a link; only the structure (the H1, and H2 sections with links) can be an issue.
 *
 * The file is untrusted text: nothing from it is kept except a stripped, shortened title and section names,
 * counts, and the http(s) link URLs (resolved, for the link sample). Line by line and linear. Pure.
 */
import { stripControl } from "../lib/terminal-text.js";

/** Lines longer than this are not parsed (a list item that long counts as a non-link item). */
const MAX_LINE = 4096;
const MAX_SECTIONS_KEPT = 50;
const MAX_LINKS_KEPT = 1000;

export interface LlmsTxtFormat {
  /** The H1 text, control characters removed, at most 200 characters; null without an H1. */
  title: string | null;
  hasSummary: boolean;
  /** H2 sections in order (names stripped, at most 100 characters; first 50 kept) with their link counts. */
  sections: { name: string; links: number }[];
  sectionCount: number;
  hasOptionalSection: boolean;
  /** Top-level list items under H2 sections that start with a Markdown link. */
  linkCount: number;
  /** Top-level list items under H2 sections that don't start with a link (data, not an issue). */
  nonLinkItems: number;
  /** What follows the links: `: notes` (the proposal's form), a dash, nothing, or anything else. */
  notesStyle: { colon: number; dash: number; none: number; other: number };
  /** Absolute http(s) URLs of those links, in file order, de-duplicated (first 1,000). */
  links: string[];
  /** Problems with the structure, crawlmark's own fixed text. Empty means the file follows the proposal. */
  issues: string[];
}

/** A list item marker (`-`, `*`, `+`, `1.` or `1)`) and the content after it. */
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])[ \t]+/;
const MAX_LINK_TEXT = 1000;
const MAX_DEST = 2048;

const isSpace = (c: string | undefined) => c === " " || c === "\t";

/**
 * A Markdown link at the start of `s` (`[text](url)`, `[text](<url>)`, `[text](url "title")`, one level of
 * balanced parentheses in the URL): its destination and what follows it, or null. A scanner, not a regex.
 */
export function leadingLink(s: string): { url: string; rest: string } | null {
  if (s[0] !== "[") return null;
  const close = s.indexOf("](", 1);
  if (close === -1 || close > MAX_LINK_TEXT) return null;
  let i = close + 2;
  while (isSpace(s[i])) i++;
  let url: string;
  if (s[i] === "<") {
    const end = s.indexOf(">", i + 1);
    if (end === -1 || end - i > MAX_DEST) return null;
    url = s.slice(i + 1, end);
    i = end + 1;
  } else {
    const start = i;
    let depth = 0;
    for (; i < s.length && i - start <= MAX_DEST; i++) {
      const c = s[i]!;
      if (isSpace(c)) break;
      if (c === "(") {
        if (++depth > 1) return null;
      } else if (c === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    if (depth !== 0) return null;
    url = s.slice(start, i);
  }
  if (!url) return null;
  while (isSpace(s[i])) i++;
  const q = s[i];
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, i + 1);
    if (end === -1) return null;
    i = end + 1;
    while (isSpace(s[i])) i++;
  }
  if (s[i] !== ")") return null;
  return { url, rest: s.slice(i + 1) };
}

/**
 * A heading's text without its closing `#` sequence. Only a run of `#` preceded by a space (or making up the
 * whole text) closes the heading, so `C#` stays `C#`. A loop, not a backtracking regex.
 */
export function trimClosingHashes(s: string): string {
  let end = s.length;
  while (end > 0 && isSpace(s[end - 1])) end--;
  let start = end;
  while (start > 0 && s[start - 1] === "#") start--;
  if (start === end) return s.slice(0, end);
  if (start === 0) return "";
  if (!isSpace(s[start - 1])) return s.slice(0, end);
  while (start > 0 && isSpace(s[start - 1])) start--;
  return s.slice(0, start);
}

function notesKind(rest: string): keyof LlmsTxtFormat["notesStyle"] {
  const r = rest.replace(/^\*\*|^__/, "").trimStart();
  if (r === "") return "none";
  if (r[0] === ":") return "colon";
  if (r[0] === "-" || r[0] === "\u2013" || r[0] === "\u2014") return "dash";
  return "other";
}

export function parseLlmsTxt(text: string, baseUrl: string): LlmsTxtFormat {
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  const issues = new Set<string>();
  let title: string | null = null;
  let h1Count = 0;
  let seenContent = false;
  let hasSummary = false;
  let inFence = false;
  let current: { name: string; links: number } | null = null;
  const sections: { name: string; links: number }[] = [];
  let sectionCount = 0;
  let hasOptionalSection = false;
  let linkCount = 0;
  let nonLinkItems = 0;
  const notesStyle = { colon: 0, dash: 0, none: 0, other: 0 };
  let headingInPreamble = false;
  const links: string[] = [];
  const seenLinks = new Set<string>();

  for (const raw of lines) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      seenContent = true;
      continue;
    }
    if (inFence || line === "") continue;
    // Indented list items are sub-bullets (notes under a link), not entries of the file list.
    const indented = /^( {2,}|\t)/.test(raw);
    if (raw.length > MAX_LINE) {
      if (current && !indented && LIST_ITEM.test(line)) nonLinkItems++;
      seenContent = true;
      continue;
    }
    const heading = /^(#{1,6})[ \t]+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const name = stripControl(trimClosingHashes(heading[2] ?? "")).trim();
      if (level === 1) {
        h1Count++;
        if (h1Count === 1) {
          if (seenContent) issues.add("The file does not start with the H1 title.");
          title = name.slice(0, 200) || null;
        }
      } else if (level === 2) {
        sectionCount++;
        current = { name: name.slice(0, 100), links: 0 };
        if (sections.length < MAX_SECTIONS_KEPT) sections.push(current);
        if (name.toLowerCase() === "optional") hasOptionalSection = true;
      } else if (!current) {
        headingInPreamble = true;
      }
      seenContent = true;
      continue;
    }
    if (line.startsWith(">") && h1Count === 1 && !current) hasSummary = true;
    const marker = current && !indented ? LIST_ITEM.exec(line) : null;
    if (current && marker) {
      let content = line.slice(marker[0].length);
      if (content.startsWith("**") || content.startsWith("__")) content = content.slice(2);
      const link = leadingLink(content);
      if (!link) {
        nonLinkItems++;
      } else {
        linkCount++;
        current.links++;
        notesStyle[notesKind(link.rest)]++;
        try {
          const u = new URL(link.url, baseUrl);
          if ((u.protocol === "http:" || u.protocol === "https:") && links.length < MAX_LINKS_KEPT) {
            u.hash = "";
            const s = u.toString();
            if (!seenLinks.has(s)) {
              seenLinks.add(s);
              links.push(s);
            }
          }
        } catch {
          /* not a URL: counted as a link, never fetched */
        }
      }
    }
    seenContent = true;
  }

  if (h1Count === 0) issues.add("There is no H1 title (the only required part).");
  if (h1Count > 1) issues.add(`There are ${h1Count} H1 headings; the proposal has one title.`);
  if (headingInPreamble) issues.add("A heading other than H1 or H2 comes before the first H2 section.");
  if (sectionCount > 0 && linkCount === 0) issues.add("The H2 sections contain no links.");
  return { title, hasSummary, sections, sectionCount, hasOptionalSection, linkCount, nonLinkItems, notesStyle, links, issues: [...issues] };
}
