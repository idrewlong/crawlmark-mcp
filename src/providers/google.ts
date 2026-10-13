import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Auth, google } from "googleapis";
import { env } from "../config.js";
import {
  authIdentityKey,
  inspectServiceAccountKey,
  mapTokenError,
  missingDataScopes,
  missingGtmScope,
  SERVICE_ACCOUNT_SCOPES,
  authModeNote,
  GOOGLE_NOT_CONFIGURED_MESSAGE,
  GoogleNotConfiguredError,
  noTokenMessage,
  resolveAuthMode,
  type ResolvedAuthMode,
  selectGoogleAuthConfig,
  serviceAccountKeyMissingMessage,
  type GoogleAuthStatus,
} from "../lib/google-auth.js";
import { readTokenFile } from "../lib/token-store.js";
import { TIMEOUTS } from "../lib/timeout.js";
import { CrawlmarkOAuth2Client, createOAuthClientLoader } from "./google-oauth-client.js";

// Every googleapis request (Search Console, GA4, discovery) gives up after 30s.
google.options({ timeout: TIMEOUTS.networkMs });

/** A bare OAuth client for the login flow (no stored credentials). */
export function newOAuthClient(redirectUri?: string): Auth.OAuth2Client {
  const cfg = selectGoogleAuthConfig({ ...env, GOOGLE_AUTH_MODE: "oauth" });
  if (cfg.mode !== "oauth") throw new Error("unreachable");
  return new CrawlmarkOAuth2Client({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri });
}

let saAuth: Auth.GoogleAuth | undefined;

function serviceAccountAuth(keyFile: string): Auth.GoogleAuth {
  if (!existsSync(keyFile)) throw new Error(serviceAccountKeyMissingMessage(keyFile));
  saAuth ??= new google.auth.GoogleAuth({ keyFile, scopes: [...SERVICE_ACCOUNT_SCOPES] });
  return saAuth;
}

/** OAuth client loaded with the stored token. Refreshed tokens are merged back into the file. */
const oauthClient = createOAuthClientLoader({
  tokenFile: env.GOOGLE_TOKEN_FILE,
  newClient: () => newOAuthClient(),
  onSaveError: (err) => console.error(`crawlmark: could not save refreshed Google token: ${err.message}`),
});

/** The auth mode in effect: explicit GOOGLE_AUTH_MODE, else auto-detected from the credentials present. */
export function googleAuthMode(): { mode: ResolvedAuthMode; auto: boolean } {
  return resolveAuthMode(env);
}

/** Heads-up when auto-detection ignored a configured OAuth client (see authModeNote). */
export function googleAuthModeNote(): string | undefined {
  return authModeNote(env);
}

/** True when some Google auth is configured (it may still be broken, e.g. a missing key file). */
export function googleConfigured(): boolean {
  return googleAuthMode().mode !== "none";
}

/** Throw the "Google isn't set up" error before a Google call (and before any per-client property check). */
export function assertGoogleConfigured(): void {
  if (!googleConfigured()) throw new GoogleNotConfiguredError();
}

/**
 * Auth for GSC and GA4, chosen by GOOGLE_AUTH_MODE (or auto-detected): the
 * signed-in user's OAuth2Client (auto-refreshing) or the service-account GoogleAuth.
 */
export function googleAuth(): Auth.OAuth2Client | Auth.GoogleAuth {
  const cfg = selectGoogleAuthConfig(env);
  return cfg.mode === "oauth" ? oauthClient() : serviceAccountAuth(cfg.keyFile);
}

/**
 * Which Google identity is active, from local files only (no network). For
 * `auth status` and a later health-check prompt.
 */
