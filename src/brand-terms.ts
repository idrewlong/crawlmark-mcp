/**
 * suggest_brand_terms: infer a client's brand terms from its own Search
 * Console queries (free), falling back to DataForSEO ranked keywords for its
 * own domain (paid, cached 7 days) when it has no property or too few rows.
 * With `apply`, saves candidates at or above `minConfidence` to that client's
 * entry only, with source auto-gsc or auto-dataforseo.
 */
import { autoAddable } from "./analysis/brand-terms.js";
import { inferClientBrandTerms, MIN_GSC_ROWS, type BrandInference } from "./brand-inference.js";
import { addBrandTerms, loadRegistry, resolveClient } from "./clients.js";
import type { BrandTermEntry } from "./lib/clients.js";
import type { Skipped } from "./lib/client-lists.js";

export interface SuggestBrandOptions {
  /** Save candidates at or above minConfidence. */
  apply?: boolean | undefined;
  minConfidence?: "high" | "medium" | undefined;
  /** Paid DataForSEO fallback: unset = only when Search Console isn't usable; true = also for sparse Search Console data; false = never. */
  allowPaid?: boolean | undefined;
}

export interface SuggestBrandResult extends BrandInference {
  currentBrandTerms: string[];
  applied: { minConfidence: "high" | "medium"; added: BrandTermEntry[]; skipped: Skipped[] } | null;
  next: string;
}

export async function suggestBrandTerms(idOrDomain: string, opts: SuggestBrandOptions = {}): Promise<SuggestBrandResult> {
  const client = await resolveClient(idOrDomain);
  const registry = await loadRegistry();
  const others = registry.clients.filter((c) => c.domain !== client.domain);
  const inference = await inferClientBrandTerms(client, others, { allowPaid: opts.allowPaid });
  const minConfidence = opts.minConfidence ?? "high";

  let applied: SuggestBrandResult["applied"] = null;
  if (opts.apply) {
    applied = { minConfidence, added: [], skipped: [] };
    for (const source of ["gsc", "dataforseo"] as const) {
      // Strict auto-add: only candidates matching the distinctive part of the client's name.
      const terms = autoAddable(inference.candidates, minConfidence).filter((c) => c.source === source).map((c) => c.term);
      if (terms.length === 0) continue;
      const r = await addBrandTerms(client.domain, terms, { source: source === "gsc" ? "auto-gsc" : "auto-dataforseo" });
      applied.added.push(...r.added.map(({ input: _i, ...e }) => e));
      applied.skipped.push(...r.skipped);
    }
  }
  const current = opts.apply ? (await resolveClient(client.domain)).brandTerms : client.brandTerms;

  return {
    ...inference,
    currentBrandTerms: current,
    applied,
    next:
      (applied ? `Saved ${applied.added.length} term(s) at ${minConfidence} confidence or above that match the distinctive part of the name. ` : "Nothing was saved. ") +
      "Candidates with a reviewReason are never saved automatically. Review them (and the medium and low candidates (and the remaining non-branded queries) with the user; for the ones they confirm, call " +
      'add_brand_terms with source: "suggested". Undo any term with remove_brand_terms.',
  };
}

export interface SuggestAllOptions {
  apply?: boolean | undefined;
  minConfidence?: "high" | "medium" | undefined;
  /** Allow DataForSEO (paid) for clients with no usable Search Console. Off by default: --all never spends unless asked. */
  paid?: boolean | undefined;
  /** Also allow DataForSEO for clients whose Search Console returned under MIN_GSC_ROWS rows. Implies paid. */
  paidSparse?: boolean | undefined;
}

/**
 * Every client: a free Search Console pass first (no paid calls). Then, only when asked (paid or
 * paidSparse), a paid pass for clients that still have no candidates and no usable Search Console
 * (or, with paidSparse, too few rows). Never retries after a Search Console error.
 */
export async function suggestBrandTermsForAll(domains: string[], opts: SuggestAllOptions = {}): Promise<Map<string, SuggestBrandResult | Error>> {
  const results = new Map<string, SuggestBrandResult | Error>();
  const run = async (domain: string, allowPaid: boolean | undefined) => {
    try {
      results.set(domain, await suggestBrandTerms(domain, { apply: opts.apply, minConfidence: opts.minConfidence, allowPaid }));
    } catch (err) {
      results.set(domain, err instanceof Error ? err : new Error(String(err)));
    }
  };
  for (const d of domains) await run(d, false);
  if (!opts.paid && !opts.paidSparse) return results;
  for (const d of domains) {
    const r = results.get(d);
    if (!r || r instanceof Error || r.candidates.length > 0 || r.sources.gsc.error !== undefined) continue;
    const unusable = !r.sources.gsc.used;
    const sparse = r.sources.gsc.used && (r.sources.gsc.rows ?? 0) < MIN_GSC_ROWS;
    if (unusable) await run(d, opts.paidSparse ? true : undefined);
    else if (sparse && opts.paidSparse) await run(d, true);
  }
  return results;
}
