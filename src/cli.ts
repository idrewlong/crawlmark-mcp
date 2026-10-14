#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * crawlmark-cli: local admin commands. Unlike the MCP server, this writes its
 * own output to stdout.
 */
import { parseArgs } from "node:util";
import { Auth } from "googleapis";
import { autoAddable, type BrandCandidate } from "./analysis/brand-terms.js";
import { suggestBrandTerms, suggestBrandTermsForAll, type SuggestBrandResult } from "./brand-terms.js";
import {
  addBrandTerms,
  addClient,
  loadOverrides,
  addCompetitors,
  addKeywords,
  loadRegistry,
  removeBrandTerms,
  removeClient,
  removeCompetitors,
  removeKeywords,
  resolveClient,
  resolveClientOffline,
  setClientProfile,
  type ListAddResult,
  type ListRemoveResult,
} from "./clients.js";
import { clientDefaults, env, HOME, type Client } from "./config.js";
import { assembleRegistry, formatTable, missingPieces } from "./lib/clients.js";
import { PROVIDER_IDS } from "./lib/provider-ids.js";
import { describeAuthMode } from "./lib/google-auth.js";
import { describeHome } from "./lib/home.js";
import { deleteTokenFile, readTokenFile } from "./lib/token-store.js";
import { checkGoogleAuthLive, googleAuthMode, googleAuthModeNote, googleAuthStatus } from "./providers/google.js";
import { loopbackLogin } from "./providers/google-login.js";
import { runAudits, runRankChecks, runTrafficChecks, type Skipped } from "./scheduled.js";
import { assertSafeUrl } from "./lib/url-guard.js";
import { packageVersion } from "./lib/entry.js";
import { setupCommand } from "./setup/cli-setup.js";
import { groupHelp, HELP_GROUPS, isHelpGroup, programName, topHelp } from "./cli-help.js";
import { printUpdateNotice, updateCacheFile } from "./lib/update-check.js";
import { FORMAT_CHOICES, previewBrandingCommand, reportCommand, templatesCommand, templatesNewCommand, type ReportCliDeps } from "./report-cli.js";
import { openPath } from "./lib/terminal-links.js";
import type { Format } from "./reports/templates/schema.js";
import { chooseRenderer } from "./setup/ui.js";
import { closeEgressProxy } from "./lib/egress-proxy.js";
import { crawlCommand } from "./crawl-cli.js";
import { logsCommand } from "./logs-cli.js";
import { indexCoverageCommand, indexImportCommand } from "./index-coverage-cli.js";
import { dataCommand } from "./data-cli.js";
import { seoSnapshotCommand } from "./seo-snapshot-cli.js";

/** Phase 10: after --help / --version on a TTY, a dim "Update available" line on stderr (at most one registry request a day). */
async function updateNoticeAfterHelp(json = false): Promise<void> {
  await printUpdateNotice({ current: packageVersion(import.meta.url), cacheFile: updateCacheFile(env.DATA_DIR), json });
}

/** Help for a group (or the top level), for stdout (bold on a TTY) or stderr (plain). */
function helpText(group: string | undefined, stream: "stdout" | "stderr" = "stdout"): string {
  const o = { prog: programName(process.argv[1]), bold: stream === "stdout" && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR };
  return isHelpGroup(group) ? groupHelp(group, o) : topHelp(o);
}

/** The command group being run, so a usage error shows that group's help. */
let currentGroup: string | undefined;

// A reader that closes early (e.g. `| head -1`) is not an error.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

const out = (line = "") => process.stdout.write(line + "\n");
const warn = (line: string) => process.stderr.write(line + "\n");
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function login(): Promise<number> {
  const { mode } = googleAuthMode();
  if (mode !== "oauth") {
    warn(
      `Note: the active Google auth mode is ${mode === "none" ? "not configured" : mode}, so the server won't use this sign-in ` +
        "until you set GOOGLE_AUTH_MODE=oauth (or remove GOOGLE_APPLICATION_CREDENTIALS so it auto-detects OAuth).",
    );
  }
  const result = await loopbackLogin({ tokenFile: env.GOOGLE_TOKEN_FILE, log: warn });
  out(`Signed in as ${result.email ?? "(email not returned)"}`);
  out(`Token saved to ${env.GOOGLE_TOKEN_FILE}`);
  out(`Scopes: ${result.scopes.join(" ") || "(none reported)"}`);
  if (result.missingScopes.length) {
    warn(
      `Warning: these scopes were not granted, so the matching tools will fail: ${result.missingScopes.join(", ")}. ` +
        "Run `crawlmark-cli auth login` again and leave every box ticked on the consent screen.",
    );
    return 1;
  }
  return 0;
}

