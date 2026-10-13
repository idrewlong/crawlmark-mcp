import { existsSync, readFileSync } from "node:fs";
import { Auth, google } from "googleapis";
import { env } from "../config.js";
import {
  DATA_SCOPES,
  noTokenMessage,
  selectGoogleAuthConfig,
  serviceAccountKeyMissingMessage,
  type GoogleAuthStatus,
} from "../lib/google-auth.js";
import { readTokenFile } from "../lib/token-store.js";
import { CrawlmarkOAuth2Client, createOAuthClientLoader } from "./google-oauth-client.js";

/** A bare OAuth client for the login flow (no stored credentials). */
export function newOAuthClient(redirectUri?: string): Auth.OAuth2Client {
  const cfg = selectGoogleAuthConfig({ ...env, GOOGLE_AUTH_MODE: "oauth" });
  if (cfg.mode !== "oauth") throw new Error("unreachable");
  return new CrawlmarkOAuth2Client({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri });
}

let saAuth: Auth.GoogleAuth | undefined;

function serviceAccountAuth(keyFile: string): Auth.GoogleAuth {
  if (!existsSync(keyFile)) throw new Error(serviceAccountKeyMissingMessage(keyFile));
  saAuth ??= new google.auth.GoogleAuth({ keyFile, scopes: [...DATA_SCOPES] });
  return saAuth;
}

/** OAuth client loaded with the stored token. Refreshed tokens are merged back into the file. */
const oauthClient = createOAuthClientLoader({
  tokenFile: env.GOOGLE_TOKEN_FILE,
  newClient: () => newOAuthClient(),
  onSaveError: (err) => console.error(`crawlmark: could not save refreshed Google token: ${err.message}`),
});

/**
 * Auth for GSC and GA4, chosen by GOOGLE_AUTH_MODE: the signed-in user's
 * OAuth2Client (auto-refreshing) or the service-account GoogleAuth.
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
  if (env.GOOGLE_AUTH_MODE === "service_account") {
    const keyFile = env.GOOGLE_APPLICATION_CREDENTIALS;
    const base = { mode: "service_account" as const, keyFile };
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
  const base = { mode: "oauth" as const, tokenFile };
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
