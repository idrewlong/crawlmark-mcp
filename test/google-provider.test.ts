import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../src/config.js";
import { GoogleNotConfiguredError, GTM_SCOPE, INVALID_GRANT_MESSAGE, noTokenMessage, type StoredToken } from "../src/lib/google-auth.js";
import { deleteTokenFile, readTokenFile, writeTokenFile } from "../src/lib/token-store.js";
import {
  assertGoogleConfigured,
  checkGoogleAuthLive,
  checkServiceAccountKeyFile,
  googleAuth,
  googleAuthIdentity,
  googleAuthMode,
  googleAuthModeNote,
  googleAuthStatus,
  googleConfigured,
} from "../src/providers/google.js";
import { CrawlmarkOAuth2Client } from "../src/providers/google-oauth-client.js";
import { DATA_SCOPES_GRANTED, startFakeGoogle, type FakeGoogle } from "./helpers/fake-google.js";
import { POSIX_MODES } from "./platform.js";

// google.ts builds its token-file client through createOAuthClientLoader. Wrap that so the client it builds
// talks to the fake Google on 127.0.0.1 instead of googleapis.com. Everything else in google.ts runs as shipped.
const hoisted = vi.hoisted(() => ({ endpoints: undefined as Record<string, string> | undefined }));
vi.mock("../src/providers/google-oauth-client.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/providers/google-oauth-client.js")>();
  return {
    ...actual,
    createOAuthClientLoader: (opts: Parameters<typeof actual.createOAuthClientLoader>[0]) =>
      actual.createOAuthClientLoader({
        ...opts,
        newClient: () => new actual.CrawlmarkOAuth2Client({ clientId: "test-client", clientSecret: "test-secret", endpoints: hoisted.endpoints }),
      }),
  };
});

type Mutable = Record<string, unknown>;
const KEYS = ["GOOGLE_AUTH_MODE", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_APPLICATION_CREDENTIALS"] as const;
const saved: Mutable = {};
let google: FakeGoogle;
let dir: string;
let tick = 0;

function configure(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const k of KEYS) delete (env as Mutable)[k];
  Object.assign(env, values);
}

/** Write a token file with a distinct mtime, so the client loader (which caches by mtime) always rebuilds. */
function putToken(token: Partial<StoredToken> = {}): void {
  const stored = { refresh_token: `stored-refresh-${++tick}`, access_token: "old-access", expiry_date: 1, ...token } as StoredToken;
  writeTokenFile(env.GOOGLE_TOKEN_FILE, stored);
  const t = new Date(Date.now() + tick * 2000);
  utimesSync(env.GOOGLE_TOKEN_FILE, t, t);
}

const OAUTH = { GOOGLE_AUTH_MODE: "oauth", GOOGLE_OAUTH_CLIENT_ID: "test-client", GOOGLE_OAUTH_CLIENT_SECRET: "test-secret" } as const;

beforeAll(() => {
  for (const k of KEYS) saved[k] = (env as Mutable)[k];
  dir = mkdtempSync(join(tmpdir(), "crawlmark-gprov-"));
});
afterAll(() => {
  for (const k of KEYS) (env as Mutable)[k] = saved[k];
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  google = await startFakeGoogle();
  hoisted.endpoints = google.endpoints;
  deleteTokenFile(env.GOOGLE_TOKEN_FILE);
  configure({});
});
afterEach(async () => {
  await google.close();
  deleteTokenFile(env.GOOGLE_TOKEN_FILE);
});

