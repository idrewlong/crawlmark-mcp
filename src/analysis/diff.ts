import { checkKey, checkOf, gtmContainerKey, normalizeUrl, SEVERITY_ORDER, type CheckedPair, type Finding } from "./findings.js";

/** An audit as saved by the store: what the diff needs plus the full result. */
export interface StoredAudit {
  id: string;
  client: string;
  /** ms since epoch */
  ranAt: number;
  settings: unknown;
  summary: unknown;
  findings: Finding[];
  checked: CheckedPair[];
  result: unknown;
}

export interface AuditDiff {
  base: { auditId: string; ranAt: string };
  target: { auditId: string; ranAt: string };
  /** Not in the base, and the base checked this page and source. */
  new: Finding[];
  /** Not in the base, and the base did not check this page or source: not evidence that anything changed. */
  firstChecked: Finding[];
  resolved: Finding[];
  persistent: Finding[];
  unverified: Finding[];
  /** Base Tag Manager findings of a container the target replaced. */
  retired: Finding[];
  /** Public container IDs, when the audited Tag Manager container changed. */
  containerChange?: { from: string; to: string };
  scoreChanges: { url: string; category: string; from: number; to: number }[];
  /** Caveats about how comparable the two audits are (stale cache, different settings). */
  warnings: string[];
  counts: { new: number; firstChecked: number; resolved: number; persistent: number; unverified: number; retired: number };
}

const DAY_MS = 24 * 60 * 60 * 1000;

const bySeverityThenUrl = (a: Finding, b: Finding) =>
  SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
  a.url.localeCompare(b.url) ||
  a.rule.localeCompare(b.rule) ||
  a.id.localeCompare(b.id);

interface PageScores {
  url: string;
  lighthouse: { ok: boolean; data?: { scores?: Record<string, number> } };
}

/** Lighthouse category scores per URL, read from a stored result. Tolerant of odd shapes. */
function scoresOf(result: unknown): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  const pages = (result as { pages?: PageScores[] } | null)?.pages ?? [];
  for (const p of pages) {
    if (p.lighthouse?.ok && p.lighthouse.data?.scores) out.set(normalizeUrl(p.url), p.lighthouse.data.scores);
  }
  return out;
}

/** The normalised URLs of the pages an audit covered, or null when its result doesn't list pages. */
function auditedPages(result: unknown): Set<string> | null {
  const pages = (result as { pages?: { url?: unknown }[] } | null)?.pages;
  if (!Array.isArray(pages)) return null;
  return new Set(pages.flatMap((p) => (typeof p?.url === "string" ? [normalizeUrl(p.url)] : [])));
}

