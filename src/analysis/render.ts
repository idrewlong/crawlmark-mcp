import type { Severity } from "./findings.js";
import type { SeoExtract } from "./render-extract.js";

export interface RenderFlag {
  /** e.g. "title-js-only", "canonical-mismatch". */
  rule: string;
  severity: Severity;
  title: string;
  /** Both values, so the reader can see the difference. */
  evidence: string;
}

const show = (v: string | null | undefined) => (v == null ? "(none)" : JSON.stringify(v));
const norm = (v: string | null) => (v ?? "").replace(/\s+/g, " ").trim();
/** Directive lists compare equal regardless of case, spacing and order ("index,follow" = "Index, Follow"). */
const directives = (v: string) => v.toLowerCase().split(",").map((d) => d.trim()).filter(Boolean).sort().join(",");
const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/**
 * Compare what a crawler gets without JavaScript (raw) with the rendered DOM.
 * Pure. For each of title, canonical and robots: missing in raw but present
 * after render is `<field>-js-only`; present in both but different (or lost in
 * the render) is `<field>-mismatch`. H1 only has the mismatch form.
 */
export function compareRender(raw: SeoExtract, rendered: SeoExtract, opts: { rawTruncated?: boolean } = {}): RenderFlag[] {
  const flags: RenderFlag[] = [];

  const scalar = (field: "title" | "canonical" | "robots", label: string, equal: (a: string, b: string) => boolean = (a, b) => a === b) => {
    const r = raw[field];
    const d = rendered[field];
    if (r == null && d == null) return;
    if (r == null && d != null) {
      flags.push({
        rule: `${field}-js-only`,
        severity: "high",
        title: `${label} only exists after JavaScript runs`,
        evidence: `raw: ${show(r)}; rendered: ${show(d)}`,
      });
    } else if (r == null || d == null || !equal(norm(r), norm(d))) {
      flags.push({
        rule: `${field}-mismatch`,
        severity: "high",
        title: `${label} differs between the raw and rendered page`,
        evidence: `raw: ${show(r)}; rendered: ${show(d)}`,
      });
    }
  };

  scalar("title", "Title");
  scalar("canonical", "Canonical", sameUrl);
  scalar("robots", "Robots meta", (a, b) => directives(a) === directives(b));

  const rawH1 = raw.h1.join(" | ");
  const renH1 = rendered.h1.join(" | ");
  if (norm(rawH1) !== norm(renH1)) {
    flags.push({
      rule: "h1-mismatch",
      severity: "high",
      title: "H1 differs between the raw and rendered page",
      evidence: `raw: ${show(rawH1 || null)}; rendered: ${show(renH1 || null)}`,
    });
  }

  // Floor: a few words on a tiny page is not "content depends on JS" (deviation from the plan, noted there).
  if (!opts.rawTruncated && rendered.wordCount > raw.wordCount * 3 && rendered.wordCount >= 50 && rendered.wordCount - raw.wordCount >= 30) {
    flags.push({
      rule: "content-js-dependent",
      severity: "medium",
      title: "Most page content depends on JavaScript",
      evidence: `raw: ${raw.wordCount} words; rendered: ${rendered.wordCount} words`,
    });
  }

  if (raw.jsonLdTypes.length === 0 && rendered.jsonLdTypes.length > 0) {
    flags.push({
      rule: "jsonld-js-only",
      severity: "medium",
      title: "Structured data only exists after JavaScript runs",
      evidence: `raw: (none); rendered: ${rendered.jsonLdTypes.join(", ")}`,
    });
  }

  if (rendered.internalLinks > raw.internalLinks * 2) {
    flags.push({
      rule: "links-js-only",
      severity: "medium",
      title: "Many internal links only exist after JavaScript runs",
      evidence: `raw: ${raw.internalLinks} internal links; rendered: ${rendered.internalLinks}`,
    });
  }

  return flags;
}
