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
  addCompetitors,
  addKeywords,
  loadRegistry,
  removeBrandTerms,
  removeClient,
  removeCompetitors,
  removeKeywords,
  resolveClient,
  setClientProfile,
  type ListAddResult,
  type ListRemoveResult,
} from "./clients.js";
import { env, HOME, type Client } from "./config.js";
import { formatTable, missingPieces } from "./lib/clients.js";
import { describeAuthMode } from "./lib/google-auth.js";
import { describeHome } from "./lib/home.js";
import { deleteTokenFile, readTokenFile } from "./lib/token-store.js";
import { checkGoogleAuthLive, googleAuthMode, googleAuthModeNote, googleAuthStatus } from "./providers/google.js";
import { loopbackLogin } from "./providers/google-login.js";
import { runAudits, runTrafficChecks, type Skipped } from "./scheduled.js";
import { assertSafeUrl } from "./lib/url-guard.js";
import { packageVersion } from "./lib/entry.js";
import { setupCommand } from "./setup/cli-setup.js";

const USAGE = `Usage: crawlmark-cli <command>

Commands:
  setup [--step <node|dataforseo|google|psi|discovery|register>] [--dry-run] [--yes]
                Guided setup: checks Node (and builds from source), enters and live-checks each
                credential, discovers clients and registers crawlmark with Claude. Re-runnable;
                each step shows its status first and can be skipped. --dry-run writes nothing;
                --yes accepts every default without asking (steps that need input are skipped)
  setup status [--json] [--only <id,id>] [--refresh]
                Same checks as the setup_status tool: each integration's state and next step
  setup migrate --to <dir> [--force] [--yes] [--dry-run]
                Copy (never move) .env, config/clients.yaml, data/ and secrets/ from the current
                config home to <dir>, skipping files that exist unless --force. Asks first unless --yes
  auth login    Sign in to Google in your browser (OAuth mode) and store the token
  auth status   Show the active Google auth mode, account and granted scopes
  auth logout   Revoke the stored Google token and delete it
  clients list [--refresh]
                Show every client. When Google is set up, newly discovered Search Console
                and GA4 domains are added to clients.yaml first
  clients add <domain>... [--name <name>]
                Add clients by hand (works without Google, e.g. for DataForSEO);
                --name only with a single domain
  clients remove <domain>... [--ignore]
                Delete clients' entries from clients.yaml; --ignore hides them for good instead
  clients set <client> [--area <location>] [--niche <text>] [--name <name>] [--brand-terms "a,b"]
                Set a client's area (DataForSEO location name, e.g. "Austin,Texas,United States"),
                niche, display name and brand terms (comma-separated; replaces the list; they add to the
                built-in domain/name matching for the branded split); pass "" to clear one
  competitors list <client>
  competitors add <client> <domain>... [--note <text>]
  competitors remove <client> <domain>...
                Manage a client's competitors (URLs and www. forms become bare domains)
  keywords list <client>
  keywords add <client> <keyword>... [--note <text>]
  keywords remove <client> <keyword>...
                Manage a client's tracked keywords (quote keywords with spaces)
  brand list <client>
  brand add <client> <term>...
  brand remove <client> <term>...
                Manage a client's brand terms (quote terms with spaces)
  brand suggest <client>|--all [--apply] [--min-confidence high|medium] [--paid] [--paid-sparse] [--no-paid]
                Infer brand terms from Search Console (free). With --all, DataForSEO (paid,
                ~$0.02 a client) is never used unless --paid (clients with no Search Console
                property) or --paid-sparse (also clients with under 20 Search Console rows).
                For one client it is used when the client has no Search Console property,
                also for sparse data with --paid-sparse, never with --no-paid; never after a
                Search Console error. --apply saves candidates at or above --min-confidence
                (default high) that match the distinctive part of the client's name; AUTO shows
                "yes" for high candidates that qualify, else why it needs review
  audit --client <domain|slug> [--urls <url,url>] [--dry-run]
  audit --all [--dry-run]
                Scheduled audit: runs discovery (--all), a fresh run_audit per client (one at a time),
                saves the snapshot and diffs it against the previous one. --urls overrides the page
                list (one client). Clients that can't be audited are skipped and reported.
  check-traffic --client <domain|slug> | --all [--dry-run]
                Compares the last 7 complete Search Console days with the 7 before, branded vs
                non-branded. Free. Clients without Search Console are skipped.
                Both print JSON to stdout and POST a text summary to ALERT_WEBHOOK_URL when there are
                alerts (new critical/high finding; non-branded clicks down by ALERT_TRAFFIC_DROP_PCT
                and at least ALERT_MIN_CLICKS_LOST). Exit code: 0 no alerts, 1 error, 2 alerts.
`;

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