export function googleAuthStatus(): GoogleAuthStatus {
  const { mode, auto } = googleAuthMode();
  if (mode === "none") return { mode: "none", auto: true, configured: false, problem: GOOGLE_NOT_CONFIGURED_MESSAGE };
  if (mode === "service_account") {
    const keyFile = env.GOOGLE_APPLICATION_CREDENTIALS;
    const base = { mode: "service_account" as const, auto, keyFile };
    try {
      const cfg = selectGoogleAuthConfig(env);
      if (cfg.mode !== "service_account") throw new Error("unreachable");
      if (!existsSync(cfg.keyFile)) {
        return { ...base, configured: false, problem: serviceAccountKeyMissingMessage(cfg.keyFile) };
      }
      const key = JSON.parse(readFileSync(cfg.keyFile, "utf8")) as { client_email?: unknown };
      const email = typeof key.client_email === "string" ? key.client_email : undefined;
      return email
        ? { ...base, configured: true, email }
        : { ...base, configured: false, problem: `Key file at ${cfg.keyFile} has no client_email; is it a service-account key?` };
    } catch (err) {
      return { ...base, configured: false, problem: (err as Error).message };
    }
  }

  const tokenFile = env.GOOGLE_TOKEN_FILE;
  const base = { mode: "oauth" as const, auto, tokenFile };
  try {
    selectGoogleAuthConfig(env);
  } catch (err) {
    return { ...base, configured: false, signedIn: false, problem: (err as Error).message };
  }
  try {
    const token = readTokenFile(tokenFile);
    if (!token) return { ...base, configured: true, signedIn: false, problem: noTokenMessage(tokenFile) };
    return {
      ...base,
      configured: true,
      signedIn: true,
      ...(token.email ? { email: token.email } : {}),
      ...(token.scope ? { scopes: token.scope.split(/\s+/) } : {}),
    };
  } catch (err) {
    return { ...base, configured: true, signedIn: false, problem: (err as Error).message };
  }
}

/**
 * Cache-key identity for the active Google auth (mode plus account). Reads
 * local files only. See authIdentityKey for the no-email fallback.
 */
export function googleAuthIdentity(): string {
  const status = googleAuthStatus();
  let hash: string | undefined;
  if (status.mode === "oauth" && !status.email) {
    try {
      const token = readTokenFile(env.GOOGLE_TOKEN_FILE);
      if (token) hash = createHash("sha256").update(token.refresh_token).digest("hex").slice(0, 16);
    } catch {
      /* unreadable token: googleAuth() reports it; the key falls back to "none" */
    }
  }
  return authIdentityKey(status, hash);
}

export interface GoogleLiveCheck {
  ok: boolean;
  /** OAuth only: scopes on the refreshed token. */
  scopes?: string[];
  /** OAuth only: data scopes not granted (the check fails when any are missing). */
  missingScopes?: string[];
  /** OAuth only: true when Tag Manager isn't granted (gtm_audit won't work; not a failure). */
  gtmScopeMissing?: boolean;
  error?: string;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Get an access token from a service-account GoogleAuth: proves the key is valid and not revoked. */
async function serviceAccountTokenCheck(auth: Auth.GoogleAuth): Promise<GoogleLiveCheck> {
  try {
    const token = await auth.getAccessToken();
    if (!token) throw new Error("No access token returned.");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

/**
 * Live check of the active Google auth: a service account gets an access token;
 * OAuth forces a refresh (so the refresh token is exercised, not a cached access
 * token) and reads the granted scopes. Throws nothing; the result says what failed.
 */
export async function checkGoogleAuthLive(): Promise<GoogleLiveCheck> {
  let auth: Auth.OAuth2Client | Auth.GoogleAuth;
  try {
    auth = googleAuth();
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
  if (selectGoogleAuthConfig(env).mode === "service_account") return serviceAccountTokenCheck(auth as Auth.GoogleAuth);
  const client = auth as Auth.OAuth2Client;
  try {
    // The client's `tokens` listener saves the new access token.
    const { credentials } = await client.refreshAccessToken();
    const token = credentials.access_token;
    if (!token) throw new Error("No access token returned.");
    const info = await client.getTokenInfo(token);
    const missing = missingDataScopes(info.scopes);
    return {
      ok: missing.length === 0,
      scopes: info.scopes,
      missingScopes: missing,
      gtmScopeMissing: missingGtmScope(info.scopes),
      ...(missing.length ? { error: `Missing scopes: ${missing.join(", ")}.` } : {}),
    };
  } catch (err) {
    return { ok: false, error: errorText(mapTokenError(err)) };
  }
}

/**
 * Check a service-account key file that isn't configured yet (the setup wizard):
 * its JSON shape, then a live token request. Never returns key material.
 */
export async function checkServiceAccountKeyFile(keyFile: string): Promise<{ ok: true; email: string } | { ok: false; problem: string }> {
  let text: string;
  try {
    text = readFileSync(keyFile, "utf8");
  } catch (err) {
    return { ok: false, problem: `Can't read ${keyFile}: ${(err as NodeJS.ErrnoException).code ?? errorText(err)}.` };
  }
  const shape = inspectServiceAccountKey(text);
  if (!shape.ok) return shape;
  const live = await serviceAccountTokenCheck(new google.auth.GoogleAuth({ keyFile, scopes: [...SERVICE_ACCOUNT_SCOPES] }));
  return live.ok ? { ok: true, email: shape.email } : { ok: false, problem: `Google rejected the key: ${live.error}` };
}
