#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * crawlmark-cli: local admin commands. Unlike the MCP server, this writes its
 * own output to stdout.
 */
import { parseArgs } from "node:util";
import { Auth } from "googleapis";
import { addClient, loadRegistry, removeClient } from "./clients.js";
import { env } from "./config.js";
import { formatTable, missingPieces } from "./lib/clients.js";
import { describeAuthMode, mapTokenError, missingDataScopes } from "./lib/google-auth.js";
import { deleteTokenFile, readTokenFile } from "./lib/token-store.js";
import { googleAuth, googleAuthMode, googleAuthModeNote, googleAuthStatus } from "./providers/google.js";
import { loopbackLogin } from "./providers/google-login.js";

const USAGE = `Usage: crawlmark-cli <command>

Commands:
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
    try {
      await (googleAuth() as Auth.GoogleAuth).getAccessToken();
      out("Key check: OK (obtained an access token)");
      return 0;
    } catch (err) {
      out(`Key check failed: ${message(err)}`);
      return 1;
    }
  }

  out(`Signed in as: ${s.email ?? "(unknown)"}`);
  out(`Token file: ${s.tokenFile}`);
  try {
    const client = googleAuth() as Auth.OAuth2Client;
    // Force a refresh so the check exercises the refresh token, not a cached
    // access token. The client's `tokens` listener saves the new access token.
    const { credentials } = await client.refreshAccessToken();
    const token = credentials.access_token;
    if (!token) throw new Error("No access token returned.");
    const info = await client.getTokenInfo(token);
    out(`Scopes: ${info.scopes.join(" ")}`);
    out("Token check: OK");
    const missing = missingDataScopes(info.scopes);
    if (missing.length) {
      out(`Missing scopes: ${missing.join(", ")}. Run \`crawlmark-cli auth login\` again and grant all of them.`);
      return 1;
    }
    return 0;
  } catch (err) {
    if (s.scopes) out(`Scopes (at login): ${s.scopes.join(" ")}`);
    out(`Token check failed: ${message(mapTokenError(err))}`);
    return 1;
  }
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

function usageError(problem: string): number {
  warn(`${problem}\n`);
  warn(USAGE);
  return 2;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      refresh: { type: "boolean", default: false },
      ignore: { type: "boolean", default: false },
      name: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [group, command, ...args] = positionals;
  if (values.help) {
    out(USAGE);
    return 0;
  }
  if (group === "clients" && command === "add") return clientsAdd(args, values.name);
  if (group === "clients" && command === "remove") return clientsRemove(args, values.ignore);
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
  return 2;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  // Refresh failures are already mapped where they happen; a login exchange
  // failure must not be reported as an expired sign-in.
  warn(`Error: ${message(err)}`);
  process.exitCode = 1;
}