async function clientsSet(args: string[], values: { area?: string | undefined; niche?: string | undefined; name?: string | undefined; "brand-terms"?: string | undefined }): Promise<number> {
  if (args.length !== 1) return usageError("clients set takes exactly one client.");
  if (values.area === undefined && values.niche === undefined && values.name === undefined && values["brand-terms"] === undefined) {
    return usageError("clients set needs --area, --niche, --name or --brand-terms.");
  }
  const brandTerms = values["brand-terms"] === undefined ? undefined : values["brand-terms"].split(",");
  const r = await setClientProfile(args[0]!, { area: values.area, niche: values.niche, name: values.name, brandTerms });
  for (const [k, v] of Object.entries(r.set)) out(`Set ${k}: ${v}`);
  for (const k of r.cleared) out(`Cleared ${k}.`);
  out(`${r.client}: name ${r.profile.name}; area ${r.profile.area ?? "(not set)"}; niche ${r.profile.niche ?? "(not set)"}; brand terms ${r.profile.brandTerms.join(", ") || "(none)"}. File: ${r.clientsFile}`);
  return 0;
}

type ScheduledFlags = { client?: string | undefined; all: boolean; urls?: string | undefined; "dry-run": boolean };

/** Usage problems in the scheduled commands exit 1, because 2 means "alerts" to a cron wrapper. */
function scheduledUsage(problem: string): number {
  warn(`${problem}\n`);
  warn(USAGE);
  return 1;
}

async function scheduledCommand(kind: "audit" | "check-traffic", args: string[], values: ScheduledFlags): Promise<number> {
  if (args.length) return scheduledUsage(`${kind} takes only flags, got: ${args.join(" ")}`);
  if (values.all === (values.client !== undefined)) return scheduledUsage(`${kind} takes --client <domain|slug> or --all.`);
  if (values.urls !== undefined && (kind !== "audit" || values.all)) return scheduledUsage("--urls works only with `audit --client`.");

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
      ? await runAudits(clients, { ...common, ...(urls ? { urls } : {}) })
      : await runTrafficChecks(clients, { ...common, thresholds });
  out(JSON.stringify({ ...report, discovery }, null, 2));
  for (const e of report.errors) warn(`Error: ${e}`);
  return report.exitCode;
}

function usageError(problem: string): number {
  warn(`${problem}\n`);
  warn(USAGE);
  return 2;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--version" || argv[0] === "-v") {
    out(packageVersion(import.meta.url));
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
      all: { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      "min-confidence": { type: "string" },
      "no-paid": { type: "boolean", default: false },
      paid: { type: "boolean", default: false },
      "paid-sparse": { type: "boolean", default: false },
      client: { type: "string" },
      urls: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      step: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
      json: { type: "boolean", default: false },
      only: { type: "string" },
      to: { type: "string" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [group, command, ...args] = positionals;
  if (values.help) {
    out(USAGE);
    return 0;
  }
  if (group === "audit" || group === "check-traffic") return scheduledCommand(group, command ? [command, ...args] : args, values);
  if (group === "clients" && command === "add") return clientsAdd(args, values.name);
  if (group === "clients" && command === "remove") return clientsRemove(args, values.ignore);
  if (group === "clients" && command === "set") return clientsSet(args, values);
  if (group === "competitors") return competitorsCommand(command, args, values.note);
  if (group === "keywords") return keywordsCommand(command, args, values.note);
  if (group === "brand") return brandCommand(command, args, values);
  if (group === "setup") return setupCommand(command, args, values);
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
  if (!group || group === "help") {
    out(USAGE);
    return 0;
  }
  warn(`Unknown command: ${argv.join(" ")}\n`);
  warn(USAGE);
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
