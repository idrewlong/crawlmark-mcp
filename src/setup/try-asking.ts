/**
 * "Try asking Claude" prompts for the fancy summary box (pure).
 *
 * Privacy: the caller reads clients only from the local clients.yaml, and only
 * in fancy mode (an interactive terminal). The prompts are printed to that
 * terminal and nowhere else: never written to a file, log, cache or the network.
 * Without clients (or in tests) they use example.com.
 */
import { stripControl } from "../lib/terminal-text.js";

export interface ExampleClient {
  domain: string;
  name?: string | undefined;
  /** Has a Search Console property (those come first: their reports have the most data). */
  gsc?: boolean | undefined;
  ignore?: boolean | undefined;
}

export interface TryAsking {
  prompts: string[];
  /** Shown when the prompts use example.com. */
  hint?: string | undefined;
}

const MAX_CLIENTS = 3;
const MAX_TEXT = 40;

/** Untrusted text made fit for one line: control and bidi characters gone, whitespace collapsed, length capped. */
function clean(text: string | undefined): string {
  const t = stripControl(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
}

const TEMPLATES: ((c: { label: string; domain: string }) => string)[] = [
  (c) => `Give me the monthly report for ${c.label}`,
  (c) => `What are the quick wins for ${c.domain}?`,
  (c) => `Run an audit on ${c.domain} and tell me what changed since last time`,
];

/**
 * Three prompts. With clients: up to three of them (Search Console first, ignored ones
 * skipped), cycled over the prompts; the report prompt reads "<name> (<domain>)" when the
 * client has a name that isn't just its domain. Without clients: example.com and a hint.
 */
export function tryAskingExamples(clients: readonly ExampleClient[] | undefined, cliDisplay: string): TryAsking {
  const picked = (clients ?? [])
    .filter((c) => !c.ignore)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => Number(Boolean(b.c.gsc)) - Number(Boolean(a.c.gsc)) || a.i - b.i)
    .map(({ c }) => ({ domain: clean(c.domain), name: clean(c.name) }))
    .filter((c) => c.domain !== "")
    .slice(0, MAX_CLIENTS);
  if (picked.length === 0) {
    const ex = { label: "example.com", domain: "example.com" };
    return { prompts: TEMPLATES.map((t) => t(ex)), hint: `Add your own: ${cliDisplay} clients add <domain>` };
  }
  return {
    prompts: TEMPLATES.map((t, i) => {
      const c = picked[i % picked.length]!;
      const label = c.name && c.name.toLowerCase() !== c.domain.toLowerCase() ? `${c.name} (${c.domain})` : c.domain;
      return t({ label, domain: c.domain });
    }),
  };
}
