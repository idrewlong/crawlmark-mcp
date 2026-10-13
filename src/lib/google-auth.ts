/**
 * Pure helpers for Google auth (no I/O): mode selection, the OAuth consent URL,
 * callback validation, token-file parsing/merging, and error messages.
 * The I/O lives in src/providers/google.ts, src/providers/google-oauth-client.ts,
 * src/providers/google-login.ts and src/lib/token-store.ts.
 */
import { z } from "zod";

export const GOOGLE_AUTH_MODES = ["oauth", "service_account"] as const;
export type GoogleAuthMode = (typeof GOOGLE_AUTH_MODES)[number];

/** Read-only data scopes. GSC and GA4 fail without these. */
export const DATA_SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
] as const;

/**
 * Tag Manager (read-only). Not part of DATA_SCOPES: OAuth tokens issued before
 * Phase 6b lack it, so it is requested at login but never required by the
 * missing-scope check. Only the GTM tools need it (see missingGtmScope).
 */
export const GTM_SCOPE = "https://www.googleapis.com/auth/tagmanager.readonly";

/** Scopes for service-account mode. */
export const SERVICE_ACCOUNT_SCOPES = [...DATA_SCOPES, GTM_SCOPE] as const;

/**
 * OAuth scopes: the data scopes plus Tag Manager and `openid email`, the
 * minimum needed to learn which account signed in (Google returns it in the ID token).
 */
export const OAUTH_SCOPES = [...DATA_SCOPES, GTM_SCOPE, "openid", "email"] as const;

export const LOGIN_COMMAND = "crawlmark-cli auth login";
export const CALLBACK_PATH = "/oauth2callback";

// ---------------------------------------------------------------- mode selection

export interface GoogleAuthEnv {
  /** Unset means auto-detect (see resolveAuthMode). */
  GOOGLE_AUTH_MODE?: GoogleAuthMode | undefined;
  GOOGLE_OAUTH_CLIENT_ID?: string | undefined;
  GOOGLE_OAUTH_CLIENT_SECRET?: string | undefined;
  /** Already resolved to an absolute path. */
  GOOGLE_APPLICATION_CREDENTIALS?: string | undefined;
}

export type GoogleAuthConfig =
  | { mode: "oauth"; clientId: string; clientSecret: string }
  | { mode: "service_account"; keyFile: string };

/** "none": no Google credentials configured at all. Google tools are then unavailable; everything else works. */
export type ResolvedAuthMode = GoogleAuthMode | "none";

/**
 * The auth mode in effect. An explicit GOOGLE_AUTH_MODE wins. Unset, it
 * auto-detects: a service-account key path, else a complete OAuth client
 * (ID and secret), else none.
 */
export function resolveAuthMode(e: GoogleAuthEnv): { mode: ResolvedAuthMode; auto: boolean } {
  if (e.GOOGLE_AUTH_MODE) return { mode: e.GOOGLE_AUTH_MODE, auto: false };
  if (e.GOOGLE_APPLICATION_CREDENTIALS) return { mode: "service_account", auto: true };
  if (e.GOOGLE_OAUTH_CLIENT_ID && e.GOOGLE_OAUTH_CLIENT_SECRET) return { mode: "oauth", auto: true };
  return { mode: "none", auto: true };
}

/**
 * A one-line heads-up when auto-detection picked the service account although
 * a full OAuth client is configured too, or undefined. The key path often
 * comes from the shell rather than .env, which makes this easy to miss.
 */
export function authModeNote(e: GoogleAuthEnv): string | undefined {
  if (e.GOOGLE_AUTH_MODE || !e.GOOGLE_APPLICATION_CREDENTIALS) return undefined;
  if (!e.GOOGLE_OAUTH_CLIENT_ID || !e.GOOGLE_OAUTH_CLIENT_SECRET) return undefined;
  return (
    "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are set but ignored, because GOOGLE_APPLICATION_CREDENTIALS " +
    "is set (possibly from your shell), so the service account is used. Set GOOGLE_AUTH_MODE to choose."
  );
}

export const GOOGLE_NOT_CONFIGURED_MESSAGE =
  "Google isn't set up (no service-account key or OAuth client configured), so Search Console and GA4 are unavailable. " +
  "See README > Google. DataForSEO, Lighthouse and accessibility tools still work.";