async function status(): Promise<number> {
  const s = googleAuthStatus();
  out(`Home: ${describeHome(HOME)}`);
  out(`Mode: ${describeAuthMode(s)}`);
  const note = googleAuthModeNote();
  if (note) out(`Note: ${note}`);
  if (s.mode === "none") {
    // Not an error: Google is optional.
    out(s.problem);
    return 0;
  }
  if (s.problem) {
    out(s.problem);
    return 1;
  }

  if (s.mode === "service_account") {
    out(`Service account: ${s.email}`);
    out(`Key file: ${s.keyFile}`);
    const check = await checkGoogleAuthLive();
    out(check.ok ? "Key check: OK (obtained an access token)" : `Key check failed: ${check.error}`);
    return check.ok ? 0 : 1;
  }

  out(`Signed in as: ${s.email ?? "(unknown)"}`);
  out(`Token file: ${s.tokenFile}`);
  const check = await checkGoogleAuthLive();
  if (!check.scopes) {
    if (s.scopes) out(`Scopes (at login): ${s.scopes.join(" ")}`);
    out(`Token check failed: ${check.error}`);
    return 1;
  }
  out(`Scopes: ${check.scopes.join(" ")}`);
  out("Token check: OK");
  if (check.gtmScopeMissing) {
    out("Note: Tag Manager access isn't granted, so gtm_audit won't work. Run `crawlmark-cli auth login` again to add it.");
  }
  if (check.missingScopes?.length) {
    out(`Missing scopes: ${check.missingScopes.join(", ")}. Run \`crawlmark-cli auth login\` again and grant all of them.`);
    return 1;
  }
  return 0;
}

async function logout(): Promise<number> {
  const path = env.GOOGLE_TOKEN_FILE;
  let token;
  try {
    token = readTokenFile(path);
  } catch (err) {
    warn(`Warning: ${message(err)} Deleting it without revoking.`);
  }
  if (token) {
    try {
      // Revoking the refresh token also invalidates its access tokens.
      await new Auth.OAuth2Client().revokeToken(token.refresh_token);
      out("Revoked the Google token.");
    } catch (err) {
      warn(
        `Warning: could not revoke the token (${message(err)}). Deleting it locally anyway; ` +
          "you can remove access at https://myaccount.google.com/permissions.",
      );
    }
  }
  if (deleteTokenFile(path)) {
    out(`Deleted ${path}. Signed out.`);
  } else if (!token) {
    out("Not signed in (no token file).");
  }
  return 0;
}

async function clientsList(refresh: boolean): Promise<number> {
  const registry = await loadRegistry({ refresh });
  const rows = registry.clients.map((c) => [
    c.domain,
    c.name,
    c.sources.join(",") || "-",
    c.gscProperty ?? "-",
    c.ga4PropertyId ?? "-",
    missingPieces(c).join(",") || "-",
    [
      c.aliases.length ? `aliases: ${c.aliases.join(", ")}` : "",
      c.alternates.gsc.length ? `other GSC: ${c.alternates.gsc.join(", ")}` : "",
      c.alternates.ga4.length ? `other GA4: ${c.alternates.ga4.map((a) => a.propertyId).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; "),
  ]);
  if (rows.length) {
    out(formatTable(["DOMAIN", "NAME", "SOURCES", "GSC PROPERTY", "GA4 ID", "MISSING", "NOTES"], rows));
    out();
  }
  const d = registry.discovery;
  const f = registry.clientsFile;
  const status = d.skipped ? "skipped" : d.ok ? "ok" : "failed";
  out(`${registry.clients.length} client(s) from ${f.path}${f.exists ? "" : " (not created yet)"}. Discovery: ${status}${registry.fromCache ? " (cached; --refresh to re-list)" : ""}.`);
  if (f.added.length) out(`Added to clients.yaml: ${f.added.join(", ")}`);
  if (f.filled.length) out(`Filled in clients.yaml: ${f.filled.join(", ")}`);
  if (registry.ignored.length) out(`Ignored (ignore: true): ${registry.ignored.join(", ")}`);
  if (d.info) out(d.info);
  if (d.error) out(`Discovery failed, showing clients.yaml entries only: ${d.error}`);
  for (const w of d.warnings) out(`Warning: ${w}`);
  for (const n of d.notes) out(`Note: ${n}`);
  if (!registry.clients.length && d.skipped) out("Add a client with: crawlmark-cli clients add <domain>");
  // Google not being set up is fine; a configured Google that fails is not.
  return d.ok || d.skipped ? 0 : 1;
}

async function clientsAdd(domains: string[], name: string | undefined): Promise<number> {
  if (domains.length === 0) return usageError("clients add needs at least one domain.");
  if (name !== undefined && domains.length > 1) return usageError("--name works with a single domain.");
  let failed = 0;
  for (const domain of domains) {
    try {
      const r = await addClient(domain, name);
      if (r.status === "added") out(`Added ${r.domain} to ${env.CLIENTS_FILE}.`);
      else if (r.status === "unignored") out(`${r.domain} was ignored; removed \`ignore: true\` from its entry (${r.key}).`);
      else out(`${r.domain} is already in ${env.CLIENTS_FILE} (as ${r.key}); nothing changed.`);
    } catch (err) {
      warn(`Could not add ${domain}: ${message(err)}`);
      failed++;
    }
  }
  return failed ? 1 : 0;
}

