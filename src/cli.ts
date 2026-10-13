#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * crawlmark-cli: local admin commands. Unlike the MCP server, this writes its
 * own output to stdout.
 */
import { Auth } from "googleapis";
import { env } from "./config.js";
import { mapTokenError, missingDataScopes } from "./lib/google-auth.js";
import { deleteTokenFile, readTokenFile } from "./lib/token-store.js";
import { googleAuth, googleAuthStatus } from "./providers/google.js";
import { loopbackLogin } from "./providers/google-login.js";

const USAGE = `Usage: crawlmark-cli <command>

Commands:
  auth login    Sign in to Google in your browser (OAuth mode) and store the token
  auth status   Show the active Google auth mode, account and granted scopes
  auth logout   Revoke the stored Google token and delete it
`;

const out = (line = "") => process.stdout.write(line + "\n");
const warn = (line: string) => process.stderr.write(line + "\n");
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function login(): Promise<number> {
  if (env.GOOGLE_AUTH_MODE !== "oauth") {
    warn("Note: GOOGLE_AUTH_MODE is service_account, so the server won't use this sign-in until you set GOOGLE_AUTH_MODE=oauth.");
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
  out(`Mode: ${s.mode}`);
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

async function main(argv: string[]): Promise<number> {
  const [group, command] = argv;
  if (group === "auth") {
    if (command === "login") return login();
    if (command === "status") return status();
    if (command === "logout") return logout();
  }
  if (!group || group === "help" || group === "--help" || group === "-h") {
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