/** Thrown by Google calls when no Google auth is configured. Expected, not a fault. */
export class GoogleNotConfiguredError extends Error {
  constructor() {
    super(GOOGLE_NOT_CONFIGURED_MESSAGE);
    this.name = "GoogleNotConfiguredError";
  }
}

/** Pick the auth config for the active mode, or throw a message that says exactly what's missing. */
export function selectGoogleAuthConfig(e: GoogleAuthEnv): GoogleAuthConfig {
  const { mode } = resolveAuthMode(e);
  if (mode === "none") throw new GoogleNotConfiguredError();
  if (mode === "service_account") {
    if (!e.GOOGLE_APPLICATION_CREDENTIALS) {
      throw new Error(
        "GOOGLE_AUTH_MODE=service_account but GOOGLE_APPLICATION_CREDENTIALS is not set. " +
          "Point it at a service-account JSON key (see README), or set GOOGLE_AUTH_MODE=oauth.",
      );
    }
    return { mode: "service_account", keyFile: e.GOOGLE_APPLICATION_CREDENTIALS };
  }
  const missing = [
    !e.GOOGLE_OAUTH_CLIENT_ID && "GOOGLE_OAUTH_CLIENT_ID",
    !e.GOOGLE_OAUTH_CLIENT_SECRET && "GOOGLE_OAUTH_CLIENT_SECRET",
  ].filter((v): v is string => Boolean(v));
  if (missing.length) {
    throw new Error(
      `Google OAuth is not configured: ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set. ` +
        `Create a Desktop app OAuth client in Google Cloud (see README), add the values to .env, then run \`${LOGIN_COMMAND}\`. ` +
        "Or set GOOGLE_AUTH_MODE=service_account to use a service-account key instead.",
    );
  }
  return {
    mode: "oauth",
    clientId: e.GOOGLE_OAUTH_CLIENT_ID!,
    clientSecret: e.GOOGLE_OAUTH_CLIENT_SECRET!,
  };
}

export function serviceAccountKeyMissingMessage(keyFile: string): string {
  return (
    `Service-account key file not found at ${keyFile} (from GOOGLE_APPLICATION_CREDENTIALS). ` +
    "Download a JSON key for the service account to that path (see README), or set GOOGLE_AUTH_MODE=oauth."
  );
}

export function noTokenMessage(tokenFile: string): string {
  return `Not signed in to Google (no token at ${tokenFile}). Run \`${LOGIN_COMMAND}\` to sign in.`;
}

// ---------------------------------------------------------------- consent URL + callback