async function clientsRemove(domains: string[], ignore: boolean): Promise<number> {
  if (domains.length === 0) return usageError("clients remove needs at least one domain.");
  let failed = 0;
  const removed: string[] = [];
  for (const domain of domains) {
    try {
      const r = await removeClient(domain, { ignore });
      if (r.status === "not-found") {
        out(`${r.domain} isn't in ${env.CLIENTS_FILE}; nothing changed.`);
        failed++;
      } else if (r.status === "ignored") {
        out(`${r.domain} is now ignore: true in ${env.CLIENTS_FILE}. It's hidden, and discovery won't add it back.`);
      } else {
        out(`Removed ${r.domain} from ${env.CLIENTS_FILE}.`);
        removed.push(r.domain);
      }
      if (r.status !== "not-found") {
        // Phase 13 B: a removed (or hidden) client's stored Ahrefs data is deleted (Ahrefs storage decision).
        const { purgeProviderData } = await import("./lib/provider-data.js");
        const p = purgeProviderData("ahrefs", r.domain);
        if (p.snapshots + p.cacheEntries + p.issueSnapshotsEdited > 0) out(`Deleted stored Ahrefs data for ${r.domain} (${p.snapshots} snapshot rows, ${p.cacheEntries} cache entries).`);
      }
    } catch (err) {
      warn(`Could not remove ${domain}: ${message(err)}`);
      failed++;
    }
  }
  if (removed.length) {
    out(
      "If Google still lists a removed domain, discovery will add it back on the next run. " +
        `To hide it for good, run \`crawlmark-cli clients remove ${removed.join(" ")} --ignore\` (sets ignore: true).`,
    );
  }
  return failed ? 1 : 0;
}

function printSkipped(skipped: { input: string; detail: string }[]): void {
  for (const k of skipped) out(`Skipped ${k.input}: ${k.detail}`);
}

function printAdded<E>(r: ListAddResult<E>, label: (e: E) => string, noun: string): number {
  for (const a of r.added) out(`Added ${label(a)}${a.input.trim() !== label(a) ? ` (from ${a.input})` : ""}.`);
  printSkipped(r.skipped);
  out(`${r.client} now has ${r.list.length} ${noun}. File: ${r.clientsFile}`);
  // Only a request that was entirely invalid fails; duplicates are not errors.
  return r.added.length === 0 && r.skipped.some((k) => k.reason === "invalid") ? 1 : 0;
}

function printRemoved<E>(r: ListRemoveResult<E>, noun: string): number {
  for (const v of r.removed) out(`Removed ${v}.`);
  printSkipped(r.skipped);
  out(`${r.client} now has ${r.list.length} ${noun}. File: ${r.clientsFile}`);
  return r.removed.length === 0 ? 1 : 0;
}

const meta = (e: { source?: string; addedAt?: string; note?: string }) => [e.source ?? "-", e.addedAt ?? "-", e.note ?? ""];

async function competitorsCommand(command: string | undefined, args: string[], note: string | undefined): Promise<number> {
  const [client, ...domains] = args;
  if (!client) return usageError(`competitors ${command ?? ""} needs a client.`);
  if (command === "list") {
    if (domains.length) return usageError("competitors list takes only a client.");
    const c = await resolveClient(client);
    if (c.competitorEntries.length === 0) out(`${c.domain} has no competitors yet. Add some with: crawlmark-cli competitors add ${c.domain} <domain>...`);
    else out(formatTable(["DOMAIN", "SOURCE", "ADDED", "NOTE"], c.competitorEntries.map((e) => [e.domain, ...meta(e)])));
    out(`Area: ${c.area ?? "(not set)"}. Niche: ${c.niche ?? "(not set)"}.`);
    return 0;
  }
  if (domains.length === 0) return usageError(`competitors ${command} needs at least one domain.`);
  if (command === "add") return printAdded(await addCompetitors(client, domains, { note }), (e) => e.domain, "competitor(s)");
  if (command === "remove") return printRemoved(await removeCompetitors(client, domains), "competitor(s)");
  return usageError(`Unknown command: competitors ${command ?? ""}`);
}

async function keywordsCommand(command: string | undefined, args: string[], note: string | undefined): Promise<number> {
  const [client, ...keywords] = args;
  if (!client) return usageError(`keywords ${command ?? ""} needs a client.`);
  if (command === "list") {
    if (keywords.length) return usageError("keywords list takes only a client.");
    const c = await resolveClient(client);
    if (c.keywordEntries.length === 0) out(`${c.domain} has no tracked keywords yet. Add some with: crawlmark-cli keywords add ${c.domain} "<keyword>"...`);
    else out(formatTable(["KEYWORD", "SOURCE", "ADDED", "NOTE"], c.keywordEntries.map((e) => [e.keyword, ...meta(e)])));
    return 0;
  }
  if (keywords.length === 0) return usageError(`keywords ${command} needs at least one keyword.`);
  if (command === "add") return printAdded(await addKeywords(client, keywords, { note }), (e) => e.keyword, "tracked keyword(s)");
  if (command === "remove") return printRemoved(await removeKeywords(client, keywords), "tracked keyword(s)");
  return usageError(`Unknown command: keywords ${command ?? ""}`);
}