describe("checkGoogleAuthLive (OAuth): the refresh token is exercised against the token endpoint", () => {
  it("refreshes with the stored refresh token, checks the scopes, and saves the new access token (0600) without losing the refresh token", async () => {
    configure(OAUTH);
    putToken({ refresh_token: "my-refresh-token", email: "me@example.com" });

    const r = await checkGoogleAuthLive();

    expect(r).toMatchObject({ ok: true, missingScopes: [], gtmScopeMissing: true });
    expect(r.scopes).toEqual(DATA_SCOPES_GRANTED);
    expect(google.tokenRequests).toHaveLength(1);
    expect(google.tokenRequests[0]!.grant).toBe("refresh_token");
    expect(google.tokenRequests[0]!.params.get("refresh_token")).toBe("my-refresh-token");
    expect(google.tokenRequests[0]!.params.get("client_id")).toBe("test-client");

    const after = readTokenFile(env.GOOGLE_TOKEN_FILE)!;
    expect(after.access_token).toBe("refreshed-access-token");
    expect(after.refresh_token).toBe("my-refresh-token");
    expect(after.email).toBe("me@example.com");
    if (POSIX_MODES) expect(statSync(env.GOOGLE_TOKEN_FILE).mode & 0o777).toBe(0o600);
  });

  it("an expired or revoked refresh token (invalid_grant) becomes the sign-in-again message and leaves the file alone", async () => {
    configure(OAUTH);
    putToken({ refresh_token: "revoked-token" });
    google.plan.token = () => ({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } });

    const r = await checkGoogleAuthLive();

    expect(r).toEqual({ ok: false, error: INVALID_GRANT_MESSAGE });
    expect(r.error).toContain("crawlmark-cli auth login");
    expect(readTokenFile(env.GOOGLE_TOKEN_FILE)).toMatchObject({ refresh_token: "revoked-token", access_token: "old-access" });
  });

  it("other token-endpoint failures keep their own error instead of the invalid_grant advice", async () => {
    configure(OAUTH);
    putToken();
    google.plan.token = () => ({ status: 500, body: { error: "backend_error" } });
    const r = await checkGoogleAuthLive();
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain("invalid_grant");
    expect(r.error).toBeTruthy();
  });

  it("fails when a data scope isn't granted, and says which", async () => {
    configure(OAUTH);
    putToken();
    google.plan.tokenInfoScopes = ["https://www.googleapis.com/auth/webmasters.readonly"];
    const r = await checkGoogleAuthLive();
    expect(r.ok).toBe(false);
    expect(r.missingScopes).toEqual(["https://www.googleapis.com/auth/analytics.readonly"]);
    expect(r.error).toBe("Missing scopes: https://www.googleapis.com/auth/analytics.readonly.");
  });

  it("reports Tag Manager as granted when the token has it", async () => {
    configure(OAUTH);
    putToken();
    google.plan.tokenInfoScopes = [...DATA_SCOPES_GRANTED, GTM_SCOPE];
    expect(await checkGoogleAuthLive()).toMatchObject({ ok: true, gtmScopeMissing: false });
  });

  it("not signed in: asks for the login, makes no request", async () => {
    configure(OAUTH);
    const r = await checkGoogleAuthLive();
    expect(r).toEqual({ ok: false, error: noTokenMessage(env.GOOGLE_TOKEN_FILE) });
    expect(google.tokenRequests).toHaveLength(0);
  });

  it("Google not configured: a result, not a throw", async () => {
    const r = await checkGoogleAuthLive();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Google isn't set up/);
  });

  it("a token response with no access token is an error", async () => {
    configure(OAUTH);
    putToken();
    google.plan.token = () => ({ status: 200, body: { token_type: "Bearer", expires_in: 3600 } });
    const r = await checkGoogleAuthLive();
    expect(r.ok).toBe(false);
  });

  it("googleAuth() hands out an OAuth client carrying the stored refresh token", () => {
    configure(OAUTH);
    putToken({ refresh_token: "carried-token" });
    const c = googleAuth() as CrawlmarkOAuth2Client;
    expect(c).toBeInstanceOf(CrawlmarkOAuth2Client);
    expect(c.credentials.refresh_token).toBe("carried-token");
    expect(googleAuth()).toBe(c); // cached until the file changes
  });
});