export interface AuthUrlParams {
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

/**
 * Options for OAuth2Client.generateAuthUrl. `access_type=offline` + `prompt=consent`
 * make Google return a refresh token every time, including on re-login.
 */
export function authUrlOptions(p: AuthUrlParams): {
  access_type: "offline";
  prompt: "consent";
  scope: string[];
  state: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  include_granted_scopes: false;
} {
  return {
    access_type: "offline",
    prompt: "consent",
    scope: [...OAUTH_SCOPES],
    state: p.state,
    redirect_uri: p.redirectUri,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
    include_granted_scopes: false,
  };
}

export type CallbackResult =
  | { kind: "code"; code: string }
  /** Google redirected back with our state but no usable code: the sign-in is over. */
  | { kind: "error"; message: string }
  /**
   * Callback path with a missing or wrong state (stale tab, local probe). Answer
   * 400 and keep waiting: only a request carrying our state may settle the flow.
   */
  | { kind: "reject" }
  /** Not the callback (e.g. /favicon.ico, unparseable target); answer 404 and keep waiting. */
  | { kind: "ignore" };

/** Validate the loopback redirect. `requestUrl` is the raw request target (path + query). */
export function parseCallback(requestUrl: string, expectedState: string): CallbackResult {
  let url: URL;
  try {
    url = new URL(requestUrl, "http://127.0.0.1");
  } catch {
    return { kind: "ignore" };
  }
  if (url.pathname !== CALLBACK_PATH) return { kind: "ignore" };
  const q = url.searchParams;
  if (q.get("state") !== expectedState) return { kind: "reject" };
  const error = q.get("error");
  if (error) {
    const msg =
      error === "access_denied"
        ? "Sign-in was cancelled or access was denied."
        : `Google returned an error: ${error}.`;
    return { kind: "error", message: msg };
  }
  const code = q.get("code");
  if (!code) return { kind: "error", message: "The OAuth callback had no authorization code." };
  return { kind: "code", code };
}

/** Scopes the app needs for data access that weren't granted (users can untick scopes on the consent screen). */
export function missingDataScopes(granted: string | readonly string[] | undefined | null): string[] {
  const set = new Set(typeof granted === "string" ? granted.split(/\s+/) : (granted ?? []));
  return DATA_SCOPES.filter((s) => !set.has(s));
}

/** True when a granted-scope list is known and lacks the Tag Manager scope. An unknown list is not "missing". */
export function missingGtmScope(granted: string | readonly string[] | undefined | null): boolean {
  if (granted === undefined || granted === null) return false;
  const list = typeof granted === "string" ? granted.split(/\s+/) : granted;
  return !list.includes(GTM_SCOPE);
}

export const GTM_SCOPE_MESSAGE = `Tag Manager access isn't granted to this sign-in. Run \`${LOGIN_COMMAND}\` again to grant it (leave every permission ticked).`;

/** Email claim from an ID token. Display only: the token came straight from Google's token endpoint over TLS. */
export function emailFromIdToken(idToken: string | null | undefined): string | undefined {
  const payload = idToken?.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- token file

export const StoredTokenSchema = z.object({
  refresh_token: z.string().min(1),
  access_token: z.string().optional(),
  expiry_date: z.number().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
  id_token: z.string().optional(),
  /** Signed-in account, captured at login for display. */
  email: z.string().optional(),
});
export type StoredToken = z.infer<typeof StoredTokenSchema>;

/** Parse the token file's text. Throws a readable error if it's corrupt. */
export function parseTokenFile(text: string, path: string): StoredToken {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Google token file at ${path} is not valid JSON. Run \`${LOGIN_COMMAND}\` again.`);
  }
  const parsed = StoredTokenSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Google token file at ${path} has no refresh token. Run \`${LOGIN_COMMAND}\` again.`);
  }
  return parsed.data;
}

/** Shape of the OAuth2Client `tokens` event / getToken result (fields may be null). */
export interface IncomingTokens {
  refresh_token?: string | null;
  access_token?: string | null;
  expiry_date?: number | null;
  scope?: string | null;
  token_type?: string | null;
  id_token?: string | null;
}

/**
 * Merge freshly issued tokens into the stored ones. Google usually omits
 * `refresh_token` (and sometimes `id_token`) on refresh, so absent/null fields
 * keep their stored value instead of wiping it.
 */
export function mergeTokens(existing: StoredToken | undefined, incoming: IncomingTokens): StoredToken {
  const out: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    if (v !== null && v !== undefined && v !== "") out[k] = v;
  }
  const email = emailFromIdToken(incoming.id_token);
  if (email) out.email = email;
  return StoredTokenSchema.parse(out);
}

// ---------------------------------------------------------------- errors

export function googleErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const data = (err as { response?: { data?: unknown } }).response?.data;
  if (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string") {
    return (data as { error: string }).error;
  }
  return undefined;
}

export function isInvalidGrant(err: unknown): boolean {
  if (googleErrorCode(err) === "invalid_grant") return true;
  return err instanceof Error && /\binvalid_grant\b/.test(err.message);
}

export const INVALID_GRANT_MESSAGE =
  "Google sign-in expired or was revoked (invalid_grant). " +
  `Run \`${LOGIN_COMMAND}\` to sign in again. ` +
  "Note: if the OAuth consent screen is External with publishing status Testing (personal Gmail), " +
  "Google expires sign-ins after 7 days, so this is expected weekly.";

/** Map a token-refresh failure to a user-facing error. Non-auth errors pass through unchanged. */
export function mapTokenError(err: unknown): unknown {
  if (err instanceof Error && err.message === INVALID_GRANT_MESSAGE) return err;
  if (isInvalidGrant(err)) return new Error(INVALID_GRANT_MESSAGE, { cause: err });
  return err;
}