async function brandCommand(command: string | undefined, args: string[], values: BrandFlags): Promise<number> {
  if (command === "suggest") return brandSuggest(args, values);
  const [client, ...terms] = args;
  if (!client) return usageError(`brand ${command ?? ""} needs a client.`);
  if (command === "list") {
    if (terms.length) return usageError("brand list takes only a client.");
    const c = await resolveClient(client);
    if (c.brandTermEntries.length === 0) out(`${c.domain} has no brand terms yet (the domain and name are always matched). Try: crawlmark-cli brand suggest ${c.domain}`);
    else out(formatTable(["TERM", "SOURCE", "ADDED"], c.brandTermEntries.map((e) => [e.term, e.source ?? "-", e.addedAt ?? "-"])));
    return 0;
  }
  if (terms.length === 0) return usageError(`brand ${command} needs at least one term.`);
  if (command === "add") return printAdded(await addBrandTerms(client, terms), (e) => e.term, "brand term(s)");
  if (command === "remove") return printRemoved(await removeBrandTerms(client, terms), "brand term(s)");
  return usageError(`Unknown command: brand ${command ?? ""}`);
}

const signalText = (c: BrandCandidate) =>
  [c.signals.nameSimilarity.fired && `name ${c.signals.nameSimilarity.score}`, c.signals.navigational.fired && "navigational", c.signals.concentration.fired && "concentration"]
    .filter(Boolean)
    .join(", ") || "-";

type BrandFlags = { all: boolean; apply: boolean; "min-confidence"?: string | undefined; "no-paid": boolean; paid: boolean; "paid-sparse": boolean };

async function brandSuggest(args: string[], values: BrandFlags): Promise<number> {
  const min = values["min-confidence"] ?? "high";
  if (values["no-paid"] && values["paid-sparse"]) return usageError("--no-paid and --paid-sparse can't be combined.");
  if (min !== "high" && min !== "medium") return usageError("--min-confidence must be high or medium.");
  if (values.all === (args.length > 0)) return usageError("brand suggest takes one client or --all.");
  if (args.length > 1) return usageError("brand suggest takes one client.");
  if (values["no-paid"] && values.paid) return usageError("--no-paid and --paid can't be combined.");
  const targets = values.all ? (await loadRegistry()).clients.map((c) => c.domain) : [args[0]!];
  let results: Map<string, SuggestBrandResult | Error>;
  if (values.all) {
    // No paid calls unless --paid (clients with no usable Search Console) or --paid-sparse (also sparse Search Console).
    results = await suggestBrandTermsForAll(targets, { apply: values.apply, minConfidence: min, paid: values.paid, paidSparse: values["paid-sparse"] });
  } else {
    // One client: DataForSEO only when it has no Search Console property, also for sparse data with --paid-sparse, never with --no-paid.
    const allowPaid = values["no-paid"] ? false : values["paid-sparse"] ? true : undefined;
    results = new Map();
    try {
      results.set(targets[0]!, await suggestBrandTerms(targets[0]!, { apply: values.apply, minConfidence: min, allowPaid }));
    } catch (err) {
      results.set(targets[0]!, err instanceof Error ? err : new Error(String(err)));
    }
  }

  const rows: string[][] = [];
  let cost = 0;
  let failed = 0;
  for (const [domain, r] of results) {
    if (r instanceof Error) {
      rows.push([domain, "(error)", "-", "-", "-", r.message.slice(0, 80), "-", "-"]);
      failed++;
      continue;
    }
    cost += r.costUsd;
    if (r.candidates.length === 0) {
      const why = r.sources.gsc.skipped ?? (r.sources.gsc.rows !== undefined ? `${r.sources.gsc.rows} GSC rows` : "");
      rows.push([domain, "(none)", "-", "-", "-", why || "-", "-", "-"]);
    }
    const saved = new Set((r.applied?.added ?? []).map((a) => a.term.toLowerCase()));
    for (const c of r.candidates) {
      rows.push([domain, c.term, c.confidence, String(c.score), c.source, signalText(c), c.reviewReason === null ? "yes" : c.reviewReason.replace("needs-review: ", "review: "), saved.has(c.term.toLowerCase()) ? "yes" : "-"]);
    }
    for (const e of r.excluded) rows.push([domain, e.term, "excluded", "-", "-", `${e.reason} (${e.client})`, "-", "-"]);
  }
  out(formatTable(["CLIENT", "TERM", "CONFIDENCE", "SCORE", "SOURCE", "SIGNALS", "AUTO", "SAVED"], rows));
  out();
  out(`DataForSEO cost: $${cost.toFixed(4)}.${values.apply ? ` Saved terms at ${min} confidence or above.` : " Nothing saved; re-run with --apply, or add terms with: crawlmark-cli brand add <client> <term>..."}`);
  const ok = [...results.values()].filter((r): r is SuggestBrandResult => !(r instanceof Error));
  const auto = ok.reduce((n, r) => n + autoAddable(r.candidates, "high").length, 0);
  out(`${auto} high-confidence candidate(s) qualify for automatic adding (AUTO yes) across ${results.size} client(s); the rest are suggestions to review.`);
  return failed && failed === results.size ? 1 : 0;
}