export function diffAudits(base: StoredAudit, target: StoredAudit): AuditDiff {
  const baseIds = new Map(base.findings.map((f) => [f.id, f]));
  const targetIds = new Map(target.findings.map((f) => [f.id, f]));
  const targetChecked = new Set(target.checked.map(checkKey));
  const baseChecked = new Set(base.checked.map(checkKey));

  // A replaced Tag Manager container: the base audited gtm://X and the target gtm://Y. X's findings can't be fixed or
  // unverified (the container isn't audited any more), and Y's have nothing to be compared with.
  const gtmKeys = (a: StoredAudit) => new Set(a.checked.filter((c) => c.source === "gtm").map((c) => c.url));
  const baseGtm = gtmKeys(base);
  const targetGtm = gtmKeys(target);
  const oldKey = [...baseGtm].find((k) => !targetGtm.has(k));
  const newKey = [...targetGtm].find((k) => !baseGtm.has(k));
  const containerChange = oldKey && newKey ? { from: oldKey.replace(/^gtm:\/\//, ""), to: newKey.replace(/^gtm:\/\//, "") } : undefined;

  const notInBase = target.findings.filter((f) => !baseIds.has(f.id));
  const added = notInBase.filter((f) => baseChecked.has(checkKey(checkOf(f))));
  const firstChecked = notInBase.filter((f) => !baseChecked.has(checkKey(checkOf(f))));
  const persistent = target.findings.filter((f) => baseIds.has(f.id));
  const goneAll = base.findings.filter((f) => !targetIds.has(f.id));
  const retired = containerChange ? goneAll.filter((f) => f.source === "gtm" && gtmContainerKey(f.url) === oldKey) : [];
  const gone = containerChange ? goneAll.filter((f) => !(f.source === "gtm" && gtmContainerKey(f.url) === oldKey)) : goneAll;
  const resolved = gone.filter((f) => targetChecked.has(checkKey(checkOf(f))));
  const unverified = gone.filter((f) => !targetChecked.has(checkKey(checkOf(f))));

  const baseScores = scoresOf(base.result);
  const scoreChanges: AuditDiff["scoreChanges"] = [];
  for (const [url, to] of scoresOf(target.result)) {
    const from = baseScores.get(url);
    if (!from) continue;
    for (const category of Object.keys(to)) {
      const a = from[category];
      const b = to[category];
      if (typeof a === "number" && typeof b === "number" && a !== b) scoreChanges.push({ url, category, from: a, to: b });
    }
  }
  scoreChanges.sort((a, b) => a.url.localeCompare(b.url) || a.category.localeCompare(b.category));

  const warnings: string[] = [];
  const bs = (base.settings ?? {}) as { formFactor?: string; wcagLevel?: string; fresh?: boolean };
  const ts = (target.settings ?? {}) as typeof bs;
  if (bs.formFactor !== ts.formFactor) warnings.push(`Lighthouse form factor differs (base ${bs.formFactor ?? "unknown"}, target ${ts.formFactor ?? "unknown"}); scores and lab metrics are not comparable.`);
  if (bs.wcagLevel !== ts.wcagLevel) warnings.push(`WCAG level differs (base ${bs.wcagLevel ?? "unknown"}, target ${ts.wcagLevel ?? "unknown"}); axe findings are not comparable.`);
  if (ts.fresh !== true && target.ranAt - base.ranAt < DAY_MS) {
    warnings.push("The target audit was not run fresh and is within 24h of the base, so some results may be cached copies of the base. Re-run run_audit with fresh (the default) to compare real changes.");
  }

  if (containerChange) warnings.push(`Tag Manager container changed from ${containerChange.from} to ${containerChange.to}: ${retired.length} finding(s) of ${containerChange.from} are retired and ${containerChange.to}'s are listed as first checked.`);
  const basePages = auditedPages(base.result);
  const targetPages = auditedPages(target.result);
  if (basePages && targetPages) {
    const extra = [...targetPages].filter((u) => !basePages.has(u)).length;
    const missing = [...basePages].filter((u) => !targetPages.has(u)).length;
    if (extra || missing) warnings.push(`The target audited ${extra} page(s) the base didn't${missing ? `, and the base audited ${missing} the target didn't` : ""}; findings on pages the base didn't check are listed as first checked.`);
  }

  const sorted = {
    new: [...added].sort(bySeverityThenUrl),
    firstChecked: [...firstChecked].sort(bySeverityThenUrl),
    retired: [...retired].sort(bySeverityThenUrl),
    resolved: [...resolved].sort(bySeverityThenUrl),
    persistent: [...persistent].sort(bySeverityThenUrl),
    unverified: [...unverified].sort(bySeverityThenUrl),
  };
  return {
    base: { auditId: base.id, ranAt: new Date(base.ranAt).toISOString() },
    target: { auditId: target.id, ranAt: new Date(target.ranAt).toISOString() },
    ...sorted,
    ...(containerChange ? { containerChange } : {}),
    scoreChanges,
    warnings,
    counts: {
      new: sorted.new.length,
      firstChecked: sorted.firstChecked.length,
      retired: sorted.retired.length,
      resolved: sorted.resolved.length,
      persistent: sorted.persistent.length,
      unverified: sorted.unverified.length,
    },
  };
}

export interface AuditLookup {
  get(id: string): StoredAudit | undefined;
  latest(): StoredAudit | undefined;
  /** Most recent audit strictly before the given time. */
  before(ranAt: number): StoredAudit | undefined;
}

/** Choose the two audits for compare_audits. Pure; the lookups are injected. Throws clear errors. */
export function pickComparison(
  client: string,
  args: { baseAuditId?: string; targetAuditId?: string },
  store: AuditLookup,
): { base: StoredAudit; target: StoredAudit } {
  const load = (id: string) => {
    const a = store.get(id);
    if (!a || a.client !== client) throw new Error(`No audit "${id}" for ${client}. Use list_audits to see saved audits.`);
    return a;
  };
  const target = args.targetAuditId ? load(args.targetAuditId) : store.latest();
  if (!target) throw new Error(`${client} has no saved audits. Run run_audit first.`);
  const base = args.baseAuditId ? load(args.baseAuditId) : store.before(target.ranAt);
  if (!base) throw new Error(`${client} needs an audit older than ${target.id} to compare against. Run run_audit again.`);
  if (base.id === target.id) throw new Error("baseAuditId and targetAuditId are the same audit.");
  if (base.ranAt > target.ranAt) {
    throw new Error(`The base audit (${base.id}) is newer than the target (${target.id}). Swap baseAuditId and targetAuditId.`);
  }
  return { base, target };
}

/** The monthly report's audit section: the latest audit, diffed against the last one before the month. Null unless both exist and differ. */
export function monthlyAuditSection(latest: StoredAudit | undefined, beforeMonth: StoredAudit | undefined) {
  if (!latest || !beforeMonth || beforeMonth.id === latest.id) return null;
  return {
    auditId: latest.id,
    ranAt: new Date(latest.ranAt).toISOString(),
    summary: latest.summary,
    diff: diffAudits(beforeMonth, latest),
  };
}