describe("auth mode and status (local files only)", () => {
  it("nothing configured", () => {
    expect(googleAuthMode()).toEqual({ mode: "none", auto: true });
    expect(googleConfigured()).toBe(false);
    expect(() => assertGoogleConfigured()).toThrow(GoogleNotConfiguredError);
    expect(googleAuthStatus()).toMatchObject({ mode: "none", configured: false });
    expect(googleAuthIdentity()).toBeTruthy();
  });

  it("OAuth client set but not signed in", () => {
    configure({ GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret" });
    expect(googleAuthMode()).toEqual({ mode: "oauth", auto: true });
    expect(googleConfigured()).toBe(true);
    expect(() => assertGoogleConfigured()).not.toThrow();
    expect(googleAuthStatus()).toMatchObject({ mode: "oauth", configured: true, signedIn: false, problem: noTokenMessage(env.GOOGLE_TOKEN_FILE) });
  });

  it("signed in: email and scopes come from the token file", () => {
    configure(OAUTH);
    putToken({ email: "me@example.com", scope: `${DATA_SCOPES_GRANTED.join(" ")} openid` });
    expect(googleAuthStatus()).toMatchObject({ mode: "oauth", configured: true, signedIn: true, email: "me@example.com", scopes: [...DATA_SCOPES_GRANTED, "openid"] });
  });

  it("explicit oauth mode without the client secret says what is missing", () => {
    configure({ GOOGLE_AUTH_MODE: "oauth", GOOGLE_OAUTH_CLIENT_ID: "id" });
    const s = googleAuthStatus();
    expect(s).toMatchObject({ mode: "oauth", configured: false, signedIn: false });
    expect((s as { problem?: string }).problem).toContain("GOOGLE_OAUTH_CLIENT_SECRET");
  });

  it("a corrupt token file is a problem, not a crash", () => {
    configure(OAUTH);
    writeFileSync(env.GOOGLE_TOKEN_FILE, "{not json");
    const s = googleAuthStatus();
    expect(s).toMatchObject({ signedIn: false, configured: true });
    expect((s as { problem?: string }).problem).toContain("not valid JSON");
  });

  it("identity differs per account, and falls back to a hash of the refresh token without an email", () => {
    configure(OAUTH);
    putToken({ email: "a@example.com" });
    const a = googleAuthIdentity();
    putToken({ email: "b@example.com" });
    const b = googleAuthIdentity();
    expect(a).not.toBe(b);
    expect(a).toContain("a@example.com");

    putToken({ refresh_token: "one" });
    const x = googleAuthIdentity();
    putToken({ refresh_token: "two" });
    const y = googleAuthIdentity();
    expect(x).not.toBe(y);
    expect(x).not.toContain("one");
  });

  it("notes when auto-detection ignored a configured OAuth client", () => {
    configure({ GOOGLE_APPLICATION_CREDENTIALS: join(dir, "key.json"), GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret" });
    expect(googleAuthModeNote()).toContain("ignored");
    configure({ ...OAUTH });
    expect(googleAuthModeNote()).toBeUndefined();
  });
});

describe("service-account status and key check (no network)", () => {
  it("missing key file", () => {
    const keyFile = join(dir, "missing.json");
    configure({ GOOGLE_APPLICATION_CREDENTIALS: keyFile });
    expect(googleAuthStatus()).toMatchObject({ mode: "service_account", configured: false, keyFile });
    expect(() => googleAuth()).toThrow(/Service-account key file not found/);
  });

  it("key file without client_email, and with one", () => {
    const keyFile = join(dir, "sa.json");
    configure({ GOOGLE_APPLICATION_CREDENTIALS: keyFile });
    writeFileSync(keyFile, JSON.stringify({ type: "service_account" }));
    expect((googleAuthStatus() as { problem?: string }).problem).toContain("no client_email");
    writeFileSync(keyFile, JSON.stringify({ type: "service_account", client_email: "svc@example-project.iam.gserviceaccount.com" }));
    expect(googleAuthStatus()).toMatchObject({ configured: true, email: "svc@example-project.iam.gserviceaccount.com" });
    expect(googleAuthIdentity()).toContain("svc@example-project.iam.gserviceaccount.com");
  });

  it("an unparseable key file is a problem", () => {
    const keyFile = join(dir, "bad.json");
    writeFileSync(keyFile, "nope");
    configure({ GOOGLE_APPLICATION_CREDENTIALS: keyFile });
    expect(googleAuthStatus()).toMatchObject({ mode: "service_account", configured: false });
  });

  it("checkServiceAccountKeyFile: unreadable file and wrong shape are reported before any request", async () => {
    const missing = await checkServiceAccountKeyFile(join(dir, "nope.json"));
    expect(missing).toMatchObject({ ok: false });
    expect((missing as { problem: string }).problem).toMatch(/Can't read .*nope\.json: ENOENT/);

    const bad = join(dir, "not-a-key.json");
    writeFileSync(bad, "{\"hello\": 1}");
    const shape = await checkServiceAccountKeyFile(bad);
    expect(shape.ok).toBe(false);
  });
});