type ClientsSetFlags = {
  area?: string | undefined;
  niche?: string | undefined;
  name?: string | undefined;
  "brand-terms"?: string | undefined;
  provider?: string | undefined;
  country?: string | undefined;
  "bing-site"?: string | undefined;
  "place-id"?: string | undefined;
  "ahrefs-site-audit-project"?: string | undefined;
  "semrush-project"?: string | undefined;
};

/** `none` (any case) clears a value: the empty string setClientProfile expects. */
const noneToEmpty = (v: string | undefined) => (v !== undefined && v.trim().toLowerCase() === "none" ? "" : v);

async function clientsSet(args: string[], values: ClientsSetFlags): Promise<number> {
  if (args.length !== 1) return usageError("clients set takes exactly one client.");
  if (Object.values({ a: values.area, n: values.niche, m: values.name, b: values["brand-terms"], p: values.provider, c: values.country, s: values["bing-site"], g: values["place-id"], ah: values["ahrefs-site-audit-project"], sp: values["semrush-project"] }).every((v) => v === undefined)) {
    return usageError("clients set needs --area, --niche, --name, --brand-terms, --provider, --country, --bing-site, --place-id, --ahrefs-site-audit-project or --semrush-project.");
  }
  const provider = noneToEmpty(values.provider)?.trim().toLowerCase();
  if (provider !== undefined && provider !== "" && !(PROVIDER_IDS as readonly string[]).includes(provider)) {
    return usageError(`--provider must be one of ${PROVIDER_IDS.join(", ")} or none (got "${values.provider}").`);
  }
  const country = noneToEmpty(values.country)?.trim();
  if (country !== undefined && country !== "" && !/^[A-Za-z]{2}$/.test(country)) {
    return usageError(`--country must be a two-letter ISO code such as US or GB, or none (got "${values.country}").`);
  }
  const brandTerms = values["brand-terms"] === undefined ? undefined : values["brand-terms"].split(",");
  const r = await setClientProfile(args[0]!, { area: values.area, niche: values.niche, name: values.name, brandTerms, dataProvider: provider, country, bingSite: noneToEmpty(values["bing-site"]), gbpPlaceId: noneToEmpty(values["place-id"]), ahrefsSiteAuditProject: noneToEmpty(values["ahrefs-site-audit-project"]), semrushProject: noneToEmpty(values["semrush-project"]) }, { trustedPlaceId: true });
  for (const [k, v] of Object.entries(r.set)) out(`Set ${k}: ${v}`);
  for (const k of r.cleared) out(`Cleared ${k}.`);
  out(
    `${r.client}: name ${r.profile.name}; area ${r.profile.area ?? "(not set)"}; niche ${r.profile.niche ?? "(not set)"}; brand terms ${r.profile.brandTerms.join(", ") || "(none)"}. ` +
      (r.profile.country !== undefined ? `data provider ${r.profile.dataProvider ?? "(default)"}; country ${r.profile.country ?? "(none)"}. ` : "") +
      (r.profile.bingSite !== undefined ? `Bing site ${r.profile.bingSite ?? "(matched by domain)"}. ` : "") +
      (r.profile.gbpPlaceId !== undefined ? `Google Business Profile place ID ${r.profile.gbpPlaceId ?? "(not set)"}. ` : "") +
      (r.profile.ahrefsSiteAuditProject !== undefined ? `Ahrefs Site Audit project ${r.profile.ahrefsSiteAuditProject ?? "(matched by domain)"}. ` : "") +
      (r.profile.semrushProject !== undefined ? `Semrush project ${r.profile.semrushProject ?? "(matched by domain)"}. ` : "") +
      `File: ${r.clientsFile}`,
  );
  return 0;
}

type ScheduledFlags = { client?: string | undefined; all: boolean; urls?: string | undefined; "dry-run": boolean; "include-tag-manager": boolean; live: boolean };

/** Usage problems in the scheduled commands exit 1, because 2 means "alerts" to a cron wrapper. */
function scheduledUsage(problem: string): number {
  warn(`${problem}\n`);
  warn(helpText(currentGroup, "stderr"));
  return 1;
}

