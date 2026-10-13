import { createHash } from "node:crypto";

/**
 * Tag Manager container audit (Phase 6b). Pure: no I/O, so it is tested with a
 * hand-built container-version fixture. The provider (src/providers/gtm.ts)
 * fetches the live version and workspace statuses; this file only analyses them.
 *
 * Findings use a local type with source "gtm". run_audit adds them to its
 * findings (analysis/findings.ts) only with includeTagManager (Phase 12, opt-in).
 */

// ---------------------------------------------------------------- input shapes (a subset of the API's ContainerVersion)

export interface GtmParameter {
  type?: string | null;
  key?: string | null;
  value?: string | null;
  list?: GtmParameter[] | null;
  map?: GtmParameter[] | null;
}

export interface GtmTag {
  tagId?: string | null;
  name?: string | null;
  type?: string | null;
  paused?: boolean | null;
  firingTriggerId?: string[] | null;
  blockingTriggerId?: string[] | null;
  parameter?: GtmParameter[] | null;
  consentSettings?: { consentStatus?: string | null } | null;
  setupTag?: { tagName?: string | null }[] | null;
  teardownTag?: { tagName?: string | null }[] | null;
}

export interface GtmTrigger {
  triggerId?: string | null;
  name?: string | null;
  type?: string | null;
  parameter?: GtmParameter[] | null;
  filter?: unknown;
  customEventFilter?: unknown;
  autoEventFilter?: unknown;
}

export interface GtmVariable {
  variableId?: string | null;
  name?: string | null;
  type?: string | null;
  parameter?: GtmParameter[] | null;
}

export interface GtmContainerVersion {
  containerVersionId?: string | null;
  name?: string | null;
  tag?: GtmTag[] | null;
  trigger?: GtmTrigger[] | null;
  variable?: GtmVariable[] | null;
}

// ---------------------------------------------------------------- output

export type GtmSeverity = "medium" | "low";

export type GtmRule =
  | "paused-tag"
  | "no-firing-trigger"
  | "legacy-ua"
  | "duplicate-ga4-config"
  | "unused-variable"
  | "unused-trigger"
  | "custom-html"
  | "missing-consent-settings";

export interface GtmFinding {
  /** Stable hash of source + rule + entity, for diffing once this joins the audit findings. */
  id: string;
  source: "gtm";
  rule: GtmRule;
  severity: GtmSeverity;
  title: string;
  entity: { kind: "tag" | "trigger" | "variable"; id: string; name: string };
  evidence?: string;
}

const SEVERITY: Record<GtmRule, GtmSeverity> = {
  "legacy-ua": "medium",
  "no-firing-trigger": "medium",
  "duplicate-ga4-config": "medium",
  // Tags without consent settings matter for privacy compliance, but the check is heuristic.
  "missing-consent-settings": "medium",
  "paused-tag": "low",
  "unused-variable": "low",
  "unused-trigger": "low",
  "custom-html": "low",
};

const SEVERITY_RANK = { medium: 0, low: 1 } as const;

// ---------------------------------------------------------------- helpers

const str = (v: string | null | undefined, fallback = ""): string => (typeof v === "string" && v !== "" ? v : fallback);
const tagName = (t: GtmTag) => str(t.name, `(tag ${str(t.tagId, "?")})`);

function entity(kind: "tag" | "trigger" | "variable", id: string | null | undefined, name: string) {
  return { kind, id: str(id, name), name };
}

function finding(rule: GtmRule, title: string, e: GtmFinding["entity"], evidence?: string): GtmFinding {
  const id = createHash("sha256").update(["gtm", rule, e.kind, e.id].join("\n")).digest("hex").slice(0, 16);
  return { id, source: "gtm", rule, severity: SEVERITY[rule], title, entity: e, ...(evidence ? { evidence } : {}) };
}

/** Every string value in a parameter tree (values, keys' values, nested lists and maps). */
function paramValues(params: GtmParameter[] | null | undefined): string[] {
  const out: string[] = [];
  const walk = (p: GtmParameter) => {
    if (typeof p.value === "string") out.push(p.value);
    p.list?.forEach(walk);
    p.map?.forEach(walk);
  };
  params?.forEach(walk);
  return out;
}

function paramByKey(params: GtmParameter[] | null | undefined, key: string): string | undefined {
  return params?.find((p) => p.key === key && typeof p.value === "string")?.value ?? undefined;
}

