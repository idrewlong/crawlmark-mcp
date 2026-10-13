import { AxePuppeteer } from "@axe-core/puppeteer";
import puppeteer from "puppeteer";
import { cached, cacheKey, TTL } from "../lib/cache.js";
import { CHROME_FLAGS, chromePath } from "./browser.js";

export type WcagLevel = "A" | "AA" | "AAA";

const TAGS: Record<WcagLevel, string[]> = {
  A: ["wcag2a", "wcag21a"],
  AA: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  AAA: ["wcag2a", "wcag2aa", "wcag2aaa", "wcag21a", "wcag21aa", "wcag22aa"],
};

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  wcag: string[];
  nodes: number;
  /** A few example selectors so a dev can find the element. */
  examples: string[];
}

export interface AxeResult {
  url: string;
  level: WcagLevel;
  violations: AxeViolation[];
  counts: { critical: number; serious: number; moderate: number; minor: number };
  incomplete: number;
  passes: number;
}

const IMPACT_ORDER = ["critical", "serious", "moderate", "minor"];

/** Automated WCAG check with axe-core. Catches roughly a third of issues; manual review still needed. */
export async function runAxe(url: string, level: WcagLevel = "AA", opts: { refresh?: boolean } = {}): Promise<AxeResult> {
  const { value } = await cached(cacheKey("axe", url, level), TTL.day, async () => {
    const browser = await puppeteer.launch({ executablePath: await chromePath(), args: CHROME_FLAGS });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 900 });
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });
      const res = await new AxePuppeteer(page).withTags(TAGS[level]).analyze();

      const violations: AxeViolation[] = res.violations
        .map((v) => ({
          id: v.id,
          impact: v.impact ?? null,
          help: v.help,
          helpUrl: v.helpUrl,
          wcag: v.tags.filter((t) => /^wcag\d/.test(t)),
          nodes: v.nodes.length,
          examples: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
        }))
        .sort((a, b) => IMPACT_ORDER.indexOf(a.impact ?? "minor") - IMPACT_ORDER.indexOf(b.impact ?? "minor"));

      const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
      for (const v of violations) {
        const k = (v.impact ?? "minor") as keyof typeof counts;
        counts[k] += v.nodes;
      }
      return { url, level, violations, counts, incomplete: res.incomplete.length, passes: res.passes.length };
    } finally {
      await browser.close();
    }
  }, opts);
  return value;
}