async function scheduledCommand(kind: "audit" | "check-traffic" | "check-ranks", args: string[], values: ScheduledFlags): Promise<number> {
  if (args.length) return scheduledUsage(`${kind} takes only flags, got: ${args.join(" ")}`);
  if (values.all === (values.client !== undefined)) return scheduledUsage(`${kind} takes --client <domain|slug> or --all.`);
  if (values.urls !== undefined && (kind !== "audit" || values.all)) return scheduledUsage("--urls works only with `audit --client`.");
  if (values["include-tag-manager"] && kind !== "audit") return scheduledUsage("--include-tag-manager works only with `audit`.");
  // Paid live SERPs run only when --live is given explicitly (never by default, also not from cron).
  if (values.live && kind !== "check-ranks") return scheduledUsage("--live works only with `check-ranks`.");

  let urls: string[] | undefined;
  if (values.urls !== undefined) {
    urls = values.urls.split(",").map((u) => u.trim()).filter(Boolean);
    if (!urls.length) return scheduledUsage("--urls needs at least one URL.");
    for (const u of urls) await assertSafeUrl(u);
  }

  let clients: Client[];
  const skipped: Skipped[] = [];
  let discovery: unknown;
  let discoveryError: string | undefined;
  if (values.all) {
    const registry = await loadRegistry({ refresh: true });
    clients = registry.clients;
    for (const domain of registry.ignored) skipped.push({ client: domain, reason: "ignore: true in clients.yaml" });
    const d = registry.discovery;
    discoveryError = d.error;
    discovery = { ok: d.ok, skipped: d.skipped ?? false, error: d.error, warnings: d.warnings };
    if (d.error) warn(`Discovery failed, using clients.yaml entries only: ${d.error}`);
  } else {
    try {
      clients = [await resolveClient(values.client!)];
    } catch (err) {
      // A typo in a scheduled job should be noticed, so an unknown or ignored client is an error here.
      warn(`Error: ${message(err)}`);
      return 1;
    }
  }

  const common = { dryRun: values["dry-run"], skipped, discoveryError, webhookUrl: env.ALERT_WEBHOOK_URL };
  const thresholds = { trafficDropPct: env.ALERT_TRAFFIC_DROP_PCT, minClicksLost: env.ALERT_MIN_CLICKS_LOST };
  const report =
    kind === "audit"
      ? await runAudits(clients, { ...common, ...(urls ? { urls } : {}), ...(values["include-tag-manager"] ? { includeTagManager: true } : {}) })
      : kind === "check-ranks"
        ? await runRankChecks(clients, { ...common, live: values.live, rankDropThreshold: env.ALERT_RANK_DROP })
        : await runTrafficChecks(clients, { ...common, thresholds });
  out(JSON.stringify({ ...report, discovery }, null, 2));
  for (const e of report.errors) warn(`Error: ${e}`);
  return report.exitCode;
}

/** The real sources for `report`: discovery as `audit --all` (cached for a dry run), Google, Chrome for PDF. */
async function realReportDeps(opts: { interactive?: boolean } = {}): Promise<ReportCliDeps> {
  const [{ loadDefaultRunDeps }, { chromePdfPrinter }] = await Promise.all([import("./reports/templates/run.js"), import("./reports/render/pdf.js")]);
  return {
    loadClients: async ({ client, all, dryRun }) => {
      if (!all) return { clients: [await resolveClient(client!)], skipped: [] };
      // A dry run doesn't run discovery (which can add new domains to clients.yaml): clients.yaml only.
      const registry = dryRun
        ? assembleRegistry({ skipped: "Dry run: clients.yaml only (discovery not run)." }, loadOverrides(), clientDefaults)
        : await loadRegistry({ refresh: true });
      const d = registry.discovery;
      if (d.error) warn(`Discovery failed, using clients.yaml entries only: ${d.error}`);
      return {
        clients: registry.clients,
        skipped: registry.ignored.map((domain) => ({ client: domain, reason: "ignore: true in clients.yaml" })),
        discovery: { ok: d.ok, skipped: d.skipped ?? false, error: d.error, warnings: d.warnings },
        discoveryError: d.error,
      };
    },
    runDeps: loadDefaultRunDeps,
    printer: chromePdfPrinter,
    reportsDir: env.REPORTS_DIR,
    version: packageVersion(import.meta.url),
    ...(opts.interactive
      ? {
          chooseFormats: async (defaults: Format[]) => {
            const { clackPrompter } = await import("./setup/ui-clack.js");
            const prompt = clackPrompter();
            try {
              return (await prompt.multiselect?.("Which formats? (space to tick, Enter to confirm)", FORMAT_CHOICES, defaults)) ?? defaults;
            } finally {
              prompt.close();
            }
          },
        }
      : {}),
  };
}