// ---------------------------------------------------------------- rule: legacy Universal Analytics

const UA_ID = /\bUA-\d{4,10}-\d{1,4}\b/i;
/** Tag types that are Universal Analytics or classic Google Analytics. */
const LEGACY_TYPES = new Set(["ua", "ga"]);
/** Snippets that load analytics.js / ga.js from a Custom HTML tag. */
const LEGACY_SNIPPET = /google-analytics\.com\/(?:analytics|ga)\.js|\bga\(\s*['"]create['"]/i;

export function legacyUaFindings(tags: GtmTag[]): GtmFinding[] {
  const out: GtmFinding[] = [];
  for (const t of tags) {
    const type = str(t.type);
    const values = paramValues(t.parameter);
    const ua = values.map((v) => v.match(UA_ID)?.[0]).find(Boolean);
    const snippet = type === "html" && values.some((v) => LEGACY_SNIPPET.test(v));
    if (!LEGACY_TYPES.has(type) && !ua && !snippet) continue;
    const why = LEGACY_TYPES.has(type) ? `tag type "${type}"` : ua ? `property ID ${ua}` : "analytics.js snippet";
    out.push(
      finding(
        "legacy-ua",
        `Legacy Universal Analytics tag "${tagName(t)}"`,
        entity("tag", t.tagId, tagName(t)),
        `${why}. Universal Analytics stopped processing data in 2023; migrate to GA4 or remove the tag.`,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------- rule: duplicate GA4 config / Google tags

const GA4_CONFIG_TYPES = new Set(["gaawc", "googtag"]);

/** Resolve `{{Variable}}` through constant variables, one level. Unresolvable references are kept as written. */
function resolveValue(raw: string, constants: Map<string, string>): string {
  const m = raw.trim().match(/^\{\{(.+)\}\}$/);
  const resolved = m ? constants.get(m[1]!) : undefined;
  return (resolved ?? raw).trim().toUpperCase();
}

function constantVariables(variables: GtmVariable[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of variables) {
    if (v.type !== "c" || !v.name) continue;
    const value = paramByKey(v.parameter, "value");
    if (value) out.set(v.name, value);
  }
  return out;
}

export function duplicateGa4Findings(tags: GtmTag[], variables: GtmVariable[]): GtmFinding[] {
  const constants = constantVariables(variables);
  const byId = new Map<string, GtmTag[]>();
  for (const t of tags) {
    if (t.paused || !GA4_CONFIG_TYPES.has(str(t.type))) continue;
    const raw = paramByKey(t.parameter, t.type === "googtag" ? "tagId" : "measurementId");
    if (!raw) continue;
    const id = resolveValue(raw, constants);
    byId.set(id, [...(byId.get(id) ?? []), t]);
  }
  const out: GtmFinding[] = [];
  for (const [id, group] of [...byId].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (group.length < 2) continue;
    const names = group.map(tagName);
    out.push(
      finding(
        "duplicate-ga4-config",
        `${group.length} active Google tag / GA4 configuration tags use ${id}`,
        entity("tag", `ga4-config:${id}`, names[0]!),
        `Tags: ${names.join(", ")}. Duplicates can double-count page views; keep one per measurement ID.`,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------- rules: paused, no trigger, custom HTML

export function pausedFindings(tags: GtmTag[]): GtmFinding[] {
  return tags
    .filter((t) => t.paused)
    .map((t) => finding("paused-tag", `Paused tag "${tagName(t)}"`, entity("tag", t.tagId, tagName(t)), `type ${str(t.type, "unknown")}`));
}

export function noTriggerFindings(tags: GtmTag[]): GtmFinding[] {
  // A tag with no trigger of its own can still run as another tag's setup or teardown tag.
  const sequenced = new Set<string>();
  for (const t of tags) {
    for (const ref of [...(t.setupTag ?? []), ...(t.teardownTag ?? [])]) if (ref.tagName) sequenced.add(ref.tagName);
  }
  return tags
    .filter((t) => !t.paused && !(t.firingTriggerId ?? []).length && !sequenced.has(str(t.name)))
    .map((t) =>
      finding(
        "no-firing-trigger",
        `Tag "${tagName(t)}" has no firing trigger`,
        entity("tag", t.tagId, tagName(t)),
        `type ${str(t.type, "unknown")}. It never fires unless another tag sequences it.`,
      ),
    );
}

export function customHtmlFindings(tags: GtmTag[]): GtmFinding[] {
  return tags
    .filter((t) => t.type === "html")
    .map((t) => {
      const html = paramByKey(t.parameter, "html") ?? "";
      return finding(
        "custom-html",
        `Custom HTML tag "${tagName(t)}"`,
        entity("tag", t.tagId, tagName(t)),
        `${html.length} characters${t.paused ? ", paused" : ""}. Review for performance and security (arbitrary script runs on every page it fires on).`,
      );
    });
}

// ---------------------------------------------------------------- rules: unused variables and triggers

/** JSON text of an entity, used to look for `{{Name}}` references. */
const jsonOf = (x: unknown) => JSON.stringify(x);

export function unusedVariableFindings(tags: GtmTag[], triggers: GtmTrigger[], variables: GtmVariable[]): GtmFinding[] {
  const corpus: { owner: unknown; text: string }[] = [
    ...tags.map((x) => ({ owner: x, text: jsonOf(x) })),
    ...triggers.map((x) => ({ owner: x, text: jsonOf(x) })),
    ...variables.map((x) => ({ owner: x, text: jsonOf(x) })),
  ];
  const out: GtmFinding[] = [];
  for (const v of variables) {
    if (!v.name) continue;
    // JSON.stringify escapes quotes and backslashes in names, so search for the escaped form.
    const ref = jsonOf(`{{${v.name}}}`).slice(1, -1);
    const used = corpus.some((c) => c.owner !== v && c.text.includes(ref));
    if (!used) {
      out.push(
        finding("unused-variable", `Unused variable "${v.name}"`, entity("variable", v.variableId, v.name), `type ${str(v.type, "unknown")}; no tag, trigger or variable references {{${v.name}}}.`),
      );
    }
  }
  return out;
}

/** Trigger IDs a trigger-group trigger combines (`triggerIds` list of trigger references). */
function groupedTriggerIds(trigger: GtmTrigger): string[] {
  const out: string[] = [];
  const walk = (p: GtmParameter) => {
    if (p.type === "triggerReference" && typeof p.value === "string") out.push(p.value);
    p.list?.forEach(walk);
    p.map?.forEach(walk);
  };
  trigger.parameter?.forEach(walk);
  return out;
}

export function unusedTriggerFindings(tags: GtmTag[], triggers: GtmTrigger[]): GtmFinding[] {
  const used = new Set<string>();
  for (const t of tags) for (const id of [...(t.firingTriggerId ?? []), ...(t.blockingTriggerId ?? [])]) used.add(id);
  for (const tr of triggers) for (const id of groupedTriggerIds(tr)) used.add(id);
  return triggers
    .filter((tr) => tr.triggerId && !used.has(tr.triggerId))
    .map((tr) => {
      const name = str(tr.name, `(trigger ${tr.triggerId})`);
      return finding("unused-trigger", `Unused trigger "${name}"`, entity("trigger", tr.triggerId, name), `type ${str(tr.type, "unknown")}; no tag fires or is blocked by it.`);
    });
}

// ---------------------------------------------------------------- rule: consent settings

/** Tag types with Consent Mode checks built in, so they need no extra consent settings. */
const BUILT_IN_CONSENT = new Set(["googtag", "gaawc", "gaawe", "ua", "ga", "awct", "sp", "flc", "fls", "gclidw", "gcs", "cvt_consent"]);

/** Consent Mode is in use when some tag declares required consent, or a Consent Initialization trigger exists. */
export function consentModeInUse(tags: GtmTag[], triggers: GtmTrigger[]): boolean {
  return (
    tags.some((t) => t.consentSettings?.consentStatus === "needed") ||
    triggers.some((tr) => tr.type === "consentInit" || tr.type === "CONSENT_INIT")
  );
}

export function consentFindings(tags: GtmTag[], triggers: GtmTrigger[]): GtmFinding[] {
  if (!consentModeInUse(tags, triggers)) return [];
  // A CMP tag fires on Consent Initialization triggers; it sets consent rather than needing it.
  const consentInitIds = new Set(triggers.filter((tr) => tr.type === "consentInit" || tr.type === "CONSENT_INIT").map((tr) => tr.triggerId));
  const isCmp = (t: GtmTag) => (t.firingTriggerId ?? []).length > 0 && (t.firingTriggerId ?? []).every((id) => consentInitIds.has(id));
  return tags
    .filter((t) => !t.paused && !BUILT_IN_CONSENT.has(str(t.type)) && !isCmp(t))
    .filter((t) => {
      const status = t.consentSettings?.consentStatus;
      return !status || status === "notSet";
    })
    .map((t) =>
      finding(
        "missing-consent-settings",
        `Tag "${tagName(t)}" has no consent settings`,
        entity("tag", t.tagId, tagName(t)),
        `type ${str(t.type, "unknown")}. Consent Mode is used elsewhere in this container; set the consent checks this tag needs under Advanced Settings > Consent Settings.`,
      ),
    );
}

// ---------------------------------------------------------------- whole-container audit

export interface GtmAnalysis {
  findings: GtmFinding[];
  counts: { tags: number; triggers: number; variables: number };
  consentModeDetected: boolean;
}

export function analyzeContainerVersion(version: GtmContainerVersion): GtmAnalysis {
  const tags = version.tag ?? [];
  const triggers = version.trigger ?? [];
  const variables = version.variable ?? [];
  const findings = [
    ...legacyUaFindings(tags),
    ...noTriggerFindings(tags),
    ...duplicateGa4Findings(tags, variables),
    ...consentFindings(tags, triggers),
    ...pausedFindings(tags),
    ...unusedVariableFindings(tags, triggers, variables),
    ...unusedTriggerFindings(tags, triggers),
    ...customHtmlFindings(tags),
  ].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) ||
      (a.entity.name < b.entity.name ? -1 : a.entity.name > b.entity.name ? 1 : 0),
  );
  return {
    findings,
    counts: { tags: tags.length, triggers: triggers.length, variables: variables.length },
    consentModeDetected: consentModeInUse(tags, triggers),
  };
}

export function countBySeverity(findings: GtmFinding[]): Record<GtmSeverity, number> {
  const out = { medium: 0, low: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
}

// ---------------------------------------------------------------- unpublished workspace changes

/** One `workspaces.getStatus` response (subset). */
export interface GtmWorkspaceStatus {
  workspaceChange?:
    | {
        changeStatus?: string | null;
        tag?: GtmTag | null;
        trigger?: GtmTrigger | null;
        variable?: GtmVariable | null;
        folder?: { name?: string | null } | null;
        client?: { name?: string | null } | null;
        transformation?: { name?: string | null } | null;
        zone?: { name?: string | null } | null;
        customTemplate?: { name?: string | null } | null;
        builtInVariable?: { name?: string | null } | null;
        [k: string]: unknown;
      }[]
    | null;
  mergeConflict?: unknown[] | null;
}

export interface GtmWorkspaceInput {
  workspaceId: string;
  name: string;
  status: GtmWorkspaceStatus;
}

export interface WorkspaceChangeSummary {
  workspaceId: string;
  name: string;
  changes: number;
  byType: Record<string, number>;
  /** First few changed entities, e.g. "tag: GA4 Config (updated)". */
  sample: string[];
  mergeConflicts: number;
}

export interface UnpublishedChanges {
  /** Changed entities across all workspaces (the same entity changed in two workspaces counts twice). */
  totalChanges: number;
  workspaces: WorkspaceChangeSummary[];
}

const SAMPLE_LIMIT = 10;
const ENTITY_KEYS = ["tag", "trigger", "variable", "folder", "client", "transformation", "zone", "customTemplate", "builtInVariable", "environment"] as const;

export function summarizeWorkspaces(workspaces: GtmWorkspaceInput[]): UnpublishedChanges {
  const summaries = workspaces.map((w): WorkspaceChangeSummary => {
    const changes = w.status.workspaceChange ?? [];
    const byType: Record<string, number> = {};
    const sample: string[] = [];
    for (const c of changes) {
      const kind = ENTITY_KEYS.find((k) => c[k] !== undefined && c[k] !== null) ?? "other";
      byType[kind] = (byType[kind] ?? 0) + 1;
      if (sample.length < SAMPLE_LIMIT) {
        const named = (c[kind] as { name?: string | null } | undefined)?.name;
        sample.push(`${kind}: ${named ?? "(unnamed)"}${c.changeStatus ? ` (${c.changeStatus})` : ""}`);
      }
    }
    return { workspaceId: w.workspaceId, name: w.name, changes: changes.length, byType, sample, mergeConflicts: (w.status.mergeConflict ?? []).length };
  });
  return {
    totalChanges: summaries.reduce((n, s) => n + s.changes, 0),
    workspaces: summaries.filter((s) => s.changes > 0 || s.mergeConflicts > 0),
  };
}