/**
 * Failure exchanging the authorization code at login (expired or reused code,
 * PKCE mismatch, bad client). Not a refresh failure, so no 7-day expiry hint.
 */
export function loginExchangeErrorMessage(err: unknown): string {
  const code = googleErrorCode(err);
  const detail = code ?? (err instanceof Error ? err.message : String(err));
  const hint =
    code === "invalid_client" || code === "unauthorized_client"
      ? " Check GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (the client must be a Desktop app)."
      : "";
  return `Sign-in failed: Google rejected the authorization code (${detail}).${hint} Run \`${LOGIN_COMMAND}\` again.`;
}

// ---------------------------------------------------------------- status

export type GoogleAuthStatus =
  | {
      mode: "none";
      /** Always true: "none" only comes from auto-detection. */
      auto: true;
      configured: false;
      problem: string;
    }
  | {
      mode: "oauth";
      /** True when the mode was auto-detected rather than set in GOOGLE_AUTH_MODE. */
      auto: boolean;
      configured: boolean;
      signedIn: boolean;
      email?: string;
      scopes?: string[];
      tokenFile: string;
      problem?: string;
    }
  | {
      mode: "service_account";
      auto: boolean;
      configured: boolean;
      email?: string;
      keyFile?: string;
      problem?: string;
    };

/**
 * Stable key for the active Google identity, for cache keys: data one identity
 * fetched must not be served to another. Uses the account email when known;
 * an OAuth token with no recorded email falls back to a hash of its refresh
 * token (never an empty string, which would collide across accounts).
 */
export function authIdentityKey(s: GoogleAuthStatus, refreshTokenHash?: string): string {
  if (s.mode === "none") return "none";
  if (s.mode === "service_account") return `service_account:${s.email ?? s.keyFile ?? "unknown"}`;
  if (s.email) return `oauth:${s.email}`;
  return `oauth:token:${refreshTokenHash ?? "none"}`;
}

/** "auto → service_account", or just the mode when set explicitly. For `auth status`. */
export function describeAuthMode(s: { mode: ResolvedAuthMode; auto: boolean }): string {
  return s.auto ? `auto → ${s.mode === "none" ? "not configured" : s.mode}` : s.mode;
}

/** One-line summary of the active Google identity, e.g. for a health check. */
export function describeAuthStatus(s: GoogleAuthStatus): string {
  if (s.mode === "none") return s.problem;
  if (s.problem) return `Google auth (${s.mode}): ${s.problem}`;
  if (s.mode === "oauth") return `Google auth: OAuth, signed in as ${s.email ?? "an unknown account"}`;
  return `Google auth: service account ${s.email ?? "(email unknown)"}`;
}

// ---------------------------------------------------------------- key files

/**
 * Check a service-account key file's JSON before using it: it must be an
 * object with type "service_account", a client_email and a private_key.
 * Returns the email, or a message saying what's wrong (never the key itself).
 */
export function inspectServiceAccountKey(text: string): { ok: true; email: string } | { ok: false; problem: string } {
  let key: unknown;
  try {
    key = JSON.parse(text);
  } catch {
    return { ok: false, problem: "The file isn't valid JSON. Download the key again (IAM & Admin > Service accounts > Keys > Add key > JSON)." };
  }
  if (!key || typeof key !== "object" || Array.isArray(key)) return { ok: false, problem: "The file isn't a JSON object, so it isn't a service-account key." };
  const k = key as Record<string, unknown>;
  if (k.type !== "service_account") {
    return {
      ok: false,
      problem:
        k.type === undefined && "installed" in k
          ? "This is an OAuth client file, not a service-account key. For option C, create a JSON key under IAM & Admin > Service accounts > Keys."
          : `The file's type is ${JSON.stringify(k.type ?? null)}, not "service_account".`,
    };
  }
  if (typeof k.client_email !== "string" || !k.client_email) return { ok: false, problem: "The key has no client_email." };
  if (typeof k.private_key !== "string" || !k.private_key.includes("PRIVATE KEY")) return { ok: false, problem: "The key has no private_key." };
  return { ok: true, email: k.client_email };
}