function usageError(problem: string): number {
  warn(`${problem}\n`);
  warn(helpText(currentGroup, "stderr"));
  return 2;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--version" || argv[0] === "-v") {
    out(packageVersion(import.meta.url));
    await updateNoticeAfterHelp();
    return 0;
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      refresh: { type: "boolean", default: false },
      ignore: { type: "boolean", default: false },
      name: { type: "string" },
      note: { type: "string" },
      area: { type: "string" },
      niche: { type: "string" },
      "brand-terms": { type: "string" },
      provider: { type: "string" },
      country: { type: "string" },
      "bing-site": { type: "string" },
      "place-id": { type: "string" },
      "ahrefs-site-audit-project": { type: "string" },
      "semrush-project": { type: "string" },
      all: { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      "min-confidence": { type: "string" },
      "no-paid": { type: "boolean", default: false },
      paid: { type: "boolean", default: false },
      "paid-sparse": { type: "boolean", default: false },
      client: { type: "string" },
      urls: { type: "string" },
      "include-tag-manager": { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      step: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
      json: { type: "boolean", default: false },
      only: { type: "string" },
      template: { type: "string" },
      month: { type: "string" },
      quarter: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      format: { type: "string" },
      include: { type: "string" },
      to: { type: "string" },
      force: { type: "boolean", default: false },
      "max-pages": { type: "string" },
      "max-depth": { type: "string" },
      concurrency: { type: "string" },
      "user-agent": { type: "string" },
      "include-subdomains": { type: "boolean", default: false },
      "start-url": { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      bots: { type: "string" },
      "no-verify": { type: "boolean", default: false },
      max: { type: "string" },
      "stale-days": { type: "string" },
      "all-pages": { type: "boolean", default: false },
      reason: { type: "string" },
      "confirm-property": { type: "boolean", default: false },
      kinds: { type: "string" },
      file: { type: "string" },
      replace: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [group, command, ...args] = positionals;
  currentGroup = group;
  if (values.help) {
    out(helpText(group === "help" ? command : group));
    await updateNoticeAfterHelp(values.json);
    return 0;
  }
  // Phase 13 B: commands that read or write stored provider data first check whether the Ahrefs key was removed and
  // delete expired cache rows. Before the dispatch, so the commands that return early (report, audit, check-ranks)
  // reconcile too: a cron-only install must not keep a removed provider's data. help and setup are untouched.
  if (["report", "seo-snapshot", "data", "audit", "check-ranks", "clients"].includes(group ?? "")) (await import("./lib/provider-data.js")).reconcileOnce();
  if (group === "audit" || group === "check-traffic" || group === "check-ranks") return scheduledCommand(group, command ? [command, ...args] : args, values);
  if (group === "crawl") {
    return crawlCommand(command ? [command, ...args] : args, values, { out, warn, usage: scheduledUsage }, {
      resolveClient,
      run: async (client, opts) => {
        const { runLocalCrawl, loadLocalCrawlDeps } = await import("./reports/local-crawl.js");
        return (await runLocalCrawl(client, opts, await loadLocalCrawlDeps())).result;
      },
    });
  }
  if (group === "index-coverage" && command === "import") {
    return indexImportCommand(args, values, { out, warn, usage: scheduledUsage }, {
      resolveClient,
      importFile: async (client, path, opts) => {
        const [{ resolveCliLogFiles }, { importPagesExport }] = await Promise.all([import("./lib/log-files.js"), import("./reports/pages-import.js")]);
        const [file] = await resolveCliLogFiles([path], { file: "export file", dirs: "" });
        return importPagesExport(client, file!, { reason: opts.reason, confirmProperty: opts.confirmProperty, now: Date.now() });
      },
    });
  }
  if (group === "index-coverage") {
    return indexCoverageCommand(command ? [command, ...args] : args, values, { out, warn, usage: scheduledUsage }, {
      loadClients: async ({ client, all }) => {
        if (!all) return { clients: [await resolveClient(client!)], skipped: [] };
        const registry = await loadRegistry({ refresh: true });
        const d = registry.discovery;
        if (d.error) warn(`Discovery failed, using clients.yaml entries only: ${d.error}`);
        return { clients: registry.clients, skipped: registry.ignored.map((domain) => ({ client: domain, reason: "ignore: true in clients.yaml" })), discoveryError: d.error };
      },
      run: async (c, o) => {
        const ix = await import("./reports/indexing.js");
        return ix.inspectIndexCoverage(c, o, await ix.loadIndexingDeps());
      },
    });
  }
  if (group === "logs") {
    return logsCommand(command ? [command, ...args] : args, values, { out, warn, usage: scheduledUsage }, {
      resolveClient,
      analyze: async (client, files, opts) => {
        const [{ analyzeLogs }, { googleCrawlerRanges }] = await Promise.all([import("./reports/log-analysis.js"), import("./providers/crawler-ipranges.js")]);
        return analyzeLogs(client.slug, files, opts, { googleRanges: (signal) => googleCrawlerRanges({ signal }) });
      },
    });
  }
  if (group === "report" && command === "preview-branding") {
    const fancy = chooseRenderer({ stdinTTY: process.stdin.isTTY, stdoutTTY: process.stdout.isTTY, env: process.env, yes: values.yes }) === "fancy";
    try {
      return await previewBrandingCommand(args, values, { out, warn, homeDir: HOME.dir, cwd: process.cwd() }, {
        resolveClient: resolveClientOffline,
        render: async (branding) => {
          const [{ renderBrandingPreview }, { chromePdfPrinter }] = await Promise.all([import("./reports/branding-preview.js"), import("./reports/render/pdf.js")]);
          return renderBrandingPreview(HOME.dir, branding, { printer: chromePdfPrinter, version: packageVersion(import.meta.url) });
        },
        ...(fancy
          ? {
              open: async (path: string) => {
                const { clackPrompter } = await import("./setup/ui-clack.js");
                const prompt = clackPrompter();
                try {
                  const a = await prompt.ask("Press Enter to open the preview (or s to skip)");
                  if (a.trim() === "" && !openPath(path)) out(`Couldn't open it. The preview is ${path}`);
                } finally {
                  prompt.close();
                }
              },
            }
          : {}),
      });
    } finally {
      await closeEgressProxy();
    }
  }
  if (group === "report" && command === "templates" && args[0] === "new") {
    // Phase 13 C: the interactive template builder. Fancy (clack) on a capable terminal, plain text otherwise.
    const renderer = chooseRenderer({ stdinTTY: process.stdin.isTTY, stdoutTTY: process.stdout.isTTY, env: process.env, yes: values.yes });
    const [{ loadDefaultRunDeps }, { cliPrefix }] = await Promise.all([import("./reports/templates/run.js"), import("./setup/status-providers.js")]);
    return templatesNewCommand(args.slice(1), values, { out, warn, homeDir: HOME.dir, cwd: process.cwd() }, {
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      ui: async () => {
        if (renderer === "fancy") {
          const clack = await import("./setup/ui-clack.js");
          return { ui: clack.clackUi({ banner: false }), prompt: clack.clackPrompter() };
        }
        const [{ plainUi }, { terminalPrompter }] = await Promise.all([import("./setup/ui.js"), import("./setup/prompter.js")]);
        return { ui: plainUi(out), prompt: terminalPrompter() };
      },
      resolveClient: resolveClientOffline,
      runDeps: loadDefaultRunDeps,
      reportsDir: env.REPORTS_DIR,
      version: packageVersion(import.meta.url),
      cliDisplay: cliPrefix(),
      ...(renderer === "fancy" ? { openPath: (p: string) => openPath(p) } : {}),
    });
  }
  if (group === "report" && command === "templates") {
    const [sub, ...rest] = args;
    return templatesCommand(sub, rest, { out, warn, homeDir: HOME.dir, cwd: process.cwd() });
  }
  if (group === "report") {
    try {
      // The format picker only on an interactive terminal in fancy mode (never in CI, pipes, NO_COLOR or with --yes).
      const interactive = chooseRenderer({ stdinTTY: process.stdin.isTTY, stdoutTTY: process.stdout.isTTY, env: process.env, yes: values.yes }) === "fancy";
      return await reportCommand(command ? [command, ...args] : args, values, { out, warn, homeDir: HOME.dir, cwd: process.cwd() }, await realReportDeps({ interactive }));
    } finally {
      // A PDF starts the egress proxy; its sockets would keep the CLI alive.
      await closeEgressProxy();
    }
  }
  if (group === "seo-snapshot") {
    return seoSnapshotCommand(command ? [command, ...args] : args, values, { out, warn, usage: scheduledUsage }, {
      loadClients: async ({ client, all }) => {
        if (!all) return { clients: [await resolveClient(client!)], skipped: [] };
        const registry = await loadRegistry({ refresh: true });
        const d = registry.discovery;
        if (d.error) warn(`Discovery failed, using clients.yaml entries only: ${d.error}`);
        return { clients: registry.clients, skipped: registry.ignored.map((domain) => ({ client: domain, reason: "ignore: true in clients.yaml" })), discoveryError: d.error };
      },
      sections: async () => {
        const ps = await import("./reports/provider-sections.js");
        return { deps: await ps.loadProviderSectionDeps(), spend: await ps.loadSpendDeps(), ps };
      },
    });
  }
  if (group === "data") {
    const { purgeProviderData } = await import("./lib/provider-data.js");
    return dataCommand(command, args, values, { out, warn, usage: scheduledUsage }, { resolveClient: async (id) => resolveClientOffline(id), purge: purgeProviderData });
  }
  if (group === "clients" && command === "add") return clientsAdd(args, values.name);
  if (group === "clients" && command === "remove") return clientsRemove(args, values.ignore);
  if (group === "clients" && command === "set") return clientsSet(args, values);
  if (group === "competitors") return competitorsCommand(command, args, values.note);
  if (group === "keywords") return keywordsCommand(command, args, values.note);
  if (group === "brand") return brandCommand(command, args, values);
  if (group === "setup") return setupCommand(command, args, values);
  if (group === "init") return setupCommand(command, args, values, "init");
  // Every other command takes no further arguments.
  if (args.length) return usageError(`Unexpected argument${args.length > 1 ? "s" : ""}: ${args.join(" ")}`);
  if (group === "clients") {
    if (command === "list") return clientsList(values.refresh);
  }
  if (group === "auth") {
    if (command === "login") return login();
    if (command === "status") return status();
    if (command === "logout") return logout();
  }
  if (!group) {
    out(helpText(undefined));
    await updateNoticeAfterHelp(values.json);
    return 0;
  }
  if (group === "help") {
    if (command === undefined || isHelpGroup(command)) {
      out(helpText(command));
      await updateNoticeAfterHelp(values.json);
      return 0;
    }
    currentGroup = undefined;
    return usageError(`No help for "${command}". Commands: ${HELP_GROUPS.join(", ")}.`);
  }
  warn(`Unknown command: ${argv.join(" ")}\n`);
  warn(helpText(undefined, "stderr"));
  // 1, not 2: a cron wrapper reads 2 as "alerts".
  return 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  // Refresh failures are already mapped where they happen; a login exchange
  // failure must not be reported as an expired sign-in.
  warn(`Error: ${message(err)}`);
  process.exitCode = 1;
}
