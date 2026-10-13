/**
 * The ai_readiness report section's data, from a saved audit's site hygiene (llms.txt and AI crawler
 * access). Free and local: it never fetches. Pure. llms.txt content is untrusted, so only counts, the
 * stripped title and URLs are carried over; renderers escape them and show URLs as code.
 */
import type { SiteHygiene } from "../analysis/hygiene.js";
import { stripControl } from "../lib/terminal-text.js";
import type { AiReadinessData } from "./report-types.js";

/** null when the audit predates these checks (neither field is there). */
export function aiReadinessFrom(audit: { id: string; ranAt: number }, hygiene: Pick<SiteHygiene, "llmsTxt" | "aiCrawlers" | "flags">): AiReadinessData | null {
  const l = hygiene.llmsTxt;
  const a = hygiene.aiCrawlers;
  if (!l && !a) return null;
  let llmsTxt: AiReadinessData["llmsTxt"] = { checked: false };
  if (l && !("error" in l)) {
    const f = l.llmsTxt.format;
    const full = "error" in l.llmsFullTxt ? null : { present: l.llmsFullTxt.present, status: l.llmsFullTxt.status, bytes: l.llmsFullTxt.bytes };
    const broken = new Map(hygiene.flags.filter((x) => x.rule === "llms-txt-broken-link").map((x) => [x.url, x]));
    llmsTxt = {
      checked: true,
      url: l.llmsTxt.url,
      present: l.llmsTxt.present,
      status: l.llmsTxt.status,
      contentType: l.llmsTxt.contentType ? stripControl(l.llmsTxt.contentType).slice(0, 100) : null,
      bytes: l.llmsTxt.bytes,
      title: f?.title ? stripControl(f.title).slice(0, 200) : null,
      hasSummary: f?.hasSummary ?? false,
      sections: f?.sectionCount ?? 0,
      links: f?.linkCount ?? 0,
      hasOptionalSection: f?.hasOptionalSection ?? false,
      issues: f?.issues ?? [],
      linksChecked: l.links?.sampled.length ?? 0,
      brokenLinks: (l.links?.sampled ?? []).filter((s) => broken.has(s.url)).map((s) => ({ url: s.url, status: s.status })),
      full,
    };
  }
  let crawlers: AiReadinessData["crawlers"] = { checked: false };
  if (a && !("error" in a)) {
    crawlers = {
      checked: true,
      robotsFound: a.robotsFound,
      keyPages: a.keyPages,
      rows: a.crawlers.map((c) => ({ bot: c.bot, vendor: c.vendor, purpose: c.purpose, honorsRobots: c.honorsRobots, group: c.group, access: c.access, homepage: c.homepage, blockedKeyPages: c.blockedKeyPages.length })),
    };
  }
  return { auditId: audit.id, ranAt: new Date(audit.ranAt).toISOString(), llmsTxt, crawlers };
}
